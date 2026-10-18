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

  // 3. **顺序配对**（review Y7）：只有"该声明之后出现了对应结果"的调用才算已执行。
  //
  //    为什么不能用"整段日志里出现过同 id 的结果"判断（原实现）：provider 不给
  //    tool-call id 时，02 的聚合器用 `call_${index}` 兜底，而每个响应都从 index 0
  //    起算——不同响应的首个调用都叫 `call_0`。于是较早响应留下的 `call_0` 结果，
  //    会让**较新**响应的 `call_0` 声明被误判为已完成；取消或结果缺失时，投影里就
  //    出现"有 tool_calls、无对应 tool 消息"的 assistant，provider 直接判 400。
  //
  //    配对按事件顺序进行：一个 `tool/result` 只结算**最早一条尚未结算**的同 id
  //    声明（FIFO）。这样"声明—结果"的时序关系被保留，跨响应的同名 id 不会串台。
  const pendingDecl = new Map<string, number[]>() // callId -> 待结算的声明序号（FIFO）
  const resolvedSeq = new Set<number>() // 已拿到结果的声明序号
  const seqsByEvent = new Map<number, number[]>() // 事件下标 -> 该事件的声明序号
  let nextSeq = 0
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'assistant/message') {
      const seqs: number[] = []
      for (const call of event.toolCalls ?? []) {
        const seq = nextSeq++
        seqs.push(seq)
        const queue = pendingDecl.get(call.id)
        if (queue) queue.push(seq)
        else pendingDecl.set(call.id, [seq])
      }
      seqsByEvent.set(i, seqs)
    } else if (event.type === 'tool/result') {
      const seq = pendingDecl.get(event.result.callId)?.shift()
      if (seq !== undefined) resolvedSeq.add(seq)
    }
  }

  // 4. 线性投影：pending 记录"已投影但尚未被结果消费"的 callId **计数**——
  //    计数而非 Set，是因为重复 id 时一条结果只能抵消一条声明（Set 会让第二条
  //    声明永远等不到结果，同样拼出非法请求）
  const pending = new Map<string, number>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (!event) continue
    switch (event.type) {
      case 'user/message':
        out.push({ role: 'user', content: event.content })
        break

      case 'assistant/message': {
        const seqs = seqsByEvent.get(i) ?? []
        const calls: ToolCall[] = (event.toolCalls ?? []).filter((_call, index) => {
          const seq = seqs[index]
          return seq !== undefined && resolvedSeq.has(seq)
        })
        // 空回复（无内容也无已执行调用）不投影：给模型发一条空 assistant 消息没有意义
        if (event.content === '' && calls.length === 0) break
        out.push(
          calls.length > 0
            ? { role: 'assistant', content: event.content, toolCalls: calls }
            : { role: 'assistant', content: event.content },
        )
        for (const call of calls) pending.set(call.id, (pending.get(call.id) ?? 0) + 1)
        break
      }

      case 'tool/result': {
        const callId = event.result.callId
        const left = pending.get(callId) ?? 0
        // 孤立结果（其 assistant 在切点之前被截掉，或乱序到达）→ 跳过
        if (left === 0) break
        out.push({ role: 'tool', toolCallId: callId, content: event.result.content })
        if (left === 1) pending.delete(callId)
        else pending.set(callId, left - 1)
        break
      }

      default:
        // header / turn/start / turn/end / compaction：模型不可见
        break
    }
  }

  return out
}
