# MiniDSH 骨架设计

> 状态：Reviewed（2026-10-16 所有者拍板 Q1–Q6，可进入 M0 模块设计）
> 版本：0.1.5（修订记录见 §12）
> 参考实现：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `86a402200d`

## 1. 项目定位

MiniDSH 是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh，~46 万行 TS 不含测试，含测试约 109 万行）的**架构级迷你复刻**：以约 1 万行 TypeScript 重写其 agent 骨架，保留四条设计灵魂，放弃全部产品化工程。

**保留的四条灵魂**（缺一条就不成立）：

1. **Everything is a plugin** —— 包括 agent loop、LLM adapter 在内的一切能力都以同一插件协议挂载，核心不知道任何具体能力的存在。
2. **Model-visible means logged** —— 模型可见的会话事实只来自 session log 的投影，不存在第二份"内存对话状态"。
3. **Guarded tool pipeline** —— 工具执行必须过 `schema 校验 → pre-execute（可否决）→ execute → post-execute` 管道。
4. **LLM adapter seam** —— provider 是可替换接口，DeepSeek 只是默认实现。

**明确不做**（与原版对照详见 §10）：Web UI、Electron、SDK/ACP 服务、HMR 与插件热卸载、Cordis 可逆 effects、session 多版本迁移、subagent/teams、MCP resources/prompts/sampling、sandbox、LSP、browser-use、telemetry、i18n、npm 插件分发。

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 22 LTS | 内置 `fetch`、`AbortController`、`--watch`，流式处理不引第三方库 |
| 语言 | TypeScript 5.x，`strict: true`，ESM only | 与原版对齐 |
| 构建 | `tsc` 直出到 `dist/`，`bin` 入口 `mdsh` | 规模小，不需要 bundler |
| **运行时依赖** | **零**（0 dependencies） | 1 万行内看清全部机制是本项目目的；SSE 解析、JSON Schema 校验、MCP 客户端全部手写 |
| 开发依赖 | `typescript`、`@types/node`、`tsx`、`vitest`、`eslint`（flat config） | 常规；lint 是 DoD 门禁之一（process.md §7） |
| 包管理 | pnpm | 与原版一致；`typecheck` / `lint` / `test` 均为 pnpm scripts |
| 配置格式 | JSON（`minidsh.json`） | 零依赖原则 > YAML 人体工学（§11-Q2 决议） |
| 测试 | vitest，只测三块核心语义（见各模块文档） | 测试代码不计入产品 LOC 预算 |

## 3. 总体架构

```text
┌─────────────────────────── 宿主 · src/cli ────────────────────────────┐
│  REPL · 流式渲染 · 权限询问 · slash 命令（/compact /resume /model …）   │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ boot(config)：按配置顺序挂载插件
┌────────────────────────────────▼──────────────────────────────────────┐
│                     插件内核 · src/plugin                              │
│      definePlugin · EventBus（通知 + 瀑布拦截） · Ctx 组装 · 组合根     │
└───┬──────────┬──────────┬───────────┬───────────┬───────────┬──────────┘
    │ctx.llm   │ctx.sessions│ctx.tools │ctx.prompt │ctx.agent  │ctx.events
    ▼          ▼           ▼           ▼           ▼           ▼
┌─────────┐┌─────────┐┌──────────┐┌─────────┐┌──────────┐┌──────────┐
│ llm/    ││ session/││ tools/   ││ prompt/ ││ agent/   ││ 插件们    │
│ adapter ││ JSONL   ││ registry ││ section ││ turn/step ││ memory   │
│ seam    ││ log+投影││ +pipeline││ 拼装    ││ loop     ││ mcp      │
└─────────┘└─────────┘└──────────┘└─────────┘└──────────┘└──────────┘
     ▲ 每个框内模块本身也是插件，经同一协议挂载，无任何隐式内建通道 ▲
```

两条不变量：

- **组合根是唯一的装配点**：任何模块都不得被宿主直接 import 调用，一切经 `ctx` 服务面交互。
- **插件只通过 ctx 交互**：插件间不 import 彼此，跨插件影响只能经由注册的服务或事件（这正是原版 "no privileged core" 的最小保留）。

## 4. 模块分解与依赖顺序

| # | 模块 | 职责一句话 | 预算 | 依赖（须先 Baseline） |
|---|---|---|---:|---|
| M0 | 骨架 | 契约类型 + 插件内核 + 组合根 + 冒烟测试 | ~1.2k | — |
| 01 | config | 配置加载、默认值合并、权限策略解析 | ~0.4k | M0 |
| 02 | llm | adapter 接口 + OpenAI 兼容 SSE 流式客户端 | ~1.5k | M0 |
| 03 | session | append-only JSONL + `deriveMessages()` + resume | ~1.5k | M0 |
| 04 | prompt | prompt section 注册与拼装 | ~0.5k | M0 |
| 05 | tools | 注册表 + guarded pipeline + 6 内置工具 | ~2.5k | 03（结果入 log） |
| 06 | agent | turn/step loop + 并行调度 + 取消 + compaction | ~2.0k | 02, 03, 04, 05 |
| 07 | cli | REPL 宿主 + slash 命令 | ~1.0k | 06 |
| 08 | plugin-memory | MEMORY 文件记忆 + `memory` 工具 | ~0.2k | 05 |
| 09 | plugin-mcp | MCP stdio 客户端（tools/list + tools/call） | ~0.7k | 05 |
| | **合计** | | **~11.5k**（目标 ~10k，允许浮动，硬上限 20k，见 process.md §6） | |

依赖方向单一，无环；实现顺序即编号顺序，一次一个模块。

```text
M0 ──► 01 ──► 02 ──► 03 ──► 04 ──► 05 ──► 06 ──► 07
                                        ├──► 08
                                        └──► 09
```

## 5. 骨架契约（本文档的核心）

以下契约在 M0 中以**类型 + 内核实现**落地，后续模块文档不得改动签名（改动 = 修改本基线文档并重新 review）。实现细节一律留给模块设计文档。

### 5.1 插件协议

```ts
export interface Ctx { /* 见 5.2，M0 实现时逐服务以 stub 形态就位 */ }

export interface Plugin {
  name: string
  /** config 为 plugins[].config 的实例级配置（组合根注入），无则 undefined；插件自行 narrow */
  setup(ctx: Ctx, config?: unknown): void | Promise<void>
  /** 仅进程退出时调用；无热卸载（对照原版的砍点，见 §10） */
  dispose?(): void | Promise<void>
}

export type PluginFactory = () => Plugin | Promise<Plugin>
export function definePlugin(factory: PluginFactory): PluginFactory
```

挂载规则：

1. 组合根按 `config.plugins` 数组**顺序**串行执行 `await plugin.setup(ctx, entry.config)`；任一失败则启动失败（fail-fast，不做部分可用）。插件实例级配置（`plugins[].config`）由组合根作为 `setup` 第二参数注入——ctx 只承载全局态，不混入单插件配置。
2. 插件来源两种：`builtin:<name>`（核心内置插件表）与相对/绝对路径（本地插件，`import()` 加载其 `default` 导出）。
3. 同名注册（工具、adapter、prompt section id）抛错；`ctx` 上每个服务面在 M0 以最小实现或 stub 就位（见 5.2），由对应模块实现后以**同一插件**形式挂载（eat own dogfood：`builtin:llm`、`builtin:session` 本身就是插件）。

### 5.2 Ctx 服务面

```ts
export interface Ctx {
  readonly config: Config                 // 01：冻结的最终配置
  readonly events: EventBus                // 5.3
  readonly llm: LlmRegistry                // 02：register(name, factory) / resolve(name)
  readonly tools: ToolRegistry            // 05：register(def) / list() / get(name)
  readonly prompt: PromptRegistry          // 04：section(...) / render()
  readonly sessions: SessionStore          // 03：create / open / append / subscribe
  readonly agent: AgentRegistry            // 06：register(ctl) / resolve() —— 由 builtin:agent-loop 注册
  readonly log: Logger                     // M0：level 过滤 + stderr
  readonly signal: AbortSignal             // M0：进程级取消信号，仅在进程退出流程触发（见下）
}
```

取消信号边界：**`ctx.signal` 只承载进程级退出信号，与单回合取消是两条独立通道**。REPL 拦截 Ctrl+C 时先解释为"取消当前回合"（调用 `AgentControl.cancel()`）；连续两次 Ctrl+C 或显式退出命令（`/exit`）才触发 `ctx.signal`。工具执行同时观察两者：`cancel()` 使在途调用转为 `cancelled` 结果，`ctx.signal` 触发时进程内所有在途操作一并中止。任何模块不得把 `ctx.signal` 当作回合级取消使用。

各服务面在 M0 均以可实例化的最小实现或明确 `throw('not mounted')` 的空实现交付，签名以下为准：

```ts
interface LlmRegistry   { register(name: string, factory: LlmAdapterFactory): void
                          resolve(name: string): LlmAdapterFactory }
interface ToolRegistry  { register(def: ToolDefinition): void       // ToolDefinition 见 §5.4
                          list(): ReadonlyArray<ToolDefinition>
                          get(name: string): ToolDefinition }
interface PromptRegistry{ section(s: PromptSection): void
                          render(): string }
interface SessionStore  { create(opts: SessionInit): Promise<Session>
                          open(id: string): Promise<Session>     // resume
                          list(): Promise<SessionMeta[]>
                          read(id: string): Promise<SessionEvent[]>   // 0.1.5 新增，见 §5.4 下方说明
                          append(sessionId: string, event: SessionEvent): Promise<void>
                          subscribe(sessionId: string, fn: (e: SessionEvent) => void): Unsubscribe }
interface AgentRegistry  { register(ctl: AgentControl): void
                          resolve(): AgentControl }              // 未注册时 resolve 抛 'not mounted'
interface AgentControl  { run(input: UserInput): Promise<TurnSummary>
                          cancel(reason?: string): void }        // 取消当前回合，见 §5.2 取消信号边界
```

adapter 解析约定：06 模块调用 `ctx.llm.resolve(config.model.provider)` 获取 adapter 工厂——resolve 的 name 即 provider 名，默认值不另设字段；未知 provider 由 `resolve` 抛错，启动时（或首次回合时）fail-fast。

装配语义统一说明：**`Ctx` 的每个服务面都是内核在 M0 创建的容器对象（readonly 引用恒定），插件只往容器里注册实现，从不替换引用本身**——registry 型服务面（llm/prompt/agent）由对应 builtin 插件 `register` 填充，其余服务面由内核在 M0 直接交付最终实现。`PromptRegistry.render()` 按 `order` 排序拼装全部 section，产出整体作为 `LLMRequest.system`（工具 schema 由 05 模块以一个 prompt section 注册，保持 render 是系统提示的唯一出口）。

### 5.3 事件总线

两类事件，静态类型表（M0 定表，后续模块可增补行，增补 = 改本文档）：

| 通知事件（fire-and-forget，同步） | 载荷 |
|---|---|
| `plugin/mounted` | `{ name }` |
| `session/append` | `{ sessionId, event }` |
| `turn/start` `turn/end` | `{ sessionId, turnNo }` |
| `step/start` `step/end` | `{ sessionId, turnNo, stepNo }` |
| `stream/chunk` | `{ sessionId, delta }`（增量文本/工具调用片段） |
| `tool/start` `tool/end` | `{ sessionId, callId, name }` |

| 瀑布事件（串行 `await`，可修改载荷，可否决） | 载荷 | 谁否决、效果 |
|---|---|---|
| `llm/request` | `LLMRequest` | 插件改写请求（换 model、注入预算说明），不否决 |
| `tools/pre-execute` | `ToolInvocation` | CLI 权限监听器抛 `ToolRejected` → 结果为 permission denied |
| `tools/post-execute` | `ToolResult` | 插件改写结果（截断、脱敏） |

```ts
interface EventBus {
  on<K extends keyof NotificationMap>(type: K, fn: (p: NotificationMap[K]) => void): Unsubscribe
  emit<K extends keyof NotificationMap>(type: K, payload: NotificationMap[K]): void
  onWaterfall<K extends keyof WaterfallMap>(type: K, fn: (p: WaterfallMap[K]) => WaterfallMap[K] | void | Promise<WaterfallMap[K] | void>): Unsubscribe
  waterfall<K extends keyof WaterfallMap>(type: K, payload: WaterfallMap[K]): Promise<WaterfallMap[K]>
}
```

- 瀑布语义：监听器经 `onWaterfall` 注册，派发时按注册序执行；listener 返回同构对象则替换载荷继续，返回 `undefined` 保持原载荷；抛错即否决，错误上抛给调用方（pipeline 捕获 `ToolRejected` 转为 denied 结果）。
- 通知事件错误策略：`emit` 同步派发，单个监听器抛错**捕获后经 `ctx.log` 记 stderr，不影响其余监听器与主流程**；`emit` 本身永不抛错。
- 与原版对照：原版三域事件 + 串行/瀑布/纯通知三种派发，这里压缩为两域两种（§10）。

### 5.4 核心数据类型（跨模块词汇表）

```ts
type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }   // content: 序列化结果/错误

interface LLMRequest { system?: string                   // 现场拼装的系统提示（§6），不入 session log
                       messages: ChatMessage[]; model: string
                       tools: ToolSchema[]                 // 模型可见面：由 05 从已注册 ToolDefinition 投影
                                                           // { name, description, schema }，非独立定义
                       maxTokens?: number; signal: AbortSignal }
type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; delta: ToolCallDelta }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'end' }
interface LlmAdapter { stream(req: LLMRequest): AsyncIterable<StreamEvent> }
```

工具契约（05 实现，签名以下为准）：之所以放在骨架层定义，是因为它同时被 04（schema 作为 prompt section 的模型可见面）与 06（并发调度依据）消费，属跨模块词汇。

```ts
/** 参数 JSON Schema 最小子集；校验器手写（零依赖），不支持 $ref 与组合关键字 */
interface JsonSchema { type: 'object'
                       properties: Record<string, unknown>
                       required?: string[]
                       additionalProperties?: boolean }

interface ToolDefinition {
  name: string                    // 权限策略按此名匹配（config.permissions，匹配规则见本节下方，Q6 决议）
  description: string
  schema: JsonSchema
  /** 并发属性：默认 'parallel'——可与本 step 内其他 parallel 工具并发，受 config.tools.maxParallel 限制；
   *  'exclusive' 为独占屏障：等待在途调用全部结束后单独执行，执行期间不与任何工具并发 */
  concurrency?: 'parallel' | 'exclusive'
  /** 只返回结果文本，ToolResult 由 pipeline 组装；抛错由 pipeline 转为失败结果（见下） */
  execute(args: Record<string, unknown>, env: ToolEnv): Promise<string>
}

interface ToolEnv { callId: string; sessionId: string; signal: AbortSignal }

interface ToolInvocation { callId: string; name: string; args: Record<string, unknown>
                           sessionId: string; turnNo: number; stepNo: number }
interface ToolResult { callId: string; name: string; ok: boolean
                       content: string                 // 序列化结果或错误文本，同时入 log 与回模型
                       error?: { code: ToolErrorCode; message: string } }
type ToolErrorCode = 'invalid_args' | 'permission_denied' | 'execution_error' | 'timeout' | 'cancelled'
```

pipeline 产出约定（对应灵魂 #3）：`schema 校验` 失败 → `ok:false` + `invalid_args`；`pre-execute` 抛 `ToolRejected`（§5.3）→ `permission_denied`；`execute` 抛错/超时/取消 → `execution_error` / `timeout` / `cancelled`。**任何分支都产出 `ToolResult` 并 `append(tool/result)`，不向上抛**——错误是工具结果的一种，不是异常路径。超时来源：仅对声明了 `timeoutMs` 配置的工具生效（如 `config.tools.bash.timeoutMs`），其余工具默认无超时、仅受取消信号约束；具体配置面归 05 模块设计。

权限匹配规则（01 与 05 共同遵守，Q6 决议）：

1. **精确键优先**：工具名先与 `permissions` 中的精确键匹配（如 `bash`），命中即用其策略。
2. **通配键次之**：未命中精确键时匹配通配键，取**前缀最长**的命中者（同长时取声明序在前者）；通配键仅支持 `前缀*` 形式（如 `mcp__*` 匹配所有 `mcp__` 开头的工具名），不做完整 glob。
3. **兜底**：全部未命中时按 `ask` 处理；不支持裸 `"*"` 键（配置中出现视为校验错误，启动失败）。

> **规则 2 修订（2026-10-16，01 模块 review 提出，所有者已复核采纳）**：原决议为"按声明序取首个命中"。01 实现时发现 `permissions` 是三层配置**逐键深合并**的产物，合并后的键序由"哪一层先被合并"决定（全局层键恒排在项目层之前），与用户在任一文件里看到的书写顺序都不一致。于是全局层的宽泛规则（`mcp__*`）会永久压住项目层更严格的规则（`mcp__github*`）——**权限收紧静默失效**，且无任何诊断。改判"最长前缀"后语义退化为"更具体的规则总是赢"，不再依赖不可见的键序。影响面：01 的 `resolvePermission` 与 05 的 pre-execute 调用。

Session log 事件表（M0 定枚举，03 模块定字段细节）：

| 事件 | 语义 |
|---|---|
| `session/header` | 会话元信息（id、createdAt、provider、model、cwd） |
| `turn/start` / `turn/end` | 回合边界 |
| `user/message` | 用户输入（模型可见） |
| `assistant/message` | 模型一次完整回复：文本 + toolCalls + usage + `interrupted?`（取消时落已送达前缀） |
| `tool/result` | 单个工具调用的结果/错误（按 `toolCallId` 关联） |
| `compaction` | 压缩边界事件：`{ summary, boundary }`，投影时替换边界之前的历史 |

注意：log 事件与 §5.3 总线事件是**两套独立命名空间**（前者持久化、后者进程内派发）。`turn/start` 等同名仅表语义对应，载荷结构不同，代码中以各自的类型表区分。

**对照原版的两处偏离**（须 review 认可）：

- `tool/call` 不单独成事件，并入 `assistant/message.toolCalls`（原版为独立 durable 事件）。
- 系统提示**不入 log**，每次请求由 prompt sections 现场拼装（原版把 prompt 作为 `system/message` 日志化）。理由：mini 版 prompt 由配置与插件确定，可重建，日志化收益不抵复杂度；"logged" 原则只约束会话事实。

### 5.5 组合根与启动序列

```text
mdsh [flags]                        # 宿主
 └─ loadConfig()                    # 01：全局 ~/.minidsh/config.json → 项目 minidsh.json → flags 逐层合并
 └─ boot(config)
     ├─ new EventBus / Ctx / signal
     ├─ 解析 plugins:[] → PluginFactory 列表
     ├─ 依序 await setup(ctx, entry.config)   # 每个挂载成功 emit plugin/mounted
     └─ 任一失败 → 打印已挂载名单 + 错误，退出码 1
 └─ REPL（07）                      # ctx.agent.resolve().run(...) 驱动回合
```

M0 阶段 01-config 尚未实现：冒烟测试使用组合根内硬编码的最小 config（仅含默认 plugins 数组），01 Baseline 后切换为 `loadConfig()`。

**config 不属于插件系统**：`loadConfig()` 由宿主在 `boot()` 之前调用，结果冻结后注入 `Ctx.config`；01 模块交付的是这个函数的实现，不以插件形式挂载，因此它不在 §8 的 `plugins` 列表内（不与 `builtin:llm` 等并列）。

## 6. 一个回合的数据流（骨架级时序）

```text
用户输入 ──► sessions.append(user/message)
        └─ ctx.agent.resolve().run()
              turn/start
              ┌─ step:
              │   system = ctx.prompt.render()   # sections 现场拼装（工具 schema 亦为 section）→ req.system
              │   messages = deriveMessages(session)    # log 投影，唯一事实源
              │   req = events.waterfall('llm/request', {…})
              │   for await ev of adapter.stream(req)    # 02
              │       emit stream/chunk ──► CLI 渲染
              │   sessions.append(assistant/message)    # 取消则落 interrupted 前缀
              │   无 toolCalls ──────────────► turn/end
              │   调度工具：依 ToolDefinition.concurrency（§5.4）
              │   parallel 组并发(≤maxParallel) / exclusive 独占屏障
              │   each: pre-execute(权限) → execute → post-execute
              │   sessions.append(tool/result ×N)
              └──► 下一个 step
              压缩检查（06）：token 估算超阈值 → summary 请求 → append(compaction)
```

## 7. 目录与存储布局

```text
mini-dsh/
├── docs/                    # 本文档 + process.md + design/NN-*.md
├── src/
│   ├── contracts.ts          # M0：§5 全部类型（跨模块词汇的唯一出处）
│   ├── plugin/              # M0：definePlugin、EventBus、Ctx、组合根 boot()
│   ├── config/ llm/ session/ prompt/ tools/ agent/ cli/   # 依编号逐模块实现
│   └── index.ts             # 导出 public API（SDK 面，薄）
├── plugins/
│   ├── memory/  mcp/        # 08/09，走同一插件协议
└── package.json  tsconfig.json  vitest.config.ts

~/.minidsh/
├── config.json              # 全局配置：跨项目默认值（默认 provider/model、权限策略等），项目级 minidsh.json 优先覆盖；API key 一律走环境变量，不落盘
├── memory/MEMORY.md         # 08 插件
└── sessions/<id>/session.jsonl   # 03：一会话一目录一文件（§11-Q4 决议）
```

## 8. 配置形态（骨架级示例；字段细节归 01 模块文档）

```jsonc
{
  "model": { "provider": "deepseek", "name": "deepseek-chat",
             "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY" },
  "contextWindow": 131072,
  "tools": { "maxParallel": 4, "bash": { "shell": "auto", "timeoutMs": 120000 } },
  "compaction": { "thresholdRatio": 0.8, "keepTurns": 4 },
  "permissions": { "read": "auto", "glob": "auto", "grep": "auto",
                   "write": "ask", "edit": "ask", "bash": "ask", "mcp__*": "ask" },
  "plugins": [
    { "source": "builtin:llm" }, { "source": "builtin:session" },
    { "source": "builtin:prompt" }, { "source": "builtin:tools" },
    { "source": "builtin:agent-loop" },
    { "source": "./plugins/memory" },
    { "source": "./plugins/mcp",
      "config": { "servers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } } }
  ]
}
```

## 9. 里程碑与预算

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| M0 | 骨架：契约 + 内核 + 组合根 | 冒烟测试通过：挂载 toy 插件（注册 section + 收事件）全链路工作 |
| M1-M9 | 按 §4 编号逐模块 | 每模块走 process.md 五步循环 |
| 收尾 | README、总 LOC 复核 | 目标 ~10k，硬上限 ≤ 20k；预算偏差表归档 |

## 10. 与原版 deepseek-harness 对照

| 原版机制 | MiniDSH 处理 | 理由 |
|---|---|---|
| Cordis DI、可逆 effects、profiles/bundles/patch 分层、HMR | `definePlugin` 串行挂载，无卸载/热替换 | 保留"可替换"之形，砍掉运行时复杂度大头 |
| 三域事件（session/agent/capability），串行+瀑布+通知 | 单一总线，通知 + 3 个瀑布事件 | 扩展点语义保留，派发种类收敛 |
| agent inbox 持久投影、claim 语义 | FIFO promise 队列 | 回合内串行即可 |
| request/header 系列、freeze evidence、runtime context reconcile | 每步现场组装请求 | 重放语义服务于强持久恢复，mini 不承诺 |
| system prompt 日志化（system/message） | 不入 log（§5.4 偏离） | 可重建性成立 |
| session 多版本迁移链、zstd、generation | 单版本 JSONL | 迁移体系服务于升级兼容，mini 无历史包袱 |
| compaction 全家（basic/image-offload/result-pruner、spill） | 单一 summarize 策略 + 工具输出截断 | 覆盖长会话主路径 |
| capability seams（fs/subprocess 可换远程沙箱） | 工具直连本地实现 | 换执行世界是产品能力，非骨架 |
| 记忆 = MCP 生态（第三方 server） | memory 插件 + mcp 插件，均非核心 | 与原版决策一致：记忆来自插件 |

## 11. 开放问题（已全部拍板，2026-10-16 所有者决议）

| # | 问题 | 决议 |
|---|---|---|
| Q1 | Windows 下 `bash` 工具的默认 shell | `shell: "auto"`：检测到 `bash`（Git Bash）用之，否则回退 PowerShell；可在配置中固定 |
| Q2 | 配置格式 | JSON（零依赖原则优先） |
| Q3 | bin 命名 | `mdsh` |
| Q4 | 会话文件布局 | `~/.minidsh/sessions/<id>/session.jsonl`（一会话一目录，为附件留位） |
| Q5 | §5.4 两处 log 偏离（tool/call 并入 assistant、prompt 不入 log） | 接受 |
| Q6 | `permissions` 通配符匹配规则 | 精确键 > `前缀*` 通配键；未匹配兜底 `ask`；不支持裸 `*`（见 §5.4 权限匹配规则） |

## 12. 修订记录

本基线文档的每次改动登记于此，review 时以本节为准（改动 = 重新 review）。

| 版本 | 修订内容 |
|---|---|
| 0.1.0-draft | 初稿：定位、模块分解、骨架契约（§5）、对照表与开放问题 |
| 0.1.1-draft | 系统提示入口收敛为 `PromptRegistry.render()` 唯一出口；瀑布事件的注册 API 定为 `onWaterfall`；agent 装配语义明确为“容器对象引用恒定、插件只注册不替换”；LOC 统计口径（排除测试、逐模块预算） |
| 0.1.2-draft | §5.4 补工具契约（`ToolDefinition` / `ToolInvocation` / `ToolResult` / `ToolErrorCode`）及其 pipeline 产出约定 —— 因工具定义同时被 04 与 06 消费，属跨模块词汇；§5.5 明确 config 非插件、由宿主在 boot 前冻结注入；§11 增补 Q6（permissions 通配符匹配规则）；新增本节作为修订落点 |
| 0.1.3 | 所有者拍板 Q1–Q6（§11 改为决议表），状态 Draft → Reviewed；§5.2 补取消信号边界（`ctx.signal` 仅进程级，回合取消走 `cancel()`，Ctrl+C 两段式）与 adapter 解析约定（resolve name = `config.model.provider`，未知 provider fail-fast）；§5.3 补通知事件错误策略（监听器抛错记 log、emit 永不抛）；§5.4 补超时来源说明与权限匹配规则（精确键 > `前缀*` 通配 > 兜底 `ask`，裸 `*` 视为配置错误） |
| 0.1.5 | §5.2 给 `SessionStore` **新增** `read(id): Promise<SessionEvent[]>`（03 设计 §2.4 D1 / §8-Q1，所有者 2026-10-17 拍板）：原契约只写不读（`create/open/list/append/subscribe` 无任何取回事件序列的口子），而 §6 要求 `messages = deriveMessages(session)`——投影没有输入来源。补 `read` 前，06 只剩三条路且均不可接受：用 `subscribe` 自建内存投影（违反灵魂 #2）、让 `open()` 返回的 `Session` 挂 `events` 快照（经容器后静态类型塌缩为 `Session`，需 downcast，且"句柄即快照"语义模糊）、直接 import 03 内部模块（违反"插件间不 import 彼此"）。纯新增方法，不改动任何既有签名；同步落点：`src/contracts.ts`、`src/plugin/containers.ts`（委托）、`src/plugin/containers.test.ts` |
| 0.1.4 | §5.4 权限匹配规则 2 修订：通配键由"声明序取首个命中"改判"**最长前缀**优先（同长时取声明序在前者）"。理由：`permissions` 是三层逐键深合并产物，键序由合并层序决定（全局层键恒前于项目层），按声明序会让全局层宽泛规则（如 `mcp__*`）永久压住项目层更严格规则（如 `mcp__github*`），权限收紧静默失效且无诊断。改判后语义为"更具体的规则总是赢"，不再依赖不可见的键序。影响面：01 `resolvePermission`、05 pre-execute |
