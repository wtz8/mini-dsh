import type { LlmAdapter, SessionEvent, StreamEvent, TokenUsage } from '../contracts.js'
import { TRANSCRIPT_ITEM_CHARS, TRANSCRIPT_MAX_CHARS } from './types.js'
import type { CompactOutcome, CompactRequest } from './types.js'

/**
 * 压缩（compaction，设计 §4.6 / 实现期偏离 X2）：把"太长的历史"换成一段摘要。
 *
 * **切点语义必须按 03 的投影规则理解**（03 §4.4 规则 2 / §8-Q8）：`deriveMessages`
 * 以**最后一个 compaction 事件的数组位置**为切点，切点之前的**全部**事件被摘要取代。
 * 在 append-only 日志里，这意味着"把最近 N 个回合的日志留下来"是做不到的——
 * compaction 只能追加在**末尾**，它之前的一切都进了摘要。
 *
 * 因此本模块的语义是：
 *
 * - **切点恒为"即将追加的位置"**（`events.length`），唯一不压缩的情形是没有任何
 *   可摘要内容（只有 header）；
 * - **`keepTurns` 不再是"保留多少个回合"，而是摘要的粒度指引**：最近 N 个回合
 *   的细节（文件路径、命令、报错、结论）要完整保留，更早的部分可粗粒度概括；
 * - **`boundary` 记的是被折叠掉的最后一个回合号**——因为连当前回合也一并折叠，
 *   它就是当前回合号（供人读与自省，不参与投影）。
 *
 * 三块内容：切点判定（`findCompactionCut`）、transcript 渲染（`renderTranscript`）、
 * 摘要请求与落盘（`compactSession`）。
 *
 * 安全线（三条，缺一不可）：
 *
 * - **空摘要不 append**：空摘要等于把整段历史换成空文本，无从恢复；
 * - **摘要失败跳过**：压缩是优化，不是主流程，失败只 `log.warn`；
 * - **每回合最多一次**（由 `loop.ts` 的 `compacted` 标志保证）：单回合本身撑爆窗口时
 *   压缩救不回来，每步重试只会放大开销。
 */

/**
 * 摘要指令（中文：与 04 的段文案同语言口径）。
 *
 * 要求结构化输出，是为了让摘要在投影成首条 user 消息后仍然可读、可据以续做。
 */
export const SUMMARY_INSTRUCTION = [
  '请把下面这段更早的对话压缩成一份结构化摘要，供后续对话接着做下去。',
  '要求：',
  '1. 用户目标：用户最初想要什么，当前目标是什么；',
  '2. 已完成：已经做过的事与得到的结论（含改动过的文件路径）；',
  '3. 关键事实：路径、命令、报错、约定等后续仍然需要的信息；',
  '4. 待办：还没做完的事。',
  '只输出摘要本身，不要复述原文，不要加开场白。',
].join('\n')

/** 截断后缀（transcript 内部使用，便于一眼看出被截过）。 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断 ${text.length - limit} 字符）`
}

/**
 * 判定压缩切点：返回**被摘要取代的区间上界**（下标，开区间右侧）。
 *
 * 03 §4.4 的投影规则决定了切点只能是"即将追加 compaction 的位置"——
 * compaction 事件写在末尾，它之前的**全部**事件都会被摘要取代（X2）。
 * 于是"保留最近 N 个回合的日志"在 append-only 语义下无解；`keepTurns` 退化为
 * 摘要的粒度指引（见 `buildSummaryPrompt`）。
 *
 * @param events 全量事件序列
 * @returns 切点下标（有可摘要内容时为 `events.length`）；`0` 表示不压缩
 */
export function findCompactionCut(events: readonly SessionEvent[]): number {
  for (const event of events) {
    if (
      event.type === 'user/message' ||
      event.type === 'assistant/message' ||
      event.type === 'tool/result' ||
      event.type === 'compaction'
    ) {
      return events.length
    }
  }
  // 只有 header / turn 边界：没有可摘要的事实
  return 0
}

/**
 * 切点之前最后一个回合的回合号（即"被折叠掉的最后一个回合"）。
 *
 * 仅作语义标注写进 `compaction.boundary`——投影以**事件位置**为准（03 §8-Q8）。
 */
function boundaryOf(events: readonly SessionEvent[], cut: number): number {
  let boundary = 0
  for (let i = 0; i < cut; i += 1) {
    const event = events[i]
    if (event?.type === 'turn/start') boundary = event.turnNo
  }
  return boundary
}

/**
 * 组装摘要请求的用户消息。
 *
 * `keepTurns` 在这里兑现（X2）：它不再是"保留多少回合的日志"，而是**摘要粒度**——
 * 最近 N 个回合的细节要完整保留，更早的可以粗粒度概括。
 *
 * @param transcript `renderTranscript` 的产物
 * @param keepTurns `config.compaction.keepTurns`
 * @returns 直接可作为 user 消息 content 的文本
 */
export function buildSummaryPrompt(transcript: string, keepTurns: number): string {
  const granularity =
    keepTurns > 0
      ? `最近 ${keepTurns} 个回合的细节（文件路径、命令、报错、结论）请完整保留；更早的部分可粗粒度概括。`
      : '全部内容按要点概括，不需要保留逐字细节。'
  return [`${SUMMARY_INSTRUCTION}\n${granularity}`, '', transcript].join('\n')
}

/**
 * 把一段 log 渲染成给摘要模型看的文本（纯函数）。
 *
 * - `user/message` → `用户：…`；`assistant/message` → `助手：…` + 其工具调用骨架；
 * - `tool/result` → `[工具结果 <name> · ok/error] …`（单条截断至 `maxItemChars`）；
 * - `compaction` → 其 `summary` **必须带上**：否则二次压缩会把更早的摘要丢掉；
 * - `session/header` / `turn/*` 跳过（元信息对摘要无意义）；
 * - 总量超预算时**从最旧开始丢**，并在开头补一行省略说明——近期内容比远古内容重要。
 *
 * @param events 待渲染的事件序列（通常是 `events.slice(0, cut)`）
 * @param options.maxItemChars 单条工具结果上限，默认 `TRANSCRIPT_ITEM_CHARS`
 * @param options.maxChars 总量上限，默认 `TRANSCRIPT_MAX_CHARS`
 * @returns 渲染文本；无任何可渲染内容时为空串
 */
export function renderTranscript(
  events: readonly SessionEvent[],
  options: { maxItemChars?: number; maxChars?: number } = {},
): string {
  const maxItemChars = options.maxItemChars ?? TRANSCRIPT_ITEM_CHARS
  const maxChars = options.maxChars ?? TRANSCRIPT_MAX_CHARS

  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        lines.push(`用户：${event.content}`)
        break

      case 'assistant/message': {
        lines.push(`助手：${event.content}`)
        for (const call of event.toolCalls ?? []) {
          lines.push(`  [调用 ${call.name}(${truncate(call.arguments, 200)})]`)
        }
        break
      }

      case 'tool/result': {
        const tag = event.result.ok ? 'ok' : `error:${event.result.error?.code ?? 'failed'}`
        lines.push(`[工具结果 ${event.result.name} · ${tag}] ${truncate(event.result.content, maxItemChars)}`)
        break
      }

      case 'compaction':
        // 更早的摘要必须保留：它是那一段历史唯一的留存
        lines.push(`会话摘要（更早部分）：${event.summary}`)
        break

      default:
        // header / turn/start / turn/end：对摘要无意义
        break
    }
  }

  // 总量预算：从最旧开始丢
  let total = 0
  for (const line of lines) total += line.length + 1
  let dropped = 0
  while (total > maxChars && dropped < lines.length - 1) {
    total -= (lines[dropped] as string).length + 1
    dropped += 1
  }
  if (dropped === 0) return lines.join('\n')
  return [`…（更早的 ${dropped} 条已省略）`, ...lines.slice(dropped)].join('\n')
}

/** 零用量（provider 未回报 usage 时的占位）。 */
function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 }
}

/**
 * 只收集文本、不派发事件的流消费（压缩专用）。
 *
 * 压缩请求**不派发 `stream/chunk`**（设计 D7）：摘要不是回合输出，派发会让 CLI
 * 把它当成助手回复渲染出来。
 *
 * @param iter adapter 产出的流
 * @param sink 用量累加器：**即使流中途失败，已送达的 usage 也已经写进去了**
 *   ——摘要请求是真实花销，失败也要计入 `totalUsage`（设计 §8-Q8）
 * @returns 摘要文本
 */
async function collectText(
  iter: AsyncIterable<StreamEvent>,
  sink: { usage: TokenUsage },
): Promise<string> {
  let text = ''
  for await (const event of iter) {
    if (event.type === 'text') text += event.delta
    // 与回合流同口径（设计 D6）：多片 usage 时最后一个是该请求的最终用量
    else if (event.type === 'usage') sink.usage = event.usage
    else if (event.type === 'end') break
  }
  return text
}

/**
 * 执行一次压缩（设计 §4.6）。
 *
 * 流程：定位切点 → 渲染 transcript → 发一次不带工具的摘要请求 → 追加 `compaction` 事件。
 * **任何一步不达标都只是跳过**（`compacted: false`），不抛错、不破坏回合。
 *
 * @param request 压缩上下文（含全量事件快照与回合信号）
 * @returns `compacted` 是否真的写入了 `compaction` 事件；`usage` 是本次摘要请求的
 *   用量（失败也可能是"已送达的部分用量"）——调用方必须把它累加进 `totalUsage`
 */
export async function compactSession(request: CompactRequest): Promise<CompactOutcome> {
  const { ctx, sessionId, resolveAdapter, events, signal } = request
  /**
   * 摘要请求的用量（真实花销，无论成败都要回传给调用方）。
   * 用"盒子"持有：`collectText` 需要在流中途失败时也能把已送达的用量留下。
   */
  const sink = { usage: zeroUsage() }
  /** 跳过压缩的统一出口（带上已产生的用量）。 */
  const skipped = (): CompactOutcome => ({ compacted: false, usage: sink.usage })

  const cut = findCompactionCut(events)
  if (cut <= 0) return skipped()

  const transcript = renderTranscript(events.slice(0, cut))
  if (transcript.trim() === '') return skipped()

  const boundary = boundaryOf(events, cut)
  const base = {
    messages: [
      {
        role: 'user' as const,
        content: buildSummaryPrompt(transcript, ctx.config.compaction.keepTurns),
      },
    ],
    model: ctx.config.model.name,
    tools: [],
    signal,
  }

  let adapter: LlmAdapter
  let requestPayload
  try {
    // 惰性解析（02 D7）：provider 未注册在使用点才暴露
    adapter = resolveAdapter()
    // 压缩请求同样过 `llm/request` 瀑布——插件可见即可改写，与其它请求一致
    requestPayload = await ctx.events.waterfall('llm/request', base)
  } catch (err) {
    ctx.log.warn(`compaction skipped: ${err instanceof Error ? err.message : String(err)}`)
    return skipped()
  }

  let summary: string
  try {
    summary = await collectText(adapter.stream(requestPayload), sink)
  } catch (err) {
    ctx.log.warn(`compaction skipped: ${err instanceof Error ? err.message : String(err)}`)
    return skipped()
  }

  if (summary.trim() === '') {
    ctx.log.warn('compaction skipped: model returned an empty summary')
    return skipped()
  }

  try {
    await ctx.sessions.append(sessionId, { type: 'compaction', summary, boundary })
  } catch (err) {
    ctx.log.warn(`compaction skipped: failed to append: ${err instanceof Error ? err.message : String(err)}`)
    return skipped()
  }

  ctx.log.info(`compacted history up to turn ${boundary}`)
  return { compacted: true, usage: sink.usage }
}
