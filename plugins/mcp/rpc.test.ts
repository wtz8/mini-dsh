import { describe, expect, it, vi } from 'vitest'

import { createJsonRpcSession } from './rpc.js'

/**
 * rpc.ts 单测（设计 §6.1）：纯内存驱动——伪 send 收集出站行，
 * 用 `receive()` 喂入站行。不拉子进程（子进程边界归 client/集成测试）。
 */

/** 伪出站口：收集写出的每一行（含换行）。 */
function makeFakeSend(): { send(line: string): void; lines: string[] } {
  const lines: string[] = []
  return { send: (line: string) => void lines.push(line), lines }
}

/** 解析出站行为消息对象。 */
function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

/** 用响应行喂会话。 */
function reply(session: ReturnType<typeof createJsonRpcSession>, id: number, result: unknown): void {
  session.receive(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

describe('createJsonRpcSession', () => {
  it('17 · 请求行格式正确且 id 自增', () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    const first = session.request('initialize', { a: 1 })
    const second = session.request('tools/list', {})
    expect(out.lines).toHaveLength(2)
    const m1 = parse(out.lines[0]!)
    const m2 = parse(out.lines[1]!)
    expect(m1).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } })
    expect(m2).toMatchObject({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(out.lines[0]!.endsWith('\n')).toBe(true)
    // params 为 undefined 时不出现在消息里（tools/list 传的是 {}，此处单独验证）
    const third = session.request('ping')
    const m3 = parse(out.lines[2]!)
    expect(m3).toEqual({ jsonrpc: '2.0', id: 3, method: 'ping' })
    void [first, second, third]
  })

  it('18 · 响应按 id 分发：并发请求乱序返回不串线', async () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    const a = session.request('m-a')
    const b = session.request('m-b')
    // 先回 b 再回 a（id 2 先于 id 1）
    reply(session, 2, 'B 的结果')
    reply(session, 1, 'A 的结果')
    await expect(a).resolves.toBe('A 的结果')
    await expect(b).resolves.toBe('B 的结果')
    expect(session.pendingCount).toBe(0)
  })

  it('19 · 入站通知（无 id）不影响等待者', async () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    const p = session.request('tools/call')
    session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
    expect(session.pendingCount).toBe(1)
    reply(session, 1, { ok: true })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('20 · 未知 id 的响应被忽略（迟到/重复响应无害）', async () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    const p = session.request('m')
    session.receive(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '别家的' }))
    expect(session.pendingCount).toBe(1)
    reply(session, 1, '我的')
    await expect(p).resolves.toBe('我的')
  })

  it('21 · 请求超时 ⇒ reject 且消息含方法名与毫秒数', async () => {
    vi.useFakeTimers()
    try {
      const out = makeFakeSend()
      const session = createJsonRpcSession(out)
      const p = session.request('tools/list', {}, { timeoutMs: 1500 })
      const assertion = expect(p).rejects.toThrow('MCP 请求 tools/list 超时（1500ms）')
      await vi.advanceTimersByTimeAsync(1500)
      await assertion
      expect(session.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('22 · JSON-RPC error 响应 ⇒ reject 且消息含错误码；failAll ⇒ 全部在途失败', async () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    const a = session.request('m-a')
    session.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }))
    await expect(a).rejects.toThrow('MCP 错误 -32601: method not found')

    // 子进程崩溃场景：两个在途请求同时失败
    const b = session.request('m-b')
    const c = session.request('m-c')
    session.failAll(new Error('MCP server 连接已关闭'))
    await expect(b).rejects.toThrow('连接已关闭')
    await expect(c).rejects.toThrow('连接已关闭')
    expect(session.pendingCount).toBe(0)
  })

  it('23 · 非法 JSON 行 / 空行 / 非对象行被忽略且不抛', () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    expect(() => session.receive('这不是 JSON')).not.toThrow()
    expect(() => session.receive('   ')).not.toThrow()
    expect(() => session.receive('"裸字符串"')).not.toThrow()
    expect(() => session.receive('[1,2]')).not.toThrow()
  })

  it('24 · 取消 ⇒ 先发 notifications/cancelled（requestId 对应）再 reject', async () => {
    const out = makeFakeSend()
    const session = createJsonRpcSession(out)
    const controller = new AbortController()
    const p = session.request('tools/call', { name: 'x' }, { signal: controller.signal })
    expect(out.lines).toHaveLength(1)
    controller.abort()
    // 取消通知是第二条出站行：方法与 requestId 都要正确
    const notice = parse(out.lines[1]!)
    expect(notice).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
    await expect(p).rejects.toThrow('已取消')
    expect(session.pendingCount).toBe(0)
    // 已取消的信号上再发请求：不产生任何 IO，直接失败
    await expect(session.request('m', undefined, { signal: controller.signal })).rejects.toThrow(
      '已取消',
    )
    expect(out.lines).toHaveLength(2)
  })
})
