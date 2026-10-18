import type { ApproveHandler } from '../index.js'

import { oneLine } from './render.js'
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
 * @param io 宿主 IO；非交互（`isTTY === false`）时一律拒绝并给出 stderr 提示
 * @returns 可直接交给 `createAgentPlugin({ approve })` 的处理器
 */
export function createApproveHandler(io: CliIO): ApproveHandler {
  return async (invocation): Promise<boolean> => {
    // Q4：无 TTY 就无从取得同意 —— 失败关闭是唯一安全方向（不降级为放行）
    if (!io.isTTY) {
      io.err(`\n[mdsh] 非交互环境：工具 ${invocation.name} 的权限策略为 ask，已按拒绝处理\n`)
      return false
    }

    io.out(`\n⚠ 工具 ${invocation.name} 需要授权（turn ${invocation.turnNo} / step ${invocation.stepNo}）\n`)
    io.out(`  ${oneLine(previewArgs(invocation.args), ARGS_PREVIEW_CHARS)}\n`)

    let answer: string | null
    try {
      answer = await io.lines.ask('允许？[y/N] ')
    } catch {
      // ask 抛错（流已关闭等）同样视为拒绝，绝不把异常漏给 05
      answer = null
    }
    // 打断（Ctrl+C）与 EOF 都表现为 null ⇒ false
    return answer !== null && /^(y|yes)$/i.test(answer.trim())
  }
}
