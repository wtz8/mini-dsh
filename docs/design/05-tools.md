# 05-tools 设计

> 状态：**Baseline**（2026-10-18 所有者拍板 Q1–Q10 全部按建议项；实现与测试完成，所有者 review 通过后随模块提交归档）
> 预算：~2.5k 行（架构 §4；本次范围预计 ~2.0k，见 §7 预算说明）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §3 `ToolRegistryImpl` 与 §5 的 `ToolRejected`）、`01-config.md`（Baseline，重点 `resolvePermission` 与 `Config.tools` / `Config.permissions`）、`02-llm.md`（Baseline，重点 §2.2 的插件侧能力出口先例）、`03-session.md`（Baseline，重点 §2 的 `tool/result` 事件与 `deriveMessages` 的配对规则）、`04-prompt.md`（Baseline，重点 §2.2 的 `PROMPT_ORDER.tools = 350`、§5 末行"相对路径基准"的跨模块承诺、文末与 05 的职责边界）、`architecture.md` 0.1.5（§5.3 瀑布、§5.4 工具契约与 pipeline 产出约定、§6 数据流、§7 遗留表 PB-02）

## 1. 背景与目标

05 交付架构灵魂 #3 —— **guarded tool pipeline**：`schema 校验 → pre-execute（可否决）→ execute → post-execute`，外加六个内置工具与一份工具清单（模型可见面）。它是 01（权限选择器）、03（结果入 log）、04（工具段占位）三处承诺的兑现点。

对应骨架契约（均已 Baseline，不得改签名）：

- architecture §5.2 `ToolRegistry { register / list / get }`：M0 已交付**最终实现**（`src/plugin/containers.ts` 的 `ToolRegistryImpl`），与 04 的 `PromptRegistryImpl` 同性质——**容器已定，05 只往里注册内容**。
- architecture §5.4 `ToolDefinition` / `ToolEnv` / `ToolInvocation` / `ToolResult` / `ToolErrorCode` 与"pipeline 产出约定"：**任何分支都产出 `ToolResult` 并 `append(tool/result)`，不向上抛**。
- architecture §5.3 `tools/pre-execute` / `tools/post-execute` 瀑布、`tool/start` / `tool/end` 通知事件。
- architecture §5.4 权限匹配规则（精确键 > 最长前缀通配 > 兜底 `ask`）与 01 的 `resolvePermission`。
- 04 §2.2 `PROMPT_ORDER.tools = 350`：工具清单只有**一个**真值出口，即 05 注册的 `tools` 段。

目标（一句话）：让 06 只需

```ts
const runner = createToolRunner(ctx, { approve })            // 05：一次，插件 setup 内
// 每 step：
const calls = /* 02 的 accumulator 产物 */
for (const call of calls) {
  const result = await runner.run(call, { sessionId, turnNo, stepNo, signal })  // 05：永不抛
}
req.tools = toToolSchemas(ctx.tools.list())                  // 05：模型可见面投影
```

就拿到"参数一定合法、权限一定过门、结果一定入 log"的工具调用，且**任何插件注册的工具（08 的 memory、09 的 MCP）自动享有同一条管道**。

**非目标**（防范围膨胀）：

- 不做沙箱 / 容器 / 权限提升隔离（架构 §10 明确砍 sandbox）。05 的硬边界是"参数合法性 + 权限门 + 路径解析基准"，不是 OS 级隔离。
- 不做并发调度：`ToolDefinition.concurrency` 由 **06** 消费（架构 §6），05 只负责标注与单次执行。
- 不做结果压缩 / 摘要（归 06 的 compaction）；05 只做**长度硬上限**截断。
- 不做 bash 的持久 shell / PTY / 交互式 stdin（一次性 `spawn` + 收集输出）。
- 不做工具热卸载、`unregister`（架构 §10 无热卸载）。
- 不新增运行时错误类（§2.3），不改 `contracts.ts` 任何签名（§2.4）。

## 2. 对外契约

模块落在 `src/tools/`。沿用 02 X2/X3 与 04 的出口约定：**宿主侧**经 `src/tools/index.ts`；**插件侧**能力额外经 `src/index.ts` 转发（否则 06 只能深引用内部路径）。

### 2.1 宿主侧（`src/tools/index.ts`）

```ts
/** 审批回调：拿到的是**改写完成、已冻结**的调用快照，即"将要执行的那一个"（PB-02 ③）。 */
export type ApproveHandler = (invocation: Readonly<ToolInvocation>) => Promise<boolean> | boolean

/** 单次工具调用的运行上下文（06 每 step 组装一次，供本 step 全部调用复用）。 */
export interface ToolRunContext {
  sessionId: string
  turnNo: number
  stepNo: number
  /** 回合级取消信号（06 的 `cancel()`）；05 内部会与 `ctx.signal` 合并（§4.4） */
  signal: AbortSignal
}

/** 工具执行器（guarded pipeline 的唯一入口）。 */
export interface ToolRunner {
  /**
   * 执行一次工具调用。**永不抛错**：任何失败都表现为 `ok:false` 的 `ToolResult`，
   * 并已 `append(tool/result)` 入会话日志（架构 §5.4）。
   */
  run(call: ToolCall, context: ToolRunContext): Promise<ToolResult>
}

export interface ToolRunnerOptions {
  /** `ask` 的审批通道；缺省 = 无审批处理器 → `ask` **失败关闭**（PB-02 ②） */
  approve?: ApproveHandler
  /** 审批等待上限，默认 60_000ms；超时按"拒绝"处理（失败关闭） */
  approvalTimeoutMs?: number
  /** 结果文本硬上限，默认 64_000 字符（中段截断，见 §4.6） */
  maxResultChars?: number
  /**
   * 工具超时（架构 §5.4：只有声明了超时的工具才受限）。
   * 返回 `undefined` = 该调用无超时，仅受取消信号约束。
   */
  timeoutFor?: (name: string, args: Record<string, unknown>) => number | undefined
}

/**
 * 构造工具执行器（薄接线层：绑定 `ctx`，不含策略）。
 * 06 在**自己的 setup 内**调一次，之后每 step 复用。
 */
export function createToolRunner(ctx: Ctx, options?: ToolRunnerOptions): ToolRunner

/** 从已注册工具投影模型可见面（`LLMRequest.tools`）。 */
export function toToolSchemas(defs: ReadonlyArray<ToolDefinition>): ToolSchema[]

/** 构造 `tools` prompt 段（order = `PROMPT_ORDER.tools`，内容见 §3.4）。 */
export function createToolsSection(tools: Pick<ToolRegistry, 'list'>): PromptSection

/**
 * 构造 `builtin:tools` 插件工厂：注册六个内置工具 + `tools` 段。
 * 实例级配置 `plugins[].config = { disabled?: string[] }`（禁用的内置工具名，未知名抛错）。
 */
export function createToolsPlugin(options?: ToolsPluginOptions): PluginFactory

/** 把 `builtin:tools` 注册进内核 builtin 表；@returns 退订句柄 */
export function registerToolsBuiltin(): Unsubscribe

export interface ToolsPluginOptions {
  /** 覆盖内置工具集（生产不传；测试注入裁剪集） */
  tools?: readonly ToolDefinition[]
  /** 禁用的内置工具名（与实例配置合并；未知名抛错） */
  disabled?: readonly string[]
}
```

### 2.2 插件侧（额外经 `src/index.ts` 转发）

`createToolRunner` / `toToolSchemas` / `ToolRunner` / `ToolRunContext` / `ApproveHandler` —— 06 消费（构建 `req.tools`、驱动一次调用）。08/09 不需要转发：它们只 `ctx.tools.register(def)`，管道自动生效。

另转发 `resolvePath`（实现期补，见 §7 X4）：08 写 `~/.minidsh/memory/MEMORY.md` 时需要同一套"相对路径按 cwd、`~` 展开"的基准，自己拼会与 D6 漂移。

### 2.3 不新增运行时错误类

`src/errors.ts` 按"发生在哪一阶段"分类，05 的运行失败**全部是工具结果**而非异常（架构 §5.4 已定）。两类 setup 期错误走既有通道：

- 内置工具同名重复注册 → 容器抛 `'tool '<name>' already registered'` → setup 内抛 → 组合根转 `BootError`（M0 语义）。
- 实例配置非法（非对象 / `disabled` 非字符串数组 / 含未知工具名）→ 抛 `Error` → 同样转 `BootError`（与 03 `config.dir`、04 `disabled` 同式）。

### 2.4 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | **pipeline 以"导出函数 + 调用方注入"形态交付，不挂到 `ctx` 服务面** | `ToolRegistry` 签名只有 `register/list/get`（架构 §5.2），加 `run` = 改基线。与 02 的 `createToolCallAccumulator`、03 的 `deriveMessages` 同式：插件侧能力经 `src/index.ts` 转发，由消费方（06）显式接线 |
| D2 | **权限门在 `tools/pre-execute` 瀑布之后独立执行**，不由 CLI 监听器在瀑布内完成 | PB-02 ③：瀑布可改写 `name`/`args`，"先授权、后允许改写"就是"检查 A、执行 B"。故顺序改为 schema → 瀑布（改写）→ **复检** → **冻结快照** → 权限 → 执行。架构 §5.3 的"CLI 权限监听器抛 `ToolRejected`"仍然**可用**（任一监听器抛 `ToolRejected` 一律转 `permission_denied`），只是不再是内置权限门的实现方式——这是本轮新增的澄清，需 review 认可 |
| D3 | **六个内置工具与插件分离**：`createReadTool()` 等是纯构造函数 | 与 03 D3 / 04 D3 同式：工具可脱离组合根单测（直接喂 args 断言输出），插件退化为"注册清单 + 接线"薄层 |
| D4 | `tools` 段注册在 `PROMPT_ORDER.tools`（350），**每次 render 现查 `ctx.tools.list()`** | 09 的 MCP 工具在 `builtin:tools` 之后挂载，快照会让段内容取决于挂载顺序（与 04 D5 同理由） |
| D5 | **`tools/post-execute` 抛错不吞掉已经产出的结果**（保留原结果 + `log.error`） | pre-execute 抛错 = 否决（还没执行）；post-execute 已经执行完、副作用已发生，此时把结果换成错误文本等于**丢掉事实**。两段瀑布语义在这一点上不同，需显式区分 |
| D6 | **相对路径基准 = `process.cwd()`**（六个工具全部） | 兑现 04 §5 末行的跨模块承诺：环境段告诉模型"所有相对路径都按上面的工作目录解析"。二者若不一致，这句话就是假的 |
| D7 | 无工具时 `tools` 段返回 `''` | 与 04 D2 的"空段过滤"一致；也避免"# 可用工具"后空无一物 |
| D8 | 结果长度在 pipeline 做**硬上限截断**（默认 64k 字符） | 工具输出是上下文膨胀的主源；06 的 compaction 是"事后总结"，pipeline 的截断是"事前止血"，两层不重复 |

## 3. 数据结构

```text
src/tools/
├── types.ts          # 模块内类型（ToolsPluginOptions / 工具构造选项 / ToolRuntime）
├── schema.ts         # 手写 JSON Schema 最小子集校验器（validateArgs / describeSchema）
├── path.ts           # 相对路径解析基准（resolvePath / expandHome），D6 的唯一落点
├── fs-error.ts       # fs 错误 → 模型可读文案（read/write/edit/fs-walk 共用，实现期补，见 §7 X2）
├── pipeline.ts       # createToolRunner：guarded pipeline 状态机（本模块核心）
├── projection.ts     # toToolSchemas()：ToolDefinition → ToolSchema
├── section.ts        # createToolsSection()：order 350 的 prompt 段
├── plugin.ts         # createToolsPlugin / registerToolsBuiltin（注册 6 工具 + 段）
├── builtin/
│   ├── read.ts       # read（parallel）
│   ├── write.ts      # write（exclusive）
│   ├── edit.ts       # edit（exclusive）
│   ├── glob.ts       # glob（parallel）
│   ├── grep.ts       # grep（parallel）
│   └── bash.ts       # bash（exclusive）
├── fs-walk.ts        # glob/grep 共用的目录遍历（跳过 .git / node_modules，不跟符号链接）
└── index.ts          # 模块出口（宿主侧）
```

### 3.1 参数校验器（`schema.ts`）

`JsonSchema`（`contracts.ts`）只声明了 `type` / `properties` / `required` / `additionalProperties`，而 `properties` 的值是 `unknown`——具体关键字由本模块定义。支持的子集（其余关键字**忽略**，不报错）：

```ts
type PropSchema =
  | { type: 'string';  description?: string; minLength?: number }
  | { type: 'number';  description?: string }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array';   description?: string; items?: PropSchema }
  | { type: 'object';  description?: string; properties?: Record<string, PropSchema>
                       required?: string[]; additionalProperties?: boolean }
```

```ts
export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string }   // message 形如 `args.limit: expected integer, got string`

/** 校验根参数必须是 object；不修改入参（返回浅拷贝）。 */
export function validateArgs(schema: JsonSchema, args: unknown): ValidationResult

/** 生成 `path: string, limit?: integer` 形式的人类可读签名（供 tools 段使用，非机器 schema）。 */
export function describeSchema(schema: JsonSchema): string
```

不支持的：`$ref`、`oneOf`/`anyOf`/`allOf`、`patternProperties`、`format`、`default`（默认值由**工具实现**自己兜，不在校验器里填——校验器保持"只判不改"）。

### 3.2 六个内置工具

`execute(args, env)` 只返回结果文本；失败抛错（由 pipeline 转 `execution_error`）。所有相对路径经 `resolvePath()`（=`path.resolve(process.cwd(), p)`，并展开 `~`）。

| 工具 | 参数（`required` 加粗） | 行为与输出 | 并发 |
|---|---|---|---|
| `read` | **path**, offset?, limit?（默认 1 / 2000，上限 2000） | 按行编号输出 `     1\t<内容>`；文件更长时尾部附 `（共 N 行，已显示第 a–b 行）`；空文件 → `（空文件）`；前 8KB 含 NUL → 报"二进制文件"；单行超 4000 字符截断并标注 | parallel |
| `write` | **path**, **content** | 自动建父目录，整文件覆盖；返回 `已写入 <绝对路径>（N 字节）`；目标是目录 → 报错 | exclusive |
| `edit` | **path**, **oldString**(minLength 1), **newString**, replaceAll? | 精确字符串匹配：0 处 → 报错并提示先 `read`；多处且未开 `replaceAll` → 报错要求更长的唯一片段；返回 `已在 <绝对路径> 替换 N 处` | exclusive |
| `glob` | **pattern**, path?, limit?（默认 200，上限 1000） | 自研 glob（`**` / `*` / `?`）在 `path`（默认 cwd）下遍历，输出相对路径每行一条；按路径升序；命中上限附截断说明；无匹配 → `（无匹配）` | parallel |
| `grep` | **pattern**(正则), path?, glob?, ignoreCase?, limit?（默认 100，上限 500） | 遍历 + 逐行正则匹配，输出 `相对路径:行号: 内容`（行内容截 500 字符）；非法正则 → 报错；跳过二进制与 >2MB 文件 | parallel |
| `bash` | **command**(minLength 1), timeoutMs? | 按 `config.tools.bash.shell` 解析 shell（`auto` 见 §4.5），`cwd = process.cwd()`；输出 = stdout + `[stderr]` 段 + `[退出码: N]`；**非零退出仍算 `ok:true`**（进程正常结束，退出码是结果的一部分）；spawn 失败 / 超时 / 取消才算失败 | exclusive |

`fs-walk.ts` 的遍历规则（glob / grep 共用）：跳过 `.git` 与 `node_modules`（硬编码，不可配）；不跟随符号链接（防环）；目录深度上限 20；单次遍历最多访问 20,000 个条目后停止并附说明。

### 3.3 工具清单（模型可见面）

两个出口，一个真值：

1. `toToolSchemas(ctx.tools.list())` → `LLMRequest.tools`（机器可读，OpenAI 兼容 `{name, description, schema}`）。
2. `createToolsSection()` → 系统提示中的 `# 可用工具`（人类可读索引，order 350）。

### 3.4 `tools` 段文案（order 350，Q5 拍板后为准）

```text
# 可用工具

- `read(path, offset?, limit?)` — 读取文件内容，按行编号返回
- `write(path, content)` — 覆盖写入整个文件
- `edit(path, oldString, newString, replaceAll?)` — 精确字符串替换
- `glob(pattern, path?, limit?)` — 按 glob 模式查找文件路径
- `grep(pattern, path?, glob?, ignoreCase?, limit?)` — 在文件中按正则搜索内容
- `bash(command, timeoutMs?)` — 在工作目录下执行 shell 命令

参数的具体类型与约束见 `tools` 字段中的 JSON Schema；相对路径按工作目录解析。
```

- 工具名 / 描述来自 `ToolDefinition`（**不是**本模块硬编码的六行常量）——插件注册的工具自动出现在这里；无工具时整段返回 `''`（D7）。
- 只列"名字 + 参数骨架 + 一句话"，不放完整 JSON Schema：机器 schema 已由 `LLMRequest.tools` 承载，重复一遍纯属烧 token（Q5）。
- 末行是 04 environment 段"相对路径"承诺的**回指**，两处必须同时为真（D6）。

## 4. 核心流程

### 4.1 pipeline 状态机（`pipeline.ts`，本模块的骨架）

```text
run(call, ctxRun):
  ① 解析参数    JSON.parse(call.arguments) → 非对象/语法错 ⇒ invalid_args
  ② 查定义      ctx.tools.get(call.name)   → 未注册    ⇒ execution_error（§4.7）
  ③ 校验        validateArgs(def.schema, args) 失败 ⇒ invalid_args
  ④ 瀑布        inv = await events.waterfall('tools/pre-execute', {callId,name,args,sessionId,turnNo,stepNo})
                  · 抛 ToolRejected            ⇒ permission_denied（否决语义，架构 §5.3）
                  · 抛其它异常                 ⇒ execution_error（监听器 bug，不静默）
  ⑤ 复检        inv 的 name/args 与 ③ 不同 ⇒ 重新 get + validateArgs（PB-02 ④：同一快照）
  ⑥ 冻结        snap = deepFreeze({...inv})      ← 从此不再接受任何改写
  ⑦ 权限门      action = resolvePermission(config.permissions, snap.name)
                  auto ⇒ 继续
                  deny ⇒ permission_denied（**不展示审批**，PB-02 ①）
                  ask  ⇒ approve(snap)（超时/无处理器/返回非 true ⇒ 失败关闭，PB-02 ②）
  ⑧ 执行        emit tool/start → execute(snap.args, env)（带超时与取消，§4.4/§4.5）
                emit tool/end
  ⑨ 截断        ok 结果超 maxResultChars ⇒ 中段截断（§4.6）
  ⑩ 后处理      result = await events.waterfall('tools/post-execute', result)（抛错⇒保留原结果，D5）
  ⑪ 入 log      await ctx.sessions.append(sessionId, { type:'tool/result', toolCallId: call.callId, result })
  ⑫ 返回        result（ok:false 也照常走到 ⑪，错误是结果不是异常）
```

- **顶层 `try/catch` 兜底**：任何未预期异常（如 append 的 io 错）都转为 `execution_error` 结果，`run` 对外**永不抛**。
- ③ 与 ⑤ 之间可能重复校验一次：schema 判定是纯内存 O(属性数) 操作，重复成本可忽略；换来"架构 §5.4 的 schema 先于 pre-execute"与"PB-02 ③/④ 执行对象一致"两条同时成立。
- ⑧ 的 `tool/start` / `tool/end` **只在真正执行时**发：`deny` / `invalid_args` / 未注册不发（CLI 不会为没执行的调用闪一下 spinner）。CLI 渲染失败结果可以从 `run` 的返回值或 `session/append` 事件拿。

### 4.2 权限门（PB-02 的四条，逐条落点）

| PB-02 边界 | 本设计的落点 |
|---|---|
| ① `deny` 不展示审批、不调用工具，但仍写 `tool/result` | ⑦ 的 `deny` 分支直接产出结果，跳 ⑧ 但**照常走 ⑪**；`content` 为模型可读文案 |
| ② 无审批处理器 / 超时 / 用户拒绝 ⇒ `ask` 失败关闭 | ⑧ 前的 `requestApproval()`：`approve === undefined` → 拒绝；`Promise.race` 超时 → 拒绝；返回值 `!== true` → 拒绝；`approve` 抛错 → 拒绝 + `log.error`。**没有任何路径把 `ask` 降级为 `auto`** |
| ③ 授权对象 = 改写全部完成后的同一不可变快照 | ⑥ 的 `deepFreeze` 在 ⑦ 之前；`approve` 收到的是 `Readonly<ToolInvocation>`，与 ⑧ 传给 `execute` 的 `snap` 同源同值 |
| ④ schema 校验 / 权限 / registry lookup / 执行绑定同一 invocation | ② 与 ⑤ 的 lookup 结果一致（name 未变则复用），⑧ 直接用 `snap.args` 调 `execute`；`Env.callId` 与 `snap.callId` 同值 |

- `resolvePermission` 复用 01 的实现（01 X6 已把它经 `src/index.ts` 转发），本模块**不自实现**匹配。实现期注意：`pipeline.ts` 直接从 `../config/permissions.js` 引入而非绕回 `src/index.js`——后者转发本模块的 `createToolRunner`，绕回即成环（与 02 X2 同一避环模式）。
- 审批结果不缓存："同一回合里批准过 `bash`"不代表后续 `bash` 免问——每次调用都要重新过门（Q3 附议）。

### 4.3 审批通道的接线（跨模块约定，需 06/07 遵守）

`approve` 是**函数**，只能由宿主注入（配置文件里放不了函数）：

```text
07 CLI:  registerBuiltin('agent-loop', createAgentPlugin({ approve: askUserOnStdin }))
           │   （默认 builtin 表的 agent-loop 无 approve ⇒ 所有 ask 都失败关闭）
06 agent: setup 时 createToolRunner(ctx, { approve: options.approve,
                                          timeoutFor: bashTimeout })
           └─ 每 step 对每个 call 调 runner.run(call, {...})
```

- 05 的 `builtin:tools` **不接收** `approve`：审批是宿主策略，工具模块不该知道"谁来问用户"。
- 06 的 `timeoutFor` 由 05 提供的工厂组装（`createBashTimeoutResolver(ctx.config)`，实现见 `plugin.ts`）——06 不必知道 bash 的超时字段叫什么。

### 4.4 取消与超时

- **两条取消通道合并**：`env.signal = AbortSignal.any([runCtx.signal, ctx.signal])`（Node ≥22 内置）。`runCtx.signal` 是回合级（`AgentControl.cancel()`），`ctx.signal` 是进程级（架构 §5.2 的边界），工具两者都观察。
- **超时**：`timeoutFor(name, args)` 返回毫秒数时，pipeline 起一个定时器 → 到点 `abort(callController)` 并**等待 execute 结算至多 2s**（给子进程收尸的时间），随后产出 `timeout` 结果。未声明超时的工具（read/glob/grep/write/edit）只受取消信号约束（架构 §5.4）。
- **取消优先于超时**：若两者同时到达，按 `cancelled` 报（用户意图优先）。
- bash 收到 abort 后：`SIGTERM` → 1.5s 后 `SIGKILL`；Windows 用 `taskkill /pid <pid> /T /F` 杀进程树（Node 的 `kill()` 只管直接子进程，`cmd /c` 留下的孙进程会脱管）。

### 4.5 bash 的 shell 解析与超时

```text
resolveShell(config.tools.bash.shell)   # 插件 setup 时解析一次，缓存结果
  'bash'       → 用 bash
  'powershell' → powershell -NoProfile -NonInteractive -Command
  'auto'       → 探测：spawnSync('bash', ['-c', 'exit 0']) 成功 ⇒ bash；否则 powershell
                 （POSIX 上 bash 不存在时退 'sh'；Windows 上二者都没有 ⇒ 启动期抛错）
```

- `cwd` 固定为 `process.cwd()`（D6），**不提供 `cwd` 参数**：需要换目录就 `cd x && …`，少一个与 04 承诺打架的面。
- `timeoutMs` 参数只能**调小**：`min(args.timeoutMs ?? config, config.tools.bash.timeoutMs)`。模型不能给自己续命；用户想看长任务就改配置（Q8）。
- 环境变量：继承父进程（`env: process.env`）。不做白名单——凭据外发是 07 的信任提示问题（PROGRESS F-03），不是本模块能解决的。

### 4.6 结果截断（D8）

```text
if (ok && content.length > maxResultChars):
  head = 60% 预算, tail = 40% 预算
  content = head + `\n\n…（已截断 ${dropped} 字符）…\n\n` + tail
```

- 保留**头部**（通常是结论/命令回显）与**尾部**（通常是错误信息和退出码），砍中段——与"留头"、"留尾"两种单一策略相比更不容易丢关键信息。
- 截断发生在 ⑨（execute 之后、post-execute 之前）：插件仍能看到完整结果做脱敏（若它想要的话）；默认不再拼接。
- 错误结果不截断（文案本就有界，且截断错误信息会误导模型）。

### 4.7 未注册工具的错误码（Q4）

`ToolErrorCode` 是**封闭枚举**（`contracts.ts`），没有 `unknown_tool`。未注册工具按 `execution_error` 报，`message` 写明 `unknown tool '<name>'`，`content` 为模型可读文案（提示它可能记错了工具名，或该工具未挂载）。不选 `invalid_args`：参数没问题，是工具不存在；不选 `permission_denied`：会诱导模型以为是权限问题而去重试。

### 4.8 `builtin:tools` 的 setup 时序

```text
createToolsPlugin(options) → setup(ctx, config?)
  disabled = [...(options?.disabled ?? []), ...narrowDisabled(config)]     # Array.isArray 拒数组（04 Y1）
  unknown  = disabled.filter(n => !KNOWN_TOOL_NAMES.has(n))                 # 死配置早暴露
  if (unknown.length) throw Error(...)
  for (const make of BUILTIN_TOOL_FACTORIES)                              # read/write/edit/glob/grep/bash
    if (!disabled.includes(name)) ctx.tools.register(make())              # 同名校验在容器
  ctx.prompt.section(createToolsSection(ctx.tools))                       # order 350
```

- 插件名固定 `builtin:tools`；无 `dispose`（不持有资源：工具是纯函数闭包，bash 的 shell 探测结果是启动期常量）。
- 注册顺序固定为 read → write → edit → glob → grep → bash：`ctx.tools.list()` 的顺序即模型看到的 `tools` 顺序（稳定顺序有利于 provider 前缀缓存）。

## 5. 边界情况与错误处理

| 情况 | 行为 |
|---|---|
| `call.arguments` 是空串 | `JSON.parse('')` 抛错 → `invalid_args`，文案提示"参数必须是合法 JSON 对象" |
| `call.arguments` 是 `[]` / `null` / `"x"` / `123` | 根不是 object → `invalid_args`（数组不算参数对象） |
| 参数含未知字段且 `additionalProperties: false` | `invalid_args`，文案给出字段名 |
| 参数含未知字段且未声明 `additionalProperties` | **放行**（JSON Schema 默认语义）；工具实现自行忽略 |
| `additionalProperties: true` | 放行 |
| 工具未注册（模型幻觉/插件未挂） | `execution_error`，message `unknown tool '<name>'`（§4.7） |
| 权限 `deny` | 工具不执行、不审批；`content` 为"被权限策略禁止"，含策略来源（`permission: deny`）；已入 log |
| 权限 `ask` 且无 `approve` | 失败关闭：`content` 说明"当前宿主未提供审批通道"，`code: permission_denied` |
| 审批超时（默认 60s） | 视同拒绝，`content` 写明超时；不重试 |
| 审批期间回合被取消 | `cancelled`（不是 `permission_denied`——用户没拒绝，是回合没了） |
| `tools/pre-execute` 监听器把 `read` 改名为 `bash` | ⑤ 重新 lookup + 校验；⑦ 按 **`bash`** 的权限判定——这是 PB-02 ③ 的核心用例 |
| `tools/pre-execute` 监听器把 `args` 改成不合 schema | ⑤ 复检失败 → `invalid_args`（**不执行**），文案指明"改写后校验失败" |
| `tools/pre-execute` 抛 `ToolRejected` | `permission_denied`，`content` 用异常的 message（架构 §5.3 否决语义） |
| `tools/pre-execute` 抛其它异常 | `execution_error`，message 含监听器错误；不静默吞（宁可暴露插件 bug） |
| `tools/post-execute` 抛错 | 保留 post 之前的结果 + `log.error`（D5：副作用已发生，不能把事实换掉） |
| `execute` 抛错 | `execution_error`，`content` 含 `err.message`（不塞 stack——模型不需要，日志里有） |
| `execute` 返回空串 | 视为成功，`content` 记 `（无输出）`（避免模型看到空的 tool 消息不知所措） |
| 超时 | `timeout`，`content` 写明工具名与毫秒数；进程已尽力收尸（§4.4） |
| 取消 | `cancelled`，`content` 写明"回合已取消"；与超时同时到达时按取消报 |
| `ctx.sessions.append` 失败（io / 未挂载） | `log.error` 后仍返回结果（工具已执行，事实不能丢）。**已知边界**：此时模型看不到该结果，下一 step 的投影会丢弃未配对的 toolCall——属会话存储故障的下游表现，归 03/07 的故障提示，05 不重试 |
| 结果超 64k 字符 | 中段截断（§4.6） |
| `read` 打到 10MB 以上文件 | 报错并提示用 `offset` / `limit` 分片读（不静默截断：截断的文件内容看起来"就是全部"） |
| `read` / `grep` 遇到二进制 | 报错/跳过（前 8KB 含 NUL 判定），不做编码探测 |
| `glob` / `grep` 遍历遇到 `EACCES` | 跳过该目录/文件并继续（`warn` 级日志），不中断整次遍历 |
| `write` / `edit` 目标不可写（EACCES / 只读盘） | `execution_error`，message 带绝对路径与 errno |
| `bash` 命令不存在 | 非零退出（127 / PowerShell 的 CommandNotFound），**`ok:true`**——shell 正常结束，退出码是事实 |
| `bash` 输出无换行结尾 / 超大输出 | 原样保留再走 ⑨ 截断；不重排格式 |
| `bash` 在 Windows 上 `auto` 探测找不到任何 shell | **setup 期抛错**（转 BootError）：没有 shell 的 `bash` 工具是废工具，早失败优于运行时每次报错 |
| 两处同时注册同名工具（08/09 撞名） | 容器抛 `'already registered'` → BootError（M0 语义）；命名约定见 §8 附 |
| `builtin:tools` 未挂载 | `ctx.tools.list()` 为空 → `tools` 段返回 `''`；任何调用 → `execution_error`（`unknown tool`）。07 的默认 `plugins` 必须含 `builtin:tools`（并入 07 DoD） |
| 实例配置 `disabled` 写成数组 | 抛 `'must be an object'`（照 04 Y1：`typeof [] === 'object'` 会静默忽略） |
| `disabled` 含未知工具名 | 抛错（死配置早暴露，与 01 X7 / 04 Q5 同式） |

## 6. 测试计划

### 6.1 单元测试（`src/tools/**/*.test.ts`，与源码同目录）

**`schema.test.ts`（约 18 例）**：六种类型的正例与反例（string/number/integer/boolean/array/object）；`integer` 拒 `1.5`；`required` 缺失（文案带字段名）；`additionalProperties: false` 拒未知字段、缺省放行；`minLength` / `minimum` / `maximum`；嵌套 object 与 array `items`；根为数组/null/标量 → 拒；**不修改入参**（校验后原对象未变）；未知关键字被忽略；`describeSchema` 输出 `a: string, b?: integer` 形态。

**`path.test.ts`（4 例）**：相对路径以 `process.cwd()` 为基准；绝对路径原样；`~` 展开为 homedir；空串拒绝。

**`pipeline.test.ts`（约 22 例，本模块核心）**：
- 正常路径：auto 权限 → 执行 → `append(tool/result)` 被调用且内容是结果文本；`tool/start` / `tool/end` 各一次。
- `invalid_args`：JSON 语法错 / 根非对象 / 缺必填 / 类型错，四例都不执行 `execute`（用 spy 断言零调用）。
- `unknown tool` → `execution_error`。
- `deny`：执行器零调用、**审批零调用**、仍 append、`tool/start` 不发。
- `ask` 无处理器 → 失败关闭；`ask` 处理器返回 `false` / `undefined` → 失败关闭；返回 `true` → 执行；处理器抛错 → 失败关闭且 `log.error`。
- 审批超时（`approvalTimeoutMs: 20`）→ 失败关闭，文案含"超时"。
- 审批期间取消 → `cancelled`。
- `pre-execute` 改写 args 后**复检**生效（改成非法 → `invalid_args`）；改写 name 后按新名查权限（`read` → `bash`，`bash: deny` 时拒绝）。
- `pre-execute` 抛 `ToolRejected` → `permission_denied` 且 message 透传；抛普通 Error → `execution_error`。
- `post-execute` 改写结果生效；`post-execute` 抛错 → 保留原结果 + `log.error`。
- `execute` 抛错 → `execution_error`（`content` 含 message）；返回空串 → `（无输出）`。
- 超时：`timeoutFor` 返回 20ms、execute 挂 200ms → `timeout`；不声明超时的工具不会被超时打断。
- 取消：`runCtx.signal` 已 abort → `cancelled` 且 execute 不执行；执行中 abort → `cancelled`。
- `append` 抛错 → 仍返回结果 + `log.error`（不抛）。
- 结果超 `maxResultChars`（设 100）→ 头尾保留、含截断标注。
- 快照不可变：`pre-execute` 之后的 `approve` 收到的对象被冻结（`Object.isFrozen` 为 true），且 `approve` 收到的 name/args 与 `execute` 收到的同值。
- 顶层兜底：`ctx.sessions.append` 同步抛 → 不冒泡。

**`projection.test.ts`（3 例）**：`toToolSchemas` 输出 `{name, description, schema}` 且**不含** `execute` / `concurrency`；顺序与注册顺序一致；空数组 → `[]`。

**`section.test.ts`（4 例）**：无工具 → `''`；有工具 → 每行含工具名与参数骨架、末行含"相对路径"；`order === PROMPT_ORDER.tools`（350）；**惰性**——先 render 再注册工具，第二次 render 出现新工具。

**`builtin/read.test.ts`（8 例）**：行号与内容；`offset` / `limit` 分页与尾部说明；空文件；二进制拒绝；单行超长截断；目录报错；文件不存在（ENOENT 文案含绝对路径）；CRLF 行尾不产生多余空行。

**`builtin/write.test.ts`（4 例）**：新建（含多级父目录）；覆盖；字节数与内容精确；目标是目录 → 报错。

**`builtin/edit.test.ts`（6 例）**：单处替换；多处未开 `replaceAll` → 报错且文件未变；`replaceAll` 全替换；0 处 → 报错；`oldString` 空 → 校验期 `invalid_args`（经 pipeline 走一遍）；替换后内容精确。

**`builtin/glob.test.ts`（7 例）**：`*.ts` 按**文件名**匹配（含子目录，与 ripgrep `-g` 一致，见 §7 X1）；`src/*.ts` 只匹配该层；`**/*.ts` 递归；`?` 单字符；`path` 参数为基准目录；跳过 `node_modules` / `.git`；limit 截断提示。

**`builtin/grep.test.ts`（6 例）**：命中输出 `路径:行号: 内容`；`ignoreCase`；`glob` 过滤；非法正则报错；无匹配 `（无匹配）`；跳过二进制文件。

**`builtin/bash.test.ts`（6 例）**：`echo` 输出与退出码 0；非零退出仍 `ok:true`（直接断言工具返回文本，不经过 pipeline）；`timeoutMs` 被 clamp（注入小配置，断言实际生效值）；abort 后进程被杀（用长 `sleep` 断言在 2s 内返回）；stderr 段；`shell` 显式指定 powershell / bash 各一例（Windows 上按可用性 skip）。

**`plugin.test.ts`（6 例）**：插件名 `builtin:tools`；注册六个工具 + 一个 section；`disabled` 生效（禁 bash 后只剩五个，section 也不含 bash）；`disabled` 含未知名 → 抛错；实例配置为数组 → 抛错（04 Y1 同式）；`disabled` 与构造选项合并。

**实绩：115 例单测**（分布见 §7）。另加一轮 7 例临时探针做评审实证（跑完即删）。

### 6.2 集成测试（`tests/integration/tools.test.ts`，真实组合根 + 真实 fs）

1. **挂载链路**：`registerSessionBuiltin` + `registerPromptBuiltin` + `registerToolsBuiltin` → `boot` → `plugin/mounted` 三条；`ctx.tools.list()` 六个；`ctx.prompt.render()` 含 `# 可用工具` 且**位于** `# 工具使用`（300）与 `# 工作准则`（800）之间（`indexOf` 相对位置）。
2. **端到端调用链路（核心）**：runner（`approve` 返回 true，权限 `{ read: 'auto' }`）读一个 tmp 文件 → `ToolResult.ok === true`；`ctx.sessions.read(id)` 里出现 `tool/result`，且 `deriveMessages` 投影出配对完好的 `assistant.toolCalls` + `tool` 消息。
3. **权限链路**：`{ bash: 'deny' }` → `bash` 调用返回 `permission_denied`，**执行器未运行**（用无害命令 + 断言无副作用文件）；`{ write: 'ask' }` 且**不传 approve** → 失败关闭且文件未被创建。
4. **改写链路**：注册一个插件监听 `tools/pre-execute`，把 `read` 的 `path` 改写到另一个文件 → 实际读到的是改写后的文件（验证瀑布改写真的作用于执行对象）。
5. **未挂载链路**：不挂 `builtin:tools` → `render()` 无 `# 可用工具` 段（但仍有其他段）；调用任意工具得 `execution_error`。
6. **09 预演链路**：挂载后手动 `ctx.tools.register(fakeMcpTool)` → 下一次 `render()` 出现该工具、`toToolSchemas` 含它、经 runner 调用可正常执行（验证"MCP 工具自动享有同一条管道"，D4 惰性）。

fixture：`os.tmpdir()` 下 `fs.mkdtemp` 的 `mdsh-tools-it-*` / `mdsh-tools-sessions-*`（不落在仓库内，afterEach 清理；与 01/02/03 的 fixture 目录互不干扰）。全程不打网络；bash 用例只用 `echo` / `exit`，不依赖外部命令。

## 7. 验收标准（DoD）

- [x] 本文档状态 **Reviewed**（2026-10-18 所有者拍板 Q1–Q10 全部按建议项）
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿（**418 例** = 现状 296 + 05 单测 115 + 05 集成 7）
- [x] 公共导出均有中文 JSDoc（用途/参数/返回值/副作用/错误行为）：`createToolRunner` / `toToolSchemas` / `createToolsSection` / `createToolsPlugin` / `registerToolsBuiltin` / `createBuiltinTools` / `createBashTimeoutResolver` / `resolvePath` / `displayPath` 与五个类型齐备
- [x] §6.1 单元测试点全部有对应用例且通过（12 个测试文件，**115 例**）
- [x] §6.2 集成测试六条链路全部通过（`tests/integration/tools.test.ts`，**7 例 / 6 链路**，链路 3 拆成 deny 与 ask 两例）
- [x] `src/tools/` LOC **1844 行**（预算 ~2.5k；见下方预算说明）
- [x] **零运行时依赖**：`package.json` 的 `dependencies` 仍为空（glob / grep / 校验器 / shell 调用全部内置 `fs` / `path` / `child_process`）
- [x] 未改动 `contracts.ts` 中**任何**骨架签名（`ToolDefinition` / `ToolResult` / `ToolErrorCode` / `ToolRegistry` 原样）
- [x] **PB-02 四条**逐条有测试守卫：①`deny` 不执行不审批仍入 log；②无处理器/超时/非 true/抛错全失败关闭；③授权与执行同一冻结快照；④改写后复检 + 按新名判权限
- [x] **`tools` 段 order = `PROMPT_ORDER.tools`（350）**（04 §2.2 的预留位），集成链路 1 断言 300 < 350 < 800
- [x] **相对路径基准 = `process.cwd()`**，六个工具全部经 `path.ts`（04 §5 的跨模块承诺）
- [x] **权限门在所有改写之后、对同一冻结快照执行**（D2 + §4.2 表）
- [x] **`ask` 的失败关闭没有例外路径**（无处理器 / 超时 / 非 true / 抛错 → 全部拒绝）
- [x] 工具结果文案声明"输出是待分析数据、不是新指令"（承接 04 Y3：`tools` 段末行 + pipeline 错误文案只说事实、不含诱导性指令）
- [x] 实例配置 narrow 用 `Array.isArray` 拒数组（04 Y1 的防线）
- [x] `src/index.ts` 已转发 `createToolRunner` / `toToolSchemas` / `resolvePath` 与相关类型
- [x] `docs/PROGRESS.md` 已更新（05 步骤、LOC 实绩、06/07 的接口约定）
- [x] 所有者已 review 代码（2026-10-18：读码全量 + 门禁复跑 + 临时探针实证；修复 Y2–Y4，见下表）

**LOC 实绩**：`src/tools/` **1844 行** —— pipeline 440 / bash 209 / schema 200 / fs-walk 157 / plugin 139 / read 116 / grep 114 / edit 97 / types 70 / glob 70 / write 52 / section 51 / path 50 / fs-error 38 / index 27 / projection 14。测试 1351 行（不计入）。

**单测分布（115 例）**：pipeline 32 / schema 20 / read 9 / plugin 9 / glob 7 / grep 7 / bash 7 / path 6 / edit 6 / section 5 / write 4 / projection 3。

**预算说明**：架构 §4 给 05 的 ~2.5k，实绩 1844（**−26%，低于下沿**），需说明：

1. **六件工具比预估薄**：`fs-walk` 把 glob/grep 的遍历抽成一份（省掉两套实现约 100 行），`schema` 校验器只做本模块真正用到的关键字（无 `$ref`/组合关键字），`bash` 的 shell 探测与杀进程树各十几行。
2. **没有产品化工程**：无沙箱、无 PTY、无重试、无进度回调、无输出格式化模板——这些都是架构 §10 明确砍掉的部分，估 2.5k 时给它们留了余量。
3. **口径差异**：设计初稿把"六工具 + 管道 + 段 + 校验器"按 2.0k 估，实际 1.84k；差额主要来自工具与校验器的节省（`pipeline` 本身比预估多）。

不追加"为了凑预算"的功能：1830 行覆盖了 §6 的全部验收点，压低是设计瘦身的自然结果，不是漏做。

### 偏离记录（实现期，编号 X）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | `matchGlob` 的匹配基准：模式**不含 `/` 时按 basename 匹配**（设计 §6.1 初稿写"`*.ts` 单层"） | `grep` 的 `glob` 过滤若只匹配根层就基本没用（`*.ts` 搜不到 `src/a.ts`）。改为"含 `/` 匹配整条相对路径、不含 `/` 匹配文件名"后，`grep` 与 `glob` 两个工具的语义都自然，且与 ripgrep `-g '*.ts'` 一致 |
| X2 | 新增 `src/tools/fs-error.ts`（设计 §3 的文件树是 13 文件，实际 14） | fs 错误文案被 read / write / edit / fs-walk（grep 的 EACCES 跳过）四处共用；塞进任何单个工具文件都会让其余工具反向依赖它 |
| X3 | 快照的**身份字段由 pipeline 持有**：监听器只能改 `name` / `args`，`callId` / `sessionId` / `turnNo` / `stepNo` 一律取调用方的值 | 设计只写了"冻结快照"，未规定哪些字段可改。评审探针发现：允许改 `sessionId` 会让 `ToolEnv.sessionId` 与日志落点分叉（同一调用在两个会话里），允许改 `callId` 会让 `tool/result` 与 `assistant.toolCalls` 配不上——两者都不是"改写"该有的能力 |
| X4 | `resolvePath` 额外经 `src/index.ts` 转发 | 08 写 `~/.minidsh/memory/MEMORY.md` 需要同一套基准（相对路径按 cwd、`~` 展开）；不转发的话 08 会自己拼一遍，与 D6 的"唯一基准"漂移 |
| X5 | `edit` 在 `execute` 内再兜一次 `oldString === ''`（schema 的 `minLength: 1` 已拦） | 绕过 pipeline 直接调工具时（公共可调用面），`indexOf('')` 会死循环。工具不能只信任上游校验 |
| X6 | 单测实绩 **115 例**（设计预估 ~95） | 多出的是评审探针转正：超时收尸、冻结快照身份、post-execute 丢 `error` 字段、`**` 零层匹配等边界，原本不在 §6.1 清单里，实证时发现值得守 |

### 偏离记录（评审期，编号 Y）

| # | 偏离 | 理由 |
|---|---|---|
| Y1 | `postProcess` 在插件改写结果**丢掉 `error` 字段**时保留原错误码（`out.ok === false` 且未给 error） | 自检探针实测：插件只改 `content` 时，`error.code` 会消失，07/日志就分不清"参数错"还是"执行错"。规则改为：插件给了合法 error 用它，否则 `ok:false` 沿用原错误码 |
| Y2 | `schema.ts` 校验子集收敛回 §3.1 文档口径：删掉 string 的 `maxLength` 与 number 的 `minimum`/`maximum`（198→200 行，case 拆分所致） | 所有者 review 发现实现超出文档钉的子集。§7 预算说明明确"校验器只做本模块真正用到的关键字"——六内置工具没人用这三个关键字，超出文档的能力按"未知关键字忽略"语义本就不该存在；选择改代码随文档，而非放宽文档 |
| Y3 | `killTree` 的 `taskkill` spawn 补 `'error'` 监听 + `unref`（缺失时退回 `process.kill` 直接子进程） | 所有者 review 探针实证（`node -e` 跑不存在的命令）：**spawn 失败是异步 `'error'` 事件，`try/catch` 拦不住**，原注释声称的"退回直接 kill"其实不会发生——taskkill 缺失时整个进程会以 unhandled 'error' 崩溃。极端环境（精简 Windows 镜像）下一次 bash 取消就会带走整个 CLI |
| Y4 | bash 取消用例显式 `timeout: 15_000`（保留 `<4000ms` 断言） | 所有者 review 复跑门禁时该例在**全量并发**下超时一次（默认 5s 上限），单跑 3 次与全量复跑均通过——杀进程依赖真实 taskkill，高负载下"杀得慢"会被默认超时误判成"挂死"。拉长 harness 超时后，若真没杀掉（进程自然退出需 5s）仍会被 `<4000ms` 断言抓住 |
| Y7 | **（P2）`glob` / `grep` 被取消时会把半截结果当成事实**：`walkFiles` 收到取消信号只是**静默提前返回**（`truncated` 仍为 `false`），两个工具在遍历之后都不再看信号——实测（4000 个文件、遍历中途 abort）`glob` 返回 **203 条且无任何截断提示**，看起来像一份完整列表；进入前已取消则返回「（无匹配）」。后果是 append-only log 里留下"确实只有这些文件 / 确实没有匹配"的错误事实，下一回合的投影会把它喂给模型 | 遍历后补 `if (env.signal.aborted) throw new Error('操作已取消')`（与 `read` 同式），由管道按 `signal.aborted` 归为 `cancelled`。修复后同一探针改为 `reject(操作已取消)`；两个工具各补一例"已取消 ⇒ 抛错"的回归（共 +2 例）。不改 `walkFiles` 的契约（它仍只承诺"尽早返回"），取消语义由**消费方**判，这样其它调用方需要部分结果时不受影响 |
| Y6 | **（P1，产品缺陷非测试问题）取消复合命令时回合被挂满整个命令时长**：`onAbort` 只调 `killTree`，而 Windows 的 `taskkill /T /F` **杀不到 MSYS fork 出来的孙进程**（tasklist 前后对比实证：bash 已死、`sleep` 仍存活，尽管 taskkill 报告"成功终止"）；该孙进程握着继承去的 stdout 管道句柄 ⇒ Node 的 `'close'` 要等它自然退出 ⇒ 实测取消一次耗时 **60.7s**（等于睡满 60s）。单条简单命令看不出问题（bash 会 exec 掉自己、没有孙进程），所以长期被当成"偶发抖动"；而 `npm ci && npm run build`、`grep x \| tail` 这类复合命令一按 Ctrl+C 就会真的挂住 | `onAbort` 在杀树之外**立刻 `destroy()` 掉 stdio**，切断被残留者握住的管道（实测 60.7s → **0.97s**）。孙进程仍可能残留为孤儿：零运行时依赖下拿不到原生 Job Object API，做不到更强保证；但"取消 ⇒ 不挂住回合"这一承诺成立，残留仅为后台进程。用例判别同步从**耗时**改为**标记文件**（命令跑完才写标记，断言标记不存在）——摘掉 `killTree` 后该用例如实失败（跑满 60s、标记出现），证明判据有效。注：Y4 / Y5（sleep 20s + `<12000ms`）与本轮第一轮（sleep 60s + `<35000ms`）三次加宽耗时上界**均未解决**，因为根因不是"杀得慢"；本轮实证还排除了"CPU 争抢"这一猜想（20 核全部打满时杀进程仍只需 0.9s） |

### 评审修复追加（2026-10-19 外部全模块审查）

| # | 偏离 | 理由 |
|---|---|---|
| Y8 | **（测试判据缺口，P3）Y6 的回归防线防不住"挂死"本身**：取消用例改用"标记文件不存在"判据后，只防"没杀进程"——外部审查实证把 `destroy()` 摘掉后，用例两条断言照样全过（只是跑满 60s），对 Y6 核心修复（destroy 切断管道）的回归防线是空的 | 判据补一条**粗粒度**耗时上界（`elapsed < 30_000` @ sleep 60）：修复生效 ≈ 1s、挂死 = 60s，30s 居中取界。与 Y4/Y5 的教训不冲突：那些上界贴着正常值 2–3 倍设（高负载下正常值会漂过），这条贴着"半个故障值"设，正常/故障之间隔一个数量级 |
| Y9 | **（P3）`grep` 的截断说明把两种"已截断"混为一句**：`truncated`（命中数达 limit）与 `walked.truncated`（目录遍历未完成）共用一句"仅显示前 N 条命中"——遍历未完成时模型会把半截命中列表误读成全量事实（与 Y7 的"半截结果当事实"同类） | 两种含义分开表述："命中数已达 limit（N）上限" / "目录遍历未完成，以上结果只覆盖部分文件"。既有用例只断言含"已截断"，不受影响 |

### 评审排除的误报（探针实证，记录以免后续重复怀疑）

自检方式沿用 02/03/04：读码 + 临时探针（7 例，跑完即删）。**未发现 P0/P1**，坐实 1 个 P3（Y1，已修）。所有者 review（2026-10-18 第二轮）同样为"读码 + 实证"：坐实 Y2–Y4（上文），其余核对项（pipeline 十二步顺序、PB-02 四条映射、X1–X6 落点、集成六链路、契约签名零改动、出口面）逐条对照无误。

| 怀疑 | 结论 |
|---|---|
| 工具忽略 `abort` 时超时会把回合挂死 | **不成立**：探针实测超时后最多等 2s 收尸即返回 `timeout`（总耗时 2.07s） |
| 审批处理器改冻结快照会炸掉 pipeline | **不成立**：严格模式下赋值抛 TypeError → 被 `.catch` 当拒绝处理，结果是可读的 `permission_denied` |
| 执行器同步抛错会导致 `tool/start` 没有配对的 `tool/end` | **不成立**：`finally` 里发 `tool/end`，探针断言 start/end 成对 |
| `**/x.ts` 要求至少一层目录 | **不成立**：`(?:[^/]+/)*` 允许零层，根层 `x.ts` 也命中 |


## 8. 决策点记录

> **2026-10-18 所有者拍板：Q1–Q10 全部按建议项通过。**

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 内置工具集 | **六个**：`read` / `write` / `edit` / `glob` / `grep` / `bash`（架构 §4 与 §8 示例已列）。不再加 `ls`（glob 覆盖）、不加 `task`/`todo`（产品能力，非骨架） |
| Q2 | 权限门与瀑布的先后 | **schema → pre-execute（改写/否决）→ 复检 → 冻结 → 权限 → 执行**（D2）。PB-02 ③/④ 要求"授权对象即执行对象"，只有把权限门放在瀑布**之后**才能成立；架构 §5.3 的 `ToolRejected` 否决语义保留 |
| Q3 | 审批通道形态 | **注入 `approve` 函数**（runner 选项），审批**逐次进行、不缓存**；无处理器 / 超时（默认 60s）/ 非 `true` / 抛错 一律**失败关闭**。07 经 `createAgentPlugin({ approve })` 接线（§4.3） |
| Q4 | 未注册工具的错误码 | **`execution_error`**（枚举无 `unknown_tool`，改枚举 = 改基线）；message 写 `unknown tool '<name>'` |
| Q5 | `tools` 段内容 | **名字 + 参数骨架 + 一句话描述**，不放完整 JSON Schema（机器 schema 已在 `LLMRequest.tools`，重复即烧 token）；末行回指"相对路径按工作目录解析" |
| Q6 | `builtin:tools` 是否支持 `disabled` | **支持**（与 04 同形，含 `Array.isArray` 拒绝数组）。理由：无热卸载的前提下，用户需要一个"别把 bash 给模型看"的正当出口，权限 `deny` 只挡执行不挡展示 |
| Q7 | glob/grep 的遍历范围 | 跳过 `.git` 与 `node_modules`（硬编码）、不跟符号链接、深度 ≤20、单次遍历 ≤20,000 条目；`glob` 默认 200 / 上限 1000 条，`grep` 默认 100 / 上限 500 条。**不做 .gitignore 解析**（需额外格式实现，且与"跳过两个大目录"的收益重叠） |
| Q8 | bash 的 shell 与超时 | `auto` 在 **setup 时探测一次**（`bash -c 'exit 0'`），失败退 powershell，两者皆无则**启动失败**；`timeoutMs` 只能调小（`min(args, config)`），不允许模型给自己续命 |
| Q9 | 结果截断 | pipeline 硬上限 **64k 字符**、中段截断（留头 60% / 尾 40%）；工具自身另有更小的默认（read 2000 行、glob 200 条、grep 100 条）。不在 05 做摘要（归 06 的 compaction） |
| Q10 | 是否新增错误类 | **不新增**（与 04 Q6 同）：运行期失败全部是 `ToolResult`；setup 期失败走 `BootError` 通道 |

### 附：与 06 / 07 / 08 / 09 的职责边界

- **06**：setup 时 `createToolRunner(ctx, { approve, timeoutFor })` 一次；每 step 按 `ToolDefinition.concurrency` 与 `config.tools.maxParallel` 调度 `runner.run(...)`；`req.tools = toToolSchemas(ctx.tools.list())`。**06 不得自己 append `tool/result`**（05 已做），也不得绕过 runner 直接调 `def.execute`。
- **07**：默认 `plugins` 必须含 `builtin:tools`（与"默认 plugins 非空"同一条 DoD）；提供审批实现并经 `registerBuiltin('agent-loop', createAgentPlugin({ approve }))` 注入（§4.3）；F-02/F-03 的信任提示与本模块无关（05 不做沙箱）。
- **08 / 09**：只 `ctx.tools.register(def)`，自动获得 schema 校验、权限门、截断、入 log；MCP 工具名**必须**以 `mcp__` 开头（否则 `mcp__*` 通配规则不命中，兜底变 `ask`）；`concurrency` 建议 `'parallel'`（远端 IO）。
