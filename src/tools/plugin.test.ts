import { describe, expect, it } from 'vitest'

import type { Config, Ctx, PromptSection, ToolDefinition } from '../contracts.js'
import { createDefaultConfig } from '../config/index.js'
import { BUILTIN_TOOL_NAMES, BUILTIN_TOOLS, createBashTimeoutResolver, createToolsPlugin } from './plugin.js'

/**
 * `builtin:tools` 插件（设计 §4.8）：薄注册层——注册哪些工具、段是否反映禁用。
 * 真实组合根链路见 `tests/integration/tools.test.ts`。
 */

interface FakeCtx {
  ctx: Ctx
  registered: ToolDefinition[]
  sections: PromptSection[]
}

function fakeCtx(config: Config = createDefaultConfig()): FakeCtx {
  const registered: ToolDefinition[] = []
  const sections: PromptSection[] = []
  const ctx = {
    config,
    tools: {
      register: (def: ToolDefinition) => {
        registered.push(def)
      },
      list: () => registered,
      get: () => {
        throw new Error('not used')
      },
    },
    prompt: {
      section: (s: PromptSection) => {
        sections.push(s)
      },
      render: () => sections.map((s) => s.render()).join('\n\n'),
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  return { ctx, registered, sections }
}

/** 取插件实例（`definePlugin` 的工厂返回 `Plugin | Promise<Plugin>`，统一 await）。 */
async function setup(options: Parameters<typeof createToolsPlugin>[0], ctx: Ctx, config?: unknown): Promise<void> {
  const plugin = await createToolsPlugin(options)()
  await plugin.setup(ctx, config)
}

describe('builtin:tools plugin', () => {
  it('插件名固定为 builtin:tools', async () => {
    const plugin = await createToolsPlugin()()
    expect(plugin.name).toBe(BUILTIN_TOOLS)
  })

  it('setup 注册六个内置工具与一个 tools 段', async () => {
    const { ctx, registered, sections } = fakeCtx()
    await setup({}, ctx)

    expect(registered.map((d) => d.name)).toEqual([...BUILTIN_TOOL_NAMES])
    expect(sections).toHaveLength(1)
    expect(sections[0]?.id).toBe('tools/catalog')
    expect(sections[0]?.render()).toContain('`bash(')
  })

  it('构造选项 disabled 生效：工具与段同步消失', async () => {
    const { ctx, registered, sections } = fakeCtx()
    await setup({ disabled: ['bash'] }, ctx)

    expect(registered.map((d) => d.name)).not.toContain('bash')
    expect(registered).toHaveLength(5)
    expect(sections[0]?.render()).not.toContain('`bash(')
  })

  it('实例配置 plugins[].config.disabled 与构造选项合并', async () => {
    const { ctx, registered } = fakeCtx()
    await setup({ disabled: ['bash'] }, ctx, { disabled: ['write'] })

    expect(registered.map((d) => d.name)).toEqual(['read', 'edit', 'glob', 'grep'])
  })

  it('disabled 含未知工具名时抛错（死配置早暴露）', async () => {
    const { ctx } = fakeCtx()
    await expect(setup({}, ctx, { disabled: ['nope'] })).rejects.toThrow(/unknown tool/)
  })

  it('实例配置写成数组时抛错（typeof [] === "object" 不能放行）', async () => {
    const { ctx } = fakeCtx()
    await expect(setup({}, ctx, ['bash'])).rejects.toThrow(/must be an object/)
  })

  it('自定义工具集替换内置六件套（测试注入用）', async () => {
    const fake: ToolDefinition = {
      name: 'fake',
      description: 'fake',
      schema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }
    const { ctx, registered } = fakeCtx()
    await setup({ tools: [fake] }, ctx)
    expect(registered.map((d) => d.name)).toEqual(['fake'])
  })
})

describe('createBashTimeoutResolver', () => {
  it('bash 默认取配置上限，模型给的 timeoutMs 只能调小', () => {
    const config = createDefaultConfig()
    config.tools.bash.timeoutMs = 120_000
    const resolve = createBashTimeoutResolver(config)

    expect(resolve('bash', {})).toBe(120_000)
    expect(resolve('bash', { timeoutMs: 5_000 })).toBe(5_000)
    expect(resolve('bash', { timeoutMs: 999_999 })).toBe(120_000)
    expect(resolve('bash', { timeoutMs: -1 })).toBe(120_000)
  })

  it('其他工具无超时（只受取消信号约束）', () => {
    const resolve = createBashTimeoutResolver(createDefaultConfig())
    expect(resolve('read', {})).toBeUndefined()
    expect(resolve('grep', { timeoutMs: 1 })).toBeUndefined()
  })
})
