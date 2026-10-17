import { describe, expect, it } from 'vitest'

import { deepMerge } from './merge.js'

/**
 * deepMerge 单元测试（设计 §6.1）：递归规则、数组替换、undefined 跳过、
 * `__proto__` 防护与纯函数性。
 */

describe('deepMerge · 递归规则', () => {
  it('两侧同为纯对象时递归合并，非冲突键各自保留', () => {
    const base = { tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120_000 } } }
    const result = deepMerge(base, { tools: { maxParallel: 8 } })

    expect(result.tools.maxParallel).toBe(8)
    // 未覆盖的键（含嵌套内的）保持原值
    expect(result.tools.bash).toEqual({ shell: 'auto', timeoutMs: 120_000 })
  })

  it('override 为 undefined 时原样返回 base（无覆盖层）', () => {
    const base = { a: 1 }
    expect(deepMerge(base, undefined)).toBe(base)
  })

  it('非对象值整值替换：原始值覆盖对象、对象覆盖原始值', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: 'scalar' })).toEqual({ a: 'scalar' })
    expect(deepMerge({ a: 'scalar' }, { a: { b: 1 } })).toEqual({ a: { b: 1 } })
  })
})

describe('deepMerge · 数组与 null', () => {
  it('数组整值替换，不做拼接（plugins 的语义）', () => {
    const base = { plugins: [{ source: 'builtin:llm' }, { source: 'builtin:session' }] }
    const result = deepMerge(base, { plugins: [{ source: 'builtin:tools' }] })

    expect(result.plugins).toEqual([{ source: 'builtin:tools' }])
  })

  it('null 覆盖保留原样（校验期才报错，合并阶段不静默当缺省）', () => {
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: null })
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })
})

describe('deepMerge · undefined 与 __proto__', () => {
  it('值为 undefined 的键被跳过（flags 未设置不得浇空下层）', () => {
    const result = deepMerge({ contextWindow: 131_072, model: { name: 'deepseek-chat' } }, {
      contextWindow: undefined,
      model: { name: undefined, provider: 'openai' },
    })

    expect(result.contextWindow).toBe(131_072)
    expect(result.model).toEqual({ name: 'deepseek-chat', provider: 'openai' })
  })

  it('__proto__ 键被丢弃且不污染 Object.prototype', () => {
    // JSON.parse 会产出 '__proto__' 自有键，直接赋值会触发原型 setter
    const override = JSON.parse('{"__proto__":{"polluted":true},"keep":1}') as Record<string, unknown>
    const result = deepMerge({ keep: 0 }, override)

    expect(result.keep).toBe(1)
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('deepMerge · 纯函数性', () => {
  it('不修改 base 与 override 任一入参', () => {
    const base = { tools: { maxParallel: 4 } }
    const override = { tools: { maxParallel: 8 } }
    const result = deepMerge(base, override)

    expect(base.tools.maxParallel).toBe(4) // base 未被就地改写
    expect(override.tools.maxParallel).toBe(8)
    expect(result).not.toBe(base)
    // 嵌套对象也是新对象，改动结果不回写 base
    result.tools.maxParallel = 16
    expect(base.tools.maxParallel).toBe(4)
  })
})
