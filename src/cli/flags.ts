import type { Config } from '../contracts.js'

import type { CliFlags } from './types.js'

/**
 * 命令行 flags 的手写解析（零依赖：不引 commander/yargs）。
 *
 * 只支持 §3.2 列出的七个 flag，`plugins` 刻意不设 flag——插件表是数组且整值
 * 替换（01 §3 合并规则），命令行表达不了；要改插件表就写项目配置。
 *
 * **未知 flag 与缺参数值一律失败**（返回 `undefined`）：与 01"死配置早暴露"、
 * 04"禁用段显式抛错"同一立场——静默忽略一个拼错的 flag 比启动失败更难排查。
 */

/** 合法日志级别（`Config['logLevel']` 的字面量集合，此处不引常量避免循环）。 */
const LOG_LEVELS: ReadonlyArray<NonNullable<Config['logLevel']>> = ['debug', 'info', 'warn', 'error']

/** 用法文案（`--help` 与解析失败共用）。 */
export const USAGE = `mdsh — MiniDSH 命令行（deepseek-harness 的架构级迷你复刻）

用法:
  mdsh [flags]

flags:
  --resume, -r <id>      启动时复用指定会话（配合 /sessions 查看 id）
  --config-dir <dir>     全局配置目录（默认 ~/.minidsh）
  --no-project           不读项目层配置 minidsh.json
  --trust-project        跳过项目层本地插件的信任确认
  --log-level <level>    日志级别: debug | info | warn | error
  --help, -h             打印本帮助
  --version, -v          打印版本号

交互:
  直接输入即发起一个回合；/help 查看命令；/exit 或 EOF 退出。
  第一次 Ctrl+C 取消当前回合，两秒内再按一次退出。`

/** 判断一个 token 是否"看起来像 flag"（用于检测缺失的参数值）。 */
function looksLikeFlag(token: string): boolean {
  return token.startsWith('-')
}

/**
 * 解析 argv。
 *
 * @param argv 不含 `node` 与脚本路径的参数数组（即 `process.argv.slice(2)`）
 * @returns 解析结果；**`undefined` 表示解析失败**（未知 flag / 缺参数值 / 级别非法）
 */
export function parseFlags(argv: readonly string[]): CliFlags | undefined {
  const flags: CliFlags = {
    noProject: false,
    trustProject: false,
    help: false,
    version: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--help':
      case '-h':
        flags.help = true
        break
      case '--version':
      case '-v':
        flags.version = true
        break
      case '--no-project':
        flags.noProject = true
        break
      case '--trust-project':
        flags.trustProject = true
        break
      case '--resume':
      case '-r':
      case '--config-dir':
      case '--log-level': {
        const value = argv[i + 1]
        // 缺值 / 值本身是另一个 flag ⇒ 失败（不把 `--resume --no-project` 读成 id=`--no-project`）
        if (value === undefined || looksLikeFlag(value)) return undefined
        i += 1
        if (arg === '--resume' || arg === '-r') {
          if (value.trim() === '') return undefined
          flags.resume = value
        } else if (arg === '--config-dir') {
          if (value.trim() === '') return undefined
          flags.globalDir = value
        } else {
          if (!LOG_LEVELS.includes(value as NonNullable<Config['logLevel']>)) return undefined
          flags.logLevel = value as NonNullable<Config['logLevel']>
        }
        break
      }
      default:
        // 未知 flag：不静默忽略
        return undefined
    }
  }
  return flags
}
