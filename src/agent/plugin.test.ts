import { describe, expect, it } from 'vitest'

import type { Config, LlmAdapter, SessionEvent, StreamEvent } from '../contracts.js'
import { SessionError } from '../errors.js'
import { createDefaultConfig } from '../config/index.js'
import { createKernel } from '../plugin/ctx.js'
import { createAgentPlugin, registerAgentBuiltin } from './plugin.js'
import { BUILTIN_AGENT } from './types.js'
import type { AgentControlHandle } from './types.js'

/**
 * `builtin:agent-loop` 插件（设计 §6.1 / §4.1 / §4.8）：真实内核 + 伪 session store +
 * 伪 adapter + 真 runner（05）。验证装配、实例配置 narrow、生命周期。
 */

const SESSION_ID = 's1'

function header(): SessionEvent {
  return {
    type: 'session/header',
    id: SESSION_ID,
    createdAt: '2026-10-18T00:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-chat',
    cwd: '/tmp',
  }
}

interface Kit {
  ctx: ReturnType<typeof createKernel>
  events: SessionEvent[]
  scripts: Array<StreamEvent[]>
}

function kit(options: { existing?: string[]; config?: Partial<Config> } = {}): Kit {
  const config = createDefaultConfig()
  config.logLevel = 'error'
  Object.assign(config, options.config ?? {})
  const ctx = createKernel(config, new AbortController().signal)

  const events: SessionEvent[] = [header()]
  const session = {
    id: SESSION_ID,
    meta: { id: SESSION_ID, createdAt: '', provider: 'deepseek', model: 'm', cwd: '/tmp' },
  }
  ctx.sessions.mount({
    create: async () => {
      events.push({ type: 'turn/start', turnNo: 0 })
      events.pop()
      return session
    },
    open: async (id: string) => {
      if (id !== SESSION_ID) throw new SessionError(`no such session: ${id}`, { kind: 'not_found' })
      return session
    },
    list: async () => [session.meta],
    read: async () => [...events],
    append: async (_id, event) => {
      events.push(event)
    },
    subscribe: () => () => {},
  })

  const scripts: Array<StreamEvent[]> = []
  const adapter: LlmAdapter = {
    stream: () =>
      (async function* (): AsyncIterable<StreamEvent> {
        for (const event of scripts.shift() ?? []) yield event
      })(),
  }
  ctx.llm.register('deepseek', () => adapter)

  return { ctx, events, scripts }
}

/** 一次工具调用（单个分片）。 */
function callOf(name: string, args = '{}', id = 'c1'): StreamEvent[] {
  return [{ type: 'tool-call', delta: { index: 0, id, name, argumentsDelta: args } }, { type: 'end' }]
}

function textOf(delta: string): StreamEvent[] {
  return [{ type: 'text', delta }, { type: 'end' }]
}

describe('builtin:agent-loop 装配', () => {
  it('34 · 无 sessionId 时新建会话，并注册控制面', async () => {
    const k = kit()
    const plugin = await createAgentPlugin()()
    await plugin.setup(k.ctx, undefined)
    expect(plugin.name).toBe(BUILTIN_AGENT)
    const ctl = k.ctx.agent.resolve() as AgentControlHandle
    expect(typeof ctl.run).toBe('function')
    expect(typeof ctl.cancel).toBe('function')
  })

  it('35 · 有 sessionId 时 open；未知 id 在启动期失败', async () => {
    const ok = kit()
    const pluginOk = await createAgentPlugin({ sessionId: SESSION_ID })()
    await expect(pluginOk.setup(ok.ctx, undefined)).resolves.toBeUndefined()

    const bad = kit()
    const pluginBad = await createAgentPlugin({ sessionId: 'nope' })()
    await expect(pluginBad.setup(bad.ctx, undefined)).rejects.toThrow('nope')
  })

  it('36 · 实例配置 maxStepsPerTurn 生效，非法值一律抛', async () => {
    // 权限显式 auto：默认兜底是 ask，无 approve 时全部失败关闭（PB-02 ②）
    const k = kit({ config: { permissions: { read: 'auto' } } })
    k.scripts.push(callOf('read', '{}', 'c1'), callOf('read', '{}', 'c2'), textOf('结束'))
    k.ctx.tools.register({
      name: 'read',
      description: 'read',
      schema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })
    const plugin = await createAgentPlugin()()
    await plugin.setup(k.ctx, { maxStepsPerTurn: 2 })
    const ctl = k.ctx.agent.resolve()
    const summary = await ctl.run({ text: '一直读' })
    expect(summary.stepCount).toBe(2)

    for (const bad of [{ maxStepsPerTurn: 0 }, { maxStepsPerTurn: -1 }, { maxStepsPerTurn: 1.5 }, { maxStepsPerTurn: '3' }, []]) {
      const k2 = kit()
      const p2 = await createAgentPlugin()()
      await expect(p2.setup(k2.ctx, bad)).rejects.toThrow()
    }
  })
})

describe('builtin:agent-loop 生命周期', () => {
  it('37 · dispose 容忍 setup 未完成（半启动清理不炸）', async () => {
    const plugin = await createAgentPlugin()()
    const dispose = plugin.dispose as (() => Promise<void>) | undefined
    await expect(dispose?.() ?? Promise.resolve()).resolves.toBeUndefined()
  })

  it('38 · dispose 中止在途回合并等待其收尾', async () => {
    const k = kit({ config: { permissions: { slow: 'auto' } } })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    k.scripts.push(callOf('slow'), textOf('完成'))
    let toolEntered = false
    k.ctx.tools.register({
      name: 'slow',
      description: 'slow tool',
      schema: { type: 'object', properties: {} },
      execute: async (_args, env) => {
        toolEntered = true
        await gate
        return env.signal.aborted ? 'aborted' : 'done'
      },
    })
    const plugin = await createAgentPlugin()()
    await plugin.setup(k.ctx, undefined)
    const ctl = k.ctx.agent.resolve() as AgentControlHandle

    let entered = false
    const task = ctl.run({ text: '跑个慢工具' }).then((s) => {
      entered = true
      return s
    })
    // 等工具**进入**执行（此时结果还没落盘）
    const start = Date.now()
    while (!toolEntered) {
      if (Date.now() - start > 3000) throw new Error('tool never entered')
      await new Promise((r) => setTimeout(r, 5))
    }

    let disposed = false
    const dispose = plugin.dispose as (() => Promise<void>) | undefined
    const disposing = (dispose?.() ?? Promise.resolve()).then(() => {
      disposed = true
    })
    // dispose 必须等工具结算：此刻还没释放闸门，不应完成
    await new Promise((r) => setTimeout(r, 20))
    expect(disposed).toBe(false)
    release()
    await disposing
    await task
    expect(disposed).toBe(true)
    expect(entered).toBe(true)
  })

  it('38b · 取消卡在审批等待：结果 cancelled（05 的 requestApproval 自己处理取消）', async () => {
    const k = kit({ config: { permissions: { read: 'ask' } } })
    k.ctx.tools.register({
      name: 'read',
      description: 'read',
      schema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })
    k.scripts.push(callOf('read'), textOf('后续'))
    // approve 永不返回：模拟"用户一直没理审批提示"
    const plugin = await createAgentPlugin({ approve: () => new Promise<boolean>(() => {}) })()
    await plugin.setup(k.ctx, undefined)
    const ctl = k.ctx.agent.resolve()

    const task = ctl.run({ text: '读文件' })
    await new Promise((r) => setTimeout(r, 50))
    ctl.cancel()
    const summary = await task

    const result = k.events.find((e) => e.type === 'tool/result') as {
      result: { ok: boolean; error?: { code: string } }
    }
    // 不是 permission_denied：取消比"未获授权"更准确（实现期偏离 X3）
    expect(result?.result.error?.code).toBe('cancelled')
    expect(summary.interrupted).toBe(true)
  })

  it('39 · registerAgentBuiltin 重复注册抛错，退订后可移除', async () => {
    const off = registerAgentBuiltin()
    expect(() => registerAgentBuiltin()).toThrow()
    off()
    expect(() => registerAgentBuiltin()).not.toThrow()
  })
})
