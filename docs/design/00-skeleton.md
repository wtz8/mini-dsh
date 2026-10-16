# M0 骨架设计

> 状态：Reviewed（2026-10-16 所有者接受评审意见，R1–R4 已拍板，见 §8 决议表）
> 预算：~1.2k 行（src/contracts.ts + src/errors.ts + src/plugin/ + src/index.ts，不含测试）
> 上游依赖：architecture.md 0.1.3（Reviewed）；process.md（Reviewed）
> 交付物：契约类型 + 插件内核 + 组合根 + 公共 API 出口 + 冒烟测试，完成标准见 architecture.md §9

## 1. 背景与目标

M0 是全部后续模块的地基，一次性交付四件事：

1. **契约类型**（`src/contracts.ts`）：骨架设计 §5 全部类型的唯一定义处，包括此前 review 留白的跨模块词汇（`ToolCall`、`ToolCallDelta`、`TokenUsage`、`SessionEvent`、`Session`、`UserInput`、`TurnSummary`、`PromptSection`、`Config` 等）与事件总线的**静态类型表**（`NotificationMap` / `WaterfallMap`）。**纯类型模块**，不放任何运行时值。
2. **插件内核**（`src/plugin/`）：`definePlugin`、`EventBus`（通知 + 瀑布两域）、`Ctx` 容器组装、`Logger`、进程级 `signal`。
3. **组合根**（`src/plugin/boot.ts`）：按配置顺序挂载插件、builtin 插件表、失败即清理并中止。
4. **错误类**（`src/errors.ts`）与**公共 API 出口**（`src/index.ts`）：运行时错误类（`ToolRejected` / `BootError`）不进 contracts.ts；`index.ts` 薄导出全部类型 + `definePlugin` + `registerBuiltin` + `boot`/`shutdown` + 错误类——插件作者（含各 builtin 插件与 toy 插件）一律经此 import，不深引用内部路径。

   其中 `registerBuiltin(name, factory): Unsubscribe` 是 builtin 插件表的唯一注册入口（X6）：表本身是 `boot.ts` 的模块级私有状态，02–09 各内置模块经此把自己注册进表，**不直接 import 内部的 Map**。返回退订句柄供测试与进程内重挂载使用。

M0 不实现任何具体能力（LLM、session 持久化、工具执行都是后续模块以 builtin 插件形式挂载），但**全部容器与服务面签名就位**——M0 之后任何模块都只需要"往容器里注册"，不再动内核。

完成标准（architecture.md §9）：冒烟测试通过——挂载 toy 插件（注册 prompt section + 收发事件）全链路工作。

## 2. 对外契约

### 2.1 补齐的留白类型（进 `contracts.ts`）

以下类型在骨架设计 §5 中被引用但未定义，M0 补齐定义（写法为最终签名，后续模块不得改动；字段细节按注明归属到对应模块细化）：

```ts
/** 模型侧看到的完整工具调用；arguments 为原始 JSON 字符串（delta 拼接产物），
 *  解析与校验由 05 的 pipeline 负责，agent 层不解释 */
interface ToolCall { id: string; name: string; arguments: string }

/** 流式过程中的工具调用增量片段（OpenAI 兼容分片风格） */
interface ToolCallDelta { index: number; id?: string; name?: string; argumentsDelta?: string }

/** token 用量；totalTokens 可选（provider 不给就不填） */
interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens?: number }

/** 模型可见的工具投影：由 05 从 ToolDefinition 生成，非独立定义 */
interface ToolSchema { name: string; description: string; schema: JsonSchema }

/** adapter 工厂：接收 model 配置构造 adapter（baseUrl/apiKeyEnv 归 01 的 ModelConfig） */
type LlmAdapterFactory = (model: ModelConfig) => LlmAdapter

/** prompt section：render 同步返回文本；order 小者在前，同 order 按 section id 字典序 */
interface PromptSection { id: string; order: number; render(): string }

/** 用户输入；mini 版仅文本 */
interface UserInput { text: string }

/** 一个回合的汇总（AgentControl.run 的返回值） */
interface TurnSummary { turnNo: number; stepCount: number; totalUsage: TokenUsage; interrupted: boolean }

/** 通用退订句柄 */
type Unsubscribe = () => void
```

**事件总线静态类型表**（架构 §5.3 只给了表格未给签名，M0 补齐；两张表封闭，新增行 = 改基线文档）：

```ts
/** 通知事件载荷表（fire-and-forget）。stream/chunk 的 delta 即 adapter 产出的流事件本体
 *  （StreamEvent，骨架 §5.4）；06 决定对其中哪些子类型派发本事件，本表只定载荷类型 */
interface NotificationMap {
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

/** 瀑布事件载荷表（串行 await，监听器可替换载荷、可否决） */
interface WaterfallMap {
  'llm/request': LLMRequest
  'tools/pre-execute': ToolInvocation
  'tools/post-execute': ToolResult
}
```

**运行时值的落点**（contracts.ts 保持纯类型模块）：`ToolRejected`（pre-execute 否决专用异常，05 的 pipeline 捕获后转 `permission_denied` 结果）与 `BootError`（见 §4.1，携带 `mounted: string[]`）定义在 `src/errors.ts`。骨架设计未指定错误类的文件归属，此为澄清而非偏离。

### 2.2 Session 词汇（枚举 M0 定，字段细节 03 细化）

```ts
/** append-only 会话日志事件；投影语义（deriveMessages）归 03 */
type SessionEvent =
  | { type: 'session/header'; id: string; createdAt: string; provider: string; model: string; cwd: string }
  | { type: 'turn/start'; turnNo: number }
  | { type: 'turn/end'; turnNo: number }
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string; toolCalls?: ToolCall[]; usage: TokenUsage; interrupted?: boolean }
  | { type: 'tool/result'; toolCallId: string; result: ToolResult }
  | { type: 'compaction'; summary: string; boundary: number }  // boundary: turnNo，投影时替换该回合之前的历史

interface SessionMeta { id: string; createdAt: string; provider: string; model: string; cwd: string }
interface Session { id: string; meta: SessionMeta }
interface SessionInit { provider: string; model: string; cwd: string }
```

与骨架设计 §5.4 事件表逐行对应；`tool/result` 以 `toolCallId` 关联（与 `ToolResult.callId` 同值）。03 模块可增补**已有变体的字段**，但不得改已有字段语义；**变体集合对 03 封闭**——新增事件类型会同时影响 `deriveMessages` 与全部消费者，视同修改基线（须走 architecture.md §5.4 事件表的基线修订与重新 review），不得在模块内擅自增补。

### 2.3 Config 骨架级形状（校验/合并/默认值归 01）

```ts
/** 权限策略三值（R1 决议）：auto = 直接执行；ask = 询问用户；deny = 静默拒绝
 *  —— 05 直接产出 permission_denied 结果，不询问用户（与 ask 的本质区别） */
type PermissionAction = 'auto' | 'ask' | 'deny'
interface ModelConfig { provider: string; name: string; baseUrl: string; apiKeyEnv: string }
interface PluginEntry { source: string; config?: unknown }
interface Config {
  model: ModelConfig
  contextWindow: number
  tools: { maxParallel: number; bash: { shell: 'auto' | 'bash' | 'powershell'; timeoutMs: number } }
  compaction: { thresholdRatio: number; keepTurns: number }
  permissions: Record<string, PermissionAction>   // 匹配规则见架构 §5.4（Q6 决议），解析归 01
  plugins: PluginEntry[]
  logLevel?: 'debug' | 'info' | 'warn' | 'error'   // R4 决议：Logger 过滤级别，默认 'info'（默认值合并归 01）
}
```

M0 不实现 `loadConfig()`（01 交付），冒烟测试用组合根内硬编码的最小 config。**字段增补规则**：后续模块（如 03 需要数据目录）可在不改变既有字段语义的前提下增补字段，但增补必须回写本节——`Config` 是骨架级词汇，不归任何单一模块私有。整个 config（含 `plugins[].config`）经 `deepFreeze` 冻结后注入，插件不得修改自身实例配置。**冻结归属恒定为 `boot()`**：01 交付的 `loadConfig()` 只负责加载与合并、不做冻结，`boot()` 内的 `deepFreeze` 在 01 Baseline 前后保持不变——直接调用 `boot()` 的调用方（测试）拿到的冻结语义恒定，01 接管加载后无需回改内核。

### 2.4 与骨架设计契约草图的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | `ctx.sessions` 的容器类型为 `SessionStoreContainer extends SessionStore`，新增一次性 `mount(impl: SessionStore): void`（第二次调用抛错；未 mount 前所有方法抛 `'not mounted'`）；**`Ctx.sessions` 的声明类型即 `SessionStoreContainer`**（`SessionStore` 的子类型，不违反骨架 §5.2 的签名），03 的 `builtin:session` 插件经 `ctx.sessions.mount(impl)` 注入实现 | 骨架 §5.2 的 `SessionStore` 签名本身不变；但 `Ctx` 引用 readonly 恒定，而 session 实现由 03 的 `builtin:session` 插件在 setup 时挂载，需要一个一次性的注入通道。这是对 §5.2 "装配语义统一说明"的**澄清而非偏离**：内核交付的是容器，最终实现由插件 mount |
| D2 | 内核导出 `shutdown(ctx: Ctx): Promise<void>`，按挂载**逆序**调用各插件 `dispose()`，dispose 抛错记 log 不上抛 | 骨架只说"进程退出时调用 dispose"，未定调用方与顺序；07 CLI 在退出流程调用 |
| D3 | `LlmAdapterFactory` 签名定为 `(model: ModelConfig) => LlmAdapter` | 骨架只写了 `register(name, factory)`，工厂参数未定；adapter 需要 baseUrl/apiKey，从 Config.model 注入是唯一不引入新全局态的路径 |
| D4 | 事件静态类型表**有意封闭**：插件不能注册新的类型化事件（新增 = 改基线文档） | 明示架构 §5.3 的既有张力：这是"Everything is a plugin"的有意简化——扩展点收敛为注册服务面与监听既有事件，换取静态可检查的载荷类型 |
| D5 | `Ctx.sessions` 声明类型为 `SessionStoreContainer`（非 `SessionStore` 本身） | 子类型 widening，消费者按 `SessionStore` 用不受影响；显式声明才能让 03 插件调用 `mount` 而无需 downcast（D1 的类型面落实） |

## 3. 数据结构（内核内部）

```text
src/
├── contracts.ts       # §5 全部类型（纯类型模块，跨模块词汇唯一出处）
├── errors.ts          # 运行时错误类：ToolRejected / BootError
├── index.ts           # 公共 API 薄导出（类型 + definePlugin + boot/shutdown + 错误类）
└── plugin/
    ├── define-plugin.ts   # definePlugin：工厂身份透传（类型收窄糖）
    ├── event-bus.ts       # EventBus
    ├── logger.ts          # Logger：level 过滤 + stderr 输出
    ├── containers.ts      # Ctx 各服务面容器的最小实现
    ├── boot.ts            # 组合根 boot() / shutdown() / builtin 插件表
    └── ctx.ts             # Ctx 组装（容器注入，readonly 冻结）
```

**挂载序的持有方式**：`shutdown(ctx)` 是自由函数，内核在 `boot.ts` 内以模块级 `WeakMap<Ctx, Plugin[]>` 记录挂载序（boot 写入、shutdown 读取）——`Ctx` 本身不携带任何私有字段，禁止"往 ctx 上偷偷挂内部状态"的写法。

**EventBus**：两个 `Map<string, listener[]>`（通知表 / 瀑布表），按注册序追加。通知 `emit`：同步遍历，单个监听器抛错 `try/catch` 后经 `ctx.log.error` 记录，继续下一个，`emit` 本身永不抛（架构 §5.3 决议）。瀑布 `waterfall`：`for await` 串行，返回值非 `undefined` 则替换载荷，抛错即否决上抛。

**容器**（全部由内核在 boot 时创建，readonly 引用注入 Ctx）：

- `LlmRegistry` / `ToolRegistry` / `PromptRegistry` / `AgentRegistry`：真实最小实现——`register` 查重（重复名抛错）、`resolve`/`get` 未注册抛 `'not mounted'`；`PromptRegistry.render()` 按 `order` 升序、同序按 id 字典序拼接（分隔符 `\n\n`）。
- `SessionStoreContainer`：见 D1，委托式容器。
- `Logger`：`debug/info/warn/error(msg: string, ...meta: unknown[])`；level 取 `config.logLevel`（R4 决议，缺省 `'info'`），输出到 stderr。
- `signal`：boot 内 `new AbortController()`，`ctx.signal` 即其 `signal`；触发逻辑（Ctrl+C 两段式）归 07，M0 只暴露通道。

**builtin 插件表**：`Map<string, PluginFactory>`，M0 时为**空表**——`builtin:llm` 等随 02–06 各模块交付时注册进表中。冒烟测试的 toy 插件走本地路径 `import()`。

## 4. 核心流程

### 4.1 boot() 时序

```text
boot(config): Promise<Ctx>
 1. deepFreeze(config)                          # 递归冻结，含 plugins[].config；归属恒定为 boot（§2.3），01 的 loadConfig() 不冻结
 2. new AbortController → signal
 3. new Logger(level) → new EventBus(logger)    # level 取 config.logLevel，缺省 'info'
 4. 创建全部容器，组装 Ctx（readonly 冻结）
 5. for entry of config.plugins（数组顺序）:
      a. factory = entry.source 以 'builtin:' 开头 → 查 builtin 表（未命中抛 BootError）
         否则视为相对 cwd 的路径：
           url = pathToFileURL(path.resolve(process.cwd(), source))
           mod = await import(url) → 取 mod.default（失败 / 无 default / default 不是 factory 函数 抛 BootError）
         # 注意：ESM 相对说明符按导入者模块（src/plugin/boot.ts）解析，
         # 必须先基于 cwd 转绝对路径再转 file:// URL（Windows 盘符路径必需）
      b. plugin = await factory() → 形状校验（{ name: string, setup: function }，否则同步骤 a 的失败路径）
      c. 挂载序追加 plugin（WeakMap<Ctx, Plugin[]>）——在 setup **之前**追加：
         setup 半失败者同样要被逆序 dispose（X5），但不计入 BootError.mounted
      d. await plugin.setup(ctx, entry.config)   # 抛错 → 复用 shutdown 清理挂载序（§4.2，含本插件）
                                                 # → 抛 BootError，名单为挂载序剔除末位（fail-fast，不继续）
      e. events.emit('plugin/mounted', { name: plugin.name })   # 仅挂载成功才广播
 6. 返回 ctx
```

`BootError extends Error`，携带 `mounted: string[]`（已成功挂载的插件名）——07 CLI 负责打印名单与退出码 1；M0 冒烟测试断言其抛出与名单内容。boot 失败路径的清理即 R3 决议：**挂载失败不是"无副作用"的**——09 的 MCP 插件可能在 setup 中拉起 stdio 子进程，Windows 下父进程退出不保证子进程终止，因此失败前必须逆序 dispose 已挂载插件（dispose 抛错只记 log，不掩盖 BootError）。

### 4.2 shutdown() 时序

```text
shutdown(ctx): Promise<void>
  按挂载逆序对挂载序内每个插件调用 dispose?.()（存在才调用；名单来自 WeakMap，含 setup 半失败者）
  单个 dispose 抛错 → 记 log.error，继续下一个
  清空挂载序 → 幂等：重复调用不再触发第二轮 dispose
  最后 abort(signal controller)                # 触发 ctx.signal，中止在途操作（abort 本身幂等）
```

`shutdown` 语义服务两个调用方：正常退出（07 CLI 在退出流程调用）与 boot 失败清理（§4.1 步骤 d 复用同一流程）。**幂等**（X5）：07 的退出路径与信号路径可能各调一次，清空挂载序保证不会二次 dispose。

### 4.3 冒烟链路（测试视角）

```text
toy 插件 = definePlugin(() => ({ name: 'toy',
  setup(ctx) {
    ctx.prompt.section({ id: 'toy', order: 100, render: () => 'TOY SECTION' })
    ctx.events.on('plugin/mounted', () => received.push(...))
  } }))
boot({ ...最小 config, plugins: [{ source: '<toy 文件路径>' }] })
→ 断言：boot 成功；render() 含 'TOY SECTION'；plugin/mounted 事件收到（含 toy 自身）；
        sessions.append 等未挂载方法抛 'not mounted'；shutdown 后 dispose 被调用
```

## 5. 边界情况与错误处理

| 情况 | 行为 |
|---|---|
| 插件 `setup` 抛错 | 先按 §4.2 逆序 dispose **挂载序内的全部插件**（含半失败者本身，X5）→ 抛 `BootError`（名单为已成功挂载者，不含半失败者）——fail-fast，无部分可用 |
| `import()` 失败 / 无 default 导出 / default 不是函数 / builtin 名不存在 | 同上，`BootError`（该插件未挂载，不在名单内） |
| `factory()` 抛错 | 同上：先按 §4.2 逆序 dispose 已挂载插件，再抛 `BootError` |
| `factory()` 返回的不是插件（漏 `return`、导出任意对象/原始值） | 同上，归为"该插件未挂载"。**必须先做形状校验**：否则 `plugin.setup` 与失败路径里的 `plugin.name` 会以 `TypeError` 二次抛错，从而绕过清理、抛出的也不是 `BootError`（实现期实测到的 bug） |
| `shutdown` 被重复调用 | 幂等：第二轮不触发任何 dispose（挂载序已清空，X5）；`abort()` 本身幂等 |
| `boot()` 被重复或并发调用 | 未定义行为，M0 不做防护；调用方（07 CLI / 测试）自行保证全程仅调用一次 |
| 同名注册（adapter / tool / prompt section id） | `register` 时抛错 → 在 setup 内抛出 → 转 BootError |
| `resolve`/`get`/未 mount 的 SessionStore 方法 | 抛 `'not mounted'` |
| `SessionStoreContainer.mount` 第二次调用 | 抛错（一次性注入） |
| 通知事件监听器抛错 | 吞掉 + `log.error`，`emit` 永不抛 |
| 瀑布监听器抛错 | 上抛给 `waterfall` 调用方（否决语义） |
| `dispose` 抛错 | 记 log，继续逆序执行 |
| config 被插件尝试修改 | `deepFreeze` 后写入在 strict 模式下抛 `TypeError`（含 `plugins[].config`，插件不得修改自身实例配置） |
| boot 失败清理中 dispose 抛错 | 记 log，继续逆序执行；不掩盖 BootError 的上抛 |
| `setup` 超时 | **不设超时**——M0 无异步能力可依赖（fetch 属 02），挂载阶段信任插件；记为有意决策 |

## 6. 测试计划

### 6.1 单元测试（`src/plugin/*.test.ts`）

**EventBus**：通知按注册序派发与退订；监听器抛错被吞并记 log、后续监听器仍执行；瀑布串行顺序、返回对象替换载荷、返回 `undefined` 保持载荷、抛错上抛。

**容器**：四类 registry 的注册/查重/未挂载解析抛错；`PromptRegistry.render` 的 order 与同序 id 排序、分隔符拼接；SessionStoreContainer 未 mount 抛错 → mount 后委托 → 二次 mount 抛错。

**boot**：按数组顺序挂载（以 plugin/mounted 序断言）；`entry.config` 正确传入 setup 第二参；setup 抛错时先逆序 dispose 再抛 BootError（名单剔除半失败者、半失败者自身仍被 dispose、后续插件不执行）；builtin 未命中、路径 import 失败、default 导出不是函数、`factory()` 抛错、**`factory()` 返回非插件**五类 BootError（后三类同样先清理再上抛）；`registerBuiltin` 重复注册抛错、退订后 builtin 名不再命中；插件路径按 **cwd** 解析（非 boot.ts 所在目录）；config 冻结（改写抛 TypeError，含 `plugins[].config`）。

**shutdown**：逆序调用 dispose；缺 dispose 的插件跳过；dispose 抛错不影响后续；**重复调用幂等**（第二轮无新增 dispose）。

**Logger**：级别过滤（低于阈值静默、默认 info、非法级别兜底 info）、输出到 stderr、格式 `[级别] 消息 [meta...]`、meta 序列化（字符串原样 / 对象 JSON / 多个空格连接）、`Error` meta 输出 stack 而非 `{}`、循环引用 meta 不炸且退化为 `String()`。

### 6.2 集成测试（`tests/integration/skeleton.test.ts`）

以**真实组合根**驱动全链路（不 mock 内核），用本地 toy 插件走完"挂载 → 注册服务面 → 事件收发 → 卸载"：

1. §4.3 冒烟链路：toy 插件注册 prompt section 后 `ctx.prompt.render()` 命中；同时监听 `plugin/mounted` 收到自身事件；未挂载的 `ctx.sessions.append` 抛 `'not mounted'`；`shutdown` 后 dispose 被调用。
2. 双插件协作链路：A 注册服务面、B 通过 `ctx` 消费该服务面，验证"插件只经 ctx 交互"（无相互 import）与挂载顺序语义。
3. 叶子插件失败链路：第三个插件 setup 抛错 → BootError 名单含前两个、第三个未入名单、后续插件不再执行；**挂载序内全部插件（含半失败者）的 dispose 被逆序调用**（R3 + X5 的清理语义）。
4. 公共 API 出口链路：本地插件只 import `src/index.js`（不深引用 `src/plugin/*`），经出口拿到 `definePlugin` / `BootError` / `ToolRejected` / `registerBuiltin` 四类符号且均可构造——验证"插件作者一律经公共出口 import"这条路真的走得通。

不使用外部进程与网络；临时 fixture 插件文件放在 `tests/integration/fixtures/` 下随测试生成与清理。

## 7. 验收标准（DoD）

- [x] 本文档状态 Reviewed，实现未偏离（差异仅限 §2.4 D1–D5 且已获同意；实现期小偏离见下方"偏离记录"，均不触碰契约签名）
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（package.json / tsconfig / eslint flat config / vitest.config 在 M0 一并就位）
- [x] `src/contracts.ts` 覆盖骨架设计 §5 全部类型（含 `NotificationMap` / `WaterfallMap`），无 `any` 逃逸（strict: true）；运行时值仅存于 `src/errors.ts`
- [x] §6.1 单元测试点全部有对应用例且通过（`src/plugin/` 四个测试文件，44 例：EventBus 8 / 容器 14 / boot 14 / Logger 8）
- [x] §6.2 集成测试点全部有对应用例且通过（`tests/integration/skeleton.test.ts`，4 条链路）
- [x] LOC ≤ ~1.2k ±20%（`git ls-files 'src/**/*.ts' | grep -v '\.test\.ts$' | xargs wc -l`）。**M0 统计口径为全部 `src/`**（contracts.ts / errors.ts / index.ts 均属 M0 预算，此口径与 process.md §6 的模块级口径在 M0 等价）；01 起恢复模块级口径。**实绩 1133 行**（在 960–1440 区间内；较首版 1053 增加 registerBuiltin 出口、插件形状校验、X5 清理语义与 JSDoc）
- [x] `docs/PROGRESS.md` 已更新（M0 步骤打勾、LOC 实绩、01-config 的下一步动作）
- [x] 所有者 review 代码通过（2026-10-16 首轮 review：2 个真 bug + 6 项改进，已全部修复并回写 §4/§5/§6/§7，新增偏离 X5–X6）
- [ ] 文档状态更新为 Baseline 并按 process.md §5 提交

### 偏离记录（实现时补记，2026-10-16；均不改任何契约签名）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | `boot.ts` 内除挂载序 `WeakMap<Ctx, Plugin[]>` 外，并行增设 `WeakMap<Ctx, AbortController>` | §4.2 要求 shutdown 最后 abort，而 `ctx.signal` 只读、controller 不能挂到 ctx 上（§3 禁止"往 ctx 挂内部状态"），与挂载序同级的模块级 WeakMap 是唯一合规存放处 |
| X2 | `SessionStoreContainer` 的 Promise 返回方法（create/open/list/append）以 `async` 包装，未挂载时以 **Promise rejection** 呈现 `'not mounted'` | 服务面签名是 Promise 契约，同步异常会让"在 async 上下文外直接调用"的场景绕过 `await` 的统一错误路径；subscribe 保持同步抛 |
| X3 | lint 链路在 eslint flat config 基础上引入 `typescript-eslint` 与 `@eslint/js` 两个配套 devDependency | 架构 §2 只列了 `eslint`；flat config 对 `.ts` 文件的解析与规则需要 TS parser，属 lint 门禁的必需配套而非新运行时依赖（dependencies 仍为空） |
| X4 | `tsconfig` include 覆盖 `src/` 与 `tests/`（typecheck 门禁覆盖测试代码），故 `tsc` 构建产物为 `dist/src/index.js`，`package.json` 的 `main` 按此设置 | M0 不交付 bin（`mdsh` 归 07）；07 交付时再调整 rootDir / bin 布局 |
| X5 | 挂载序在 `setup` **之前**追加插件，故 `shutdown` 会 dispose "setup 未成功"的插件；`BootError.mounted` 名单剔除末位半失败者。同时 `shutdown` 结束后清空挂载序，使其幂等 | 两处都是 R3 决议的补强：①半失败者可能已在 setup 中拉起外部资源（09 MCP 的 stdio 子进程正是 R3 的立论场景），只清理"之前成功的"会漏掉它；②07 的退出路径与信号路径可能各调一次 shutdown，不幂等就会二次 dispose。`mounted` 名单语义仍是"已成功挂载"，未变 |
| X6 | builtin 插件表（Map）改为 `boot.ts` 模块级**私有**状态，新增导出 `registerBuiltin(name, factory): Unsubscribe` 作为唯一注册入口，并经 `src/index.ts` 转发 | 原实现导出裸 Map，02–09 注册内置插件只能深引用 `src/plugin/boot.js`，与 §1"不深引用内部路径"自相矛盾；出口改为函数后可查重、可退订，内置模块不再触碰内部路径 |


## 8. 决策点记录（2026-10-16 所有者拍板，原"遗留决策点"已全部关闭）

| # | 问题 | 决议 |
|---|---|---|
| R1 | `PermissionAction` 是否增加 `'deny'` | **加**。deny 语义：05 的 pipeline 直接产出 `permission_denied` 结果，**不询问用户**（与 ask 的本质区别）；01 解析 / 05 匹配均按三值实现，CLI 不为 deny 发起权限询问 |
| R2 | `Logger` 方法面是否需要 `child(prefix)` 之类的能力 | **不加**。四方法（debug/info/warn/error）够用，不预扩；前缀需求（若有）由调用方自行拼进消息 |
| R3 | boot 失败是否对已挂载插件执行清理 | **是**（推翻原"否"的建议）。挂载失败即复用 shutdown 流程：逆序 dispose（抛错只记 log）→ abort → 抛 BootError。理由：M0 虽无外部资源，但 09 的 MCP 插件可能在 setup 中拉起 stdio 子进程，Windows 下父进程退出不保证子进程终止；清理成本约 5 行，语义与正常退出统一 |
| R4 | Logger level 的配置来源（评审新增） | `Config` 增加可选 `logLevel`（默认 `'info'`），默认值合并归 01；M0 boot 直接读取，缺省 `'info'`。补此字段是为了让 07 的 `--verbose` 类开关有落点，避免 Logger 在 07 阶段返工 |

评审同时确认：`Ctx.sessions` 声明类型为 `SessionStoreContainer`（D5）、插件路径按 cwd 解析并转 file:// URL（§4.1）、`WeakMap<Ctx, Plugin[]>` 持有挂载序（§3）、事件静态类型表进 contracts.ts（§2.1）。

2026-10-16 二次评审（所有者要求）补四处澄清，均不改任何契约签名：`deepFreeze` 归属恒定为 `boot()`（§2.3 / §4.1，01 的 `loadConfig()` 只加载合并、不冻结）；`default` 非 factory / `factory()` 抛错的失败路径入 §4.1 与 §5 边界表；`SessionEvent` 变体集合对 03 封闭（§2.2）；重复 / 并发调用 `boot()` 为未定义行为（§5）。
