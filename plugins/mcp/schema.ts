import type { JsonSchema } from '../../src/index.js'

/**
 * 判断"普通对象"（排除 null 与数组；05 的 schema.ts 有同款但未导出，
 * 插件不得深引用内部路径——架构 §3 不变量）。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 MCP server 返回的 `inputSchema` 收窄为 05 的 `JsonSchema` 子集（设计 §4.3）。
 *
 * 为什么要收窄：MCP 侧是**完整 JSON Schema**（可能含 `$ref` / `oneOf` / 对象形态的
 * `additionalProperties` 等），而 05 的契约只钉了根形状
 * （`type:'object'` + `properties` + `required` + `additionalProperties`）。
 * 直接透传不合法字段的风险在于：
 *
 * - 根 `type` 缺失或不是 `'object'` ⇒ 05 的 `validateArgs` 按对象语义校验，
 *   根字段必须钉死为 `'object'`；
 * - `required` 不是字符串数组、`additionalProperties` 不是布尔（JSON Schema
 *   允许它是 schema 对象）⇒ 收窄为"无此约束"，而不是把非法值塞给 05。
 *
 * `properties` 的值**原样透传**（`unknown`）：05 的 `asPropSchema` 只认六种
 * `type`，不认识的关键字（`$ref` / `oneOf` / `enum` / `format`…）一律忽略、
 * 不约束也不报错——这是 05 的既定行为，收窄层不必重做一遍过滤。
 *
 * @param input MCP 工具的 `inputSchema` 原始值（可能缺失/畸形）
 * @returns 恒为合法的 `JsonSchema`：根 `type` 钉 `'object'`，非法字段被丢弃；
 *   无参工具得到 `{ type: 'object', properties: {} }`
 */
export function normalizeInputSchema(input: unknown): JsonSchema {
  const source = isPlainObject(input) ? input : {}
  const rawProps = source['properties']
  const rawRequired = source['required']
  const rawAdditional = source['additionalProperties']

  const properties = isPlainObject(rawProps) ? rawProps : {}
  const required =
    Array.isArray(rawRequired) && rawRequired.every((k) => typeof k === 'string')
      ? (rawRequired as string[])
      : undefined
  const additionalProperties =
    typeof rawAdditional === 'boolean' ? rawAdditional : undefined

  return {
    type: 'object',
    properties,
    ...(required !== undefined ? { required } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  }
}
