import { describe, expect, it, vi } from 'vitest'

import { createApprovalChannel } from './approval.js'

/**
 * approval.ts 单测（设计 §6.1）：
 * 挂起-响应 / 拒绝 / 重复响应 / 超时失败关闭 / close 放行全部挂起者 /
 * 订阅与退订幂等 / 快照隔离。
 */

/** 构造一个最小调用快照。 */
function invocation(name = 'write', args: Record<string, unknown> = { path: 'a.txt' }) {
  return { callId: 'c1', name, args, sessionId: 's1', turnNo: 1, stepNo: 1 }
}

describe('createApprovalChannel', () => {
  it('挂起直到 respond 放行；列表先增后减', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const pending = channel.ask(invocation())

    expect(channel.pending()).toHaveLength(1)
    expect(channel.pending()[0]).toMatchObject({ id: 'a1', toolName: 'write' })
    expect(channel.pending()[0]?.args).toEqual({ path: 'a.txt' })

    expect(channel.respond('a1', true)).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(channel.pending()).toHaveLength(0)
  })

  it('respond 拒绝时按失败关闭放行 false', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const pending = channel.ask(invocation())
    channel.respond('a1', false)
    await expect(pending).resolves.toBe(false)
  })

  it('重复响应同一 id 返回 false（防双击/双端重复结算）', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const pending = channel.ask(invocation())
    expect(channel.respond('a1', true)).toBe(true)
    expect(channel.respond('a1', true)).toBe(false)
    await expect(pending).resolves.toBe(true)
  })

  it('未知 id 的 respond 返回 false', () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    expect(channel.respond('a404', true)).toBe(false)
  })

  it('超时按拒绝放行（失败关闭，不降级为放行）', async () => {
    vi.useFakeTimers()
    try {
      const channel = createApprovalChannel({ timeoutMs: 1000 })
      const pending = channel.ask(invocation())
      vi.advanceTimersByTime(1001)
      await expect(pending).resolves.toBe(false)
      expect(channel.pending()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() 把全部挂起者按拒绝放行，后续 ask 立即 false', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const p1 = channel.ask(invocation('write'))
    const p2 = channel.ask(invocation('edit'))

    channel.close()
    await expect(p1).resolves.toBe(false)
    await expect(p2).resolves.toBe(false)

    const p3 = channel.ask(invocation())
    await expect(p3).resolves.toBe(false)
    expect(channel.respond('a3', true)).toBe(false)
  })

  it('close() 幂等：重复调用无副作用', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const p1 = channel.ask(invocation())
    channel.close()
    channel.close()
    await expect(p1).resolves.toBe(false)
  })

  it('subscribe 收到带语义的变更（add / resolve），退订后不再收', () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const seen: string[] = []
    const off = channel.subscribe((change) => seen.push(change.kind))

    channel.ask(invocation())
    expect(seen).toEqual(['add'])
    channel.respond('a1', true)
    expect(seen).toEqual(['add', 'resolve'])

    off()
    off() // 幂等
    channel.respond('a404', false) // 不存在的 id：无通知
    channel.ask(invocation())
    expect(seen).toEqual(['add', 'resolve'])
  })

  it('resolve 通知携带 allow 真值（拒绝时为 false，非"一律拒绝"）', () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const seen: Array<{ id: string; allow: boolean }> = []
    channel.subscribe((c) => {
      if (c.kind === 'resolve') seen.push({ id: c.id, allow: c.allow })
    })

    void channel.ask(invocation())
    channel.respond('a1', true)
    expect(seen).toEqual([{ id: 'a1', allow: true }])
  })

  it('订阅者抛错不影响通道与其余订阅者', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const seen: string[] = []
    channel.subscribe(() => {
      throw new Error('listener boom')
    })
    channel.subscribe(() => seen.push(channel.pending()[0]?.id ?? '?'))

    const pending = channel.ask(invocation())
    expect(seen).toEqual(['a1'])
    channel.respond('a1', true)
    await expect(pending).resolves.toBe(true)
  })

  it('pending 是快照：外部改动不影响通道内部（args 深拷贝）', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const args = { path: 'a.txt' }
    const pending = channel.ask(invocation('write', args))

    // 改动原始对象不应影响待审批快照
    args['path'] = 'CHANGED'
    expect(channel.pending()[0]?.args).toEqual({ path: 'a.txt' })

    // 改动快照也不应影响内部
    const snap = channel.pending()[0]
    if (snap) snap.args['path'] = 'HACKED'
    expect(channel.pending()[0]?.args).toEqual({ path: 'a.txt' })

    channel.respond('a1', true)
    await expect(pending).resolves.toBe(true)
  })

  it('args 含不可序列化值时退化浅拷贝，不让展示搞崩回合', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const weird: Record<string, unknown> = {}
    weird['self'] = weird // 循环引用，JSON.stringify 会抛

    const pending = channel.ask(invocation('bash', weird))
    // 退化浅拷贝后，循环引用原样保留（展示端自行处理）
    const snapArgs = channel.pending()[0]?.args as { self?: unknown }
    expect(snapArgs['self']).toBe(weird)

    channel.respond('a1', true)
    await expect(pending).resolves.toBe(true)
  })

  it('close() 广播一次 close 语义（不逐条 resolve）', () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const seen: string[] = []
    channel.subscribe((c) => seen.push(c.kind))
    void channel.ask(invocation())
    void channel.ask(invocation())
    seen.length = 0

    channel.close()
    expect(seen).toEqual(['close'])
  })

  it('id 单调递增，pending 按请求先后排序', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const ps = [channel.ask(invocation()), channel.ask(invocation()), channel.ask(invocation())]
    expect(channel.pending().map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
    channel.respond('a2', true)
    expect(channel.pending().map((a) => a.id)).toEqual(['a1', 'a3'])
    channel.respond('a3', false)
    channel.respond('a1', false)
    await Promise.allSettled(ps)
  })
})
