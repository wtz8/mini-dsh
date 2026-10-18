import fs from 'node:fs/promises'
import path from 'node:path'

import type { JsonSchema, ToolDefinition } from '../../contracts.js'
import { describeFsError } from '../fs-error.js'
import { displayPath, resolvePath } from '../path.js'

/**
 * `write` 工具：整文件覆盖写入（父目录不存在时自动创建）。
 *
 * **exclusive**：写文件与同 step 内的其它工具并发会让"读到一半被覆盖"这种
 * 竞争变得可观测，独占屏障是更省心的语义（架构 §5.4 的 concurrency 注释）。
 *
 * 不做"写前必须读过"的检查：那是策略，归权限（`write` 默认 `ask`）与 prompt 准则，
 * 工具层只做"说要写什么就写什么"。
 */

const schema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目标文件路径；相对路径按工作目录解析' },
    content: { type: 'string', description: '完整文件内容（覆盖写入）' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
}

/**
 * 构造 `write` 工具定义。
 *
 * @returns 工具定义（`concurrency: 'exclusive'`）
 */
export function createWriteTool(): ToolDefinition {
  return {
    name: 'write',
    description: '把完整内容写入文件（覆盖已有内容，自动创建父目录）',
    schema,
    concurrency: 'exclusive',
    execute: async (args): Promise<string> => {
      const abs = resolvePath(args['path'] as string)
      const content = args['content'] as string
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
      } catch (err) {
        throw new Error(describeFsError(err, abs))
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      return `已写入 ${displayPath(abs)}（${bytes} 字节，${content.split('\n').length} 行）`
    },
  }
}
