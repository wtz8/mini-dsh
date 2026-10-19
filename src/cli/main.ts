import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAgentPlugin } from '../agent/index.js'
import { loadConfig } from '../config/index.js'
import type { Config, Ctx, Unsubscribe } from '../contracts.js'
import { boot, registerBuiltin, shutdown } from '../index.js'
import { registerLlmBuiltin } from '../llm/index.js'
import { registerPromptBuiltin } from '../prompt/index.js'
import { registerSessionBuiltin } from '../session/index.js'
import { registerToolsBuiltin } from '../tools/index.js'

import { createApproveHandler } from './approve.js'
import { withDefaultPlugins } from './defaults.js'
import { describeError } from './diagnose.js'
import { USAGE, parseFlags } from './flags.js'
import { createProcessIO } from './io.js'
import { createCli } from './repl.js'
import type { CliIO, ProjectAudit } from './types.js'
import { BOOT_TIMEOUT_MS, BUILTIN_PREFIX, SHUTDOWN_TIMEOUT_MS, VERSION } from './types.js'

/**
 * 启动序列与退出流程（架构 §5.5 / §4.1）。
 *
 * 07 是宿主，本文件是它唯一"认识全部模块"的地方：注册 builtin、boot、起 REPL、
 * 最后收尾。`repl.ts` 及以下的各层都不 import 具体模块实现，只经 `ctx` 服务面
 * （架构 §3 的组合根不变量）。
 *
 * 两条硬义务落在这里：
 * - **O1 默认 plugins 非空**（`withDefaultPlugins`）、**O2 审批实现注入**；
 * - **O5 dispose 超时兜底**：内核 `shutdown` 不设超时（M0 设计 §4.2），
 *   单个挂起的 dispose 会让它永不返回，这里用 `Promise.race` 兜住。
 */

/** 项目层配置文件名（01 约定，架构 §7）。 */
const PROJECT_CONFIG_FILE = 'minidsh.json'

/**
 * `--no-project` 的实现手法（D1）：把 `loadConfig` 的 `projectDir` 指向一个
 * 确定不存在的目录，命中 `readJsonFile` 的 `ENOENT` 分支（返回 `undefined`），
 * 效果等价于"不读项目层"。
 *
 * 为什么不用一个"忽略项目层"的开关：`LoadConfigOptions.projectDir` 只接受目录
 * 字符串，加开关要改 01（已 Baseline）。
 */
function noProjectDir(): string {
  return path.join(os.tmpdir(), 'mdsh-no-project')
}

/** 生效的接入点是否"明文 http 且非本机"（02 记录的已知风险，07 只提示不阻断）。 */
function isInsecureEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:') return false
    return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    // 非法 URL 由 02 在使用点报错，这里不抢着诊断
    return false
  }
}

/**
 * 项目层配置体检（O6 / §4.8）。
 *
 * 读的是**文件里的字段存在性**，不做合并语义判断——最终生效值以 `config` 为准。
 *
 * @param projectDir 项目目录；`undefined`（`--no-project`）时跳过体检
 * @param config 已加载合并的最终配置
 */
export async function inspectProject(projectDir: string | undefined, config: Config): Promise<ProjectAudit> {
  const empty: ProjectAudit = { localPlugins: [], overridesEndpoint: false, insecureEndpoint: false }
  if (projectDir === undefined) return empty

  const file = path.join(projectDir, PROJECT_CONFIG_FILE)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    // 没有项目配置是常态（首次启动），不是问题
    return empty
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非法 JSON 已在 loadConfig 报过 ConfigError，这里只做体检，不重复报错
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
  const record = parsed as Record<string, unknown>

  // F-02：非 builtin 的 source 是"本地代码"，将以用户权限执行
  const localPlugins: string[] = []
  const plugins = record['plugins']
  if (Array.isArray(plugins)) {
    for (const entry of plugins) {
      if (typeof entry === 'object' && entry !== null) {
        const source = (entry as { source?: unknown }).source
        if (typeof source === 'string' && !source.startsWith(BUILTIN_PREFIX)) localPlugins.push(source)
      }
    }
  }

  // F-03：项目层可改接入点与凭据来源
  const model = record['model']
  let overridesEndpoint = false
  if (typeof model === 'object' && model !== null && !Array.isArray(model)) {
    const fields = model as Record<string, unknown>
    overridesEndpoint = fields['baseUrl'] !== undefined || fields['apiKeyEnv'] !== undefined
  }

  return {
    file,
    localPlugins,
    overridesEndpoint,
    insecureEndpoint: isInsecureEndpoint(config.model.baseUrl),
  }
}

/**
 * 项目级插件的信任确认（F-02 / Q3）。
 *
 * 拒绝即**退出码 1**，不降级为"剔除插件继续启动"——少挂了插件却照常启动会让
 * 用户以为功能齐全（与 01"死配置早暴露"、04"禁用段显式抛错"同一立场）。
 *
 * @returns `true` 放行；`false` 表示宿主应当以退出码 1 结束
 */
async function confirmLocalPlugins(io: CliIO, audit: ProjectAudit, trustProject: boolean): Promise<boolean> {
  if (audit.localPlugins.length === 0) return true

  if (trustProject) {
    io.err(`[mdsh] 已按 --trust-project 加载项目级插件：${audit.localPlugins.join(', ')}\n`)
    return true
  }
  if (!io.isTTY) {
    io.err(
      `[mdsh] 项目配置声明了本地插件（${audit.localPlugins.join(', ')}），非交互环境下默认拒绝；\n` +
        '      确认可信请加 --trust-project，或加 --no-project 忽略项目层\n',
    )
    return false
  }

  io.out(`\n项目配置 ${audit.file ?? PROJECT_CONFIG_FILE} 声明了本地插件，它们将以你的权限执行任意代码：\n`)
  for (const source of audit.localPlugins) io.out(`  · ${source}\n`)
  const answer = await io.lines.ask('继续？[y/N] ')
  // 空行 / EOF / 打断 / 其它输入一律视为拒绝
  return answer !== null && /^(y|yes)$/i.test(answer.trim())
}

/**
 * 确定启动时的会话 id（O7 / X1 / Y4）。
 *
 * 首选**控制面自带的 id**（`AgentControl.sessionId`，06 在 setup 内 create/open 会话
 * 时持有）——这是确定取值。之所以不能靠订阅：06 在 `setup()` 内就把 `session/header`
 * 写完了（06 §8-Q1），07 的订阅挂载于 boot 之后，永远收不到该事件。
 *
 * 控制面未挂载时（默认 builtin 表里没有 agent-loop、或 boot 没跑到它的 setup）才回退：
 * - `--resume`：启动参数里的 id 就是当前会话；
 * - 否则：`list()` 的首条——`SessionStore.list()` 已保证按 `createdAt` 降序
 *   （03 store，同值按 id 降序稳定）。**不再自行排序**：早期版本用 `localeCompare`
 *   重排，既重复了 store 的契约，同值时又丢了 id 兜底（Y1）。
 *
 * 导出是为了让集成测试复用**真实**的取值逻辑——夹具若自己抄一份，链路就成了
 * "测试自己跟自己对答案"，07 改坏了也不会红。
 *
 * @returns 会话 id；无法确定时返回 `undefined`（UI 显示 `unknown`，不影响跑回合）
 */
export async function initialSessionId(ctx: Ctx, resume: string | undefined): Promise<string | undefined> {
  try {
    return ctx.agent.resolve().sessionId
  } catch {
    // agent-loop 未挂载：走推定路径
  }
  if (resume !== undefined) return resume
  try {
    const metas = await ctx.sessions.list()
    return metas[0]?.id
  } catch {
    // 会话存储不可读时不影响 REPL 本身：只是横幅与 /session 显示 unknown
    return undefined
  }
}

/**
 * 带超时的 `shutdown`（O5）：内核不中断挂起的 dispose，宿主编一个兜底。
 *
 * @param ctx 要收尾的内核
 * @param io 超时提示的落点
 */
async function shutdownWithTimeout(ctx: Ctx, io: CliIO): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS)
  })
  const done = shutdown(ctx).then((): 'done' => 'done')
  const result = await Promise.race([done, timeout])
  if (timer) clearTimeout(timer)
  if (result === 'timeout') {
    io.err(`[mdsh] 插件卸载超过 ${SHUTDOWN_TIMEOUT_MS}ms 未返回，强制退出\n`)
  }
}

/**
 * 带超时的 `boot`（review Y9）：boot 失败时内核会逆序 dispose 已挂载插件（R3），
 * 该清理与 `shutdown` 一样不设超时——单个挂起的 dispose 会让 `boot()` 永不返回，
 * 启动期挂死（连 REPL 都进不去、无任何输出）。超时按启动失败处理；此时后台
 * 的 boot 仍在挂着，靠 bin 的 `process.exit` 收尸。
 *
 * @throws 超时抛 Error（会被 main 的启动失败分支接住）；boot 自身的 BootError 原样上抛
 */
async function bootWithTimeout(config: Config): Promise<Ctx> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`插件挂载超过 ${BOOT_TIMEOUT_MS}ms 未返回（某个 setup/dispose 挂起？），按启动失败处理`))
    }, BOOT_TIMEOUT_MS)
  })
  try {
    return await Promise.race([boot(config), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 进程入口。
 *
 * @param argv 命令行参数（不含 `node` 与脚本路径）
 * @param io IO 面；**省略则用 `process.*`**（注入伪 IO 是集成测试的唯一入口，D2）
 * @returns 退出码（0 正常 / 1 启动失败）；**不调用 `process.exit`**——
 *          退出是 bin 的权利，返回码也让测试的断言更简单（D5）
 */
export async function main(argv: readonly string[], io?: CliIO): Promise<number> {
  const injected = io !== undefined
  const activeIO: CliIO = io ?? createProcessIO()

  // ① flags
  const flags = parseFlags(argv)
  if (flags === undefined) {
    activeIO.err(`无法解析命令行参数。\n${USAGE}\n`)
    if (!injected) activeIO.lines.close()
    return 1
  }
  if (flags.help) {
    activeIO.out(`${USAGE}\n`)
    if (!injected) activeIO.lines.close()
    return 0
  }
  if (flags.version) {
    activeIO.out(`mdsh ${VERSION}\n`)
    if (!injected) activeIO.lines.close()
    return 0
  }

  // ② 配置（ConfigError 发生在 boot 之前，无需清理）
  let config: Config
  try {
    config = await loadConfig({
      globalDir: flags.globalDir,
      projectDir: flags.noProject ? noProjectDir() : undefined,
      flags: flags.logLevel === undefined ? undefined : { logLevel: flags.logLevel },
    })
  } catch (err) {
    activeIO.err(`${describeError(err).text}\n`)
    if (!injected) activeIO.lines.close()
    return 1
  }
  // ③ O1：用户没配 plugins 才补默认表
  config = withDefaultPlugins(config)

  // ④ O6：项目层体检与信任确认
  const audit = await inspectProject(flags.noProject ? undefined : process.cwd(), config)
  if (!(await confirmLocalPlugins(activeIO, audit, flags.trustProject))) {
    // 拒绝也要给诊断：否则用户只看到退出码 1，不知道该加 --trust-project 还是 --no-project
    activeIO.err('[mdsh] 已拒绝加载项目级插件。确认可信请加 --trust-project，或加 --no-project 忽略项目层\n')
    if (!injected) activeIO.lines.close()
    return 1
  }

  // ⑤ 注册 builtin：四个模块自带的注册器 + 一个带 approve 的 agent-loop（O2）
  //
  // builtin 表是**进程级全局**的，同名重复注册一律抛错。因此注册整段包在 try 里：
  // 半途失败（例如上一次启动没退干净）必须把自己已注册的那几个退订掉，
  // 否则下一次启动会撞"同名重复注册"，故障转移到用户头上。
  const approve = createApproveHandler(activeIO)
  const builtinUnsubs: Unsubscribe[] = []
  // 初值是空操作：注册半途失败时也能安全调用（agentUnsub 可能尚未赋值）
  let agentUnsub: Unsubscribe = () => undefined
  try {
    builtinUnsubs.push(registerLlmBuiltin(), registerSessionBuiltin(), registerPromptBuiltin(), registerToolsBuiltin())
    agentUnsub = registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId: flags.resume }))
  } catch (err) {
    for (const off of builtinUnsubs) off()
    agentUnsub()
    activeIO.err(`[mdsh] 注册内置插件失败（进程内可能已有未清理的注册）：${err instanceof Error ? err.message : String(err)}\n`)
    if (!injected) activeIO.lines.close()
    return 1
  }

  // ⑥ boot（失败时 boot 内部已逆序 dispose，R3；超时兜底见 bootWithTimeout）
  let ctx: Ctx
  try {
    ctx = await bootWithTimeout(config)
  } catch (err) {
    activeIO.err(`${describeError(err).text}\n`)
    for (const off of builtinUnsubs) off()
    agentUnsub()
    if (!injected) activeIO.lines.close()
    return 1
  }

  /**
   * `/resume` 的重启（§4.4）：旧内核收尾 → 换掉 agent-loop 实例 → 新 boot。
   * 放在这里是因为注册/退订 builtin 与 boot 都是启动序列的权属（REPL 不该认识它们）。
   */
  async function restart(id: string): Promise<Ctx | undefined> {
    await shutdownWithTimeout(ctx, activeIO)
    agentUnsub()
    try {
      // 与 ⑤ 同式：注册也包进来。抛错时若任其逃出 `start()`，bin 层会把它印成
      // "未捕获的启动错误"，可它发生在会话中途；统一转成"返回 undefined"，
      // 由 REPL 置退出码 1 收尾。此时 `agentUnsub` 仍是旧句柄（已调用过），
      // main 的 finally 再调一次是幂等的（boot 的退订按注册身份比对）
      agentUnsub = registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId: id }))
      ctx = await bootWithTimeout(config)
      return ctx
    } catch (err) {
      activeIO.err(`${describeError(err).text}\n`)
      return undefined
    }
  }

  const handle = createCli({
    ctx,
    config,
    io: activeIO,
    audit,
    restart,
    sessionId: await initialSessionId(ctx, flags.resume),
  })

  // ⑦ SIGINT：只有真实进程入口才接管（注入 IO 的调用方自己调 handle.interrupt）
  const onSigint = (): void => {
    handle.interrupt()
  }
  if (!injected) process.on('SIGINT', onSigint)

  try {
    return await handle.start()
  } finally {
    if (!injected) process.off('SIGINT', onSigint)
    // 先摘 stdin 监听：否则它的引用会拖住事件循环，进程退不干净
    if (!injected) activeIO.lines.close()
    await shutdownWithTimeout(ctx, activeIO)
    for (const off of builtinUnsubs) off()
    agentUnsub()
  }
}
