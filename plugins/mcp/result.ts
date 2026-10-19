/**
 * `tools/call` 结果投影（设计 §4.5）：MCP 的 `content` 块数组 → 模型可见文本。
 *
 * 投影规则（与原版 `extractText` / `projectContent` 对齐，mini 降级项见各 case）：
 * - `text` 块按序 `\n` 拼接（唯一的"真内容"通道）；
 * - `image` / `audio` / `resource` → 占位文本（mini 无附件存储与多模态链路）；
 * - `resource_link` → `资源链接：<name>（<uri>）`；
 * - 未知块类型 → 占位文本（**不**把块原样 JSON 序列化给模型，防注入面扩大）；
 * - 空数组 / 非数组 / 全部块都无文本 ⇒ 占位提示（返回空字符串会让 05 的
 *   pipeline 显示"（无输出）"，语义是"工具没说话"而非"内容无法展示"，须区分）。
 *
 * 投影后的文本若过长，由 05 的 64k 中段截断兜底（05 §4.6），本层不再截。
 */

/** 判断"普通对象"（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 占位文案：内容为空或全部无法展示时使用。 */
const EMPTY_PLACEHOLDER = (rawName: string): string => `（${rawName} 未返回可展示内容）`

/**
 * 投影 `content` 块数组为模型可见文本。
 *
 * @param content `tools/call` 响应的 `content` 字段（未收窄的原始值）
 * @param rawName 远端工具名（占位文案里使用；模型可据此向用户转述）
 * @returns 恒为非空字符串；绝不抛错（畸形内容降级为占位文本，不让一次
 *   调用因为 server 返回了怪东西而变成 execution_error）
 */
export function projectContent(content: unknown, rawName: string): string {
  if (!Array.isArray(content)) return EMPTY_PLACEHOLDER(rawName)
  const parts: string[] = []
  for (const block of content) {
    if (!isPlainObject(block)) {
      parts.push('[不支持的 MCP 内容块]')
      continue
    }
    switch (block['type']) {
      case 'text': {
        // text 缺失、非字符串或空串：跳过该块（空文本块没有信息量，
        // 全部块都无文本时由末尾的占位兜底）
        if (typeof block['text'] === 'string' && block['text'] !== '') parts.push(block['text'])
        break
      }
      case 'resource_link': {
        const name = typeof block['name'] === 'string' ? block['name'] : ''
        const uri = typeof block['uri'] === 'string' ? block['uri'] : ''
        parts.push(`资源链接：${name || uri}（${uri}）`)
        break
      }
      case 'image':
      case 'audio':
      case 'resource': {
        // 内嵌二进制不进模型（mini 无附件存储；原版会解码进附件体系，此处降级）
        parts.push(`[不支持的 MCP 内容类型：${String(block['type'])}]`)
        break
      }
      default: {
        parts.push(`[不支持的 MCP 内容类型：${String(block['type'])}]`)
        break
      }
    }
  }
  if (parts.length === 0) return EMPTY_PLACEHOLDER(rawName)
  return parts.join('\n')
}
