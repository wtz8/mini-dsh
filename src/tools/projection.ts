import type { ToolDefinition, ToolSchema } from '../contracts.js'

/**
 * 把已注册的 `ToolDefinition` 投影为模型可见面（`LLMRequest.tools`）。
 *
 * 只保留 `{ name, description, schema }`：`execute` 是本地实现、`concurrency` 是
 * 06 的调度依据，都不该发给 provider（多发的字段既浪费 token，也可能被严格的网关拒绝）。
 *
 * @param defs 已注册工具（通常是 `ctx.tools.list()`）
 * @returns 模型可见的 `ToolSchema[]`（顺序与入参一致——稳定顺序有利于 provider 前缀缓存）
 */
export function toToolSchemas(defs: ReadonlyArray<ToolDefinition>): ToolSchema[] {
  return defs.map((def) => ({ name: def.name, description: def.description, schema: def.schema }))
}
