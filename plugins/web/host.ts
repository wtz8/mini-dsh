import type { Config, Ctx, Unsubscribe } from '../../src/index.js'
import { boot, registerBuiltin, shutdown } from '../../src/index.js'
import { createAgentPlugin } from '../../src/agent/index.js'
import { loadConfig } from '../../src/config/index.js'
import { withDefaultPlugins } from '../../src/cli/defaults.js'
import { describeError } from '../../src/cli/diagnose.js'
import { registerLlmBuiltin } from '../../src/llm/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { registerSessionBuiltin } from '../../src/session/index.js'
import { registerToolsBuiltin } from '../../src/tools/index.js'

import { createWebPlugin } from './plugin.js'
import { BUILTIN_WEB_SOURCE, WEB_SHUTDOWN_TIMEOUT_MS, WEB_BOOT_TIMEOUT_MS } from './types.js'

/**
 * web 宿主：MiniDSH 的**第二个宿主形态**（与 `src/cli` 并列，但落在本模块内）。
 *
 * 为什么把它放在插件目录：它就是本模块的产物之一，且刻意保持**薄**——只做
 * 「装配 + 起服务 + 等退出」，不含任何 agent 语义（那些全在 `src/`）。
 *
 * 与 CLI 宿主的两处实质差异：
 * 1. **审批通道来自 web 插件**：`createWebPlugin()` 先构造，拿到 `approve` 再注入
 *    agent-loop（顺序不可换，否则 `ask` 全部失败关闭）；
 * 2. **退出靠信号而非 stdin**：没有 REPL，等 `SIGINT` / `SIGTERM`。
 */

/** web 宿主的命令行用法。 */
export const WEB_USAGE = `mdsh-web —— MiniDSH 的本地 Web 界面（蓝色大肥鱼主题）

用法：
  mdsh-web [options]

选项：
  --port <n>        监听端口，默认 3080（0 = 由系统分配）
  --host <addr>     监听地址，默认 127.0.0.1（仅允许回环地址）
  --global-dir <p>  全局配置目录，默认 ~/.minidsh
  --no-project      忽略当前目录的 minidsh.json
  --trust-project   信任项目级插件，跳过确认
  --log-level <lvl> 日志级别：debug | info | warn | error
  --resume <id>     恢复指定会话
  -h, --help        显示本帮助

说明：
  服务只绑定回环地址，外部机器无法访问；页面与接口全部由本进程提供，不访问外网。
`

/** web 宿主的命令行参数。 */
export interface WebHostFlags {
  /** `--port`；省略则用配置/默认值 */
  port?: number
  /** `--host`，默认 `127.0.0.1` */
  host: string
  globalDir?: string
  noProject: boolean
  trustProject: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  resume?: string
  help: boolean
}

/**
 * 解析 web 宿主的命令行参数。
 *
 * 自写极简解析而非复用 07 的 `parseFlags`：两者的开关集合不同，且这里多一个
 * `--port`；宿主各自的 flag 面本来就该各自持有（07 的 flags 服务于 REPL）。
 *
 * @param argv 命令行参数（不含 `node` 与脚本路径）
 * @returns 解析结果；无法解析时返回 `undefined`
 */
export function parseWebFlags(argv: readonly string[]): WebHostFlags | undefined {
  const out: WebHostFlags = {
    host: '127.0.0.1',
    noProject: false,
    trustProject: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '-h' || arg === '--help') {
      out.help = true
      continue
    }
    if (arg === '--no-project') {
      out.noProject = true
      continue
    }
    if (arg === '--trust-project') {
      out.trustProject = true
      continue
    }

    if (arg === '--port' || arg === '--host' || arg === '--global-dir' ||
        arg === '--log-level' || arg === '--resume') {
      const value = argv[i + 1]
      if (value === undefined) return undefined
      i += 1
      if (arg === '--port') {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
        out.port = n
      } else if (arg === '--host') {
        out.host = value
      } else if (arg === '--global-dir') {
        out.globalDir = value
      } else if (arg === '--log-level') {
        if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
          out.logLevel = value
        } else {
          return undefined
        }
      } else {
        out.resume = value
      }
      continue
    }

    return undefined
  }

  return out
}

/**
 * 启动 web 宿主。
 *
 * 流程与 CLI 宿主同构（07 §4.1）：配置 → 默认插件表 → 注册 builtin → boot →
 * 等待信号 → 收尾。差异见文件头的两点说明。
 *
 * @param argv 命令行参数（不含 `node` 与脚本路径）
 * @returns 退出码（0 正常 / 1 启动失败）
 */
export async function startWebHost(argv: readonly string[]): Promise<number> {
  const flags = parseWebFlags(argv)
  if (flags === undefined) {
    process.stderr.write(`无法解析命令行参数。\n${WEB_USAGE}\n`)
    return 1
  }
  if (flags.help) {
    process.stdout.write(WEB_USAGE)
    return 0
  }

  // ① 配置
  let config: Config
  try {
    config = await loadConfig({
      globalDir: flags.globalDir,
      projectDir: flags.noProject ? undefined : process.cwd(),
      flags: flags.logLevel === undefined ? undefined : { logLevel: flags.logLevel },
    })
  } catch (err) {
    process.stderr.write(`${describeError(err).text}\n`)
    return 1
  }
  // ② 默认插件表（用户没配才补）
  config = withDefaultPlugins(config)
  // ③ 确保 web 在表内且排在 agent-loop 之后（setup 时要能取到 agent）
  config = withWebPlugin(config)

  // ④ 审批通道：先于 agent-loop 构造，再注入
  const web = createWebPlugin({
    port: flags.port,
    host: flags.host,
    onReady: (info) => {
      process.stdout.write(
        `\n  蓝色大肥鱼 · MiniDSH\n  界面已就绪：${info.url}\n  按 Ctrl+C 停止服务\n\n`,
      )
    },
  })

  const builtinUnsubs: Unsubscribe[] = []
  let agentUnsub: Unsubscribe = () => undefined
  try {
    builtinUnsubs.push(registerLlmBuiltin())
    builtinUnsubs.push(registerSessionBuiltin())
    builtinUnsubs.push(registerPromptBuiltin())
    builtinUnsubs.push(registerToolsBuiltin())
    agentUnsub = registerBuiltin('agent-loop', createAgentPlugin({ approve: web.approve, sessionId: flags.resume }))
    builtinUnsubs.push(registerBuiltin('web', web.factory))
  } catch (err) {
    for (const off of builtinUnsubs) off()
    agentUnsub()
    process.stderr.write(
      `[mdsh-web] 注册内置插件失败（进程内可能已有未清理的注册）：${errText(err)}\n`,
    )
    return 1
  }

  // ⑤ boot
  let ctx: Ctx
  try {
    ctx = await bootWithTimeout(config)
  } catch (err) {
    process.stderr.write(`${describeError(err).text}\n`)
    for (const off of builtinUnsubs) off()
    agentUnsub()
    return 1
  }

  // ⑥ 跟踪回合状态：Ctrl+C 两段式（第一次取消回合，第二次退出）
  let running = false
  const offStart = ctx.events.on('turn/start', () => { running = true })
  const offEnd = ctx.events.on('turn/end', () => { running = false })

  let stop: () => void = () => undefined
  const exited = new Promise<void>((resolve) => { stop = resolve })

  let interrupts = 0
  const onSignal = (): void => {
    interrupts += 1
    if (interrupts === 1 && running) {
      try {
        ctx.agent.resolve().cancel('web host interrupted')
        process.stdout.write('\n[mdsh-web] 已请求取消当前回合；再按一次 Ctrl+C 退出\n')
      } catch {
        stop()
      }
      return
    }
    stop()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await exited
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    offStart()
    offEnd()
    await shutdownWithTimeout(ctx)
    for (const off of builtinUnsubs) off()
    agentUnsub()
  }

  return 0
}

/**
 * 确保 `config.plugins` 含 web 条目，且**排在 agent-loop 之后**。
 *
 * 顺序即挂载顺序（架构 §5.5）：web 的 setup 需要 `ctx.agent.resolve()` 可用，
 * 而 agent-loop 在**自己的** setup 里注册控制面——因此 web 必须在其后。
 *
 * 已含 web 条目时原样返回（用户自己的排序优先，包括把 web 放到别处的自由）。
 *
 * @param config 配置
 * @returns 调整后的配置
 */
export function withWebPlugin(config: Config): Config {
  const hasWeb = config.plugins.some((entry) => isWebSource(entry.source))
  if (hasWeb) return config

  const plugins = [...config.plugins]
  // 插到 agent-loop 之后；找不到就追加到末尾
  const at = plugins.findIndex((entry) => isAgentSource(entry.source))
  const index = at >= 0 ? at + 1 : plugins.length
  plugins.splice(index, 0, { source: BUILTIN_WEB_SOURCE })
  return { ...config, plugins }
}

/** 该 source 是否指 web 插件（builtin 表项或路径含 `plugins/web`）。 */
function isWebSource(source: string): boolean {
  return source === BUILTIN_WEB_SOURCE || source.replace(/\\/g, '/').includes('plugins/web')
}

/** 该 source 是否指 agent-loop。 */
function isAgentSource(source: string): boolean {
  return source === 'builtin:agent-loop' || source.replace(/\\/g, '/').includes('src/agent')
}

/** 带超时的 boot（与 07 Y9 同式）。 */
async function bootWithTimeout(config: Config): Promise<Ctx> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`插件挂载超过 ${String(WEB_BOOT_TIMEOUT_MS)}ms 未返回，按启动失败处理`))
    }, WEB_BOOT_TIMEOUT_MS)
  })
  try {
    return await Promise.race([boot(config), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 带超时的 shutdown（内核不设超时，宿主兜底，07 O5）。 */
async function shutdownWithTimeout(ctx: Ctx): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), WEB_SHUTDOWN_TIMEOUT_MS)
  })
  const result = await Promise.race([shutdown(ctx).then((): 'done' => 'done'), timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (result === 'timeout') {
    process.stderr.write(`[mdsh-web] 插件卸载超过 ${String(WEB_SHUTDOWN_TIMEOUT_MS)}ms 未返回，强制退出\n`)
  }
}

/** 取错误的可读文本。 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
