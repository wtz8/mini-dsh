import { describe, expect, it } from 'vitest'

import type { JsonSchema } from '../../src/index.js'

import { normalizeInputSchema } from './schema.js'

/**
 * schema.ts 单测（设计 §6.1）：MCP 完整 JSON Schema → 05 的 `JsonSchema` 子集。
 *
 * 05 的 SDK 面不导出 `validateArgs`（插件不得深引用内部路径，架构 §3），
 * 因此"产物可被 05 消费"以**结构断言**保证：根 `type` 恒为 `'object'`、
 * `properties` 恒为对象、`required` 恒为字符串数组或缺失、
 * `additionalProperties` 恒为布尔或缺失——这正是 05 校验器读取的全部字段。
 */

describe('normalizeInputSchema', () => {
  it('6 · 标准 schema 直通（properties / required / additionalProperties 保留）', () => {
    const input = {
      type: 'object',
      properties: { q: { type: 'string', description: '查询词' } },
      required: ['q'],
      additionalProperties: false,
    }
    expect(normalizeInputSchema(input)).toEqual({
      type: 'object',
      properties: { q: { type: 'string', description: '查询词' } },
      required: ['q'],
      additionalProperties: false,
    })
  })

  it('7 · 根缺失 type / type 非 object / 输入 undefined ⇒ 根钉为 object', () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(normalizeInputSchema({ properties: {} })).toEqual({ type: 'object', properties: {} })
    expect(normalizeInputSchema({ type: 'array', properties: {} })).toEqual({
      type: 'object',
      properties: {},
    })
    // 无参工具：properties 缺失时得到空对象而非 undefined
    expect(normalizeInputSchema(null)).toEqual({ type: 'object', properties: {} })
  })

  it('8 · properties 原样透传：05 不认识的关键字留在原地（由 05 的 asPropSchema 忽略）', () => {
    const input = {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date' },
        ref: { $ref: '#/definitions/x' },
        mode: { enum: ['fast', 'slow'], default: 'fast' },
      },
    }
    const out = normalizeInputSchema(input)
    expect(out.properties).toEqual(input.properties)
  })

  it('9 · required 非数组 ⇒ 丢弃；additionalProperties 非布尔（schema 对象形态）⇒ 丢弃', () => {
    const out = normalizeInputSchema({
      type: 'object',
      properties: {},
      required: 'q',
      additionalProperties: { type: 'string' },
    })
    expect(out).toEqual({ type: 'object', properties: {} })
    expect(out.required).toBeUndefined()
    expect(out.additionalProperties).toBeUndefined()
  })

  it('10 · properties 非对象（数组 / 字符串）⇒ 置空对象', () => {
    expect(normalizeInputSchema({ type: 'object', properties: ['a'] })).toEqual({
      type: 'object',
      properties: {},
    })
    expect(normalizeInputSchema({ type: 'object', properties: 'x' })).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('11 · 产物满足 05 的 JsonSchema 契约形状（可直接注册进工具表）', () => {
    const samples: unknown[] = [
      undefined,
      {},
      { type: 'object' },
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', additionalProperties: true },
    ]
    for (const input of samples) {
      const out: JsonSchema = normalizeInputSchema(input)
      // 结构断言：05 的校验器只读取这四个字段，形状对齐即可安全消费
      expect(out.type).toBe('object')
      expect(typeof out.properties).toBe('object')
      expect(out.properties).not.toBeNull()
      expect(Array.isArray(out.properties)).toBe(false)
      if (out.required !== undefined) {
        expect(Array.isArray(out.required)).toBe(true)
        for (const key of out.required) expect(typeof key).toBe('string')
      }
      if (out.additionalProperties !== undefined) {
        expect(typeof out.additionalProperties).toBe('boolean')
      }
    }
  })
})
