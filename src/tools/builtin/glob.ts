import fs from 'node:fs/promises'

import type { JsonSchema, ToolDefinition } from '../../contracts.js'
import { describeFsError } from '../fs-error.js'
import { matchGlob, walkFiles } from '../fs-walk.js'
import { displayPath, resolvePath } from '../path.js'

/**
 * `glob` 工具：按模式查找文件路径。
 *
 * 支持 `**`（任意层）、`*`（段内任意字符）、`?`（段内单字符）。模式含 `/` 时对整条
 * 相对路径匹配，不含 `/` 时对文件名匹配（与 ripgrep `-g` 一致，见 `fs-walk.ts`）。
 *
 * 只返回**文件**，不返回目录：模型要的是"能读的东西"，目录列表用 `read` 会报错、
 * 用 `bash ls` 又太重。
 */

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

const schema: JsonSchema = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'glob 模式，如 `src/**/*.ts`、`*.md`' },
    path: { type: 'string', description: '搜索起点目录，默认工作目录' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `最多返回条数，默认 ${DEFAULT_LIMIT}` },
  },
  required: ['pattern'],
  additionalProperties: false,
}

/**
 * 构造 `glob` 工具定义。
 *
 * @returns 工具定义（`concurrency` 缺省为 parallel）
 */
export function createGlobTool(): ToolDefinition {
  return {
    name: 'glob',
    description: '按 glob 模式查找文件路径（支持 **、*、?）',
    schema,
    execute: async (args, env): Promise<string> => {
      const pattern = args['pattern'] as string
      const base = resolvePath(typeof args['path'] === 'string' ? args['path'] : '.')
      const limit =
        typeof args['limit'] === 'number' ? Math.min(args['limit'], MAX_LIMIT) : DEFAULT_LIMIT

      try {
        const stat = await fs.stat(base)
        if (!stat.isDirectory()) throw new Error(`搜索起点不是目录：${base}`)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('搜索起点')) throw err
        throw new Error(describeFsError(err, base))
      }

      const walked = await walkFiles(base, { match: matchGlob(pattern), signal: env.signal })
      const shown = walked.files.slice(0, limit)
      if (shown.length === 0) return '（无匹配）'

      const notes: string[] = []
      if (walked.files.length > limit) {
        notes.push(`（已截断：共匹配 ${walked.files.length} 条，仅显示前 ${limit} 条）`)
      }
      if (walked.truncated) notes.push('（遍历达到条目上限，结果可能不完整）')
      const where = base === process.cwd() ? '' : `（起点 ${displayPath(base)}）`
      const body = shown.join('\n')
      return `${body}${notes.length > 0 ? `\n\n${notes.join('\n')}` : ''}${where ? `\n\n${where}` : ''}`
    },
  }
}
