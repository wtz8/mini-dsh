import type { SessionEvent } from '../contracts.js'

/**
 * 读回时的**最小结构校验**（03 设计 §3）。
 *
 * JSONL 里的每一行都是 `JSON.parse` 的产物（`unknown`）：崩溃会留下半行（由
 * `parseLine` 拦掉），但"合法 JSON 却不是合法 SessionEvent"同样可能——外部编辑、
 * 旧版本残留、手工修补都会造成。若不拦，畸形行会一路流进 `deriveMessages`，
 * 让 06 在拼请求时崩在一个与真正原因无关的地方。
 *
 * 只做**结构**校验（字段存在性与类型），不做语义校验（如 turnNo 是否递增）——
 * 后者是 06 的写入纪律，03 不替它兜底。
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/** 工具错误码集合（与 `ToolErrorCode` 同步；此处用字面量集合避免运行时依赖类型）。 */
const TOOL_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_args',
  'permission_denied',
  'execution_error',
  'timeout',
  'cancelled',
])

function isTokenUsage(value: unknown): boolean {
  if (!isObject(value)) return false
  if (!isNumber(value.inputTokens) || !isNumber(value.outputTokens)) return false
  return value.totalTokens === undefined || isNumber(value.totalTokens)
}

function isToolCall(value: unknown): boolean {
  if (!isObject(value)) return false
  return isString(value.id) && isString(value.name) && isString(value.arguments)
}

function isToolResult(value: unknown): boolean {
  if (!isObject(value)) return false
  if (!isString(value.callId) || !isString(value.name) || !isBoolean(value.ok) || !isString(value.content)) {
    return false
  }
  if (value.error === undefined) return true
  const error = value.error
  if (!isObject(error)) return false
  return typeof error.code === 'string' && TOOL_ERROR_CODES.has(error.code) && isString(error.message)
}

/**
 * 判断一个未知值是否为合法的 `SessionEvent`。
 *
 * 变体集合与 `contracts.ts` 的 `SessionEvent` 一一对应（该集合对 03 封闭，
 * 新增变体 = 改基线，须同步本函数）。
 *
 * @param value 待判定的值（通常来自 `JSON.parse`）
 */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isObject(value)) return false
  switch (value.type) {
    case 'session/header':
      return (
        isString(value.id) &&
        isString(value.createdAt) &&
        isString(value.provider) &&
        isString(value.model) &&
        isString(value.cwd)
      )
    case 'turn/start':
    case 'turn/end':
      return isNumber(value.turnNo)
    case 'user/message':
      return isString(value.content)
    case 'assistant/message': {
      if (!isString(value.content) || !isTokenUsage(value.usage)) return false
      if (value.interrupted !== undefined && !isBoolean(value.interrupted)) return false
      if (value.toolCalls === undefined) return true
      const calls = value.toolCalls
      return Array.isArray(calls) && calls.every(isToolCall)
    }
    case 'tool/result':
      return isString(value.toolCallId) && isToolResult(value.result)
    case 'compaction':
      return isString(value.summary) && isNumber(value.boundary)
    default:
      return false
  }
}
