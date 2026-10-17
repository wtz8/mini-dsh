import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LLMRequest, ModelConfig } from '../contracts.js'
import { LlmError } from '../errors.js'
import { createOpenAiAdapter } from './adapter.js'
import type { FetchLike } from './types.js'

/**
 * adapter 单元测试（设计 §6.1）：注入伪 fetch（真实 `Response` + `ReadableStream`），
 * 全程不打网络。覆盖事件序列、错误分类、取消与提前退出的关流。
 */

const KEY_ENV = 'MDSH_TEST_API_KEY'

const model: ModelConfig = {
  provider: 'deepseek',
  name: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: KEY_ENV,
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** 伪 fetch 记录的调用。 */
interface FakeCall {
  url: string
  init: RequestInit
}
interface Fake {
  fetchImpl: FetchLike
  calls: FakeCall[]
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): Fake {
  const calls: FakeCall[] = []
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init as RequestInit })
    return Promise.resolve(handler(String(url), init as RequestInit))
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

/** 用文本或字节分片构造 SSE 响应（字节分片用于验证多字节字符被切断的解码）。 */
function sseResponse(chunks: Array<string | Uint8Array>, status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

/** 收集一条流的全部事件。 */
async function collect(adapter: ReturnType<typeof createOpenAiAdapter>, req: LLMRequest) {
  const events = []
  for await (const event of adapter.stream(req)) events.push(event)
  return events
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('adapter · 正常流', () => {
  it('事件序列：text → usage → end（[DONE] 终结）', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl, calls } = makeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    const adapter = createOpenAiAdapter(model, { fetchImpl })

    const events = await collect(adapter, request())
    expect(events).toEqual([
      { type: 'text', delta: 'he' },
      { type: 'text', delta: 'llo' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: 'end' },
    ])

    // 请求形态：URL、鉴权头与流式开关（生产侧最易错的三处）
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-test')
    expect(JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('tool-call 增量按 index 归属，原样透传给 06', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"p' +
          '\\":1}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )

    const events = await collect(createOpenAiAdapter(model, { fetchImpl }), request())
    expect(events).toEqual([
      { type: 'tool-call', delta: { index: 0, id: 'c1', name: 'read', argumentsDelta: '{"p":1}' } },
      { type: 'end' },
    ])
  })

  it('多字节字符被 TCP 分片切断：解码后仍是完整汉字', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const han = new TextEncoder().encode('你') // 0xe4 0xbd 0xa0，故意在中间切断
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        new Uint8Array([...new TextEncoder().encode('data: {"choices":[{"delta":{"content":"')]),
        new Uint8Array([han[0]!]),
        new Uint8Array([...han.slice(1), ...new TextEncoder().encode('"}}]}\n\ndata: [DONE]\n\n')]),
      ]),
    )

    const events = await collect(createOpenAiAdapter(model, { fetchImpl }), request())
    expect(events).toEqual([
      { type: 'text', delta: '你' },
      { type: 'end' },
    ])
  })

  it('流提前 EOF 且无 [DONE]：补发一次 end', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() => sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']))

    const events = await collect(createOpenAiAdapter(model, { fetchImpl }), request())
    expect(events).toEqual([{ type: 'text', delta: 'x' }, { type: 'end' }])
  })

  it('流末 [DONE] 带尾随空格：仍正常收尾，不因最后一帧判死整条流', async () => {
    // 回归：修复前该帧会被当普通数据帧送进 JSON.parse，在模型输出已产出后抛
    // `protocol`，导致整个回合被判失败（探针 K2/K3 复现）
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        'data: [DONE] \n\n',
      ]),
    )

    const events = await collect(createOpenAiAdapter(model, { fetchImpl }), request())
    expect(events).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      { type: 'end' },
    ])
  })

  it('非对象帧（网关的 `data: null` 空闲帧）被忽略，流继续正常收尾', async () => {
    // 忽略而非判错：此时模型输出已产出，为空闲帧中断整条流不划算。
    // 容忍层在 adapter（编排层），`toStreamEvents` 的严格语义保持不变。
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: null\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )

    const events = await collect(createOpenAiAdapter(model, { fetchImpl }), request())
    expect(events).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
      { type: 'end' },
    ])
  })
})

describe('adapter · 错误分类', () => {
  it('HTTP 非 2xx：kind=http，带 status 与截断后的响应体', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() => new Response('{"error":"bad key"}', { status: 401 }))
    const adapter = createOpenAiAdapter(model, { fetchImpl })

    const err = await collect(adapter, request()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('http')
    expect((err as LlmError).status).toBe(401)
    expect((err as LlmError).message).toContain('bad key')
  })

  it('网络失败：kind=network，带底层原因', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() => {
      throw new Error('ECONNREFUSED')
    })

    const err = await collect(createOpenAiAdapter(model, { fetchImpl }), request()).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('network')
    expect((err as LlmError).message).toContain('ECONNREFUSED')
  })

  it('非法 JSON 帧：kind=protocol', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() => sseResponse(['data: {not json}\n\n']))

    const err = await collect(createOpenAiAdapter(model, { fetchImpl }), request()).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('protocol')
    expect((err as LlmError).message).toContain('{not json}')
  })

  it('响应无 body：kind=protocol', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() => new Response(null, { status: 200 }))

    const err = await collect(createOpenAiAdapter(model, { fetchImpl }), request()).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('protocol')
  })

  it('API key 未设置：调用 stream() 时同步抛（D4），且一次请求都不发', async () => {
    vi.stubEnv(KEY_ENV, undefined)
    const { fetchImpl, calls } = makeFetch(() => sseResponse(['data: [DONE]\n\n']))
    const adapter = createOpenAiAdapter(model, { fetchImpl })

    // 关键断言：不是"首次 next() 才失败"，而是调用点即失败
    expect(() => adapter.stream(request())).toThrow(LlmError)
    expect(calls).toHaveLength(0)
    try {
      adapter.stream(request())
    } catch (err) {
      expect((err as LlmError).kind).toBe('config')
      expect((err as LlmError).message).toContain(KEY_ENV)
    }
  })

  it('API key 为空白也视为未设置；正常值会被 trim 后放进鉴权头', async () => {
    vi.stubEnv(KEY_ENV, '   ')
    const { fetchImpl } = makeFetch(() => sseResponse(['data: [DONE]\n\n']))
    expect(() => createOpenAiAdapter(model, { fetchImpl }).stream(request())).toThrow(LlmError)

    vi.stubEnv(KEY_ENV, '  sk-x  ')
    const fake = makeFetch(() => sseResponse(['data: [DONE]\n\n']))
    await collect(createOpenAiAdapter(model, { fetchImpl: fake.fetchImpl }), request())
    expect((fake.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-x')
  })

  it('调用前 signal 已 abort：同步抛 aborted', () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl, calls } = makeFetch(() => sseResponse(['data: [DONE]\n\n']))
    const controller = new AbortController()
    controller.abort()

    expect(() => createOpenAiAdapter(model, { fetchImpl }).stream(request({ signal: controller.signal }))).toThrow(
      LlmError,
    )
    expect(calls).toHaveLength(0)
  })

  it('契约外畸形请求：构造期错误原样抛出，不伪装成网络故障', async () => {
    // 请求构造在 try 之外（修复 P2-3）：编程错误必须是 TypeError，
    // 否则 07 会把本地 bug 提示成"网络故障"，误导排查方向
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch(() => sseResponse(['data: [DONE]\n\n']))
    const malformed = request() as unknown as { tools?: unknown }
    malformed.tools = undefined // 契约要求必填，此处模拟 `as any` / JS 侧调用

    const caught = await collect(createOpenAiAdapter(model, { fetchImpl }), malformed as never).catch(
      (e: unknown) => e,
    )
    expect(caught).toBeInstanceOf(TypeError)
    expect(caught).not.toBeInstanceOf(LlmError)
  })
})

describe('adapter · 取消与提前退出', () => {
  it('迭代中 abort：抛 aborted 并结束迭代', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const { fetchImpl } = makeFetch((_url, init) => {
      const signal = init.signal as AbortSignal
      const encoder = new TextEncoder()
      let sent = false
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
            return
          }
          // 模拟 provider 不再发数据：直到取消信号到达才让流出错
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
              { once: true },
            )
          })
        },
      })
      return new Response(stream, { status: 200 })
    })

    const controller = new AbortController()
    const adapter = createOpenAiAdapter(model, { fetchImpl })
    const seen: unknown[] = []
    // 收到首片后取消：伪流随后以 AbortError 出错，迭代器应以 aborted 结束
    const err = await (async () => {
      try {
        for await (const event of adapter.stream(request({ signal: controller.signal }))) {
          seen.push(event)
          controller.abort()
        }
        return undefined
      } catch (e) {
        return e
      }
    })()

    expect(seen).toEqual([{ type: 'text', delta: 'a' }])
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
    // 本例不断言 cancel：流已因取消而 **errored**，`reader.cancel()` 对出错的流是
    // no-op（Streams 规范），底层连接由 fetch 的 signal 负责销毁。"关流"的兜底由
    // 下一条"提前 break"用例断言（那条流是 open 状态）。
  })

  it('调用方提前 break：不抛错，且 reader 被 cancel（无悬挂连接）', async () => {
    vi.stubEnv(KEY_ENV, 'sk-test')
    const state = { cancelled: false }
    const { fetchImpl } = makeFetch(() => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 只发一帧且不 close：让调用方有机会提前退出
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
        },
        cancel() {
          state.cancelled = true
        },
      })
      return new Response(stream, { status: 200 })
    })

    const adapter = createOpenAiAdapter(model, { fetchImpl })
    const seen: unknown[] = []
    for await (const event of adapter.stream(request())) {
      seen.push(event)
      break // 提前退出
    }
    expect(seen).toEqual([{ type: 'text', delta: 'a' }])
    expect(state.cancelled).toBe(true)
  })
})
