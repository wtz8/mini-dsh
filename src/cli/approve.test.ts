import { Readable } from 'node:stream'

import type { ToolInvocation } from '../contracts.js'
import { describe, expect, it } from 'vitest'

import { createLineReader } from './io.js'
import { createApproveHandler } from './approve.js'
import type { CliIO, LineReader } from './types.js'

/**
 * 审批通道单测（设计 §6.1 第 16–20 条 / O2）。
 *
 * 核心守的是**白名单语义**：除了用户明确输入 y/yes，其余一切（n / 空行 / EOF /
 * 被打断 / ask 抛错 / 非交互）都必须落到 `false` —— 绝不能降级为放行（PB-02 ②）。
 */

/** 伪 IO：可脚本化每次 ask 的返回（含抛错）。 */
function fakeIO(options: { answers: Array<string | null>; isTTY?: boolean; throwOnAsk?: boolean }): {
  io: CliIO
  out: string[]
  err: string[]
} {
  const out: string[] = []
  const err: string[] = []
  let index = 0
  const lines: LineReader = {
    next: async () => null,
    ask: async (prompt: string): Promise<string | null> => {
      out.push(prompt)
      if (options.throwOnAsk === true) throw new Error('stdin closed')
      return options.answers[index++] ?? null
    },
    interrupt: () => undefined,
    close: () => undefined,
  }
  const io: CliIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines,
    isTTY: options.isTTY ?? true,
  }
  return { io, out, err }
}

/** 一次待授权的调用（read 工具、turn 2 / step 1）。 */
function invocation(): ToolInvocation {
  return {
    callId: 'call_0',
    name: 'write',
    args: { path: 'a.txt', content: 'hello' },
    sessionId: 's1',
    turnNo: 2,
    stepNo: 1,
  }
}

describe('createApproveHandler', () => {
  it('⑯ y / Y / yes 放行，其余一律拒绝', async () => {
    for (const [answers, expected] of [
      [['y'], true],
      [['Y'], true],
      [['yes'], true],
      [['YES'], true],
      [['n'], false],
      [[''], false],
      [['maybe'], false],
    ] as Array<[Array<string | null>, boolean]>) {
      const { io } = fakeIO({ answers })
      await expect(createApproveHandler(io)(invocation())).resolves.toBe(expected)
    }
  })

  it('⑰ 非交互环境一律拒绝，并给出 stderr 提示', async () => {
    const { io, err } = fakeIO({ answers: ['y'], isTTY: false })
    // 即便"答案"是 y，非 TTY 也不该放行——没有 TTY 就无从取得真实同意
    await expect(createApproveHandler(io)(invocation())).resolves.toBe(false)
    expect(err.join('')).toContain('非交互环境')
  })

  it('⑱ EOF / 被打断（ask 返回 null）视为拒绝', async () => {
    const { io } = fakeIO({ answers: [null] })
    await expect(createApproveHandler(io)(invocation())).resolves.toBe(false)
  })

  it('⑲ ask 抛错不冒泡，按拒绝处理', async () => {
    const { io } = fakeIO({ answers: [], throwOnAsk: true })
    await expect(createApproveHandler(io)(invocation())).resolves.toBe(false)
  })

  it('⑳ 提示含工具名、turn/step 与参数预览', async () => {
    const { io, out } = fakeIO({ answers: ['y'] })
    await createApproveHandler(io)(invocation())
    const text = out.join('')
    expect(text).toContain('write')
    expect(text).toContain('turn 2')
    expect(text).toContain('step 1')
    expect(text).toContain('a.txt')
    expect(text).toContain('允许？')
  })

  it('附带：不缓存决定——同一工具连问两次都会走 ask', async () => {
    const { io, out } = fakeIO({ answers: ['y', 'n'] })
    const approve = createApproveHandler(io)
    await expect(approve(invocation())).resolves.toBe(true)
    await expect(approve(invocation())).resolves.toBe(false)
    // 两次都写了 prompt（未命中任何缓存）
    expect(out.filter((line) => line === '允许？[y/N] ')).toHaveLength(2)
  })

  // review Y7/Y8：默认配置（permissions 空 ⇒ 全工具 ask、maxParallel 4）下一步内
  // 会有多个工具并发走到审批。单槽等待者会丢掉前 N-1 个（60s 假死）；
  // 行泵 FIFO 队列 + 审批闸门共同保证：一次只问一个，答案与工具一一对应。
  it('并发审批接真实行泵：串行提问、FIFO 取行、答案一一对应', async () => {
    const input = new Readable({ read() {} })
    const written: string[] = []
    const io: CliIO = {
      out: (text) => written.push(text),
      err: () => undefined,
      lines: createLineReader(input, (text) => written.push(text)),
      isTTY: true,
    }
    const approve = createApproveHandler(io)
    const first = approve(invocation())
    const second = approve(invocation())
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 闸门：第一个问题已打出，第二个被压住（一次只问一个，避免提示交错）
    expect(written.filter((w) => w.includes('允许？'))).toHaveLength(1)
    // 两行输入到达：第一行归第一问，第二行归第二问（先来后到）
    input.push('y\nn\n')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false)
    expect(written.filter((w) => w.includes('允许？'))).toHaveLength(2)
  })
})
