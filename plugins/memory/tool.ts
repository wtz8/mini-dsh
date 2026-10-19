import type { JsonSchema, ToolDefinition } from '../../src/index.js'
import { resolvePath } from '../../src/index.js'
import { appendMemory, toSlashes } from './file.js'
import { DEFAULT_MEMORY_FILE, type MemoryOptions } from './types.js'

/**
 * `memory` 工具：append-only 的跨会话记忆写入（设计 §8-Q3）。
 *
 * 刻意不做 action 枚举（read/clear/...）：读由 prompt 段承担（模型每个 step
 * 都看得到全文），改/删用既有 `edit`/`write` 工具直接改文件。条目格式自治——
 * 不包 `- ` 前缀、不加时间戳，模型比工具更知道这条记忆该长成什么样（§8-Q4）。
 */

/** 工具名（权限选择器按此名匹配：`permissions: { "memory": "auto" }` 可免审批）。 */
export const MEMORY_TOOL_NAME = 'memory'

const schema: JsonSchema = {
  type: 'object',
  properties: {
    content: { type: 'string', description: '要追加的记忆条目（markdown；建议自带日期）' },
  },
  required: ['content'],
  additionalProperties: false,
}

/**
 * 构造 `memory` 工具定义（纯函数：不读 ctx，路径经选项注入）。
 *
 * @param options 记忆文件路径（缺省 `DEFAULT_MEMORY_FILE`）
 * @returns ToolDefinition（`concurrency: 'exclusive'`，与 write/edit 一致：
 *   分隔判断 + 追加是两步，同 step 并发调用会交错，设计 §8-Q7）
 */
export function createMemoryTool(options: MemoryOptions = {}): ToolDefinition {
  const file = options.file ?? DEFAULT_MEMORY_FILE
  return {
    name: MEMORY_TOOL_NAME,
    description: '追加一条跨会话记忆（用户偏好、项目约定、经验教训）到记忆文件；写入后下个 step 起出现在系统提示中',
    schema,
    concurrency: 'exclusive',
    execute: async (args): Promise<string> => {
      // content 的字符串形态已由 05 管道的 schema 校验保证；空白串按
      // "未写入"的 ok 结果处理（模型空调用不该算 execution_error，设计 §5-#7）
      const content = args['content'] as string
      if (content.trim() === '') return '内容为空，未写入'
      const abs = resolvePath(file)
      // IO 失败原样抛出：管道转 execution_error，"错误是工具结果的一种"（架构 §5.4）
      const bytes = await appendMemory(abs, content)
      return `已追加到 ${toSlashes(abs)}（${bytes} 字节）`
    },
  }
}
