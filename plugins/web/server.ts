import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { ChatMessage, Ctx, SessionEvent, TokenUsage, TurnSummary } from '../../src/index.js'
import { deriveMessages, resolvePermission } from '../../src/index.js'

import { PAGE_HTML } from './assets/page.js'
import { APP_CSS } from './assets/styles.js'
import { APP_JS } from './assets/client.js'
import { MASCOT_WEBP_BASE64 } from './assets/mascot.js'
import { MAX_BODY_BYTES, UI_RESULT_CHARS } from './types.js'
import type { StateSnapshot, UiEvent } from './types.js'

/**
 * HTTP 服务与 SSE 推送（零依赖：只用 `node:http`）。
 *
 * 三条硬约束落实在这里：
 * - **只绑回环**：`isLoopbackHost` 是启动前的闸门，非回环地址直接拒绝（D4）；
 * - **无外链**：页面只引用同目录下的 `app.css` / `app.js`，离线可用（D2）；
 * - **不存第二份状态**：所有历史由 `ctx.sessions.read()` + `deriveMessages` 现场投影（D5）。
 */

/** web 服务的依赖集（插件装配；单测注入伪实现）。 */
export interface WebServerDeps {
  /** 组合根返回的上下文 */
  ctx: Ctx
  /** 审批通道（插件持有，与注入 agent-loop 的是同一个） */
  approvals: ApprovalSink
  /** 启动一个回合；resolve 时回合已结束（不抛——错误已转成 `error` 帧） */
  runTurn(text: string): Promise<TurnSummary>
  /** 读取当前会话 id */
  sessionId(): string
}

/** 本模块向审批通道索取的那一面（查询与结算）。 */
export interface ApprovalSink {
  pending(): ReadonlyArray<{ id: string; toolName: string; args: Record<string, unknown>; createdAt: number }>
  /** 结算一次审批；id 不存在或已结算返回 `false` */
  respond(id: string, allow: boolean): boolean
}

/** 已解析的服务选项（默认值已填齐、host 已校验）。 */
export interface ResolvedWebOptions {
  port: number
  host: string
  /** 规范化后的前缀：`''` 或 `'/mdsh'`（无尾斜杠） */
  basePath: string
  heartbeatMs: number
  onReady?(info: { port: number; host: string; url: string }): void
}

/** web 服务句柄。 */
export interface WebServer {
  /** 监听就绪后 resolve 实际端口（端口 0 时为系统分配值） */
  ready(): Promise<number>
  /** 当前实际端口；就绪前为 `undefined` */
  readonly port: number | undefined
  /** 向全部 SSE 客户端推一帧；无客户端时静默丢弃 */
  broadcast(ev: UiEvent): void
  /** 关闭服务并断开全部 SSE 连接；2s 后强制收尾 */
  close(): Promise<void>
}

/**
 * 判断是否为回环地址（D4 的闸门）。
 *
 * 接受的形态：
 * - `localhost`（含大写）；
 * - IPv4 回环 `127.x.x.x`（按 RFC 1122，整个 127/8 都是本机）；
 * - IPv6 回环 `::1`，含方括号写法与带网卡作用域的 `::1%lo0`。
 *
 * 其余（含 `0.0.0.0`、`::`、局域网地址、公网地址）一律**拒绝**——
 * 前两者会把服务暴露到所有网卡，正是本模块要防的。
 *
 * @param host 待判定的监听地址
 * @returns 是回环地址则 `true`
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === '' || h === 'localhost') return true

  // IPv6 方括号写法：[::1]、[::1%lo0]
  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1)
    return isLoopbackIpv6(inner)
  }
  // 裸 IPv6：::1、::1%lo0
  if (h.includes(':')) return isLoopbackIpv6(h)

  // IPv4：127.0.0.0/8
  if (/^127(\.\d{1,3}){3}$/.test(h)) {
    return h
      .split('.')
      .every((part) => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255)
  }
  return false
}

/** IPv6 字面量是否为回环（`::1`，允许带作用域后缀）。 */
function isLoopbackIpv6(literal: string): boolean {
  const withoutScope = literal.split('%')[0] ?? ''
  if (withoutScope === '::1') return true
  // 全写形态 0000:...:0001（7 个冒号）
  if (/^0{0,4}(:0{0,4}){6}:0{0,3}1$/.test(withoutScope)) return true
  return false
}

/**
 * 规范化 URL 前缀。
 *
 * @param basePath 用户给的前缀
 * @returns `''`（根）或 `/xxx`（无尾斜杠）
 * @throws Error 形态非法（不以 `/` 开头）
 */
export function normalizeBasePath(basePath: string | undefined): string {
  if (basePath === undefined || basePath === '' || basePath === '/') return ''
  if (!basePath.startsWith('/')) throw new Error('`basePath` must start with `/`')
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
}

/** 剥掉前缀；不匹配返回 `null`。 */
function stripBase(pathname: string, basePath: string): string | null {
  if (basePath === '') return pathname
  if (pathname === basePath) return '/'
  if (!pathname.startsWith(basePath + '/')) return null
  return pathname.slice(basePath.length)
}

/** 累计用量：log 中全部 `assistant/message.usage` 求和。 */
function sumUsage(events: readonly SessionEvent[]): TokenUsage {
  let inputTokens = 0
  let outputTokens = 0
  for (const event of events) {
    if (event.type === 'assistant/message' && event.usage) {
      inputTokens += event.usage.inputTokens
      outputTokens += event.usage.outputTokens
    }
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

/** 计数已开始的回合数。 */
function countTurns(events: readonly SessionEvent[]): number {
  let n = 0
  for (const event of events) if (event.type === 'turn/start') n += 1
  return n
}

/** 已注册工具名（升序）+ 各自生效的权限策略。 */
function toolPolicies(ctx: Ctx): Array<{ name: string; action: string }> {
  return ctx.tools
    .list()
    .map((def) => ({ name: def.name, action: resolvePermission(ctx.config.permissions, def.name) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json', JSON.stringify(data))
}

/** 吉祥物立绘（模块加载时解码一次，复用；内容固定，可长缓存）。 */
const MASCOT_WEBP = Buffer.from(MASCOT_WEBP_BASE64, 'base64')

/** 发送二进制体（图片等资源；不带 charset，允许长缓存）。 */
function sendBin(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'public, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * 读取请求体（带字节上限，B12）。
 *
 * @throws Error 超出 `MAX_BODY_BYTES` 或流出错
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析 JSON 对象；非对象返回 `null`。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** 展示用截断：保留头尾，中间省略（工具结果可能很长）。 */
export function truncateForUi(text: string, limit: number = UI_RESULT_CHARS): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head - 24
  return `${text.slice(0, head)}\n… 已省略部分输出 …\n${text.slice(Math.max(0, text.length - tail))}`
}

/**
 * 创建并监听 web 服务。
 *
 * `host` 必须已通过 `isLoopbackHost` 校验（由 `plugin.ts` 在 setup 内把关）。
 *
 * @param options 已解析选项
 * @param deps 依赖集
 * @returns 服务句柄
 */
export function createWebServer(options: ResolvedWebOptions, deps: WebServerDeps): WebServer {
  /** 已连接的 SSE 客户端 */
  const clients = new Set<ServerResponse>()
  let closed = false
  let port: number | undefined

  /**
   * 广播一帧。
   *
   * 逐个 write；出错（客户端已断）就从集合里摘掉，不让一个死连接影响其他人。
   */
  function broadcast(ev: UiEvent): void {
    if (clients.size === 0) return
    const frame = `data: ${JSON.stringify(ev)}\n\n`
    for (const client of [...clients]) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  }

  /**
   * 组装状态快照：历史**现场投影**，不缓存。
   *
   * 会话不可读时（如存储未挂载）不抛错——返回空快照，界面照常可用，
   * 与 07 "会话 id 不可读不影响 REPL" 同式（O7）。
   */
  async function snapshot(): Promise<StateSnapshot> {
    const ctx = deps.ctx
    const sessionId = deps.sessionId()
    const cfg = ctx.config
    let messages: ChatMessage[] = []
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let turnCount = 0
    try {
      const events = await ctx.sessions.read(sessionId)
      messages = deriveMessages(events)
      usage = sumUsage(events)
      turnCount = countTurns(events)
    } catch {
      // 读不到就当新会话
    }
    return {
      sessionId,
      provider: cfg.model.provider,
      model: cfg.model.name,
      cwd: process.cwd(),
      messages,
      usage,
      turnCount,
      tools: toolPolicies(ctx).map((t) => t.name),
      running: false,
    }
  }

  /** 处理一个 HTTP 请求。 */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', `http://${options.host}`).pathname
    } catch {
      send(res, 400, 'text/plain', 'bad request')
      return
    }

    const path = stripBase(pathname, options.basePath)
    if (path === null) {
      send(res, 404, 'text/plain', 'not found')
      return
    }

    // 静态资源
    if (path === '/' || path === '/index.html') {
      const html = PAGE_HTML.split('__BASE__').join(options.basePath).replace('__THEME__', 'light')
      send(res, 200, 'text/html', html)
      return
    }
    if (path === '/assets/app.css') {
      send(res, 200, 'text/css', APP_CSS)
      return
    }
    if (path === '/assets/app.js') {
      send(res, 200, 'application/javascript', APP_JS)
      return
    }
    if (path === '/assets/mascot.webp') {
      sendBin(res, 200, 'image/webp', MASCOT_WEBP)
      return
    }

    // API
    if (path.startsWith('/api/')) {
      await handleApi(req, res, method, path)
      return
    }

    send(res, 404, 'text/plain', 'not found')
  }

  /** API 路由分派。 */
  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    if (path === '/api/state') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const snap = await snapshot()
      sendJson(res, 200, {
        ...snap,
        running: running,
        pendingApprovals: deps.approvals.pending(),
        toolPolicies: toolPolicies(deps.ctx),
      })
      return
    }

    if (path === '/api/events') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      openStream(res)
      return
    }

    if (path === '/api/turn') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let body: Record<string, unknown> | null
      try {
        body = parseJsonObject(await readBody(req))
      } catch {
        sendJson(res, 413, { error: 'request body too large' })
        return
      }
      if (body === null) {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const text = typeof body['text'] === 'string' ? body['text'].trim() : ''
      if (text === '') {
        sendJson(res, 400, { error: '`text` must be a non-empty string' })
        return
      }
      if (running) {
        sendJson(res, 409, { error: 'a turn is already running' })
        return
      }
      running = true
      sendJson(res, 202, { ok: true })
      // 不 await：回合在后台跑，过程经 SSE 推送；await 会让这个 HTTP 请求挂到回合结束。
      //
      // `turn-end` 帧**由插件侧的 runTurn 包装器广播**——总线上的 `turn/end` 通知
      // 只带 `sessionId`/`turnNo`，而用量与步数只在 `TurnSummary` 里，
      // 因此收口在拿到 summary 的那一侧，避免重复推帧。
      void deps
        .runTurn(text)
        .catch(() => undefined)
        .finally(() => {
          running = false
        })
      return
    }

    if (path === '/api/cancel') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        deps.ctx.agent.resolve().cancel('user requested via web ui')
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 503, { error: describe(err) })
      }
      return
    }

    if (path === '/api/approve') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let body: Record<string, unknown> | null
      try {
        body = parseJsonObject(await readBody(req))
      } catch {
        sendJson(res, 413, { error: 'request body too large' })
        return
      }
      if (body === null) {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const id = body['id']
      const allow = body['allow'] === true
      if (typeof id !== 'string' || id === '') {
        sendJson(res, 400, { error: '`id` must be a non-empty string' })
        return
      }
      const hit = deps.approvals.respond(id, allow)
      if (!hit) {
        // 已结算 / 已超时：不是错误，如实告知，UI 无需特殊处理
        sendJson(res, 200, { ok: true, matched: false })
        return
      }
      // approval-resolved 帧由插件侧的通道订阅统一广播（含 allow 真值），
      // 此处不再重复推——所有浏览器都会经订阅同步到卡片消失。
      sendJson(res, 200, { ok: true, matched: true })
      return
    }

    sendJson(res, 404, { error: 'unknown api route' })
  }

  /** 建立一条 SSE 长连接。 */
  function openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 首帧即发 hello：前端据此判定连接成功，无需等服务端首个业务事件
    const ctx = deps.ctx
    res.write(
      `data: ${JSON.stringify({
        type: 'hello',
        sessionId: deps.sessionId(),
        provider: ctx.config.model.provider,
        model: ctx.config.model.name,
        cwd: process.cwd(),
        tools: toolPolicies(ctx).map((t) => t.name),
      } satisfies UiEvent)}\n\n`,
    )
    clients.add(res)

    const onClose = (): void => {
      clients.delete(res)
      res.off('close', onClose)
    }
    res.on('close', onClose)
  }

  let running = false

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: describe(err) })
      else res.end()
    })
  })

  server.on('error', () => undefined)

  const readyPromise = new Promise<number>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address()
      const value = typeof address === 'object' && address !== null ? address.port : options.port
      port = value
      if (options.onReady) {
        options.onReady({ port: value, host: options.host, url: urlOf(options.host, value, options.basePath) })
      }
      resolve(value)
    })
    server.once('error', (err: Error) => reject(err))
    server.listen(options.port, options.host)
  })

  const heartbeat: NodeJS.Timeout = setInterval(() => {
    for (const client of [...clients]) {
      try {
        client.write(': keep-alive\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }, options.heartbeatMs)
  heartbeat.unref()

  return {
    ready: () => readyPromise,
    get port() { return port },
    broadcast,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      for (const client of [...clients]) {
        try { client.end() } catch { /* 已断开 */ }
      }
      clients.clear()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 2000)
        server.close(() => { clearTimeout(timer); resolve() })
        // 端口已无监听时 close 的回调仍会触发；这里只兜底"有连接挂着"的极端情况
      })
    },
  }
}

/** 拼可点开的 URL。 */
function urlOf(host: string, port: number, basePath: string): string {
  const h = host.includes(':') ? `[${host}]` : host
  return `http://${h}:${String(port)}${basePath}/`
}

/** 取错误的可读文本（与 07 的 `describeError` 同口径，这里只取文本避免依赖 CLI）。 */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
