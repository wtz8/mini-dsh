import type {
  ChatMessage,
  Plugin,
  PluginFactory,
  TokenUsage,
  ToolErrorCode,
  ToolInvocation,
  Unsubscribe,
} from '../../src/index.js'

/**
 * 10-web-ui 的对外类型。
 *
 * 跨模块词汇（`ToolInvocation` / `ChatMessage` / `Plugin` …）一律在 `src/contracts.ts`，
 * 本文件只放本模块自己新增的形状：插件选项、审批记录、推给浏览器的事件帧、状态快照。
 */

/** builtin 名提示：`config.plugins[].source` 写作 `builtin:web`（需宿主先注册）。 */
export const WEB_PLUGIN_NAME = 'web'

/** web 插件在 builtin 表里的 source 写法（`builtin:web`）。 */
export const BUILTIN_WEB_SOURCE = 'builtin:web'

/** boot 超时上限：与 07 的 `BOOT_TIMEOUT_MS` 同量级，防某个 setup 挂起。 */
export const WEB_BOOT_TIMEOUT_MS = 15_000

/** 插件卸载超时上限：与 07 的 `SHUTDOWN_TIMEOUT_MS` 同量级。 */
export const WEB_SHUTDOWN_TIMEOUT_MS = 5_000

/** 默认监听端口（与原版 dsh web 一致）。 */
export const DEFAULT_PORT = 3080

/** 默认监听地址：回环。非回环一律拒绝启动。 */
export const DEFAULT_HOST = '127.0.0.1'

/** 审批等待上限的默认值（与 05 的 `DEFAULT_APPROVAL_TIMEOUT_MS` 对齐）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/** SSE 心跳间隔的默认值：注释帧，用于穿透代理的空闲断连。 */
export const DEFAULT_HEARTBEAT_MS = 15_000

/** 单个请求体的字节上限（防误传大文件把内存撑爆）。 */
export const MAX_BODY_BYTES = 1_048_576

/** 工具结果推给 UI 时的展示截断长度（字符）；log 里仍是全量。 */
export const UI_RESULT_CHARS = 2000

/**
 * `createWebPlugin` 的构造选项。
 *
 * 这里的取值属**宿主档**（最高优先级）：CLI 若要暴露 `--web-port` 之类的开关，
 * 就把值传到这里，而不是改写 `config`。
 */
export interface WebPluginOptions {
  /** 监听端口，默认 `DEFAULT_PORT`（3080）；`0` 表示由系统分配 */
  port?: number
  /**
   * 监听地址，默认 `DEFAULT_HOST`（`127.0.0.1`）。
   *
   * **只接受回环地址**（`127.0.0.0/8` / `::1` / `localhost`），其余一律抛 Error
   * ——本模块的设计前提是"只在本机运行"，做成拒绝而非警告，与 01"死配置早暴露"、
   * 04"禁用段显式抛错"同一立场。
   */
  host?: string
  /** URL 前缀，默认 `'/'`；如设为 `'/mdsh'` 则全部路由挂在其下 */
  basePath?: string
  /** 审批等待上限（毫秒），默认 `DEFAULT_APPROVAL_TIMEOUT_MS` */
  approvalTimeoutMs?: number
  /** SSE 心跳间隔（毫秒），默认 `DEFAULT_HEARTBEAT_MS` */
  heartbeatMs?: number
  /** 监听成功回调；端口由系统分配时用它拿到真实端口 */
  onReady?(info: WebServerInfo): void
}

/** 服务就绪信息。 */
export interface WebServerInfo {
  port: number
  host: string
  /** 可直接点开的 URL（`http://<host>:<port><basePath>`） */
  url: string
}

/**
 * web 插件的实例级配置（`plugins[].config`）形态。
 *
 * 只放"用户愿意写进 JSON"的项；审批通道这类**可变对象**不能走这条路——
 * 组合根会对 `plugins[].config` 执行 `deepFreeze`（M0 §4.1），冻住的通道无法接收响应。
 */
export interface WebPluginConfig {
  port?: number
  host?: string
  basePath?: string
}

/**
 * web 插件：标准 `Plugin` 之外额外暴露只读运行时信息。
 *
 * 额外字段只给**宿主**诊断用（如打印启动横幅），不注册进 `ctx` 服务面——
 * 没有第二个插件需要消费 HTTP 服务，注册即污染（与 06 的 `AgentControlHandle` 同式取舍）。
 */
export interface WebPlugin extends Plugin {
  /** 实际监听端口；未启动或已关闭时 `undefined` */
  readonly port: number | undefined
  /** 当前待审批请求快照 */
  readonly pendingApprovals: ReadonlyArray<PendingApproval>
}

/** web 模块的工厂产物：插件工厂 + 要注入 agent-loop 的审批通道（D3）。 */
export interface WebPluginBundle {
  /** 注册进 builtin 表或写进 `config.plugins` 的插件工厂 */
  factory: PluginFactory
  /**
   * 交给 `createAgentPlugin({ approve })` 的审批通道。
   *
   * 宿主必须把它注入 agent-loop，否则所有 `ask` 策略的工具都会**失败关闭**
   * （05 的 PB-02 ②：无审批处理器 = 拒绝），界面上表现为"什么都写不了"。
   */
  approve: ApprovalHandler
}

/** 审批回调签名（与 05 的 `ApproveHandler` 同构，此处独立命名以免循环引用）。 */
export type ApprovalHandler = (invocation: Readonly<ToolInvocation>) => Promise<boolean> | boolean

/** 一条待审批请求（浏览器可见面）。 */
export interface PendingApproval {
  /**
   * 审批 id（`a1` / `a2` … 单调递增）。
   *
   * 刻意用序号而非随机串：审批是人机交互过程，序号便于 UI 排序、日志对照与口头沟通
   * （"第三个待审批"）。工具调用的 `callId` 是模型给的随机 id，两者分工不同。
   */
  id: string
  /** 工具名（与 `config.permissions` 匹配用的是同一个名字） */
  toolName: string
  /** 冻结后的参数快照（展示用副本；前端改动它不影响真正执行的对象） */
  args: Record<string, unknown>
  /** 请求时刻（`Date.now()`），供 UI 显示"已等待 N 秒" */
  createdAt: number
}

/**
 * 审批通道的变更通知（订阅者据此增量更新 UI）。
 *
 * - `add`：新请求挂起（广播 `approval` 帧）；
 * - `resolve`：一条审批被结算——**含 allow 真值**（浏览器/超时/通道关闭三路同源）；
 * - `close`：通道整体关闭（UI 据此清空全部卡片）。
 */
export type ApprovalChange =
  | { kind: 'add'; approval: PendingApproval }
  | { kind: 'resolve'; id: string; allow: boolean }
  | { kind: 'close' }

/**
 * 审批通道：05 的 `ApproveHandler` 与浏览器之间的双向桥。
 *
 * 生命周期与插件一致。`close()` 后全部挂起请求按**拒绝**放行（失败关闭，
 * 与 05 PB-02 ② 同立场），不降级为放行——拿不到人回复时，安全的默认是不动手。
 */
export interface ApprovalChannel {
  /** 作为 `ApproveHandler` 注入 05/06：挂起直到浏览器响应、超时或通道关闭 */
  ask(invocation: Readonly<ToolInvocation>): Promise<boolean>
  /** 待审批列表快照（按 id 序号升序；**深拷贝**，外部改动不影响内部） */
  pending(): ReadonlyArray<PendingApproval>
  /** 浏览器响应；id 不存在或已响应返回 `false`（防重复响应） */
  respond(id: string, allow: boolean): boolean
  /** 变更订阅（新增 / 结算 / 关闭） */
  subscribe(fn: (change: ApprovalChange) => void): Unsubscribe
  /** 关闭通道：全部挂起请求按拒绝放行，并通知订阅者 */
  close(): void
}

/** 推给浏览器的事件帧（SSE `data:` 载荷的解析产物）。 */
export type UiEvent =
  /** 连接建立时的握手帧：带会话与模型信息，供 UI 初始化头部 */
  | { type: 'hello'; sessionId: string; provider: string; model: string; cwd: string; tools: string[] }
  /** 回合开始 */
  | { type: 'turn-start'; turnNo: number }
  /** 助手文本增量（逐字） */
  | { type: 'text'; delta: string }
  /** 工具开始执行 */
  | { type: 'tool-start'; callId: string; name: string; args: string }
  /** 工具执行结束（含失败——错误是结果的一种） */
  | { type: 'tool-end'; callId: string; name: string; ok: boolean; text: string; code?: ToolErrorCode }
  /** 回合结束汇总 */
  | { type: 'turn-end'; turnNo: number; stepCount: number; usage: TokenUsage; interrupted: boolean }
  /** 新的待审批请求 */
  | { type: 'approval'; approval: PendingApproval }
  /** 审批已被响应（UI 据此移除卡片） */
  | { type: 'approval-resolved'; id: string; allow: boolean }
  /** 回合级错误（LLM / 会话），不终止服务 */
  | { type: 'error'; text: string }
  /** 内核日志镜像（受 `config.logLevel` 过滤） */
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; text: string }

/**
 * `GET /api/state` 的响应：前端据此**重建**视图。
 *
 * 前端不维护第二份对话状态（灵魂 #2）：刷新页面后靠本接口从
 * `ctx.sessions.read()` + `deriveMessages` 重建，内存里只在回合进行中缓存"正在打字的那一段"。
 */
export interface StateSnapshot {
  sessionId: string
  provider: string
  model: string
  cwd: string
  /** 由 session log 投影出的完整对话（含 tool 消息） */
  messages: ChatMessage[]
  /** 累计用量（log 中全部 `assistant/message.usage` 求和） */
  usage: TokenUsage
  /** 已完成的回合数（按 `turn/start` 计数） */
  turnCount: number
  /** 已注册工具名（升序） */
  tools: string[]
  /** 当前是否有回合在跑 */
  running: boolean
}
