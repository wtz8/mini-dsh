import { describe, expect, it } from 'vitest'

import type { ToolCall, ToolDefinition } from '../contracts.js'
import { scheduleToolCalls } from './schedule.js'

/**
 * 工具并发调度（设计 §6.1 / §4.4）：
 * 并发峰值 ≤ maxParallel、`exclusive` 独占屏障、取消后停止启动但等在途、错误上抛。
 */

/** 一条记录：工具名 + 进入/退出的相对序号（用于判定重叠）。 */
interface Record_ {
  name: string
  start: number
  end: number
}

/** 伪执行器：记录并发轨迹，可按名设置"挂住直到释放"。 */
function recorder(options: { throwFor?: string; holdFor?: string } = {}) {
  const calls: Record_[] = []
  let seq = 0
  let active = 0
  let peak = 0
  const gates: Array<() => void> = []

  const run = async (call: ToolCall): Promise<string> => {
    const start = seq++
    active += 1
    peak = Math.max(peak, active)
    const entry: Record_ = { name: call.name, start, end: -1 }
    calls.push(entry)
    try {
      if (options.holdFor === call.name) {
        await new Promise<void>((resolve) => {
          gates.push(resolve)
        })
      }
      if (options.throwFor === call.name) throw new Error(`boom:${call.name}`)
      return 'ok'
    } finally {
      active -= 1
      entry.end = seq++
    }
  }

  return {
    calls,
    get peak(): number {
      return peak
    },
    release: (): void => {
      for (const g of gates.splice(0)) g()
    },
    run,
  }
}

function defsOf(...specs: Array<{ name: string; concurrency?: 'parallel' | 'exclusive' }>): Map<string, ToolDefinition> {
  return new Map(
    specs.map((spec) => [
      spec.name,
      {
        name: spec.name,
        description: spec.name,
        schema: { type: 'object', properties: {} },
        ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
        execute: async () => 'ok',
      },
    ]),
  )
}

const defs = defsOf(
  { name: 'read' },
  { name: 'grep' },
  { name: 'write', concurrency: 'exclusive' },
  { name: 'bash', concurrency: 'exclusive' },
)

function call(name: string, id = name): ToolCall {
  return { id, name, arguments: '{}' }
}

const noAbort = new AbortController().signal

describe('scheduleToolCalls', () => {
  it('1 · 空调用列表：立即返回', async () => {
    const rec = recorder()
    await scheduleToolCalls([], defs, rec.run, { maxParallel: 4, signal: noAbort })
    expect(rec.calls).toHaveLength(0)
  })

  it('2 · 并发峰值不超过 maxParallel', async () => {
    const rec = recorder()
    await scheduleToolCalls(
      [call('read', 'a'), call('read', 'b'), call('read', 'c'), call('read', 'd'), call('read', 'e')],
      defs,
      rec.run,
      { maxParallel: 2, signal: noAbort },
    )
    expect(rec.calls).toHaveLength(5)
    expect(rec.peak).toBeLessThanOrEqual(2)
  })

  it('3 · exclusive 执行期间不与任何工具并发', async () => {
    const rec = recorder()
    await scheduleToolCalls([call('read', 'a'), call('bash')], defs, rec.run, {
      maxParallel: 4,
      signal: noAbort,
    })
    const bash = rec.calls.find((c) => c.name === 'bash')
    expect(bash).toBeDefined()
    const overlapping = rec.calls.filter((c) => c !== bash && c.start < (bash as Record_).end && c.end > (bash as Record_).start)
    expect(overlapping).toHaveLength(0)
  })

  it('4 · exclusive 之前排在途调用全部结束（屏障 1）', async () => {
    const rec = recorder({ holdFor: 'read' })
    const task = scheduleToolCalls([call('read', 'a'), call('read', 'b'), call('bash')], defs, rec.run, {
      maxParallel: 4,
      signal: noAbort,
    })
    // 两个 read 挂着，bash 必须等它们结束
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.calls.map((c) => c.name)).toEqual(['read', 'read'])
    rec.release()
    await task
    expect(rec.calls.map((c) => c.name)).toEqual(['read', 'read', 'bash'])
  })

  it('5 · 混合序列：exclusive 前后各自并发', async () => {
    const rec = recorder()
    await scheduleToolCalls(
      [call('read', 'a'), call('grep', 'b'), call('write'), call('read', 'c'), call('grep', 'd')],
      defs,
      rec.run,
      { maxParallel: 2, signal: noAbort },
    )
    const names = rec.calls.map((c) => c.name)
    const wIdx = names.indexOf('write')
    expect(wIdx).toBeGreaterThanOrEqual(2)
    // write 之前的两个先跑完（顺序不定，但都在 write 之前结束）
    expect(rec.calls.slice(0, wIdx).every((c) => c.end < (rec.calls[wIdx] as Record_).start)).toBe(true)
    expect(names.slice(wIdx + 1).sort()).toEqual(['grep', 'read'])
  })

  it('6 · 未注册工具按 parallel 处理', async () => {
    const rec = recorder()
    await scheduleToolCalls([call('mcp__unknown')], defs, rec.run, { maxParallel: 4, signal: noAbort })
    expect(rec.calls).toHaveLength(1)
  })

  it('7 · maxParallel = 1 时严格串行', async () => {
    const rec = recorder()
    await scheduleToolCalls([call('read', 'a'), call('read', 'b'), call('read', 'c')], defs, rec.run, {
      maxParallel: 1,
      signal: noAbort,
    })
    expect(rec.peak).toBe(1)
  })

  it('8 · 取消后不再启动新调用，但已在途的照常结算', async () => {
    const rec = recorder({ holdFor: 'read' })
    const controller = new AbortController()
    const task = scheduleToolCalls(
      [call('read', 'a'), call('read', 'b'), call('read', 'c')],
      defs,
      rec.run,
      { maxParallel: 4, signal: controller.signal },
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.calls).toHaveLength(3)
    controller.abort()
    rec.release()
    await task
    // 三个都已启动（并发上限 4），全部结算完毕
    expect(rec.calls.every((c) => c.end >= 0)).toBe(true)
  })

  it('9 · run 抛错时上抛（不静默吞），且不产生 unhandled rejection', async () => {
    const rec = recorder({ throwFor: 'grep' })
    await expect(
      scheduleToolCalls([call('read', 'a'), call('grep')], defs, rec.run, { maxParallel: 2, signal: noAbort }),
    ).rejects.toThrow('boom:grep')
  })

  it('10 · maxParallel 为 0 或非法时退化为串行', async () => {
    const rec = recorder()
    await scheduleToolCalls([call('read', 'a'), call('read', 'b')], defs, rec.run, {
      maxParallel: 0,
      signal: noAbort,
    })
    expect(rec.peak).toBe(1)
  })
})
