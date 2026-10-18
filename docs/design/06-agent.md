# 06-agent 设计

> 状态：**Baseline**（2026-10-18 所有者拍板 **Q1–Q13 全部按建议项通过**；2026-10-18 晚所有者 review 代码完成，评审期修复 **Y1–Y2** 已回写 §7，待提交归档）
> 预算：~2.0k 行（架构 §4；本次范围预计 ~1.5k，见 §7 预算说明）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §5 组合根与 dispose 约定、X5 半失败插件）、`01-config.md`（Baseline，重点 `Config.compaction` / `Config.tools.maxParallel` / `resolvePermission`）、`02-llm.md`（Baseline，重点 §2.2 `createToolCallAccumulator` 插件侧出口、D7"provider 自检归使用点"、`LlmError.kind`）、`03-session.md`（Baseline，重点 §4.4 `deriveMessages` 的配对与截断规则、`SessionError`）、`04-prompt.md`（Baseline，重点 §2.2 `PROMPT_ORDER`、`render()` 每步现拼）、`05-tools.md`（Baseline，**重点 §4.3 审批通道接线与 §8 附则"与 06 的职责边界"**）、`architecture.md` 0.1.5（§5.2 取消信号边界与 `AgentRegistry`/`AgentControl`、§5.3 瀑布、§5.4 事件表、§6 一个回合的数据流）

## 1. 背景与目标

06 是骨架的**驱动层**：把 02（adapter）、03（会话 log）、04（系统提示）、05（guarded pipeline）四块已就位的能力串成"一个回合"。它是唯一同时消费四个模块的模块，也是 `ctx.agent` 这个服务面的填充者。

对应骨架契约（均已 Baseline，**06 不改任何签名**）：

- architecture §5.2 `AgentRegistry { register / resolve }` 与 `AgentControl { run(input): Promise<TurnSummary>; cancel(reason?): void }`。
- architecture §5.2 取消信号边界：`ctx.signal` 是**进程级**，回合级取消走 `cancel()`，二者是两条独立通道。
- architecture §6 一个回合的数据流：`user/message` → `turn/start` → step 循环（render / deriveMessages / waterfall / stream / append / 按 `concurrency` 调度工具）→ `turn/end` → 压缩检查。
- architecture §5.4 `SessionEvent` 事件表：`turn/start` / `turn/end` / `user/message` / `assistant/message` / `compaction` 的写入。
- architecture §5.3 `llm/request` 瀑布与 `step/start` / `step/end` / `stream/chunk` 通知事件。
- 05 §8 附则对 06 的四条接口约定（PROGRESS.md"给 06 的接口约定"条目同文）：

  > setup 时 `createToolRunner(ctx, { approve, timeoutFor })` 一次；每 step 调 `runner.run(call, {sessionId,turnNo,stepNo,signal})`；`req.tools = toToolSchemas(ctx.tools.list())`；**06 不得自行 append `tool/result`**，也不得绕过 runner 直接调 `def.execute`；调度按 `ToolDefinition.concurrency`。

目标（一句话）：让 07 只需

```ts
const ctl = ctx.agent.resolve()
const summary = await ctl.run({ text: '把 src/agent 下的 TODO 清掉' })   // 一个回合跑完
ctl.cancel()                                                            // 中途按 Ctrl+C
```

就拿到"每一步都从 log 重新投影、工具一定过管道、取消一定收敛、超窗口一定压缩"的回合循环。

**非目标**（防范围膨胀）：

- 不做多会话并发 / 子 agent / 任务树（原版的 `task` 工具属产品能力，架构 §10 已砍）。
- 不做 token 精确统计（无 tokenizer，零依赖）：只做**启发式估算**驱动压缩，不承诺与 provider 计费一致。
- 不做自动重试 / fallback provider / 速率限制（02 的 `LlmError` 直接上抛，策略归 07）。
- 不做审批 UI（05 只定义 `approve` 通道，实现归 07）。
- 不做 prompt 缓存、不做流式中断后的续写（cancel 即落前缀结束回合）。
- 不改 `Config` 形状（不新增骨架级字段，§8-Q4）；不改 `contracts.ts` 任何签名（§2.4）。

## 2. 对外契约

模块落在 `src/agent/`。沿用 02 X2 / 03 / 04 / 05 的出口约定：**宿主侧**经 `src/agent/index.ts`；06 没有下游插件消费者（唯一消费方是 07 宿主），故 `src/index.ts` 只需**增补一行转发**（`createBashTimeoutResolver`，见 §2.3），不新增 06 自己的插件侧出口。

### 2.1 宿主侧（`src/agent/index.ts`）

```ts
/** builtin 名：`config.plugins[].source` 写作 `builtin:agent-loop`。 */
export const BUILTIN_AGENT = 'builtin:agent-loop'

/** 单回合步数上限的默认值（§8-Q4）。 */
export const MAX_STEPS_PER_TURN = 32

/** 压缩相关常量（§4.6）：单条工具结果的截断长度与 transcript 总预算。 */
export const TRANSCRIPT_ITEM_CHARS = 800
export const TRANSCRIPT_MAX_CHARS = 60_000

/**
 * 插件构造选项（生产由 07 传入）。
 * 07 若要 resume，把会话 id 传进来；省略则由 06 新建。
 */
export interface AgentPluginOptions {
  /** 复用的会话 id（07 的 /resume）；省略 = setup 时新建会话 */
  sessionId?: string
  /** `ask` 策略的审批通道（05）；缺省 ⇒ 所有 `ask` 失败关闭（PB-02 ②） */
  approve?: ApproveHandler
  /** 单回合步数上限，默认 `MAX_STEPS_PER_TURN` */
  maxStepsPerTurn?: number
}

/** 实例级配置（`plugins[].config`）形态：只暴露步数上限。 */
export interface AgentPluginConfig {
  maxStepsPerTurn?: number
}

/**
 * 构造 `builtin:agent-loop` 插件工厂。
 *
 * setup 内：装配 runner → 解析/创建会话 → `ctx.agent.register(control)`。
 */
export function createAgentPlugin(options?: AgentPluginOptions): PluginFactory

/** 把默认 `builtin:agent-loop` 注册进内核 builtin 表（无 approve）；@returns 退订句柄 */
export function registerAgentBuiltin(): Unsubscribe

/* ---- 以下为可脱离组合根单测的实现面（D3：核心与插件分离） ---- */

/** 回合循环的依赖集（插件装配，单测注入伪实现）。 */
export interface AgentDeps {
  ctx: Ctx
  sessionId: string
  /** 惰性解析 adapter（02 D7：provider 自检归使用点，不在 setup 内做） */
  resolveAdapter(): LlmAdapter
  /** 05 的 guarded pipeline（setup 内创建一次） */
  runner: ToolRunner
  /** 单回合步数上限 */
  maxStepsPerTurn: number
}

/** 构造 `AgentControl`（回合循环本体）；`cancel()` 只作用于当前回合。 */
export function createAgentControl(deps: AgentDeps): AgentControl

/** 按 `concurrency` 与 `maxParallel` 调度一批工具调用（§4.4）。 */
export function scheduleToolCalls(
  calls: readonly ToolCall[],
  defs: ToolDefIndex,
  run: (call: ToolCall) => Promise<unknown>,
  options: ScheduleOptions,
): Promise<void>

/** token 启发式估算（§3.3）：纯函数，无 tokenizer。 */
export function estimateTokens(text: string): number
export function estimateRequestTokens(input: {
  system: string
  messages: readonly ChatMessage[]
  tools: readonly ToolSchema[]
}): number

/** 是否需要压缩（§4.6）：纯函数。 */
export function needsCompaction(estimated: number, contextWindow: number, thresholdRatio: number): boolean

/** 压缩切点判定（§4.6 / X2）：纯函数；有可摘要内容时返回 `events.length`，否则 0。 */
export function findCompactionCut(events: readonly SessionEvent[]): number

/** 摘要请求的用户消息（`keepTurns` 在这里兑现为粒度指引，X2）。 */
export function buildSummaryPrompt(transcript: string, keepTurns: number): string

/** transcript 渲染（§4.6）：纯函数，log → 给摘要模型看的文本。 */
export function renderTranscript(
  events: readonly SessionEvent[],
  options?: { maxItemChars?: number; maxChars?: number },
): string

/**
 * 执行一次压缩（§4.6）：切点 → transcript → 摘要请求 → 追加 `compaction`。
 * 任何一步不达标都只跳过，**不抛错**。
 * @returns `compacted` 是否写入；`usage` 是本次摘要请求的用量（失败时为已送达的部分用量）
 *   ——调用方**必须**累加进 `TurnSummary.totalUsage`（Q8 / 评审期修复 Y1）
 */
export function compactSession(request: CompactRequest): Promise<CompactOutcome>
```

### 2.2 与 07 的装配形态

```text
07 CLI:
  registerBuiltin('agent-loop', createAgentPlugin({ approve: askUserOnStdin, sessionId }))
      │                                   // 不注入 approve ⇒ 所有 ask 失败关闭（05 §4.3）
      └─ boot(config) ─► builtin:agent-loop.setup(ctx, entry.config)
                             ├─ createToolRunner(ctx, { approve: wrapped, timeoutFor })
                             ├─ sessionId ? sessions.open(id) : sessions.create({provider,model,cwd})
                             └─ ctx.agent.register(createAgentControl({ ctx, sessionId, resolveAdapter, runner, maxSteps }))
  REPL: ctx.agent.resolve().run({ text })
```

### 2.3 `src/index.ts` 的增补（一行）

`createBashTimeoutResolver` 目前只在 `src/tools/index.ts`（宿主侧）导出。06 作为插件作者经 `src/index.js` import，故本次**增补转发**：

```ts
/** 05 的 bash 超时解析工厂（06 在 setup 内接线 `timeoutFor`，避免知道字段名的位置耦合） */
export { createBashTimeoutResolver } from './tools/plugin.js'
```

不改动 05 的任何代码；`src/index.ts` 不导出 06 的实现（无下游插件消费者），因此**不产生 index → agent → index 的环**（与 02 X2 同一避环模式）。

### 2.4 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | **`user/message` 由 06 在 `run()` 内 append**，不由 07 先落盘再调 `run` | 架构 §6 的时序图把 append 画在 `run()` 之前，但 `run(input)` 的签名收的是 `text`——若两边都写会双写，若只由 07 写则 06 的"输入事实"依赖调用方自觉（08/09 或测试直接调 `run` 就会漏）。取"谁收输入谁落盘"（§8-Q2） |
| D2 | **`turnNo` 从 log 推导**（`turn/start` 事件计数 + 1），不在内存里维护计数器 | 灵魂 #2（model-visible means logged）：resume 到另一个进程时内存计数器必然归零，会让回合号与既有 log 冲突。计数 `turn/start` 是 log 自身的真相，与 `deriveMessages` 同源（§8-Q3） |
| D3 | **回合循环与插件分离**：`createAgentControl(deps)` 是纯接线可注入的核心，插件只做装配 | 与 03 D3 / 04 D3 / 05 D3 同式：循环逻辑可注入伪 adapter / 伪 runner 单测，插件退化为"装配 + 生命周期"薄层 |
| D4 | **压缩在每 step 开头检查**，而不是回合结束后统一检查 | 压缩的目的是"别发出超窗口的请求"。放在 step 开头可与本 step 的 `read + deriveMessages` 复用同一次投影（零额外 IO），且保证任何一步发出去的请求都已过闸（§8-Q9） |
| D5 | **工具结果在 log 中是"完成序"而非"声明序"** | `tool/result` 由 05 的 runner 在 `run()` 内部 append（05 §4.1 步骤 ⑪），06 无法在不串行化执行的前提下控制顺序。并发与顺序二选一，取并发（§8-Q5 记录风险） |
| D6 | **`assistant/message` 的 `usage` 取本 step 流中最后一个 `usage` 事件**，跨 step 累加进 `TurnSummary.totalUsage` | OpenAI 兼容流里 usage 可能每片下发（累计值）或只在末片下发；取最后一个即为该请求的最终用量（§8-Q8） |
| D7 | **压缩请求不派发 `stream/chunk`** | 摘要不是回合输出，派发会让 CLI 把摘要文本当成助手回复渲染出来（§8-Q6） |
| D8 | **每回合最多压缩一次**；压缩后仍超阈值只 `log.warn` | 若单个回合本身就撑爆窗口，压缩救不回来；每 step 都重试会变成"每步一次额外 LLM 调用"的放大器（§4.6） |
| D9 | **`cancel()` 期间若卡在审批等待，06 用回合信号把 `approve` 包一层立即返回 `false`** | 05 的 `approve` 只收 invocation、拿不到信号，审批等待最长 60s（默认）；不包装则 Ctrl+C 要等满 60s 才生效（§8-Q12） |
| D10 | **`dispose()` 中止在途回合并等待其收尾**（不设超时） | 工具结果需要在会话 store 清理前落盘（03 的 dispose 会 `settled() + clear()`）。不设超时沿用内核既有约定——07 的退出流程用 `Promise.race` 兜底（PROGRESS 遗留表"dispose 无超时"） |

## 3. 数据结构

### 3.1 模块文件与 LOC 预估

| 文件 | 职责 | 预估 |
|---|---:|---:|
| `types.ts` | 选项 / 依赖集 / 常量 | ~90 |
| `tokens.ts` | token 启发式估算（纯函数） | ~70 |
| `schedule.ts` | 并发调度器（`concurrency` + `maxParallel` + 取消） | ~170 |
| `compact.ts` | 切点定位 / transcript 渲染 / 摘要请求 | ~330 |
| `loop.ts` | 回合循环（`createAgentControl`） | ~620 |
| `plugin.ts` | 插件装配、实例配置 narrow、`registerAgentBuiltin` | ~200 |
| `index.ts` | 宿主侧出口 | ~40 |
| | **合计** | **~1.5k** |

### 3.2 回合内的中间态

```ts
/** 一次流式产出的聚合结果（collect 的返回值，内存态，不入 log）。 */
interface CollectedStream {
  /** 拼接后的文本（取消时为已送达前缀） */
  text: string
  /** 本次请求最终 usage（无 usage 事件时为零值） */
  usage: TokenUsage
  /** 02 的聚合器产物，按 index 升序 */
  calls: ToolCall[]
  /** 流被取消/中断（adapter 抛 `aborted` 或信号已 abort） */
  aborted: boolean
}

/** 当前回合的运行态（`createAgentControl` 闭包内）。 */
interface TurnState {
  turnNo: number
  /** 回合级控制器；`cancel()` 即 abort 它。与 `ctx.signal` 用 `AbortSignal.any` 合并 */
  controller: AbortController
  signal: AbortSignal
  /** 用户是否已请求取消（决定 `TurnSummary.interrupted`） */
  cancelRequested: boolean
}
```

`turnNo` 落盘即真相；`stepNo` 只在本回合内递增（步号不跨回合，log 里也没有 `step/*` 事件——`step/start` / `step/end` 只是**总线**通知，架构 §5.4 的 log 事件表不含它们）。

### 3.3 token 启发式估算（`tokens.ts`）

零依赖 ⇒ 没有 tokenizer。规则：

```text
CJK（含中日韩统一表意文字、假名、全角标点、CJK 标点）  → 1 token/字符
其余字符                                              → 1 token/4 字符（向上取整）
每条消息                                              → +4（role 与分隔开销）
assistant.toolCalls                                   → 按 JSON.stringify 长度再估一次
tools[]                                               → 按 JSON.stringify(schema) 长度估一次
system                                                → 按文本估一次
```

- 中文按 1 token/字是**保守偏高**（DeepSeek 中文实际约 0.6–1.5 token/字），偏高的后果只是"稍早压缩"，安全方向正确。
- 本函数只服务于"要不要压缩"这一个判断，**不对外承诺精度**，也不写进 log（log 只记 provider 回报的真实 usage）。

### 3.4 压缩事件

```ts
{ type: 'compaction', summary: string, boundary: number }
```

- `summary`：模型产出的摘要文本；`deriveMessages` 把它作为**首条 user 消息**投影（03 设计 §4.4 规则 2）。
- `boundary`：**被折叠掉的最后一个回合号**（语义标注，投影不使用——切点以事件位置为准，03 §8-Q8）。

## 4. 核心流程

### 4.1 插件 setup 与 dispose

```text
createAgentPlugin(options) → setup(ctx, config?):
  ① maxSteps = narrowMaxSteps(config) ?? options.maxStepsPerTurn ?? MAX_STEPS_PER_TURN
     非法（非正整数 / 配置是数组）⇒ throw ⇒ 组合根转 BootError（与 04 Y1 同式：Array.isArray 防线）
  ② runner = createToolRunner(ctx, {
        approve: options.approve,                          // 原样透传（X3：取消判定在 05 内）
        timeoutFor: createBashTimeoutResolver(ctx.config), // 05 提供，06 不认字段名
     })
  ③ session = options.sessionId
        ? await ctx.sessions.open(options.sessionId)   // resume：id 不存在 ⇒ SessionError ⇒ BootError（启动期 fail-fast）
        : await ctx.sessions.create({ provider: config.model.provider,
                                      model:    config.model.name,
                                      cwd:      process.cwd() })
  ④ ctx.agent.register(createAgentControl({ ctx, sessionId: session.id, resolveAdapter, runner, maxSteps }))

dispose():
  controller?.abort('shutdown')                 // 可选链：必须容忍 setup 未完成（内核 X5）
  await current?.catch(() => {})                // 等在途回合收尾（工具结果要落盘），不设超时（D10）
```

- **`resolveAdapter` 是惰性的**：`() => ctx.llm.resolve(ctx.config.model.provider)(ctx.config.model)`。不在 setup 内解析，兑现 02 D7（"provider 自检归使用点"）——否则"某插件在 agent 之后注册 provider"会被误判为未注册而启动失败。
- **会话在 setup 创建**：resume 一个不存在的 id 应在**启动时**报错，而不是等用户第一次回车（§8-Q1）。
- **`approve` 不包装**（X3）：取消期间的审批由 05 判为 `cancelled`、无审批通道时判为 `permission_denied`，两者都是失败关闭（PB-02 ②）。

### 4.2 `run()` 时序

```text
run(input):
  ① 若已有回合在跑 ⇒ throw Error('a turn is already running')（§5 边界表）
  ② turnNo   = count(log 中的 turn/start) + 1                    ← D2
     turn    = { controller: new AbortController(), cancelRequested: false }
     signal  = AbortSignal.any([turn.controller.signal, ctx.signal])
  ③ append(turn/start { turnNo })                                ← **先写回合边界**（X1，见下）
     append(user/message { content: input.text })                ← D1：输入事实由 06 落盘
     emit('turn/start')                                          ← 先落盘后通知（与 03"落盘后才广播"同式）
  ④ stepNo = 0 ; usage = ZERO ; compacted = false ; interrupted = false
  ⑤ for (stepNo < maxStepsPerTurn):
        stepNo++ ; emit('step/start')
        try { 走一个 step（§4.3）} finally { emit('step/end') }
        结束条件之一成立 ⇒ break
  ⑥ finally:
        append(turn/end { turnNo }) ; emit('turn/end')
        current = undefined
  ⑦ return { turnNo, stepCount: stepNo, totalUsage: usage,
             interrupted: interrupted || turn.cancelRequested || signal.aborted }
```

- 步骤 ⑥ 在 `finally` 中：**即使 LLM 抛错也要保证 `turn/end` 落盘**（日志边界闭合；否则 resume 后回合计数与事件序列失衡）。落盘失败只记 `log.error`，不掩盖正在上抛的回合错误（与内核 dispose 的"抛错只记 log"同式）。
- **③ 的顺序是 X1**：设计原序为 `user/message → turn/start`，实现改为 `turn/start → user/message`。原因是压缩以 `turn/start` 的下标为切点，若 user 消息排在前面，切点会把该回合**自己的**用户输入折进摘要，保留的回合反而丢掉了用户问题。改序后"回合 N 的全部事件都在 ts_N 之后"成立。
- `cancel(reason?)`：无在途回合 ⇒ `log.debug` 后返回（no-op）；否则 `turn.cancelRequested = true` + `turn.controller.abort(reason ?? 'cancelled')`。

### 4.3 一个 step 的时序

```text
step(turnNo, stepNo, signal):
  ① if (signal.aborted) { interrupted = true ; return 'break' }
  ② events   = await ctx.sessions.read(sessionId)          ← 每步重读：log 是唯一事实源
     messages = deriveMessages(events)                     ← 03 的投影，灵魂 #2
  ③ if (!compacted && needsCompaction(estimateRequestTokens({system, messages, tools}),
                                      contextWindow, thresholdRatio)):
         await compact(events)                             ← §4.6（失败只 warn）
         compacted = true
         if (signal.aborted) { interrupted = true ; return 'break' }
         messages = deriveMessages(await ctx.sessions.read(sessionId))
  ④ req = await ctx.events.waterfall('llm/request', {
          system: ctx.prompt.render(),                     ← 04：系统提示唯一出口，每步现拼
          messages, model: ctx.config.model.name,
          tools: toToolSchemas(ctx.tools.list()),          ← 05：模型可见面
          signal,
     })
  ⑤ out = await collect(adapter.stream(req))               ← 02；每片 emit('stream/chunk')（§4.5）
  ⑥ append(assistant/message { content: out.text,
              toolCalls: out.calls.length ? out.calls : undefined,
              usage: out.usage, ...(out.aborted ? { interrupted: true } : {}) })
     usage += out.usage                                     ← D6
  ⑦ if (out.aborted)          { interrupted = true ; return 'break' }   ← 取消：落前缀后收尾
     if (out.calls.length===0) return 'break'               ← 无工具调用：回合自然结束
                                                            （"无文本也无调用"的空回复同此分支）
  ⑧ await scheduleToolCalls(out.calls, defs, runOne, { maxParallel, signal })
     // 结果由 05 的 runner 自行 append(tool/result)——06 不重复写（05 §8 附则）
  ⑨ if (signal.aborted) { interrupted = true ; return 'break' }
```

- `defs` = `new Map(ctx.tools.list().map(d => [d.name, d]))`，**每步取一次快照**（工具只在 boot 期注册，快照安全且避免 `get()` 抛错）。未注册的工具不在 map 里 ⇒ 按 `'parallel'` 调度，由 runner 产出 `execution_error`（05 §4.7）——**06 不替 05 判断工具是否存在**。
- `system` 每步 render 一次：已知取舍（环境段含秒级时间戳，会削弱 provider 前缀缓存），PROGRESS 遗留表已记录，**本模块不改**。

### 4.4 工具并发调度（`schedule.ts`）

```text
scheduleToolCalls(calls, defs, runOne, { maxParallel, signal }):
  inflight = new Set<Promise<void>>() ; errors = []
  start(p):  const w = p.then(noop, err => errors.push(err))   // 记录错误，避免 unhandled rejection
             inflight.add(w) ; void w.then(() => inflight.delete(w))
  drain():   while (inflight.size) await Promise.allSettled([...inflight])
             if (errors.length) throw errors[0]                // 收尾时上抛第一个（不静默吞）

  for (call of calls):
     if (signal.aborted) break                     // 取消后不再启动新调用
     if (defs.get(call.name)?.concurrency === 'exclusive'):
         await drain()                             // 屏障 1：等在途全部结束
         await runOne(call)                        // 屏障 2：单独执行，期间无并发
     else:
         if (inflight.size >= maxParallel) await Promise.race(inflight)   // 等一个空位
         start(runOne(call))
  await drain()                                    // 收尾：等本 step 全部调用结算
```

- `maxParallel` 取 `ctx.config.tools.maxParallel`（默认 4）。01 的 `validate.ts` 已保证 `≥ 1`（`requireInt(..., 1)`），此处对 `<= 0` 仍按 1 兜底——调度器不做除法/取模，取 1 等价于串行，是最安全的退化方向。
- `Promise.race(inflight)` 只用于"等空位"，不做取消（runner 永不抛，race 不会变成 rejection）。
- **取消语义**：`signal` 已 abort 时立即停止**启动**新调用，但已在途的调用照常等其结算（runner 会把取消信号传给工具，产出 `cancelled` 结果并落盘）。这条保证"取消不会留下未落盘的工具调用"。
- 顺序保证：结果在 log 里是**完成序**（D5）。

### 4.5 流收集与 `stream/chunk`

```text
collect(iter, signal):
  text = '' ; usage = ZERO ; acc = createToolCallAccumulator() ; aborted = false
  try {
    for await (const ev of iter):
      ctx.events.emit('stream/chunk', { sessionId, delta: ev })   ← 四种 StreamEvent 全派发（Q6）
      switch (ev.type): 'text'      → text += ev.delta
                        'tool-call' → acc.push(ev.delta)          ← 02 的聚合器
                        'usage'     → usage = ev.usage            ← 最后一个生效（D6）
                        'end'       → break
  } catch (err):
     if (err instanceof LlmError && (err.kind === 'aborted' || signal.aborted)) aborted = true
     else throw err                                                ← http/network/protocol 上抛给 07
  return { text, usage, calls: acc.result(), aborted }
```

- `stream/chunk` 同步派发、监听器抛错由总线捕获记 log（架构 §5.3），**不影响主流程**。
- `end` 事件也派发一份：给 CLI 一个"本段流结束"的显式信号，省得它靠 `usage` 猜。

### 4.6 压缩（`compact.ts`）

```text
needsCompaction(estimated, contextWindow, thresholdRatio) = estimated >= contextWindow * ratio   （Q9）

compact(events):
  cut = findCompactionCut(events)
        // X2：03 的投影以"最后一个 compaction 事件的位置"为切点，append-only 日志下
        // 切点只能是"即将追加的位置" ⇒ 有可摘要内容时恒为 events.length，否则 0
  if (cut <= 0) return
  transcript = renderTranscript(events.slice(0, cut))
  if (transcript.trim() === '') return                       // 只有 header 时没有可摘要的内容
  boundary = events[0..cut) 中最后一个 turn/start 的 turnNo（无则 0）
  req = await events.waterfall('llm/request', {
          messages: [{ role:'user', content: SUMMARY_INSTRUCTION + '\n\n' + transcript }],
          model: config.model.name, tools: [], signal,        // tools 空：摘要不该再调工具
        })
  try {
     // 不 emit stream/chunk（D7）；用量经 sink 带回，失败也不丢（Q8 / Y1）
     const { text, usage } = await collectSilent(adapter.stream(req), sink)
  } catch (err) { log.warn('compaction skipped: <err>') ; return { compacted:false, usage:sink.usage } }
  if (text.trim() === '') { log.warn('compaction skipped: empty summary') ; return ... }   ← 空摘要守卫
  await append({ type:'compaction', summary: text, boundary })
  log.info(`compacted turn <= ${boundary}`)
```

- **摘要请求的用量必须回传**（评审期修复 **Y1**，兑现 §8-Q8）：压缩是一条真实的 LLM 调用，
  用量漏掉会让 07 显示的 `totalUsage` 偏小。实现用"用量盒子"（`sink`）在 `collectText`
  内累积——**流中途失败时已送达的 usage 也要留下**，故 `compactSession` 的成功与跳过
  两条出口都带上 `usage`，`loop.ts` 无条件 `addUsage`。

**transcript 渲染规则**（`renderTranscript`，纯函数）：

| 事件 | 文本形态 |
|---|---|
| `user/message` | `用户：<content>` |
| `assistant/message` | `助手：<content>`；有 `toolCalls` 时补 `[调用 <name>(<arguments 前 200 字符>)]` |
| `tool/result` | `[工具结果 <name> · ok/error] <content 截断至 800 字符>` |
| `compaction` | `会话摘要（更早部分）：<summary>`——**必须带上**，否则更早的摘要会在二次压缩时丢失 |
| `session/header` / `turn/*` | 跳过（元信息对摘要无意义） |

- 总预算 60k 字符：超出时**从最旧开始丢**，并在开头补一行 `…（更早的 N 条已省略）`。
- **空摘要守卫**是硬要求：append 一个空 summary 等于用 `deriveMessages` 把边界前的历史换成一条空 user 消息——历史被静默抹掉且无从恢复。
- 压缩请求同样走 `llm/request` 瀑布（插件可见，可改写），但**不派发 `stream/chunk`**（D7）。
- **每回合最多一次**（D8）：`compacted` 标志置位后不再检查；若压缩后仍超阈值，只 `log.warn`（单回合内容撑爆窗口时压缩救不回来，重试只会放大开销）。

### 4.7 错误处置

| 来源 | 处置 |
|---|---|
| adapter 抛 `LlmError{kind:'aborted'}` 或信号已 abort | 落 `assistant/message`（含已送达前缀 + `interrupted:true`）→ `interrupted = true` → 正常结束回合（**不上抛**） |
| adapter 抛 `LlmError{kind:'http'/'network'/'protocol'/'config'}` | `finally` 落 `turn/end` → **原样上抛**给 07（07 按 `kind` 给不同提示；02 §2.3 的分类就是为这个） |
| `sessions.read` / `append` 抛 `SessionError` | 上抛（回合无法在无 log 的前提下继续） |
| `ctx.prompt.render()` 抛（段 render 出错） | 上抛（04 已定"段抛错上抛不吞"） |
| 工具调用失败 | **不是错误路径**：runner 永不抛，产出 `ok:false` 的 `ToolResult` 并入 log；回合继续下一步 |
| 压缩失败 / 空摘要 | `log.warn` + 跳过，**不影响回合** |
| `llm/request` 瀑布被否决 | 错误上抛（架构 §5.3 语义）；同 LLM 错误路径，`turn/end` 仍落盘 |

### 4.8 dispose

```text
dispose():
  turn?.controller.abort('shutdown')     // 可选链：容忍 setup 未完成（内核 X5）
  await current?.catch(() => {})         // 等在途回合收尾（D10）
```

- `current` 是本回合 `run()` 的 Promise；等它结算是为了让工具结果在 03 的 store 清理之前落盘。
- **不设超时**（内核既有约定）：07 的退出流程用 `Promise.race` + 强制退出兜底。

## 5. 边界情况与错误处理

| # | 情况 | 行为 |
|---|---|---|
| 1 | 空文本输入（`''` / 全空白） | 照常走完一个回合（06 不做策略判断；过滤空输入归 07） |
| 2 | 并发 `run()`（上一回合未结束） | `throw Error('a turn is already running')`（07 不得并发跑回合） |
| 3 | `cancel()` 时无在途回合 | no-op + `log.debug` |
| 4 | 连续两次 `cancel()` | 第二次仍是 no-op（进程级退出由 07 触发 `ctx.signal`） |
| 5 | 流中途被取消 | 落部分文本 + `interrupted:true`；**不启动工具**；回合返回 `interrupted:true` |
| 6 | 工具执行中被取消 | 已启动的调用照常结算（runner 传信号 ⇒ 结果 `cancelled` 并落盘）；未启动的不再启动 |
| 7 | 审批等待中被取消 | 05 的 `requestApproval` 直接产出 **`cancelled`** 结果（不是 `permission_denied`）；取消比"未获授权"更准确（X3） |
| 8 | 模型返回空（无文本、无调用） | 回合结束（`assistant/message` 仍落盘；`deriveMessages` 投影时会跳过空 assistant） |
| 9 | 步数达 `maxStepsPerTurn` | 回合结束 + `log.warn`（不追加说明性消息——06 不编造会话事实） |
| 10 | 未注册的工具名 | 按 parallel 调度，runner 产出 `execution_error`（05 §4.7），回合继续 |
| 11 | `maxParallel <= 0` 的异常配置 | 按 1 处理（串行）；01 的校验是本防线的前置 |
| 12 | `keepTurns <= 0` 或不足 `keepTurns` 个回合 | 切点退化为**当前回合起点**（只折叠更早内容），见 §4.6 |
| 13 | 压缩请求失败 / 返回空 | 跳过压缩，`log.warn`，回合继续 |
| 14 | 压缩后仍超阈值 | 不再压缩（每回合一次），`log.warn` |
| 15 | resume 的 `sessionId` 不存在 | setup 内 `open()` 抛 `SessionError{kind:'not_found'}` ⇒ 组合根转 `BootError`，**启动期**失败 |
| 16 | 会话 IO 失败（磁盘满/权限） | `SessionError` 上抛给 07；`turn/end` 可能落不进去（尽力而为，不吞错误） |
| 17 | dispose 时 setup 未完成 | 全程可选链（内核 X5） |
| 18 | `run()` 期间进程退出（`ctx.signal`） | 与回合取消同一路径：`interrupted:true`，`turn/end` 落盘 |
| 19 | **取消发生在请求发出之前**（回合刚起步就 `cancel()`） | log 落成"空回合"：`turn/start` + `user/message` + `turn/end`，**无 `assistant/message`**；`stepCount === 1`、`interrupted:true`。这是 log 如实记录"用户问了但取消了"，不是缺陷（评审探针 P2 实测确认） |
| 20 | **取消与 LLM 错误同时发生**（流中途 `cancel()`，adapter 抛 `http`/`network`） | **取消优先**：按 §4.7 第一行"或信号已 abort"判为中断，落已送达前缀、回合正常收尾，**错误不上抛**（07 看不到这次 500）。有意取舍：用户主动取消时，错误分类没有意义；探针 P2b 实测确认 |

## 6. 测试计划

### 6.1 单元测试（`src/agent/**/*.test.ts`，与源码同目录）

**`tokens.test.ts`**（估算，纯函数）：空串为 0 / 纯 ASCII 约 `ceil(n/4)` / 纯中文约 `n` / 中英混排 / 每条消息 +4 开销 / `tools` schema 计入 / `system` 计入 / `needsCompaction` 阈值三态（低于、等于、高于——等于即触发）。

**`schedule.test.ts`**（并发调度，注入记录调用顺序的伪 `runOne`）：

1. 空 `calls` ⇒ 立即返回，无调用。
2. 全 parallel（5 个）且 `maxParallel=2` ⇒ 并发峰值恒 ≤ 2（用计数器记录峰值）。
3. `exclusive` 独占屏障 ⇒ 它开始执行时在途数为 0、执行期间无其它工具在途。
4. `exclusive` 之前的 parallel 必须先结束（屏障 1）。
5. 混合序列 `[p, p, e, p]` ⇒ 顺序符合"e 前排空、e 单独、e 后继续并发"。
6. 未注册工具（不在 `defs`）按 parallel 处理。
7. `maxParallel=1` ⇒ 严格串行。
8. 调度途中 `signal.aborted` ⇒ 不再启动新调用，但已在途的照常结算（断言已启动数 < 总数 且全部结算）。
9. `runOne` 抛错（违反契约的防御）⇒ 不产生 unhandled rejection，`drain` 正常返回。

**`compact.test.ts`**（切点与 transcript，纯函数 + 伪 adapter）：

10. `findCompactionCut`：回合数 > keepTurns ⇒ 切在"倒数第 keepTurns 个回合起点"。
11. `findCompactionCut`：回合数 ≤ keepTurns ⇒ 退化为当前回合起点。
12. `findCompactionCut`：无 `turn/start` ⇒ 0（不压缩）。
13. `renderTranscript`：user/assistant/tool 三种形态齐全；tool 结果超 800 字符被截断。
14. `renderTranscript`：**包含既有 compaction 的 summary**（二次压缩不丢更早摘要）。
15. `renderTranscript`：总量超 60k ⇒ 丢最旧 + 开头有省略说明。
16. `renderTranscript`：只有 header ⇒ 空串（触发"不压缩"）。
17. 压缩主流程：超阈值 ⇒ append 一条 `compaction`，`boundary` 为被折叠的最后一个回合号；之后 `deriveMessages` 只剩摘要 + 保留的回合。
18. 摘要为空 ⇒ **不 append**（守卫）。
19. 摘要请求抛 `LlmError` ⇒ 跳过压缩、不抛、有 warn 日志。
20. 压缩请求 `tools` 为空数组、且不派发 `stream/chunk`（监听断言）。

**`loop.test.ts`**（回合循环，注入伪 adapter / 伪 sessions / 伪 runner）：

21. 无工具调用 ⇒ 一步结束；`assistant/message` 落盘；`TurnSummary{stepCount:1, interrupted:false}`。
22. 有工具调用 ⇒ 继续下一步；`stepCount` 正确；每步 `messages` 都由 log 重新投影（伪 sessions 计数断言"每步都 read 了一次"）。
23. 空回复（无文本无调用）⇒ 回合结束。
24. 取消打断流 ⇒ 落带 `interrupted:true` 的 `assistant/message`（含前缀文本）；返回 `interrupted:true`；**未启动工具**。
25. 取消发生在工具执行中 ⇒ 在途工具结算（伪 runner 记录收到 abort），回合结束，`interrupted:true`。
26. `LlmError{kind:'http'}` ⇒ 上抛同一错误对象；但 `turn/end` 已落盘（日志边界闭合）。
27. `llm/request` 瀑布被插件改写 `model` ⇒ 实际请求用的是改写后的值（伪 adapter 断言）。
28. `turnNo` 从 log 推导（预置 3 个 `turn/start` ⇒ 本次为 4）；`step/start` / `step/end` 成对派发。
29. 步数达上限 ⇒ 回合结束 + warn；`stepCount === maxStepsPerTurn`。
30. `stream/chunk` 对四种 `StreamEvent` 全派发；`usage` 取最后一个（多片 usage 时断言取末片）。
31. 压缩触发：预置超阈值 messages ⇒ 一步内先 append compaction，再用压缩后的 messages 发请求。
32. 并发 `run()` ⇒ 抛 `'a turn is already running'`；`cancel()` 无在途回合 ⇒ no-op。
33. `user/message` 由 run 内 append（断言 log 里恰好一条）。

**`plugin.test.ts`**（装配与生命周期）：

34. setup 无 `sessionId` ⇒ 新建会话并 `ctx.agent.register`；`resolve()` 拿到 control。
35. setup 有 `sessionId` ⇒ `open()`；id 不存在 ⇒ 抛（集成侧断言转 BootError）。
36. 实例配置 `maxStepsPerTurn` 生效；非法值（0 / 负数 / 非整数 / 数组）⇒ 抛。
37. dispose 容忍 setup 未完成（未跑 setup 直接 dispose 不抛）。
38. dispose 中止在途回合并等待其收尾（伪 runner 的未结算调用被等到）。
39. `registerAgentBuiltin` 重复注册 ⇒ 抛；退订句柄可移除。

### 6.2 集成测试（`tests/integration/agent.test.ts`，真实组合根 + 真实 JSONL + 伪 fetch）

用 02 的 `createLlmPlugin({ fetchImpl })` 注入伪 SSE（与 `tests/integration/llm.test.ts` 同式，全程不打网络），挂载 `builtin:session`（tmp 目录）/ `builtin:prompt` / `builtin:tools` / `builtin:agent-loop`，真实 `boot()` 后经 `ctx.agent.resolve()` 驱动：

1. **纯问答链路**：SSE 只回文本 ⇒ `TurnSummary{stepCount:1}`，log 事件序列为 `header / user / turn/start / assistant / turn/end`，`deriveMessages` 投影出 user+assistant 两条。
2. **工具调用链路**：SSE 回一个 `read` 调用 ⇒ 工具执行 ⇒ `tool/result` 入 log ⇒ 第二轮回文本 ⇒ 回合结束；断言 `step/start` 派发两次、`tool/start`/`tool/end` 成对。
3. **并发与独占**：一轮回 3 个调用（`read`×2 + `bash`）⇒ 断言两个 read 可并发（时间重叠）、bash 执行期间无其它工具在途。
4. **取消**：第一轮流式过程中 `cancel()` ⇒ `interrupted:true`，log 中 assistant 带 `interrupted:true`，`turn/end` 仍存在。
5. **压缩**：把 `contextWindow` 调小使首步即超阈值 ⇒ 摘要请求（伪 fetch 按内容路由返回摘要）⇒ log 追加 `compaction`，后续投影只剩摘要。
6. **resume**：同一 sessionId boot 两次 ⇒ 第二次 `turnNo` 从 2 起（log 推导），且能读到第一次的全部事件。
7. **审批失败关闭**：默认（不注入 approve）下 `permissions` 兜底 ask 的工具 ⇒ 结果 `permission_denied` 且入 log；注入 approve 后 ⇒ 正常执行。

## 7. 验收标准（DoD）

- [x] 设计文档状态为 **Reviewed**（2026-10-18 所有者拍板 Q1–Q13 全部按建议项）
- [x] 实现落在**一个** package：`src/agent/`（七文件，见 §3.1）
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（门禁 **483 例**：基线 419 + 06 新增 64）
- [x] §6.1 的单测点（**60 例**）与 §6.2 的集成点（**7 条链路**）全部覆盖并通过
- [x] 不改 `contracts.ts` 任何签名；不改 `Config` 形状；`src/index.ts` 只增补 `createBashTimeoutResolver` 一行转发
- [x] 06 **不**自行 append `tool/result`、**不**绕过 runner 调 `def.execute`（05 §8 附则）
- [x] 每步都从 log 重新投影（`deriveMessages`），内存中无第二份对话状态
- [x] 取消路径三条（流中 / 工具中 / 审批中）均有测试覆盖且都能收敛
- [x] 压缩的三条安全线齐全：空摘要不 append、失败跳过、每回合一次
- [x] 公共导出全部有中文 JSDoc（用途 / 参数 / 返回值 / 副作用 / 错误行为）
- [x] LOC 在预算内（实绩 **1124** 行，预算 ~2.0k；低于下界的原因见下方"预算说明"）
- [x] 所有者已 review 代码（2026-10-18：读码全量 + 门禁复跑 486 例 + 6 例临时探针实证）
- [x] 设计文档状态更新为 **Baseline**（提交归档待用户确认）
- [x] `docs/PROGRESS.md` 已更新（步骤、LOC 实绩、下一步动作）

### 偏离记录（实现期，编号 X）

| # | 偏离 | 理由与影响 |
|---|---|---|
| X1 | **`turn/start` 先于 `user/message` 落盘**（设计 §4.2 原序相反） | 压缩以 `turn/start` 的下标为切点；若 user 消息排在前面，切点会把该回合自己的输入折进摘要——"保留的回合"反而丢了用户问题。改序后"回合 N 的全部事件都在 ts_N 之后"成立。影响：log 事件序列由 `user → turn/start` 变为 `turn/start → user`；`deriveMessages` 不投影这两个中的 `turn/start`，投影结果不变 |
| X2 | **压缩切点语义订正**：`keepTurns` 由"保留 N 个回合的日志"改为"摘要粒度指引" | 03 §4.4 以"最后一个 compaction 事件的位置"为切点，append-only 日志下 compaction 只能追加在末尾，**它之前的全部事件都进摘要**——"保留最近 N 个回合的日志"无解。实现改为：切点恒为 `events.length`；`keepTurns` 在 `buildSummaryPrompt` 里兑现为"最近 N 个回合保留细节"；`boundary` 记当前回合号。已同步 §4.6 / §8-Q10 |
| X3 | **不再用回合信号包装 `approve`**（设计 D9 / Q12 的方案作废） | 探针实证：05 的 `requestApproval` 内部已把 `combinedSignal(rc)`（回合级 ∪ 进程级）与审批结果赛跑，取消得到 `cancelled`（比 `permission_denied` 准确）。06 再包一层会让两条路径竞态、错误码不确定。`approve` 原样透传。已同步 §2.4 D9 / §5 第 7 行 / §8-Q12 |
| X4 | `scheduleToolCalls` 的 `run` 参数放宽为 `Promise<unknown>`，并把并发调用的错误**收集后在收尾时上抛** | `runner.run` 返回 `Promise<ToolResult>`，放宽便于测试注入；错误不静默吞（原伪代码写 `noop`），但也不能让未 await 的 promise 变成 unhandled rejection，故先收集再上抛第一个 |
| X5 | `createAgentControl` 返回 `AgentControlHandle`（`AgentControl` 的子类型，多一个 `abortAndWait`） | `dispose` 需要"中止在途回合并等其收尾"，而 `AgentControl` 的基线签名只有 `run` / `cancel`（架构 §5.2）。该能力无第二方消费，故不上 `ctx.agent` 服务面，由插件持有句柄调用 |
| X6 | `run()` 用**非 async 函数**实现，同步建立回合态后再启动异步主体 | `async` 函数体只在首个 `await` 前同步执行，而"当前回合"占位必须在 `run()` 返回前完成——否则调用方 `run()` 之后立刻 `cancel()` 会撞上"无在途回合"被判成 no-op，**取消被静默丢弃**（已加用例 33b 锁定） |

### 偏离记录（评审期，编号 Y）

| # | 偏离 | 理由与影响 |
|---|---|---|
| Y1 | **压缩请求的用量计入 `TurnSummary.totalUsage`**（`compactSession` 返回值由 `boolean` 改为 `CompactOutcome{compacted, usage}`） | 设计 §8-Q8 拍板"压缩请求的用量也计入 totalUsage（真实花销）"，但 §4.6 伪代码写的是 `const { text } = await collectSilent(...)`——用量被丢弃，实现照伪代码写，**两处自相矛盾**。探针实测：摘要请求 `usage{100,20}` + 回合回复 `{5,5}`，`totalUsage` 只报 `{5,5}`。按 Q8（owner 拍板项）为准改实现：用"用量盒子"在流消费内累积，**失败时已送达的部分用量也要回传**，`loop.ts` 无条件累加。影响：`compactSession` 返回类型变化（新增导出 `CompactOutcome`），无下游消费者。已补 3 例回归（compact 19b/19c、loop 31b） |
| Y2 | 三处注释/JSDoc 与实现不符的订正（无行为变更） | ①`types.ts` 与 `loop.ts` 的 `AgentControlHandle` 说明把偏离号写成 **X2**（压缩切点），实为 **X5**；②`schedule.ts` "屏障 1"注释写"可能抛出前面调用的错误"，X4 改成"收集后收尾上抛"后已不成立；③`loop.ts` 的 `run()` 上方有两个连续的 JSDoc 块（前一个悬空），合并为一个。另删 `tokens.ts` 一处冗余类型断言 |

### 评审排除的误报（第二轮，探针实证）

| 怀疑点 | 实证结论 |
|---|---|
| "`stream/chunk` 监听器抛错会炸掉回合" | **不成立**：总线捕获并记 `error`，回合照常结束（探针 P3） |
| "`LlmError` 上抛后 `current` 不会清空，第二次 `run()` 会被判成并发" | **不成立**：`run()` 的 `finally` 已清空，第二次 `run()` 正常且 `turnNo` 递增到 2（探针 P4） |
| "dispose 会把在途回合的错误上抛" | **不成立**：`current` 自身带 catch（永不 reject），dispose 不抛（探针 P5） |
| "压缩请求缺 `system` 会让 adapter 抛 TypeError" | **不成立**：契约 `LLMRequest.system` 本就可选，02 的 `buildRequestBody` 明确"非空才插入"（读码确认） |

### 评审排除的误报（探针实证，记录以免后续重复怀疑）

自检评审（读码 + 5 例临时探针，跑完即删）确认的**非问题**：

| 怀疑点 | 实证结论 |
|---|---|
| "取消要等审批超时 60s 才生效" | **不成立**：05 的 `requestApproval` 自己把信号纳入 race，取消立即产出 `cancelled`（探针 P2） |
| "工具 execute 抛错会炸掉回合" | **不成立**：runner 产出 `execution_error`，回合继续下一步（探针 P3） |
| "LLM 抛错时 `step/start` / `step/end` 会失衡" | **不成立**：`step/end` 在 `finally` 中派发，实测各 1 次（探针 P5） |
| "并发结果在 log 里是声明序" | **反向确认**：是完成序（快的先落），与设计 D5 一致（探针 P4） |
| "进程级信号已 abort 时 run 会卡住" | **不成立**：首步即判定中断并正常收尾，`turn/end` 落盘（探针 P1） |

### 预算说明

架构 §4 给 06 的预算是 ~2.0k 行，**实绩 1124 行**（types 155 / tokens 103 / schedule 102 / compact 280 / loop 312 / plugin 142 / index 30；排除测试；评审期 Y1–Y2 后口径）。

低于预算下界（2.0k×0.8 = 1.6k），原因有三，均非"功能缺失"：

1. **没有文案类实体内容**——04 那种"压不掉的段文案"在本模块不存在，本模块全是流程与策略代码；
2. **四块能力都是"复用"而非"实现"**——投影调 03、聚合调 02、执行调 05、提示调 04，06 只写编排；
3. **压缩是单一策略**（架构 §10 已砍 compaction 全家），只保留一条 summarize 路径。

## 8. 决策点记录

> **2026-10-18 所有者拍板：Q1–Q13 全部按建议项通过。**

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 会话由谁创建、何时创建 | **06 在 setup 内创建/open**（推荐）。resume 一个不存在的 id 应在**启动期**报 `BootError`，而不是等用户第一次回车；07 通过监听 `session/append` 的 `session/header` 事件拿到自动创建的 id（`AgentControl` 无 id 出口，改契约不值当） |
| Q2 | `user/message` 由谁 append | **06 在 `run()` 内 append**（推荐）。架构 §6 时序图把 append 画在 run 之前，但 `run(input)` 收的就是 `text`；双写与"依赖调用方自觉"二选一，取前者 |
| Q3 | `turnNo` 来源 | **从 log 中 `turn/start` 计数推导**（推荐）。内存计数器在 resume 场景必然归零；计数 log 与灵魂 #2 同源 |
| Q4 | 单回合步数上限 | **模块常量 `MAX_STEPS_PER_TURN = 32`**（推荐），可通过插件选项/实例配置覆盖；**不新增 `Config` 字段**（避免动 01 与骨架级词汇） |
| Q5 | 工具结果在 log 中的顺序 | **接受完成序**（推荐）。`tool/result` 由 05 在 `run()` 内 append，要声明序就得串行化执行——等于放弃并发。风险：个别 provider 对 tool 消息顺序敏感；一旦出现 400，改法是 05 暴露"延迟 append"选项，不在 06 侧绕 |
| Q6 | `stream/chunk` 派发范围 | **四种 `StreamEvent` 全派发**（推荐），含 `end`；压缩请求**不派发** |
| Q7 | LLM 错误的处置 | **`aborted` 落前缀 + 正常结束回合；其余 `kind` 落 `turn/end` 后原样上抛**给 07（推荐）。06 不做重试/降级——错误分类是 02 专门为宿主准备的 |
| Q8 | usage 累加口径 | **每步取最后一个 `usage` 事件，跨步累加**（推荐），压缩请求的用量也计入 `totalUsage`（真实花销）。**注**：§4.6 初版伪代码漏了这一步，实现照伪代码写导致用量被丢，已由评审期 **Y1** 修复并补 3 例回归 |
| Q9 | 压缩检查时机 | **每 step 开头**（推荐）——与本 step 的 `read + deriveMessages` 复用同一次投影，零额外 IO，且保证任何一步发出去的请求都已过闸 |
| Q10 | 压缩切点 | ~~保留最近 `keepTurns` 个回合~~ → **实测不可行，语义订正为"摘要粒度"**（X2）。append-only 日志 + 位置切点下，compaction 只能写在末尾，它之前的一切都进摘要；`keepTurns` 改为"最近 N 个回合保留细节"的指令 |
| Q11 | 压缩失败 / 空摘要 | **跳过压缩 + `log.warn`**（推荐）。尤其空摘要必须守卫：append 空 summary 等于静默抹掉历史 |
| Q12 | 取消时卡在审批等待 | ~~06 用回合信号包装 `approve`~~ → **实测作废，改为原样透传**（X3）。05 的 `requestApproval` 已把回合信号纳入 race，取消得到 `cancelled`；06 再包装会造成"拒绝/取消"竞态 |
| Q13 | `dispose()` 是否等在途回合 | **abort + 等待收尾**（推荐），不设超时（沿用内核约定，07 用 `Promise.race` 兜底）。不等会让工具结果落在 03 的 store 清理之后 |

### 附：与 07 / 08 / 09 的职责边界

- **07（宿主）**：
  1. 默认 `plugins` 必须含 `builtin:agent-loop`（与"默认 plugins 非空"同一条 DoD）；
  2. 用 `registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId }))` 注入审批实现——**不注入则所有 `ask`（含权限兜底）失败关闭**，CLI 会"什么都不能写"；
  3. 想显示/复用会话 id ⇒ 监听 `session/append` 取 `session/header` 事件的 `id`（§8-Q1）；
  4. Ctrl+C 两段式：**第一次** `ctx.agent.resolve().cancel()`，**第二次**（或 `/exit`）才触发 `ctx.signal` / `shutdown`；
  5. 需捕获并分支处置 `LlmError`（按 `kind`）、`SessionError`、`BootError`；06 不吞这三类。
- **08 / 09（插件）**：与 06 无直接接口。唯一相关的是 `ToolDefinition.concurrency`——MCP 类远端 IO 工具建议 `'parallel'`（05 §8 附则同建议），本地有副作用工具建议 `'exclusive'`。
- **给后续模块的提醒**：`src/index.ts` 的转发面按"有没有下游插件消费者"判定，06 无下游消费者，故只做入向增补（`createBashTimeoutResolver`），不导出自身实现。
