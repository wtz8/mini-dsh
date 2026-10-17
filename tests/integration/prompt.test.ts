import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config, Ctx, PluginEntry, ToolDefinition } from '../../src/index.js'
import { boot, definePlugin, registerBuiltin, shutdown } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { PROMPT_ORDER } from '../../src/prompt/order.js'

/**
 * 04-prompt 集成测试（设计 §6.2）：**真实组合根** + 真实 `PromptRegistryImpl` 容器。
 *
 * 五条链路：挂载与排序 / 可扩展（插件加段）/ **未挂载返回空串** / 条件+惰性 /
 * 禁用。核心验证点是"04 只注册内容、不改容器"这一结构（D1）以及"段在 render
 * 时才求值"（§4.3）——后者是挂载顺序无关的保证。
 *
 * 本模块零 IO，**不需要 fixture 目录**。
 */

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []
let mounted: string[] = []

/** 探针插件：挂在最前，记录后续插件的挂载广播（`plugin/mounted`）。 */
function registerProbe(): void {
  unsubscribes.push(
    registerBuiltin(
      'prompt-probe',
      definePlugin(() => ({
        name: 'prompt-probe',
        setup(ctx: Ctx): void {
          ctx.events.on('plugin/mounted', ({ name }) => {
            mounted.push(name)
          })
        },
      })),
    ),
  )
}

/** 自定义段插件：验证"任何插件都能往系统提示里加段，无需改 04"。 */
function registerExtra(): void {
  unsubscribes.push(
    registerBuiltin(
      'prompt-extra',
      definePlugin(() => ({
        name: 'prompt-extra',
        setup(ctx: Ctx): void {
          ctx.prompt.section({
            id: 'extra/tail',
            order: PROMPT_ORDER.plugin,
            render: () => 'EXTRA TAIL',
          })
        },
      })),
    ),
  )
}

function makeConfig(plugins: PluginEntry[]): Config {
  const config = createDefaultConfig()
  config.plugins = plugins
  return config
}

/** 最小工具定义：只用于把 `ctx.tools.list()` 变成非空（不真正执行）。 */
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} for integration test`,
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => 'ok',
  }
}

beforeEach(() => {
  mounted = []
})

afterEach(async () => {
  for (const ctx of contexts) await shutdown(ctx)
  contexts.length = 0
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
})

async function bootPrompt(plugins: PluginEntry[]): Promise<Ctx> {
  unsubscribes.push(registerPromptBuiltin())
  const ctx = await boot(makeConfig(plugins))
  contexts.push(ctx)
  return ctx
}

describe('04-prompt 集成', () => {
  it('链路 1 · 挂载：builtin:prompt 注册四段，render 按 order 升序拼装', async () => {
    registerProbe()
    const ctx = await bootPrompt([{ source: 'builtin:prompt-probe' }, { source: 'builtin:prompt' }])

    expect(mounted).toContain('builtin:prompt')

    const text = ctx.prompt.render()
    expect(text).toContain('你是 MiniDSH')
    expect(text).toContain('# 运行环境')
    expect(text).toContain('# 工作准则')
    // 顺序：identity(100) → environment(200) → guidelines(800)
    expect(text.indexOf('你是 MiniDSH')).toBeLessThan(text.indexOf('# 运行环境'))
    expect(text.indexOf('# 运行环境')).toBeLessThan(text.indexOf('# 工作准则'))
    // 无工具时不出现工具段（条件渲染）
    expect(text).not.toContain('# 工具使用')
  })

  it('链路 2 · 可扩展：插件注册的段排在最后，以 \\n\\n 连接', async () => {
    registerExtra()
    const ctx = await bootPrompt([{ source: 'builtin:prompt' }, { source: 'builtin:prompt-extra' }])

    const text = ctx.prompt.render()
    expect(text.endsWith('EXTRA TAIL')).toBe(true)
    expect(text).toContain('\n\nEXTRA TAIL')
  })

  it('链路 3 · 未挂载：render() 返回空串且不抛错（prompt 容器不是委托式容器，D1）', async () => {
    // 不注册 builtin:prompt，plugins 里也没有任何 prompt 段来源
    const ctx = await boot(makeConfig([]))
    contexts.push(ctx)
    expect(ctx.prompt.render()).toBe('')
  })

  it('链路 4 · 条件 + 惰性：工具随后注册也能在下次 render 反映（挂载顺序无关）', async () => {
    const ctx = await bootPrompt([{ source: 'builtin:prompt' }])

    expect(ctx.prompt.render()).not.toContain('# 工具使用')
    ctx.tools.register(fakeTool('read'))
    expect(ctx.prompt.render()).toContain('# 工具使用')
  })

  it('链路 5 · 禁用：实例配置 plugins[].config.disabled 去掉指定段，其余保留', async () => {
    const ctx = await bootPrompt([
      { source: 'builtin:prompt', config: { disabled: ['core/guidelines'] } },
    ])

    const text = ctx.prompt.render()
    expect(text).not.toContain('# 工作准则')
    expect(text).toContain('你是 MiniDSH')
  })
})
