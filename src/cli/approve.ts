import type { ApproveHandler } from '../index.js'

import { oneLine } from './render.js'
import { createTheme } from './theme.js'
import type { CliIO } from './types.js'
import { ARGS_PREVIEW_CHARS } from './types.js'

/**
 * 审批通道（O2 / §4.6）：`ask` 策略的人类接口。
 *
 * 05 的 `ApproveHandler` 语义是**白名单**：只有返回 `true` 才放行，`false` /
 * 抛错 / 超时一律拒绝（PB-02 ② 失败关闭）。07 的实现必须守住同一条线：
 * 除了用户明确输入 y/yes，其余一切（空行、EOF、被 Ctrl+C 打断、ask 抛错、
 * 非交互环境）都落到 `false`。
 *
 * **不缓存决定**：每次调用都问。缓存会把 `tools/pre-execute` 改写后的参数
 * 用"改写前的授权"放行，直接违反 PB-02 ③（授权对象 === 执行对象）。
 */

/** 参数预览：`JSON.stringify` 后单行化；不可序列化时退化为字符串。 */
function previewArgs(args: Record<string, unknown>): string {
  let text: string
  try {
    text = JSON.stringify(args) ?? String(args)
  } catch {
    // 含 BigInt 等不可序列化值时退化为浅描述，绝不让预览本身炸掉审批
    text = Object.keys(args).join(', ')
  }
  return text === '' ? '{}' : text
}

/**
 * 构造审批处理器。
 *
 * 审批**串行化**（review Y8）：`tools.maxParallel > 1` 时同一步会有多个工具同时
 * 走到 `ask`。行泵侧的 FIFO 等待者队列保证每个 `ask` 都能拿到一行答案（不再
 * 互相覆盖），但若不串行，N 个"允许？[y/N]"会同时打出、答案与工具的对应关系
 * 只能靠猜。这里用 promise 链做闸门：一次只问一个，答完再问下一个。等待者
 * 本身不会挂死（EOF / interrupt / 60s 审批超时都会结算），闸门必然放行。
 *
 * @param io 宿主 IO；非交互（`isTTY === false`）时一律拒绝并给出 stderr 提示
 * @returns 可直接交给 `createAgentPlugin({ approve })` 的处理器
 */
export function createApproveHandler(io: CliIO): ApproveHandler {
  /** 呈现主题（§4.3.1）；`plain` 下为恒等变换，故以下文案与改造前逐字节一致。 */
  const t = createTheme(io.rich === true)
  /** 串行闸门：上一次审批结算后才放行下一次提问。 */
  let gate: Promise<unknown> = Promise.resolve()
  return async (invocation): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      // Q4：无 TTY 就无从取得同意 —— 失败关闭是唯一安全方向（不降级为放行）
      if (!io.isTTY) {
        io.err(`\n[mdsh] 非交互环境：工具 ${invocation.name} 的权限策略为 ask，已按拒绝处理\n`)
        return false
      }

      io.out(`\n${t.warn('⚠')} ${t.warn(`工具 ${invocation.name} 需要授权`)}${t.dim(`（turn ${invocation.turnNo} / step ${invocation.stepNo}）`)}\n`)
      io.out(`  ${t.dim(oneLine(previewArgs(invocation.args), ARGS_PREVIEW_CHARS))}\n`)

      let answer: string | null
      try {
        answer = await io.lines.ask(`${t.accent('允许？[y/N]')} `)
      } catch {
        // ask 抛错（流已关闭等）同样视为拒绝，绝不把异常漏给 05
        answer = null
      }
      // 打断（Ctrl+C）与 EOF 都表现为 null ⇒ false
      return answer !== null && /^(y|yes)$/i.test(answer.trim())
    }
    // 排队：无论前一个成败（run 自身不抛，但 io.out 理论上可能），闸门都要放行
    const result = gate.then(run, run)
    gate = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
