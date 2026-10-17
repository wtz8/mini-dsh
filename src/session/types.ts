import type { SessionEvent, SessionMeta, SessionStore } from '../contracts.js'

/**
 * 模块内类型（03 设计 §3）。
 *
 * 契约类型（`Session` / `SessionMeta` / `SessionEvent` / `SessionStore`）一律从
 * `contracts.ts` 取，本文件只放 03 自己的选项与内部结构。
 */

/** 会话文件名（架构 §7：`~/.minidsh/sessions/<id>/session.jsonl`）。 */
export const SESSION_FILE = 'session.jsonl'

/** 事件订阅回调：收到一个已落盘的事件（同步派发）。 */
export type SessionListener = (event: SessionEvent) => void

/**
 * 会话存储构造选项（03 设计 §2.1）。
 *
 * store **不持有 ctx**——诊断与广播一律以回调注入（D3），使 store 可脱离组合根单测。
 */
export interface SessionStoreOptions {
  /** sessions 根目录；缺省 `~/.minidsh/sessions`（架构 §7） */
  dir?: string
  /** 事件落盘**之后**的回调——插件侧接 `ctx.events.emit('session/append', …)` */
  onAppend?: (sessionId: string, event: SessionEvent) => void
  /** 非致命诊断（坏行跳过、list 跳过损坏会话）；插件侧接 `ctx.log.warn` */
  onWarn?: (message: string) => void
  /** 订阅者抛错；插件侧接 `ctx.log.error`（与 EventBus 的"emit 永不抛"同义） */
  onError?: (message: string, err: unknown) => void
  /** id 生成（测试注入固定 id 用）；缺省 `createSessionId()` */
  idFactory?: () => string
}

/** 插件实例级配置（`plugins[].config`，插件自行 narrow）。 */
export interface SessionPluginConfig {
  /** sessions 根目录；相对路径按 cwd 解析。缺省 `~/.minidsh/sessions` */
  dir?: string
}

/** 插件构造选项（宿主侧注入，生产不传）。 */
export interface SessionPluginOptions {
  /** 覆盖 sessions 根目录（测试注入 tmp 目录用） */
  dir?: string
}

/** 内存中的会话条目（`create` / `open` 后常驻，直到 `clear()`）。 */
export interface SessionEntry {
  meta: SessionMeta
  /** `<dir>/<id>/session.jsonl` */
  file: string
  /** 全量事件序列（按写入顺序；mini 版规模可控，见设计 §5 已知限制） */
  events: SessionEvent[]
  listeners: Set<SessionListener>
}

/**
 * JSONL 会话存储（03 的真实实现）。
 *
 * 结构上是 `SessionStore` 的子类型，多出的两个方法只给**持有者**（插件 / 测试）用：
 * 经 `ctx.sessions` 拿到的仍是契约面 `SessionStoreContainer`（静态类型不含它们）。
 */
export interface JsonlSessionStore extends SessionStore {
  /** 等待全部在途写入落盘（退出前 flush；`append` 均已 await，正常路径无需调用） */
  settled(): Promise<void>
  /** 清空内存缓存与订阅；**不删文件**（dispose 时调用） */
  clear(): void
}
