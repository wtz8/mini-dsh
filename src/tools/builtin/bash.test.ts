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
  return shell.label === 'powershell' ? 'Start-Sleep -Seconds 5' : 'sleep 5'
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

  it('取消信号到达时杀掉子进程并抛错（不挂住回合）', { timeout: 15_000 }, async () => {
    // 显式拉长 vitest 超时：杀进程依赖真实 taskkill/信号，全量并发跑时机器负载高，
    // 默认 5s 超时会把"杀得慢"误判成"挂死"；<4000ms 断言仍能抓住"根本没杀掉"
    // （杀不掉时进程自然退出需 5s，断言会失败）
    const controller = new AbortController()
    const started = Date.now()
    const pending = tool.execute({ command: sleepCommand() }, env(controller.signal))
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/取消/)
    expect(Date.now() - started).toBeLessThan(4000)
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
