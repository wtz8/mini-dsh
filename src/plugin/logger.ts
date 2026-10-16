import type { Logger } from '../contracts.js'

/** 日志级别权重：数值越大越严重；低于当前级别的日志被过滤。 */
const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 } as const

type LogLevel = keyof typeof LEVEL_WEIGHT

/**
 * 序列化单个 meta 参数。
 *
 * - `Error` 单独处理：`JSON.stringify(new Error(...))` 只会得到 `{}`，等于丢掉全部
 *   排障信息，因此取 `stack`（无 stack 时退 `name: message`）；
 * - 其余值先试 `JSON.stringify`，失败（循环引用、BigInt 等）退化为 `String()`；
 * - 输出永远不能因序列化失败而把调用方炸掉——日志是最底层的观测手段。
 */
function formatOne(m: unknown): string {
  if (m instanceof Error) return m.stack ?? `${m.name}: ${m.message}`
  try {
    return typeof m === 'string' ? m : JSON.stringify(m)
  } catch {
    return String(m)
  }
}

/** 序列化全部 meta 参数，以空格连接（任一参数序列化失败都不影响其余）。 */
function formatMeta(meta: unknown[]): string {
  return meta.map(formatOne).join(' ')
}

/**
 * 创建 Logger 实例（M0 内核直接交付的最终实现）。
 *
 * - 级别过滤：低于 `level` 的调用被静默丢弃；
 * - 输出目标：stderr（stdout 留给 07 CLI 渲染与模型流式输出）；
 * - 输出格式：`[级别] 消息 [meta...]`，每条一行。
 *
 * @param level 过滤级别（来自 `config.logLevel`，缺省 `'info'`，R4 决议）
 * @returns Logger 实例（四方法：debug/info/warn/error）
 */
export function createLogger(level: LogLevel): Logger {
  // 兜底：level 来自 config（01 从 JSON 解析），非法值不得让全部日志被过滤或全量放行，
  // 未知级别按 'info' 处理
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info
  /** 单条日志写出：stderr 上的 write 不会阻塞事件循环，失败也不上抛。 */
  const write = (lv: LogLevel, msg: string, meta: unknown[]): void => {
    if (LEVEL_WEIGHT[lv] < threshold) return
    const extra = meta.length > 0 ? ` ${formatMeta(meta)}` : ''
    process.stderr.write(`[${lv}] ${msg}${extra}\n`)
  }
  return {
    debug: (msg, ...meta) => write('debug', msg, meta),
    info: (msg, ...meta) => write('info', msg, meta),
    warn: (msg, ...meta) => write('warn', msg, meta),
    error: (msg, ...meta) => write('error', msg, meta),
  }
}
