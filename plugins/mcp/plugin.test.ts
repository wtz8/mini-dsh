import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { Ctx, Logger } from '../../src/index.js'
import mcpDefault from './index.js'
import { createMcpPlugin } from './plugin.js'
import type { McpServerSpec, SpawnLike } from './types.js'

/**
 * plugin.ts 单测（设计 §6.1）：伪 ctx + 伪 spawn。
 *
 * 覆盖：插件形状与 default 导出 / 注册数量与顺序（并行完成序不影响键序）/
 * 配置 narrow 防线 / fail 与 tolerate 两种启动失败策略 / 空 servers /
 * dispose 幂等与 setup 未完成容忍 / `$ENV:` 环境变量解析（Q14）。
 */

type Responder = (msg: Record<string, unknown>, reply: (result: unknown) => void) => void

/** 伪子进程记录面。 */
interface SpawnRecord {
  command: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  received: Array<Record<string, unknown>>
  killed: boolean
  close(): void
}

/** 标准应答器：握手 + 单个 echo 工具 + tools/call 成功。 */
const standardResponder: Responder = (msg, reply) => {
  if (msg['method'] === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } })
  } else if (msg['method'] === 'tools/list') {
    reply({ tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object' } }] })
  } else if (msg['method'] === 'tools/call') {
    reply({ content: [{ type: 'text', text: 'ok' }], isError: false })
  }
}

/** 沉默应答器：什么都不回（制造启动超时）。 */
const silentResponder: Responder = () => {}

/** 标准应答器 + 人工延迟（验证"完成先后不影响注册序"）。 */
function delayedResponder(ms: number, tools: string[]): Responder {
  return (msg, reply) => {
    const answer = (): void => {
      if (msg['method'] === 'initialize') {
        reply({ capabilities: { tools: {} }, serverInfo: { name: 'fake' } })
      } else if (msg['method'] === 'tools/list') {
        reply({ tools: tools.map((name) => ({ name })) })
      }
    }
    setTimeout(answer, ms)
  }
}

/**
 * 造伪 spawn 工具箱：按 `command` 选择 responder（default = 标准应答器），
 * 每条伪子进程记录 command / env / cwd / 收到的消息 / kill 状态。
 */
function makeSpawnKit(responders: Record<string, Responder> = {}): {
  spawn: SpawnLike
  records: SpawnRecord[]
} {
  const records: SpawnRecord[] = []
  const spawn: SpawnLike = (command, _args, options) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const emitter = new EventEmitter()
    const received: Array<Record<string, unknown>> = []
    const record: SpawnRecord = {
      command,
      env: options.env,
      cwd: options.cwd,
      received,
      killed: false,
      close: () => emitter.emit('close'),
    }
    records.push(record)
    const responder = responders[command] ?? standardResponder
    createInterface({ input: stdin }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      received.push(msg)
      responder(msg, (result) => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg['id'], result })}\n`)
      })
    })
    return Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 42424,
      kill: () => {
        record.killed = true
        // 真实子进程被 kill 后会退出 ⇒ 触发 close；伪进程同步模拟
        emitter.emit('close')
        return true
      },
    }) as unknown as ChildProcess
  }
  return { spawn, records }
}

/** 伪日志器。 */
function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** 伪 ctx：plugin 只消费 `log` 与 `tools.register`（register 同步挂到顶层便于断言）。 */
function makeCtx(): Ctx & { register: ReturnType<typeof vi.fn>; log: Logger } {
  const register = vi.fn()
  const log = makeLog()
  return { log, register, tools: { register } } as unknown as Ctx & {
    register: ReturnType<typeof vi.fn>
    log: Logger
  }
}

describe('createMcpPlugin', () => {
  it('34 · 插件形状：default 导出是工厂，产物过 assertPlugin 语义', async () => {
    expect(typeof mcpDefault).toBe('function')
    const plugin = await mcpDefault()
    expect(plugin.name).toBe('mcp')
    expect(typeof plugin.setup).toBe('function')
    const local = await createMcpPlugin()()
    expect(local.name).toBe('mcp')
    expect(typeof local.setup).toBe('function')
  })

  it('35 · 注册数量 = 全部 server 工具之和，顺序按配置键序（并行完成先后不影响）', async () => {
    // alpha 故意比 beta 慢 30ms：若注册序受完成序影响，beta 会先注册
    const { spawn } = makeSpawnKit({
      'srv-alpha': delayedResponder(30, ['a1', 'a2']),
      'srv-beta': delayedResponder(0, ['b1']),
    })
    const ctx = makeCtx()
    const servers: Record<string, McpServerSpec> = {
      alpha: { command: 'srv-alpha' },
      beta: { command: 'srv-beta' },
    }
    await (await createMcpPlugin({ servers, spawn })()).setup(ctx)
    const names = ctx.register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['mcp__alpha__a1', 'mcp__alpha__a2', 'mcp__beta__b1'])
  })

  it('36 · narrow 防线：配置形状非法 ⇒ setup 抛错（转 BootError）', async () => {
    const { spawn } = makeSpawnKit()
    const badConfigs: unknown[] = [
      ['数组不是对象'],
      { servers: ['数组也不是 server 表'] },
      { servers: { 'bad name': { command: 'x' } } }, // server 名含空格
      { servers: { demo: ['不是对象'] } },
      { servers: { demo: { command: '' } } },
      { servers: { demo: { command: 'x', args: '不是数组' } } },
      { servers: { demo: { command: 'x', args: [1] } } },
      { servers: { demo: { command: 'x', env: { T: 42 } } } },
      { servers: { demo: { command: 'x', startupTimeoutMs: -1 } } },
      { onStartupError: 'explode' },
    ]
    for (const config of badConfigs) {
      const ctx = makeCtx()
      const plugin = await createMcpPlugin({ spawn })()
      await expect(plugin.setup(ctx, config)).rejects.toThrow(/mcp 插件配置|server 名/)
      expect(ctx.register).not.toHaveBeenCalled()
    }
  })

  it('37 · fail 策略：任一 server 启动失败 ⇒ setup 抛错，已起的子进程全部被 kill', async () => {
    const { spawn, records } = makeSpawnKit({ 'srv-bad': silentResponder })
    const ctx = makeCtx()
    const servers: Record<string, McpServerSpec> = {
      good: { command: 'srv-good' },
      bad: { command: 'srv-bad', startupTimeoutMs: 20 }, // 沉默 ⇒ 20ms 超时
    }
    const plugin = await createMcpPlugin({ servers, spawn })()
    await expect(plugin.setup(ctx)).rejects.toThrow(/MCP server 启动失败：bad/)
    // good 的连接由失败路径关闭；bad 的连接在单 server 自清时关闭——都不留孤儿
    expect(records.map((r) => r.killed)).toEqual([true, true])
    expect(ctx.register).not.toHaveBeenCalled()
  })

  it('38 · tolerate 策略：失败的 server 零工具，其余照常注册，log.error 留痕', async () => {
    const { spawn } = makeSpawnKit({ 'srv-bad': silentResponder })
    const ctx = makeCtx()
    const servers: Record<string, McpServerSpec> = {
      good: { command: 'srv-good' },
      bad: { command: 'srv-bad', startupTimeoutMs: 20 },
    }
    await (
      await createMcpPlugin({ servers, spawn, onStartupError: 'tolerate' })()
    ).setup(ctx)
    const names = ctx.register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['mcp__good__echo'])
    expect(ctx.log.error).toHaveBeenCalledOnce()
    // 实例配置里的 onStartupError 同样生效（优先于构造选项）
    const ctx2 = makeCtx()
    await (
      await createMcpPlugin({ servers, spawn })()
    ).setup(ctx2, { onStartupError: 'tolerate' })
    expect(ctx2.register.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([
      'mcp__good__echo',
    ])
  })

  it('39 · 空 servers：挂载成功、零工具、不 spawn', async () => {
    const { spawn, records } = makeSpawnKit()
    const ctx = makeCtx()
    await (await createMcpPlugin({ spawn })()).setup(ctx)
    await (await createMcpPlugin({ spawn })()).setup(ctx, { servers: {} })
    expect(ctx.register).not.toHaveBeenCalled()
    expect(records).toHaveLength(0)
  })

  it('40 · dispose：正常路径关闭全部连接；setup 未完成 / 未调用时 dispose 不炸', async () => {
    // 正常路径：两个 server，dispose 后全部 kill
    const kit = makeSpawnKit()
    const servers: Record<string, McpServerSpec> = { a: { command: 'x' }, b: { command: 'y' } }
    const plugin = await createMcpPlugin({ servers, spawn: kit.spawn })()
    await plugin.setup(makeCtx())
    await plugin.dispose?.()
    expect(kit.records.map((r) => r.killed)).toEqual([true, true])
    // 未 setup 就 dispose（00 X5 义务的极端形态）
    await expect((await createMcpPlugin()()).dispose?.()).resolves.toBeUndefined()
    // setup 抛错（fail 路径已自清）后再 dispose：幂等、不炸
    const failing = makeSpawnKit({ 'srv-bad': silentResponder })
    const broken = await createMcpPlugin({
      servers: { good: { command: 'srv-good' }, bad: { command: 'srv-bad', startupTimeoutMs: 20 } },
      spawn: failing.spawn,
    })()
    await expect(broken.setup(makeCtx())).rejects.toThrow()
    await expect(broken.dispose?.()).resolves.toBeUndefined()
  })

  it('41 · $ENV:NAME 解析为父进程环境变量（Q14），普通值原样透传', async () => {
    process.env['MDSH_MCP_TEST_TOKEN'] = 'secret-value'
    try {
      const { spawn, records } = makeSpawnKit()
      const ctx = makeCtx()
      await (
        await createMcpPlugin({
          spawn,
          servers: {
            demo: { command: 'srv', env: { TOKEN: '$ENV:MDSH_MCP_TEST_TOKEN', PLAIN: 'literal' } },
          },
        })()
      ).setup(ctx)
      const env = records[0]!.env
      expect(env?.['TOKEN']).toBe('secret-value')
      expect(env?.['PLAIN']).toBe('literal')
    } finally {
      delete process.env['MDSH_MCP_TEST_TOKEN']
    }
  })

  it('42 · $ENV:NAME 引用的变量不存在 ⇒ 该 server 启动失败，且不 spawn（零副作用）', async () => {
    delete process.env['MDSH_MCP_MISSING_VAR']
    const { spawn, records } = makeSpawnKit()
    const ctx = makeCtx()
    await expect(
      (
        await createMcpPlugin({
          spawn,
          servers: { demo: { command: 'srv', env: { TOKEN: '$ENV:MDSH_MCP_MISSING_VAR' } } },
        })()
      ).setup(ctx),
    ).rejects.toThrow(/MDSH_MCP_MISSING_VAR/)
    expect(records).toHaveLength(0)
  })
})
