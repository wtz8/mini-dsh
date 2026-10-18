import { describe, expect, it } from 'vitest'

import type { Config } from '../contracts.js'
import { ConfigError } from '../errors.js'
import { createDefaultConfig } from './defaults.js'
import { validateConfig } from './validate.js'

/**
 * 校验器单元测试（设计 §6.1 / §4.2 校验表）：合法配置通过；逐项非法值各一例，
 * 断言 ConfigError 的 path；plugins[].config 不校验；未知字段忽略。
 */

/** 从默认值出发构造一份合法配置，再按需改写单个字段。 */
function valid(): Config {
  return createDefaultConfig()
}

/** 断言 raw 校验失败，并返回抛出的 ConfigError（便于断言 path）。 */
function expectInvalid(raw: unknown): ConfigError {
  let caught: unknown
  try {
    validateConfig(raw)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(ConfigError)
  return caught as ConfigError
}

describe('validateConfig · 合法输入', () => {
  it('默认配置通过校验，且字段被完整保留', () => {
    const config = valid()
    const result = validateConfig(config)

    expect(result).toEqual(config)
    // 本例同时是"Config 增字段"的守卫（设计 §4.2 注）：后续模块给 Config 增字段时，
    // 若只改 createDefaultConfig() 而漏改 validateConfig() 的白名单重建，本断言立刻红
  })

  it('plugins[].config 为任意形态均通过（§8-Q7，插件自行 narrow）', () => {
    const config = valid()
    config.plugins = [
      { source: './plugins/mcp', config: { servers: { github: { command: 'npx', args: ['-y', 'x'] } } } },
      { source: './plugins/memory', config: null },
      { source: './plugins/empty', config: 42 },
      { source: 'builtin:llm' },
    ]

    const result = validateConfig(config)
    expect(result.plugins).toHaveLength(4)
    expect(result.plugins[0]?.config).toEqual({
      servers: { github: { command: 'npx', args: ['-y', 'x'] } },
    })
    // 无 config 的项不补出该键
    expect(result.plugins[3]).toEqual({ source: 'builtin:llm' })
  })

  it('未知字段被忽略，不出现在结果中（§8-Q1）', () => {
    const config = valid() as unknown as Record<string, unknown>
    config.unknownField = 'whatever'
    config.model = { ...(config.model as Record<string, unknown>), extra: 1 }

    const result = validateConfig(config)
    expect(result).not.toHaveProperty('unknownField')
    expect(result.model).not.toHaveProperty('extra')
  })

  it('logLevel 缺省补 info（设计 §4.2 / X6），显式四值均合法', () => {
    const config = valid() as unknown as Record<string, unknown>
    config.logLevel = undefined
    expect(validateConfig(config).logLevel).toBe('info')

    for (const level of ['debug', 'info', 'warn', 'error']) {
      config.logLevel = level
      expect(validateConfig(config).logLevel).toBe(level)
    }
  })

  it('字符串字段的前后空白被归一化（X8：不把 " p " 透传给 02）', () => {
    const config = valid()
    config.model.provider = '  deepseek  '

    expect(validateConfig(config).model.provider).toBe('deepseek')
  })

  it('plugins[].config 深拷贝：与入参不共享子对象（review Y11）', () => {
    // 回归：合并在数组上是整值替换，原样透传会让 boot() 的 deepFreeze 冻结
    // 调用方 flags.plugins[].config，调用方之后修改即抛 TypeError
    const nested = { servers: { github: { command: 'npx' } } }
    const config = valid()
    config.plugins = [{ source: 'builtin:mcp', config: nested }]

    const result = validateConfig(config)
    expect(result.plugins[0]?.config).toEqual(nested)
    expect(result.plugins[0]?.config).not.toBe(nested)
    expect((result.plugins[0]?.config as typeof nested).servers).not.toBe(nested.servers)
  })
})

describe('validateConfig · 非法输入的字段路径', () => {
  it('根级非对象', () => {
    expect(expectInvalid(null).path).toBe('config')
    expect(expectInvalid([]).path).toBe('config')
    expect(expectInvalid('config').path).toBe('config')
  })

  it('model 四个字段必须是非空字符串', () => {
    for (const field of ['provider', 'name', 'baseUrl', 'apiKeyEnv']) {
      const config = valid()
      ;(config.model as unknown as Record<string, unknown>)[field] = ''

      const err = expectInvalid(config)
      expect(err.path).toBe(`config.model.${field}`)
      expect(err.message).toContain('must be a non-empty string')
    }
  })

  it('contextWindow 必须是 >= 1 的整数', () => {
    const config = valid()
    config.contextWindow = 0
    expect(expectInvalid(config).path).toBe('config.contextWindow')

    config.contextWindow = 1.5
    expect(expectInvalid(config).path).toBe('config.contextWindow')
  })

  it('tools.maxParallel 必须 >= 1', () => {
    const config = valid()
    config.tools.maxParallel = 0
    expect(expectInvalid(config).path).toBe('config.tools.maxParallel')
  })

  it('tools.bash.shell 必须是三值枚举', () => {
    const config = valid()
    config.tools.bash.shell = 'zsh' as Config['tools']['bash']['shell']
    expect(expectInvalid(config).path).toBe('config.tools.bash.shell')
  })

  it('tools.bash.timeoutMs 必须 >= 1', () => {
    const config = valid()
    config.tools.bash.timeoutMs = -1
    expect(expectInvalid(config).path).toBe('config.tools.bash.timeoutMs')
  })

  it('compaction.thresholdRatio 必须在 (0, 1]，keepTurns >= 0', () => {
    const config = valid()
    config.compaction.thresholdRatio = 0
    expect(expectInvalid(config).path).toBe('config.compaction.thresholdRatio')

    config.compaction.thresholdRatio = 1.5
    expect(expectInvalid(config).path).toBe('config.compaction.thresholdRatio')

    const another = valid()
    another.compaction.keepTurns = -1
    expect(expectInvalid(another).path).toBe('config.compaction.keepTurns')
  })

  it('permissions 值必须是三值之一', () => {
    const config = valid()
    config.permissions = { bash: 'yes' as never }
    expect(expectInvalid(config).path).toBe('config.permissions.bash')
  })

  it('permissions 裸 "*" 键视为配置错误（架构 §5.4 Q6）', () => {
    const config = valid()
    config.permissions = { '*': 'ask' }

    const err = expectInvalid(config)
    expect(err.path).toBe('config.permissions.*')
  })

  it('permissions 空字符串键视为配置错误（X7：死配置，永远不会被命中）', () => {
    const config = valid()
    config.permissions = { '': 'auto' }

    expect(expectInvalid(config).path).toBe('config.permissions.<empty>')
  })

  it('permissions 键带首尾空白视为配置错误（review Y12：否则 deny 静默退化为兜底 ask）', () => {
    const config = valid()
    config.permissions = { ' bash ': 'deny' }

    const err = expectInvalid(config)
    expect(err.path).toBe('config.permissions. bash ')
    expect(err.message).toContain('leading or trailing whitespace')
  })

  it('plugins 必须是数组且每项有非空 source', () => {
    const nonArray = valid() as unknown as Record<string, unknown>
    nonArray.plugins = { source: 'builtin:llm' }
    expect(expectInvalid(nonArray).path).toBe('config.plugins')

    const config = valid()
    config.plugins = [{ source: '' }]
    expect(expectInvalid(config).path).toBe('config.plugins[0].source')

    const notObject = valid()
    notObject.plugins = ['builtin:llm'] as never
    expect(expectInvalid(notObject).path).toBe('config.plugins[0]')
  })

  it('logLevel 必须是四值枚举', () => {
    const config = valid()
    config.logLevel = 'verbose' as never
    expect(expectInvalid(config).path).toBe('config.logLevel')
  })

  it('失败即 fail-fast：首个错误抛出后不再校验后续字段', () => {
    const config = valid()
    config.contextWindow = 0
    config.tools.maxParallel = 0

    // 两处都非法，但只报先校验到的那一个
    expect(expectInvalid(config).path).toBe('config.contextWindow')
  })
})
