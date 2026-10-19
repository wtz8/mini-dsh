import { describe, expect, it, vi } from 'vitest'

import type { Config, LlmAdapter, SessionEvent, StreamEvent } from '../contracts.js'
import { LlmError } from '../errors.js'
import { createDefaultConfig } from '../config/index.js'
import { createKernel } from '../plugin/ctx.js'
import { compactSession, findCompactionCut, renderTranscript } from './compact.js'

/**
 * 压缩（设计 §6.1 / §4.6）：切点定位与 transcript 是纯函数，直接断言；
 * `compactSession` 用真实内核（真 EventBus / 真 registry）+ 伪 adapter + 伪 session store。
 */

function header(): SessionEvent {
  return {
    type: 'session/header',
    id: 's1',
    createdAt: '2026-10-18T00:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-chat',
    cwd: '/tmp',
  }
}

/** 三个回合的事件序列（第三个回合只有用户输入，模拟"正在跑"）。 */
function threeTurns(): SessionEvent[] {
  return [
    header(),
    { type: 'turn/start', turnNo: 1 },
    { type: 'user/message', content: '第一个问题' },
    { type: 'assistant/message', content: '第一个回答', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'turn/end', turnNo: 1 },
    { type: 'turn/start', turnNo: 2 },
    { type: 'user/message', content: '第二个问题' },
    { type: 'assistant/message', content: '第二个回答', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'turn/end', turnNo: 2 },
    { type: 'turn/start', turnNo: 3 },
    { type: 'user/message', content: '第三个问题' },
  ]
}

describe('findCompactionCut', () => {
  it('10 · 有可摘要内容时切点 = 追加位置（整段历史进摘要，03 §4.4 的位置切点语义）', () => {
    const events = threeTurns()
    expect(findCompactionCut(events)).toBe(events.length)
  })

  it('11 · 只有 header 与回合边界时不压缩（无可摘要的事实）', () => {
    expect(findCompactionCut([header(), { type: 'turn/start', turnNo: 1 }])).toBe(0)
  })

  it('12 · 有 tool/result 也算可摘要内容', () => {
    const events: SessionEvent[] = [
      header(),
      {
        type: 'tool/result',
        toolCallId: 'c1',
        result: { callId: 'c1', name: 'read', ok: true, content: 'ok' },
      },
    ]
    expect(findCompactionCut(events)).toBe(events.length)
  })
})

describe('renderTranscript', () => {
  it('13 · user / assistant / tool 三种形态齐全', () => {
    const text = renderTranscript([
      { type: 'user/message', content: '问题' },
      {
        type: 'assistant/message',
        content: '回答',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        type: 'tool/result',
        toolCallId: 'c1',
        result: { callId: 'c1', name: 'read', ok: true, content: '内容' },
      },
    ])
    expect(text).toContain('用户：问题')
    expect(text).toContain('助手：回答')
    expect(text).toContain('[调用 read({"path":"a"})]')
    expect(text).toContain('[工具结果 read · ok] 内容')
  })

  it('14 · 单条工具结果超长被截断', () => {
    const long = 'x'.repeat(2000)
    const text = renderTranscript(
      [
        {
          type: 'tool/result',
          toolCallId: 'c1',
          result: { callId: 'c1', name: 'read', ok: false, content: long, error: { code: 'execution_error', message: 'boom' } },
        },
      ],
      { maxItemChars: 100 },
    )
    expect(text).toContain('error:execution_error')
    expect(text).not.toContain(long)
    expect(text).toContain('已截断')
  })

  it('15 · 带上既有 compaction 的摘要（二次压缩不丢更早历史）', () => {
    const text = renderTranscript([
      { type: 'compaction', summary: '更早的摘要', boundary: 2 },
      { type: 'user/message', content: '新问题' },
    ])
    expect(text).toContain('会话摘要（更早部分）：更早的摘要')
    expect(text).toContain('用户：新问题')
  })

  it('16 · 超出总量预算时从最旧开始丢，并注明省略条数', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', content: 'a'.repeat(100) },
      { type: 'user/message', content: 'b'.repeat(100) },
      { type: 'user/message', content: 'c'.repeat(100) },
    ]
    const text = renderTranscript(events, { maxChars: 150 })
    expect(text.startsWith('…（更早的')).toBe(true)
    expect(text).toContain('已省略）')
    expect(text).toContain('ccc')
    expect(text).not.toContain('aaa')
  })

  it('17 · 只有 header 时为空串（触发"不压缩"）', () => {
    expect(renderTranscript([header()])).toBe('')
  })

  // review Y5：原实现只截工具结果，用户/assistant 原文不设限——超大单条输入
  // 会把摘要请求本身灌爆（它要压的正是"太大"，发给模型的请求却更大）
  it('17b · 用户 / assistant / 调用参数 / 旧摘要同样受单条上限约束（review Y5）', () => {
    const long = 'y'.repeat(2000)
    const text = renderTranscript(
      [
        { type: 'compaction', summary: long, boundary: 1 },
        { type: 'user/message', content: long },
        {
          type: 'assistant/message',
          content: long,
          toolCalls: [{ id: 'c1', name: 'write', arguments: long }],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
      { maxItemChars: 100 },
    )
    expect(text).not.toContain(long)
    expect(text.match(/已截断/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('17c · 单条上限自动夹到 ≤ 总量预算（"至少保一行"不再放行超长行）', () => {
    const events: SessionEvent[] = [{ type: 'user/message', content: 'z'.repeat(500) }]
    // 未夹紧时：一条 500 字符的行超过 maxChars=200 仍会被"至少保一行"整体放行
    const text = renderTranscript(events, { maxItemChars: 400, maxChars: 200 })
    // 200 上限 + 截断后缀/前缀的少量开销；对照未修复时的 503 字符
    expect(text.length).toBeLessThanOrEqual(220)
    expect(text).toContain('已截断')
  })
})

/** 伪 session store：内存数组，记录写入。 */
function fakeStore(initial: SessionEvent[]) {
  const events = [...initial]
  return {
    events,
    store: {
      create: async () => ({ id: 's1', meta: { id: 's1', createdAt: '', provider: 'deepseek', model: 'm', cwd: '/tmp' } }),
      open: async (id: string) => {
        if (id !== 's1') throw new Error('not found')
        return { id, meta: { id, createdAt: '', provider: 'deepseek', model: 'm', cwd: '/tmp' } }
      },
      list: async () => [],
      read: async () => [...events],
      append: async (_id: string, event: SessionEvent) => {
        events.push(event)
      },
      subscribe: () => () => {},
    },
  }
}

/** 伪 adapter：按脚本产出文本，或抛出指定错误。 */
function fakeAdapter(spec: string | Error): LlmAdapter {
  return {
    stream: () =>
      (async function* (): AsyncIterable<StreamEvent> {
        if (spec instanceof Error) throw spec
        yield { type: 'text', delta: spec }
        yield { type: 'end' }
      })(),
  }
}

function harness(spec: string | Error, initial: SessionEvent[] = threeTurns(), configPatch: Partial<Config> = {}) {
  const config = createDefaultConfig()
  config.logLevel = 'error'
  Object.assign(config, configPatch)
  const ctx = createKernel(config, new AbortController().signal)
  const { store, events } = fakeStore(initial)
  ctx.sessions.mount(store)
  const chunks: unknown[] = []
  ctx.events.on('stream/chunk', (payload) => {
    chunks.push(payload)
  })
  const warn = vi.spyOn(ctx.log, 'warn').mockImplementation(() => {})
  const info = vi.spyOn(ctx.log, 'info').mockImplementation(() => {})
  return { ctx, events, chunks, warn, info, adapter: fakeAdapter(spec) }
}

describe('compactSession', () => {
  it('18 · 正常压缩：追加 compaction 事件，boundary 为被折叠的最后一个回合号', async () => {
    const h = harness('这是一份摘要')
    const ok = await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => h.adapter,
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(ok.compacted).toBe(true)
    const compaction = h.events.find((e) => e.type === 'compaction')
    expect(compaction).toBeDefined()
    // 整段历史（含当前回合）被折叠，故 boundary 是当前回合号 3
    expect(compaction).toMatchObject({ summary: '这是一份摘要', boundary: 3 })
  })

  it('18b · 摘要输入覆盖全部历史事件（含当前回合输入），不静默丢事实', async () => {
    const h = harness('摘要')
    let sent = ''
    h.ctx.events.onWaterfall('llm/request', (req) => {
      sent = req.messages[0]?.content ?? ''
    })
    await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => h.adapter,
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(sent).toContain('第一个问题')
    expect(sent).toContain('第三个问题')
    // keepTurns 作为粒度指引出现在指令里
    expect(sent).toContain('最近 4 个回合')
  })

  it('19 · 空摘要不写入（守卫：不能把历史换成空文本）', async () => {
    const h = harness('   ')
    const ok = await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => h.adapter,
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(ok.compacted).toBe(false)
    expect(h.events.some((e) => e.type === 'compaction')).toBe(false)
    expect(h.warn).toHaveBeenCalled()
  })

  it('20 · 摘要请求失败：跳过压缩且不抛', async () => {
    const h = harness(new LlmError('HTTP 500', { kind: 'http', status: 500 }))
    const ok = await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => h.adapter,
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(ok.compacted).toBe(false)
    expect(h.warn).toHaveBeenCalled()
    expect(h.events.some((e) => e.type === 'compaction')).toBe(false)
  })

  it('19b · 摘要用量必须回传给调用方（真实花销计入 totalUsage，设计 §8-Q8）', async () => {
    const h = harness('这是一份摘要')
    const ok = await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => ({
        stream: () =>
          (async function* (): AsyncIterable<StreamEvent> {
            yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 4 } }
            yield { type: 'text', delta: '这是一份摘要' }
            yield { type: 'usage', usage: { inputTokens: 90, outputTokens: 12 } }
            yield { type: 'end' }
          })(),
      }),
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(ok.compacted).toBe(true)
    // 多片 usage 取最后一个（与回合流同口径）
    expect(ok.usage).toMatchObject({ inputTokens: 90, outputTokens: 12 })
  })

  it('19c · 摘要失败时，已送达的用量仍然回传（不能因为跳过压缩就丢花销）', async () => {
    const h = harness('摘要')
    const ok = await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => ({
        stream: () =>
          (async function* (): AsyncIterable<StreamEvent> {
            yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 6 } }
            throw new LlmError('HTTP 500', { kind: 'http', status: 500 })
          })(),
      }),
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(ok.compacted).toBe(false)
    expect(ok.usage).toMatchObject({ inputTokens: 50, outputTokens: 6 })
  })

  it('21 · 压缩请求不带 tools，也不派发 stream/chunk', async () => {
    const h = harness('摘要')
    let seenTools: unknown[] | undefined
    h.ctx.events.onWaterfall('llm/request', (req) => {
      seenTools = req.tools as unknown[]
    })
    await compactSession({
      ctx: h.ctx,
      sessionId: 's1',
      resolveAdapter: () => h.adapter,
      events: [...h.events],
      signal: new AbortController().signal,
    })
    expect(seenTools).toEqual([])
    expect(h.chunks).toHaveLength(0)
  })
})
