import { describe, expect, it } from 'vitest'

import type { Ctx } from '../../src/index.js'
import { createWebPlugin, narrowWebConfig } from './plugin.js'
import { WEB_PLUGIN_NAME } from './types.js'

/**
 * plugin.ts 单测（设计 §6.1）：bundle 形状 / 回环闸门 / 生命周期 /
 * 审批通道一致性。事件转发与真实 boot 归集成测试（tests/integration/web.test.ts）。
 */

/** 最小伪 ctx：插件 setup 用到 config/agent/log/events 四个面（wireEvents 要订阅总线）。 */
function fakeCtx(): Ctx {
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
  const noop = () => undefined
  return {
    config: {
      model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: '', apiKeyEnv: 'X' },
      permissions: {},
      tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 1000 } },
      compaction: { thresholdRatio: 0.8, keepTurns: 4 },
      plugins: [],
    },
    log,
    events: {
      on: () => () => undefined,
      onWaterfall: () => () => undefined,
      emit: noop,
      waterfall: (async (_t: unknown, p: unknown) => p) as Ctx['events']['waterfall'],
    },
    agent: {
      resolve: () => ({
        sessionId: 's-plug',
        run: async () => ({ turnNo: 1, stepCount: 1, totalUsage: { inputTokens: 0, outputTokens: 0 }, interrupted: false }),
        cancel: () => undefined,
      }),
    },
    tools: { list: () => [], register: () => undefined, get: () => {
      throw new Error('not mounted')
    } },
    sessions: { read: async () => [] },
  } as unknown as Ctx
}

describe('createWebPlugin · bundle 形状', () => {
  it('返回 factory + approve，且插件有固定名', async () => {
    const bundle = createWebPlugin()
    expect(typeof bundle.factory).toBe('function')
    expect(typeof bundle.approve).toBe('function')

    const plugin = await bundle.factory()
    expect(plugin.name).toBe(WEB_PLUGIN_NAME)
    expect(typeof plugin.setup).toBe('function')
    expect(typeof plugin.dispose).toBe('function')
  })
})

describe('createWebPlugin · 回环闸门（D4）', () => {
  it('非回环 host 拒绝启动', async () => {
    const bundle = createWebPlugin({ host: '0.0.0.0' })
    const plugin = await bundle.factory()
    await expect(plugin.setup(fakeCtx(), undefined)).rejects.toThrow(/non-loopback/)
  })

  it('局域网地址同样拒绝', async () => {
    const bundle = createWebPlugin({ host: '192.168.1.5' })
    const plugin = await bundle.factory()
    await expect(plugin.setup(fakeCtx(), undefined)).rejects.toThrow(/non-loopback/)
  })

  it('实例配置里的非回环 host 同样拒绝（宿主档缺省时配置生效）', async () => {
    const bundle = createWebPlugin()
    const plugin = await bundle.factory()
    await expect(plugin.setup(fakeCtx(), { host: '0.0.0.0' })).rejects.toThrow(/non-loopback/)
  })

  it('非法端口拒绝', async () => {
    const bundle = createWebPlugin()
    const plugin = await bundle.factory()
    await expect(plugin.setup(fakeCtx(), { port: 99999 })).rejects.toThrow('`port`')
  })
})

describe('createWebPlugin · 生命周期', () => {
  it('setup 起服务（onReady 拿到端口），dispose 释放端口', async () => {
    let ready: number | undefined
    const bundle = createWebPlugin({ port: 0, onReady: (info) => { ready = info.port } })
    const plugin = await bundle.factory()
    const ctx = fakeCtx()
    await plugin.setup(ctx, undefined)

    expect(ready).toBeGreaterThan(0)
    const url = `http://127.0.0.1:${String(ready)}/`
    const page = await fetch(url)
    expect(page.status).toBe(200)

    await plugin.dispose?.()
    const after = await fetch(url).catch(() => 'released')
    expect(after).toBe('released')
  })

  it('dispose 未跑 setup 也安全（X5：boot 失败清理半失败插件）', async () => {
    const bundle = createWebPlugin()
    const plugin = await bundle.factory()
    await expect(plugin.dispose?.()).resolves.toBeUndefined()
  })

  it('dispose 关闭审批通道：挂起者按拒绝放行', async () => {
    const bundle = createWebPlugin({ port: 0 })
    const plugin = await bundle.factory()
    await plugin.setup(fakeCtx(), undefined)

    const decision = bundle.approve({ callId: 'c1', name: 'write', args: {}, sessionId: 's', turnNo: 1, stepNo: 1 })
    await plugin.dispose?.()
    await expect(decision).resolves.toBe(false)

    // 通道关闭后新的 ask 立即拒绝
    const again = bundle.approve({ callId: 'c2', name: 'write', args: {}, sessionId: 's', turnNo: 1, stepNo: 1 })
    await expect(again).resolves.toBe(false)
  })

  it('onReady 的 URL 可直接访问', async () => {
    let url = ''
    const bundle = createWebPlugin({ port: 0, onReady: (info) => { url = info.url } })
    const plugin = await bundle.factory()
    await plugin.setup(fakeCtx(), undefined)

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    const res = await fetch(url)
    expect(res.status).toBe(200)
    await plugin.dispose?.()
  })
})

describe('createWebPlugin · 审批一致性', () => {
  it('bundle.approve 挂起后，经 HTTP /api/approve 可结算（UI 路径）', async () => {
    let url = ''
    const bundle = createWebPlugin({ port: 0, onReady: (info) => { url = info.url } })
    const plugin = await bundle.factory()
    await plugin.setup(fakeCtx(), undefined)

    const decision = bundle.approve({
      callId: 'c1',
      name: 'bash',
      args: { command: 'ls' },
      sessionId: 's',
      turnNo: 1,
      stepNo: 1,
    })

    // 待审批出现在状态快照里（刷新页面后 UI 靠它重建卡片）
    const state = (await (await fetch(`${url}api/state`)).json()) as {
      pendingApprovals: Array<{ id: string; toolName: string }>
    }
    expect(state.pendingApprovals).toHaveLength(1)
    expect(state.pendingApprovals[0]?.toolName).toBe('bash')

    const id = state.pendingApprovals[0]?.id ?? ''
    const res = await fetch(`${url}api/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, allow: true }),
    })
    expect(res.status).toBe(200)

    await expect(decision).resolves.toBe(true)
    await plugin.dispose?.()
  })
})

describe('narrowWebConfig（plugin 侧再引用一次导出面）', () => {
  it('配置优先级：宿主档 > 实例档', async () => {
    // host 用宿主档的回环值，实例档的非回环被覆盖 ⇒ 不抛
    const bundle = createWebPlugin({ host: '127.0.0.1', port: 0 })
    const plugin = await bundle.factory()
    await plugin.setup(fakeCtx(), { host: '0.0.0.0', port: 3080 })
    await plugin.dispose?.()
  })
})

void narrowWebConfig
