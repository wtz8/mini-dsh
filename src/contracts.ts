/**
 * MiniDSH 骨架契约 —— 跨模块词汇的唯一出处。
 *
 * 本文件是 `docs/architecture.md` §5 的类型化落地，**纯类型模块，不含任何运行时值**
 * （运行时错误类见 `src/errors.ts`，内核实现见 `src/plugin/`）。
 * 改动本文件中与基线契约同名的签名 = 修改基线文档，须走 architecture.md §12 修订流程并重新 review。
 *
 * 后续模块（01–09）实现时不得改动本文件的既有签名；可在各自模块细化字段细节的，
 * 以注释标明归属模块。
 */

/* ============================================================
 * 基础词汇
 * ============================================================ */

/**
 * 通用退订句柄：调用后取消对应订阅（事件监听、会话订阅等）。
 * 重复调用为安全无操作（幂等）；**旧句柄不会影响其后新建的订阅**
 * （每次注册有独立身份，退订只撤销自己那一条）。
 */
export type Unsubscribe = () => void

/* ============================================================
 * LLM 词汇（adapter 接口归 02 实现）
 * ============================================================ */

/**
 * 模型侧看到的完整工具调用。
 *
 * - `id`：模型产出的调用标识，与后续 `ToolResult.callId` 同值；
 * - `arguments`：**原始 JSON 字符串**（流式 delta 拼接产物），解析与校验由 05 的
 *   pipeline 负责，agent 层不解释。
 */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * 流式过程中的工具调用增量片段（OpenAI 兼容分片风格）。
 * 按 `index` 归属到同一调用，`id` / `name` 只在首个分片出现。
 */
export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

/** token 用量；`totalTokens` 可选（provider 不给就不填）。 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

/**
 * 模型可见的工具投影：由 05 从 `ToolDefinition` 生成，非独立定义。
 * 这是发给模型的 `tools` 数组元素形态。
 */
export interface ToolSchema {
  name: string
  description: string
  schema: JsonSchema
}

/** 对话消息（LLM 请求的 messages 元素；03 的投影产物）。 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  /** content 为序列化的工具结果/错误文本 */
  | { role: 'tool'; toolCallId: string; content: string }

/** 单次 LLM 请求。`system` 由 prompt sections 现场拼装，不入 session log。 */
export interface LLMRequest {
  /** 现场拼装的系统提示（prompt sections 的 render 产物），不入 session log */
  system?: string
  messages: ChatMessage[]
  model: string
  /** 模型可见面：由 05 从已注册 ToolDefinition 投影，非独立定义 */
  tools: ToolSchema[]
  maxTokens?: number
  signal: AbortSignal
}

/** adapter 产出的流事件（模型输出增量）。 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; delta: ToolCallDelta }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'end' }

/**
 * LLM adapter 接口（02 的 `builtin:llm` 实现面）。
 * provider 是可替换接口（架构灵魂 #4），DeepSeek 只是默认实现。
 */
export interface LlmAdapter {
  /** 发起流式补全请求；`req.signal` 触发时迭代器应尽快终止。 */
  stream(req: LLMRequest): AsyncIterable<StreamEvent>
}

/**
 * adapter 工厂：接收 model 配置构造 adapter。
 * `baseUrl` / `apiKeyEnv` 归 01 的 `ModelConfig`，工厂从 `config.model` 注入
 * 是唯一不引入新全局态的路径（设计 D3 决议）。
 */
export type LlmAdapterFactory = (model: ModelConfig) => LlmAdapter

/* ============================================================
 * 工具词汇（pipeline 归 05 实现；因同时被 04/06 消费而放骨架层）
 * ============================================================ */

/**
 * 参数 JSON Schema 最小子集；校验器手写（零依赖），不支持 `$ref` 与组合关键字。
 */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** 工具执行环境（pipeline 组装后传入）。 */
export interface ToolEnv {
  callId: string
  sessionId: string
  signal: AbortSignal
}

/**
 * 工具定义（05 的注册单元）。
 *
 * - `name`：权限策略按此名匹配（`config.permissions`，匹配规则见架构 §5.4：精确键 > 前缀通配 > 兜底 ask）；
 * - `concurrency`：默认 `'parallel'`——可与本 step 内其他 parallel 工具并发，受
 *   `config.tools.maxParallel` 限制；`'exclusive'` 为独占屏障：等待在途调用全部结束后
 *   单独执行，执行期间不与任何工具并发；
 * - `execute`：只返回结果文本，`ToolResult` 由 pipeline 组装；抛错由 pipeline 转为失败结果。
 */
export interface ToolDefinition {
  name: string
  description: string
  schema: JsonSchema
  concurrency?: 'parallel' | 'exclusive'
  execute(args: Record<string, unknown>, env: ToolEnv): Promise<string>
}

/** 一次工具调用请求（pre-execute 瀑布事件的载荷形态）。 */
export interface ToolInvocation {
  callId: string
  name: string
  args: Record<string, unknown>
  sessionId: string
  turnNo: number
  stepNo: number
}

/** 工具错误码（guarded pipeline 的产出分支，架构灵魂 #3）。 */
export type ToolErrorCode =
  | 'invalid_args'
  | 'permission_denied'
  | 'execution_error'
  | 'timeout'
  | 'cancelled'

/**
 * 工具执行结果：**错误是工具结果的一种，不是异常路径**——任何分支都产出 ToolResult
 * 并 `append(tool/result)`，不向上抛（架构 §5.4）。
 */
export interface ToolResult {
  callId: string
  name: string
  ok: boolean
  /** 序列化结果或错误文本，同时入 log 与回模型 */
  content: string
  error?: { code: ToolErrorCode; message: string }
}

/* ============================================================
 * 权限词汇（解析归 01，匹配归 05）
 * ============================================================ */

/**
 * 权限策略三值（R1 决议）：
 * - `auto`：直接执行；
 * - `ask`：询问用户；
 * - `deny`：静默拒绝——05 的 pipeline 直接产出 `permission_denied` 结果，
 *   **不询问用户**（与 ask 的本质区别；CLI 不为 deny 发起权限询问）。
 */
export type PermissionAction = 'auto' | 'ask' | 'deny'

/* ============================================================
 * Prompt 词汇（04 实现）
 * ============================================================ */

/**
 * prompt section：系统提示的组成片段。
 * `render` 同步返回文本；`order` 小者在前，同 order 按 section id 字典序。
 */
export interface PromptSection {
  id: string
  order: number
  render(): string
}

/* ============================================================
 * 会话词汇（字段细节归 03；枚举 M0 定）
 * ============================================================ */

/**
 * append-only 会话日志事件；投影语义（`deriveMessages`）归 03。
 * 变体集合对 03 封闭——新增事件类型视同修改基线（架构 §5.4 事件表），须重新 review。
 */
export type SessionEvent =
  | { type: 'session/header'; id: string; createdAt: string; provider: string; model: string; cwd: string }
  | { type: 'turn/start'; turnNo: number }
  | { type: 'turn/end'; turnNo: number }
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string; toolCalls?: ToolCall[]; usage: TokenUsage; interrupted?: boolean }
  | { type: 'tool/result'; toolCallId: string; result: ToolResult }
  /** 压缩边界事件：投影时替换 boundary（turnNo）之前的历史 */
  | { type: 'compaction'; summary: string; boundary: number }

/** 会话元信息（`session/header` 事件的投影形态）。 */
export interface SessionMeta {
  id: string
  createdAt: string
  provider: string
  model: string
  cwd: string
}

/** 已打开的会话句柄（字段细节归 03）。 */
export interface Session {
  id: string
  meta: SessionMeta
}

/** 创建会话的入参。 */
export interface SessionInit {
  provider: string
  model: string
  cwd: string
}

/* ============================================================
 * 回合词汇（06 实现）
 * ============================================================ */

/** 用户输入；mini 版仅文本。 */
export interface UserInput {
  text: string
}

/** 一个回合的汇总（`AgentControl.run` 的返回值）。 */
export interface TurnSummary {
  turnNo: number
  stepCount: number
  totalUsage: TokenUsage
  interrupted: boolean
}

/* ============================================================
 * 事件总线（静态类型表；新增行 = 改基线文档）
 * ============================================================ */

/**
 * 通知事件载荷表（fire-and-forget，同步派发）。
 * 两张表有意封闭（设计 D4）：扩展点收敛为注册服务面与监听既有事件，
 * 换取静态可检查的载荷类型。
 *
 * `stream/chunk` 的 delta 即 adapter 产出的流事件本体（`StreamEvent`），
 * 06 决定对其中哪些子类型派发本事件，本表只定载荷类型。
 */
export interface NotificationMap {
  'plugin/mounted': { name: string }
  'session/append': { sessionId: string; event: SessionEvent }
  'turn/start': { sessionId: string; turnNo: number }
  'turn/end': { sessionId: string; turnNo: number }
  'step/start': { sessionId: string; turnNo: number; stepNo: number }
  'step/end': { sessionId: string; turnNo: number; stepNo: number }
  'stream/chunk': { sessionId: string; delta: StreamEvent }
  'tool/start': { sessionId: string; callId: string; name: string }
  'tool/end': { sessionId: string; callId: string; name: string }
}

/** 瀑布事件载荷表（串行 await，监听器可替换载荷、可否决）。 */
export interface WaterfallMap {
  'llm/request': LLMRequest
  'tools/pre-execute': ToolInvocation
  'tools/post-execute': ToolResult
}

/**
 * 事件总线（架构 §5.3）。
 *
 * - 通知事件：`emit` 同步派发，单个监听器抛错被捕获并记 `log.error`，
 *   **`emit` 本身永不抛错**，其余监听器与主流程不受影响；
 * - 瀑布事件：按注册序串行 `await`；监听器返回同构对象则替换载荷继续，
 *   返回 `undefined` 保持原载荷；抛错即否决，错误上抛给 `waterfall` 调用方。
 */
export interface EventBus {
  /** 注册通知监听器，返回退订句柄。 */
  on<K extends keyof NotificationMap>(type: K, fn: (p: NotificationMap[K]) => void): Unsubscribe
  /** 同步派发通知事件；单个监听器抛错只记 log，不影响其余监听器。 */
  emit<K extends keyof NotificationMap>(type: K, payload: NotificationMap[K]): void
  /** 注册瀑布监听器，返回退订句柄。 */
  onWaterfall<K extends keyof WaterfallMap>(
    type: K,
    fn: (p: WaterfallMap[K]) => WaterfallMap[K] | void | Promise<WaterfallMap[K] | void>,
  ): Unsubscribe
  /** 串行派发瀑布事件，返回最终载荷（可能被监听器替换）；监听器抛错则否决上抛。 */
  waterfall<K extends keyof WaterfallMap>(type: K, payload: WaterfallMap[K]): Promise<WaterfallMap[K]>
}

/* ============================================================
 * Ctx 服务面（容器最小实现在 src/plugin/containers.ts）
 * ============================================================ */

/** LLM adapter 注册表（02 的 `builtin:llm` 经 `register` 填充）。 */
export interface LlmRegistry {
  /** 注册 adapter 工厂；同名重复注册抛错（转 BootError）。 */
  register(name: string, factory: LlmAdapterFactory): void
  /** 按名解析工厂；未注册时抛 `'not mounted'`。resolve 的 name 即 provider 名。 */
  resolve(name: string): LlmAdapterFactory
}

/** 工具注册表（05 的 `builtin:tools` 经 `register` 填充）。 */
export interface ToolRegistry {
  /** 注册工具定义；同名重复注册抛错（转 BootError）。 */
  register(def: ToolDefinition): void
  /** 已注册工具的只读快照（M0 返回内部数组的浅拷贝）。 */
  list(): ReadonlyArray<ToolDefinition>
  /** 按名取工具定义；未注册时抛 `'not mounted'`。 */
  get(name: string): ToolDefinition
}

/** prompt section 注册表（04 的 `builtin:prompt` 经 `section` 填充）。 */
export interface PromptRegistry {
  /** 注册 prompt section；同 id 重复注册抛错（转 BootError）。 */
  section(s: PromptSection): void
  /**
   * 按 order 升序、同 order 按 id 字典序拼装全部 section，分隔符 `\n\n`。系统提示唯一出口。
   * 每次调用都重新排序（O(n log n)）：架构 §6 中每 step 调一次是预期用法，
   * 调用方勿在热循环内高频调用。
   */
  render(): string
}

/** 会话存储（03 的 `builtin:session` 提供；M0 内核交付委托式容器）。 */
export interface SessionStore {
  create(opts: SessionInit): Promise<Session>
  /** resume：按 id 打开既有会话；不存在的行为归 03 定义（03 决议：抛 `SessionError{kind:'not_found'}`）。 */
  open(id: string): Promise<Session>
  list(): Promise<SessionMeta[]>
  /**
   * 取回一个会话的**全量事件序列**（按写入顺序；03 决议返回快照，调用方改动不影响内部）。
   *
   * 这是"模型可见事实只来自 log 投影"（灵魂 #2）的输入口：06 每 step 调 `read` +
   * `deriveMessages` 拼出 `LLMRequest.messages`，不得在内存里另存一份对话状态。
   *
   * @throws 会话不存在（03 决议：抛 `SessionError{kind:'not_found'}`）
   */
  read(id: string): Promise<SessionEvent[]>
  append(sessionId: string, event: SessionEvent): Promise<void>
  subscribe(sessionId: string, fn: (e: SessionEvent) => void): Unsubscribe
}

/**
 * `SessionStore` 的容器形态（设计 D1/D5）：
 * 内核在 boot 时创建此容器作为 `Ctx.sessions` 的最终实现，03 的
 * `builtin:session` 插件在 setup 时经 `mount(impl)` 一次性注入真实实现。
 *
 * - 未 mount 前所有 `SessionStore` 方法抛 `'not mounted'`；
 * - `mount` 第二次调用抛错（一次性注入通道）。
 *
 * `Ctx.sessions` 的声明类型即本接口（`SessionStore` 的子类型，不违反骨架 §5.2 签名）。
 */
export interface SessionStoreContainer extends SessionStore {
  /** 一次性注入真实实现；第二次调用抛错。 */
  mount(impl: SessionStore): void
}

/** agent 控制面（06 的 `builtin:agent-loop` 注册）。 */
export interface AgentControl {
  /** 运行一个回合，返回回合汇总。 */
  run(input: UserInput): Promise<TurnSummary>
  /** 取消当前回合（与 `ctx.signal` 的进程级取消是两条独立通道，见架构 §5.2）。 */
  cancel(reason?: string): void
}

/** agent 注册表（06 的 `builtin:agent-loop` 经 `register` 填充）。 */
export interface AgentRegistry {
  /** 注册 agent 控制面；重复注册抛错（转 BootError）。 */
  register(ctl: AgentControl): void
  /** 取控制面；未注册时抛 `'not mounted'`。 */
  resolve(): AgentControl
}

/**
 * 日志器（M0 内核直接交付最终实现）。
 * 四方法（R2 决议：不加 `child(prefix)` 之类，不预扩）；前缀需求由调用方自行拼进消息。
 */
export interface Logger {
  debug(msg: string, ...meta: unknown[]): void
  info(msg: string, ...meta: unknown[]): void
  warn(msg: string, ...meta: unknown[]): void
  error(msg: string, ...meta: unknown[]): void
}

/* ============================================================
 * 配置（加载/合并/默认值归 01；M0 冒烟测试用硬编码最小 config）
 * ============================================================ */

/** 模型配置：provider 名 + 模型名 + 接入面；API key 一律走环境变量，不落盘。 */
export interface ModelConfig {
  provider: string
  name: string
  baseUrl: string
  apiKeyEnv: string
}

/** 插件表项：`source` 为 `builtin:<name>` 或相对 cwd 的本地路径。 */
export interface PluginEntry {
  source: string
  /** 实例级配置，组合根冻结后作为 `setup` 第二参注入；插件自行 narrow。 */
  config?: unknown
}

/**
 * 骨架级配置形状（校验/合并/默认值归 01）。
 * **字段增补规则**：后续模块可在不改变既有字段语义的前提下增补字段，但增补必须
 * 回写设计文档 §2.3——Config 是骨架级词汇，不归任何单一模块私有。
 * 整个 config（含 `plugins[].config`）经 `deepFreeze` 冻结后注入，插件不得修改。
 */
export interface Config {
  model: ModelConfig
  contextWindow: number
  tools: { maxParallel: number; bash: { shell: 'auto' | 'bash' | 'powershell'; timeoutMs: number } }
  compaction: { thresholdRatio: number; keepTurns: number }
  /** 匹配规则见架构 §5.4（精确键 > 前缀通配 > 兜底 ask），解析归 01。 */
  permissions: Record<string, PermissionAction>
  plugins: PluginEntry[]
  /** Logger 过滤级别（R4 决议），默认 `'info'`（默认值合并归 01）。 */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

/* ============================================================
 * 插件协议（架构 §5.1）
 * ============================================================ */

/**
 * 插件：MiniDSH 的一切能力（含 agent loop、LLM adapter）都以同一协议挂载。
 * 插件之间**不 import 彼此**，只经 `ctx` 服务面与事件交互。
 */
export interface Plugin {
  name: string
  /**
   * 挂载钩子：组合根按 `config.plugins` 数组顺序串行 `await` 调用。
   * `config` 为 `plugins[].config` 的实例级配置（组合根注入），无则 `undefined`；插件自行 narrow。
   * 抛错 = 启动失败（fail-fast，组合根清理已挂载插件后抛 BootError）。
   */
  setup(ctx: Ctx, config?: unknown): void | Promise<void>
  /**
   * 卸载钩子：进程退出（07 的退出流程）或 boot 失败清理时调用（逆序）。
   *
   * **必须容忍 setup 未完成**：boot 失败清理会 dispose "setup 中途抛错"的插件
   * （设计 §5 / X5），此时本插件的 setup 可能一行都没跑完。因此 dispose 内不得
   * 假设 setup 已经成功——对 setup 里才创建的资源一律用可选链
   * （`handle?.close()` 而非 `handle!.close()`）。
   *
   * 抛错只记 `log.error`，不影响其余插件的 dispose，也不掩盖正在上抛的 BootError。
   * 仅进程退出时调用；无热卸载（对照原版的砍点，见架构 §10）。
   *
   * **不设超时**：内核不中断挂起的 dispose（设计 §5），由 07 的退出流程自行兜底
   * （`Promise.race` + 强制退出），否则单个卡住的 dispose 会让 `shutdown` 永不返回。
   *
   * **不得等待 `ctx.signal` 的取消**：`shutdown` 在全部 dispose 返回之后才 abort，
   * 在 dispose 里等该信号会死锁。需要终止在途任务的插件应在 dispose 内自行 abort
   * 自己的 controller。
   */
  dispose?(): void | Promise<void>
}

/** 插件工厂：组合根经 `definePlugin` 或直接 default 导出获得。 */
export type PluginFactory = () => Plugin | Promise<Plugin>

/**
 * 插件容器：组合根 boot 时组装，readonly 引用恒定。
 * **每个服务面都是内核创建的容器对象，插件只往容器里注册实现，从不替换引用本身。**
 */
export interface Ctx {
  /** 冻结的最终配置（01 的 `loadConfig()` 加载合并，`boot()` 内 `deepFreeze` 冻结） */
  readonly config: Config
  /** 事件总线（§5.3） */
  readonly events: EventBus
  /** adapter 注册表（02 填充）：`register(name, factory)` / `resolve(name)` */
  readonly llm: LlmRegistry
  /** 工具注册表（05 填充）：`register(def)` / `list()` / `get(name)` */
  readonly tools: ToolRegistry
  /** prompt 注册表（04 填充）：`section(...)` / `render()` */
  readonly prompt: PromptRegistry
  /** 会话存储容器（03 经 `mount(impl)` 注入；声明类型为容器，见 D5） */
  readonly sessions: SessionStoreContainer
  /** agent 注册表（06 填充）：`register(ctl)` / `resolve()` */
  readonly agent: AgentRegistry
  /** 日志器（M0：level 过滤 + stderr） */
  readonly log: Logger
  /** 进程级取消信号，仅在进程退出流程触发；回合级取消走 `AgentControl.cancel()` */
  readonly signal: AbortSignal
}
