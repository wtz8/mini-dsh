import type { LlmAdapter, LLMRequest, ModelConfig, StreamEvent } from '../contracts.js'
import { LlmError } from '../errors.js'
import { SseParser } from './sse.js'
import type { FetchLike, OpenAiAdapterOptions } from './types.js'
import { buildRequestBody, buildRequestUrl, toStreamEvents } from './wire.js'

/**
 * OpenAI 兼容流式 adapter（02 的核心，设计 §4.1）。
 *
 * 职责：一次 `stream(req)` = 一次 HTTP 请求 + 一条 SSE 流 → `StreamEvent` 序列。
 * 其余一概不做：**不重试、不退避、不设超时**（D5，超时由调用方用 `AbortSignal` 实现），
 * **不写日志**（工厂只收 `model`，拿不到 `ctx.log`；诊断信息经 `LlmError` 上抛）。
 */

/** HTTP 错误里回显的响应体最大长度（截断，避免把整页 HTML 塞进 message）。 */
const BODY_ECHO_LIMIT = 500
/** 协议错误里回显的原始帧最大长度。 */
const FRAME_ECHO_LIMIT = 200

/** 从 unknown 提取可读消息（底层错误要拼进 LlmError）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 判断是否取消语义：fetch/undici 以 `name === 'AbortError'` 的 DOMException 表达。 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** 截断并把换行压成空格——错误信息要能单行打印（07 的 stderr 诊断）。 */
function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}...` : oneLine
}

/**
 * 建连/读流阶段的错误分类：取消优先（signal 已 abort 或 AbortError），其余算网络。
 * 已是 `LlmError` 的错误（如协议错误）原样上抛，不做二次包装。
 */
function asTransportError(err: unknown, signal: AbortSignal): LlmError {
  if (err instanceof LlmError) return err
  const aborted = signal.aborted || isAbort(err)
  return new LlmError(`LLM request failed: ${errMsg(err)}`, {
    kind: aborted ? 'aborted' : 'network',
    cause: err,
  })
}

/** 单个 SSE 帧 → 事件；JSON 非法归 `protocol`。 */
function frameEvents(data: string): StreamEvent[] {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch (err) {
    throw new LlmError(`invalid SSE payload: ${truncate(data, FRAME_ECHO_LIMIT)}`, {
      kind: 'protocol',
      cause: err,
    })
  }
  // 合法 JSON 但不是对象（`null` / 数字 / 字符串 / 数组）：**忽略而非判错**。
  // 部分兼容网关会发 `data: null` 的空闲帧；为它中断整条流，代价是丢掉已经产出的
  // 模型输出与 usage。容忍层放在这里（编排层），`toStreamEvents` 保持线格式映射的严格语义。
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return []
  try {
    return toStreamEvents(json)
  } catch (err) {
    throw new LlmError(`unexpected stream chunk: ${errMsg(err)}`, { kind: 'protocol', cause: err })
  }
}

/**
 * 流式迭代：读响应体 → SSE 解析 → 产出事件。
 *
 * - `finally` 中 `await reader.cancel()`：提前 break / abort / 异常三种退出都要关流，
 *   否则连接悬挂（Windows 下尤其明显）。等待 cancel 完成也让"已关闭"可被测试确定性观测；
 * - `end` 事件至多一次：`[DONE]` 与 EOF 谁先到算谁。
 */
async function* iterate(
  req: LLMRequest,
  model: ModelConfig,
  apiKey: string,
  fetchImpl: FetchLike,
): AsyncGenerator<StreamEvent> {
  // 请求构造放在 try **之外**：构造期抛出的 TypeError 是调用方的编程错误
  // （契约外畸形请求，如缺 `tools`），让它原样冒泡，而不是被下面的 catch 包装成
  // `network`——否则 07 会把本地 bug 提示成"网络故障"。
  const url = buildRequestUrl(model.baseUrl)
  const body = buildRequestBody(req)

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'text/event-stream',
      },
      body,
      signal: req.signal,
    })
  } catch (err) {
    throw asTransportError(err, req.signal)
  }

  if (!response.ok) {
    // 非 2xx：把响应体（截断）拼进 message——401/429/500 的原因基本都在 body 里。
    // 一律上抛，不重试（D5）；重试与否是 agent/CLI 的决策。
    let body = ''
    try {
      body = await response.text()
    } catch {
      body = '' // 读错误体失败不影响主错误的语义
    }
    const suffix = body === '' ? '' : `: ${truncate(body, BODY_ECHO_LIMIT)}`
    throw new LlmError(`LLM request failed with HTTP ${response.status}${suffix}`, {
      kind: 'http',
      status: response.status,
    })
  }
  if (!response.body) throw new LlmError('LLM response has no body', { kind: 'protocol' })

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseParser()
  let ended = false
  try {
    while (!ended) {
      const { done, value } = await reader.read()
      // `stream: true` 让被 TCP 切断的多字节字符在下一片继续解码，不会出现半个汉字
      const frames = done ? parser.flush() : parser.push(decoder.decode(value ?? new Uint8Array(), { stream: true }))
      for (const frame of frames) {
        if (frame.kind === 'done') {
          yield { type: 'end' }
          ended = true
          break
        }
        for (const event of frameEvents(frame.data)) yield event
      }
      if (done) break
    }
  } catch (err) {
    throw asTransportError(err, req.signal)
  } finally {
    // 关流：正常结束 / 提前 break / abort 都会走到这里；cancel 幂等，失败无副作用
    await reader.cancel().catch(() => undefined)
  }
  // 流提前 EOF 且未收到 [DONE]：补一次 end，保证 06 总能收到终止信号
  if (!ended) yield { type: 'end' }
}

/**
 * 创建 OpenAI 兼容 adapter（签名即契约的 `LlmAdapterFactory`，额外收一个可选注入参）。
 *
 * @param model 模型配置：URL 与 API key 环境变量名取自此（01 的 `config.model`）
 * @param options.fetchImpl 注入的 fetch 实现；缺省 `globalThis.fetch`（Node 22 内置）
 * @returns adapter 实例（无内部可变状态，可并发发起多个 stream）
 */
export function createOpenAiAdapter(model: ModelConfig, options: OpenAiAdapterOptions = {}): LlmAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return {
    /**
     * 发起流式请求。
     *
     * **配置类错误在调用点同步抛出**（D4）：缺 API key / signal 已 abort 时一次请求都不发，
     * 让"没设 DEEPSEEK_API_KEY"立刻出现在 06 的调用行，而不是藏到首次迭代。
     *
     * @throws LlmError `config`（API key 未设置）/ `aborted`（调用前已取消）/
     *                  `network` / `http` / `protocol`（建连与读流阶段）
     */
    stream(req: LLMRequest): AsyncIterable<StreamEvent> {
      // 01 §5：apiKeyEnv 指向的环境变量是否存在由 02 在使用点 fail-fast
      const raw = process.env[model.apiKeyEnv]
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new LlmError(`API key environment variable '${model.apiKeyEnv}' is not set`, { kind: 'config' })
      }
      if (req.signal.aborted) throw new LlmError('LLM request aborted before sending', { kind: 'aborted' })
      return iterate(req, model, raw.trim(), fetchImpl)
    },
  }
}
