import { describe, expect, it } from 'vitest'

import type { Ctx, PromptSection } from '../contracts.js'
import { CORE_SECTION_IDS } from './core.js'
import { BUILTIN_PROMPT, createPromptPlugin } from './plugin.js'
import { ENVIRONMENT_ID } from './sections/environment.js'
import { GUIDELINES_ID } from './sections/guidelines.js'
import { IDENTITY_ID } from './sections/identity.js'
import { TOOL_USE_ID } from './sections/tool-use.js'
import type { EnvFacts } from './types.js'

/**
 * `builtin:prompt` 插件（设计 §4.1）：薄接线层——把 `process.*` / `ctx.config` /
 * `ctx.tools` 接成 getter，再把段注册进 `ctx.prompt`。真实组合根链路见集成测试。
 */

interface FakeCtx {
  ctx: Ctx
  /** 已注册的段（按注册顺序） */
  registered: PromptSection[]
  /** 改变"已注册工具"的内容——验证惰性与条件渲染 */
  setTools: (names: string[]) => void
}

function fakeCtx(): FakeCtx {
  const registered: PromptSection[] = []
  let tools: string[] = []
  const ctx = {
    prompt: {
      section: (s: PromptSection) => {
        registered.push(s)
      },
      render: () => registered.map((s) => s.render()).join('\n\n'),
    },
    tools: {
      list: () => tools,
      register: () => {},
      get: () => {
        throw new Error('not used')
      },
    },
    config: {
      model: { provider: 'deepseek', name: 'deepseek-chat' },
      contextWindow: 131072,
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    events: {
      on: () => () => {},
      emit: () => {},
      onWaterfall: () => () => {},
      waterfall: async (_t: string, p: unknown) => p,
    },
  } as unknown as Ctx
  return { ctx, registered, setTools: (names) => { tools = names } }
}

/** 按 id 取段；不存在即抛（比非空断言更能定位失败原因）。 */
function find(registered: PromptSection[], id: string): PromptSection {
  const found = registered.find((s) => s.id === id)
  if (!found) throw new Error(`section '${id}' not registered: ${registered.map((s) => s.id)}`)
  return found
}

function fixedFacts(): EnvFacts {
  return {
    cwd: 'D:\\MiniDSH',
    platform: 'win32',
    arch: 'x64',
    now: new Date(2026, 9, 17, 21, 3, 13),
  }
}

describe('builtin:prompt plugin', () => {
  it('插件名固定为 builtin:prompt', async () => {
    const plugin = await createPromptPlugin()()
    expect(plugin.name).toBe(BUILTIN_PROMPT)
  })

  it('setup 向 ctx.prompt 注册全部核心段', async () => {
    const { ctx, registered } = fakeCtx()
    const plugin = await createPromptPlugin()()
    plugin.setup(ctx)
    expect(registered.map((s) => s.id)).toEqual([...CORE_SECTION_IDS])
  })

  it('实例配置 disabled 与构造选项合并生效（替换官方段的唯一路径）', async () => {
    const { ctx, registered } = fakeCtx()
    const plugin = await createPromptPlugin({ disabled: [GUIDELINES_ID] })()
    plugin.setup(ctx, { disabled: [IDENTITY_ID] })
    expect(registered.map((s) => s.id)).toEqual([ENVIRONMENT_ID, TOOL_USE_ID])
  })

  it('实例配置非法时 setup 抛错（非对象 / 数组 / disabled 非字符串数组）', async () => {
    const { ctx } = fakeCtx()
    const plugin = await createPromptPlugin()()
    expect(() => plugin.setup(ctx, 42)).toThrow(/must be an object/)
    // 数组也是 object（typeof），但不放行——否则整个配置被静默忽略（Y1）
    expect(() => plugin.setup(ctx, [IDENTITY_ID])).toThrow(/must be an object/)
    expect(() => plugin.setup(ctx, { disabled: 'core/identity' })).toThrow(/array of strings/)
    expect(() => plugin.setup(ctx, { disabled: [1] })).toThrow(/array of strings/)
  })

  it('disabled 含未知 id 时 setup 抛错（拼错段 id 不该静默生效）', async () => {
    const { ctx } = fakeCtx()
    const plugin = await createPromptPlugin()()
    expect(() => plugin.setup(ctx, { disabled: ['core/identty'] })).toThrow(/core\/identty/)
  })

  it('env / hasTools 是惰性 getter：setup 时不调用，render 时才调用', async () => {
    const { ctx, registered } = fakeCtx()
    let envCalls = 0
    let toolCalls = 0
    const plugin = await createPromptPlugin({
      env: () => {
        envCalls += 1
        return fixedFacts()
      },
      hasTools: () => {
        toolCalls += 1
        return true
      },
    })()
    plugin.setup(ctx)
    expect(envCalls).toBe(0)
    expect(toolCalls).toBe(0)

    find(registered, ENVIRONMENT_ID).render()
    expect(envCalls).toBe(1)
    find(registered, TOOL_USE_ID).render()
    expect(toolCalls).toBe(1)
  })

  it('默认接线：env 取 process 与 ctx.config，hasTools 取 ctx.tools.list()', async () => {
    const { ctx, registered, setTools } = fakeCtx()
    const plugin = await createPromptPlugin()()
    plugin.setup(ctx)

    // 工具未注册 → 工具段不出场
    expect(find(registered, TOOL_USE_ID).render()).toBe('')
    // 工具随后注册 → 下次 render 自动反映（挂载顺序无关，设计 §4.3）
    setTools(['read', 'bash'])
    expect(find(registered, TOOL_USE_ID).render()).toContain('# 工具使用')

    const envText = find(registered, ENVIRONMENT_ID).render()
    expect(envText).toContain(process.cwd())
    expect(envText).toContain('deepseek/deepseek-chat')
    expect(envText).toContain('131072 tokens')
  })
})
