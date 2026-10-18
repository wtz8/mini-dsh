import type {
  LLMRequest,
  SessionEvent,
  StreamEvent,
  TokenUsage,
  ToolCall,
  TurnSummary,
  UserInput,
} from '../contracts.js'
import { LlmError } from '../errors.js'
import { createToolCallAccumulator, deriveMessages, toToolSchemas } from '../index.js'
import { compactSession } from './compact.js'
import { scheduleToolCalls } from './schedule.js'
import { estimateRequestTokens, needsCompaction } from './tokens.js'
import type { AgentControlHandle, AgentDeps, CollectedStream, TurnState } from './types.js'

/**
 * 回合循环（设计 §4.2 / §4.3）——06 的核心。
 *
 * 一句话：**每一步都从会话 log 重新投影，跑一次 LLM，按 `concurrency` 调度工具，
 * 直到模型不再要工具为止**。
 *
 * 三条不变量（对应架构灵魂）：
 *
 * 1. **模型可见事实只来自 log**：每 step `sessions.read()` + `deriveMessages()`，
 *    进程内没有第二份对话状态；
 * 2. **错误各有归属**：工具失败是结果（05 已入 log），LLM 失败是异常（上抛给 07），
 *    回合边界（`turn/end`）无论如何都要落盘；
 * 3. **回合号从 log 推导**（设计 D2）：resume 到另一个进程也不会与既有 log 撞号。
 */

/** 零用量（provider 未回报 usage 时的占位）。 */
function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 }
}

/** 累加用量（设计 D6：每步取最后一个 usage 事件，跨步累加）。 */
function addUsage(total: TokenUsage, add: TokenUsage): void {
  total.inputTokens += add.inputTokens
  total.outputTokens += add.outputTokens
  // provider 未给 totalTokens 时按 in+out 计，保证 TurnSummary.totalUsage 始终自洽
  const addTotal = add.totalTokens ?? add.inputTokens + add.outputTokens
  total.totalTokens = (total.totalTokens ?? 0) + addTotal
}

/** 统计已有回合数（`turn/start` 的个数）——回合号的唯一来源。 */
function countTurnStarts(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'turn/start') count += 1
  }
  return count
}

/**
 * 构造 agent 控制面。
 *
 * @param deps 依赖集（插件装配；单测注入伪 adapter / 伪 runner）
 * @returns 控制面句柄（含插件 dispose 需要的 `abortAndWait`，设计 §2.1 / X5）
 */
export function createAgentControl(deps: AgentDeps): AgentControlHandle {
  const { ctx, sessionId, resolveAdapter, runner, maxStepsPerTurn } = deps

  /** 当前回合的运行态；无在途回合时 `undefined`。 */
  let turn: TurnState | undefined
  /** 当前回合的"结算句柄"（无返回值、不抛错），供 dispose 等待收尾。 */
  let current: Promise<void> | undefined

  /**
   * 消费一条流：派发 `stream/chunk`，聚合文本、工具调用与用量。
   *
   * @throws adapter 抛出的非取消类 `LlmError`（`http` / `network` / `protocol` / `config`）
   */
  async function collect(
    iter: AsyncIterable<StreamEvent>,
    signal: AbortSignal,
  ): Promise<CollectedStream> {
    let text = ''
    let usage = zeroUsage()
    const accumulator = createToolCallAccumulator()
    let aborted = false

    try {
      for await (const event of iter) {
        // 四种 StreamEvent 全部派发（含 `end`），CLI 自行决定渲染哪些（设计 Q6）
        ctx.events.emit('stream/chunk', { sessionId, delta: event })
        if (event.type === 'text') text += event.delta
        else if (event.type === 'tool-call') accumulator.push(event.delta)
        else if (event.type === 'usage') usage = event.usage
        else if (event.type === 'end') break
      }
    } catch (err) {
      // 取消与"取消引发的传输中断"都算中断；其余分类原样上抛给 07（设计 §4.7）
      if (err instanceof LlmError && (err.kind === 'aborted' || signal.aborted)) aborted = true
      else throw err
    }

    return { text, usage, calls: accumulator.result(), aborted }
  }

  /**
   * 跑完一个回合。
   *
   * @throws `LlmError`（非取消类）/ `SessionError` / prompt render 的错误——
   *   但 `turn/end` 已在 finally 中尽力落盘
   */
  async function runTurn(state: TurnState, input: UserInput): Promise<TurnSummary> {
    const { turnNo, signal } = state
    const usage = zeroUsage()
    let stepNo = 0
    let interrupted = false
    /** 本回合是否自然结束（模型不再要工具 / 空回复） */
    let finished = false
    /** 压缩每回合最多一次（设计 D8） */
    let compacted = false

    // 回合边界**先**落盘，再落输入事实（实现期偏离 X1：设计 §4.2 原序为 user 先、
    // turn/start 后）。理由：压缩以 `turn/start` 的下标为切点，若 user/message 排在
    // turn/start 之前，切点会把该回合**自己的**用户输入一并折进摘要——保留的回合
    // 就丢掉了用户问题。改成 turn/start 先写后，"回合 N 的全部事件都在 ts_N 之后"
    // 这一不变量成立，切点语义才干净。
    await ctx.sessions.append(sessionId, { type: 'turn/start', turnNo })
    await ctx.sessions.append(sessionId, { type: 'user/message', content: input.text })
    // 先落盘后通知：与 03 "落盘后才广播" 同式（事实先行）
    ctx.events.emit('turn/start', { sessionId, turnNo })

    try {
      while (stepNo < maxStepsPerTurn) {
        stepNo += 1
        ctx.events.emit('step/start', { sessionId, turnNo, stepNo })
        try {
          if (signal.aborted) {
            interrupted = true
            break
          }

          // ① log 投影（每步重读：log 是唯一事实源）
          let messages = deriveMessages(await ctx.sessions.read(sessionId))
          const system = ctx.prompt.render()
          const tools = toToolSchemas(ctx.tools.list())

          // ② 压缩检查（设计 D4：与本次投影复用同一次 read，零额外 IO）
          const estimated = estimateRequestTokens({ system, messages, tools })
          if (
            !compacted &&
            needsCompaction(estimated, ctx.config.contextWindow, ctx.config.compaction.thresholdRatio)
          ) {
            compacted = true
            const outcome = await compactSession({
              ctx,
              sessionId,
              resolveAdapter,
              events: await ctx.sessions.read(sessionId),
              signal,
            })
            // 摘要请求也是真实花销，无论压缩成功与否都要计入（设计 §8-Q8）
            addUsage(usage, outcome.usage)
            if (signal.aborted) {
              interrupted = true
              break
            }
            messages = deriveMessages(await ctx.sessions.read(sessionId))
          }

          // ③ 请求过瀑布（插件可改写 model / messages / system）
          const request: LLMRequest = {
            system,
            messages,
            model: ctx.config.model.name,
            tools,
            signal,
          }
          const finalRequest = await ctx.events.waterfall('llm/request', request)

          // ④ 流式产出
          const out = await collect(resolveAdapter().stream(finalRequest), signal)

          // ⑤ 落 assistant 事实（取消则落已送达前缀 + interrupted）
          await ctx.sessions.append(sessionId, {
            type: 'assistant/message',
            content: out.text,
            usage: out.usage,
            ...(out.calls.length > 0 ? { toolCalls: out.calls } : {}),
            ...(out.aborted ? { interrupted: true } : {}),
          })
          addUsage(usage, out.usage)

          if (out.aborted) {
            interrupted = true
            break
          }
          if (out.calls.length === 0) {
            finished = true
            break
          }

          // ⑥ 调度工具：结果由 05 的 runner 自行入 log，06 不重复写
          const defs = new Map(ctx.tools.list().map((def) => [def.name, def]))
          const step = stepNo
          await scheduleToolCalls(
            out.calls,
            defs,
            (call: ToolCall) => runner.run(call, { sessionId, turnNo, stepNo: step, signal }),
            { maxParallel: ctx.config.tools.maxParallel, signal },
          )

          if (signal.aborted) {
            interrupted = true
            break
          }
        } finally {
          ctx.events.emit('step/end', { sessionId, turnNo, stepNo })
        }
      }

      if (!finished && !interrupted && stepNo >= maxStepsPerTurn) {
        ctx.log.warn(`turn ${turnNo} stopped at max steps (${maxStepsPerTurn})`)
      }
    } finally {
      // 回合边界无论如何都要闭合；落盘失败只记 log——不能掩盖正在上抛的回合错误
      try {
        await ctx.sessions.append(sessionId, { type: 'turn/end', turnNo })
      } catch (err) {
        ctx.log.error(`failed to append turn/end for turn ${turnNo}`, err)
      }
      ctx.events.emit('turn/end', { sessionId, turnNo })
    }

    return {
      turnNo,
      stepCount: stepNo,
      totalUsage: usage,
      interrupted: interrupted || state.cancelRequested || signal.aborted,
    }
  }

  /**
   * 运行一个回合（架构 §5.2 的 `AgentControl.run`）。
   *
   * **回合入口（同步返回 Promise）**。
   *
   * **为什么不能用 `async function`**：`async` 函数体只在第一个 `await` 之前同步执行，
   * 而"当前回合"的占位必须在 `run()` 返回前就完成——否则调用方 `run()` 之后立刻
   * `cancel()`（第二次 Ctrl+C 与第一次只差一帧的场景）会撞上 `current === undefined`
   * 而被判成 no-op，**取消被静默丢弃**。故这里同步建好 state 与句柄，再启动异步主体。
   *
   * @param input 用户输入（mini 版仅文本）
   * @returns 回合汇总
   * @throws Error 已有回合在跑（07 不得并发跑回合）
   * @throws `LlmError` / `SessionError` 等（06 不吞，交给 07 分支处置）
   */
  function run(input: UserInput): Promise<TurnSummary> {
    if (current !== undefined) return Promise.reject(new Error('a turn is already running'))

    const controller = new AbortController()
    const state: TurnState = {
      // turnNo 要读 log 才知道，先占位，startTurn 内填
      turnNo: 0,
      controller,
      // 回合级与进程级两条通道合并（架构 §5.2：工具与流两者都观察）
      signal: AbortSignal.any([controller.signal, ctx.signal]),
      cancelRequested: false,
    }
    // 同步占位：run() 一返回，cancel() 就能命中
    turn = state
    const task = startTurn(state, input)
    current = task.then(
      () => undefined,
      () => undefined,
    )
    return task.finally(() => {
      current = undefined
      turn = undefined
    })
  }

  /** 回合主体：读 log 定回合号 → 跑回合。 */
  async function startTurn(state: TurnState, input: UserInput): Promise<TurnSummary> {
    const events = await ctx.sessions.read(sessionId)
    state.turnNo = countTurnStarts(events) + 1
    return runTurn(state, input)
  }

  /**
   * 取消当前回合（架构 §5.2 的 `AgentControl.cancel`）。
   *
   * 与 `ctx.signal` 是两条独立通道：本方法只中止**这一个回合**，
   * 进程级退出由 07 在第二次 Ctrl+C 时触发。无在途回合时为 no-op。
   */
  function cancel(reason?: string): void {
    if (current === undefined || turn === undefined) {
      ctx.log.debug('cancel() ignored: no turn is running')
      return
    }
    turn.cancelRequested = true
    turn.controller.abort(reason ?? 'cancelled')
  }

  /**
   * 中止在途回合并等待其收尾（插件 `dispose` 用，设计 D10）。
   *
   * 等待是为了让在途工具结果在 03 的 store 清理（`settled() + clear()`）之前落盘。
   * **不设超时**——沿用内核既有约定，由 07 的退出流程用 `Promise.race` 兜底。
   */
  async function abortAndWait(reason?: string): Promise<void> {
    if (turn !== undefined) turn.controller.abort(reason ?? 'shutdown')
    if (current !== undefined) await current
  }

  const handle: AgentControlHandle = { run, cancel, abortAndWait }
  return handle
}
