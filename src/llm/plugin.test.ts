import { afterEach, describe, expect, it } from 'vitest'

import type { Ctx, ModelConfig } from '../contracts.js'
import { LlmRegistryImpl } from '../plugin/containers.js'
import { createLlmPlugin, registerLlmBuiltin } from './plugin.js'
import type { FetchLike } from './types.js'

/**
 * `builtin:llm` 插件单元测试（设计 §6.1）：插件形态、向 `ctx.llm` 注册 provider、
 * 注入的 fetch 真的被 adapter 用上、注册出口的退订语义。
 *
 * 用内核真实的 `LlmRegistryImpl`（同包内的容器实现），不 mock 注册表语义。
 */

const model: ModelConfig = {
  provider: 'deepseek',
  name: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'MDSH_PLUGIN_TEST_KEY',
}

/** 只带 llm 服务面的最小 ctx（Registry 用真实实现，其余字段与本测试无关）。 */
function ctxWithRegistry(): { ctx: Ctx; registry: LlmRegistryImpl } {
  const registry = new LlmRegistryImpl()
  return { ctx: { llm: registry } as unknown as Ctx, registry }
}

/** 返回 [DONE] 空流的伪 fetch（不打网络）。 */
function fakeFetch(calls: { count: number }): FetchLike {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            // 真发一个 [DONE] 帧：零帧空体在 02 review Y6 之后按协议错误处理
            c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            c.close()
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    )) as unknown as FetchLike
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.count += 1
    void url
    void init
    return fetchImpl(url, init)
  }) as unknown as FetchLike
}

const unsubscribes: Array<() => void> = []
afterEach(() => {
  while (unsubscribes.length > 0) unsubscribes.pop()?.()
})

describe('createLlmPlugin', () => {
  it('工厂产物是插件：name 固定 builtin:llm，setup 可用', async () => {
    const factory = createLlmPlugin()
    const plugin = await factory()

    expect(plugin.name).toBe('builtin:llm')
    expect(typeof plugin.setup).toBe('function')
    // 不实现 dispose：本插件不持有任何资源（设计 §5 边界表）
    expect(plugin.dispose).toBeUndefined()
  })

  it('setup 向 ctx.llm 注册 deepseek；同名重复注册抛错（内核语义）', async () => {
    const { ctx, registry } = ctxWithRegistry()
    const plugin = await createLlmPlugin()()

    await plugin.setup(ctx)
    expect(typeof registry.resolve('deepseek')).toBe('function')

    // 重复挂载同名 provider → 容器抛 already registered（组合根会转 BootError）
    expect(() => registry.register('deepseek', () => ({ stream: () => [] }) as never)).toThrow(/already registered/)
  })

  it('注入的 fetchImpl 真的被 adapter 使用（全程不打网络）', async () => {
    const calls = { count: 0 }
    const { ctx, registry } = ctxWithRegistry()
    const plugin = await createLlmPlugin({ fetchImpl: fakeFetch(calls) })()
    await plugin.setup(ctx)

    const adapter = registry.resolve('deepseek')(model)
    // 未设 API key → 调用点同步抛 config，一次请求都不发
    expect(() => adapter.stream({} as never)).toThrow(/is not set/)
    expect(calls.count).toBe(0)

    process.env[model.apiKeyEnv] = 'sk-test'
    try {
      const events = []
      for await (const event of adapter.stream({
        model: 'deepseek-chat',
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        events.push(event)
      }
      expect(events).toEqual([{ type: 'end' }])
      expect(calls.count).toBe(1)
    } finally {
      delete process.env[model.apiKeyEnv]
    }
  })
})

describe('registerLlmBuiltin', () => {
  it('注册返回退订句柄；退订后可再次注册（同名重复注册抛错）', () => {
    const first = registerLlmBuiltin()
    unsubscribes.push(first)
    expect(typeof first).toBe('function')
    // 未退订时重复注册 → 内核抛错
    expect(() => registerLlmBuiltin()).toThrow(/already registered/)

    first()
    const second = registerLlmBuiltin()
    unsubscribes.push(second)
    expect(typeof second).toBe('function')
  })
})
