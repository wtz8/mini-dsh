import type { JsonSchema } from '../contracts.js'

/**
 * 手写参数校验器（零依赖）。
 *
 * `contracts.ts` 的 `JsonSchema` 只钉了根形状（`type: 'object'` + `properties` +
 * `required` + `additionalProperties`），`properties` 的值是 `unknown`。本文件定义
 * 05 实际支持的关键字子集：
 *
 * - `type`：`string` / `number` / `integer` / `boolean` / `array` / `object`；
 * - `required`（对象级）、`additionalProperties`（对象级，缺省视为 `true`）；
 * - `minLength`（字符串）、`minimum` / `maximum`（整数）、`items`（数组）；
 * - `description` 只影响 `describeSchema` 的输出，不参与校验；
 * - **其余关键字一律忽略**（`$ref` / `oneOf` / `format` / `default` 等），
 *   不报错也不做特殊处理——默认值由工具实现自己兜，校验器保持"只判不改"。
 */

/** 属性级 schema（`JsonSchema.properties` 的值按此解释）。 */
export type PropSchema =
  | { type: 'string'; description?: string; minLength?: number }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items?: PropSchema }
  | {
      type: 'object'
      description?: string
      properties?: Record<string, PropSchema>
      required?: string[]
      additionalProperties?: boolean
    }

/** 校验结果：`ok: true` 时 `value` 是入参的浅拷贝（不修改调用方对象）。 */
export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string }

/** 判断"普通对象"（排除 null、数组、类实例的极端情况交给后续类型检查）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 `unknown` 收窄为 `PropSchema`：形状不认识就返回 `undefined`（= 不做约束）。
 * 外部 JS 插件可能传任意 JSON，宁可放宽也不要因一个怪关键字整条调用失败。
 */
function asPropSchema(value: unknown): PropSchema | undefined {
  if (!isPlainObject(value)) return undefined
  const type = value['type']
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'boolean' &&
    type !== 'array' &&
    type !== 'object'
  ) {
    return undefined
  }
  return value as unknown as PropSchema
}

/** 逐值校验；返回第一条错误（路径 + 期望 + 实际），通过则返回 `undefined`。 */
function checkValue(schema: PropSchema, value: unknown, at: string): string | undefined {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return `${at}: expected string, got ${typeName(value)}`
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${at}: expected at least ${schema.minLength} characters, got ${value.length}`
      }
      return undefined
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${at}: expected number, got ${typeName(value)}`
      }
      return undefined
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${at}: expected integer, got ${typeName(value)}`
      }
      if (!Number.isInteger(value)) {
        return `${at}: expected integer, got non-integer number ${value}`
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${at}: expected >= ${schema.minimum}, got ${value}`
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${at}: expected <= ${schema.maximum}, got ${value}`
      }
      return undefined
    }
    case 'boolean': {
      return typeof value === 'boolean' ? undefined : `${at}: expected boolean, got ${typeName(value)}`
    }
    case 'array': {
      if (!Array.isArray(value)) return `${at}: expected array, got ${typeName(value)}`
      const items = schema.items
      if (!items) return undefined
      for (let i = 0; i < value.length; i += 1) {
        const err = checkValue(items, value[i], `${at}[${i}]`)
        if (err) return err
      }
      return undefined
    }
    case 'object': {
      if (!isPlainObject(value)) return `${at}: expected object, got ${typeName(value)}`
      return checkObject(schema, value, at)
    }
  }
}

/** 对象级校验：必填、逐属性、未知属性。 */
function checkObject(
  schema: Extract<PropSchema, { type: 'object' }>,
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return `${at}.${key}: required but missing`
  }
  const props = schema.properties ?? {}
  for (const [key, raw] of Object.entries(value)) {
    const propSchema = asPropSchema(props[key])
    if (propSchema) {
      const err = checkValue(propSchema, raw, `${at}.${key}`)
      if (err) return err
      continue
    }
    // 未声明的键：只在显式 additionalProperties: false 时拒绝（JSON Schema 默认放行）
    if (schema.additionalProperties === false && !Object.prototype.hasOwnProperty.call(props, key)) {
      return `${at}.${key}: unexpected property`
    }
  }
  return undefined
}

/** 供错误文案使用的类型名（比 `typeof` 更贴近 JSON 词汇）。 */
function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 校验工具参数。
 *
 * 根必须是对象：`JSON.parse` 出来的 `[]` / `null` / `"x"` / `123` 都算非法
 * （工具参数按 `record<string, unknown>` 消费，数组没有具名参数）。
 *
 * @param schema 工具声明的参数 schema（`ToolDefinition.schema`）
 * @param args 已 `JSON.parse` 的原始值
 * @returns `ok: true` 时 value 为入参浅拷贝；`ok: false` 时 message 指明首个错误
 */
export function validateArgs(schema: JsonSchema, args: unknown): ValidationResult {
  if (!isPlainObject(args)) {
    return { ok: false, message: `args: expected object, got ${typeName(args)}` }
  }
  const root: PropSchema = {
    type: 'object',
    properties: (schema.properties ?? {}) as Record<string, PropSchema>,
    required: schema.required,
    additionalProperties: schema.additionalProperties,
  }
  const err = checkValue(root, args, 'args')
  if (err) return { ok: false, message: err }
  // 浅拷贝：调用方后续改动不影响已通过校验的快照
  return { ok: true, value: { ...args } }
}

/**
 * 生成人类可读的参数签名（供 `tools` prompt 段使用，例如 `path: string, limit?: integer`）。
 *
 * 刻意只给"名字 + 类型 + 是否必填"：完整 JSON Schema 已由 `LLMRequest.tools` 交付，
 * 系统提示里再抄一遍纯属烧 token（设计 Q5）。
 *
 * @param schema 工具参数 schema
 * @returns 单行签名；无参数时返回 `''`
 */
export function describeSchema(schema: JsonSchema): string {
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const parts: string[] = []
  for (const [key, raw] of Object.entries(props)) {
    const propSchema = asPropSchema(raw)
    const type = propSchema ? shortType(propSchema) : 'any'
    parts.push(`${key}${required.has(key) ? '' : '?'}: ${type}`)
  }
  return parts.join(', ')
}

/** 类型简写：数组写成 `string[]`，其余直出关键字。 */
function shortType(schema: PropSchema): string {
  if (schema.type === 'array') {
    const items = schema.items ? shortType(schema.items) : 'any'
    return `${items}[]`
  }
  return schema.type
}
