import fs from 'node:fs/promises'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Config, Ctx, LLMRequest } from '../../src/index.js'
import { LlmError, boot, createToolCallAccumulator, registerBuiltin, shutdown } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import type { FetchLike } from '../../src/llm/index.js'
import { createLlmPlugin, registerLlmBuiltin } from '../../src/llm/index.js'

/**
 * 02-llm 集成测试（设计 §6.2）：真实组合根 + 真实 `Response`/`ReadableStream`，
 * 仅在"网络出口"这一层注入伪 fetch——**全程不打网络**，其余链路（boot / 注册表 /
 * 事件总线 / dispose）全是内核真身。
 *
 * 四条链路：注册解析 / 流式（含工具调用聚合）/ 取消 / API key 缺失（01 §5 的落点）。
 *
 * fixture 目录与本仓库其它模块的 `*-fixtures/` 分开（理由同 01 X3：共用目录会在
 * vitest 并行执行时互相踩踏）。
 */

const FIXTURES_DIR = path.join('tests', 'integration', 'llm-fixtures')
const KEY_ENV = 'MDSH_IT_API_KEY'

/** 探针插件：挂载在 `builtin:llm` **之前**，记录后续插件的挂载广播。 */
const PROBE_PLUGIN = `export default () => ({
  name: 'llm-probe',
  setup(ctx) {
    ctx.events.on('plugin/mounted', ({ name }) => {
      globalThis.__m02Probe.mounted.push(name)
    })
  },
})
`

/** 探针写入 globalThis 的观测状态。 */
interface ProbeState {
  mounted: string[]
}

/* ============================================================
 * 工具函数
 * ============================================================ */

function makeConfig(sources: string[], model?: Partial<Config['model']>): Config {
  const config = createDefaultConfig()
  config.model = { ...config.model, ...model }
  config.plugins = sources.map((source) => ({ source }))
  return config
}

interface FakeCall {
  url: string
  headers: Record<string, string>
  body: string
}
interface Fake {
  fetchImpl: FetchLike
  calls: FakeCall[]
}

/** 用给定分片构造伪 fetch（真实 Response + ReadableStream，不打网络）。 */
function sseFetch(chunks: Array<string | Uint8Array>, status = 200): Fake {
  const calls: FakeCall[] = []
  const encoder = new TextEncoder()
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
        }
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } }))
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

function makeRequest(signal: AbortSignal): LLMRequest {
  return {
    system: 'you are mini-dsh',
    messages: [{ role: 'user', content: 'hi' }],
    model: 'deepseek-chat',
    tools: [
      {
        name: 'read',
        description: 'read a file',
        schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    maxTokens: 64,
    signal,
  }
}

/** 探针来源（相对 cwd，与 boot 的解析规则一致）。 */
const probeSource = (): string => path.join(FIXTURES_DIR, 'probe.mjs').replace(/\\/g, '/')

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []

async function bootWith(
  sources: string[],
  model?: Partial<Config['model']>,
): Promise<Awaited<ReturnType<typeof boot>>> {
  const ctx = await boot(makeConfig(sources, model))
  contexts.push(ctx)
  return ctx
}

beforeAll(async () => {
  await fs.mkdir(path.resolve(process.cwd(), FIXTURES_DIR), { recursive: true })
  await fs.writeFile(path.resolve(process.cwd(), FIXTURES_DIR, 'probe.mjs'), PROBE_PLUGIN, 'utf8')
})

afterAll(async () => {
  await fs.rm(path.resolve(process.cwd(), FIXTURES_DIR), { recursive: true, force: true })
})

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop()
    if (ctx) await shutdown(ctx)
  }
  while (unsubscribes.length > 0) unsubscribes.pop()?.()
  vi.unstubAllEnvs()
})

/* ============================================================
 * 链路 1：注册与解析（provider 名即 config.model.provider）
 * ============================================================ */

describe('集成 · 注册与解析链路', () => {
  it('builtin:llm 经组合根挂载后，ctx.llm 可解析 deepseek；未知 provider fail-fast', async () => {
    ;(globalThis as Record<string, unknown>).__m02Probe = { mounted: [] } as ProbeState
    unsubscribes.push(registerLlmBuiltin())

    const ctx = await bootWith([probeSource(), 'builtin:llm'])

    // 挂载广播：探针在 builtin:llm 之前挂载，因此能看到它；探针自身也在名单里
    // （M0 语义：监听器在 setup 内注册，会收到包括自身在内的 plugin/mounted）
    expect(((globalThis as Record<string, unknown>).__m02Probe as ProbeState).mounted).toEqual([
      'llm-probe',
      'builtin:llm',
    ])
    // 注册的 provider 名即 config.model.provider（架构 §5.2 解析约定）
    expect(typeof ctx.llm.resolve(ctx.config.model.provider)).toBe('function')
    // Q1 决议：只注册 deepseek，其它 provider 名一律 fail-fast，不做隐式兜底
    expect(() => ctx.llm.resolve('openai')).toThrow(/not mounted/)
  })
})

/* ============================================================
 * 链路 2：流式链路（伪 fetch + 真实 boot，含工具调用聚合）
 * ============================================================ */

describe('集成 · 流式链路', () => {
  it('经组合根取到的 adapter 产出完整事件序列，且请求形态正确', async () => {
    vi.stubEnv(KEY_ENV, 'sk-integration')
    const fake = sseFetch([
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa' +
        'th\\":\\"/a\\"}"}}]}}]}\n\n',
      'data: {"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n',
      'data: [DONE]\n\n',
    ])
    // 用注入了伪 fetch 的 llm 插件替换默认注册（同一 builtin 名），仍走真实 boot
    unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl: fake.fetchImpl })))
    const ctx = await bootWith(['builtin:llm'], { apiKeyEnv: KEY_ENV })

    const adapter = ctx.llm.resolve(ctx.config.model.provider)(ctx.config.model)
    const events = []
    for await (const event of adapter.stream(makeRequest(ctx.signal))) events.push(event)

    expect(events).toEqual([
      { type: 'text', delta: 'he' },
      { type: 'tool-call', delta: { index: 0, id: 'c1', name: 'read', argumentsDelta: '{"path":"/a"}' } },
      { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } },
      { type: 'end' },
    ])

    // 请求形态：URL、鉴权头、系统提示在前、tools 已映射、流式开关
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    expect(fake.calls[0]?.headers['authorization']).toBe('Bearer sk-integration')
    const body = JSON.parse(fake.calls[0]?.body ?? '{}') as {
      messages: Array<{ role: string; content: string }>
      tools: Array<{ type: string; function: { name: string } }>
      stream: boolean
      max_tokens: number
    }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'you are mini-dsh' })
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: expect.any(Object) } },
    ])
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(64)
  })

  it('06 的用法：tool-call 增量经公共出口的聚合器拼回完整 ToolCall', async () => {
    vi.stubEnv(KEY_ENV, 'sk-integration')
    const fake = sseFetch([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"p' +
        '"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\\":\\"/a\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl: fake.fetchImpl })))
    const ctx = await bootWith(['builtin:llm'], { apiKeyEnv: KEY_ENV })

    // 聚合器经 src/index.ts 转发（插件侧出口），06 不必深引用 src/llm/
    const accumulator = createToolCallAccumulator()
    const adapter = ctx.llm.resolve(ctx.config.model.provider)(ctx.config.model)
    for await (const event of adapter.stream(makeRequest(ctx.signal))) {
      if (event.type === 'tool-call') accumulator.push(event.delta)
    }

    expect(accumulator.result()).toEqual([{ id: 'c1', name: 'read', arguments: '{"path":"/a"}' }])
  })
})

/* ============================================================
 * 链路 3：取消链路
 * ============================================================ */

describe('集成 · 取消链路', () => {
  it('迭代中取消：adapter 以 aborted 结束（进程级 signal 的传导）', async () => {
    vi.stubEnv(KEY_ENV, 'sk-integration')
    const encoder = new TextEncoder()
    const fake: Fake = {
      calls: [],
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        fake.calls.push({ url: String(url), headers: {}, body: '' })
        const signal = init?.signal as AbortSignal
        let sent = false
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
              return
            }
            await new Promise<never>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted by test'), { name: 'AbortError' })),
                { once: true },
              )
            })
          },
        })
        return Promise.resolve(new Response(stream, { status: 200 }))
      }) as unknown as FetchLike,
    }
    unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl: fake.fetchImpl })))
    const ctx = await bootWith(['builtin:llm'], { apiKeyEnv: KEY_ENV })

    const controller = new AbortController()
    const adapter = ctx.llm.resolve(ctx.config.model.provider)(ctx.config.model)
    const seen: unknown[] = []
    const err = await (async () => {
      try {
        for await (const event of adapter.stream(makeRequest(controller.signal))) {
          seen.push(event)
          controller.abort() // 回合级取消：收到首片后中止
        }
        return undefined
      } catch (e) {
        return e
      }
    })()

    expect(seen).toEqual([{ type: 'text', delta: 'a' }])
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
  })
})

/* ============================================================
 * 链路 4：配置缺失链路（01 §5："apiKeyEnv 由 02 在使用点 fail-fast"）
 * ============================================================ */

describe('集成 · API key 缺失链路', () => {
  it('环境变量未设置：stream() 抛 config，且一次请求都没发出', async () => {
    vi.stubEnv('MDSH_IT_MISSING_KEY', undefined)
    const fake = sseFetch(['data: [DONE]\n\n'])
    unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl: fake.fetchImpl })))
    const ctx = await bootWith(['builtin:llm'], { apiKeyEnv: 'MDSH_IT_MISSING_KEY' })

    const adapter = ctx.llm.resolve(ctx.config.model.provider)(ctx.config.model)
    let caught: unknown
    try {
      adapter.stream(makeRequest(ctx.signal))
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).kind).toBe('config')
    expect((caught as LlmError).message).toContain('MDSH_IT_MISSING_KEY')
    // fail-fast 落在使用点：配置问题不该先建连再失败
    expect(fake.calls).toHaveLength(0)
    // boot 本身不受影响（D7：不使用点不校验 provider/key）
    expect(ctx.config.model.apiKeyEnv).toBe('MDSH_IT_MISSING_KEY')
  })
})
