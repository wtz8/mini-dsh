import type {
  AgentControl,
  ChatMessage,
  Ctx,
  LlmAdapter,
  SessionEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolSchema,
} from '../contracts.js'
import type { ApproveHandler, ToolRunner } from '../tools/types.js'

/**
 * 06-agent 的对外类型（经 `src/agent/index.ts` 导出）。
 *
 * 跨模块词汇（`AgentControl` / `TurnSummary` / `StreamEvent` …）一律在 `contracts.ts`，
 * 本文件只放 06 自己新增的形状：插件选项、可注入依赖集、回合内中间态。
 */

/** builtin 名：`config.plugins[].source` 写作 `builtin:agent-loop`。 */
export const BUILTIN_AGENT = 'builtin:agent-loop'

/**
 * 单回合步数上限的默认值（设计 §8-Q4）。
 *
 * 32 步 ≈ 一次"读文件 → 改 → 跑测试 → 修"循环留足余量，又不会让失控的
 * 工具循环把 token 烧穿。走插件选项/实例配置可调，**不进 `Config`**（避免动骨架级词汇）。
 */
export const MAX_STEPS_PER_TURN = 32

/** transcript 中单条工具结果的截断长度（字符）。 */
export const TRANSCRIPT_ITEM_CHARS = 800

/** transcript 的总字符预算；超出时从最旧开始丢。 */
export const TRANSCRIPT_MAX_CHARS = 60_000

/**
 * 插件构造选项（生产由 07 传入）。
 *
 * 07 若要 resume，把会话 id 传进来；省略则由 06 在 setup 内新建。
 */
export interface AgentPluginOptions {
  /** 复用的会话 id（07 的 /resume）；省略 = setup 时新建会话 */
  sessionId?: string
  /** `ask` 策略的审批通道（05）；缺省 ⇒ 所有 `ask` 失败关闭（PB-02 ②） */
  approve?: ApproveHandler
  /** 单回合步数上限，默认 `MAX_STEPS_PER_TURN`（正整数） */
  maxStepsPerTurn?: number
}

/** 实例级配置（`plugins[].config`）形态：只暴露步数上限。 */
export type AgentPluginConfig = {
  maxStepsPerTurn?: number
}

/**
 * 回合循环的依赖集（插件装配，单测注入伪实现；设计 D3）。
 *
 * 与 03 的"store 与插件分离"、04 的"段与插件分离"同式：循环逻辑不直接读
 * `ctx.llm` / 不自己 new 任何东西，全部由插件接线层注入。
 */
export interface AgentDeps {
  ctx: Ctx
  sessionId: string
  /**
   * 惰性解析 adapter。
   *
   * **不在 setup 内解析**（02 D7）：provider 可能由排在 agent 之后的插件注册，
   * setup 期自检会把"尚未注册"误判为"配置错误"而启动失败。
   */
  resolveAdapter(): LlmAdapter
  /** 05 的 guarded pipeline（setup 内创建一次，每 step 复用） */
  runner: ToolRunner
  /** 单回合步数上限 */
  maxStepsPerTurn: number
}

/** 一次流式产出的聚合结果（内存态，不入 log）。 */
export interface CollectedStream {
  /** 拼接后的文本；取消时为"已送达前缀" */
  text: string
  /** 本次请求最终 usage（无 usage 事件时为零值） */
  usage: TokenUsage
  /** 02 的聚合器产物，按 index 升序 */
  calls: ToolCall[]
  /** 流被取消/中断（adapter 抛 `aborted`，或信号已 abort） */
  aborted: boolean
}

/** 当前回合的运行态（`createAgentControl` 闭包内持有）。 */
export interface TurnState {
  turnNo: number
  /** 回合级控制器；`cancel()` 即 abort 它 */
  controller: AbortController
  /** `AbortSignal.any([controller.signal, ctx.signal])`——回合级与进程级两条通道的合并 */
  signal: AbortSignal
  /** 用户是否已请求取消（决定 `TurnSummary.interrupted`） */
  cancelRequested: boolean
}

/**
 * `AgentControl` 的扩展句柄（插件私有面）。
 *
 * `AgentControl` 的基线签名只有 `run` / `cancel`（架构 §5.2），而插件的 `dispose`
 * 需要"中止在途回合并等其收尾"——该能力不上 `ctx.agent` 服务面（无第二方消费），
 * 由插件持有句柄调用（实现期偏离 X5）。
 */
export interface AgentControlHandle extends AgentControl {
  /** 中止在途回合并等待其收尾（dispose 用；无在途回合时立即返回） */
  abortAndWait(reason?: string): Promise<void>
}

/**
 * `compactSession` 的结果。
 *
 * `usage` 是**摘要请求自身的用量**（失败时是已送达的部分用量）——它是真实花销，
 * 必须计入 `TurnSummary.totalUsage`（设计 §8-Q8），否则用户看到的用量偏小。
 */
export interface CompactOutcome {
  /** 是否真的写入了 `compaction` 事件 */
  compacted: boolean
  /** 本次摘要请求的用量（无 usage 事件时为零值） */
  usage: TokenUsage
}

/** 压缩请求所需的最小上下文（`compactSession` 的入参）。 */
export interface CompactRequest {
  ctx: Ctx
  sessionId: string
  /** 惰性解析 adapter（与 `AgentDeps.resolveAdapter` 同源） */
  resolveAdapter(): LlmAdapter
  /** 当前会话的全量事件序列（压缩前读到的快照） */
  events: readonly SessionEvent[]
  /** 回合级合并信号 */
  signal: AbortSignal
}

/** `estimateRequestTokens` 的入参：一次请求里全部会被计 token 的部分。 */
export interface RequestTokensInput {
  system: string
  messages: readonly ChatMessage[]
  tools: readonly ToolSchema[]
}

/** 工具并发调度的入参（`scheduleToolCalls`）。 */
export interface ScheduleOptions {
  /** 并发上限（`config.tools.maxParallel`；01 已保证 ≥1，此处再兜底为 ≥1） */
  maxParallel: number
  /** 回合级合并信号；已 abort 时不再启动新调用 */
  signal: AbortSignal
}

/** 工具定义快照：每 step 从 `ctx.tools.list()` 建一次，避免 `get()` 抛错。 */
export type ToolDefIndex = ReadonlyMap<string, ToolDefinition>
