import { describe, expect, it } from 'vitest'

import { createDefaultConfig } from './defaults.js'

/**
 * 默认值单元测试（设计 §6.1）：字段齐全性、R4 的 logLevel 默认值，
 * 以及 D5 的回归点——出厂必须是新对象，不能是共享常量。
 */

describe('createDefaultConfig · 默认值', () => {
  it('返回字段齐全的 Config，logLevel 默认 info（R4）', () => {
    const config = createDefaultConfig()

    expect(config).toEqual({
      model: {
        provider: 'deepseek',
        name: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
      contextWindow: 131_072,
      tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120_000 } },
      compaction: { thresholdRatio: 0.8, keepTurns: 4 },
      permissions: {},
      plugins: [],
      logLevel: 'info',
    })
  })

  it('permissions 为空表：全部工具走 resolvePermission 的 ask 兜底', () => {
    expect(createDefaultConfig().permissions).toEqual({})
  })

  it('plugins 默认为空数组（D1 / §8-Q2：builtin 列表待 07 补齐）', () => {
    expect(createDefaultConfig().plugins).toEqual([])
  })
})

describe('createDefaultConfig · 出厂对象独立（D5 回归）', () => {
  it('两次调用返回不同对象，嵌套对象也不共享引用', () => {
    const a = createDefaultConfig()
    const b = createDefaultConfig()

    expect(a).not.toBe(b)
    expect(a.tools).not.toBe(b.tools)
    expect(a.model).not.toBe(b.model)
  })

  it('修改返回值不影响后续调用', () => {
    const first = createDefaultConfig()
    first.tools.maxParallel = 99
    first.model.name = 'gpt-4'

    const second = createDefaultConfig()
    expect(second.tools.maxParallel).toBe(4)
    expect(second.model.name).toBe('deepseek-chat')
  })

  it('返回值可写：未被冻结（冻结归属 boot，01 只加载）', () => {
    const config = createDefaultConfig()
    expect(Object.isFrozen(config)).toBe(false)
    expect(() => {
      config.contextWindow = 1000
    }).not.toThrow()
  })
})
