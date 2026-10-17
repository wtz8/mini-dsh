import type { ToolCall, ToolCallDelta } from '../contracts.js'

/**
 * 工具调用增量聚合器（06 用，设计 §4.4 / §8-Q3）。
 *
 * OpenAI 兼容线格式下，一次工具调用被切成多个分片：`id` 与 `name` **只在首个分片**
 * 出现，`arguments` 逐片追加，分片之间靠 `index` 归属。这份"怎么把分片拼回完整调用"
 * 的知识属 provider 线格式，因此归 02 保管（adapter seam 内），06 只消费结果。
 */
export interface ToolCallAccumulator {
  /**
   * 喂入一个 tool-call 增量。
   * 幂等性说明：`argumentsDelta` 是**追加**语义，重复喂同一 delta 会重复拼接。
   */
  push(delta: ToolCallDelta): void
  /**
   * 产出完整的工具调用列表，按 `index` 升序。
   * 可在任意时刻调用（不消耗内部状态，可重复调用）。
   */
  result(): ToolCall[]
}

/** 单个调用槽位的中间态。 */
interface Slot {
  id?: string
  name?: string
  args: string
}

/**
 * 创建聚合器。
 *
 * @returns 聚合器实例（每次调用返回独立状态，不共享）
 */
export function createToolCallAccumulator(): ToolCallAccumulator {
  const slots = new Map<number, Slot>()
  return {
    push(delta: ToolCallDelta): void {
      const slot: Slot = slots.get(delta.index) ?? { args: '' }
      // id / name 以首次出现为准：后续同 index 分片只带 arguments，重复覆盖没必要，
      // 且能容忍 provider 在多个分片里重复下发 id 的情况
      if (slot.id === undefined && delta.id !== undefined) slot.id = delta.id
      if (slot.name === undefined && delta.name !== undefined) slot.name = delta.name
      if (delta.argumentsDelta !== undefined) slot.args += delta.argumentsDelta
      slots.set(delta.index, slot)
    },
    result(): ToolCall[] {
      return [...slots.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, slot]) => ({
          // 兜底 id：05/06 靠 callId 关联 ToolResult 与 assistant/message.toolCalls，
          // 空 id 会让关联链断裂，故宁可造一个可追溯的占位，也不留空串
          id: slot.id ?? `call_${index}`,
          name: slot.name ?? '',
          arguments: slot.args,
        }))
    },
  }
}
