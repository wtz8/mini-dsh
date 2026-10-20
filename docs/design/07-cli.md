# 07-cli 设计

> 状态：**Baseline**（2026-10-18 所有者拍板：**§8 的 Q1–Q15 全部按建议项通过**；并明确"代码不用严格限制行数，超了也没事"——预算仅作登记，不作门禁，见 §7 预算说明。2026-10-18 晚代码评审通过，X1–X5 与 Y1–Y9 全部处置完毕——其中 Y7–Y9 为 2026-10-19 外部全模块审查追加，见 §7）
> 预算：~1.0k 行（架构 §4；本次范围预计 ~1.3k，**超预算不阻断**，见 §7 预算说明）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §4.1/§4.2 的 boot/shutdown 与 dispose 约定、§5 边界表）、`01-config.md`（Baseline，`loadConfig` / `ConfigError` / `resolvePermission`）、`02-llm.md`（Baseline，`LlmError.kind` 五分类、`createLlmPlugin({fetchImpl})`）、`03-session.md`（Baseline，`SessionError.kind`、`list()`）、`04-prompt.md`（Baseline）、`05-tools.md`（Baseline，**重点 `ApproveHandler` 与审批失败关闭**）、`06-agent.md`（Baseline，**重点 §8 附则"与 07 的职责边界"、§4.7 错误处置、§5 边界表**）、`architecture.md` **0.1.7**（§5.2 取消信号边界与 `AgentControl.sessionId`、§5.5 启动序列、§7 目录布局）

## 1. 背景与目标

07 是骨架的**宿主层**（架构 §3 顶端的"宿主 · src/cli"）：它是整个项目里唯一不在插件系统内的组件（与 `loadConfig()` 同，架构 §5.5），也是唯一把"前六个模块交付的能力"变成"一个能用的命令行程序"的地方。

对应骨架契约（**07 不改任何既有签名**；评审期 Y4 **纯新增**了 `AgentControl.sessionId` 一个字段，
不改任何既有签名，见 §7 Y4 与 `architecture.md` 0.1.7）：

- architecture §5.5 启动序列：`loadConfig()` → `boot(config)` → REPL（`ctx.agent.resolve().run(...)`）。
- architecture §5.2 取消信号边界：Ctrl+C **两段式**——第一次 `cancel()`，第二次才触发 `ctx.signal` / `shutdown`。
- architecture §3：`REPL · 流式渲染 · 权限询问 · slash 命令`。
- architecture §2：`bin` 入口 `mdsh`。

07 还承接了前六个模块累积下来的**七条宿主义务**（散落在 PROGRESS.md 遗留表与 05/06 的设计文档里，列举于此作为需求来源）：

| # | 义务 | 出处 |
|---|---|---|
| O1 | **默认 `plugins` 非空**且含 `builtin:prompt` / `builtin:tools` / `builtin:agent-loop`（否则 `render()` 无工具段、调用全得 `execution_error`、`ctx.agent.resolve()` 抛 `'not mounted'`） | PROGRESS 遗留表"升级为阻塞项"、F-16、06 §8 附则 1 |
| O2 | **提供审批实现**并注入 `createAgentPlugin({ approve })`（否则所有 `ask` 含权限兜底都失败关闭，CLI"什么都不能写"） | 06 §8 附则 2、PB-02 ② |
| O3 | **Ctrl+C 两段式** | 架构 §5.2、06 §8 附则 4 |
| O4 | **分支处置 `LlmError`（按 `kind`）/ `SessionError` / `BootError` / `ConfigError`**——06 不吞前两类、01 抛第三类、boot 抛第四类 | 06 §8 附则 5、errors.ts 各类的 JSDoc |
| O5 | **`shutdown` 超时兜底**：内核 dispose 不设超时，07 用 `Promise.race` + 强制退出 | PROGRESS 遗留表"dispose 无超时" |
| O6 | **项目配置信任提示**（F-02/F-03）：项目层可加载任意本地 JS 插件、可改 `model.baseUrl` / `model.apiKeyEnv` | PROGRESS 遗留表 F-02 / F-03 |
| O7 | 会话 id 的可见性：`AgentControl` 无 id 出口，07 监听 `session/append` 的 `session/header` 拿 id | 06 §8-Q1 |

目标（一句话）：让 `mdsh` 起来后能"问一句、看流式回复、工具要授权就问一次、Ctrl+C 能打断、/exit 能干净退出"，且启动失败时把错误说清楚而不是抛一堆 stack。

**非目标**（防范围膨胀）：

- 不做 rich TUI：无 ANSI 着色、无光标控制、无进度条（零依赖 + 输出可被管道消费）。
- 不做输入增强：无历史命令、无行编辑、无 Tab 补全（这些是 `readline`/`ink` 的产品化价值，非骨架）。
- 不做配置写入：不写 `config.json`、不写信任清单落盘（信任每次启动重问，见 §8-Q3）。
- 不做 `/compact`（06 压缩只在 step 开头内部触发，无对外口子；改 `AgentControl` 契约不值当，见 §8-Q7）。
- 不做 README / 总 LOC 复核（架构 §9 的独立收尾项）。
- 不改 `Config` 形状、不改 `contracts.ts` 任何签名（07 的全部策略落在自身常量，见 §8-Q14）。

## 2. 对外契约

模块落在 `src/cli/`（01–07 的宿主侧目录惯例），另加一个**非 TS 的 bin 引导脚本** `bin/mdsh.js`。

出口分两类（沿用 01 的判定）：07 是**宿主能力**，不经 `src/index.ts` 转发（那张出口面是插件侧 SDK 面，架构 §5.5 已确立"config 不属于插件系统"，宿主程序同理）。

### 2.1 宿主侧（`src/cli/index.ts`）

```ts
/** 版本号（与 package.json 同步；不读文件是因为 dist 下相对路径会漂移）。 */
export const VERSION = '0.1.0'

/** 默认插件表：用户未配置 `plugins` 时由 07 补齐（O1）。顺序即挂载顺序。 */
export const DEFAULT_PLUGINS: readonly PluginEntry[]

/** 两次 Ctrl+C 判定为"退出"的时间窗（毫秒，§4.5）。 */
export const DOUBLE_INTERRUPT_MS = 2000
/** shutdown 的兜底超时（毫秒，O5）：超时后强制 `process.exit`。 */
export const SHUTDOWN_TIMEOUT_MS = 3000

/** 命令行 flags 的解析结果（§3.2）。 */
export interface CliFlags {
  /** `--resume <id>`：启动时复用会话 */
  resume?: string
  /** `--config-dir <dir>`：全局配置目录（默认 `~/.minidsh`） */
  globalDir?: string
  /** `--no-project`：不读项目层配置（F-02 的逃生口） */
  noProject: boolean
  /** `--trust-project`：跳过项目层插件的信任确认（非交互场景用） */
  trustProject: boolean
  /** `--log-level <level>`：覆盖 `config.logLevel` */
  logLevel?: Config['logLevel']
  /** `--help` / `--version`：打印后退出码 0，不进入 REPL */
  help: boolean
  version: boolean
}

/** 纯函数：argv → flags；未知 flag 视为错误返回 `undefined`（§5 表）。 */
export function parseFlags(argv: readonly string[]): CliFlags | undefined

/** 纯函数：`config.plugins` 为空时补默认表（O1；不改其它字段）。 */
export function withDefaultPlugins(config: Config): Config

/**
 * 进程入口：flags → 配置 → 信任确认 → 注册 builtin → boot → REPL → 退出流程。
 * @returns 退出码（0 正常 / 1 失败）；**不调用 `process.exit`**，由 bin 决定
 */
export function main(argv: readonly string[], io?: CliIO): Promise<number>

/* ---- 以下为可脱离进程单测的实现面（D2：宿主逻辑与 process 全局解耦） ---- */

/** 一行输入的读取器（§3.3）：REPL 与审批共用同一队列。 */
export interface LineReader {
  /** 取下一行（已去尾部 `\r`）；EOF 后恒返回 `null` */
  next(): Promise<string | null>
  /** 提问：先写 prompt 再取下一行；被 `interrupt()` 打断时返回 `null` */
  ask(prompt: string): Promise<string | null>
  /** 打断一次进行中的 `ask`（Ctrl+C 用），使其以 `null` 结算 */
  interrupt(): void
  /** 关闭：摘掉 data 监听、唤醒全部等待者（`null`） */
  close(): void
}

/** 宿主的 IO 面（生产接 `process.*`，测试注入伪实现）。 */
export interface CliIO {
  out(text: string): void            // 渲染与提示（stdout）
  err(text: string): void            // 诊断与错误（stderr）
  lines: LineReader
  /** 是否交互式；非 TTY 时不打提示符、审批自动失败关闭（§8-Q4） */
  isTTY: boolean
}

/** 从 `Readable` 构造行泵（生产传 `process.stdin`）。 */
export function createLineReader(input: Readable): LineReader
/** 生产用 IO 面（`process.stdout` / `process.stderr` / stdin 行泵）。 */
export function createProcessIO(): CliIO

/** slash 命令表（§4.4）：`/help` `/exit` `/quit` `/session` `/sessions` `/tools` `/resume`。 */
export const COMMANDS: readonly CliCommand[]
export interface CliCommand {
  name: string                       // 不含斜杠
  usage: string
  summary: string
  /** 命令体；`ctx` 是动态取用的当前内核（`/resume` 重启后会换） */
  run(ctx: CommandContext, arg: string): Promise<CommandOutcome>
}

/** 命令执行结果：`resume` 携带目标会话 id，由 REPL 交给 `CliOptions.restart` 执行。 */
export type CommandOutcome =
  | { kind: 'continue' }
  | { kind: 'exit' }
  | { kind: 'resume'; id: string }

/** `createCli` 的入参（实现期定型，见 §3.4）。 */
export interface CliOptions {
  ctx: Ctx
  config: Config
  io: CliIO
  /** `/resume` 的重启回调（由 `main` 提供，§4.4） */
  restart?: (id: string) => Promise<Ctx | undefined>
  /** 启动体检结果（横幅提示用，§4.8） */
  audit?: ProjectAudit
  /**
   * 启动时的会话 id（O7 / X1）。**不能靠监听 `session/header` 取得**：06 在
   * `setup()` 内就创建/打开会话，该事件在 `boot()` 期间已写完，07 订阅时收不到。
   */
  sessionId?: string
}

/** 构造可注入的 REPL（集成测试主入口，§6.2）。 */
export function createCli(options: CliOptions): CliHandle
export interface CliHandle {
  /** 跑完整个生命周期（启动 → REPL → 退出流程），返回退出码 */
  start(): Promise<number>
  /** 模拟一次 Ctrl+C（SIGINT 处理器与测试共用同一入口，§4.5） */
  interrupt(): void
  /** 请求结束 REPL（`/exit` 与 EOF 共用） */
  requestExit(): void
}

/** 错误分类（§4.7）：把四类错误翻成人类可读的单行诊断 + 退出码建议。 */
export function describeError(err: unknown): { text: string; exitCode: number; retryable: boolean }
```

### 2.2 与骨架的装配形态

```text
bin/mdsh.js
  └─ main(argv)
       ├─ parseFlags(argv)                       // 未知 flag ⇒ 打印 usage，退出码 1
       ├─ loadConfig({ globalDir, projectDir, flags:{ logLevel, plugins? } })
       │                                          // --no-project ⇒ projectDir 指向空目录（D1）
       ├─ withDefaultPlugins(config)              // O1：plugins 为空才补
       ├─ inspectProject(projectFile)             // O6：非 builtin 插件 / baseUrl / apiKeyEnv 体检
       │    └─ 需要确认且未 --trust-project ⇒ 询问；拒绝 ⇒ 退出码 1
       ├─ registerBuiltin('llm'/'session'/'prompt'/'tools')   // 各模块自带的 register*Builtin()
       ├─ registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId: flags.resume }))
       │                                          // O2：approve 由 07 实现（§4.6）
       ├─ boot(config) ⇒ ctx                      // 失败 ⇒ BootError ⇒ 打印 mounted + 退出码 1
       ├─ 订阅渲染：stream/chunk · tool/start · session/append           // §4.3
       ├─ REPL：next() → slash? 命令 : agent.run({ text })                // §4.2
       └─ 退出流程：race(shutdown(ctx), 3000ms) → process.exit(code)      // O5
```

### 2.3 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | `--no-project` 通过把 `loadConfig({ projectDir })` 指向**一个确定不存在的目录**实现 | `LoadConfigOptions.projectDir` 只接受字符串目录，没有"忽略项目层"开关；加开关要改 01（已 Baseline）。指向空目录命中 `readJsonFile` 的 `ENOENT` 分支返回 `undefined`，效果等价于忽略项目层（§8-Q10） |
| D2 | 宿主逻辑与 `process` 全局**解耦**：`main(argv, io?)` 可注入 IO，`CliHandle.interrupt()` 是 SIGINT 的唯一入口 | 07 的行为（REPL 循环、审批、两段式中断、退出码）必须能在集成测试里被驱动，否则唯一可测面只剩"起真进程"。与 03 D3 / 04 D3 / 05 D3 / 06 D3 同式的"核心与外壳分离" |
| D3 | **默认插件表在 07 侧补齐**，不回改 01 的默认值 | 01 §2.1 D1 已拍板"默认 `plugins` 为 `[]`"，且当时各 builtin 尚未就位；补齐动作只在"用户没配"时发生，语义是宿主的兜底而非配置的默认值（§8-Q2） |
| D4 | **回合内错误不终止 REPL**：`LlmError` / `SessionError` 打印诊断后回到提示符 | 06 §4.7 明确"原样上抛给 07"，07 的处置策略是宿主决策；一次 500 不该让用户丢掉整个会话（只有启动期的 `ConfigError` / `BootError` 才退出，§8-Q11） |
| D5 | `main()` **返回退出码而不直接 `process.exit`** | 退出是 bin 的权利；返回码让集成测试能断言退出码，也让 `finally` 里的清理先跑完（§4.7） |
| D6 | 行读取**不用 `node:readline`**，手写行泵 | REPL 与审批共用同一 stdin：审批发生在 `run()` 的 await 期间，此时 REPL 不在读行。用 readline 需要在两条消费路径间 `pause/resume` 并自己处理未消费的缓冲；手写行泵把"队列 + 等待者"做成一处，且能直接吃 `Readable.from([...])` 做单测（§8-Q1） |

## 3. 数据结构

### 3.1 模块文件与 LOC 预估

| 文件 | 职责 | 预估 | 实绩 |
|---|---:|---:|---:|
| `types.ts` | 选项 / IO 面 / 命令 / 常量 | 90 | **234** |
| `flags.ts` | argv 解析 + `--help` 文案 | 110 | **99** |
| `defaults.ts` | `DEFAULT_PLUGINS` / `withDefaultPlugins` / `VERSION` | 70 | **34** |
| `io.ts` | 行泵 + 生产 IO 面 | 130 | **141** |
| `approve.ts` | 审批通道（invocation 文案化 + y/N 询问） | 100 | **58** |
| `render.ts` | 渲染格式化 + 事件订阅（流式文本 / 工具行 / 回合摘要 / 横幅） | 120 | **100** |
| `commands.ts` | slash 命令表与执行 | 160 | **145** |
| `repl.ts` | 主循环 + 两段式中断 + 内核重启（`/resume`） | 220 | **160** |
| `diagnose.ts` | 错误分类（`describeError`）——**实现期新增（X1）** | — | **101** |
| `main.ts` | 启动序列 + 项目层体检与信任确认 + 退出流程 | 260 | **326** |
| `index.ts` | 宿主侧出口 | 30 | **44** |
| `bin/mdsh.js` | bin 引导脚本（**JS，不计入 TS LOC**） | ~8 | 26 |
| | **合计** | **~1.29k** | **1442** |

> `diagnose.ts` 是新拆出来的：错误分类原计划放 `main.ts`，但 `commands.ts` 也要用，
> 放在 main 会形成 `commands → main → repl → commands` 的循环引用（X1）。

### 3.2 flags 形态

```text
mdsh [--resume <id>] [--config-dir <dir>] [--no-project] [--trust-project]
     [--log-level debug|info|warn|error] [--help] [--version]
```

- `plugins` **不设 flag**：插件表是数组且整值替换（01 §3），命令行里表达不了；需要改插件表就写项目配置。
- `--log-level` 走 `loadConfig({ flags })` 的 flags 层（01 已支持 `logLevel`），不额外改配置。
- 未知 flag / 缺参数值 ⇒ `parseFlags` 返回 `undefined` ⇒ 打印 usage 到 stderr、退出码 1（fail-fast，与 01"死配置早暴露"的立场一致）。

### 3.3 行泵（`io.ts`）

```ts
interface LineReaderState {
  buffer: string                       // 未成行的残余
  queue: string[]                      // 已成行、尚未被消费
  waiters: Array<(line: string | null) => void>   // 等待者（至多一个：REPL 与审批互斥）
  interrupted: boolean                 // ask 被打断
  eof: boolean
}
```

- `data` 事件累积 buffer，按 `\n` 切行 push 进 `queue`；有等待者则立即唤醒（**先到先服务**，一次一行）。
- `end` / `close` ⇒ `eof = true`，唤醒等待者传 `null`；之后所有 `next()` / `ask()` 立即返回 `null`。
- `interrupt()` 只作用于**当前进行中的 `ask`**：置 `interrupted` 并唤醒它（`null`）。REPL 的 `next()` 不受影响——它本就只在回合外等待。
- 关闭时必须移除 `data` / `end` 监听，否则 `process.stdin` 的引用会拖住事件循环（退出流程依赖这一点，§4.7）。

**REPL 与审批不会真正竞争**：REPL 只在 `run()` 之外 `next()`，审批只在 `run()` 之内 `ask()`，二者在时间上互斥。行泵仍按"单一等待者队列"实现，是为了让回合进行中用户提前敲入的行被**缓冲**（回合结束后 REPL 立刻读到），而不是被吞掉。

### 3.4 REPL 状态

```ts
interface ReplState {
  ctx: Ctx
  config: Config
  sessionId: string | undefined        // 来自 session/header 事件（O7）
  exiting: boolean                     // /exit 或 EOF 置位
  /** 上一次 Ctrl+C 的时刻；用于两段式判定（§4.5） */
  lastInterruptAt: number
  /** 当前是否有在途回合（决定 Ctrl+C 的第一次语义） */
  turnRunning: boolean
}
```

### 3.5 项目层体检结果（`main.ts`）

```ts
interface ProjectAudit {
  /** 项目配置文件路径（不存在时为 undefined ⇒ 无需体检） */
  file?: string
  /** 非 `builtin:` 的插件来源（F-02：可加载任意本地代码） */
  localPlugins: string[]
  /** 项目层是否覆盖了接入点（F-03：可改 endpoint 与凭据来源） */
  overridesEndpoint: boolean
  /** 生效的 baseUrl 是否明文 http 且非本机（02 记录的已知风险，07 只提示） */
  insecureEndpoint: boolean
}
```

## 4. 核心流程

### 4.1 启动序列（`main`）

```text
main(argv, io?):
  ① flags = parseFlags(argv)
     undefined ⇒ err(usage) ; return 1
     flags.help ⇒ out(usage) ; return 0
     flags.version ⇒ out(VERSION) ; return 0
  ② io ??= createProcessIO()
  ③ config = await loadConfig({ globalDir: flags.globalDir,
                                projectDir: flags.noProject ? EMPTY_DIR : undefined,
                                flags: { logLevel: flags.logLevel } })
     catch ConfigError ⇒ err(describeError) ; return 1
  ④ config = withDefaultPlugins(config)                        ← O1
  ⑤ audit = await inspectProject(process.cwd(), config, flags)
     if (audit.localPlugins.length && !flags.trustProject)
          ok = await io.lines.ask(信任提示)                     ← O6（§4.8）
          ok !== true ⇒ err('已拒绝项目级插件…可用 --no-project / --trust-project') ; return 1
     if (audit.insecureEndpoint) err('warn: baseUrl 为明文 http…')
  ⑥ 注册 builtin：llm / session / prompt / tools（各模块 register*Builtin）
     再 registerBuiltin('agent-loop', createAgentPlugin({ approve: createApproveHandler(io),
                                                          sessionId: flags.resume }))  ← O2
  ⑦ ctx = await boot(config)
     catch BootError ⇒ err(启动失败 + mounted 名单) ; return 1
  ⑧ handle = createCli({ ctx, config, io, audit })
     code = await handle.start()
  ⑨ 退出流程（§4.7）：race(shutdown(ctx), SHUTDOWN_TIMEOUT_MS) → io.lines.close() → return code
```

- 步骤 ⑥ 的 `registerBuiltin('agent-loop', …)` **取代** `registerAgentBuiltin()`（后者注册的是无 `approve` 的默认实例，06 §4.1 注释已指明"07 应当用自己的实例替换"）。
- 步骤 ⑤ 的 `EMPTY_DIR` = `path.join(os.tmpdir(), 'mdsh-no-project')`（D1：不存在 ⇒ 项目层读不到）。
- 步骤 ③ 的 `ConfigError` 与 ⑦ 的 `BootError` 都发生在 REPL 之前，**此时不需要 `shutdown`**（前者还没 boot；后者 boot 内部已清理，R3）。
- `registerBuiltin` 同名重复注册会抛错（内核语义）：步骤 ⑥ 只在进程启动时执行一次；REPL 内的 `/resume` 重启需要**先退订再注册**（保存句柄，§4.4）。

### 4.2 REPL 主循环（`repl.ts`）

```text
start():
  ① subscribes = attachRender(ctx, io)          ← §4.3，返回退订句柄数组
  ② 横幅：mdsh · provider/name · session <id> · 输入 /help 查看命令
  ③ while (!exiting):
       line = await io.lines.next()
       if (line === null) break                 ← EOF = 退出（退出码 0）
       text = line.trim()
       if (text === '') continue                ← 空行不跑回合（06 §5 第 1 行：过滤空输入归 07）
       if (text.startsWith('/')) { outcome = await dispatch(text) ; … }
       else {
         turnRunning = true
         try { summary = await ctx.agent.resolve().run({ text }) }      ← 06
         catch (err) { err(describeError(err)) ; continue }             ← D4：打印后继续
         finally { turnRunning = false }
         out(回合摘要行)                                                 ← §4.3
       }
  ④ 退订渲染监听器
  ⑤ return 0
```

- `run()` 期间**不读行**：用户输入被行泵缓冲，回合结束后由 `next()` 依次取出（§3.3）。
- 步骤 ③ 的命令分派：`/exit` / `/quit` ⇒ `exiting = true`；`/resume <id>` ⇒ 重启内核（§4.4）；其余命令执行后继续循环。
- 未知命令 ⇒ 打印"未知命令，/help 查看"并继续（不退出、不抛错）。
- 只有 `/exit` 与 EOF 会让 `start()` 返回；**Ctrl+C 的第二段同样置 `exiting`**（§4.5）。

### 4.3 渲染（`render.ts`）

订阅三个通知事件（架构 §5.3），全部为**同步派发、永不抛错**的总线语义：

| 事件 | 渲染 |
|---|---|
| `stream/chunk`（`delta.type === 'text'`） | 增量写 `delta.delta`（不加前缀、不换行） |
| `stream/chunk`（其余三种） | 忽略（`tool-call` 由下面两行表达；`usage` / `end` 无渲染含义） |
| `tool/start` | `\n· ${name} …\n` |
| `session/append`（`event.type === 'tool/result'`） | `  ↳ ${ok ? '✓' : '✗ ' + code} ${单行化(content, 120)}\n` |
| `session/append`（`event.type === 'session/header'`） | 记下 `id`，不打印（横幅已打）。**实际 id 由启动序列确定**（X1：本事件在 boot 期间已发完，07 订阅时收不到），此分支只是兜底 |

回合结束（REPL 侧）：`\n— turn N · steps S · tokens in/out —`，`interrupted` 时前置一行 `（已取消）`。

- **工具结果用 `session/append` 而非 `tool/end` 渲染**：05 的时序是 `tool/start → execute → tool/end → post-execute → append`（pipeline §4.1 步骤 ⑧⑪），`tool/end` 时结果还没入 log；而 `tool/result` 的载荷带 `ok` / `error.code`，正好是渲染要的结论。
- 无 ANSI、无进度条：输出到管道时（非 TTY）同样可读（§1 非目标）。**此条已由 §4.3.1 修正为"按输出目标分支"**——原措辞把一条正确的约束（管道可读）泛化到了 TTY 场景，代价是交互观感停留在调试输出。
- 监听器抛错由总线捕获（架构 §5.3），渲染代码仍保持"不抛"的自律：格式化函数对任意 `content` 都安全（单行化 = 换行替换空格 + 截断）。

#### 4.3.1 呈现主题与富化渲染（2026-10-19 追加，`theme.ts`）

§4.3 的"无 ANSI"是**对管道的约束**，不是对终端的约束。追加一层 `Theme` 抽象，让两者同时成立：

| 模式 | 触发条件 | 输出 |
|---|---|---|
| **plain**（默认） | 未声明 `rich`，或 `detectRich()` 为 false | 与 §4.3 **逐字节一致**（恒等主题） |
| **rich** | `CliIO.rich === true`（生产由 `process.stdout.isTTY` 决定） | 分层横幅、工具区块带耗时、角色着色 |

富化后的三处形态（`plain` 侧不变）：

- **横幅**：主行 `mdsh <ver> · provider/model · session <id>`（品牌加粗 + 模型强调 + 会话弱化），下接弱化分隔线，次要信息（接入点 / 凭据来源）与用法提示降级为弱化或警告色，整体缩进两格成卡片状；
- **工具两行**：`● <name> …` → `└ ✓ <单行结果> · <耗时>`（失败为 `✗ <code>`，走红）。耗时来自 `tool/start` 记的时间戳与 `session/append(tool/result)` 时刻之差（按 `callId` 存在闭包 Map 里，退订时清空）；
- **回合摘要**：前置一条分隔线，摘要行弱化。文案与 `plain` 保持**相同子串**（`turn N` / `steps S` / `tokens in/out`），任何 `toContain` 断言在两种模式下都成立。

**为什么是显式 `Theme` 参数而不是读 `io.isTTY`**（两条例由，缺一不可）：

1. `CliIO.isTTY` 是 `process.stdin.isTTY`，语义是"能否向用户**提问**"（§4.6 据此决定非交互时审批一律拒绝）；能否着色该看 **stdout**。`mdsh > out.txt` 下 stdin 是 TTY、stdout 是文件——复用它会把转义码写进文件，正好破坏上面那条自律。
2. 现有伪 IO 几乎都是 `isTTY: true`（`render.test.ts:50` / `repl.test.ts:118` / 集成夹具 / `main.test.ts:27`），若渲染内部按它分支，`render.test.ts` 的 8 处精确断言（含 103 行的**相等**断言、124–125 行的**长度**断言）会全部走富化路径而变红。做成显式参数后"未声明即 plain"，**现有断言一行不用改**。

**`plain` 主题的强约束**：所有函数是**恒等变换**，不是"去掉颜色"。目的是让富化改造对管道输出零影响，此不变量由集成测试链路 9 守门（§6.2）。

### 4.4 slash 命令（`commands.ts`）

| 命令 | 行为 |
|---|---|
| `/help` | 打印命令表（名称 / 用法 / 说明）与两条交互说明（Ctrl+C 两段式、`/exit`） |
| `/exit` `/quit` | `return 'exit'` |
| `/session` | 打印当前会话 id、provider/model、已跑回合数（回合数经 `ctx.sessions.read(id)` 数 `turn/start`） |
| `/sessions` | `ctx.sessions.list()` 最近 10 条：id / 创建时间 / cwd / model |
| `/tools` | `ctx.tools.list()` + `resolvePermission(config.permissions, name)` ⇒ 每行 `name · auto/ask/deny` |
| `/resume <id>` | 缺参数 ⇒ 打印用法并继续；否则 `return 'restart'` |

`/resume` 的重启（REPL 内，**不经进程重启**）：

```text
restart(id):                                 // 由 main 提供，经 CliOptions.restart 注入 REPL
  ① await race(shutdown(ctx), SHUTDOWN_TIMEOUT_MS)      ← 旧内核收尾（会话 store 落盘）
  ② agentUnsub()                                        ← 先退订旧的 agent-loop 工厂
     agentUnsub = registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId: id }))
  ③ ctx = await boot(config)                            ← 新内核（新容器，session 可再 mount）
     失败 ⇒ err(BootError) ; 返回 undefined ⇒ REPL 置 exiting 并返回退出码 1
     （不重试：会话 id 不存在应在启动期就报）
  ④ REPL 侧：退订旧渲染监听器 → 换 ctx → 重新订阅 → 只打 session 行
```

重启动作放在 `main` 而非 `repl`：注册/退订 builtin 与 `boot` 是启动序列的权属（`main` 持有 `config` 与 `agentUnsub`），
REPL 只消费"给我一个新 ctx 或什么都没有"这一个回调（与 D2"宿主逻辑与外壳分离"同式）。

- 重启后 `sessionId` 直接取 restart 的目标 id（X1：不再是靠 header 事件）。
- `boot()` 的重复调用：内核注释写"重复/并发调用 `boot()` 为未定义行为"（M0 未做防护），但这里是**串行**的 shutdown → boot，且两者用的是不同的 `Ctx` 对象（每次 boot 新建容器与 WeakMap 记录），因此不构成"同一 ctx 重复 boot"。

### 4.5 Ctrl+C 两段式（`repl.ts` + `main.ts`）

架构 §5.2：第一次解释为"取消当前回合"，第二次才触发 `ctx.signal` / `shutdown`。

```text
interrupt():                                  // SIGINT 处理器与 CliHandle.interrupt 共用
  now = Date.now()
  if (turnRunning && now - lastInterruptAt > DOUBLE_INTERRUPT_MS):
       lastInterruptAt = now
       ctx.agent.resolve().cancel('user interrupt')     ← 第一次：取消回合
       io.lines.interrupt()                             ← 唤醒可能卡在审批的 ask（§4.6）
       out('\n（已请求取消，再按一次 Ctrl+C 退出）')
       return
  // 第二次（或空闲时的第二次）：
  requestExit()                                ⇒ exiting = true
  io.lines.interrupt()
  // 退出流程由 main 的 finally 执行：shutdown(ctx) + 超时兜底
```

- **空闲时（无在途回合）同样走两段式**：第一次只打印提示不退出，避免误触丢会话（§8-Q8）。
- 时间窗 `DOUBLE_INTERRUPT_MS = 2000`：窗口内的第二次按下才算"连续"；跨回合的两次取消不该被累加成退出。
- `cancel()` 之后回合仍在跑（06 会落前缀 + `turn/end`）；REPL 继续 `await run()`，跑完才回到提示符。所以"第二次 Ctrl+C 退出"的语义是：**置 `exiting` 并 shutdown**——`shutdown` 会触发 06 插件的 `dispose`（abort + `abortAndWait`），在途回合随即收尾。
- SIGINT 只在**进程入口**注册（`main` 步骤 ⑧ 之前 `process.on('SIGINT', …)`），测试直接调 `handle.interrupt()`，不依赖信号。

### 4.6 审批通道（`approve.ts`）

`ApproveHandler` 签名（05）：`(invocation: Readonly<ToolInvocation>) => boolean | Promise<boolean>`——**只有显式 `true` 才放行**（PB-02 ②）。07 的实现：

```text
createApproveHandler(io):
  return async (inv) => {
    ① 非交互（!io.isTTY）⇒ err('非交互环境，ask 策略一律拒绝') ; return false
    ② 打印：
         ⚠ 工具 ${inv.name} 需要授权（turn ${inv.turnNo} / step ${inv.stepNo}）
           ${单行化(prettyArgs(inv.args), 400)}
         允许？[y/N]
    ③ answer = await io.lines.ask('')      // 打断时返回 null
    ④ return answer !== null && /^(y|yes)$/i.test(answer.trim())
  }
```

- `inv.args` 的展示用 `JSON.stringify` 后截断（不引第三方格式化器），每个参数一行会更好但预算有限，取"单行 + 400 字符截断"。
- **不缓存决定**：每次调用都问（与 05 的"授权对象 === 执行对象"一致；缓存会把改写后的 args 用旧授权放行）。
- 返回值不是 `true` 的一切（`n` / 空行 / EOF / 被打断 / 抛错）都是拒绝；`ask` 抛错时（stdin 已关）同样落到 `false`，绝不降级为放行。
- 审批超时由 05 管（`DEFAULT_APPROVAL_TIMEOUT_MS = 60_000`），07 不再设自己的计时器。
- 取消与审批的关系（06 X3 / 05 pipeline）：05 的 `requestApproval` 内部已把回合信号纳入 `Promise.race`，取消会先产出 `cancelled`；07 的 `io.lines.interrupt()` 只负责**让挂着的 `ask` 自行结算**，避免那一行输入在回合结束后被 REPL 误读成新输入。

### 4.7 退出流程与错误分类（`main.ts`）

```text
// 正常路径（REPL 结束）与异常路径共用同一段收尾
finally:
  io.lines.close()                                   // 摘监听，防止 stdin 拖住事件循环
  await Promise.race([ shutdown(ctx), delay(SHUTDOWN_TIMEOUT_MS) ])   ← O5
  // 超时不报错：打印一行 warn 后强制退出（process.exit 由 bin 执行）
```

错误分类（`describeError`，按错误类与 `kind` 分支；文案英文与内核其余错误一致，**诊断面向用户**）：

| 错误 | 打印 | 退出码 | REPL 是否继续 |
|---|---|---:|---|
| `ConfigError`（`file`） | `config error: <msg>\n  file: <file>` | 1 | 否（启动期） |
| `ConfigError`（`path`） | `config error: <msg>\n  path: <path>`（附"可用 --config-dir 换目录"） | 1 | 否 |
| `BootError` | `boot failed: <msg>\n  mounted: [a, b, c]` | 1 | 否（启动期） |
| `LlmError{config}` | `llm: 环境变量 <apiKeyEnv> 未设置（检查全局/项目配置）` | — | **是**（D4） |
| `LlmError{http}` | `llm: provider 返回 <status>（详见 baseUrl 与模型名）` | — | 是 |
| `LlmError{network}` | `llm: 无法连接 <host>（检查网络与 baseUrl）` | — | 是 |
| `LlmError{protocol}` | `llm: 响应不是预期的 SSE 流（baseUrl 是否指向 OpenAI 兼容端点）` | — | 是 |
| `LlmError{aborted}` | 不打印（06 已在回合内消化为 `interrupted`） | — | 是 |
| `SessionError{not_found}` | `session: 会话不存在（用 /sessions 查看，或 mdsh --resume <id>）` | — | 是 |
| `SessionError{io}` | `session: 读写失败 <file>（磁盘/权限）` | — | 是 |
| `SessionError{corrupt}` | `session: 会话文件已损坏 <file>` | — | 是 |
| 其它未知错误 | `<name>: <message>` + stack（`--log-level debug` 时） | — | 是 |

- 表格右列是 07 的**策略选择**：只有"启动期无法构成可用进程"的错误才终止（§8-Q11）。
- REPL 内的 `try/catch` 包住 `run()`；**不包**命令执行（命令自身的错误按未知错误打印并继续）。

### 4.8 项目层体检与信任确认（`main.ts`，O6）

```text
inspectProject(cwd, config, flags):
  ① 读 <cwd>/minidsh.json（不存在 ⇒ 返回空 audit；JSON 非法由 01 在 loadConfig 已报错，
     这里只做字段体检，不再解析一遍语义）
  ② localPlugins = plugins[].source 中不以 'builtin:' 开头的那些（F-02）
  ③ overridesEndpoint = 项目层含 model.baseUrl 或 model.apiKeyEnv（F-03）
  ④ insecureEndpoint = 生效的 baseUrl 以 'http://' 开头且 host 不是 localhost/127.0.0.1/[::1]
```

处置：

| 情况 | 处置 |
|---|---|
| `localPlugins` 非空 + 交互 | 打印来源清单与"它们将在当前目录以你的权限执行任意代码"，`ask('继续？[y/N]')`；`y` 放行，其余 **退出码 1** |
| `localPlugins` 非空 + `--trust-project` | 不询问，直接启动（`err` 打一行"已按 --trust-project 加载项目插件"） |
| `localPlugins` 非空 + 非交互且无 `--trust-project` | 不询问 ⇒ **退出码 1**（无法取得同意，默认拒绝；提示 `--trust-project` / `--no-project`） |
| `overridesEndpoint` | 只 `err` 一行提示"项目配置改写了接入点：baseUrl=… apiKeyEnv=…"，**不阻断** |
| `insecureEndpoint` | 只 `err` 一行 warn（02 记录的已知风险：明文 http 会明文发送 API key） |

- 拒绝时不降级为"剔除插件后继续"：**少挂了插件却照常启动**比启动失败更难排查（与 01"死配置早暴露"、04"禁用段显式抛错"同一立场）。
- `inspectProject` 读的是**文件里的字段存在性**，不做合并语义判断——最终生效值以 `config` 为准（打印的就是 `config.model.baseUrl`）。

## 5. 边界情况与错误处理

| # | 情况 | 行为 |
|---|---|---|
| 1 | 未知 flag / 缺参数值 | 打印 usage 到 stderr，退出码 1 |
| 2 | `--help` / `--version` | 打印到 stdout，退出码 0，不 boot |
| 3 | 全局/项目配置 JSON 非法 | `ConfigError` ⇒ 诊断 + 退出码 1（尚未 boot，无需清理） |
| 4 | 用户未配 `plugins` | 补 `DEFAULT_PLUGINS`（O1）；**用户配了则不覆盖** |
| 5 | 项目配置含本地插件（F-02） | 交互询问；拒绝 / 非交互 ⇒ 退出码 1（§4.8） |
| 6 | `boot` 失败（未知 builtin / 插件抛错 / resume 的 id 不存在） | `BootError` ⇒ 打印 message + `mounted` 名单，退出码 1（boot 内部已 dispose） |
| 7 | `ctx.agent.resolve()` 抛 `'not mounted'` | 只可能发生在默认表里没有 agent-loop；O1 已保证不会发生；真发生时按未知错误打印并退出（REPL 起不来） |
| 8 | 空行 / 全空白输入 | 跳过，不跑回合（06 不过滤，过滤归 07） |
| 9 | 未知 slash 命令 | 打印"未知命令" + `/help`，继续 |
| 10 | `/resume` 的 id 不存在 | 重启内核时 06 在 setup 内 `open()` 抛 `SessionError{not_found}` ⇒ 转 `BootError` ⇒ 打印，`exiting = true`，退出码 1 |
| 11 | 回合中 `LlmError` / `SessionError` | 打印分类诊断（§4.7），回到提示符，**会话保留** |
| 12 | 回合被取消（第一次 Ctrl+C） | 06 落 `interrupted` 前缀 + `turn/end`；07 打印"（已取消）"与摘要行 |
| 13 | 审批中按 Ctrl+C | `cancel()` + `io.lines.interrupt()`；05 判 `cancelled`（06 X3），挂起的 `ask` 以 `null` 结算 |
| 14 | 非交互（管道输入）下需要 `ask` | 直接 `false`（失败关闭）+ stderr 提示；回合继续（工具结果为 `permission_denied`） |
| 15 | stdin EOF | REPL 结束，退出码 0（与 `/exit` 同路径） |
| 16 | `shutdown` 挂起（某插件 dispose 不返回） | `Promise.race` 3s 兜底 ⇒ warn + 退出（O5） |
| 17 | 渲染监听器抛错 | 总线捕获记 `log.error`（架构 §5.3）；渲染代码自身亦不抛（§4.3） |
| 18 | 行泵已关闭后仍有 `next()` | 恒返回 `null`（EOF 语义），不抛 |
| 19 | 会话 id 取不到（`session/header` 未到达） | 横幅与 `/session` 显示 `unknown`；不影响回合（06 持有 id，07 只显示） |
| 20 | Windows 下 `process.stdin` 的 CRLF | 行泵去掉尾部 `\r`（§3.3） |
| 21 | `--resume` 与 `/resume` 同时用 | `--resume` 决定启动会话，`/resume` 可再切换（重启内核） |
| 22 | `/resume` 时旧内核 shutdown 超时 | 同样 3s 兜底后继续 boot（不阻塞切换；warn 一行） |

## 6. 测试计划

> **实现结果**：单测 **8 文件 / 60 例**（覆盖下面全部编号点，另补了若干边界用例）；
> 集成 **8 链路 / 8 例**。门禁由 06 交付时的 485 例增至 **553 例**。

### 6.1 单元测试（`src/cli/**/*.test.ts`，与源码同目录）

**`flags.test.ts`**：

1. 空 argv ⇒ 全默认（`noProject=false` 等）。
2. `--resume <id>` / `--config-dir <dir>` 取值；缺值 ⇒ `undefined`。
3. `--no-project` / `--trust-project` / `--help` / `--version` 布尔位。
4. `--log-level` 非法值 ⇒ `undefined`（不给 01 喂脏值）。
5. 未知 flag ⇒ `undefined`。

**`defaults.test.ts`**：

6. `withDefaultPlugins`：空 `plugins` ⇒ 补默认表且含三个关键 builtin；非空 ⇒ **原样不动**（D3）。
7. `DEFAULT_PLUGINS` 顺序：`agent-loop` 在 `session` / `llm` / `tools` 之后（挂载顺序约束）。
8. 返回值是新 Config 对象、不改入参（纯函数；01 的 Config 未冻结，07 不得就地改）。

**`io.test.ts`**（`Readable.from([...])` 注入）：

9. 多行一次到达 ⇒ `next()` 逐行返回（缓冲正确）。
10. 跨 chunk 的半行 ⇒ 拼接后再成行。
11. CRLF ⇒ 尾部 `\r` 被去掉。
12. EOF ⇒ `next()` 返回 `null`，之后恒 `null`。
13. `ask()` 在 EOF 时返回 `null`；`interrupt()` 使进行中的 `ask` 返回 `null` 且不影响后续 `next()`。
14. 回合期间到达的行被缓冲：`ask` 消费一行后，`next()` 仍能取到其余行。
15. `close()` 后不再有 `data` 监听（断言 `listenerCount` 归零）。

**`approve.test.ts`**（伪 IO）：

16. 输入 `y` / `Y` / `yes` ⇒ `true`；`n` / 空行 / 其它 ⇒ `false`。
17. 非交互 ⇒ `false` 且写 stderr。
18. `ask` 返回 `null`（EOF / 打断）⇒ `false`（不降级放行）。
19. `ask` 抛错 ⇒ `false`（不把异常漏给 05）。
20. 打印内容含工具名与 turn/step（断言 prompt 文案）。

**`render.test.ts`**（伪 ctx 的事件总线或直接注入伪总线）：

21. `stream/chunk` 的 text delta ⇒ 增量写出；其余三种不产生输出。
22. `tool/start` ⇒ `· name …`；`session/append(tool/result)` ⇒ `↳ ✓` / `↳ ✗ code`。
23. 超长 content 被单行化并截断到 120。
24. `session/header` ⇒ 记录 id（不打印）。
25. 退订后不再产生输出。

**`commands.test.ts`**：

26. `/help` 输出含全部命令名。
27. `/exit` / `/quit` ⇒ `'exit'`。
28. `/session` 用伪 sessions 的 `read` 数出回合数；id 未知时显示 `unknown`。
29. `/sessions` 输出 `list()` 的条目（伪 store 两条）。
30. `/tools` 输出每个工具的权限三值（伪 config 三种各一）。
31. `/resume` 缺参数 ⇒ 提示且返回"继续"。
32. 未知命令 ⇒ 提示 + 继续。

**`repl.test.ts`**（伪 agent control + 伪 IO）：

33. 普通输入 ⇒ 调一次 `run({ text })`，摘要行含 turn/steps/tokens。
34. 空行 ⇒ 不调 `run`。
35. 斜杠输入 ⇒ 走命令分派，不调 `run`。
36. EOF ⇒ 结束，退出码 0。
37. 回合抛 `LlmError{http}` ⇒ 打印诊断且**循环继续**（第二行输入仍能跑）。
38. 第一次 `interrupt()`（有在途回合）⇒ 调 `cancel()` 且不退出；窗口内第二次 ⇒ `exiting`。
39. 窗口外的第二次 ⇒ 仍是 `cancel()`（不累加成退出）。
40. 空闲时第一次 `interrupt()` ⇒ 只提示不退出。

**`main.test.ts`**（伪 IO + 伪 config 目录）：

41. `--help` / `--version` ⇒ 退出码 0，不 boot（断言未调用）。
42. 配置错误 ⇒ 退出码 1，stderr 含 `file` 或 `path`。
43. boot 失败 ⇒ 退出码 1，stderr 含 `mounted`。
44. 项目层有本地插件且用户拒绝 ⇒ 退出码 1；`y` ⇒ 进入 REPL（伪 agent 断言 `run` 被调）。
45. 正常启动 ⇒ 退出码 0，且 `shutdown` 被调用（清理断言）。

### 6.2 集成测试（`tests/integration/cli.test.ts`，真实组合根 + 伪 fetch + 伪 stdin）

与 `tests/integration/agent.test.ts` 同式：真实 `boot`、真实 JSONL（tmp 目录）、真实工具与 prompt，**只在网络出口与 stdin/stdout 注入伪实现**。通过 `createCli({ ctx, config, io })` 或 `main(argv, io)` 驱动，断言收集到的全部 stdout 文本。

实现结果：**十条链路**（X5：原计划的第 1、2 条合并；评审期新增 6b / 6c / 7b 三条——见 Y3 / Y5；X6 追加第 10 条守门）。

1. **默认 plugins 生效**（O1）：不配 `plugins`（用 `createDefaultConfig()`）⇒ 启动后 `ctx.prompt.render()` 含工具段、`ctx.agent.resolve()` 可用、一个纯文本回合跑完（`stepCount:1`）。
2. **一问一答链路**：伪 stdin 投一行 ⇒ stdout 含流式回复文本与 `— turn 1 · steps 1` 摘要行。
3. **工具 + 审批放行**：SSE 回一个 `write` 调用（权限 `ask`）⇒ stdout 出现授权提示 ⇒ 投 `y` ⇒ 工具执行、`tool/result` 入 log、stdout 含 `↳ ✓`。
4. **审批拒绝**：同样的调用投 `n` ⇒ 结果为 `permission_denied`（log 断言），stdout 含 `↳ ✗ permission_denied`，回合继续到结束。
5. **两段式中断**：回合流式中 `interrupt()` 一次 ⇒ `interrupted:true` 且 REPL 未结束；再 `interrupt()` ⇒ 退出流程执行、`shutdown` 被调用（断言 `ctx.signal.aborted`）。
6. **`LlmError` 分类提示**：伪 fetch 返回 500 ⇒ stdout/stderr 含 `provider 返回 500` 字样，且 REPL 继续（再投一行仍能跑通）。
7. **`--resume` 与 `/resume`**：启动带 `--resume <id>`（先用一次 boot 造会话）⇒ 第二次进程 `turnNo` 从 2 起；REPL 内 `/resume <另一 id>` ⇒ 内核重启后会话切换（断言新 `session/header` 的 id）。
8. **项目配置信任确认（F-02）**：tmp 目录里放一份含 `./plugin.js` 的 `minidsh.json` ⇒ 启动出现确认提示；拒绝 ⇒ 退出码 1；带 `--trust-project` ⇒ 正常启动。
9. **dispose 超时兜底**：注入一个 dispose 永不返回的插件 ⇒ 退出流程在 ~3s 后结束（断言耗时 < 5s 且退出码仍产出）。
10. **管道模式零 ANSI**（X6 追加，`plain` 不变量的守门）：伪 IO 不声明 `rich` ⇒ 整个 REPL 生命周期收集到的 stdout/stderr **不含 `\x1b`**。此链路一旦变红，说明有人把着色写进了非富化路径。

## 7. 验收标准（DoD）

- [x] 设计文档状态为 **Reviewed**（§8 的 Q1–Q15 已于 2026-10-18 由所有者拍板，全部按建议项）
- [x] 实现落在**一个** package：`src/cli/`（十文件，见 §3.1）+ 一个 bin 引导脚本
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（**562 例**：单测 66 + 集成 11 + 前序模块 485）
- [x] §6.1 的单测点（66 例）与 §6.2 的集成链路（11 条）全部覆盖并通过
- [x] **O1**：未配置 `plugins` 时启动即挂载 llm/session/prompt/tools/agent-loop，且能跑完一个回合
- [x] **O2**：审批实现已注入，`ask` 工具在 `y` 下执行、`n` 下失败关闭（不得降级为 auto）
- [x] **O3**：Ctrl+C 第一段只取消回合、第二下才结束 REPL 并进入退出流程（窗口 2s）
- [x] **O4**：`LlmError`（按 kind）/ `SessionError` / `BootError` / `ConfigError` 四类各有可测的诊断分支
- [x] **O5**：`shutdown` 有 3s 超时兜底，挂起的 dispose 不会让进程永不退出
- [x] **O6**：项目级非 builtin 插件默认需确认，拒绝/非交互 ⇒ 退出码 1
- [x] **O7**：会话 id 在横幅与 `/session` 显示。**取得方式已改**（X1/Y1）：不是经 `session/append` 的 `session/header`，而是启动时取 `AgentControl.sessionId`（Y4 新增的契约字段，**确定取值**）；控制面未挂载时才回退到 `--resume` 参数或 `sessions.list()` 首条。集成覆盖见链路 6b（Y3：此前夹具漏传 `sessionId`，本条一度是"勾了但没测到"）
- [x] 不改 `contracts.ts` 任何签名、不改 `Config` 形状、不改动 01–06 的实现代码
- [x] 不新增运行时依赖（行泵手写，`package.json` 的 `dependencies` 仍为空）
- [x] 公共导出全部有中文 JSDoc（用途 / 参数 / 返回值 / 副作用 / 错误行为）
- [x] LOC 在预算内或偏差已说明：实绩 **1433 行**（预算 ~1.0k，超出部分全来自 O1–O7，所有者已明确不设门禁）
- [ ] 所有者已 review 代码
- [ ] 设计文档状态更新为 **Baseline**
- [ ] `docs/PROGRESS.md` 已更新（步骤、LOC 实绩、下一步动作）

### 偏离记录（实现期，编号 X）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | **新增 `diagnose.ts`，错误分类从 `main.ts` 剥离** | `commands.ts` 的 `/session`、`/sessions` 失败也要给出诊断，若从 `main.ts` 引入会形成 `commands → main → repl → commands` 的循环引用 |
| X2 | **会话 id 不由 `session/header` 事件取得**（O7 的原方案落空） | 06 在 `setup()` 内 create/open 会话（06 §8-Q1），`session/header` 在 `boot()` 期间已写入 log，07 的渲染订阅在 boot 之后——**永远收不到**。真机烟测时 `/session` 显示 `unknown` 暴露了它。改为：启动时由 `--resume` 参数或 `sessions.list()` 的最新一条确定（`initialSessionId`），`/resume` 重启后直接取目标 id；渲染层的 header 分支降级为兜底。**Y4 之后再演进**：改取 `AgentControl.sessionId`（确定取值），`list()` 首条降为"控制面未挂载"时的兜底 |
| X3 | **两段式的第二下用 `lines.close()` 而非 `lines.interrupt()`** | 空闲时 REPL 正 `await lines.next()`。只置 `exiting` 的话，循环要等下一次 stdin 有动静才检查得到——用户按了 Ctrl+C 还得敲一下回车才退出。close 唤醒等待者（EOF 语义），循环随即结束。`interrupt()` 仍只作用于 `ask`（防止把 REPL 的等待误判成 EOF） |
| X4 | **注册 builtin 整段包 try/catch，失败时退订已注册者** | builtin 表是进程级全局、同名重复注册会抛错。半途失败（上一次启动没退干净）若不清理，故障会转移到下一次启动。探针 P1 实证：占了位的手柄仍能正常退订（说明没误删别人的注册） |
| X5 | 集成测试合并为**八条链路**（原 §6.2 的第 1、2 条——"默认 plugins 生效"与"一问一答"——合并为一条） | 两者共享同一套装配，拆开要重复一次 boot；O1 的断言（工具段/agent 可用）与流式渲染断言放在同一回合里更连贯 |
| X6 | **（2026-10-19 交付后追加）新增 `theme.ts` 呈现主题层，渲染按输出目标分支富化** | §4.3 的"无 ANSI"约束是对的（管道要可读），但被无差别应用到了 TTY——交互观感因此停留在调试输出。追加一层 `Theme`（见 §4.3.1）：显式参数、`plain` 为恒等变换、未声明即 plain，故**现有 8 处渲染断言一行未改**。属交付后追加的实现，性质为实现期偏离，故归入 X 系而非另起编号。决策见 §8 的 Q16–Q18 |

### 偏离记录（评审期，编号 Y）

| # | 偏离 | 理由 |
|---|---|---|
| Y1 | **`initialSessionId` 去掉自行的 `localeCompare` 排序，直接取 `list()[0]`** | X2 的修正是"自己排序取最新"，但 03 的 `SessionStore.list()` **已保证按 `createdAt` 降序**（同值再按 id 降序保证稳定，`store.ts:138`）。自排既重复了 store 的契约，同值时又丢了 id 兜底；`localeCompare` 对 ISO 串还带 locale 依赖。改为直接取首条，并把"依赖 store 降序"写进 JSDoc——契约在一处，不在两处 |
| Y2 | **X1/X2 相关注释与文案同步**（三处） | 修了实现没修说明，会让后来者按旧描述理解：`render.ts` 的 JSDoc 仍写"从 `session/header` 取"；`render.ts` 的 header 分支未标明**正常启动下不可达**（保留是为防 06 将来改懒创建，但要说清它不是主路径）；`commands.ts` 的 unknown 文案仍写"尚未收到 session/header" |
| Y3 | **集成夹具补 `sessionId` 装配，O7 从"零覆盖"变为有回归** | `bootCli` 只造了 `createCli({ ctx, config, io, restart })`，没传 `sessionId`——集成测试里横幅与 `/session` **恒为 `unknown`**，而 §7 DoD 的 O7 当时已勾。真机走 `main` 完整装配所以烟测正常，**集成层从未真正覆盖 O7**。现夹具改用真实 `initialSessionId`（导出它，避免夹具抄一份变成"自证"），并新增链路 6b |

| Y4 | **`AgentControl` 新增 `readonly sessionId`，07 改取控制面的 id**（骨架契约改动，架构文档同步至 **0.1.7**；06 设计文档记为 Y3） | 这是 X2 的**彻底解**：06 的控制面闭包本就持有 `session.id`（`plugin.ts:104` 传入），只是 `loop.ts` 的 handle 没带出。补一个字段后，会话 id 从"`list()` 首条"的**推定**变成**确知**，Y1 记下的同毫秒 `createdAt` 边界消失，`/resume` 后的 id 也自证。代价不在代码（净增约 5 行），而在流程——`AgentControl` 属架构 §5.2 骨架契约，改动须改基线并重新 review：同步落点 `contracts.ts` / `agent/loop.ts` / `plugin/containers.test.ts`（手写字面量）/ `architecture.md`（版本 + §12 记录）/ `06-agent.md`（Y3）。对 08/09 亦有用：插件要知道"当前会话"时不必自己猜。**所有者 2026-10-18 拍板"现在就改"**（07 未提交时改最便宜） |
| Y5 | 补三条此前"绿灯但没测到"的集成链路 | ①**`--resume` 不存在的 id ⇒ 启动期 `BootError` ⇒ 退出码 1**（O4 的启动期分支，此前只测了 resume 成功路径）；②**`/resume` 后断言 `/session` 显示的就是目标 id**（此前只断言"已切换到会话"文案，id 错了也照样绿）；③**夹具补 `audit`，覆盖横幅的项目配置提示行**（O6 的可见部分）。三条均为 Y3 同类的"夹具没走完整装配"问题 |
| Y6 | **提交前复核的四项清理**：①`/sessions` 去掉自行的 `createdAt.localeCompare` 排序，原样沿用 `list()` 的顺序；②删除 `ReplState.turnRunning` 死字段；③`USAGE` 补上 `-r` 短标；④`restart` 内的 `registerBuiltin` 一并包进 try/catch | ①是 **Y1 的漏网点**：Y1 只在 `initialSessionId` 里去掉了冗余排序，`commands.ts` 的 `/sessions` 同样自排了一次，且其行内注释称"list() 不保证时间序"——与 `store.ts` list 的契约（createdAt 降序 + 同值 id 降序）**直接矛盾**。功能上当前无害（sort 稳定 + ISO 串字典序等于时间序），但"排序契约只在 store 一处"的不变量被破坏，且 `localeCompare` 带 locale 依赖，与 store 的码位比较在含标点/大小写混排时可能分叉。②`turnRunning` 只被写、从未被读（Q8 拍板"空闲也走两段式"后 `interrupt()` 不再需要它），而 `types.ts` 的 JSDoc 仍写着"决定 Ctrl+C 第一次的语义"——**承诺了一个不存在的行为**。③`-r` 在 `parseFlags` 里被接受，却没写进 `--help` 文案（§3.2 的七个 flag 里也没列），属文档漂移。④`restart` 里 `registerBuiltin` 抛错会逃出 `handle.start()`，被 bin 层印成"未捕获的**启动**错误"，可它发生在会话中途；与 ⑤ 同式统一转成"返回 `undefined` ⇒ 退出码 1" |

### 评审修复追加（2026-10-19 外部全模块审查）

| # | 偏离 | 理由 |
|---|---|---|
| Y7 | **（P1）行泵单一等待者被并发 ask 覆盖**：默认配置（`permissions: {}` ⇒ 全工具 `ask`、`tools.maxParallel: 4`）下一步内 ≥2 个工具并发审批时，`take()` 无守卫覆盖 `waiter`——前 N-1 个等待者的 resolve 被**静默丢弃**，只能等 60s 审批超时后误判 `permission_denied`（用户无从知晓为何没问它）。附带三处同源缺陷：`chunk.toString('utf8')` 在 chunk 边界切多字节字符（中文输入变 U+FFFD 并永久进 log）；stdin 无 `'error'` 监听（流故障 ⇒ 等待者永久挂、无监听的流抛错还可能带崩进程）；切行逐行 slice 是 O(n²) | `waiter` 改 **FIFO 等待者队列**（`interrupt()` 打断全部 ask、`close()` 唤醒全部）；入队后立即结算杜绝插队；`StringDecoder` 拼回跨 chunk 多字节字符；挂 `'error'` 监听按 EOF 收尾；一次扫描切全部行。探针实证（真实 `createLineReader`）：修复前连输两行 `y` 只有最后一个等待者结算；已补 4 例回归（并发 FIFO / interrupt 全打断 / 多字节切断 / 流错误） |
| Y8 | **并发审批的提示交错、答案对应关系靠猜**（Y7 的另一半）：行泵队列化后每个 `ask` 都能拿到一行，但 N 个"允许？[y/N]"会**同时打出**，用户无从知道哪行答案对应哪个工具 | `createApproveHandler` 加**串行闸门**（promise 链）：一次只问一个，答完再问下一个。等待者不会挂死（EOF / interrupt / 60s 审批超时都会结算），闸门必然放行，无死锁路径。已补 1 例接真实行泵的回归：并发两次审批，断言第一时刻只有 1 个提示、两行输入与两次审批一一对应 |
| Y9 | **（P3）`boot()` 无超时兜底**（O5 只包了退出路径）：boot 失败时内核逆序 dispose 已挂载插件（R3），该清理不设超时——单个挂起的 dispose 让 `boot()` 永不返回，**启动期挂死**（连 REPL 都进不去、无任何输出）；09 的 MCP 插件（stdio 子进程）落地后此路径风险升级 | 新增 `bootWithTimeout`（`BOOT_TIMEOUT_MS = 15s`，比 shutdown 的 3s 宽——boot 含本地插件动态 import，冷启动 + 杀软扫描下文件读可能慢到秒级）：超时按启动失败处理（退出码 1 + 诊断），`main` 与 `restart` 两处接入。集成测试的真实 boot 为毫秒级，15s 余量充足（全量门禁复跑全绿） |

### 评审排除的误报

| 怀疑 | 结论 | 证据 |
|---|---|---|
| 链路 6b 首跑失败（`/session` 显示 `unknown`）是 X2 没修好 / `createdAt` 同毫秒导致推定错 | **不是**。是测试夹具漏传 `sessionId`（Y3） | 打印 stdout 后确认横幅亦为 `session unknown`；而真机 `main` 烟测显示真实 id。补装配后链路 6b 绿 |
| 渲染层的 `session/header` 分支是死代码，应删 | **不删**，但标注 | 正常启动下不可达（header 在 boot 的 setup 内写完）；保留是为防 06 改为懒创建会话。已加注释说明"不要当成主路径，也不要因没跑进过就删掉而不留说明" |
| `initialSessionId` 取"最新一条"不可靠，应改契约加 `current()` | **一度判为"不改"，Y4 后已改** | 原判断：Q14 拍板 07 不改 `contracts.ts`，启发式是契约约束下的唯一解。复核发现真正的出口不是 `SessionStore.current()`（那会让无状态的多会话 store 变有状态），而是 **`AgentControl.sessionId`**——06 的闭包本就持有该 id。故以"加一个字段"的极小代价彻底解决，见 Y4 |

### 评审结论

X1–X5 全部**已改正或本就不构成缺陷**，无一"将错就错"：

- **X2、X3 是真 bug，实现期已改正**（会话 id 恒 unknown、空闲时 Ctrl+C 退不出）；评审期又清掉了 X2 的次生瑕疵（Y1）、说明残留（Y2，四处）、集成夹具漏装配（Y3），最后经 **Y4 彻底解决**（`AgentControl.sessionId`，架构文档 0.1.7）；
- **X1、X4、X5 不是缺陷**：拆文件避循环引用、注册失败清理、测试链路合并，都是实现期撞到的正常收尾，如实记载即可；
- **X2 经历了"修好 → 发现其实是契约缺出口 → 补出口"三段**：先是"监听 header 事件"方案落空，退为推定并留下同毫秒边界；评审复核发现 06 的控制面本就持有该 id，补一个字段即让推定变确知。教训是——**遇到"只能靠启发式"时，先确认是不是某个已存在的对象其实握着答案**。

### 预算说明

架构 §4 给 07 的预算是 ~1.0k 行，§3.1 预估 **~1.29k**，超出 ±20% 上界（1.2k）约 90 行。

**所有者 2026-10-18 拍板：全部按建议项（Q1–Q15），且明确"代码不用严格限制行数，超了也没事"**——因此本模块的预算只作登记，**不作为门禁**（process.md §6 的"偏差超 ±20% 须说明理由"此处已说明，无需另行批准）。总产品代码仍在架构硬上限 20k 之内（06 交付后 `src/` 全量非测试 **7108 行**，加 07 后约 8.4k）。

超出部分全部来自"前六个模块累积下来的宿主义务"（§1 的 O1–O7），而非功能膨胀：

| 义务 | 增量 |
|---|---:|
| O6 项目层体检与信任确认（F-02/F-03） | ~110 |
| O1 默认插件表与 O7 会话 id 可见性 | ~80 |
| O2 审批通道（含 invocation 文案化） | ~100 |
| O5 dispose 超时兜底 + O4 四类错误分类 | ~90 |
| D2 的 IO 解耦（行泵 + 可注入 IO 面） | ~130 |

## 8. 决策点记录（2026-10-18 所有者拍板：Q1–Q15 **全部按建议项**）

| # | 问题 | 决议 |
|---|---|---|
| Q1 | 行输入实现 | **手写行泵**。REPL 与审批共用同一 stdin，readline 需要在两条消费路径间 pause/resume 并自己管未消费缓冲；行泵把"队列 + 单一等待者"收在一处，且能直接吃 `Readable.from([...])` 做单测（D6） |
| Q2 | 默认 `plugins` 在哪补齐 | **07 侧 `withDefaultPlugins()`**。01 已拍板默认 `[]` 且已 Baseline；补齐只在"用户没配"时发生，是宿主兜底不是配置默认值（D3） |
| Q3 | 项目级插件被拒绝时的处置 | **退出码 1**。降级为"剔除插件继续启动"会让"少挂了插件"变成静默事实；启动失败 + 提示 `--no-project` / `--trust-project` 可诊断（§4.8） |
| Q4 | 非交互（管道）下遇到 `ask` | **一律拒绝 + stderr 提示**。无 TTY 就没法取得同意，失败关闭是唯一安全方向（PB-02 ②） |
| Q5 | slash 命令集 | **`/help` `/exit` `/quit` `/session` `/sessions` `/tools` `/resume`** 七条。`/tools` 展示权限三值是有诊断价值的低成本项 |
| Q6 | `/resume` 的实现 | **REPL 内重启内核**（经 `CliOptions.restart` 回调，动作实现在 `main`）。shutdown 旧 ctx → 退订并重注册 agent-loop（带 id）→ 新 boot |
| Q7 | 是否做 `/compact` | **不做**。06 的压缩只在 step 开头内部触发，无对外口子；为它扩 `AgentControl` 契约属基线变更，不值当。已登记 PROGRESS 遗留表 |
| Q8 | 空闲时第一次 Ctrl+C | **仍走两段式**：只打印"再按一次退出"，不直接退出，避免误触丢会话 |
| Q9 | 两次 Ctrl+C 的"连续"判定 | **2 秒时间窗**（`DOUBLE_INTERRUPT_MS`）。跨回合的两次取消不该被累加成退出 |
| Q10 | flags 集合 | **`--resume` `--config-dir` `--no-project` `--trust-project` `--log-level` `--help` `--version`**。`--no-project` 经"指向空目录"实现（D1），不改 01 |
| Q11 | 回合内 `LlmError` / `SessionError` 是否终止 REPL | **不终止**：打印分类诊断后回到提示符，会话保留，用户可改配置/换措辞重试（D4） |
| Q12 | 渲染口径 | **纯文本无 ANSI**：流式文本直接流出；工具两行（`· name …` + `↳ ✓/✗ code`，结果行由 `tool/result` 驱动而非 `tool/end`，因为后者早于入 log） |
| Q13 | 回合结束是否打印摘要 | **打印**：`— turn N · steps S · tokens in/out —`；`interrupted` 时加"（已取消）" |
| Q14 | 是否新增 `Config` 字段 / 改契约 | **不改**。07 的全部策略落在自身常量（`DOUBLE_INTERRUPT_MS` / `SHUTDOWN_TIMEOUT_MS` / `DEFAULT_PLUGINS`） |
| Q15 | 预算 | **不设门禁**：所有者明确"代码不用严格限制行数，超了也没事"。预估 ~1.29k 仍登记在 §7 预算说明，但不作为验收条件 |

#### 追加决策（2026-10-19，渲染观感改造）

| # | 问题 | 决议 |
|---|---|---|
| Q16 | 富化的判定读哪个 TTY | **新增 `CliIO.rich`，取 `process.stdout.isTTY`**，不复用 `isTTY`（= stdin）。两者的语义本就不同：stdin 的 TTY 决定"能否提问"，stdout 的 TTY 决定"能否着色"。`mdsh > out.txt` 下二者分叉，复用会把转义码写进文件 |
| Q17 | 富化如何不破坏现有断言 | **显式 `Theme` 参数 + `plain` 为恒等主题**。伪 IO 未声明 `rich` 即走 plain，故 `render.test.ts` 的相等/长度断言一行不用改；富化分支另写单测 |
| Q18 | 是否引 chalk 之类的依赖 | **不引**。ANSI 就是 `\x1b[…m` 字符串，手写十几行足够；`package.json` 的 `dependencies` 保持为空（与 Q14 同旨）。另尊重社区约定：`NO_COLOR` 非空、`TERM=dumb`、旧版 conhost（win32 且无 `WT_SESSION` / `TERM`）一律不富化 |
| Q19 | 是否加 `--no-color` flag | **不加**。环境变量已覆盖主要诉求，而加 flag 要动 `parseFlags` / `USAGE` / flags 形态测试，与本项"渲染是可替换末端、内核零改动"的叙事相悖。需要时再加 |
| Q20 | 分隔线是否读终端宽度 | **固定 60 字符**。为一条分隔线给 `CliIO` 加 `columns` 字段不值当（D2 的 IO 面是刻意收窄的）；60 在 80 与 120 列下都不折行 |

### 附：与 08 / 09 的职责边界

- **07 不认识任何具体插件**：默认插件表只列 `builtin:*`（08/09 是 `plugins/` 下的本地插件，由用户在项目配置里显式列出，走 F-02 的信任确认）。
- **08（memory）/ 09（mcp）的命令**：若它们要提供 slash 命令（如 `/memory`），07 不提供扩展点——`COMMANDS` 是宿主常量表。插件想加命令需改本模块（mini 版不为"插件扩展 REPL"留缝：命令是宿主主权，架构 §3 也把它画在宿主框内）。
- **09 的 MCP 工具权限**：`mcp__*` 的 `ask` 走同一条审批通道（§4.6），07 不需要知道工具来自 MCP。
- **给收尾项的提醒**：README 与总 LOC 复核属架构 §9 的独立里程碑，不在本模块内；07 只保证 `bin` 入口 `mdsh` 可用。
