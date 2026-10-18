import fs from 'node:fs/promises'

import type { JsonSchema, ToolDefinition } from '../../contracts.js'
import { describeFsError } from '../fs-error.js'
import { displayPath, resolvePath } from '../path.js'

/**
 * `edit` 工具：精确字符串替换。
 *
 * 为什么是"精确字符串"而不是行号/正则：
 * - 行号会因前一次编辑漂移，模型很容易改错行；
 * - 精确匹配要求模型先 `read` 到原文（04 准则"先读后改"的工程化），
 *   匹配失败或命中多处时**拒绝执行**，而不是猜一个位置。
 *
 * **exclusive**：读-改-写是一个不可分割的序列，并发下会互相覆盖。
 */

const schema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目标文件路径；相对路径按工作目录解析' },
    oldString: { type: 'string', minLength: 1, description: '要被替换的原文片段（必须与文件内容完全一致）' },
    newString: { type: 'string', description: '替换后的内容（可为空串 = 删除该片段）' },
    replaceAll: { type: 'boolean', description: '命中多处时是否全部替换，默认 false' },
  },
  required: ['path', 'oldString', 'newString'],
  additionalProperties: false,
}

/** 统计 `needle` 在 `hay` 中不重叠出现的次数与首处下标。 */
function countOccurrences(hay: string, needle: string): { count: number; first: number } {
  let count = 0
  let first = -1
  let from = 0
  for (;;) {
    const idx = hay.indexOf(needle, from)
    if (idx === -1) break
    if (first === -1) first = idx
    count += 1
    from = idx + needle.length
  }
  return { count, first }
}

/**
 * 构造 `edit` 工具定义。
 *
 * @returns 工具定义（`concurrency: 'exclusive'`）
 */
export function createEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description: '在文件中精确替换一段文本；命中多处时必须显式 replaceAll',
    schema,
    concurrency: 'exclusive',
    execute: async (args): Promise<string> => {
      const abs = resolvePath(args['path'] as string)
      const oldString = args['oldString'] as string
      const newString = args['newString'] as string
      const replaceAll = args['replaceAll'] === true

      // 空串在 schema 层已被 minLength 拦下；这里再兜一次，防止绕过 pipeline 直接调用时
      // 陷入 indexOf('') 的无限循环（工具是公共可调用面，不能只信任上游校验）
      if (oldString === '') throw new Error('oldString 不能为空串')

      let original: string
      try {
        original = await fs.readFile(abs, 'utf8')
      } catch (err) {
        throw new Error(describeFsError(err, abs))
      }

      const { count, first } = countOccurrences(original, oldString)
      if (count === 0) {
        throw new Error(
          `未找到匹配文本。请先用 read 确认原文（注意空格、缩进与换行需完全一致）：${displayPath(abs)}`,
        )
      }
      if (count > 1 && !replaceAll) {
        throw new Error(
          `匹配到 ${count} 处，无法确定改哪一处。请提供更长的唯一片段，或设置 replaceAll: true：${displayPath(abs)}`,
        )
      }

      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.slice(0, first) + newString + original.slice(first + oldString.length)

      try {
        await fs.writeFile(abs, updated, 'utf8')
      } catch (err) {
        throw new Error(describeFsError(err, abs))
      }
      return `已在 ${displayPath(abs)} 替换 ${count} 处`
    },
  }
}
