import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Ctx, SessionEvent, TurnSummary } from '../../src/index.js'
import { createApprovalChannel } from './approval.js'
import { createWebServer } from './server.js'
import type { WebServer } from './server.js'
import { truncateForUi } from './server.js'

/**
 * server.ts 单测（设计 §6.1）：真实 `node:http` 监听（端口 0 由系统分配）+
 * 真实 fetch 客户端，伪 ctx / 伪 runTurn。SSE 只验首帧与广播通路。
 */

/** 最小伪 ctx（只实现 server.ts 用到的面）。 */
function fakeCtx(events: SessionEvent[] = []): Ctx {
  return {
    config: {
      model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: '', apiKeyEnv: 'X' },
      permissions: {},
      tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 1000 } },
      compaction: { thresholdRatio: 0.8, keepTurns: 4 },
      plugins: [],
    },
    tools: { list: () => [], register: () => undefined, get: () => {
      throw new Error('not mounted')
    } },
    sessions: { read: async () => events },
    agent: {
      resolve: () => ({
        sessionId: 's-test',
        run: async (): Promise<TurnSummary> => ({ turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 1, outputTokens: 1 }, interrupted: false }),
        cancel: () => undefined,
      }),
    },
  } as unknown as Ctx
}

let server: WebServer | undefined
let base: string

beforeEach(async () => {
  const channel = createApprovalChannel({ timeoutMs: 0 })
  server = createWebServer(
    { port: 0, host: '127.0.0.1', basePath: '', heartbeatMs: 60_000 },
    {
      ctx: fakeCtx(),
      approvals: channel,
      sessionId: () => 's-test',
      async runTurn(): Promise<TurnSummary> {
        return { turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 1, outputTokens: 1 }, interrupted: false }
      },
    },
  )
  const port = await server.ready()
  base = `http://127.0.0.1:${String(port)}`
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function post(path: string, body: string): Promise<Response> {
  return await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('createWebServer · 静态资源', () => {
  it('GET / 返回大肥鱼页面（吉祥物头像就位、无字标、占位已替换）', async () => {
    const res = await fetch(base + '/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('/assets/mascot.webp')
    expect(html).not.toContain('蓝色大肥鱼')
    expect(html).not.toContain('__BASE__')
    expect(html).not.toContain('__THEME__')
  })

  it('GET /assets/mascot.webp 返回图片且可缓存', async () => {
    const res = await fetch(base + '/assets/mascot.webp')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toContain('immutable')
    const body = await res.arrayBuffer()
    // RIFF 容器头 + WEBP 四字节标记
    expect(body.byteLength).toBeGreaterThan(1000)
    expect(Buffer.from(body, 0, 4).toString('ascii')).toBe('RIFF')
    expect(Buffer.from(body, 8, 4).toString('ascii')).toBe('WEBP')
  })

  it('GET /assets/app.css 与 /assets/app.js 可用', async () => {
    const css = await fetch(base + '/assets/app.css')
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('--bff-accent')

    const js = await fetch(base + '/assets/app.js')
    expect(js.status).toBe(200)
    expect(await js.text()).toContain('EventSource')
  })

  it('basePath 前缀：资源与 API 都挂在前缀下', async () => {
    const s2 = createWebServer(
      { port: 0, host: '127.0.0.1', basePath: '/mdsh', heartbeatMs: 60_000 },
      {
        ctx: fakeCtx(),
        approvals: createApprovalChannel({ timeoutMs: 0 }),
        sessionId: () => 's',
        async runTurn(): Promise<TurnSummary> {
          return { turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 0, outputTokens: 0 }, interrupted: false }
        },
      },
    )
    const port = await s2.ready()
    const root = `http://127.0.0.1:${String(port)}`

    const inScope = await fetch(root + '/mdsh/')
    expect(inScope.status).toBe(200)
    expect(await inScope.text()).toContain('href="/mdsh/assets/app.css"')

    const state = await fetch(root + '/mdsh/api/state')
    expect(state.status).toBe(200)

    const outScope = await fetch(root + '/api/state')
    expect(outScope.status).toBe(404)

    await s2.close()
  })
})

describe('createWebServer · API', () => {
  it('GET /api/state 返回投影快照', async () => {
    const res = await fetch(base + '/api/state')
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data['sessionId']).toBe('s-test')
    expect(data['provider']).toBe('deepseek')
    expect(data['model']).toBe('deepseek-chat')
    expect(Array.isArray(data['messages'])).toBe(true)
    expect(data['running']).toBe(false)
  })

  it('POST /api/turn 空文本返回 400', async () => {
    const res = await post('/api/turn', JSON.stringify({ text: '   ' }))
    expect(res.status).toBe(400)
  })

  it('POST /api/turn 非法 JSON 返回 400', async () => {
    const res = await post('/api/turn', '{oops')
    expect(res.status).toBe(400)
  })

  it('POST /api/turn 正常启动返回 202；期间并发请求 409；结束后恢复', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => { release = r })
    const calls: string[] = []

    const slow = createWebServer(
      { port: 0, host: '127.0.0.1', basePath: '', heartbeatMs: 60_000 },
      {
        ctx: fakeCtx(),
        approvals: createApprovalChannel({ timeoutMs: 0 }),
        sessionId: () => 's',
        async runTurn(text: string): Promise<TurnSummary> {
          calls.push(text)
          await gate
          return { turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 0, outputTokens: 0 }, interrupted: false }
        },
      },
    )
    const port = await slow.ready()
    const root = `http://127.0.0.1:${String(port)}`

    const first = await fetch(root + '/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '第一问' }),
    })
    expect(first.status).toBe(202)

    const second = await fetch(root + '/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '第二问' }),
    })
    expect(second.status).toBe(409)

    release?.()
    await new Promise((r) => setTimeout(r, 30))

    const third = await fetch(root + '/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '第三问' }),
    })
    expect(third.status).toBe(202)
    expect(calls).toEqual(['第一问', '第三问'])

    await slow.close()
  })

  it('runTurn 抛错时错误帧被广播且服务不挂', async () => {
    // holder 模式：runTurn 闭包需要引用尚未创建的服务（模拟插件包装器的广播）
    const holder: { srv?: WebServer } = {}
    holder.srv = createWebServer(
      { port: 0, host: '127.0.0.1', basePath: '', heartbeatMs: 60_000 },
      {
        ctx: fakeCtx(),
        approvals: createApprovalChannel({ timeoutMs: 0 }),
        sessionId: () => 's',
        async runTurn(): Promise<TurnSummary> {
          holder.srv?.broadcast({ type: 'error', text: 'LLM 网络故障' })
          throw new Error('LLM 网络故障')
        },
      },
    )
    const failer = holder.srv
    const port = await failer.ready()
    const root = `http://127.0.0.1:${String(port)}`

    // 先订 SSE 再触发错误；帧何时到达不定，循环读到含 error 为止（带兜底超时）
    const events = await fetch(root + '/api/events')
    const reader = events.body!.getReader()
    const decoder = new TextDecoder()

    const start = await fetch(root + '/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(start.status).toBe(202)

    let joined = ''
    const deadline = Date.now() + 3000
    while (!joined.includes('"error"') && Date.now() < deadline) {
      const step = await Promise.race([
        reader.read(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 200)),
      ])
      if (step === undefined || step.done) break
      joined += decoder.decode(step.value, { stream: true })
    }
    await reader.cancel()

    expect(joined).toContain('"type":"hello"')
    expect(joined).toContain('"type":"error"')
    expect(joined).toContain('LLM 网络故障')

    // 服务仍活着
    const state = await fetch(root + '/api/state')
    expect(state.status).toBe(200)
    await failer.close()
  })

  it('GET /api/events 推送 hello 首帧', async () => {
    const res = await fetch(base + '/api/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('"type":"hello"')
    expect(text).toContain('"sessionId":"s-test"')
    await reader.cancel()
  })

  it('broadcast 的帧到达已连接客户端', async () => {
    const res = await fetch(base + '/api/events')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // 消掉 hello
    await reader.read()

    server?.broadcast({ type: 'text', delta: '你好，大肥鱼' })
    const { value } = await reader.read()
    const text = decoder.decode(value)
    expect(text).toContain('"type":"text"')
    expect(text).toContain('你好，大肥鱼')

    await reader.cancel()
  })

  it('POST /api/approve 结算审批并广播 resolved', async () => {
    const channel = createApprovalChannel({ timeoutMs: 0 })
    const s2 = createWebServer(
      { port: 0, host: '127.0.0.1', basePath: '', heartbeatMs: 60_000 },
      {
        ctx: fakeCtx(),
        approvals: channel,
        sessionId: () => 's',
        async runTurn(): Promise<TurnSummary> {
          return { turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 0, outputTokens: 0 }, interrupted: false }
        },
      },
    )
    const port = await s2.ready()
    const root = `http://127.0.0.1:${String(port)}`

    // 挂一条真实审批
    void channel.ask({ callId: 'c1', name: 'write', args: { a: 1 }, sessionId: 's', turnNo: 1, stepNo: 1 })

    const res = await fetch(root + '/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a1', allow: true }),
    })
    const data = (await res.json()) as { matched: boolean }
    expect(data.matched).toBe(true)

    const again = await fetch(root + '/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a1', allow: true }),
    })
    expect(((await again.json()) as { matched: boolean }).matched).toBe(false)

    await s2.close()
  })

  it('405：对只读接口 POST / 对写接口 GET', async () => {
    const wrongRead = await fetch(base + '/api/state', { method: 'POST', body: '{}' })
    expect(wrongRead.status).toBe(405)
    const wrongWrite = await fetch(base + '/api/turn')
    expect(wrongWrite.status).toBe(405)
  })

  it('未知路径 404，未知 API 子路径返回 JSON 404', async () => {
    const page = await fetch(base + '/nope')
    expect(page.status).toBe(404)
    const api = await fetch(base + '/api/nope')
    expect(api.status).toBe(404)
    expect(await api.text()).toContain('unknown api route')
  })

  it('超限请求体被拒绝（413）', async () => {
    const big = 'x'.repeat(1_100_000)
    const res = await fetch(base + '/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: big }),
    })
    expect(res.status).toBe(413)
  })

  it('close() 后端口释放（再请求失败）', async () => {
    const port = await server!.ready()
    await server!.close()
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/state`).catch(() => 'unreachable')
    expect(res).toBe('unreachable')
  })

  it('close() 幂等', async () => {
    await server!.close()
    await server!.close()
  })
})

describe('createWebServer · 快照', () => {
  it('会话读不到时退化为空快照，服务照常', async () => {
    const broken = {
      ...fakeCtx(),
      sessions: { read: async () => {
        throw new Error('not mounted')
      } },
    } as unknown as Ctx

    const s2 = createWebServer(
      { port: 0, host: '127.0.0.1', basePath: '', heartbeatMs: 60_000 },
      {
        ctx: broken,
        approvals: createApprovalChannel({ timeoutMs: 0 }),
        sessionId: () => 's',
        async runTurn(): Promise<TurnSummary> {
          return { turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 0, outputTokens: 0 }, interrupted: false }
        },
      },
    )
    const port = await s2.ready()
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/state`)
    const data = (await res.json()) as { messages: unknown[]; turnCount: number }
    expect(data.messages).toEqual([])
    expect(data.turnCount).toBe(0)
    await s2.close()
  })
})

describe('SSE 帧格式', () => {
  it('帧以 data: 开头、双换行结尾（浏览器 EventSource 可直接解析）', async () => {
    const res = await fetch(base + '/api/events')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text.startsWith('data:')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(true)
    const payload = JSON.parse(text.slice(5).trim() ?? '{}')
    expect(payload['type']).toBe('hello')
    await reader.cancel()
  })
})

// 引用 vi 防止未使用告警（超时类断言在 approval.test.ts 中使用假定时器）
void vi
// 引用 truncateForUi 以覆盖 server 导出面（行为断言见 config.test.ts）
void truncateForUi
