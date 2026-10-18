import type { ToolCall, ToolDefinition, ToolInvocation, ToolResult } from '../contracts.js'

/**
 * 05-tools 的对外类型（经 `src/tools/index.ts` 与 `src/index.ts` 导出）。
 *
 * `ToolDefinition` / `ToolResult` 等跨模块词汇在 `contracts.ts`（骨架 §5.4），
 * 本文件只放 05 自己新增的、06 需要知道的那几个形状。
 */

/**
 * 审批回调：`ask` 策略下向宿主请求授权。
 *
 * 收到的是**改写全部完成、已冻结**的调用快照——即"将要执行的那一个"（设计 §4.2 / PB-02 ③）。
 * 返回值语义是**白名单**：只有 `true` 才放行；`false` / `undefined` / 抛错 / 超时一律当作拒绝
 * （失败关闭，绝不降级为 `auto`）。
 */
export type ApproveHandler = (invocation: Readonly<ToolInvocation>) => Promise<boolean> | boolean

/** 单次工具调用的运行上下文（06 每 step 组装一次，供本 step 的全部调用复用）。 */
export interface ToolRunContext {
  sessionId: string
  /** 回合号（写入 `ToolInvocation`，供监听器做策略判断） */
  turnNo: number
  /** 步号（同上） */
  stepNo: number
  /** 回合级取消信号（`AgentControl.cancel()`）；pipeline 会与 `ctx.signal` 合并后交给工具 */
  signal: AbortSignal
}

/** 工具执行器：guarded pipeline 的唯一入口。 */
export interface ToolRunner {
  /**
   * 执行一次工具调用。
   *
   * **永不抛错**：解析失败、未注册、参数非法、权限拒绝、超时、取消、执行异常
   * 都表现为 `ok:false` 的 `ToolResult`，并已 `append(tool/result)` 入会话日志
   * （架构 §5.4：错误是工具结果的一种，不是异常路径）。
   */
  run(call: ToolCall, context: ToolRunContext): Promise<ToolResult>
}

/** `createToolRunner` 的选项（全部可选；生产由 06 接线）。 */
export interface ToolRunnerOptions {
  /** `ask` 的审批通道；缺省 = 无审批处理器 ⇒ `ask` **失败关闭**（PB-02 ②） */
  approve?: ApproveHandler
  /** 审批等待上限（毫秒），默认 60_000；超时按拒绝处理 */
  approvalTimeoutMs?: number
  /** 结果文本硬上限（字符），默认 64_000；超出走中段截断（设计 §4.6） */
  maxResultChars?: number
  /**
   * 工具超时解析：返回毫秒数则该调用受限，返回 `undefined` 则只受取消信号约束
   * （架构 §5.4：只有声明了超时的工具才受限）。06 用
   * `createBashTimeoutResolver(ctx.config)` 组装，不必知道字段名。
   */
  timeoutFor?: (name: string, args: Record<string, unknown>) => number | undefined
}

/** `createToolsPlugin` 的构造选项（生产不传；测试注入裁剪集）。 */
export interface ToolsPluginOptions {
  /** 覆盖内置工具集（默认六个）；测试用裁剪/伪工具 */
  tools?: readonly ToolDefinition[]
  /** 禁用的内置工具名（与实例配置 `plugins[].config.disabled` 合并） */
  disabled?: readonly string[]
}

/** 审批等待上限的默认值：够人类反应，又不会让回合无限挂住。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/** 单条工具结果的默认字符上限（设计 §4.6 / Q9）。 */
export const DEFAULT_MAX_RESULT_CHARS = 64_000
