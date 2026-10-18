import { describe, expect, it, vi } from 'vitest'

import type {
  Config,
  LlmAdapter,
  LLMRequest,
  SessionEvent,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../contracts.js'
import { LlmError, SessionError } from '../errors.js'
import { createDefaultConfig } from '../config/index.js'
import { createKernel } from '../plugin/ctx.js'
import type { ToolRunner } from '../tools/types.js'
import { createAgentControl } from './loop.js'
import type { AgentControlHandle } from './types.js'

/**
 * 回合循环（设计 §6.1 / §4.2–§4.7）：**真实内核**（真 EventBus、真 registry）+ 伪
 * session store + 伪 adapter + 伪 runner。循环的策略分支在这里精确控制，
 * 真实挂载留到集成测试。
 *
 * 脚本约定：`StreamEvent[]` 正常产出；`string` = 先产出这段文本再抛 `aborted`；
 * `Error` = 直接抛出。
 */
type Script = StreamEvent[] | Error | string

const SESSION_ID = 's1'

function header(): SessionEvent {
  return {
    type: 'session/header',
    id: SESSION_ID,
    createdAt: '2026-10-18T00:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-chat',
    cwd: '/tmp',
  }
}

/** 一段纯文本回复。 */
function text(delta: string, usage?: { inputTokens: number; outputTokens: number }): StreamEvent[] {
  const events: StreamEvent[] = [{ type: 'text', delta }]
  if (usage) events.push({ type: 'usage', usage })
  events.push({ type: 'end' })
  return events
}

/** 一次工具调用（单个分片）。 */
function callOf(name: string, args = '{}', id = 'c1'): StreamEvent[] {
  return [
    { type: 'tool-call', delta: { index: 0, id, name, argumentsDelta: args } },
    { type: 'end' },
  ]
}

function streamOf(spec: Script): AsyncIterable<StreamEvent> {
  return (async function* (): AsyncIterable<StreamEvent> {
    if (spec instanceof Error) throw spec
    if (typeof spec === 'string') {
      yield { type: 'text', delta: spec }
      throw new LlmError('aborted', { kind: 'aborted' })
    }
    for (const event of spec) yield event
  })()
}

interface Harness {
  ctx: ReturnType<typeof createKernel>
  control: AgentControlHandle
  events: SessionEvent[]
  bus: Array<{ type: string; payload: unknown }>
  chunks: StreamEvent[]
  adapterCalls: LLMRequest[]
  toolCalls: ToolCall[]
  scripts: Script[]
  reads: number
  setToolGate: (p: Promise<void>) => void
  waitTools: (n: number) => Promise<void>
}

function harness(options: {
  scripts?: Script[]
  tools?: readonly ToolDefinition[]
  config?: Partial<Config>
  maxSteps?: number
  /** 预置的历史事件（用于构造"已有若干回合"的场景） */
  seed?: readonly SessionEvent[]
} = {}): Harness {
  const config = createDefaultConfig()
  config.logLevel = 'error'
  Object.assign(config, options.config ?? {})

  const ctx = createKernel(config, new AbortController().signal)
  const events: SessionEvent[] = [header(), ...(options.seed ?? [])]
  const session = { id: SESSION_ID, meta: { id: SESSION_ID, createdAt: '', provider: 'deepseek', model: 'm', cwd: '/tmp' } }
  let reads = 0
  ctx.sessions.mount({
    create: async () => session,
    open: async (id) => {
      if (id !== SESSION_ID) throw new SessionError(`no such session: ${id}`, { kind: 'not_found' })
      return session
    },
    list: async () => [session.meta],
    read: async () => {
      reads += 1
      return [...events]
    },
    append: async (_id, event) => {
      events.push(event)
    },
    subscribe: () => () => {},
  })

  const bus: Array<{ type: string; payload: unknown }> = []
  const chunks: StreamEvent[] = []
  ctx.events.on('turn/start', (p) => bus.push({ type: 'turn/start', payload: p }))
  ctx.events.on('turn/end', (p) => bus.push({ type: 'turn/end', payload: p }))
  ctx.events.on('step/start', (p) => bus.push({ type: 'step/start', payload: p }))
  ctx.events.on('step/end', (p) => bus.push({ type: 'step/end', payload: p }))
  ctx.events.on('stream/chunk', (p) => {
    bus.push({ type: 'stream/chunk', payload: p })
    chunks.push(p.delta)
  })

  for (const def of options.tools ?? []) ctx.tools.register(def)

  const scripts: Script[] = [...(options.scripts ?? [])]
  const adapterCalls: LLMRequest[] = []
  const adapter: LlmAdapter = {
    stream(req) {
      adapterCalls.push(req)
      const spec = scripts.shift()
      return streamOf(spec ?? [])
    },
  }

  const toolCalls: ToolCall[] = []
  let gate: Promise<void> = Promise.resolve()
  const runner: ToolRunner = {
    async run(call, rc): Promise<ToolResult> {
      toolCalls.push(call)
      await gate
      const cancelled = rc.signal.aborted
      const result: ToolResult = cancelled
        ? { callId: call.id, name: call.name, ok: false, content: 'cancelled', error: { code: 'cancelled', message: 'cancelled' } }
        : { callId: call.id, name: call.name, ok: true, content: `ok:${call.name}` }
      // 模仿 05：结果由 runner 自己入 log（06 不重复写）
      events.push({ type: 'tool/result', toolCallId: call.id, result })
      return result
    },
  }

  const control = createAgentControl({
    ctx,
    sessionId: SESSION_ID,
    resolveAdapter: () => adapter,
    runner,
    maxStepsPerTurn: options.maxSteps ?? 32,
  })

  return {
    ctx,
    control,
    events,
    bus,
    chunks,
    adapterCalls,
    toolCalls,
    scripts,
    get reads(): number {
      return reads
    },
    setToolGate(p: Promise<void>): void {
      gate = p
    },
    async waitTools(n: number): Promise<void> {
      const start = Date.now()
      while (toolCalls.length < n) {
        if (Date.now() - start > 3000) throw new Error('waitTools timeout')
        await new Promise((r) => setTimeout(r, 5))
      }
    },
  }
}

/** 让工具挂住，直到显式释放（用于取消路径）。 */
function deferredGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const readDef: ToolDefinition = {
  name: 'read',
  description: 'read a file',
  schema: { type: 'object', properties: {} },
  execute: async () => 'ok',
}

describe('回合循环 · 基本形态', () => {
  it('21 · 无工具调用：一步结束，事件序列与用量正确', async () => {
    const h = harness({ scripts: [text('你好', { inputTokens: 10, outputTokens: 2 })] })
    const summary = await h.control.run({ text: '问题' })

    expect(summary).toMatchObject({ turnNo: 1, stepCount: 1, interrupted: false })
    expect(summary.totalUsage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    expect(h.events.map((e) => e.type)).toEqual([
      'session/header',
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ])
    const assistant = h.events[3]
    expect(assistant).toMatchObject({ type: 'assistant/message', content: '你好' })
  })

  it('22 · 有工具调用：继续下一步，结果入 log，每步都重读 log', async () => {
    const h = harness({ scripts: [callOf('read'), text('完成')], tools: [readDef] })
    const summary = await h.control.run({ text: '读个文件' })

    expect(summary.stepCount).toBe(2)
    expect(h.toolCalls).toHaveLength(1)
    expect(h.events.filter((e) => e.type === 'tool/result')).toHaveLength(1)
    // run() 开场读一次 + 每步各读一次
    expect(h.reads).toBeGreaterThanOrEqual(3)
  })

  it('23 · 空回复（无文本无调用）：回合结束', async () => {
    const h = harness({ scripts: [[]] })
    const summary = await h.control.run({ text: '问题' })
    expect(summary).toMatchObject({ stepCount: 1, interrupted: false })
    expect(h.events.filter((e) => e.type === 'assistant/message')).toHaveLength(1)
  })

  it('33b · run() 返回后立刻 cancel() 必须命中（不能被判成 no-op）', async () => {
    const h = harness({ scripts: [callOf('read'), text('后续')], tools: [readDef] })

    const task = h.control.run({ text: '读文件' })
    // 不 await 任何东西：此刻回合主体刚起步（首个 await 还没返回）
    h.control.cancel()
    const summary = await task

    // 取消被采纳 ⇒ 回合立刻收尾：既没发工具，也没跑到第二步
    expect(summary.interrupted).toBe(true)
    expect(summary.stepCount).toBe(1)
    expect(h.toolCalls).toHaveLength(0)
    expect(h.events.filter((e) => e.type === 'tool/result')).toHaveLength(0)
  })

  it('33 · user/message 由 run 内 append（唯一一条）', async () => {
    const h = harness({ scripts: [text('ok')] })
    await h.control.run({ text: '唯一输入' })
    const users = h.events.filter((e) => e.type === 'user/message')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ content: '唯一输入' })
  })
})

describe('回合循环 · 取消', () => {
  it('24 · 取消打断流：落已送达前缀 + interrupted，不启动工具', async () => {
    const h = harness({ scripts: ['部分文本', callOf('read')], tools: [readDef] })
    const summary = await h.control.run({ text: '问题' })

    expect(summary.interrupted).toBe(true)
    expect(summary.stepCount).toBe(1)
    const assistant = h.events.find((e) => e.type === 'assistant/message')
    expect(assistant).toMatchObject({ content: '部分文本', interrupted: true })
    // 中断后不启动工具
    expect(h.toolCalls).toHaveLength(0)
  })

  it('25 · 取消发生在工具执行中：在途调用结算，回合收尾', async () => {
    const gate = deferredGate()
    const h = harness({ scripts: [callOf('read'), text('后续')], tools: [readDef] })
    h.setToolGate(gate.promise)

    const task = h.control.run({ text: '读文件' })
    await h.waitTools(1)
    h.control.cancel()
    gate.release()
    const summary = await task

    expect(summary.interrupted).toBe(true)
    const result = h.events.find((e) => e.type === 'tool/result')
    expect(result).toBeDefined()
    expect((result as { result: ToolResult }).result.error?.code).toBe('cancelled')
  })
})

describe('回合循环 · 错误', () => {
  it('26 · LLM 非取消类错误：原样上抛，但 turn/end 已落盘', async () => {
    const h = harness({ scripts: [new LlmError('HTTP 500', { kind: 'http', status: 500 })] })
    await expect(h.control.run({ text: '问题' })).rejects.toThrow('HTTP 500')
    expect(h.events.filter((e) => e.type === 'turn/end')).toHaveLength(1)
  })

  it('32 · 并发 run 抛错；无在途回合时 cancel 是 no-op', async () => {
    const gate = deferredGate()
    const h = harness({ scripts: [callOf('read'), text('完成')], tools: [readDef] })
    h.setToolGate(gate.promise)

    const task = h.control.run({ text: '读文件' })
    await h.waitTools(1)
    await expect(h.control.run({ text: '再来' })).rejects.toThrow('a turn is already running')
    gate.release()
    await task

    const debug = vi.spyOn(h.ctx.log, 'debug').mockImplementation(() => {})
    expect(() => h.control.cancel()).not.toThrow()
    expect(debug).toHaveBeenCalled()
  })
})

describe('回合循环 · 用量口径', () => {
  it('31b · 压缩用量计入 totalUsage（真实花销，设计 §8-Q8）', async () => {
    const seed: SessionEvent[] = [
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: '第一轮问题' },
      { type: 'assistant/message', content: '第一轮回答', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'turn/end', turnNo: 1 },
    ]
    const h = harness({
      seed,
      scripts: [
        [
          { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
          { type: 'text', delta: '这是摘要' },
          { type: 'end' },
        ],
        text('最终回答', { inputTokens: 5, outputTokens: 5 }),
      ],
      config: { contextWindow: 100, compaction: { thresholdRatio: 0.5, keepTurns: 4 } },
    })
    const summary = await h.control.run({ text: 'x'.repeat(400) })
    expect(h.events.filter((e) => e.type === 'compaction')).toHaveLength(1)
    // 100/20（摘要）+ 5/5（本回合回答）
    expect(summary.totalUsage).toMatchObject({ inputTokens: 105, outputTokens: 25, totalTokens: 130 })
  })
})

describe('回合循环 · 契约与边界', () => {
  it('27 · llm/request 瀑布可改写请求（用改写后的 model 发请求）', async () => {
    const h = harness({ scripts: [text('ok')] })
    h.ctx.events.onWaterfall('llm/request', (req) => ({ ...req, model: 'other-model' }))
    await h.control.run({ text: '问题' })
    expect(h.adapterCalls[0]?.model).toBe('other-model')
  })

  it('28 · turnNo 从 log 推导（第二个回合为 2），step 事件成对', async () => {
    const h = harness({ scripts: [text('第一次'), text('第二次')] })
    const first = await h.control.run({ text: 'A' })
    const second = await h.control.run({ text: 'B' })
    expect(first.turnNo).toBe(1)
    expect(second.turnNo).toBe(2)
    expect(h.bus.filter((e) => e.type === 'step/start')).toHaveLength(2)
    expect(h.bus.filter((e) => e.type === 'step/end')).toHaveLength(2)
  })

  it('29 · 步数达上限：回合结束并记 warn', async () => {
    const warn = vi.fn()
    const h = harness({
      scripts: [callOf('read', '{}', 'c1'), callOf('read', '{}', 'c2'), text('完成')],
      tools: [readDef],
      maxSteps: 2,
    })
    vi.spyOn(h.ctx.log, 'warn').mockImplementation(warn)
    const summary = await h.control.run({ text: '一直读' })
    expect(summary.stepCount).toBe(2)
    expect(warn).toHaveBeenCalled()
  })

  it('30 · stream/chunk 全量派发；usage 取最后一个', async () => {
    const h = harness({
      scripts: [
        [
          { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
          { type: 'text', delta: 'a' },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } },
          { type: 'end' },
        ],
      ],
    })
    const summary = await h.control.run({ text: '问题' })
    expect(h.chunks.map((c) => c.type)).toEqual(['usage', 'text', 'usage', 'end'])
    expect(summary.totalUsage).toMatchObject({ inputTokens: 5, outputTokens: 7 })
  })

  it('31 · 超阈值先压缩：compaction 入 log，本回合只压一次', async () => {
    // 预置两个已完成的回合：否则"当前回合之前"只有 header，无可摘要内容（合法跳过）
    const seed: SessionEvent[] = [
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: '第一轮问题' },
      { type: 'assistant/message', content: '第一轮回答', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'turn/end', turnNo: 1 },
      { type: 'turn/start', turnNo: 2 },
      { type: 'user/message', content: '第二轮问题' },
      { type: 'assistant/message', content: '第二轮回答', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'turn/end', turnNo: 2 },
    ]
    const h = harness({
      seed,
      // 第一个脚本给压缩用，第二个是最终回答
      scripts: [text('这是摘要'), text('最终回答')],
      config: { contextWindow: 100, compaction: { thresholdRatio: 0.5, keepTurns: 4 } },
    })
    const summary = await h.control.run({ text: 'x'.repeat(400) })

    const compactions = h.events.filter((e) => e.type === 'compaction')
    expect(compactions).toHaveLength(1)
    // 连当前回合一并折叠（03 的位置切点语义），故 boundary 就是当前回合号
    expect(compactions[0]).toMatchObject({ summary: '这是摘要', boundary: 3 })
    expect(summary.turnNo).toBe(3)
    expect(summary.stepCount).toBe(1)
    // 第一个 adapter 调用是压缩请求，最后一个才是本回合的请求
    expect(h.adapterCalls).toHaveLength(2)
    // 摘要输入必须覆盖当前回合的用户输入——否则投影后这段事实会静默消失
    expect(h.adapterCalls[0]?.messages[0]?.content).toContain('x'.repeat(400))
    // 压缩后请求只剩一条摘要 user 消息（03 §4.4 的投影结果）
    const messages = h.adapterCalls[h.adapterCalls.length - 1]?.messages ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '这是摘要' })
  })
})
