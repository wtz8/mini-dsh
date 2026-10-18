import fs from 'node:fs/promises'
import path from 'node:path'

import type { JsonSchema, ToolDefinition } from '../../contracts.js'
import { describeFsError } from '../fs-error.js'
import { matchGlob, toPosix, walkFiles } from '../fs-walk.js'
import { resolvePath } from '../path.js'

/**
 * `grep` 工具：在文件内容里按正则搜索，输出 `路径:行号: 内容`。
 *
 * 为什么不用 `bash grep`：Windows 上不一定有 `grep`，而"搜索"是 agent 最高频的动作，
 * 不能依赖外部命令（零依赖原则的实用一面）。代价是自己遍历，所以设了上限：
 * 跳过 `.git` / `node_modules`、单文件 ≤2MB、默认 100 条命中断言。
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINE_CHARS = 500
const BINARY_SNIFF_BYTES = 8000

const schema: JsonSchema = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '正则表达式（JS 语法）' },
    path: { type: 'string', description: '搜索起点目录，默认工作目录' },
    glob: { type: 'string', description: '只搜索匹配该 glob 的文件，如 `*.ts`' },
    ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 false' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `最多命中条数，默认 ${DEFAULT_LIMIT}` },
  },
  required: ['pattern'],
  additionalProperties: false,
}

/** 前 8KB 含 NUL 即视为二进制（与 read 同一判据）。 */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * 构造 `grep` 工具定义。
 *
 * @returns 工具定义（`concurrency` 缺省为 parallel）
 */
export function createGrepTool(): ToolDefinition {
  return {
    name: 'grep',
    description: '在文件中按正则搜索内容，返回匹配行（路径:行号: 内容）',
    schema,
    execute: async (args, env): Promise<string> => {
      const pattern = args['pattern'] as string
      const base = resolvePath(typeof args['path'] === 'string' ? args['path'] : '.')
      const limit =
        typeof args['limit'] === 'number' ? Math.min(args['limit'], MAX_LIMIT) : DEFAULT_LIMIT
      const ignoreCase = args['ignoreCase'] === true

      let re: RegExp
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`正则表达式非法：${message}`)
      }

      const fileMatcher = typeof args['glob'] === 'string' ? matchGlob(args['glob']) : undefined
      const walked = await walkFiles(base, { match: fileMatcher, signal: env.signal })

      const hits: string[] = []
      let truncated = false
      for (const rel of walked.files) {
        if (env.signal.aborted) throw new Error('操作已取消')
        const abs = path.resolve(base, rel)
        let stat: Awaited<ReturnType<typeof fs.stat>>
        try {
          stat = await fs.stat(abs)
        } catch {
          continue // 遍历期间被删：跳过
        }
        if (stat.size > MAX_FILE_BYTES) continue
        let buf: Buffer
        try {
          buf = await fs.readFile(abs)
        } catch (err) {
          if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'EACCES') continue
          throw new Error(describeFsError(err, abs))
        }
        if (looksBinary(buf)) continue

        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? ''
          if (!re.test(line)) continue
          const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
          hits.push(`${toPosix(rel)}:${i + 1}: ${text}`)
          if (hits.length >= limit) {
            truncated = true
            break
          }
        }
        if (truncated) break
      }

      if (hits.length === 0) return '（无匹配）'
      const notes: string[] = []
      if (truncated || walked.truncated) notes.push(`（已截断：仅显示前 ${limit} 条命中）`)
      return notes.length > 0 ? `${hits.join('\n')}\n\n${notes.join('\n')}` : hits.join('\n')
    },
  }
}
