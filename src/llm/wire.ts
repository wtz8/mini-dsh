import type { ChatMessage, LLMRequest, StreamEvent, TokenUsage, ToolCallDelta, ToolSchema } from '../contracts.js'

/**
 * OpenAI 兼容线格式：请求体构造 + 响应 chunk → `StreamEvent` 映射（设计 §3 / §4.2）。
 *
 * 只写本项目用得上的字段子集，**未知字段一律忽略**（provider 扩展字段不解释）。
 * 本文件的导出是模块内部面（宿主与插件经 `index.ts`），测试可直接单测。
 */

/* ============================================================
 * unknown → 结构化值的收窄助手（零依赖手写校验，不用 any）
 * ============================================================ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/* ============================================================
 * 请求侧
 * ============================================================ */

/**
 * 请求 URL：`<baseUrl>` 去掉尾部斜杠 + `/chat/completions`（设计 §2.4 D6：
 * 契约只给 `baseUrl`，端点路径由 OpenAI 兼容面统一）。
 *
 * @param baseUrl `config.model.baseUrl`（不校验 URL 合法性，01 §8-Q6）
 */
export function buildRequestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** 单个工具定义 → 线格式 tools 元素。 */
function toWireTool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  }
}

/** `ChatMessage` → 线格式消息。三个 role 各自形态不同，逐分支映射。 */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content }
    case 'assistant': {
      const wire: Record<string, unknown> = { role: 'assistant', content: message.content }
      const calls = message.toolCalls
      if (calls && calls.length > 0) {
        wire['tool_calls'] = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      return wire
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
}

/**
 * 构造流式请求体（JSON 字符串）。
 *
 * - `system` 非空时才插入 system 消息（避免给 provider 发空串消息）；
 * - 始终带 `stream_options.include_usage`，让 provider 在流末回传 token 用量；
 * - `tools` 为空数组时**不发**该键（部分 provider 对空数组敏感）；
 * - `maxTokens` 缺省时不发 `max_tokens`。
 *
 * @param req 契约形态的请求（06 现场拼装）
 * @returns 序列化后的请求体
 */
export function buildRequestBody(req: LLMRequest): string {
  const messages: unknown[] = []
  if (typeof req.system === 'string' && req.system !== '') {
    messages.push({ role: 'system', content: req.system })
  }
  for (const message of req.messages) messages.push(toWireMessage(message))

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.tools.length > 0) body['tools'] = req.tools.map(toWireTool)
  if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens
  return JSON.stringify(body)
}

/* ============================================================
 * 响应侧
 * ============================================================ */

/** `usage` 对象 → `TokenUsage`；字段缺失按 0 计（provider 给了 usage 块才算数）。 */
function asUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const result: TokenUsage = {
    inputTokens: asNumber(usage['prompt_tokens']) ?? 0,
    outputTokens: asNumber(usage['completion_tokens']) ?? 0,
  }
  const total = asNumber(usage['total_tokens'])
  if (total !== undefined) result.totalTokens = total
  return result
}

/** 线格式 tool_calls 元素 → `ToolCallDelta`（`id`/`name` 只在首片出现，故可选）。 */
function asToolCallDelta(value: unknown): ToolCallDelta | undefined {
  const call = asRecord(value)
  if (!call) return undefined
  // index 缺失时按 0 处理：线格式恒带 index，缺失意味着单调用，归到 0 号槽位
  const delta: ToolCallDelta = { index: asNumber(call['index']) ?? 0 }
  const id = asString(call['id'])
  if (id !== undefined) delta.id = id
  const fn = asRecord(call['function'])
  if (fn) {
    const name = asString(fn['name'])
    if (name !== undefined) delta.name = name
    const args = asString(fn['arguments'])
    if (args !== undefined) delta.argumentsDelta = args
  }
  return delta
}

/**
 * 一个响应 chunk（已 `JSON.parse`）→ `StreamEvent` 列表。
 *
 * 映射规则（设计 §3）：`delta.content` → text；`delta.tool_calls[]` → tool-call；
 * `usage` → usage（在 tool/text 之前产出，与线格式里 usage 块的出现时机一致）。
 * 空 content（`''`）不产 text 事件，避免 06 侧空渲染。
 *
 * @param json 单个 SSE 帧的解析产物
 * @returns 该帧对应的事件（可能为空数组：心跳/仅含 finish_reason 的帧）
 * @throws Error chunk 不是对象（由 adapter 转为 `LlmError{kind:'protocol'}`）
 */
export function toStreamEvents(json: unknown): StreamEvent[] {
  const chunk = asRecord(json)
  if (!chunk) throw new Error('stream chunk is not an object')

  const events: StreamEvent[] = []
  const usage = asUsage(chunk['usage'])
  if (usage) events.push({ type: 'usage', usage })

  const choices = asArray(chunk['choices'])
  const firstChoice = choices === undefined ? undefined : asRecord(choices[0])
  const delta = firstChoice === undefined ? undefined : asRecord(firstChoice['delta'])
  if (delta) {
    const content = asString(delta['content'])
    if (content !== undefined && content !== '') events.push({ type: 'text', delta: content })

    const toolCalls = asArray(delta['tool_calls'])
    if (toolCalls) {
      for (const raw of toolCalls) {
        const callDelta = asToolCallDelta(raw)
        if (callDelta) events.push({ type: 'tool-call', delta: callDelta })
      }
    }
  }
  return events
}
