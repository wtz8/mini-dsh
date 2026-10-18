import type { Config, Ctx, TurnSummary, Unsubscribe } from '../contracts.js'

import type { CliIO, ProjectAudit, ReplState } from './types.js'
import { ONE_LINE_CHARS, VERSION } from './types.js'

/**
 * 流式渲染（§4.3 / Q12）：把总线事件翻译成纯文本输出。
 *
 * 三条自律：
 * - **无 ANSI、无进度条**：输出要能被管道消费（§1 非目标：不做 rich TUI）；
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
 * 订阅渲染事件。
 *
 * @param ctx 当前内核（`/resume` 重启后需重新调用本函数订阅新内核）
 * @param io 宿主 IO
 * @param state 会话 id 落点（O7：id 由启动序列的 `initialSessionId` 确定——优先取
 *   `AgentControl.sessionId`，见 Y4；**不是**由本订阅取得，见 X1）
 * @returns 退订句柄数组（顺序与订阅顺序一致）
 */
export function attachRender(ctx: Ctx, io: CliIO, state: ReplState): Unsubscribe[] {
  const offChunk = ctx.events.on('stream/chunk', ({ delta }) => {
    // 文本增量直接流出；tool-call 增量由工具两行表达，usage/end 无渲染含义
    if (delta.type === 'text') io.out(delta.delta)
  })

  const offToolStart = ctx.events.on('tool/start', ({ name }) => {
    // 长时间运行的工具（bash）若没有这一行，用户会以为卡死
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
      if (result.ok) {
        io.out(`  ↳ ✓ ${tail}\n`)
      } else {
        io.out(`  ↳ ✗ ${result.error?.code ?? 'failed'} ${tail}\n`)
      }
    }
  })

  return [offChunk, offToolStart, offAppend]
}

/**
 * 回合摘要行（Q13）：`— turn N · steps S · tokens in/out —`。
 * 取消时前置"（已取消）"，让"落了一半的回复"有明确归因。
 */
export function formatTurnSummary(summary: TurnSummary): string {
  const prefix = summary.interrupted ? '\n（已取消）' : ''
  const tokens = `${summary.totalUsage.inputTokens}/${summary.totalUsage.outputTokens}`
  return `${prefix}\n— turn ${summary.turnNo} · steps ${summary.stepCount} · tokens ${tokens} —\n`
}

/**
 * 启动横幅：版本 / 模型 / 会话 id / 接入点提示（F-03）。
 *
 * 接入点提示为什么不阻断：项目层改 `baseUrl` / `apiKeyEnv` 是合法用法
 * （自建网关、换 key 名），07 只保证用户看得见"当前打到哪儿、凭据从哪个变量来"。
 */
export function formatBanner(config: Config, sessionId: string | undefined, audit?: ProjectAudit): string {
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
