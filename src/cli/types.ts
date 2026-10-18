import type { Config, Ctx, PluginEntry } from '../contracts.js'

/**
 * 07-cli 的对外类型与常量（宿主侧）。
 *
 * 07 是**宿主**而非插件（架构 §5.5 已确立"config 不属于插件系统"，宿主程序同理），
 * 因此本模块的出口不经 `src/index.ts` 转发——那张出口面是插件侧 SDK 面。
 *
 * 类型集中在本文件的原因与 05 的 `types.ts` 同式：`repl.ts` / `commands.ts` /
 * `main.ts` 三方互相引用这些形状，分散定义必然漂移。
 */

/**
 * 版本号。**写常量而不读 `package.json`**：dist 下的相对路径与源码不同
 * （`dist/src/cli/main.js` 与 `package.json` 的相对位置会变），读文件要为此
 * 额外做路径解析，不值当。改动此处时须同步 `package.json` 的 `version`。
 */
export const VERSION = '0.1.0'

/**
 * 两次 Ctrl+C 判定为"用户想退出"的时间窗（毫秒，§4.5）。
 *
 * 为什么需要窗口而不是"累计第二次"：跨回合的两次取消是两次独立意图
 * （回合 1 取消、回合 5 又取消），不该被累加成退出。
 */
export const DOUBLE_INTERRUPT_MS = 2000

/**
 * `shutdown()` 的兜底超时（毫秒，O5）。
 *
 * 内核的 `shutdown` 不设超时（M0 设计 §4.2：内核零策略），单个挂起的 `dispose`
 * 会让它永不返回。07 是宿主，负责把它兜住：超时后照常退出。
 */
export const SHUTDOWN_TIMEOUT_MS = 3000

/** 工具结果与审批提示里，单行文案的字符上限（§4.3 / §4.6）。 */
export const ONE_LINE_CHARS = 120
/** 审批提示里参数预览的字符上限（比结果行宽，因为要看全参数）。 */
export const ARGS_PREVIEW_CHARS = 400

/**
 * 默认插件表（O1）：用户未配置 `plugins` 时由 07 补齐。
 *
 * **顺序即挂载顺序**，且不可随意调换：`builtin:agent-loop` 必须最后——
 * 它在 `setup()` 内创建/打开会话（06 §8-Q1），需要 `builtin:session`
 * 已把 store 注入 `ctx.sessions`。
 */
export const DEFAULT_PLUGIN_SOURCES = [
  'builtin:llm',
  'builtin:session',
  'builtin:prompt',
  'builtin:tools',
  'builtin:agent-loop',
] as const

/**
 * 命令行 flags 的解析结果（`parseFlags` 的产出）。
 *
 * 刻意**不提供 `--plugins`**：插件表是数组且整值替换（01 §3 合并规则），
 * 命令行表达不了；要改插件表就写项目配置。
 */
export interface CliFlags {
  /** `--resume <id>`：启动时复用指定会话 */
  resume?: string
  /** `--config-dir <dir>`：全局配置目录（默认 `~/.minidsh`） */
  globalDir?: string
  /** `--no-project`：不读项目层配置（F-02 的逃生口） */
  noProject: boolean
  /** `--trust-project`：跳过项目层插件的信任确认 */
  trustProject: boolean
  /** `--log-level <level>`：覆盖 `config.logLevel` */
  logLevel?: Config['logLevel']
  /** `--help`：打印用法后退出码 0 */
  help: boolean
  /** `--version`：打印版本后退出码 0 */
  version: boolean
}

/**
 * 行读取器（§3.3）：REPL 与审批共用同一队列。
 *
 * 与 `node:readline` 的区别：readline 需要在"REPL 读行"与"审批提问"两条消费
 * 路径之间 `pause/resume` 并自己接管未消费的缓冲；行泵把"缓冲队列 + 单一等待者"
 * 收在一处，且能直接吃 `Readable.from([...])` 做单测（D6）。
 *
 * REPL 与审批**在时间上互斥**（REPL 只在回合外读行、审批只在回合内提问），
 * 行泵仍按队列实现，是为了让回合进行中用户提前敲入的行被缓冲而非丢掉。
 */
export interface LineReader {
  /**
   * 取下一行（已去掉尾部 `\r`）。
   * @returns 一行文本；**`null` 表示 EOF**，此后恒返回 `null`
   */
  next(): Promise<string | null>
  /**
   * 提问：先写 `prompt` 再取下一行。
   * @returns 一行文本；`null` 表示 EOF 或**被 `interrupt()` 打断**
   */
  ask(prompt: string): Promise<string | null>
  /**
   * 打断一次**进行中的 `ask`**，使其以 `null` 结算（Ctrl+C 用，§4.5）。
   * 对 `next()` 无效——REPL 的等待不该被"取消回合"误当成 EOF。
   */
  interrupt(): void
  /**
   * 关闭：摘掉流上的监听、唤醒全部等待者（`null`）。
   * 必须调用，否则 `process.stdin` 的引用会拖住事件循环，进程退不干净。
   */
  close(): void
}

/**
 * 宿主的 IO 面（D2）：生产接 `process.*`，集成测试注入伪实现。
 * 有了它，REPL 循环 / 审批 / 两段式中断 / 退出码这些行为才可能被测试驱动。
 */
export interface CliIO {
  /** 渲染与提示（stdout）；不做 ANSI 着色（§1 非目标） */
  out(text: string): void
  /** 诊断与错误（stderr） */
  err(text: string): void
  /** 行读取器（生产接 `process.stdin`） */
  lines: LineReader
  /**
   * 是否交互式。非 TTY 时：不打提示符、审批一律失败关闭（Q4），
   * 因为无 TTY 就无从取得用户同意。
   */
  isTTY: boolean
}

/** REPL 的可变状态（§3.4）。 */
export interface ReplState {
  /** 当前内核（`/resume` 重启后会换成新的 Ctx） */
  ctx: Ctx
  /**
   * 当前会话 id（O7）。
   *
   * 由**启动序列**确定：优先取 `AgentControl.sessionId`（Y4），控制面未挂载时回退到
   * `--resume` 参数或 `sessions.list()` 首条。`undefined` 时 UI 显示 `unknown`。
   *
   * **不是**来自渲染层监听 `session/append` 的 `session/header`——该事件在 `boot()`
   * 期间就写完了，07 的订阅挂载于 boot 之后，永远收不到（X1）。
   */
  sessionId: string | undefined
  /** 已置位则 REPL 在下一轮循环退出（`/exit` / EOF / Ctrl+C 第二段） */
  exiting: boolean
  /** 上一次 Ctrl+C 的时刻（时间戳毫秒）；0 表示从未按下 */
  lastInterruptAt: number
}

/** 命令执行结果（§4.4）。 */
export type CommandOutcome =
  /** 继续 REPL */
  | { kind: 'continue' }
  /** 结束 REPL（`/exit` / `/quit`） */
  | { kind: 'exit' }
  /** 切换会话：由 REPL 交给 `CliOptions.restart` 执行内核重启 */
  | { kind: 'resume'; id: string }

/** 命令执行时可取用的上下文（D2：命令不直接依赖模块级全局）。 */
export interface CommandContext {
  /** 当前内核（重启后是新的引用，故每次从 state 现取） */
  readonly ctx: Ctx
  /** 冻结的最终配置 */
  readonly config: Config
  readonly io: CliIO
  readonly state: ReplState
}

/** 一条 slash 命令（不含斜杠）。 */
export interface CliCommand {
  name: string
  usage: string
  summary: string
  /**
   * @param ctx 命令上下文（ctx 动态取用，`/resume` 重启后会换）
   * @param arg 命令后的参数（已 trim，无参数为空串）
   */
  run(ctx: CommandContext, arg: string): Promise<CommandOutcome>
}

/** `createCli` 的入参。 */
export interface CliOptions {
  ctx: Ctx
  config: Config
  io: CliIO
  /**
   * `/resume` 的重启回调（§4.4）。由 `main` 提供——注册/退订 builtin 与 `boot`
   * 是启动序列的权属，`main` 才持有 `config` 与 agent-loop 的注册句柄。
   * @returns 新的 Ctx；`undefined` 表示重启失败（会话不存在等），REPL 应退出
   */
  restart?: (id: string) => Promise<Ctx | undefined>
  /**
   * 启动时的会话 id（O7）。
   *
   * **不能靠监听 `session/header` 事件取得**：06 在 `setup()` 内就创建/打开了会话
   * （06 §8-Q1），`session/header` 在 `boot()` 期间已写入 log，而 07 的渲染订阅
   * 发生在 boot 之后——永远收不到它（X1）。
   */
  sessionId?: string
  /** 启动体检结果（仅用于横幅提示，§4.8） */
  audit?: ProjectAudit
}

/** REPL 句柄：进程入口与集成测试共用同一入口面（D2）。 */
export interface CliHandle {
  /** 跑完整个 REPL 生命周期（横幅 → 循环 → 收尾），返回退出码 */
  start(): Promise<number>
  /** 模拟一次 Ctrl+C（SIGINT 处理器与测试共用，§4.5） */
  interrupt(): void
  /** 请求结束 REPL（`/exit` 与 EOF 共用） */
  requestExit(): void
}

/** 项目层配置的体检结果（O6 / §4.8）。 */
export interface ProjectAudit {
  /** 项目配置文件绝对路径；不存在时为 `undefined`（无需体检） */
  file?: string
  /** 非 `builtin:` 的插件来源（F-02：它们将在当前目录以用户权限执行任意代码） */
  localPlugins: string[]
  /** 项目层是否覆盖了接入点（F-03：`model.baseUrl` / `model.apiKeyEnv`） */
  overridesEndpoint: boolean
  /** 生效的 `baseUrl` 是否明文 http 且非本机（02 记录的已知风险，07 只提示） */
  insecureEndpoint: boolean
}

/** `describeError` 的产出：一条人类可读诊断 + 退出码建议 + 是否值得重试。 */
export interface ErrorDiagnosis {
  /** 单行或多行诊断文案（不含 stack） */
  text: string
  /** 建议退出码：启动期错误 1；回合内错误 0（REPL 继续） */
  exitCode: number
  /** 是否"换个输入/配置还能继续"（回合内错误为 true） */
  retryable: boolean
}

/** `plugins[].source` 的内置前缀（`builtin:<name>`）。 */
export const BUILTIN_PREFIX = 'builtin:'

/** 默认插件表的 `PluginEntry` 形态（`withDefaultPlugins` 用）。 */
export type DefaultPluginEntry = PluginEntry
