import fs from 'node:fs/promises'

import type { JsonSchema, ToolDefinition } from '../../contracts.js'
import { describeFsError } from '../fs-error.js'
import { displayPath, resolvePath } from '../path.js'

/**
 * `read` 工具：按行读取文本文件，带行号与分页。
 *
 * 设计取舍：
 * - **按行编号返回**（而非裸文本）：模型引用"第 37 行"时才有共同坐标系，`edit` 之后
 *   也好核对；
 * - **二进制文件直接拒绝**（前 8KB 含 NUL 判定）：把二进制按 UTF-8 读出来是一堆
 *   乱码，既浪费 token 又误导模型；
 * - **超大文件不静默截断**：只读前 N 行会让模型以为"文件就这么长"。超 10MB 时报错
 *   并提示用 `offset` / `limit` 分片，把"还要不要继续读"的决定权交回模型。
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 2000
const MAX_LINE_CHARS = 4000
/** 二进制判定窗口：只看前 8KB，避免大文件全量扫描。 */
const BINARY_SNIFF_BYTES = 8000

const schema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径；相对路径按工作目录解析' },
    offset: { type: 'integer', minimum: 1, description: '起始行号（1 起），默认 1' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `最多读取的行数，默认 ${DEFAULT_LIMIT}` },
  },
  required: ['path'],
  additionalProperties: false,
}

/** 判断缓冲区是否像二进制（前 8KB 出现 NUL 字节）。 */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true
  }
  return false
}

/** 按 `\r?\n` 切行；末尾换行不产生一条空行。 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 单行超长截断：保留行首（通常是缩进后的实际内容），标注被砍掉的字符数。 */
function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, MAX_LINE_CHARS)}…（本行还有 ${line.length - MAX_LINE_CHARS} 字符）`
}

/**
 * 构造 `read` 工具定义。
 *
 * @returns 工具定义（`concurrency` 缺省为 parallel）
 */
export function createReadTool(): ToolDefinition {
  return {
    name: 'read',
    description: '读取文本文件内容，按行编号返回；可用 offset / limit 分页',
    schema,
    execute: async (args, env): Promise<string> => {
      const abs = resolvePath(args['path'] as string)
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(abs)
      } catch (err) {
        throw new Error(describeFsError(err, abs))
      }
      if (stat.isDirectory()) throw new Error(`目标是目录，不是文件：${abs}`)
      if (!stat.isFile()) throw new Error(`不是普通文件：${abs}`)
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `文件过大（${stat.size} 字节，上限 ${MAX_FILE_BYTES}），请用 offset / limit 分片读取：${abs}`,
        )
      }
      if (env.signal.aborted) throw new Error('操作已取消')

      let buf: Buffer
      try {
        buf = await fs.readFile(abs)
      } catch (err) {
        throw new Error(describeFsError(err, abs))
      }
      if (looksBinary(buf)) throw new Error(`二进制文件，未按文本读取：${abs}`)

      const lines = splitLines(buf.toString('utf8'))
      if (lines.length === 0) return `（空文件）${displayPath(abs)}`

      const offset = typeof args['offset'] === 'number' ? args['offset'] : 1
      const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'], MAX_LIMIT) : DEFAULT_LIMIT
      if (offset > lines.length) {
        return `（共 ${lines.length} 行，起点 ${offset} 超出范围）：${displayPath(abs)}`
      }

      const end = Math.min(offset - 1 + limit, lines.length)
      const body: string[] = []
      for (let i = offset - 1; i < end; i += 1) {
        const text = lines[i] ?? ''
        body.push(`${String(i + 1).padStart(6, ' ')}\t${clipLine(text)}`)
      }
      const shown = body.join('\n')
      if (end < lines.length) {
        return `${shown}\n\n（共 ${lines.length} 行，已显示第 ${offset}–${end} 行）`
      }
      return shown
    },
  }
}
