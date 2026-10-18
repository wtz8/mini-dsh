import type { PromptSection, ToolRegistry } from '../contracts.js'
import { PROMPT_ORDER } from '../prompt/order.js'
import { describeSchema } from './schema.js'

/**
 * 工具清单 prompt 段（order = `PROMPT_ORDER.tools` = 350）。
 *
 * 这是**工具清单唯一的真值出口**（04 §7 附则）：内容全部来自 `ctx.tools.list()`，
 * 不在本模块硬编码工具名——09 挂上 MCP 工具后自动出现，08 的 memory 工具同理。
 *
 * 为什么只列"名字 + 参数骨架 + 一句话"：完整 JSON Schema 已由 `LLMRequest.tools`
 * 交付给 provider，系统提示里再抄一遍纯属烧 token（设计 Q5）。
 */

/** 段 id（与 04 的 `core/*` 命名空间并列）。 */
export const TOOLS_SECTION_ID = 'tools/catalog'

/** 段末尾的固定说明：把"参数细节在哪"和"路径怎么解析"两件事交代清楚。 */
const FOOTER = '参数的具体类型与约束见 `tools` 字段中的 JSON Schema；相对路径按工作目录解析。'

/** 压成单行：工具描述由插件提供，可能含换行（不能让它伪造出新的提示行）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 构造 `tools` 段。
 *
 * **每次 `render()` 现查注册表**（设计 D4）：MCP 工具在 `builtin:tools` 之后挂载，
 * 若做 setup 时快照，段内容会取决于 `config.plugins` 的书写顺序。
 *
 * @param tools 工具注册表（只用到 `list`）
 * @returns prompt 段；无工具时渲染为 `''`（被 04 的空段过滤自然丢弃）
 */
export function createToolsSection(tools: Pick<ToolRegistry, 'list'>): PromptSection {
  return {
    id: TOOLS_SECTION_ID,
    order: PROMPT_ORDER.tools,
    render(): string {
      const defs = tools.list()
      if (defs.length === 0) return ''
      const lines = defs.map((def) => {
        // 工具名理论上不含空白与反引号；插件作者的意外输入不该破坏 markdown 排版
        const name = def.name.replace(/[`\s]/g, '')
        const signature = describeSchema(def.schema)
        return `- \`${name}(${signature})\` — ${oneLine(def.description)}`
      })
      return ['# 可用工具', '', ...lines, '', FOOTER].join('\n')
    },
  }
}
