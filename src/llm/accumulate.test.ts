import { describe, expect, it } from 'vitest'

import { createToolCallAccumulator } from './accumulate.js'

/**
 * 工具调用聚合器单元测试（设计 §6.1）：分桶拼接、排序、id/name 首次优先、id 兜底。
 */

describe('createToolCallAccumulator', () => {
  it('同一 index 的 arguments 按到达顺序拼接', () => {
    const acc = createToolCallAccumulator()
    acc.push({ index: 0, id: 'c1', name: 'read', argumentsDelta: '{"pa' })
    acc.push({ index: 0, argumentsDelta: 'th":"/a"}' })

    expect(acc.result()).toEqual([{ id: 'c1', name: 'read', arguments: '{"path":"/a"}' }])
  })

  it('多调用按 index 升序输出，与到达顺序无关', () => {
    const acc = createToolCallAccumulator()
    acc.push({ index: 2, id: 'c3', name: 'write', argumentsDelta: 'c' })
    acc.push({ index: 0, id: 'c1', name: 'read', argumentsDelta: 'a' })
    acc.push({ index: 1, id: 'c2', name: 'glob', argumentsDelta: 'b' })

    expect(acc.result().map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('id / name 以首次出现为准（provider 若重复下发不覆盖）', () => {
    const acc = createToolCallAccumulator()
    acc.push({ index: 0, id: 'first', name: 'read', argumentsDelta: '{}' })
    acc.push({ index: 0, id: 'second', name: 'write' })

    expect(acc.result()).toEqual([{ id: 'first', name: 'read', arguments: '{}' }])
  })

  it('始终未收到 id 时兜底为 call_<index>（保证 05/06 的 callId 关联链不断）', () => {
    const acc = createToolCallAccumulator()
    acc.push({ index: 3, name: 'bash', argumentsDelta: '{}' })

    expect(acc.result()).toEqual([{ id: 'call_3', name: 'bash', arguments: '{}' }])
  })

  it('始终未收到 name 时为空串；arguments 缺失时为空串', () => {
    const acc = createToolCallAccumulator()
    acc.push({ index: 0, id: 'c1' })

    expect(acc.result()).toEqual([{ id: 'c1', name: '', arguments: '' }])
  })

  it('未喂入任何增量时 result() 为空数组；result() 可重复调用', () => {
    const acc = createToolCallAccumulator()
    expect(acc.result()).toEqual([])

    acc.push({ index: 0, id: 'c1', name: 'read', argumentsDelta: '{}' })
    expect(acc.result()).toEqual(acc.result())
  })
})
