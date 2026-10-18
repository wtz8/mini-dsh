import type { ToolCall } from '../contracts.js'
import type { ScheduleOptions, ToolDefIndex } from './types.js'

/**
 * 工具并发调度器（设计 §4.4）。
 *
 * 规则来自架构 §5.4 的 `ToolDefinition.concurrency`：
 *
 * - `'parallel'`（默认，含未注册工具）：可与本 step 内其它 parallel 调用并发，
 *   并发数受 `config.tools.maxParallel` 限制；
 * - `'exclusive'`：独占屏障——**先排在途调用全部结束**，再单独执行，执行期间
 *   不与任何工具并发。
 *
 * 三条硬性质：
 *
 * 1. **启动顺序 = 声明顺序**：按模型给出的顺序依次尝试启动，保证"先声明的先占坑"。
 * 2. **取消后停止启动、但等在途结算**：已启动的调用照常跑完（runner 会把取消信号
 *    传给工具，产出 `cancelled` 结果并落盘），不会出现"取消后还有结果没入 log"。
 * 3. **错误上抛、不静默**：`run` 违反"永不抛"契约时，错误在收尾阶段抛给调用方，
 *    同时不会留下 unhandled rejection。
 */

/** 并发上限的兜底：01 已校验 ≥1，这里再兜一次（调度器不做除法/取模，取 1 即串行）。 */
function normalizeMaxParallel(value: number): number {
  if (!Number.isFinite(value)) return 1
  const floor = Math.floor(value)
  return floor >= 1 ? floor : 1
}

/**
 * 调度一批工具调用。
 *
 * @param calls 本 step 的工具调用（模型产出的顺序）
 * @param defs 工具定义快照（`ctx.tools.list()` 建 Map）；未注册的工具按 `'parallel'` 处理
 * @param run 执行单个调用（生产即 `runner.run(call, ctxRun)` 的偏应用）
 * @param options.maxParallel 并发上限
 * @param options.signal 回合级合并信号
 * @returns 全部调用结算后 resolve
 * @throws 任一 `run` 抛错时，收尾阶段上抛第一个错误（其余调用仍会先结算完）
 */
export async function scheduleToolCalls(
  calls: readonly ToolCall[],
  defs: ToolDefIndex,
  run: (call: ToolCall) => Promise<unknown>,
  options: ScheduleOptions,
): Promise<void> {
  const maxParallel = normalizeMaxParallel(options.maxParallel)
  const { signal } = options

  /** 在途调用的句柄集合；元素自带 catch，故不会 unhandled rejection。 */
  const inflight = new Set<Promise<void>>()
  /** 收集到的错误（收尾时上抛第一个）。 */
  const errors: unknown[] = []

  /** 启动一个调用并登记句柄；结算后自动出集合。 */
  function start(call: ToolCall): void {
    const handle = Promise.resolve()
      .then(() => run(call))
      .then(
        () => undefined,
        (err: unknown) => {
          errors.push(err)
        },
      )
    inflight.add(handle)
    void handle.then(() => {
      inflight.delete(handle)
    })
  }

  /** 等在途全部结算；循环是因为出集合的动作发生在 then 回调里。 */
  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight])
    }
  }

  for (const call of calls) {
    if (signal.aborted) break
    if (defs.get(call.name)?.concurrency === 'exclusive') {
      // 屏障 1：先把在途的全部等完（错误已收集，不会在这里抛出——见文件头性质 3）
      await drain()
      // 屏障 2：单独执行，期间不与任何工具并发
      try {
        await run(call)
      } catch (err) {
        errors.push(err)
      }
      continue
    }
    if (inflight.size >= maxParallel) {
      // 等一个空位：run 永不抛（有 catch 兜底），race 不会变成 rejection
      await Promise.race(inflight)
    }
    start(call)
  }

  await drain()

  const first = errors[0]
  if (first !== undefined) throw first instanceof Error ? first : new Error(String(first))
}
