import type { Config, Ctx, TurnSummary, Unsubscribe } from '../contracts.js'

import { type Theme, createTheme, PLAIN_THEME } from './theme.js'
import type { CliIO, ProjectAudit, ReplState } from './types.js'
import { ONE_LINE_CHARS, VERSION } from './types.js'

/**
 * 流式渲染（§4.3 / Q12）：把总线事件翻译成文本输出。
 *
 * 三条自律：
 * - **富化按输出目标分支**（§4.3.1）：`rich` 主题只在 stdout 是终端时启用，
 *   `plain` 主题是恒等变换——管道/重定向下输出与本模块富化改造前**逐字节一致**；
 * - **结果行由 `session/append(tool/result)` 驱动，不由 `tool/end` 驱动**——
 *   05 的 pipeline 时序是 `tool/start → execute → tool/end → post-execute → append`
 *   （pipeline.ts 步骤 ⑧⑪），`tool/end` 时结果尚未入 log，而 `tool/result`
 *   的载荷正好带 `ok` 与 `error.code`；
 * - **自身不抛**：总线本就会捕获监听器抛错（架构 §5.3），但渲染代码不应依赖这一点。
 */

/**
 * 单行化：换行折叠为空格后按字符数截断。
 *
 * 工具输出常是多行的（bash、read），直接打印会把 REPL 冲垮；这里只留一行预览，
 * 完整内容已入会话日志，模型侧看到的也是完整版。
 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * 耗时文案：毫秒级短，秒级留一位小数。
 *
 * bash 工具最长能跑 120 秒，秒级精度足够区分"慢"与"卡死"；毫秒级则用于
 * 让 `read` 这类快工具的耗时不至于恒显示为 `0.0s`。
 */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * 订阅渲染事件。
 *
 * @param ctx 当前内核（`/resume` 重启后需重新调用本函数订阅新内核）
 * @param io 宿主 IO（仅取 `io.rich` 决定缺省主题；显式传 `theme` 时忽略它）
 * @param state 会话 id 落点（O7：id 由启动序列的 `initialSessionId` 确定——优先取
 *   `AgentControl.sessionId`，见 Y4；**不是**由本订阅取得，见 X1）
 * @param theme 呈现主题；省略时按 `io.rich` 构造（未声明即 `plain`，见 §4.3.1）
 * @returns 退订句柄数组（顺序与订阅顺序一致）
 */
export function attachRender(ctx: Ctx, io: CliIO, state: ReplState, theme?: Theme): Unsubscribe[] {
  const t = theme ?? createTheme(io.rich === true)
  /**
   * 工具起始时刻，用于 `tool/result` 时算耗时（§4.3.1）。
   *
   * **只在富化模式下记录**：plain 模式要保证输出与改造前逐字节一致，不能凭空多出
   * 耗时片段，也就无需记账（Map 恒空）。
   *
   * 条目在 `tool/result` 时取走并删除；工具被取消等"有 start 无 result"的残留
   * 不会累积——`/resume` 重启会重新调用本函数（新闭包、新 Map），退订时亦清空。
   */
  const startedAt = new Map<string, number>()

  const offChunk = ctx.events.on('stream/chunk', ({ delta }) => {
    // 文本增量直接流出；tool-call 增量由工具两行表达，usage/end 无渲染含义
    if (delta.type === 'text') io.out(delta.delta)
  })

  const offToolStart = ctx.events.on('tool/start', ({ callId, name }) => {
    if (t.rich) startedAt.set(callId, Date.now())
    // 长时间运行的工具（bash）若没有这一行，用户会以为卡死
    if (t.rich) {
      io.out(`\n${t.accent('●')} ${t.brand(name)} ${t.dim('…')}`)
      return
    }
    io.out(`\n· ${name} …`)
  })

  const offAppend = ctx.events.on('session/append', ({ event }) => {
    if (event.type === 'session/header') {
      // X1：正常启动序列下**不可达**——header 在 boot 的 setup 内就写完了，本订阅
      // 挂载于 boot 之后。保留是为防御 06 将来改为懒创建会话（那时它会成为唯一
      // 的 id 来源）；不要把它当成主路径，也不要因为"从没跑进过"就删掉它而不留说明。
      state.sessionId = event.id
      return
    }
    if (event.type === 'tool/result') {
      const result = event.result
      const tail = oneLine(result.content, ONE_LINE_CHARS)
      if (!t.rich) {
        if (result.ok) {
          io.out(`  ↳ ✓ ${tail}\n`)
        } else {
          io.out(`  ↳ ✗ ${result.error?.code ?? 'failed'} ${tail}\n`)
        }
        return
      }
      // 富化：结论 + 单行预览 + 耗时（`· 1.2s`）；无起始时刻（start 未收到）时省略耗时
      const from = startedAt.get(event.toolCallId)
      if (from !== undefined) startedAt.delete(event.toolCallId)
      const elapsed = from === undefined ? '' : ` ${t.dim(`· ${formatDuration(Date.now() - from)}`)}`
      if (result.ok) {
        io.out(`  ${t.dim('└')} ${t.ok('✓')} ${t.dim(tail)}${elapsed}\n`)
      } else {
        const code = result.error?.code ?? 'failed'
        io.out(`  ${t.dim('└')} ${t.bad('✗')} ${t.bad(code)} ${t.dim(tail)}${elapsed}\n`)
      }
    }
  })

  /** 退订时一并清空耗时账本（顺序：`offToolStart` 是 start 的订阅，包一层即可）。 */
  const offToolStartAndClear = (): void => {
    startedAt.clear()
    offToolStart()
  }

  return [offChunk, offToolStartAndClear, offAppend]
}

/**
 * 回合摘要行（Q13）：`— turn N · steps S · tokens in/out —`。
 * 取消时前置"（已取消）"，让"落了一半的回复"有明确归因。
 *
 * 富化模式下前置一条分隔线并弱化文案，但**保留全部子串**
 * （`turn N` / `steps S` / `tokens in/out`），使两种模式的断言口径一致。
 *
 * @param summary 回合摘要
 * @param theme 呈现主题（默认 plain）
 */
export function formatTurnSummary(summary: TurnSummary, theme: Theme = PLAIN_THEME): string {
  const t = theme
  const prefix = summary.interrupted ? (t.rich ? `\n${t.warn('（已取消）')}` : '\n（已取消）') : ''
  const tokens = `${summary.totalUsage.inputTokens}/${summary.totalUsage.outputTokens}`
  const body = `turn ${summary.turnNo} · steps ${summary.stepCount} · tokens ${tokens}`
  if (!t.rich) return `${prefix}\n— ${body} —\n`
  return `${prefix}\n${t.rule()}\n${t.dim(` ${body} `)}\n`
}

/**
 * 启动横幅：版本 / 模型 / 会话 id / 接入点提示（F-03）。
 *
 * 接入点提示为什么不阻断：项目层改 `baseUrl` / `apiKeyEnv` 是合法用法
 * （自建网关、换 key 名），07 只保证用户看得见"当前打到哪儿、凭据从哪个变量来"。
 *
 * 富化模式（§4.3.1）：主行加粗强调品牌与模型，其余降级为弱化或警告色，
 * 下接分隔线形成卡片状；**所有关键子串与 plain 一致**，断言口径不变。
 *
 * @param config 冻结的最终配置
 * @param sessionId 当前会话 id（`undefined` 显示为 `unknown`）
 * @param audit 项目层体检结果
 * @param theme 呈现主题（默认 plain）
 */
export function formatBanner(config: Config, sessionId: string | undefined, audit?: ProjectAudit, theme: Theme = PLAIN_THEME): string {
  const t = theme
  if (!t.rich) {
    const lines: string[] = [
      `mdsh ${VERSION} · ${config.model.provider}/${config.model.name} · session ${sessionId ?? 'unknown'}`,
      `接入点 ${config.model.baseUrl} · 凭据来源环境变量 ${config.model.apiKeyEnv}`,
    ]
    if (audit && audit.overridesEndpoint && audit.file) {
      lines.push(`提示：项目配置 ${audit.file} 改写了接入点或凭据来源`)
    }
    if (audit && audit.insecureEndpoint) {
      lines.push('提示：baseUrl 为明文 http 且非本机，API key 将以明文发送')
    }
    lines.push('输入 /help 查看命令，/exit 退出；第一次 Ctrl+C 取消回合，两秒内再按退出。')
    return `${lines.join('\n')}\n`
  }

  const lines: string[] = [
    `  ${t.brand(`mdsh ${VERSION}`)}  ${t.dim('·')}  ${t.accent(`${config.model.provider}/${config.model.name}`)}  ${t.dim('·')}  ${t.dim(`session ${sessionId ?? 'unknown'}`)}`,
    `  ${t.rule()}`,
    `  ${t.dim(`接入点 ${config.model.baseUrl} · 凭据来源环境变量 ${config.model.apiKeyEnv}`)}`,
  ]
  if (audit && audit.overridesEndpoint && audit.file) {
    lines.push(`  ${t.warn(`提示：项目配置 ${audit.file} 改写了接入点或凭据来源`)}`)
  }
  if (audit && audit.insecureEndpoint) {
    lines.push(`  ${t.warn('提示：baseUrl 为明文 http 且非本机，API key 将以明文发送')}`)
  }
  lines.push(`  ${t.dim('输入 /help 查看命令，/exit 退出；第一次 Ctrl+C 取消回合，两秒内再按退出。')}`)
  return `${lines.join('\n')}\n`
}
