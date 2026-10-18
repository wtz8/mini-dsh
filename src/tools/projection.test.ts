import { describe, expect, it } from 'vitest'

import type { ToolDefinition } from '../contracts.js'
import { toToolSchemas } from './projection.js'

/** 模型可见面投影（设计 §6.1）：只保留 name/description/schema，顺序不变。 */
function def(name: string, extra?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...extra,
  }
}

describe('toToolSchemas', () => {
  it('只投影 name / description / schema，不含 execute 与 concurrency', () => {
    const [schema] = toToolSchemas([def('bash', { concurrency: 'exclusive' })])
    expect(schema).toEqual({
      name: 'bash',
      description: 'bash tool',
      schema: { type: 'object', properties: {} },
    })
    expect(schema && 'execute' in schema).toBe(false)
    expect(schema && 'concurrency' in schema).toBe(false)
  })

  it('保持注册顺序（稳定顺序有利于 provider 前缀缓存）', () => {
    const out = toToolSchemas([def('read'), def('write'), def('bash')])
    expect(out.map((s) => s.name)).toEqual(['read', 'write', 'bash'])
  })

  it('空注册表返回空数组', () => {
    expect(toToolSchemas([])).toEqual([])
  })
})
