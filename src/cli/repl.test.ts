import type { Config, Ctx, TurnSummary, Unsubscribe } from '../contracts.js'
import { LlmError } from '../errors.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCli } from './repl.js'
import type { CliIO, LineReader } from './types.js'
import { DOUBLE_INTERRUPT_MS } from './types.js'

/**
 * REPL 主循环与两段式中断单测（设计 §6.1 第 33–40 条 / O3）。
 *
 * 伪 ctx 只实现 `events.on`（渲染订阅）与 `agent.resolve()`；回合本体用**可挂起的
 * promise** 模拟，这样"取消在途回合"这类时序语义才可被确定断言。
 */

type Handler = (payload: unknown) => void

/** 脚本化行读取器：按序返回预设输入，用完后恒为 null（EOF）。 */
function scripted(inputs: Array<string | null>): LineReader & { interrupts: () => number; closes: () => number } {
  let index = 0
  let interrupts = 0
  let closes = 0
  /** 挂起中的读取（close 时以 null 唤醒）。 */
  let wake: ((line: string | null) => void) | undefined
  return {
    next: async () => inputs[index++] ?? null,
    ask: async () => inputs[index++] ?? null,
    interrupt: () => {
      interrupts += 1
    },
    close: () => {
      closes += 1
      wake?.(null)
      wake = undefined
    },
    interrupts: () => interrupts,
    closes: () => closes,
  }
}

function config(): Config {
  return {
    model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    contextWindow: 131072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    permissions: {},
    plugins: [],
  }
}

interface Harness {
  io: CliIO
  out: string[]
  err: string[]
  runs: string[]
  cancels: string[]
  lines: LineReader & { interrupts: () => number; closes: () => number }
  handle: ReturnType<typeof createCli>
  /** 让挂起的 run() 以给定汇总结束 */
  release(summary: TurnSummary): void
  /** run() 首次被调用的通知 */
  runCalled: Promise<void>
}

/**
 * 构造一个 REPL 夹具。
 *
 * @param inputs 脚本化的行输入（用完后为 EOF）
 * @param options.runImpl 自定义回合实现（如抛错）
 * @param options.hang 回合挂起（模拟"模型还在说"），用 `release` 结束
 */
function harness(
  inputs: Array<string | null>,
  options: { runImpl?: (text: string) => Promise<TurnSummary>; hang?: boolean } = {},
): Harness {
  const out: string[] = []
  const err: string[] = []
  const runs: string[] = []
  const cancels: string[] = []
  const handlers = new Map<string, Handler[]>()

  let releaseFn: ((summary: TurnSummary) => void) | undefined
  let notifyCalled: (() => void) | undefined
  const runCalled = new Promise<void>((resolve) => {
    notifyCalled = resolve
  })
  const pending = new Promise<TurnSummary>((resolve) => {
    releaseFn = resolve
  })

  const ctx = {
    events: {
      on: (type: string, fn: Handler): Unsubscribe => {
        const list = handlers.get(type) ?? []
        list.push(fn)
        handlers.set(type, list)
        return () => undefined
      },
    },
    agent: {
      resolve: () => ({
        run: async (input: { text: string }): Promise<TurnSummary> => {
          runs.push(input.text)
          notifyCalled?.()
          if (options.runImpl) return await options.runImpl(input.text)
          if (options.hang === true) return await pending
          return SUMMARY
        },
        cancel: (reason?: string): void => {
          cancels.push(reason ?? '')
        },
      }),
    },
  } as unknown as Ctx

  const lines = scripted(inputs)
  const io: CliIO = { out: (text) => out.push(text), err: (text) => err.push(text), lines, isTTY: true }
  const handle = createCli({ ctx, config: config(), io })

  return { io, out, err, runs, cancels, lines, handle, release: (summary) => releaseFn?.(summary), runCalled }
}

const SUMMARY: TurnSummary = {
  turnNo: 1,
  stepCount: 1,
  totalUsage: { inputTokens: 10, outputTokens: 5 },
  interrupted: false,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createCli', () => {
  it('㉝ 普通输入跑一个回合并打印摘要', async () => {
    const h = harness(['你好', null])
    const code = await h.handle.start()
    expect(code).toBe(0)
    expect(h.runs).toEqual(['你好'])
    expect(h.out.join('')).toContain('turn 1')
    expect(h.out.join('')).toContain('steps 1')
  })

  it('㉞ 空行不跑回合', async () => {
    const h = harness(['', '   ', null])
    await h.handle.start()
    expect(h.runs).toEqual([])
  })

  it('㉟ 斜杠输入走命令分派，不跑回合', async () => {
    const h = harness(['/help', '/exit'])
    const code = await h.handle.start()
    expect(h.runs).toEqual([])
    expect(h.out.join('')).toContain('/resume')
    expect(code).toBe(0)
  })

  it('㊱ EOF 结束 REPL，退出码 0', async () => {
    const h = harness([null])
    expect(await h.handle.start()).toBe(0)
    expect(h.runs).toEqual([])
  })

  it('㊲ 回合抛 LlmError：打印诊断且循环继续（会话不丢）', async () => {
    const h = harness(['boom', '再来一次', null], {
      runImpl: async (text) => {
        if (text === 'boom') throw new LlmError('server error', { kind: 'http', status: 500 })
        return SUMMARY
      },
    })
    const code = await h.handle.start()
    expect(code).toBe(0)
    expect(h.runs).toEqual(['boom', '再来一次'])
    const stderr = h.err.join('')
    expect(stderr).toContain('llm:')
    expect(stderr).toContain('500')
  })

  it('㊳ 窗口内两次 Ctrl+C：第一次取消回合，第二次退出', async () => {
    const h = harness(['你好', null], { hang: true })
    const done = h.handle.start()

    await h.runCalled
    h.handle.interrupt()
    expect(h.cancels).toEqual(['user interrupt'])
    expect(h.out.join('')).toContain('已请求取消')

    h.handle.interrupt()
    expect(h.out.join('')).toContain('正在退出')
    // 第一段用 interrupt（唤醒审批中的 ask），第二段用 close（唤醒等待输入的 next）
    expect(h.lines.interrupts()).toBe(1)
    expect(h.lines.closes()).toBe(1)

    // 在途回合收尾后 REPL 才真正结束
    h.release(SUMMARY)
    expect(await done).toBe(0)
  })

  it('㊴ 窗口外的第二次 Ctrl+C 仍算"新的第一次"（不累加成退出）', async () => {
    vi.useFakeTimers()
    const h = harness(['你好', null], { hang: true })
    const done = h.handle.start()

    await h.runCalled
    h.handle.interrupt()
    vi.advanceTimersByTime(DOUBLE_INTERRUPT_MS + 100)
    h.handle.interrupt()

    // 仍是取消语义：cancel 两次，但没有"正在退出"
    expect(h.cancels).toHaveLength(2)
    expect(h.out.join('')).not.toContain('正在退出')

    h.release(SUMMARY)
    expect(await done).toBe(0)
  })

  it('㊵ 空闲时第一次 Ctrl+C 只提示、不退出（Q8）', async () => {
    const h = harness([null])
    const done = h.handle.start()

    h.handle.interrupt()
    const settled = await Promise.race([done.then(() => 'done'), Promise.resolve('pending')])
    expect(settled).toBe('pending')
    expect(h.out.join('')).toContain('已请求取消')
    expect(h.out.join('')).not.toContain('正在退出')

    h.release(SUMMARY)
    expect(await done).toBe(0)
  })

  it('附带：未知命令给出提示且不跑回合', async () => {
    const h = harness(['/nope', null])
    await h.handle.start()
    expect(h.runs).toEqual([])
    expect(h.err.join('')).toContain('/nope')
    expect(h.err.join('')).toContain('/help')
  })
})
