/**
 * 呈现主题（§4.3.1）：渲染层的样式层，决定输出是**富化**还是**恒等**。
 *
 * 三条设计约束：
 *
 * 1. **显式参数，不读 `io.isTTY`**。`CliIO.isTTY` 是 `process.stdin.isTTY`，语义是
 *    "能否向用户**提问**"（§4.6 的审批通道据此决定非交互时一律拒绝）；而能否着色该看
 *    **stdout**。`mdsh > out.txt` 下 stdin 是 TTY、stdout 是文件，复用它会把转义码写进
 *    文件——正好破坏渲染层"输出要能被管道消费"的自律（Q12）。
 *    另一半理由是测试：`render.test.ts` / `repl.test.ts` / 集成夹具的伪 IO 几乎都是
 *    `isTTY: true`，若渲染内部按它分支，那些精确断言（含 `render.test.ts` 的**相等**
 *    断言与**长度**断言）会全部走富化路径而变红。做成显式参数后"未声明即 plain"，
 *    现有断言一行不用改（Q17）。
 * 2. **plain 主题是恒等变换**：不是"去掉颜色"，而是让输出与富化改造**前逐字节一致**。
 *    这条由集成链路 10 守门（§6.2：整个 REPL 生命周期的 stdout/stderr 不含 `\x1b`）。
 * 3. **零依赖**：ANSI 就是 `\x1b[…m` 这类字符串，手写十几行足够，不必引 chalk
 *    （`package.json` 的 `dependencies` 至今为空，Q18）。
 */

/** 重置全部属性。每个着色串都必须以它收尾，否则后续输出会一直带着上一段的颜色。 */
const RESET = '\x1b[0m'
/** 加粗。 */
const BOLD = '\x1b[1m'
/** 弱化（多数终端渲染为灰）。 */
const FAINT = '\x1b[2m'
/** 青（品牌与强调）。 */
const CYAN = '\x1b[36m'
/** 绿（成功）。 */
const GREEN = '\x1b[32m'
/** 红（失败）。 */
const RED = '\x1b[31m'
/** 黄（警告）。 */
const YELLOW = '\x1b[33m'

/**
 * 分隔线的字符宽度（Q20）。
 *
 * **固定值，不读终端宽度**：为一条分隔线给 `CliIO` 加 `columns` 字段不值当——
 * D2 的 IO 面是刻意收窄的（只需 `out` / `err` / `lines` / `isTTY` / `rich`）；
 * 60 在 80 列与 120 列下都不折行。
 */
export const RULE_WIDTH = 60

/**
 * 呈现主题：一组"给字符串加样式"的函数。
 *
 * `rich === false` 时全部为恒等变换，因此**调用方可以无分支地调用它们**——
 * 富化与否的差别只体现在"值不同"，不体现在"要不要调"。
 */
export interface Theme {
  /** 是否富化。调用方仅用它决定**结构**（要不要插分隔线这类纯富化装饰）。 */
  readonly rich: boolean
  /** 品牌与主标题：加粗青。 */
  brand(text: string): string
  /** 强调（模型名、工具名）：青。 */
  accent(text: string): string
  /** 弱化（次要信息、耗时、提示）：灰。 */
  dim(text: string): string
  /** 成功（✓）。 */
  ok(text: string): string
  /** 失败（✗ 与错误码）。 */
  bad(text: string): string
  /** 警告（接入点体检提示）。 */
  warn(text: string): string
  /** 一条分隔线（已含颜色；`plain` 下是等宽的裸横线）。 */
  rule(): string
}

/** 恒等主题（plain）：非富化模式使用，所有函数原样返回入参。 */
export const PLAIN_THEME: Theme = {
  rich: false,
  brand: (text) => text,
  accent: (text) => text,
  dim: (text) => text,
  ok: (text) => text,
  bad: (text) => text,
  warn: (text) => text,
  rule: () => '─'.repeat(RULE_WIDTH),
}

/**
 * 构造主题。
 *
 * @param rich 是否富化。**应由 `CliIO.rich` 决定**（生产取 `process.stdout.isTTY`，
 *   见 `detectRich`）；测试不传时渲染层按 plain 处理
 * @returns 主题；`rich === false` 时返回 `PLAIN_THEME`（同一个对象，便于引用相等判断）
 */
export function createTheme(rich: boolean): Theme {
  if (!rich) return PLAIN_THEME
  const wrap =
    (open: string) =>
    (text: string): string =>
      `${open}${text}${RESET}`
  return {
    rich: true,
    brand: wrap(`${BOLD}${CYAN}`),
    accent: wrap(CYAN),
    dim: wrap(FAINT),
    ok: wrap(GREEN),
    bad: wrap(RED),
    warn: wrap(YELLOW),
    rule: () => `${FAINT}${'─'.repeat(RULE_WIDTH)}${RESET}`,
  }
}

/**
 * 判定是否启用富化（Q16 / Q18）。
 *
 * 四条否决规则，任一条命中即为 plain：
 * - **stdout 不是 TTY**（管道 / 重定向 / CI 日志）⇒ 转义码无处可渲染；
 * - **`NO_COLOR` 非空**（社区约定，no-color.org）⇒ 尊重用户的显式关闭；
 * - **`TERM=dumb`** ⇒ 哑终端不解释转义序列；
 * - **旧版 conhost**（win32 且既无 `WT_SESSION` 也无 `TERM`）⇒ 不解释 ANSI，会原样印出
 *   转义码。Windows Terminal 与 VS Code 集成终端都会置二者之一，故只排除这一档。
 *
 * @param options.stdoutIsTTY stdout 是否终端（生产传 `Boolean(process.stdout.isTTY)`）
 * @param options.env 环境变量（默认 `process.env`；注入是为了让单测不必改真环境）
 * @param options.platform 平台（默认 `process.platform`；同上）
 * @returns 是否启用富化
 */
export function detectRich(options: {
  stdoutIsTTY: boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): boolean {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (!options.stdoutIsTTY) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.TERM === 'dumb') return false
  if (platform === 'win32' && !env.WT_SESSION && !env.TERM) return false
  return true
}
