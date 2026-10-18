import { describe, expect, it } from 'vitest'

import type { JsonSchema } from '../contracts.js'
import { describeSchema, validateArgs } from './schema.js'

/**
 * 参数校验器（设计 §3.1 / §6.1）。重点是"该拒的拒、不该拒的别拒"：
 * JSON Schema 的默认语义（`additionalProperties` 缺省放行）不能被"顺手收紧"破坏，
 * 否则第三方插件注册的工具会莫名其妙收到 `invalid_args`。
 */

const schema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    ratio: { type: 'number' },
    all: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    nested: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  required: ['path'],
  additionalProperties: false,
}

describe('validateArgs', () => {
  it('合法参数通过，并返回浅拷贝而非入参本身', () => {
    const args = { path: 'a.txt', limit: 10 }
    const result = validateArgs(schema, args)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(args)
    expect(result.value).not.toBe(args)
  })

  it('缺必填字段时错误信息带字段路径', () => {
    const result = validateArgs(schema, { limit: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('args.path')
    expect(result.message).toContain('required')
  })

  it('字符串类型不匹配被拒', () => {
    const result = validateArgs(schema, { path: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('expected string, got number')
  })

  it('null 不算合法字符串', () => {
    const result = validateArgs(schema, { path: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('got null')
  })

  it('integer 拒绝小数与字符串数字', () => {
    expect(validateArgs(schema, { path: 'p', limit: 1.5 }).ok).toBe(false)
    expect(validateArgs(schema, { path: 'p', limit: '5' }).ok).toBe(false)
  })

  it('number 接受小数', () => {
    expect(validateArgs(schema, { path: 'p', ratio: 0.5 }).ok).toBe(true)
  })

  it('integer 的 minimum / maximum 生效', () => {
    expect(validateArgs(schema, { path: 'p', limit: 0 }).ok).toBe(false)
    expect(validateArgs(schema, { path: 'p', limit: 101 }).ok).toBe(false)
    expect(validateArgs(schema, { path: 'p', limit: 100 }).ok).toBe(true)
  })

  it('boolean 拒绝 "true" 字符串', () => {
    expect(validateArgs(schema, { path: 'p', all: 'true' }).ok).toBe(false)
    expect(validateArgs(schema, { path: 'p', all: true }).ok).toBe(true)
  })

  it('array items 逐个校验，错误信息带下标', () => {
    const result = validateArgs(schema, { path: 'p', tags: ['a', 2] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('args.tags[1]')
  })

  it('嵌套 object 的 required 生效', () => {
    const result = validateArgs(schema, { path: 'p', nested: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('args.nested.name')
  })

  it('嵌套 additionalProperties: false 拒绝未知字段', () => {
    const result = validateArgs(schema, { path: 'p', nested: { name: 'x', extra: 1 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('unexpected property')
  })

  it('顶层 additionalProperties: false 拒绝未知字段', () => {
    const result = validateArgs(schema, { path: 'p', nope: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('args.nope')
  })

  it('additionalProperties 缺省时放行未知字段（JSON Schema 默认语义）', () => {
    const open: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(validateArgs(open, { a: 'x', extra: 1 }).ok).toBe(true)
  })

  it('minLength 拒绝空串', () => {
    const result = validateArgs(schema, { path: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('at least 1 characters')
  })

  it('根为数组 / null / 标量一律拒绝（工具参数是具名对象）', () => {
    for (const bad of [[], null, 'x', 1, true]) {
      const result = validateArgs(schema, bad)
      expect(result.ok).toBe(false)
    }
  })

  it('不认识的关键字被忽略（不因插件多写字段而失败）', () => {
    const weird: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'mystery', format: 'uuid' } },
    }
    expect(validateArgs(weird, { a: 123 }).ok).toBe(true)
  })

  it('校验不修改入参对象', () => {
    const args = { path: 'p', tags: ['a'] }
    const snapshot = JSON.parse(JSON.stringify(args))
    validateArgs(schema, args)
    expect(args).toEqual(snapshot)
  })
})

describe('describeSchema', () => {
  it('必填无问号、可选带问号，按属性声明顺序输出', () => {
    const sig = describeSchema({
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path'],
    })
    expect(sig).toBe('path: string, offset?: integer, replaceAll?: boolean')
  })

  it('数组类型显示为 element[]', () => {
    const sig = describeSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    })
    expect(sig).toBe('tags?: string[]')
  })

  it('无参数时返回空串', () => {
    expect(describeSchema({ type: 'object', properties: {} })).toBe('')
  })
})
