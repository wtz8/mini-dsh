import type {
  Ctx,
  ToolDefinition,
  ToolEnv,
  ToolErrorCode,
  ToolInvocation,
  ToolResult,
  ToolCall,
} from '../contracts.js'
import { ToolRejected } from '../errors.js'
import { resolvePermission } from '../config/permissions.js'
import { isPlainObject, validateArgs } from './schema.js'
import type { ToolRunContext, ToolRunner, ToolRunnerOptions } from './types.js'
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_MAX_RESULT_CHARS } from './types.js'

/**
 * guarded tool pipeline（架构灵魂 #3）。
 *
 * 顺序（设计 §4.1 / Q2）：**解析 → 查定义 → 校验 → `tools/pre-execute` 改写/否决 →
 * 复检 → 冻结快照 → 权限门 → 执行 → 截断 → `tools/post-execute` → 入 log**。
 *
 * 为什么权限门放在瀑布**之后**（与架构 §5.3 "CLI 权限监听器抛 `ToolRejected`" 的措辞
 * 不完全一样，属本轮澄清，见设计 D2）：
 * 瀑布可以替换 `name` / `args`。若先授权再允许改写，就会出现"检查 A、执行 B"
 * （PB-02 ③）。先把所有改写做完、冻结成不可变快照，再对**这一个**对象授权，
 * 才能保证"授权对象 === 执行对象"。瀑布内抛 `ToolRejected` 仍然有效（否决语义不变），
 * 只是内置权限门不再依赖监听器实现。
 *
 * 对外契约：`run` **永不抛错**——任何失败都是 `ok:false` 的 `ToolResult` 并已入 log。
 */

/** 参数解析结果。 */
type ParsedArgs = { ok: true; value: Record<string, unknown> } | { ok: false; message: string }

/** 执行尝试的结果（区分"工具失败"与"被超时/取消打断"）。 */
type ExecOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/** 审批结果：`undefined` = 放行，否则是直接返回给调用方的失败结果。 */
type ApprovalOutcome = ToolResult | undefined

/**
 * 构造工具执行器。
 *
 * @param ctx 组合根上下文（用到 `events` / `tools` / `sessions` / `config` / `log` / `signal`）
 * @param options 审批通道、超时与截断策略（生产由 06 接线）
 * @returns 执行器；同进程可构造多份（各带自己的策略，测试用）
 */
export function createToolRunner(ctx: Ctx, options: ToolRunnerOptions = {}): ToolRunner {
  const approve = options.approve
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  const timeoutFor = options.timeoutFor

  /** 构造一个失败结果（`content` 是模型可见文案，`code` 供机器判读）。 */
  function failure(callId: string, name: string, code: ToolErrorCode, message: string): ToolResult {
    return {
      callId,
      name,
      ok: false,
      content: `工具 ${name} 执行失败（${code}）：${message}`,
      error: { code, message },
    }
  }

  /** 查工具定义：`get` 未命中会抛，这里转成 `undefined`（错误码在调用点决定）。 */
  function findTool(name: string): ToolDefinition | undefined {
    try {
      return ctx.tools.get(name)
    } catch {
      return undefined
    }
  }

  /** 合并回合级与进程级取消信号（架构 §5.2：两条独立通道，工具两者都观察）。 */
  function combinedSignal(rc: ToolRunContext): AbortSignal {
    return AbortSignal.any([rc.signal, ctx.signal])
  }

  /** 解析 `call.arguments`（模型产出的原始 JSON 字符串）。 */
  function parseArguments(raw: unknown): ParsedArgs {
    if (typeof raw !== 'string') {
      return { ok: false, message: `arguments must be a JSON string, got ${typeof raw}` }
    }
    if (raw.trim() === '') {
      return { ok: false, message: 'arguments is empty; expected a JSON object (use "{}" for no arguments)' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return { ok: false, message: `arguments is not valid JSON: ${messageOf(err)}` }
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, message: 'arguments must be a JSON object' }
    }
    return { ok: true, value: parsed }
  }

  /** 审批：只有显式 `true` 放行；无处理器/超时/拒绝/抛错一律失败关闭（PB-02 ②）。 */
  async function requestApproval(inv: ToolInvocation, rc: ToolRunContext): Promise<ApprovalOutcome> {
    if (!approve) {
      return failure(
        inv.callId,
        inv.name,
        'permission_denied',
        '当前宿主未提供审批通道（permission: ask），已按失败关闭处理',
      )
    }
    const signal = combinedSignal(rc)
    if (signal.aborted) return failure(inv.callId, inv.name, 'cancelled', '回合已取消（等待审批之前）')

    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), approvalTimeoutMs)
    })
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = (): void => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const decided = Promise.resolve()
      .then(() => approve(inv))
      .then((value): 'approved' | 'denied' => (value === true ? 'approved' : 'denied'))
      .catch((err: unknown): 'denied' => {
        ctx.log.error(`tool approval handler failed for '${inv.name}'; treating as denial`, err)
        return 'denied'
      })

    try {
      const outcome = await Promise.race([decided, timeout, aborted])
      if (outcome === 'approved') return undefined
      if (outcome === 'timeout') {
        return failure(
          inv.callId,
          inv.name,
          'permission_denied',
          `审批超时（${approvalTimeoutMs}ms 未得到答复），已按失败关闭处理`,
        )
      }
      if (outcome === 'aborted') {
        return failure(inv.callId, inv.name, 'cancelled', '回合已取消（等待审批时）')
      }
      return failure(inv.callId, inv.name, 'permission_denied', '用户拒绝了该工具调用，未执行')
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  /** 带超时与取消的执行；超时后给工具 2s 收尸时间，但不无限等待。 */
  async function executeWithTimeout(
    def: ToolDefinition,
    args: Record<string, unknown>,
    env: ToolEnv,
    timeoutMs: number | undefined,
    controller: AbortController,
    signal: AbortSignal,
  ): Promise<ExecOutcome> {
    if (signal.aborted) return { kind: 'cancelled' }
    const running = Promise.resolve().then(() => def.execute(args, env))

    if (timeoutMs === undefined) {
      try {
        return { kind: 'ok', text: await running }
      } catch (err) {
        return signal.aborted ? { kind: 'cancelled' } : { kind: 'error', message: messageOf(err) }
      }
    }

    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const timeoutHit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error(`tool timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    try {
      return { kind: 'ok', text: await Promise.race([running, timeoutHit]) }
    } catch (err) {
      if (timedOut) {
        // 给子进程收尸的时间；工具若忽略 abort 也不能把这一回合挂死
        await Promise.race([running.catch(() => undefined), delay(2000)])
        return { kind: 'timeout' }
      }
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'error', message: messageOf(err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** ①–⑨：产出一个未经 post-execute 的结果。 */
  async function invoke(call: ToolCall, rc: ToolRunContext): Promise<ToolResult> {
    const parsed = parseArguments(call.arguments)
    if (!parsed.ok) return failure(call.id, call.name, 'invalid_args', parsed.message)

    if (typeof call.name !== 'string' || call.name.trim() === '') {
      return failure(call.id, call.name, 'execution_error', 'tool name is empty')
    }
    const def = findTool(call.name)
    if (!def) {
      return failure(call.id, call.name, 'execution_error', `unknown tool '${call.name}'（未注册或对应插件未挂载）`)
    }

    const checked = validateArgs(def.schema, parsed.value)
    if (!checked.ok) return failure(call.id, call.name, 'invalid_args', checked.message)

    const base: ToolInvocation = {
      callId: call.id,
      name: call.name,
      args: checked.value,
      sessionId: rc.sessionId,
      turnNo: rc.turnNo,
      stepNo: rc.stepNo,
    }

    let rewritten: ToolInvocation
    try {
      rewritten = await ctx.events.waterfall('tools/pre-execute', base)
    } catch (err) {
      if (err instanceof ToolRejected) {
        return failure(call.id, call.name, 'permission_denied', err.message)
      }
      return failure(
        call.id,
        call.name,
        'execution_error',
        `tools/pre-execute 监听器抛错：${messageOf(err)}`,
      )
    }

    const snapshot = takeSnapshot(call.id, rewritten, base)
    if (!snapshot) {
      return failure(call.id, call.name, 'execution_error', 'tools/pre-execute 返回了形状非法的 invocation')
    }

    // ⑤ 复检：改写后的 name/args 可能已经不合法（PB-02 ④：校验对象 === 执行对象）
    const finalDef = snapshot.name === def.name ? def : findTool(snapshot.name)
    if (!finalDef) {
      return failure(
        call.id,
        snapshot.name,
        'execution_error',
        `unknown tool '${snapshot.name}'（由 tools/pre-execute 改写后）`,
      )
    }
    const rechecked = validateArgs(finalDef.schema, snapshot.args)
    if (!rechecked.ok) {
      return failure(
        call.id,
        snapshot.name,
        'invalid_args',
        `tools/pre-execute 改写后校验失败：${rechecked.message}`,
      )
    }

    // ⑥ 冻结：从此不再接受任何改写（授权对象 === 执行对象）
    const frozen: ToolInvocation = Object.freeze({
      callId: call.id,
      name: snapshot.name,
      args: immutableArgs(rechecked.value),
      sessionId: snapshot.sessionId,
      turnNo: snapshot.turnNo,
      stepNo: snapshot.stepNo,
    })

    // ⑦ 权限门
    const action = resolvePermission(ctx.config.permissions, frozen.name)
    if (action === 'deny') {
      return failure(call.id, frozen.name, 'permission_denied', `权限策略为 deny（${frozen.name}），未执行`)
    }
    if (action === 'ask') {
      const outcome = await requestApproval(frozen, rc)
      if (outcome) return outcome
    }

    // ⑧ 执行（带超时与取消），tool/start / tool/end 只包住真正执行的那一段
    const controller = new AbortController()
    const signal = AbortSignal.any([combinedSignal(rc), controller.signal])
    const env: ToolEnv = { callId: call.id, sessionId: rc.sessionId, signal }
    const timeoutMs = timeoutFor?.(frozen.name, frozen.args)

    ctx.events.emit('tool/start', { sessionId: rc.sessionId, callId: call.id, name: frozen.name })
    let outcome: ExecOutcome
    try {
      outcome = await executeWithTimeout(finalDef, frozen.args, env, timeoutMs, controller, signal)
    } finally {
      ctx.events.emit('tool/end', { sessionId: rc.sessionId, callId: call.id, name: frozen.name })
    }

    switch (outcome.kind) {
      case 'ok': {
        const text = outcome.text === '' ? '（无输出）' : outcome.text
        return {
          callId: call.id,
          name: frozen.name,
          ok: true,
          content: truncate(text, maxResultChars),
        }
      }
      case 'timeout':
        return failure(call.id, frozen.name, 'timeout', `执行超过 ${timeoutMs ?? 0}ms 被终止`)
      case 'cancelled':
        return failure(call.id, frozen.name, 'cancelled', '回合已取消')
      case 'error':
        return failure(call.id, frozen.name, 'execution_error', outcome.message)
    }
  }

  /** ⑩ 后处理：插件可改写结果；**抛错保留原结果**（D5：副作用已发生，不能把事实换掉）。 */
  async function postProcess(result: ToolResult): Promise<ToolResult> {
    let out: ToolResult
    try {
      out = await ctx.events.waterfall('tools/post-execute', result)
    } catch (err) {
      ctx.log.error(`tools/post-execute 监听器抛错，保留原结果（${result.name}）`, err)
      return result
    }
    if (!isPlainObject(out) || typeof out.content !== 'string' || typeof out.ok !== 'boolean') {
      ctx.log.error(`tools/post-execute 返回了非法的 ToolResult，保留原结果（${result.name}）`)
      return result
    }
    // 身份由 pipeline 持有：插件只能改内容与状态，改 callId/name 会让日志配对错位
    const error = normalizeError(out.error) ?? (out.ok ? undefined : result.error)
    return {
      callId: result.callId,
      name: result.name,
      ok: out.ok,
      content: out.content,
      ...(error ? { error } : {}),
    }
  }

  /** ⑪ 入 log：失败也算结果（架构 §5.4）。append 失败只记日志，不改变返回值。 */
  async function appendResult(sessionId: string, callId: string, result: ToolResult): Promise<void> {
    try {
      await ctx.sessions.append(sessionId, { type: 'tool/result', toolCallId: callId, result })
    } catch (err) {
      ctx.log.error(`tool/result 写入会话失败（${result.name} / session ${sessionId}）`, err)
    }
  }

  return {
    async run(call: ToolCall, context: ToolRunContext): Promise<ToolResult> {
      let result: ToolResult
      try {
        result = await invoke(call, context)
      } catch (err) {
        // 兜底：pipeline 内部 bug 也不该把整条回合炸掉
        result = failure(call.id, call.name, 'execution_error', `pipeline internal error: ${messageOf(err)}`)
      }
      const processed = await postProcess(result)
      await appendResult(context.sessionId, call.id, processed)
      return processed
    },
  }
}

/**
 * 从瀑布返回值取快照：形状非法返回 `undefined`（由调用点转 `execution_error`）。
 *
 * **身份字段由 pipeline 持有**：`callId` / `sessionId` / `turnNo` / `stepNo` 一律取
 * 调用方给的值，监听器只能改写 `name` 与 `args`。理由：`callId` 改了会让
 * `tool/result` 与 `assistant.toolCalls` 配不上；`sessionId` 改了会让 `ToolEnv`
 * 与日志落在两个会话上——两者都是"改写"不该拥有的能力。
 */
function takeSnapshot(callId: string, payload: ToolInvocation, base: ToolInvocation): ToolInvocation | undefined {
  if (!isPlainObject(payload)) return undefined
  const { name, args } = payload
  if (typeof name !== 'string' || name.trim() === '') return undefined
  if (!isPlainObject(args)) return undefined
  return {
    callId,
    name,
    args,
    sessionId: base.sessionId,
    turnNo: base.turnNo,
    stepNo: base.stepNo,
  }
}

/** 深拷贝后深冻结：授权与执行看到的是同一个不可变对象，且不影响监听器自己的引用。 */
function immutableArgs(args: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown>
  try {
    copy = structuredClone(args)
  } catch {
    copy = { ...args } // 含不可克隆值（如函数）时退化为浅拷贝，仍然冻结顶层
  }
  return deepFreeze(copy)
}

/** 递归冻结（带环检测：JSON 不该有环，但外部插件可能塞进来）。 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen)
  }
  return value
}

/** 中段截断（设计 §4.6）：留头 60% / 尾 40%，砍掉中间。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const dropped = text.length - head - tail
  return `${text.slice(0, head)}\n\n…（已截断 ${dropped} 字符）…\n\n${text.slice(text.length - tail)}`
}

/** 后处理返回的 error 字段需要形状校验（插件可能传任意值）。 */
function normalizeError(value: unknown): NonNullable<ToolResult['error']> | undefined {
  if (!isPlainObject(value)) return undefined
  const code = value['code']
  const message = value['message']
  if (typeof code !== 'string' || typeof message !== 'string') return undefined
  return { code: code as NonNullable<ToolResult['error']>['code'], message }
}

/** 错误 → 单行文案（模型可见，不塞 stack）。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 可被 unref 的延时（收尸等待不该拖住进程退出）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
