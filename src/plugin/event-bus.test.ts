import { describe, expect, it, vi } from 'vitest'

import type { Logger, ToolInvocation } from '../contracts.js'
import { EventBusImpl } from './event-bus.js'

/** 测试用 Logger 桩：只关心 error 是否被调用（通知监听器抛错的记录通道）。 */
function stubLogger(): Logger & { errors: unknown[][] } {
  const errors: unknown[][] = []
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (msg: string, ...meta: unknown[]) => errors.push([msg, ...meta]),
    get errors() {
      return errors
    },
  }
}

/** 最小 ToolInvocation 载荷（瀑布测试用）。 */
function invocation(name: string): ToolInvocation {
  return { callId: 'c1', name, args: {}, sessionId: 's1', turnNo: 1, stepNo: 1 }
}

describe('EventBus · 通知域', () => {
  it('通知按注册序派发，退订后不再收到', () => {
    const bus = new EventBusImpl(stubLogger())
    const order: string[] = []
    const offA = bus.on('plugin/mounted', () => order.push('a'))
    bus.on('plugin/mounted', () => order.push('b'))

    bus.emit('plugin/mounted', { name: 'x' })
    expect(order).toEqual(['a', 'b'])

    offA()
    // 退订幂等：重复调用安全
    offA()
    bus.emit('plugin/mounted', { name: 'x' })
    expect(order).toEqual(['a', 'b', 'b'])
  })

  it('单个监听器抛错被吞并记 log.error，后续监听器仍执行，emit 本身不抛', () => {
    const log = stubLogger()
    const bus = new EventBusImpl(log)
    const seen: string[] = []
    bus.on('turn/start', () => {
      throw new Error('listener boom')
    })
    bus.on('turn/start', () => seen.push('second'))

    expect(() => bus.emit('turn/start', { sessionId: 's', turnNo: 1 })).not.toThrow()
    expect(seen).toEqual(['second'])
    expect(log.errors).toHaveLength(1)
    // 记录内容：[消息, 原始错误]，消息含事件名
    expect(log.errors[0]![0]).toContain('turn/start')
    expect(log.errors[0]![1]).toBeInstanceOf(Error)
  })

  it('监听器内退订不影响本次派发（快照遍历）', () => {
    const bus = new EventBusImpl(stubLogger())
    const seen: string[] = []
    let offB: () => void = () => {}
    bus.on('turn/end', () => {
      seen.push('a')
      offB()
    })
    offB = bus.on('turn/end', () => seen.push('b'))

    bus.emit('turn/end', { sessionId: 's', turnNo: 1 })
    expect(seen).toEqual(['a', 'b']) // b 已退订但本次派发仍执行

    bus.emit('turn/end', { sessionId: 's', turnNo: 1 })
    expect(seen).toEqual(['a', 'b', 'a'])
  })
})

describe('EventBus · 瀑布域', () => {
  it('按注册序串行执行（前一个 await 完成后才开始下一个）', async () => {
    const bus = new EventBusImpl(stubLogger())
    const order: string[] = []
    bus.onWaterfall('tools/pre-execute', async (p) => {
      await new Promise((r) => setTimeout(r, 20))
      order.push(`first:${p.name}`)
    })
    bus.onWaterfall('tools/pre-execute', async () => {
      order.push('second')
    })

    const out = await bus.waterfall('tools/pre-execute', invocation('bash'))
    expect(order).toEqual(['first:bash', 'second'])
    expect(out.name).toBe('bash')
  })

  it('监听器返回对象则替换载荷，后续收到替换后的载荷', async () => {
    const bus = new EventBusImpl(stubLogger())
    bus.onWaterfall('tools/pre-execute', (p) => ({ ...p, name: 'replaced' }))
    const seen: string[] = []
    bus.onWaterfall('tools/pre-execute', (p) => {
      seen.push(p.name)
    })

    const out = await bus.waterfall('tools/pre-execute', invocation('bash'))
    expect(seen).toEqual(['replaced'])
    expect(out.name).toBe('replaced')
  })

  it('监听器返回 undefined 保持原载荷', async () => {
    const bus = new EventBusImpl(stubLogger())
    bus.onWaterfall('tools/pre-execute', () => undefined)
    bus.onWaterfall('tools/pre-execute', async () => {
      /* 异步但无返回 */
    })

    const out = await bus.waterfall('tools/pre-execute', invocation('bash'))
    expect(out).toEqual(invocation('bash'))
  })

  it('监听器抛错即否决：错误上抛给 waterfall 调用方', async () => {
    const bus = new EventBusImpl(stubLogger())
    const boom = new Error('vetoed')
    bus.onWaterfall('tools/pre-execute', () => {
      throw boom
    })
    // 否决后不再执行后续监听器
    const seen: string[] = []
    bus.onWaterfall('tools/pre-execute', () => {
      seen.push('should-not-run')
    })

    await expect(bus.waterfall('tools/pre-execute', invocation('bash'))).rejects.toBe(boom)
    expect(seen).toEqual([])
  })

  it('瀑布监听器可退订', async () => {
    const bus = new EventBusImpl(stubLogger())
    const off = bus.onWaterfall('tools/pre-execute', (p) => ({ ...p, name: 'replaced' }))
    off()

    const out = await bus.waterfall('tools/pre-execute', invocation('bash'))
    expect(out.name).toBe('bash')
  })
})
