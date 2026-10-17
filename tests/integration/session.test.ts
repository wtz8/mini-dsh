import fs from 'node:fs/promises'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ChatMessage, Config, Ctx, SessionEvent } from '../../src/index.js'
import { boot, deriveMessages, registerBuiltin, shutdown } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { createSessionPlugin } from '../../src/session/index.js'

/**
 * 03-session 集成测试（设计 §6.2）：真实组合根 + 真实文件系统（tmp 目录）。
 *
 * 五条链路：挂载与容器 / 落盘 + 投影 / 事件广播 / **resume（跨实例恢复）** / compaction。
 * resume 是 append-only 持久化的全部价值所在，故单独成链并逐项比对事件序列。
 *
 * fixture 目录与本仓库其它模块的 `*-fixtures/` 分开（理由同 01 X3：共用目录会在
 * vitest 并行执行时互相踩踏）。
 */

const FIXTURES_DIR = path.join('tests', 'integration', 'session-fixtures')

/** 探针插件：挂载在 `builtin:session` **之前**，记录后续插件的挂载广播。 */
const PROBE_PLUGIN = `export default () => ({
  name: 'session-probe',
  setup(ctx) {
    ctx.events.on('plugin/mounted', ({ name }) => {
      globalThis.__m03Probe.mounted.push(name)
    })
  },
})
`

interface ProbeState {
  mounted: string[]
}

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []

function makeConfig(sources: string[]): Config {
  const config = createDefaultConfig()
  config.plugins = sources.map((source) => ({ source }))
  return config
}

const probeSource = (): string => path.join(FIXTURES_DIR, 'probe.mjs').replace(/\\/g, '/')

/** 在 fixture 目录内建一个独立的 tmp 子目录（互不干扰，afterAll 统一清理）。 */
async function makeDir(): Promise<string> {
  return fs.mkdtemp(path.resolve(process.cwd(), FIXTURES_DIR, 'sess-'))
}

/** 用指定目录注册 `builtin:session` 并 boot。 */
async function bootWithSession(dir: string, extra: string[] = []): Promise<Ctx> {
  unsubscribes.push(registerBuiltin('session', createSessionPlugin({ dir })))
  const ctx = await boot(makeConfig([...extra, 'builtin:session']))
  contexts.push(ctx)
  return ctx
}

const init = { provider: 'deepseek', model: 'deepseek-chat', cwd: process.cwd() }

const usage = { inputTokens: 10, outputTokens: 20 }

beforeAll(async () => {
  await fs.mkdir(path.resolve(process.cwd(), FIXTURES_DIR), { recursive: true })
  await fs.writeFile(path.resolve(process.cwd(), FIXTURES_DIR, 'probe.mjs'), PROBE_PLUGIN, 'utf8')
})

afterAll(async () => {
  await fs.rm(path.resolve(process.cwd(), FIXTURES_DIR), { recursive: true, force: true })
})

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop()
    if (ctx) await shutdown(ctx)
  }
  while (unsubscribes.length > 0) unsubscribes.pop()?.()
})

/* ============================================================
 * 链路 1：挂载与容器（eat own dogfood + M0 容器语义回归）
 * ============================================================ */

describe('集成 · 挂载与容器链路', () => {
  it('builtin:session 作为插件挂载：广播 plugin/mounted，且 ctx.sessions 可用', async () => {
    ;(globalThis as Record<string, unknown>).__m03Probe = { mounted: [] } as ProbeState
    const dir = await makeDir()
    await bootWithSession(dir, [probeSource()])

    // 探针在 builtin:session 之前挂载，故能收到它的挂载广播——会话能力不是内核内建的
    expect((globalThis as Record<string, unknown>).__m03Probe).toEqual({
      mounted: ['session-probe', 'builtin:session'],
    })
  })

  it('挂载后可 create / read / list，meta 与磁盘 header 一致', async () => {
    const dir = await makeDir()
    const ctx = await bootWithSession(dir)

    const session = await ctx.sessions.create(init)
    const events = await ctx.sessions.read(session.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'session/header', id: session.id })

    const metas = await ctx.sessions.list()
    expect(metas.map((m) => m.id)).toEqual([session.id])
    expect(metas[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('未挂载 builtin:session 时，ctx.sessions 一律抛 not mounted（M0 容器语义回归）', async () => {
    const ctx = await boot(makeConfig([]))
    contexts.push(ctx)

    await expect(ctx.sessions.create(init)).rejects.toThrow(/not mounted/)
    await expect(ctx.sessions.read('any')).rejects.toThrow(/not mounted/)
  })
})

/* ============================================================
 * 链路 2：落盘 + 投影（灵魂 #2 的端到端）
 * ============================================================ */

describe('集成 · 落盘与投影链路', () => {
  it('append 的事件真实落盘，read + deriveMessages 得到模型可见面', async () => {
    const dir = await makeDir()
    const ctx = await bootWithSession(dir)
    const { id } = await ctx.sessions.create(init)

    const written: SessionEvent[] = [
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: '读一下 README' },
      {
        type: 'assistant/message',
        content: '',
        toolCalls: [{ id: 'call_0', name: 'read', arguments: '{"path":"README.md"}' }],
        usage,
      },
      {
        type: 'tool/result',
        toolCallId: 'call_0',
        result: { callId: 'call_0', name: 'read', ok: true, content: '# MiniDSH' },
      },
      { type: 'turn/end', turnNo: 1 },
    ]
    for (const event of written) await ctx.sessions.append(id, event)

    // 1. 磁盘形态：一行一事件，首行为 header
    const file = path.join(dir, id, 'session.jsonl')
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(1 + written.length)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'session/header' })

    // 2. 投影：回合边界不投影，tool 结果按 callId 关联
    const messages = deriveMessages(await ctx.sessions.read(id))
    expect(messages).toEqual<ChatMessage[]>([
      { role: 'user', content: '读一下 README' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_0', name: 'read', arguments: '{"path":"README.md"}' }],
      },
      { role: 'tool', toolCallId: 'call_0', content: '# MiniDSH' },
    ])
  })
})

/* ============================================================
 * 链路 3：事件广播（插件把 store 接到总线）
 * ============================================================ */

describe('集成 · 事件广播链路', () => {
  it('append 后经总线收到 session/append（{ sessionId, event }）', async () => {
    const dir = await makeDir()
    const ctx = await bootWithSession(dir)
    const { id } = await ctx.sessions.create(init)

    const seen: Array<{ sessionId: string; event: SessionEvent }> = []
    ctx.events.on('session/append', (payload) => {
      seen.push(payload)
    })

    const event: SessionEvent = { type: 'user/message', content: '总线检查' }
    await ctx.sessions.append(id, event)
    expect(seen).toEqual([{ sessionId: id, event }])
  })
})

/* ============================================================
 * 链路 4：resume（shutdown 后新实例打开，事件序列逐项相等）
 * ============================================================ */

describe('集成 · resume 链路', () => {
  it('进程内换一个 store 实例后 open + read 得到完全一致的事件序列', async () => {
    const dir = await makeDir()
    const first = await bootWithSession(dir)
    const { id } = await first.sessions.create(init)

    const written: SessionEvent[] = [
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: '第一轮' },
      { type: 'assistant/message', content: '回答一', usage },
      { type: 'turn/end', turnNo: 1 },
      { type: 'turn/start', turnNo: 2 },
      { type: 'user/message', content: '第二轮' },
    ]
    for (const event of written) await first.sessions.append(id, event)

    // 关闭第一个实例（dispose → flush + 清内存），再退订 builtin 以便换注新实例
    await shutdown(first)
    unsubscribes.pop()?.()

    const second = await bootWithSession(dir)
    const reopened = await second.sessions.open(id)

    expect(reopened.id).toBe(id)
    expect(reopened.meta.createdAt).toBe((await first.sessions.list())[0]?.createdAt ?? '')
    expect(await second.sessions.read(id)).toEqual([
      { type: 'session/header', id, createdAt: reopened.meta.createdAt, ...init, cwd: init.cwd },
      ...written,
    ])
  })
})

/* ============================================================
 * 链路 5：compaction 投影语义
 * ============================================================ */

describe('集成 · compaction 链路', () => {
  it('压缩事件之后，投影只剩摘要（user 消息）与新回合', async () => {
    const dir = await makeDir()
    const ctx = await bootWithSession(dir)
    const { id } = await ctx.sessions.create(init)

    for (const event of [
      { type: 'turn/start', turnNo: 1 } satisfies SessionEvent,
      { type: 'user/message', content: '旧问题' } satisfies SessionEvent,
      { type: 'assistant/message', content: '旧回答', usage } satisfies SessionEvent,
      { type: 'turn/end', turnNo: 1 } satisfies SessionEvent,
      { type: 'compaction', summary: '旧回合摘要：问了 README', boundary: 1 } satisfies SessionEvent,
      { type: 'turn/start', turnNo: 2 } satisfies SessionEvent,
      { type: 'user/message', content: '新问题' } satisfies SessionEvent,
      { type: 'assistant/message', content: '新回答', usage } satisfies SessionEvent,
    ]) {
      await ctx.sessions.append(id, event)
    }

    const messages = deriveMessages(await ctx.sessions.read(id))
    expect(messages).toEqual<ChatMessage[]>([
      { role: 'user', content: '旧回合摘要：问了 README' },
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '新回答' },
    ])
  })
})
