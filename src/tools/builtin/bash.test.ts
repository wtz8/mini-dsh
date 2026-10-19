import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** 本次跑的临时标记文件路径（跑完必清，见用例的 `finally`）。 */
function markerPath(tag: string): string {
  return join(tmpdir(), `minidsh-bash-${tag}-${process.pid}-${Date.now()}.marker`)
}

/**
 * 构造"会挂住很久，且**只在自然跑完时**才落一个标记文件"的命令。
 *
 * 睡眠写在标记之前：进程被中途杀掉 ⇒ 标记不存在；自然跑完 ⇒ 标记存在。于是"取消
 * 是否真的生效"变成**可观察的事实**，而不是靠耗时推断的猜测。详见用例处的说明。
 */
function hangCommand(marker: string, seconds: number): string {
  if (shell.label === 'powershell') {
    return `Start-Sleep -Seconds ${seconds}; Set-Content -LiteralPath '${marker}' -Value x`
  }
  // MSYS/Git Bash 认正斜杠的盘符路径；反斜杠会被当成转义符
  return `sleep ${seconds}; printf x > '${marker.replace(/\\/g, '/')}'`
}

/**
 * 取消用例的睡眠时长。取 **60s** 只为"够长"：命令跑满它要一分钟，足以让"真没杀掉"
 * 与"杀得慢"拉开距离（历史实测过 taskkill 偶发慢到 50s+，见用例注释）。
 * 用例有一条**粗粒度**耗时上界（30s，review Y8）：挂死 = 睡满 60s 会撞线，
 * 正常取消（≈1s）与杀进程慢（个位数秒）都有量级余量。
 */
const CANCEL_SLEEP_SECONDS = 60

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

  // 正向对照：先证明"自然跑完确实会落标记"。没有它，下面那条用例会因为写标记的
  // 命令本身失效（shell 路径语法变了之类）而**永远通过**——空断言比没有断言更危险。
  it('标记命令本身有效（自然跑完会落文件）', { timeout: 30_000 }, async () => {
    const marker = markerPath('control')
    try {
      await tool.execute({ command: hangCommand(marker, 1) }, env())
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(marker, { force: true })
    }
  })

  /**
   * 取消语义：**判别依据是"标记文件是否存在"，辅以一条粗粒度耗时上界**。
   *
   * 历史（同一处翻车三次，教训是这条路上不能再堆数字）：
   * - `sleep 5` / 断言 `<4000ms`（Y4）：偶发越过 4s；
   * - `sleep 20` / 断言 `<12000ms`（Y5）：全量并发下实测 21.3s，又越过；
   * - `sleep 60` / 断言 `<35000ms`（Y6 第一轮）：直接撞 50s 的 harness 超时。
   * 三次加宽三次仍失败 ⇒ 根因不是"某次杀得慢"，耗时判别这条路本身就不可靠。
   *
   * Y6 实证挖出的**真实缺陷**（不是测试问题，是产品 bug）：
   * - 复合命令下 bash 会 fork，于是多出孙进程；Windows 的 `taskkill /T /F` **杀不到
   *   它**（tasklist 前后对比确认：bash 死了，`sleep` 仍活着，尽管 taskkill 报告
   *   "成功终止"）；
   * - 孙进程握着继承去的 stdout 管道句柄 ⇒ Node 的 'close' 要等它自然退出 ⇒
   *   **回合被挂满整个命令时长**。实测取消一次要 60.7s（等于睡满）。
   * - 单条简单命令看不出问题，因为 bash 会 exec 掉自己、没有孙进程——这也是它长期
   *     被当成"偶发抖动"掩盖的原因：真实场景里 `npm ci && npm run build`、`grep | tail`
   *     这类复合命令一按 Ctrl+C 就会挂住。
   *
   * 修法（`bash.ts` 的 `onAbort`）：杀树之外**立刻 destroy stdio**，切断被残留孙进程
   * 握住的管道，回合随即返回（实测 60.7s → 0.97s）。孙进程仍可能残留成孤儿——零运行时
   * 依赖下拿不到原生 Job Object API，做不到更强保证——但"不挂住回合"的承诺成立。
   *
   * 于是判别落到可观察的事实上：命令**跑完才会写标记**，断言标记不存在即"执行被中止"。
   * 该断言确实有效——把 `killTree` 摘掉后本用例如实失败（跑满 60s、标记出现）。
   *
   * 但标记判据只防"没杀进程"，**防不住"挂死"本身**（review Y8 的实证：把 `destroy()`
   * 摘掉，两条断言照样全过，只是跑满 60s）——对 Y6 核心修复的回归防线是空的。补一条
   * **粗粒度**耗时上界：修复生效时取消 ≈ 1s，挂死时 = 睡眠时长 60s，30s 上界把两者
   * 拉开一个数量级的余量（与 Y4/Y5 的教训不冲突：那些上界贴着正常值 2–3 倍设，
   * 而这条贴着"半个故障值"设，误判空间完全不同）。
   */
  it('取消信号到达时杀掉子进程并抛错（不挂住回合）', { timeout: 120_000 }, async () => {
    const marker = markerPath('cancel')
    const controller = new AbortController()
    try {
      const started = Date.now()
      const pending = tool.execute(
        { command: hangCommand(marker, CANCEL_SLEEP_SECONDS) },
        env(controller.signal),
      )
      setTimeout(() => controller.abort(), 100)
      await expect(pending).rejects.toThrow(/取消/)
      const elapsed = Date.now() - started

      // 标记不存在 = 命令没跑完 = 进程真被杀掉了。失败时附上耗时，便于判断当时
      // 是"没杀掉"（≈ 睡眠时长）还是"杀得很慢"（远小于睡眠时长）。
      expect(
        existsSync(marker),
        `标记存在说明进程未被杀死，命令跑完了 ${CANCEL_SLEEP_SECONDS}s（实际耗时 ${elapsed}ms）`,
      ).toBe(false)
      // 粗粒度耗时上界（见用例注释）：修复生效 ≈ 1s、挂死 = 60s，30s 居中取界
      expect(elapsed, `取消耗时 ${elapsed}ms：挂死（≈睡眠时长）或杀进程离群慢`).toBeLessThan(30_000)
    } finally {
      rmSync(marker, { force: true })
    }
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
