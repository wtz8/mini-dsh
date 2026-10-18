import type { RequestTokensInput } from './types.js'

/**
 * token 启发式估算（设计 §3.3）——**纯函数，无 tokenizer**。
 *
 * 零依赖约束下拿不到真实分词器，而压缩只需要一个"是否该压缩了"的开关，
 * 不需要与 provider 计费一致。规则：
 *
 * - CJK 字符（含假名、全角、CJK 标点）按 **1 token/字**——中文实际约 0.6–1.5 token/字，
 *   取 1 是**保守偏高**；偏高的唯一后果是"稍早压缩"，方向安全；
 * - 其余字符按 **1 token/4 字符**（向上取整）——英文的常见经验值；
 * - 每条消息 **+4**（role 与分隔符开销），每个工具 schema **+8**（结构包装开销）。
 *
 * 本函数只服务于"要不要压缩"这一个判断，**不写进 log**（log 只记 provider 回报的真实 usage）。
 */

/**
 * CJK 及全角字符区间（按码位书写，避免字面量受文件编码影响）：
 * 谚文字母/音节、CJK 部首补充与标点、假名、兼容字母、扩展 A、基本区、
 * 彝文音节、谚文音节、兼容表意文字、CJK 兼容形式、全角/半角形式。
 */
const CJK_PATTERN =
  /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA48F\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** 每条消息的固定开销（role + 分隔符）。 */
const MESSAGE_OVERHEAD = 4

/** 每个工具 schema 的固定开销（name/description/结构包装）。 */
const TOOL_OVERHEAD = 8

/**
 * 估算一段文本的 token 数。
 *
 * @param text 任意文本（空串得 0）
 * @returns 估算值（非负整数）
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 估算一次请求的总 token 数：system + messages + tools。
 *
 * @param input.system 系统提示（`ctx.prompt.render()` 的产物）
 * @param input.messages 模型可见消息（`deriveMessages` 的产物）
 * @param input.tools 模型可见工具（`toToolSchemas` 的产物）
 * @returns 估算值（非负整数）
 */
export function estimateRequestTokens(input: RequestTokensInput): number {
  let total = estimateTokens(input.system)

  for (const message of input.messages) {
    total += MESSAGE_OVERHEAD
    if (message.role === 'tool') {
      total += estimateTokens(message.content)
      continue
    }
    total += estimateTokens(message.content)
    if (message.role === 'assistant') {
      // 工具调用的名称与参数串也要算：模型侧它们是以结构化形式计入上下文的
      for (const call of message.toolCalls ?? []) {
        total += estimateTokens(call.name) + estimateTokens(call.arguments) + MESSAGE_OVERHEAD
      }
    }
  }

  for (const tool of input.tools) {
    total +=
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.schema)) +
      TOOL_OVERHEAD
  }

  return total
}

/**
 * 是否触发压缩（设计 §4.6）。
 *
 * **等于阈值即触发**（`>=`）：阈值是"最多用这么多"的上界，踩线就该压，
 * 否则下一次请求必然越界——而这个判断本来就发生在"即将发请求"之前。
 *
 * @param estimated 估算 token 数
 * @param contextWindow `config.contextWindow`
 * @param thresholdRatio `config.compaction.thresholdRatio`
 * @returns 是否应立即压缩
 */
export function needsCompaction(
  estimated: number,
  contextWindow: number,
  thresholdRatio: number,
): boolean {
  if (contextWindow <= 0) return false
  const threshold = contextWindow * (thresholdRatio > 0 ? thresholdRatio : 1)
  return estimated >= threshold
}
