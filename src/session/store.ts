import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Session, SessionEvent, SessionInit, SessionMeta, Unsubscribe } from '../contracts.js'
import { SessionError } from '../errors.js'
import { createSessionId } from './ids.js'
import { appendLine, parseLine, readFirstLine, readText, splitLines } from './jsonl.js'
import { SESSION_FILE } from './types.js'
import type { JsonlSessionStore, SessionEntry, SessionListener, SessionStoreOptions } from './types.js'

/**
 * JSONL 会话存储（03 设计 §4）：append-only 落盘 + 内存全量缓存 + 订阅派发。
 *
 * 四条秩序约定（都是"log 是唯一事实源"的落点）：
 *
 * 1. **落盘 → 内存 → 派发**：崩溃一致性上"宁可写了没通知，不可通知了没写"；
 *    订阅者被回调时，内存快照已含该事件。
 * 2. **写入串行化**：并发 `append`（06 并行执行工具后 `Promise.all(append(...))`）
 *    按**调用顺序**落盘——否则投影顺序与 resume 后的顺序会漂移。
 * 3. **订阅者抛错不影响持久化**：`append` 是写入路径，绝不因某个监听器崩掉而失败。
 * 4. **冷载入 single-flight**：同 id 的并发载入共享同一 in-flight Promise 与 entry
 *    ——否则两次独立读盘、两次缓存写入让后写者胜出，先完成的 append 把事件 push
 *    进被抛弃的 entry，内存缓存与磁盘从此分叉（事件在盘上、缓存里没有）。
 *
 * 本类**不依赖 ctx**（设计 D3）：诊断与广播经构造选项的回调注入，因此可脱离
 * 组合根单测（给一个 tmp 目录即可）。
 */

/** 从 unknown 提取可读消息（底层 IO 错误要拼进 SessionError）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 取 fs 错误的 errno（用于区分 ENOENT 与真故障）。 */
function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code
}

class JsonlSessionStoreImpl implements JsonlSessionStore {
  readonly #root: string
  readonly #onAppend: ((sessionId: string, event: SessionEvent) => void) | undefined
  readonly #onWarn: ((message: string) => void) | undefined
  readonly #onError: ((message: string, err: unknown) => void) | undefined
  readonly #idFactory: () => string
  readonly #sessions = new Map<string, SessionEntry>()
  /** 进行中的载入（single-flight 备忘录）：同 id 并发载入共享同一 Promise。 */
  readonly #loading = new Map<string, Promise<SessionEntry>>()
  /** 串行写链：每次 append 接到链尾，保证落盘顺序 = 调用顺序 */
  #chain: Promise<void> = Promise.resolve()

  constructor(options: SessionStoreOptions = {}) {
    this.#root = options.dir ?? path.join(os.homedir(), '.minidsh', 'sessions')
    this.#onAppend = options.onAppend
    this.#onWarn = options.onWarn
    this.#onError = options.onError
    this.#idFactory = options.idFactory ?? (() => createSessionId())
  }

  /* ---------------- 契约面：create / open / list / read ---------------- */

  /**
   * 新建会话：建目录 → 写 `session/header` → 入内存。
   *
   * @throws SessionError `io`：目标文件已存在（绝不追加，否则会混写两个会话）或 IO 失败
   */
  async create(opts: SessionInit): Promise<Session> {
    const id = this.#idFactory()
    const file = this.#fileOf(id)
    // 碰撞检测：同秒 + 随机段撞上，或目录是外部残留——追加进去会把两个会话写到一起
    if (await this.#exists(file)) {
      throw new SessionError(`session file '${file}' already exists`, { kind: 'io', file })
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
    } catch (err) {
      throw new SessionError(`failed to create session directory for '${id}': ${errMsg(err)}`, {
        kind: 'io',
        file,
        cause: err,
      })
    }
    const meta: SessionMeta = {
      id,
      createdAt: new Date().toISOString(),
      provider: opts.provider,
      model: opts.model,
      cwd: opts.cwd,
    }
    const header: SessionEvent = { type: 'session/header', ...meta }
    await this.#write(file, header)
    this.#sessions.set(id, { meta, file, events: [header], listeners: new Set() })
    return { id, meta }
  }

  /**
   * 打开既有会话（resume）。已打开的走内存缓存，未打开的从磁盘全量载入。
   *
   * @throws SessionError `not_found`（id 不存在）/ `corrupt`（结构损坏）/ `io`
   */
  async open(id: string): Promise<Session> {
    const entry = this.#sessions.get(id) ?? (await this.#loadEntry(id))
    return { id, meta: entry.meta }
  }

  /**
   * 列出全部会话元信息，按 `createdAt` 降序（最新在前；同值按 id 降序保证稳定）。
   *
   * 只解析每个文件的首行（设计 D7）；单个会话损坏只跳过它并告警，不影响其余。
   */
  async list(): Promise<SessionMeta[]> {
    let ids: string[]
    try {
      ids = await fs.readdir(this.#root)
    } catch (err) {
      // 根目录不存在 = 还没有任何会话，属正常（与 01 对 ENOENT 的处理同义）
      if (errnoOf(err) === 'ENOENT') return []
      throw new SessionError(`failed to list sessions in '${this.#root}': ${errMsg(err)}`, {
        kind: 'io',
        file: this.#root,
        cause: err,
      })
    }

    const metas: SessionMeta[] = []
    for (const id of ids) {
      const file = path.join(this.#root, id, SESSION_FILE)
      try {
        const first = parseLine(await readFirstLine(file))
        if (first?.type === 'session/header') {
          metas.push({
            id: first.id,
            createdAt: first.createdAt,
            provider: first.provider,
            model: first.model,
            cwd: first.cwd,
          })
        } else {
          this.#warn(`skipping session '${id}': first line is not a session/header`)
        }
      } catch (err) {
        this.#warn(`skipping session '${id}': ${errMsg(err)}`)
      }
    }
    metas.sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : -1))
    return metas
  }

  /**
   * 取回一个会话的全量事件序列（契约 0.1.5 新增）。
   *
   * @returns 浅拷贝数组——调用方增删元素不影响内部序列（事件对象本身不深拷贝，
   *          调用方不应改写；03 不做防御性冻结，与"零策略内核"一致）
   * @throws SessionError `not_found` / `corrupt` / `io`
   */
  async read(id: string): Promise<SessionEvent[]> {
    const entry = this.#sessions.get(id) ?? (await this.#loadEntry(id))
    return [...entry.events]
  }

  /* ---------------- 契约面：append / subscribe ---------------- */

  /**
   * 追加一个事件：落盘 → 入内存 → 派发订阅者 → 回调插件（接 `session/append` 广播）。
   *
   * @throws SessionError `not_found`（未知 id 且磁盘上也没有）/ `io`（写入失败）
   */
  async append(sessionId: string, event: SessionEvent): Promise<void> {
    const entry = this.#sessions.get(sessionId) ?? (await this.#loadEntry(sessionId))
    const written = this.#chain.then(() => this.#write(entry.file, event))
    // 写链不被单次失败打断（后续 append 照常排队），但本次失败要如实回给调用方
    this.#chain = written.then(
      () => undefined,
      () => undefined,
    )
    await written
    entry.events.push(event)
    this.#dispatch(entry, event)
    this.#onAppend?.(sessionId, event)
  }

  /**
   * 订阅一个会话的后续事件；返回退订句柄（幂等）。
   *
   * @throws SessionError `not_found`：会话未打开（设计 D9——订阅必须在
   *   `create`/`open` 之后，静默永不触发的订阅是难排查的 bug 源）
   */
  subscribe(sessionId: string, fn: SessionListener): Unsubscribe {
    const entry = this.#sessions.get(sessionId)
    if (!entry) throw new SessionError(`session '${sessionId}' not found`, { kind: 'not_found' })
    entry.listeners.add(fn)
    return () => {
      entry.listeners.delete(fn)
    }
  }

  /* ---------------- 持有者面（不经 ctx.sessions 暴露） ---------------- */

  /** 等待全部在途写入落盘（`append` 均已 await，正常路径无需调用；退出/测试用）。 */
  async settled(): Promise<void> {
    await this.#chain
  }

  /** 清空内存缓存与订阅；**不删文件**。 */
  clear(): void {
    this.#sessions.clear()
  }

  /* ---------------- 内部 ---------------- */

  #fileOf(id: string): string {
    return path.join(this.#root, id, SESSION_FILE)
  }

  async #exists(file: string): Promise<boolean> {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }

  /** 追加一行并统一映射 IO 错误为 `SessionError{kind:'io'}`。 */
  async #write(file: string, event: SessionEvent): Promise<void> {
    try {
      await appendLine(file, event)
    } catch (err) {
      throw new SessionError(`failed to append to '${file}': ${errMsg(err)}`, {
        kind: 'io',
        file,
        cause: err,
      })
    }
  }

  /**
   * 从磁盘载入一个会话并缓存（**single-flight**）。
   *
   * 为什么必须共享 in-flight Promise：冷缓存上的并发 `append`（06 并行工具结果的
   * `Promise.all(append(...))`）若各自读盘、各自 `#sessions.set`，后写入者覆盖前者
   * ——先完成的 append 把事件 push 进被抛弃的 entry，**事件在磁盘上却永久丢失于
   * 内存缓存**，`read()` 从此与 log 分叉（违反秩序约定 4）。共享载入后并发调用方
   * 拿到同一 entry，push 落在同一数组上；载入失败时从备忘录移除，重试重新读盘
   * （不缓存 rejection，`not_found` 的会话稍后 `create` 不受影响）。
   *
   * @throws SessionError `not_found`（ENOENT）/ `io`（其它 fs 错误）/ `corrupt`（结构损坏）
   */
  #loadEntry(id: string): Promise<SessionEntry> {
    const inFlight = this.#loading.get(id)
    if (inFlight) return inFlight
    const loading = this.#doLoadEntry(id).finally(() => {
      // 成败都移除：成功后 #sessions 已有缓存；失败后重试须重新读盘
      this.#loading.delete(id)
    })
    this.#loading.set(id, loading)
    return loading
  }

  /**
   * 载入体：真正执行读盘、结构校验与缓存写入（只经 `#loadEntry` 调用）。
   *
   * @throws SessionError `not_found`（ENOENT）/ `io`（其它 fs 错误）/ `corrupt`（结构损坏）
   */
  async #doLoadEntry(id: string): Promise<SessionEntry> {
    const file = this.#fileOf(id)
    let events: SessionEvent[]
    try {
      events = await this.#readAll(file)
    } catch (err) {
      if (err instanceof SessionError) throw err
      if (errnoOf(err) === 'ENOENT') {
        throw new SessionError(`session '${id}' not found`, { kind: 'not_found', file })
      }
      throw new SessionError(`failed to read session '${id}': ${errMsg(err)}`, {
        kind: 'io',
        file,
        cause: err,
      })
    }
    const header = events[0]
    // #readAll 已保证首个有效事件是 header；此处再判一次只为类型收窄
    if (!header || header.type !== 'session/header') {
      throw new SessionError(`session file '${file}' has no session/header`, { kind: 'corrupt', file })
    }
    const entry: SessionEntry = {
      meta: {
        id: header.id,
        createdAt: header.createdAt,
        provider: header.provider,
        model: header.model,
        cwd: header.cwd,
      },
      file,
      events,
      listeners: new Set(),
    }
    this.#sessions.set(id, entry)
    return entry
  }

  /**
   * 读取并解析整个 JSONL 文件。
   *
   * 坏行（崩溃留下的半行 JSON、结构不合法的行）**跳过并告警，不抛**——一次崩溃
   * 不该让整个会话永久不可用（设计 §8-Q6）。只有"没有任何有效事件"或"首个有效
   * 事件不是 header"这类**结构性**损坏才抛 `corrupt`。
   */
  async #readAll(file: string): Promise<SessionEvent[]> {
    const text = await readText(file)
    const events: SessionEvent[] = []
    let sawHeader = false
    for (const line of splitLines(text)) {
      const event = parseLine(line)
      if (!event) {
        this.#warn(`skipping unparsable line in '${file}'`)
        continue
      }
      if (!sawHeader) {
        if (event.type !== 'session/header') {
          throw new SessionError(`session file '${file}' does not start with a session/header event`, {
            kind: 'corrupt',
            file,
          })
        }
        sawHeader = true
      }
      events.push(event)
    }
    if (!sawHeader) {
      throw new SessionError(`session file '${file}' has no valid event`, { kind: 'corrupt', file })
    }
    return events
  }

  /** 逐个派发订阅者；单个抛错只告警，不影响其余监听器与 append 本身。 */
  #dispatch(entry: SessionEntry, event: SessionEvent): void {
    // 复制一份再遍历：监听器内部退订/新订不会破坏本次遍历
    for (const fn of [...entry.listeners]) {
      try {
        fn(event)
      } catch (err) {
        this.#onError?.(`session listener of '${entry.meta.id}' threw`, err)
      }
    }
  }

  #warn(message: string): void {
    this.#onWarn?.(message)
  }
}

/**
 * 构造 JSONL 会话存储（03 的真实实现，供 `builtin:session` 插件在 setup 内 mount）。
 *
 * @param options.dir sessions 根目录；缺省 `~/.minidsh/sessions`（架构 §7）
 * @param options.onAppend 事件落盘后的回调（插件接 `ctx.events.emit('session/append')`）
 * @param options.onWarn 非致命诊断（插件接 `ctx.log.warn`）
 * @param options.onError 订阅者抛错（插件接 `ctx.log.error`）
 * @param options.idFactory id 生成（测试注入固定 id 用）
 */
export function createJsonlSessionStore(options?: SessionStoreOptions): JsonlSessionStore {
  return new JsonlSessionStoreImpl(options)
}
