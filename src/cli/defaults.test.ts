import type { Config } from '../contracts.js'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PLUGINS, withDefaultPlugins } from './defaults.js'
import { DEFAULT_PLUGIN_SOURCES } from './types.js'

/**
 * 默认插件表单测（设计 §6.1 第 6–8 条 / O1）。
 *
 * 守的是这条语义：**用户没配才补**。用户配了却用默认表覆盖，是最难排查的一类
 * "我明明写了配置为什么不生效"。
 */

/** 构造一份最小 Config（只填本用例需要的字段）。 */
function configWith(plugins: Array<{ source: string }>): Config {
  return {
    model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    contextWindow: 131072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    permissions: {},
    plugins,
  }
}

describe('withDefaultPlugins', () => {
  it('⑥ 空 plugins 补默认表，且含三个关键 builtin', () => {
    const out = withDefaultPlugins(configWith([]))
    expect(out.plugins.map((entry) => entry.source)).toEqual([...DEFAULT_PLUGIN_SOURCES])
    expect(out.plugins.map((entry) => entry.source)).toContain('builtin:prompt')
    expect(out.plugins.map((entry) => entry.source)).toContain('builtin:tools')
    expect(out.plugins.map((entry) => entry.source)).toContain('builtin:agent-loop')
  })

  it('⑦ 用户已配置 plugins 时原样不动（默认表不得覆盖用户意图）', () => {
    const custom = [{ source: 'builtin:session' }]
    const out = withDefaultPlugins(configWith(custom))
    expect(out.plugins).toEqual(custom)
  })

  it('⑧ 纯函数：不改入参，且每次返回新的数组（boot 会冻结它）', () => {
    const input = configWith([])
    const first = withDefaultPlugins(input)
    const second = withDefaultPlugins(input)
    expect(input.plugins).toEqual([])
    expect(first).not.toBe(input)
    expect(first.plugins).not.toBe(second.plugins)
    expect(first.plugins[0]).not.toBe(second.plugins[0])
  })

  it('附带：agent-loop 必须排在 session/llm/tools 之后（挂载顺序约束）', () => {
    const sources = DEFAULT_PLUGINS.map((entry) => entry.source)
    const agentAt = sources.indexOf('builtin:agent-loop')
    expect(agentAt).toBe(sources.length - 1)
    for (const before of ['builtin:llm', 'builtin:session', 'builtin:tools']) {
      expect(sources.indexOf(before)).toBeLessThan(agentAt)
    }
  })
})
