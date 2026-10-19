import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '../../src/index.js'
import { createMcpClient } from './client.js'
import type { SpawnLike } from './types.js'

/**
 * client.ts 单测（设计 §6.1）：注入伪 spawn（02 的伪 fetch 同式，D5）——
 * 子进程用 PassThrough 管道模拟，server 行为由每个用例的 responder 决定。
 * 不真拉子进程（真实进程边界归集成测试）。
 */

/** 伪日志器：记录调用供断言（warn 是否触发、debug 是否吞了 stderr 等）。 */
function makeLog(): Logger & { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** 单个伪子进程的记录面。 */
interface FakeRecord {
  /** 该进程收到的全部出站消息（initialize / tools/list / 通知）。 */
  received: Array<Record<string, unknown>>
  /** 子进程的 stdout 管道（评审 Y1：需要它触发流错误）。 */
  stdout: PassThrough
  /** kill 是否被调用。 */
  killed: boolean
  /** 触发子进程退出（'close' 事件）。 */
  close(): void
  /** 触发 spawn 'error' 事件（如 ENOENT）。 */
  fail(err: Error): void
}

type Responder = (
  msg: Record<string, unknown>,
  reply: (result: unknown) => void,
) => void

/**
 * 造一个伪 spawn：返回的 spawnFn 每次调用产出一条伪子进程（PassThrough 三管道），
 * responder 驱动"server 行为"，reply 把 result 写回 stdout。
 */
function makeServerSpawn(responder: Responder): { spawn: SpawnLike; records: FakeRecord[] } {
  const records: FakeRecord[] = []
  const spawn: SpawnLike = (_command, _args, _options) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const emitter = new EventEmitter()
    const received: Array<Record<string, unknown>> = []
    const record: FakeRecord = {
      received,
      stdout,
      killed: false,
      close: () => emitter.emit('close'),
      fail: (err: Error) => emitter.emit('error', err),
    }
    records.push(record)
    // server 行为：stdin 每行交给 responder，reply 写回 stdout
    createInterface({ input: stdin }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      received.push(msg)
      responder(msg, (result) => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg['id'], result })}\n`)
      })
    })
    // 形状对齐 ChildProcess（PassThrough 与 Socket 的差异用整体 cast 吸收）
    const child = Object.assign(emitter, {
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
    return child
  }
  return { spawn, records }
}

/** 握手 + 发现的标准 responder（tools 能力 + 工具清单）。 */
function standardResponder(
  tools: Array<Record<string, unknown>>,
  extra?: { nextCursor?: string },
): Responder {
  return (msg, reply) => {
    if (msg['method'] === 'initialize') {
      reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } })
      return
    }
    if (msg['method'] === 'tools/list') {
      reply({ tools, ...(extra?.nextCursor !== undefined ? { nextCursor: extra.nextCursor } : {}) })
      return
    }
    if (msg['method'] === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'done' }], isError: false })
    }
  }
}

const SPEC = { command: 'fake-server' }

describe('createMcpClient', () => {
  it('25 · 握手序列：initialize → notifications/initialized → tools/list，参数形状符合设计 §4.2', async () => {
    const { spawn, records } = makeServerSpawn(standardResponder([{ name: 'echo', description: '回声', inputSchema: { type: 'object' } }]))
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn })
    const tools = await client.start(1_000)

    expect(tools.map((t) => t.name)).toEqual(['echo'])
    expect(tools[0]!.description).toBe('回声')
    // 出站顺序：请求 initialize → 通知 initialized → 请求 tools/list
    const methods = records[0]!.received.map((m) => m['method'])
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    const init = records[0]!.received[0]!['params'] as Record<string, unknown>
    expect(init).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'minidsh-mcp', version: '0.1.0' },
    })
    // initialized 是通知：无 id
    expect(records[0]!.received[1]!['id']).toBeUndefined()
  })

  it('26 · capabilities.tools 缺失 ⇒ 空工具集且不发 tools/list（算启动成功）', async () => {
    const { spawn, records } = makeServerSpawn((msg, reply) => {
      if (msg['method'] === 'initialize') reply({ capabilities: {} })
    })
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn })
    await expect(client.start(1_000)).resolves.toEqual([])
    expect(records[0]!.received.map((m) => m['method'])).toEqual([
      'initialize',
      'notifications/initialized',
    ])
  })

  it('27 · 工具清单解析；nextCursor 存在时记 warn（Q12 不做分页）；重名工具 ⇒ 启动失败', async () => {
    // 正常解析 + 分页提示
    const { spawn, records } = makeServerSpawn(
      standardResponder(
        [
          { name: 'echo', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
          { name: 'boom' },
        ],
        { nextCursor: 'page-2' },
      ),
    )
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn })
    const tools = await client.start(1_000)
    expect(tools).toHaveLength(2)
    expect(tools[0]!.inputSchema).toMatchObject({ required: ['q'] })
    expect(log.warn).toHaveBeenCalledOnce()
    expect(String(log.warn.mock.calls[0]![0])).toContain('nextCursor')
    void records

    // 重名：同一 server 内两个 echo ⇒ 公开名会撞车，须在启动期失败
    const dup = makeServerSpawn(standardResponder([{ name: 'echo' }, { name: 'echo' }]))
    const dupClient = createMcpClient({ server: 'demo', spec: SPEC, log: makeLog(), spawn: dup.spawn })
    await expect(dupClient.start(1_000)).rejects.toThrow(/重名工具 'echo'/)
  })

  it('28 · callTool：wire 上用 raw 名，参数原样传递，结果收窄为 content/isError', async () => {
    const { spawn, records } = makeServerSpawn(standardResponder([{ name: 'echo' }]))
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn })
    await client.start(1_000)
    const outcome = await client.callTool('echo', { q: '你好' })
    expect(outcome).toEqual({ content: [{ type: 'text', text: 'done' }], isError: false })
    const call = records[0]!.received.find((m) => m['method'] === 'tools/call')!
    expect(call['params']).toEqual({ name: 'echo', arguments: { q: '你好' } })
  })

  it('29 · 子进程 close ⇒ 在途请求立即以"连接已关闭"失败，此后调用同样失败', async () => {
    const server = makeServerSpawn((msg, reply) => {
      if (msg['method'] === 'initialize') {
        reply({ capabilities: { tools: {} }, serverInfo: { name: 'fake' } })
      } else if (msg['method'] === 'tools/list') {
        reply({ tools: [{ name: 'echo' }] })
      }
      // tools/call 故意不应答：制造挂起的在途请求
    })
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn: server.spawn })
    await client.start(1_000)
    const pending = client.callTool('echo', {})
    server.records[0]!.close()
    await expect(pending).rejects.toThrow('连接已关闭')
    await expect(client.callTool('echo', {})).rejects.toThrow('连接已关闭')
  })

  it('25b · stdout 流出错 ⇒ 被吞掉不炸进程（评审 Y1：readline interface 也须监听 error）', async () => {
    const { spawn, records } = makeServerSpawn(standardResponder([{ name: 'echo' }]))
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn })
    await client.start(1_000)
    // readline 把 input 的 'error' 转发为 interface 的 'error'：任一层没监听，
    // 一次 stdout 出错（EPIPE / ECONNRESET）就是 uncaught exception，CLI 崩掉
    expect(() => {
      records[0]!.stdout.emit(
        'error',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      )
    }).not.toThrow()
    // dispose 后读端一并销毁：孤儿进程（F-05）不该拖住 CLI 退出
    await client.dispose()
    expect(records[0]!.stdout.destroyed).toBe(true)
  })

  it('30 · startupTimeoutMs 是整个启动序列共用的 deadline，不是每请求各算一份（评审 Y2）', async () => {
    // initialize 与 tools/list 各耗 400ms；预算 600ms ⇒ 第二次只剩 ~200ms 必超时
    const slow: Responder = (msg, reply) => {
      setTimeout(() => {
        if (msg['method'] === 'initialize') reply({ capabilities: { tools: {} } })
        else if (msg['method'] === 'tools/list') reply({ tools: [{ name: 'echo' }] })
      }, 400)
    }
    const { spawn } = makeServerSpawn(slow)
    const client = createMcpClient({ server: 'demo', spec: SPEC, log: makeLog(), spawn })
    // 修复前：两个请求各拿 600ms ⇒ 总耗时 ~800ms 且**成功**（越过 07 的 15s boot 超时）
    await expect(client.start(600)).rejects.toThrow(/tools\/list 超时/)
  })

  it('29b · spawn 失败（error 事件，如 ENOENT）⇒ 启动以"进程启动失败"失败', async () => {
    const server = makeServerSpawn(() => {})
    const log = makeLog()
    const client = createMcpClient({ server: 'demo', spec: SPEC, log, spawn: server.spawn })
    const pending = client.start(1_000)
    server.records[0]!.fail(Object.assign(new Error('spawn fake-server ENOENT'), { code: 'ENOENT' }))
    await expect(pending).rejects.toThrow(/进程启动失败.*ENOENT/)
  })
})
