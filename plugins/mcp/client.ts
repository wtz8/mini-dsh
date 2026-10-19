import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'

import type { Logger } from '../../src/index.js'
import { createJsonRpcSession } from './rpc.js'
import type { JsonRpcSession } from './rpc.js'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DISPOSE_CLOSE_TIMEOUT_MS,
  STDERR_LINE_MAX_CHARS,
  type McpCallOutcome,
  type McpRemoteTool,
  type McpServerSpec,
  type SpawnLike,
} from './types.js'

/**
 * 单个 MCP server 的客户端（设计 §4.2 / §4.6）：子进程接线 + 协议会话的宿主。
 *
 * 职责边界：协议逻辑（分帧、请求关联、超时、取消）全在 `rpc.ts`；本文件只做
 * "子进程 ↔ 会话"的接线与 server 级生命周期（握手、发现、调用、关闭）。
 *
 * 生命周期是**单向的**：`start()` 只在插件 setup 时调一次；断连不重连（Q11），
 * 之后 `callTool` 会以"连接已关闭"失败，直到 `dispose()`。
 */

/** 单次 `tools/call` 的可选策略。 */
export interface McpCallOptions {
  /** 覆盖该 server 的请求超时（毫秒）。 */
  timeoutMs?: number
  /** 取消信号（来自 05 的 `ToolEnv.signal`）。 */
  signal?: AbortSignal
}

/** 一个已 spawn 的 server 连接面。 */
export interface McpClient {
  /** 本地配置的 server 名（命名空间，见 `naming.ts`）。 */
  readonly serverName: string
  /**
   * 启动序列：`initialize` → `notifications/initialized` → `tools/list`。
   *
   * @param startupTimeoutMs 整个序列（含 spawn 后的首次响应等待）的统一超时
   * @returns 该 server 的远端工具清单；server 未声明 `capabilities.tools`
   *   时为空数组（算成功，设计 §4.2）
   * @throws Error spawn 失败 / 握手或发现超时 / JSON-RPC error / 响应形状非法 /
   *   同一 server 内工具重名（设计 §5 表 7）
   */
  start(startupTimeoutMs: number): Promise<McpRemoteTool[]>
  /**
   * 调用一个远端工具（wire 上用 raw 名，公开名从不发给 server）。
   *
   * @throws Error 超时 / 取消 / JSON-RPC error / 连接已关闭
   */
  callTool(
    rawName: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<McpCallOutcome>
  /**
   * 关闭连接：让在途请求立即失败 → 断 stdin（进程握着管道不会退出，05 Y6）→
   * kill → 最多等 {@link DISPOSE_CLOSE_TIMEOUT_MS} 毫秒退出确认。幂等。
   *
   * 已知局限（F-05）：`npx` 拉起的孙进程不在 kill 范围内，与 05 F-04 同源。
   */
  dispose(): Promise<void>
}

/** 构造参数（`spawn` 可注入，设计 D5）。 */
export interface McpClientOptions {
  server: string
  spec: McpServerSpec
  log: Logger
  spawn?: SpawnLike
}

/** 判断"普通对象"（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** unknown → 单行可读消息。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 组装子进程环境（Q9 / Q14）：继承全部 `process.env`，`spec.env` 覆盖；
 * 值形如 `'$ENV:NAME'` 时取父进程同名变量。
 *
 * @throws Error `$ENV:NAME` 引用的变量在父进程不存在（启动失败，不静默传空值：
 *   空 token 会让 server 起来后每次调用都报鉴权错，比启动失败更难懂）
 */
function buildEnv(server: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (extra === undefined) return env
  for (const [key, value] of Object.entries(extra)) {
    if (value.startsWith('$ENV:')) {
      const name = value.slice('$ENV:'.length)
      const resolved = process.env[name]
      if (resolved === undefined) {
        throw new Error(
          `MCP server '${server}' 的环境变量 ${key} 使用 $ENV:${name} 语法，但父进程没有该变量`,
        )
      }
      env[key] = resolved
      continue
    }
    env[key] = value
  }
  return env
}

/** 可被 unref 的延时（dispose 的退出确认上限不该拖住进程）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * 收窄 `tools/list` 的响应：`tools` 数组 → `McpRemoteTool[]`。
 *
 * @throws Error `tools` 缺失或非数组 / 工具项形状非法（无名字）/ 同名工具
 */
function narrowTools(
  server: string,
  result: unknown,
  log: Logger,
): McpRemoteTool[] {
  if (!isPlainObject(result)) {
    throw new Error(`MCP server '${server}' 的 tools/list 响应不是对象`)
  }
  const rawTools = result['tools']
  if (!Array.isArray(rawTools)) {
    throw new Error(`MCP server '${server}' 的 tools/list 响应缺少 tools 数组`)
  }
  // Q12：不做分页；nextCursor 存在时提示"可能有更多工具未被发现"，不静默
  const nextCursor = result['nextCursor']
  if (typeof nextCursor === 'string' && nextCursor !== '') {
    log.warn(`MCP server '${server}' 的工具列表超过一页（nextCursor 存在），仅注册第一页`)
  }
  const seen = new Set<string>()
  const tools: McpRemoteTool[] = []
  for (const item of rawTools) {
    if (!isPlainObject(item) || typeof item['name'] !== 'string' || item['name'] === '') {
      throw new Error(`MCP server '${server}' 的工具列表包含形状非法的条目`)
    }
    // 同一 server 内重名会让公开名撞车（05 容器抛 already registered → 整个 boot 挂）
    if (seen.has(item['name'])) {
      throw new Error(`MCP server '${server}' 的工具列表存在重名工具 '${item['name']}'`)
    }
    seen.add(item['name'])
    tools.push({
      name: item['name'],
      ...(typeof item['description'] === 'string' ? { description: item['description'] } : {}),
      ...('inputSchema' in item ? { inputSchema: item['inputSchema'] } : {}),
    })
  }
  return tools
}

/** 收窄 `tools/call` 的响应：只保留 `content` 与 `isError`。 */
function narrowCallOutcome(result: unknown): McpCallOutcome {
  const record = isPlainObject(result) ? result : {}
  return {
    content: record['content'],
    isError: record['isError'] === true,
  }
}

/**
 * 创建一个 server 连接（立即 spawn，不握手——握手在 `start()` 内）。
 *
 * @throws Error `$ENV:NAME` 引用的变量不存在（在 spawn **之前**抛出，不留孤儿进程）
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const { server, spec, log } = options
  const spawnFn = options.spawn ?? nodeSpawn
  const env = buildEnv(server, spec.env) // 先解环境再 spawn：失败时零副作用
  const child: ChildProcess = spawnFn(spec.command, spec.args ?? [], {
    env,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // 会话先于事件监听创建：'error' / 'close' 处理器要用它让在途请求失败
  const session: JsonRpcSession = createJsonRpcSession({
    send(line) {
      if (child.stdin === null) throw new Error('MCP server 的 stdin 不可用')
      child.stdin.write(line)
    },
    log,
  })

  /**
   * 终止原因（spawn 'error' 或进程 'close' 时记录）。
   *
   * 两个用途：① 让在途请求以它失败；② **连接死亡后新发起的调用快速失败**——
   * `failAll` 只救在途请求，管不了"close 之后才发的新请求"（那会一直挂到
   * 超时为止，单测 29 抓出的真实缺陷）；不重连（Q11），死了就是死了。
   */
  let deadReason: string | undefined
  const failDead = (): void => {
    if (deadReason !== undefined) session.failAll(new Error(deadReason))
  }

  // 05 Y3 的教训：spawn 失败以 'error' 事件异步送达，不监听会炸进程。
  // 监听后把它转成"让全部在途请求失败"，错误消息里带可操作的提示。
  child.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    const hint =
      process.platform === 'win32' && code === 'ENOENT'
        ? '（Windows 下 npx 须写作 npx.cmd，也可用完整路径）'
        : ''
    deadReason = `MCP server '${server}' 进程启动失败：${err.message}${hint}`
    failDead()
  })

  // 子进程退出：让在途请求立即失败（否则 await 永挂）；closePromise 供 dispose 等待
  let closed = false
  let resolveClose: () => void
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve
  })
  child.on('close', () => {
    closed = true
    resolveClose()
    deadReason ??= `MCP server '${server}' 连接已关闭`
    failDead()
  })

  // 管道上的 'error'（EPIPE 等）不处理会以 unhandled 'error' 炸进程；
  // 写失败已由 rpc 的 send try/catch 兜住，这里只需吞掉事件本身
  child.stdin?.on('error', () => {})
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})

  // stdout 行泵：readline 按换行切分（MCP stdio 为换行分帧 JSON，非 LSP 的
  // Content-Length 头），每行交给会话分发。
  //
  // 两个 readline interface **自身**都要装 'error' 监听（评审 Y1）：Node 的
  // readline 会把 input 流的 'error' 转发为 interface 的 'error'，而上面给
  // child.stdout / child.stderr 装的 noop 只吞掉了流那一层——interface 这一层
  // 没有监听器时，一次 stdout 出错（EPIPE / ECONNRESET）就是 uncaught exception，
  // 整个 CLI 进程崩掉（05 Y3 的同款教训；探针实证：emit 即同步抛出）。
  const stdoutLines = createInterface({ input: child.stdout! })
  stdoutLines.on('error', () => {})
  stdoutLines.on('line', (line) => session.receive(line))
  // stderr 行泵：只进诊断日志、截断（Q13），永不进工具结果（不可信输入）
  const stderrLines = createInterface({ input: child.stderr! })
  stderrLines.on('error', () => {})
  stderrLines.on('line', (line) => {
    log.debug(`[mcp:${server}] stderr: ${line.slice(0, STDERR_LINE_MAX_CHARS)}`)
  })

  let disposed = false

  return {
    serverName: server,

    async start(startupTimeoutMs: number): Promise<McpRemoteTool[]> {
      // 连接已死（spawn 失败/进程退出）时快速失败，不发出注定无人应答的请求
      if (deadReason !== undefined) throw new Error(deadReason)
      // 整个启动序列（spawn 之后的 initialize + tools/list）共用一个 deadline
      // （设计 §4.2）：两次请求分到的是"剩余时间"而不是各给一份预算——否则最坏
      // 耗时是 2×startupTimeoutMs（默认 10s ⇒ 20s），会越过 07 的
      // BOOT_TIMEOUT_MS=15s，用户看到的就不是"MCP server 启动失败"而是"插件挂载
      // 超时"，诊断性反而更差（评审 Y2）。
      const deadline = Date.now() + startupTimeoutMs
      const remainingMs = (): number => Math.max(1, deadline - Date.now())
      const initResult = await session.request(
        'initialize',
        {
          // Q5：固定声明一个版本，不校验 server 回的版本（不做兼容矩阵）
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'minidsh-mcp', version: '0.1.0' },
        },
        { timeoutMs: remainingMs() },
      )
      session.notify('notifications/initialized')
      // server 未声明 tools 能力 ⇒ 空工具集，算启动成功（设计 §4.2）
      const caps = isPlainObject(initResult) ? initResult['capabilities'] : undefined
      if (!isPlainObject(caps) || caps['tools'] === undefined) {
        log.info(`MCP server '${server}' 未声明 tools 能力，注册零工具`)
        return []
      }
      const listResult = await session.request('tools/list', {}, { timeoutMs: remainingMs() })
      return narrowTools(server, listResult, log)
    },

    async callTool(
      rawName: string,
      args: Record<string, unknown>,
      callOptions?: McpCallOptions,
    ): Promise<McpCallOutcome> {
      // 同 start：连接已死时快速失败（Q11 不重连，工具调用得到明确的死因）
      if (deadReason !== undefined) throw new Error(deadReason)
      // 公开名从不发给 server（Q6）：wire 上永远用 raw 名
      const result = await session.request(
        'tools/call',
        { name: rawName, arguments: args },
        {
          timeoutMs:
            callOptions?.timeoutMs ?? spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
        },
      )
      return narrowCallOutcome(result)
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // 先让在途调用失败（拿到明确的"连接已关闭"），再动进程；
      // 此后新调用由 deadReason 入口守卫快速失败
      deadReason ??= `MCP server '${server}' 连接已关闭`
      failDead()
      // 先断管道再 kill：进程握着管道时不会退出（05 Y6 的实证结论）
      try {
        child.stdin?.destroy()
      } catch {
        // 已销毁的管道再 destroy 不该让 dispose 失败
      }
      // 读端一并收掉（评审 Y1 的延伸）：F-05 的孤儿进程（npx 拉起的孙进程）会
      // 握着 stdout 不 end，未销毁的读端是活跃 handle —— CLI 退出将落到 bin 的
      // 强制退出而非自然收尾（stdout 可能没 flush 完）。行泵先 close 再毁流。
      stdoutLines.close()
      stderrLines.close()
      for (const stream of [child.stdout, child.stderr]) {
        try {
          stream?.destroy()
        } catch {
          // 同 stdin：已销毁不该让 dispose 失败
        }
      }
      try {
        child.kill()
      } catch (err) {
        log.debug(`[mcp:${server}] kill 失败（${messageOf(err)}），进程可能已退出`)
      }
      if (closed) return
      await Promise.race([closePromise, delay(DISPOSE_CLOSE_TIMEOUT_MS)])
    },
  }
}
