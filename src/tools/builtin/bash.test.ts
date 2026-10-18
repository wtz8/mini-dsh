import { describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../contracts.js'
import { createBashTool, resolveShell } from './bash.js'

/**
 * `bash` 工具：一次性 spawn、退出码、stderr、取消杀进程。
 *
 * 命令按解析出的 shell 分派（开发机通常是 Git Bash，但 Windows 上也可能回退
 * PowerShell），测试不假定某一种 shell 一定可用。
 */

const shell = resolveShell('auto')
const tool = createBashTool({ shell: 'auto' })

function env(signal?: AbortSignal): ToolEnv {
  return { callId: 'c1', sessionId: 's1', signal: signal ?? new AbortController().signal }
}

/** 按 shell 语法给出"输出到 stderr"的命令。 */
function stderrCommand(): string {
  return shell.label === 'powershell' ? "[Console]::Error.WriteLine('oops')" : 'echo oops 1>&2'
}

/** 按 shell 语法给出"长时间睡眠"的命令（取消测试用）。 */
function sleepCommand(): string {
  // 20 秒：必须**远大于**"杀进程"在满载机器上的耗时。POSIX 路径自带 1.5s 的
  // SIGTERM→SIGKILL 宽限，叠加 spawn/信号投递的排队后，全量并发跑实测可到 6s+；
  // 若睡眠时长只留 1s 余量（原为 5s），"杀得慢"就会被断言误判成"没杀掉"。
  return shell.label === 'powershell' ? 'Start-Sleep -Seconds 20' : 'sleep 20'
}

describe('resolveShell', () => {
  it('auto 在当前环境能解析出可用 shell', () => {
    expect(shell.command.length).toBeGreaterThan(0)
    expect(shell.prefix.length).toBeGreaterThan(0)
    expect(shell.label).toMatch(/bash|powershell|sh/)
  })

  it('显式 bash / powershell 不做探测，原样返回', () => {
    expect(resolveShell('bash').label).toBe('bash')
    expect(resolveShell('powershell').label).toBe('powershell')
  })
})

describe('bash 工具', () => {
  it('执行命令并返回 stdout 与退出码', async () => {
    const out = await tool.execute({ command: 'echo hello' }, env())
    expect(out).toContain('hello')
    expect(out).toContain('[退出码: 0]')
  })

  it('非零退出仍算成功（退出码是结果的一部分）', async () => {
    const out = await tool.execute({ command: 'exit 3' }, env())
    expect(out).toContain('[退出码: 3]')
  })

  it('stderr 单独成段', async () => {
    const out = await tool.execute({ command: stderrCommand() }, env())
    expect(out).toContain('[stderr]')
    expect(out).toContain('oops')
  })

  it('取消信号到达时杀掉子进程并抛错（不挂住回合）', { timeout: 25_000 }, async () => {
    // 只断言"在子进程自然退出前很久就返回"，**不断言"瞬间返回"**：杀进程的耗时取决于
    // 机器负载（taskkill / 信号投递会被排队拖慢），但再慢也远小于 20s 的睡眠时长。
    // 若根本没杀掉，就得等 sleep 自然结束（20s）才返回，断言即失败——这才是本用例
    // 要守的语义（"取消 ⇒ 不挂住回合"），而非某个绝对毫秒数。
    const controller = new AbortController()
    const started = Date.now()
    const pending = tool.execute({ command: sleepCommand() }, env(controller.signal))
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/取消/)
    expect(Date.now() - started).toBeLessThan(12_000)
  })

  it('并发两个调用互不影响（每次都是独立进程）', async () => {
    const [a, b] = await Promise.all([
      tool.execute({ command: 'echo one' }, env()),
      tool.execute({ command: 'echo two' }, env()),
    ])
    expect(a).toContain('one')
    expect(b).toContain('two')
  })
})
