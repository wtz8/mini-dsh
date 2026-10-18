import type { Unsubscribe } from '../contracts.js'

import { findCommand } from './commands.js'
import { describeError } from './diagnose.js'
import { attachRender, formatBanner, formatTurnSummary } from './render.js'
import type { CliHandle, CliOptions, CommandOutcome, ReplState } from './types.js'
import { DOUBLE_INTERRUPT_MS } from './types.js'

/**
 * REPL 主循环（§4.2）与 Ctrl+C 两段式（§4.5 / O3）。
 *
 * 这一层是"外壳"：它不认识任何具体能力（不 import llm/tools/session 的实现），
 * 一切经 `ctx` 服务面；渲染、命令、错误分类都在各自的模块里，本文件只编排它们
 * （与 03 D3 / 04 D3 / 05 D3 / 06 D3 同式的"核心与外壳分离"）。
 *
 * 会话 id（O7）由**启动序列确定**（`main.ts` 的 `initialSessionId`）：优先取
 * `AgentControl.sessionId`（Y4 新增的契约字段），未挂载时回退到"list 首条"推定；
 * 不来自渲染层监听 `session/append` 的 `session/header`——该事件在 `boot()` 期间就
 * 发完了，07 订阅时收不到（X1）。`/resume` 重启后直接取目标 id（render 的 header
 * 分支只是防御性兜底）。
 */

/**
 * 构造 REPL。
 *
 * @param options.ctx 已 boot 的内核
 * @param options.restart `/resume` 的重启回调（由 `main` 提供，§4.4）
 * @returns REPL 句柄；`start()` 跑完整个生命周期并返回退出码
 */
export function createCli(options: CliOptions): CliHandle {
  const { io, config } = options
  const state: ReplState = {
    ctx: options.ctx,
    sessionId: options.sessionId,
    exiting: false,
    lastInterruptAt: 0,
  }

  /** 当前内核的渲染订阅（`/resume` 重启后会整体换掉）。 */
  let unsubs: Unsubscribe[] = attachRender(state.ctx, io, state)
  /** 退出码：正常 0；`/resume` 重启失败时为 1。 */
  let exitCode = 0

  /** 分派一行 slash 输入（含未知命令提示）。 */
  async function dispatch(text: string): Promise<CommandOutcome> {
    const body = text.slice(1).trim()
    const [name = '', ...rest] = body.split(/\s+/)
    const arg = rest.join(' ').trim()
    const cmd = name === '' ? undefined : findCommand(name)
    if (!cmd) {
      io.err(`未知命令 /${name}（输入 /help 查看命令）\n`)
      return { kind: 'continue' }
    }
    // ctx 现取：命令不得缓存它（重启后会换引用）
    return await cmd.run({ ctx: state.ctx, config, io, state }, arg)
  }

  /**
   * 切换会话（`/resume`）：退订旧内核的渲染 → 换 ctx → 重新订阅。
   * 重启动作本身在 `main`（它持有 config 与 agent-loop 注册句柄）。
   */
  async function restart(id: string): Promise<void> {
    if (!options.restart) {
      io.err('当前宿主不支持切换会话（未提供重启回调）\n')
      return
    }
    for (const off of unsubs) off()
    unsubs = []
    const next = await options.restart(id)
    if (!next) {
      // 会话不存在等在启动期就被拒绝了（06 在 setup 内 open），不重试
      exitCode = 1
      state.exiting = true
      return
    }
    state.ctx = next
    // 重启的目标会话就是刚切换过去的那个（header 事件同样收不到，见 X1）
    state.sessionId = id
    unsubs = attachRender(state.ctx, io, state)
    io.out(`已切换到会话 ${id}\n`)
  }

  return {
    async start(): Promise<number> {
      io.out(formatBanner(config, state.sessionId, options.audit))

      while (!state.exiting) {
        const line = await io.lines.next()
        // null = EOF：与 /exit 同路径，退出码 0
        if (line === null) break
        const text = line.trim()
        if (text === '') continue

        if (text.startsWith('/')) {
          const outcome = await dispatch(text)
          if (outcome.kind === 'exit') break
          if (outcome.kind === 'resume') await restart(outcome.id)
          continue
        }

        try {
          const summary = await state.ctx.agent.resolve().run({ text })
          io.out(formatTurnSummary(summary))
        } catch (err) {
          // D4：回合内错误只打印诊断、不终止 REPL —— 会话还在，用户可重试
          io.err(`${describeError(err).text}\n`)
        }
      }

      for (const off of unsubs) off()
      unsubs = []
      return exitCode
    },

    /**
     * Ctrl+C（SIGINT 处理器与集成测试共用同一入口，D2）。
     *
     * 两段式（架构 §5.2）：窗口内的第二次按下才退出；第一次只取消当前回合。
     * 空闲时同样走两段式（Q8），避免误触丢会话。
     */
    interrupt(): void {
      const now = Date.now()
      const isSecond = state.lastInterruptAt > 0 && now - state.lastInterruptAt <= DOUBLE_INTERRUPT_MS

      if (!isSecond) {
        state.lastInterruptAt = now
        try {
          state.ctx.agent.resolve().cancel('user interrupt')
        } catch (err) {
          // agent-loop 未挂载时 resolve() 抛 'not mounted'：这不构成"取消失败"，
          // 用户依然看到下面的提示，且第二次按下照样能退出
          io.err(`${describeError(err).text}\n`)
        }
        // 唤醒可能挂在审批提问上的那一次 ask（§4.6）：取消后 05 会自己判 cancelled
        io.lines.interrupt()
        io.out('\n（已请求取消，再按一次 Ctrl+C 退出）\n')
        return
      }

      // 第二段：结束 REPL。再 cancel 一次是幂等的（在途回合随即收尾），
      // 进程级 abort 与 shutdown 由 main 的退出流程执行（O5）
      try {
        state.ctx.agent.resolve().cancel('user exit')
      } catch {
        /* 未挂载则跳过 */
      }
      // 用 close 而非 interrupt：此刻 REPL 可能正 `await lines.next()`（空闲等待输入），
      // 只置 `exiting` 的话循环要等下一次 stdin 有动静才会检查它——用户按了 Ctrl+C
      // 却还得敲一下回车才退出，这不可接受。close 会唤醒等待者（EOF），循环随即结束。
      io.lines.close()
      state.exiting = true
      io.out('\n（正在退出…）\n')
    },

    requestExit(): void {
      state.exiting = true
    },
  }
}
