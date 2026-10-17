import type { ChatMessage, SessionEvent, ToolCall } from '../contracts.js'

/**
 * log → 模型可见消息的投影（03 设计 §4.4）——**灵魂 #2 的唯一出口**。
 *
 * 模型可见的会话事实只来自 session log 的投影，不存在第二份"内存对话状态"：
 * 06 每 step 调 `ctx.sessions.read(id)` 再调本函数拼出 `LLMRequest.messages`。
 *
 * 四条核心规则（每条都有对应用例，见设计 §6.1）：
 *
 * 1. `session/header` / `turn/*` / `compaction` **不投影**——`ChatMessage` 只有
 *    user/assistant/tool 三种形态，元信息与回合边界对模型不可见（系统信息走
 *    `LLMRequest.system`，由 04 拼装）。
 * 2. **compaction 截断**：以**最后一个** compaction 事件的数组位置为切点，切点之前
 *    的历史被它的 `summary` 一条 user 消息取代（`boundary` 字段只作语义标注保留）；
 *    用位置而非 turnNo 过滤，对异常时序更鲁棒（设计 §8-Q8）。
 * 3. **残缺 toolCalls 丢弃**：assistant 声明了 `toolCalls` 却没有对应 `tool/result`
 *    时（取消 / 崩溃后 resume），只保留 `content`——不补占位 tool 消息（03 不编造
 *    会话事实），不裁则 provider 会因"有 tool_calls 无对应 tool 消息"判 400。
 * 4. **孤立 tool/result 跳过**：切点之后只剩结果、其 assistant 已被压缩截断时，
 *    该 tool 消息无主，同样会触发 400。
 *
 * 本函数是**纯函数**：不读盘、不缓存、不改入参，同输入必得同输出。
 *
 * @param events 按写入顺序的事件序列（`ctx.sessions.read()` 的产物）
 * @returns 模型可见的消息序列（可直接作为 `LLMRequest.messages`）
 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  // 1. 定位最后一个 compaction（切点）
  let cut = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'compaction') {
      cut = i
      break
    }
  }

  const out: ChatMessage[] = []
  if (cut >= 0) {
    const compaction = events[cut]
    // 2. 摘要作为首条 user 消息：ChatMessage 没有 system 变体（设计 §8-Q10）
    if (compaction?.type === 'compaction') {
      out.push({ role: 'user', content: compaction.summary })
    }
  }

  const start = cut + 1

  // 3. 先扫一遍收集切点之后出现过的全部结果 callId——"有结果"才保留 assistant 的调用声明
  const resolved = new Set<string>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (event?.type === 'tool/result') resolved.add(event.result.callId)
  }

  // 4. 线性投影：seen 记录"已投影且尚未被结果消费"的 callId（一对一配对）
  const pending = new Set<string>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (!event) continue
    switch (event.type) {
      case 'user/message':
        out.push({ role: 'user', content: event.content })
        break

      case 'assistant/message': {
        const calls: ToolCall[] = (event.toolCalls ?? []).filter((call) => resolved.has(call.id))
        // 空回复（无内容也无已执行调用）不投影：给模型发一条空 assistant 消息没有意义
        if (event.content === '' && calls.length === 0) break
        out.push(
          calls.length > 0
            ? { role: 'assistant', content: event.content, toolCalls: calls }
            : { role: 'assistant', content: event.content },
        )
        for (const call of calls) pending.add(call.id)
        break
      }

      case 'tool/result': {
        const callId = event.result.callId
        // 孤立结果（其 assistant 在切点之前被截掉，或乱序到达）→ 跳过
        if (!pending.has(callId)) break
        out.push({ role: 'tool', toolCallId: callId, content: event.result.content })
        pending.delete(callId)
        break
      }

      default:
        // header / turn/start / turn/end / compaction：模型不可见
        break
    }
  }

  return out
}
