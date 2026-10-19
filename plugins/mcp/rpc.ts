import type { Logger } from '../../src/index.js'
import type { JsonRpcNotification } from './types.js'

/**
 * JSON-RPC 会话（设计 §4.3）：**换行分帧 JSON** 上的请求关联层。
 *
 * 这是 09 唯一一块参考实现没有可抄代码的部分（原版委托官方 SDK，设计 §1），
 * 也是零依赖约束下必须自写的协议核心。职责刻意收窄为纯逻辑：
 *
 * - 出站：`JSON.stringify(msg) + '\n'` 交给注入的 `send`（怎么写、写到哪，
 *   归 `client.ts` 的子进程接线）；
 * - 入站：调用方把 stdout 的每一行喂给 `receive`，按 `id` 分发到等待者；
 * - 请求超时与取消：调用方给 `timeoutMs` / `signal`，会话负责 race 并在
 *   取消时发 `notifications/cancelled`（best-effort）。
 *
 * 会话不认识"子进程"——spawn / stdin / stdout / 生命周期全在 `client.ts`，
 * 因此本文件可以完全在内存里单测（伪 send + 喂行字符串）。
 */

/** 单次请求的可选策略。 */
export interface JsonRpcRequestOptions {
  /** 超时（毫秒）；到时 reject，连接与在途请求不受影响。 */
  timeoutMs?: number
  /** 取消信号；触发时先发 `notifications/cancelled` 再 reject。 */
  signal?: AbortSignal
}

/** 在途请求的簿记项：兑现渠道 + 定时器/监听器的清理函数（幂等）。 */
interface PendingEntry {
  resolve(value: unknown): void
  reject(err: Error): void
  cleanup(): void
}

/** JSON-RPC 会话的对外面。 */
export interface JsonRpcSession {
  /**
   * 发一个请求并等待响应。
   *
   * @param method 方法名（如 `initialize` / `tools/list` / `tools/call`）
   * @param params 参数（`undefined` 时不出现在消息里）
   * @param options 超时与取消策略
   * @returns 响应的 `result` 字段（未收窄的原始值）
   * @throws Error 超时 / 被取消 / 对端返回 JSON-RPC error / 发送失败 /
   *   连接关闭（`failAll`，如子进程崩溃）
   */
  request(method: string, params?: unknown, options?: JsonRpcRequestOptions): Promise<unknown>
  /**
   * 发一个通知（无 `id`，不等待响应）。
   * 发送失败只记 debug 日志不上抛（Q8：取消通知可能写在已销毁的管道上）。
   */
  notify(method: string, params?: unknown): void
  /**
   * 喂入一行入站消息（stdout 的一行）。
   * 空行 / 非法 JSON / 非对象 / 未知 id / server 通知一律**忽略且不抛**
   * （一条坏行不该毁掉整条连接，设计 §5 表 15）。
   */
  receive(line: string): void
  /**
   * 让全部在途请求立即以同一错误失败（连接关闭时调用，防止 `await` 永挂）。
   * 幂等：无在途请求时是空操作。
   */
  failAll(err: Error): void
  /** 当前在途请求数（诊断/测试用）。 */
  readonly pendingCount: number
}

/** 创建 JSON-RPC 会话。 */
export function createJsonRpcSession(options: {
  /** 出站写口：接收"一行完整 JSON"（含尾部换行）。抛错视为发送失败。 */
  send(line: string): void
  /** 可选日志器；缺省时静默。 */
  log?: Logger
}): JsonRpcSession {
  const { send, log } = options
  /** 自增请求 id（JSON-RPC 的关联键）。 */
  let nextId = 0
  const pending = new Map<number, PendingEntry>()

  /** unknown → 单行可读消息（不塞 stack）。 */
  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  function notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    try {
      send(`${JSON.stringify(msg)}\n`)
    } catch (err) {
      // 通知没有响应可等：写失败只记日志（典型场景是取消时管道已销毁，Q8）
      log?.debug(`MCP: 通知 ${method} 发送失败（${messageOf(err)}）`)
    }
  }

  function failAll(err: Error): void {
    for (const entry of pending.values()) {
      entry.cleanup()
      entry.reject(err)
    }
    pending.clear()
  }

  function request(
    method: string,
    params?: unknown,
    requestOptions?: JsonRpcRequestOptions,
  ): Promise<unknown> {
    const timeoutMs = requestOptions?.timeoutMs
    const signal = requestOptions?.signal
    // 先行检查：已取消的调用不产生任何 IO（连 cancelled 通知都不必发——请求还没出去）
    if (signal?.aborted) {
      return Promise.reject(new Error(`MCP 请求 ${method} 已取消`))
    }
    const id = ++nextId
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      const entry: PendingEntry = {
        resolve,
        reject,
        // 幂等清理：超时与取消两条路径都要撤掉对方的挂钩
        cleanup() {
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }
          if (onAbort && signal) {
            signal.removeEventListener('abort', onAbort)
            onAbort = undefined
          }
        },
      }
      /** 终态三选一的公共前置：出等待表 + 清挂钩（谁先到谁生效）。 */
      const settle = (finish: () => void): void => {
        if (!pending.delete(id)) return // 已被另一条路径终结，迟到者直接丢弃
        entry.cleanup()
        finish()
      }
      // 取消：先通知 server（best-effort）再失败——server 有机会中止自己的长任务
      const cancel = (): void => {
        settle(() => {
          notify('notifications/cancelled', { requestId: id, reason: '客户端已取消' })
          reject(new Error(`MCP 请求 ${method} 已取消`))
        })
      }
      pending.set(id, entry)
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            settle(() => {
              reject(new Error(`MCP 请求 ${method} 超时（${timeoutMs}ms）`))
            }),
          timeoutMs,
        )
        // 不拖住进程退出：调用方都在 await，定时器只服务这一条请求
        timer.unref?.()
      }
      if (signal) {
        onAbort = cancel
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        const msg =
          params === undefined
            ? { jsonrpc: '2.0' as const, id, method }
            : { jsonrpc: '2.0' as const, id, method, params }
        send(`${JSON.stringify(msg)}\n`)
      } catch (err) {
        settle(() => {
          reject(new Error(`MCP 请求 ${method} 发送失败：${messageOf(err)}`))
        })
      }
    })
  }

  function receive(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let msg: unknown
    try {
      msg = JSON.parse(trimmed)
    } catch (err) {
      log?.warn(`MCP: 忽略无法解析的消息行（${messageOf(err)}）`)
      return
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      log?.warn('MCP: 忽略非对象消息行')
      return
    }
    const record = msg as Record<string, unknown>
    const id = record['id']
    if (id === undefined || id === null) {
      // server → client 通知：mini 不消费（tools/list_changed 等按 Q11/D6 无意义）
      if (typeof record['method'] === 'string') log?.debug(`MCP: 忽略 server 通知 ${record['method']}`)
      return
    }
    // 我们的请求 id 恒为 number；对不上号的响应一律忽略（迟到/重复/别家的）
    if (typeof id !== 'number') return
    const entry = pending.get(id)
    if (!entry) {
      log?.debug(`MCP: 忽略未知 id=${id} 的响应`)
      return
    }
    pending.delete(id)
    entry.cleanup()
    const error = record['error']
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const shape = error as Record<string, unknown>
      const code = typeof shape['code'] === 'number' ? shape['code'] : 0
      const message = typeof shape['message'] === 'string' ? shape['message'] : '未知错误'
      entry.reject(new Error(`MCP 错误 ${code}: ${message}`))
      return
    }
    entry.resolve(record['result'])
  }

  return {
    request,
    notify,
    receive,
    failAll,
    get pendingCount() {
      return pending.size
    },
  }
}
