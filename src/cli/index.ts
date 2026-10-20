/**
 * 07-cli 模块出口（宿主侧）。
 *
 * 与 01 的 `loadConfig()` 同式：**宿主能力不经 `src/index.ts` 转发**——后者是
 * 插件侧 SDK 面，而 CLI 是宿主程序（架构 §5.5）。bin 脚本与集成测试一律经本文件
 * import，不深引用 `repl.ts` / `main.ts` 等内部文件。
 */

// 常量与类型
export {
  ARGS_PREVIEW_CHARS,
  BUILTIN_PREFIX,
  DEFAULT_PLUGIN_SOURCES,
  DOUBLE_INTERRUPT_MS,
  ONE_LINE_CHARS,
  SHUTDOWN_TIMEOUT_MS,
  VERSION,
} from './types.js'
export type {
  CliCommand,
  CliFlags,
  CliHandle,
  CliIO,
  CliOptions,
  CommandContext,
  CommandOutcome,
  ErrorDiagnosis,
  LineReader,
  ProjectAudit,
  ReplState,
} from './types.js'

// 启动与退出流程
export { inspectProject, main } from './main.js'
export { createCli } from './repl.js'

// 可脱离进程单测的各层
export { DEFAULT_PLUGINS, withDefaultPlugins } from './defaults.js'
export { USAGE, parseFlags } from './flags.js'
export { createLineReader, createProcessIO } from './io.js'
export { createApproveHandler } from './approve.js'
export { attachRender, formatBanner, formatTurnSummary, oneLine } from './render.js'
export { createTheme, detectRich, PLAIN_THEME, RULE_WIDTH } from './theme.js'
export type { Theme } from './theme.js'
export { COMMANDS, findCommand } from './commands.js'
export { describeError } from './diagnose.js'
