import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config, Ctx, PluginEntry, SessionEvent, Unsubscribe } from '../../src/index.js'
import { boot, definePlugin, deriveMessages, registerBuiltin, shutdown } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { createLlmPlugin } from '../../src/llm/index.js'
import type { FetchLike } from '../../src/llm/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { registerSessionBuiltin } from '../../src/session/index.js'
import { registerToolsBuiltin } from '../../src/tools/index.js'
import { createAgentPlugin } from '../../src/agent/index.js'

/**
 * 06-agent 集成测试（设计 §6.2）：**真实组合根 + 真实 JSONL 会话 + 真实工具 +
 * 真实 prompt 段**，只在"网络出口"这一层注入伪 fetch（与 02 集成同式，全程不打网络）。
 *
 * 七条链路：纯问答 / 工具调用 / 并发与独占 / 取消 / 压缩 / resume / 审批失败关闭与放行。
 */

const KEY_ENV = 'DEEPSEEK_API_KEY'

/** 一次请求的伪响应：分片数组。 */
type Responder = (body: { messages: Array<{ role: string; content: string }> }) => Array<string>

interface Fake {
  fetchImpl: FetchLike
  calls: Array<{ body: string }>
}

function scriptedFetch(responder: Responder): Fake {
  const calls: Array<{ body: string }> = []
  const encoder = new TextEncoder()
  const fetchImpl = ((_url: unknown, init?: RequestInit) => {
    const raw = String(init?.body ?? '{}')
    calls.push({ body: raw })
    const chunks = responder(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

/** 只发一片就挂住的伪 fetch（用于取消链路）：signal 触发时把流置错。 */
function hangingFetch(firstChunk: string): Fake {
  const calls: Array<{ body: string }> = []
  const encoder = new TextEncoder()
  const fetchImpl = ((_url: unknown, init?: RequestInit) => {
    calls.push({ body: String(init?.body ?? '{}') })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstChunk))
        // 永不 close：模拟"模型还在说"。取消时把流打错，让 adapter 收到中断
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'))
          } catch {
            /* 已关闭则忽略 */
          }
        })
      },
    })
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

/** 文本分片。 */
function textChunk(delta: string): string {
  return `data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}\n\n`
}

/** 工具调用分片（单个调用，一次给全）。 */
function callChunk(id: string, name: string, args: Record<string, unknown>): string {
  const payload = {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 多个工具调用（不同 index）。 */
function callChunks(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string {
  const payload = {
    choices: [
      {
        delta: {
          tool_calls: calls.map((c, index) => ({
            index,
            id: c.id,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

const DONE = 'data: [DONE]\n\n'
const USAGE = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n'

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []
let workDir: string
let sessionsDir: string
let probeOrder: string[] = []
const tempDirs: string[] = []

/** 建临时目录并登记（afterEach 统一清理）。 */
async function newDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 寄存器：把并发轨迹记录下来的探针工具（模拟 08/09 类的第三方注册）。 */
function registerProbeBuiltin(): void {
  unsubscribes.push(
    registerBuiltin(
      'probe',
      definePlugin(() => ({
        name: 'probe',
        setup(ctx): void {
          const make = (name: string, delayMs: number, concurrency: 'parallel' | 'exclusive'): void => {
            ctx.tools.register({
              name,
              description: `probe ${name}`,
              schema: { type: 'object', properties: {} },
              concurrency,
              async execute(): Promise<string> {
                probeOrder.push(`${name}:enter`)
                await new Promise((r) => setTimeout(r, delayMs))
                probeOrder.push(`${name}:exit`)
                return 'ok'
              },
            })
          }
          make('probe-a', 40, 'parallel')
          make('probe-b', 40, 'parallel')
          make('probe-x', 10, 'exclusive')
        },
      })),
    ),
  )
}

function makeConfig(plugins: PluginEntry[], patch: Partial<Config> = {}): Config {
  const config = createDefaultConfig()
  config.model.apiKeyEnv = KEY_ENV
  config.plugins = plugins
  Object.assign(config, patch)
  return config
}

function basePlugins(agentOptions?: Parameters<typeof createAgentPlugin>[0]): PluginEntry[] {
  unsubscribes.push(registerSessionBuiltin(), registerPromptBuiltin(), registerToolsBuiltin())
  unsubscribes.push(registerBuiltin('agent-loop', createAgentPlugin(agentOptions ?? {})))
  return [
    { source: 'builtin:session', config: { dir: sessionsDir } },
    { source: 'builtin:llm' },
    { source: 'builtin:prompt' },
    { source: 'builtin:tools' },
    { source: 'builtin:agent-loop' },
  ]
}

async function bootAll(
  fetchImpl: FetchLike,
  patch: Partial<Config> = {},
  agentOptions?: Parameters<typeof createAgentPlugin>[0],
  extraPlugins: PluginEntry[] = [],
): Promise<Ctx> {
  unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl })))
  const plugins = [...basePlugins(agentOptions), ...extraPlugins]
  const ctx = await boot(makeConfig(plugins, patch))
  contexts.push(ctx)
  return ctx
}

/** 清空全部 builtin 注册（同一进程内第二次 boot 前调用，避免同名重复注册抛错）。 */
function resetBuiltins(): void {
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
}

/** 取当前唯一的会话 id（07 在真实使用中经 `session/append` 的 header 事件拿到）。 */
async function singleSessionId(ctx: Ctx): Promise<string> {
  const metas = await ctx.sessions.list()
  expect(metas).toHaveLength(1)
  return metas[0]?.id ?? ''
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((e) => e.type)
}

beforeEach(async () => {
  vi.stubEnv(KEY_ENV, 'sk-integration')
  probeOrder = []
  workDir = await newDir('mdsh-agent-it-')
  sessionsDir = await newDir('mdsh-agent-sessions-')
})

afterEach(async () => {
  for (const ctx of contexts) await shutdown(ctx)
  contexts.length = 0
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
  vi.unstubAllEnvs()
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('06-agent 集成', () => {
  it('链路 1 · 纯问答：一步结束，事件序列与投影正确', async () => {
    const fake = scriptedFetch(() => [textChunk('你好'), USAGE, DONE])
    const ctx = await bootAll(fake.fetchImpl)
    const ctl = ctx.agent.resolve()

    const summary = await ctl.run({ text: '你好吗' })
    expect(summary).toMatchObject({ turnNo: 1, stepCount: 1, interrupted: false })
    expect(summary.totalUsage).toMatchObject({ inputTokens: 7, outputTokens: 3 })

    const sessionId = await singleSessionId(ctx)
    const events = await ctx.sessions.read(sessionId)
    expect(types(events)).toEqual([
      'session/header',
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ])
    const messages = deriveMessages(events)
    expect(messages).toEqual([
      { role: 'user', content: '你好吗' },
      { role: 'assistant', content: '你好' },
    ])
  })

  it('链路 2 · 工具调用：真实 read 执行、结果入 log、第二步收尾', async () => {
    const target = path.join(workDir, 'a.txt')
    await fs.writeFile(target, 'hello from file')
    let step = 0
    const fake = scriptedFetch(() => {
      step += 1
      return step === 1
        ? [callChunk('c1', 'read', { path: target }), DONE]
        : [textChunk('读到了'), DONE]
    })
    const ctx = await bootAll(fake.fetchImpl, { permissions: { read: 'auto' } })
    const ctl = ctx.agent.resolve()

    const summary = await ctl.run({ text: '读一下 a.txt' })
    expect(summary.stepCount).toBe(2)

    const sessionId = await singleSessionId(ctx)
    const events = await ctx.sessions.read(sessionId)
    const results = events.filter((e) => e.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect((results[0] as { result: { ok: boolean; content: string } }).result.ok).toBe(true)
    expect((results[0] as { result: { content: string } }).result.content).toContain('hello from file')
    // 投影里 assistant 的 toolCalls 与 tool 消息成对
    const messages = deriveMessages(events)
    expect(messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('链路 3 · 并发与独占：parallel 重叠、exclusive 独占屏障', async () => {
    registerProbeBuiltin()
    let step = 0
    const fake = scriptedFetch(() => {
      step += 1
      return step === 1
        ? [
            callChunks([
              { id: 'c1', name: 'probe-a', args: {} },
              { id: 'c2', name: 'probe-b', args: {} },
              { id: 'c3', name: 'probe-x', args: {} },
            ]),
            DONE,
          ]
        : [textChunk('搞定'), DONE]
    })
    const ctx = await bootAll(
      fake.fetchImpl,
      { permissions: { 'probe-a': 'auto', 'probe-b': 'auto', 'probe-x': 'auto' } },
      undefined,
      [{ source: 'builtin:probe' }],
    )
    const ctl = ctx.agent.resolve()
    const summary = await ctl.run({ text: '跑三个探针' })
    expect(summary.stepCount).toBe(2)

    expect(probeOrder[0]).toBe('probe-a:enter')
    expect(probeOrder[1]).toBe('probe-b:enter')
    // 独占工具必须在两个并发工具都结束后才开始
    expect(probeOrder.indexOf('probe-x:enter')).toBeGreaterThan(probeOrder.indexOf('probe-a:exit'))
    expect(probeOrder.indexOf('probe-x:enter')).toBeGreaterThan(probeOrder.indexOf('probe-b:exit'))
  })

  it('链路 4 · 取消：流中途 cancel ⇒ 落 interrupted 前缀并收尾', async () => {
    const fake = hangingFetch(textChunk('说到一半'))
    const ctx = await bootAll(fake.fetchImpl)
    const ctl = ctx.agent.resolve()

    // 等**首片真的到达**再取消，而不是 sleep 一段去赌：原写法 `setTimeout(50)` 在
    // 全量并行跑 60 个测试文件时可能取消得比首片还早，此刻回合还没产出任何文本，
    // 落进 06 §5 边界表 19 的"空回合"（只有 turn/start + user/message + turn/end，
    // **没有 assistant/message**），下面的 find 就会拿到 undefined——曾偶发红灯。
    let offFirst: Unsubscribe | undefined
    const firstChunk = new Promise<void>((resolve) => {
      offFirst = ctx.events.on('stream/chunk', ({ delta }) => {
        if (delta.type === 'text') {
          offFirst?.()
          resolve()
        }
      })
    })

    const task = ctl.run({ text: '讲个长故事' })
    await firstChunk
    offFirst?.()
    ctl.cancel()
    const summary = await task

    expect(summary.interrupted).toBe(true)
    const sessionId = await singleSessionId(ctx)
    const events = await ctx.sessions.read(sessionId)
    const assistant = events.find((e) => e.type === 'assistant/message')
    expect(assistant).toMatchObject({ content: '说到一半', interrupted: true })
    expect(types(events)).toContain('turn/end')
  })

  it('链路 5 · 压缩：超阈值写入 compaction，投影只剩摘要', async () => {
    const fake = scriptedFetch((body) => {
      const first = body.messages[0]?.content ?? ''
      return first.includes('压缩成一份结构化摘要')
        ? [textChunk('这是压缩摘要'), DONE]
        : [textChunk('最终回答'), DONE]
    })
    const ctx = await bootAll(fake.fetchImpl, {
      contextWindow: 200,
      compaction: { thresholdRatio: 0.5, keepTurns: 2 },
    })
    const ctl = ctx.agent.resolve()

    await ctl.run({ text: 'x'.repeat(600) })
    const sessionId = await singleSessionId(ctx)
    const events = await ctx.sessions.read(sessionId)
    const compaction = events.find((e) => e.type === 'compaction')
    expect(compaction).toMatchObject({ summary: '这是压缩摘要' })
    // 投影：摘要在最前，其后是本回合的助手回复
    const messages = deriveMessages(events)
    expect(messages[0]).toEqual({ role: 'user', content: '这是压缩摘要' })
  })

  it('链路 6 · resume：同一会话第二个回合，turnNo 从 log 继续', async () => {
    let step = 0
    const fake = scriptedFetch(() => {
      step += 1
      return [textChunk(`第${step}轮`), DONE]
    })
    const ctx = await bootAll(fake.fetchImpl)
    const ctl = ctx.agent.resolve()
    const first = await ctl.run({ text: '第一轮' })
    const second = await ctl.run({ text: '第二轮' })
    expect(first.turnNo).toBe(1)
    expect(second.turnNo).toBe(2)
    await shutdown(ctx)

    // 换一个进程态（重新 boot），传 sessionId 复用会话
    const sessionId = await singleSessionId(ctx)
    resetBuiltins()
    const ctx2 = await bootAll(fake.fetchImpl, {}, { sessionId })
    const ctl2 = ctx2.agent.resolve()
    const third = await ctl2.run({ text: '第三轮' })
    expect(third.turnNo).toBe(3)
    const events = await ctx2.sessions.read(sessionId)
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(3)
  })

  it('链路 7 · 审批：无 approve 时 ask 失败关闭；注入 approve 后放行', async () => {
    const target = path.join(workDir, 'b.txt')
    await fs.writeFile(target, 'secret')

    // A：默认（无 approve）⇒ 权限兜底 ask 失败关闭（PB-02 ②）
    let stepA = 0
    const fakeA = scriptedFetch(() => {
      stepA += 1
      return stepA === 1 ? [callChunk('c1', 'read', { path: target }), DONE] : [textChunk('被拒了'), DONE]
    })
    const ctxA = await bootAll(fakeA.fetchImpl)
    const ctlA = ctxA.agent.resolve()
    await ctlA.run({ text: '读 b.txt' })
    const eventsA = await ctxA.sessions.read(await singleSessionId(ctxA))
    const resultA = eventsA.find((e) => e.type === 'tool/result') as {
      result: { ok: boolean; error?: { code: string } }
    }
    expect(resultA.result.ok).toBe(false)
    expect(resultA.result.error?.code).toBe('permission_denied')
    await shutdown(ctxA)
    resetBuiltins()

    // B：注入 approve ⇒ 放行（换一个 sessions 目录，保证"只有这一个会话"可断言）
    sessionsDir = await newDir('mdsh-agent-sessions-b-')
    let stepB = 0
    const fakeB = scriptedFetch(() => {
      stepB += 1
      return stepB === 1 ? [callChunk('c1', 'read', { path: target }), DONE] : [textChunk('读到了'), DONE]
    })
    const ctxB = await bootAll(fakeB.fetchImpl, {}, { approve: () => true })
    const ctlB = ctxB.agent.resolve()
    await ctlB.run({ text: '读 b.txt' })
    const eventsB = await ctxB.sessions.read(await singleSessionId(ctxB))
    const resultB = eventsB.find((e) => e.type === 'tool/result') as { result: { ok: boolean; content: string } }
    expect(resultB.result.ok).toBe(true)
    expect(resultB.result.content).toContain('secret')
  })
})
