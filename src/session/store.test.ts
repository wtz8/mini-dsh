import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionEvent } from '../contracts.js'
import { SessionError } from '../errors.js'
import { createJsonlSessionStore } from './store.js'
import { SESSION_FILE } from './types.js'
import type { JsonlSessionStore, SessionListener } from './types.js'

/**
 * JSONL 会话存储（设计 §4.2–§4.3、§5 边界表）。
 *
 * 全部用例跑在 tmp 目录上（真实 fs，不打桩）——落盘顺序与坏行容错只有真文件才测得出来。
 * fixture 目录与其它模块分开（01 X3：共用目录会在 vitest 并行执行时互相踩踏）。
 */

let dir: string
let warns: string[]
let listenerErrors: unknown[]
let broadcast: Array<{ sessionId: string; event: SessionEvent }>

function makeStore(idFactory?: () => string): JsonlSessionStore {
  return createJsonlSessionStore({
    dir,
    onWarn: (m) => warns.push(m),
    onError: (_m, err) => listenerErrors.push(err),
    onAppend: (sessionId, event) => broadcast.push({ sessionId, event }),
    ...(idFactory === undefined ? {} : { idFactory }),
  })
}

/** 固定 id，便于拼文件路径做落盘断言。 */
const fixed = (): string => 'fixed-id'

const init = { provider: 'deepseek', model: 'deepseek-chat', cwd: 'D:\\MiniDSH' }

/** 手写一个 jsonl 文件（造损坏/坏行场景用）。 */
async function writeRaw(id: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.join(dir, id), { recursive: true })
  await fs.writeFile(path.join(dir, id, SESSION_FILE), lines.map((l) => `${l}\n`).join(''), 'utf8')
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-session-'))
  warns = []
  listenerErrors = []
  broadcast = []
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('create', () => {
  it('落盘：目录内写出 session.jsonl，首行是 header', async () => {
    const store = makeStore(fixed)
    const session = await store.create(init)

    expect(session.id).toBe('fixed-id')
    const text = await fs.readFile(path.join(dir, 'fixed-id', SESSION_FILE), 'utf8')
    const first = JSON.parse(text.split('\n')[0] ?? '') as SessionEvent
    expect(first.type).toBe('session/header')
    expect(session.meta.provider).toBe('deepseek')
    expect(session.meta.model).toBe('deepseek-chat')
    expect(session.meta.cwd).toBe('D:\\MiniDSH')
  })

  it('目标文件已存在 → 抛 io，绝不追加（追加会混写两个会话）', async () => {
    const store = makeStore(fixed)
    await store.create(init)
    await expect(store.create(init)).rejects.toMatchObject({ kind: 'io' })
    await expect(store.create(init)).rejects.toBeInstanceOf(SessionError)
  })

  it('并发 create 同一 id 只有一个成功，磁盘上只有一条 header（review Y3）', async () => {
    // 回归：原实现是 access 预检 + append，check-then-act 之间存在窗口，
    // 两个并发调用可能各写一条 header（50 轮实测复现 6 次）
    const store = makeStore(fixed)
    const results = await Promise.allSettled([store.create(init), store.create(init)])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const lines = (await fs.readFile(path.join(dir, 'fixed-id', SESSION_FILE), 'utf8')).split('\n').filter(Boolean)
    expect(lines.filter((l) => l.includes('session/header'))).toHaveLength(1)
  })
})

describe('append', () => {
  it('追加一行且内存同步（read 也看得到）', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    await store.append(id, { type: 'turn/start', turnNo: 1 })

    expect(await store.read(id)).toHaveLength(2)
    const lines = (await fs.readFile(path.join(dir, 'fixed-id', SESSION_FILE), 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    // 落盘后才广播：订阅者看到的 log 已经持久化
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0]?.event).toEqual({ type: 'turn/start', turnNo: 1 })
  })

  it('并发 append 的落盘顺序 = 调用顺序（写链串行化）', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    await Promise.all([
      store.append(id, { type: 'turn/start', turnNo: 1 }),
      store.append(id, { type: 'user/message', content: '一' }),
      store.append(id, { type: 'turn/end', turnNo: 1 }),
    ])

    const lines = (await fs.readFile(path.join(dir, 'fixed-id', SESSION_FILE), 'utf8')).split('\n').filter(Boolean)
    const types = lines.map((l) => (JSON.parse(l) as SessionEvent).type)
    expect(types).toEqual(['session/header', 'turn/start', 'user/message', 'turn/end'])
  })

  it('对未 open 但磁盘存在的会话，append 会先载入再追加', async () => {
    const first = makeStore(fixed)
    const { id } = await first.create(init)
    await first.append(id, { type: 'turn/start', turnNo: 1 })

    // 全新 store 实例（模拟进程重启后的 resume）
    const second = makeStore(fixed)
    await second.append(id, { type: 'user/message', content: '继续' })

    const events = await second.read(id)
    expect(events).toHaveLength(3)
    expect(events[2]).toEqual({ type: 'user/message', content: '继续' })
  })

  it('冷缓存上并发 append 不分叉：内存缓存与磁盘一致（single-flight 载入）', async () => {
    const first = makeStore(fixed)
    const { id } = await first.create(init)
    await first.append(id, { type: 'turn/start', turnNo: 1 })

    // 全新 store 实例 = 冷缓存（模拟进程重启后立即并发写入）；写链注释明示
    // 06 的 Promise.all(append(...)) 是一等场景，故此路径必须不分叉
    const second = makeStore(fixed)
    await Promise.all([
      second.append(id, { type: 'user/message', content: 'a' }),
      second.append(id, { type: 'user/message', content: 'b' }),
    ])

    // read 走内存缓存；clear 后再 read 走磁盘——两者必须一致（修复前缓存丢 'a'）
    const warm = await second.read(id)
    second.clear()
    const cold = await second.read(id)
    expect(warm).toHaveLength(4)
    expect(warm).toEqual(cold)
  })

  it('append 到完全未知的 id → not_found', async () => {
    const store = makeStore()
    await expect(store.append('nope', { type: 'turn/start', turnNo: 1 })).rejects.toMatchObject({
      kind: 'not_found',
    })
  })

  it('入口即快照：调用方在 await 之后改写事件对象，不污染内存缓存（review Y2）', async () => {
    // 回归：原实现把入参引用直接放进缓存，调用方改写后 read() 变了而磁盘没变，
    // 当前进程与重启恢复的历史就此分叉
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    const event: SessionEvent = { type: 'user/message', content: '原文' }
    await store.append(id, event)
    ;(event as { content: string }).content = '被改写'

    expect((await store.read(id))[1]).toEqual({ type: 'user/message', content: '原文' })
    store.clear()
    expect((await store.read(id))[1]).toEqual({ type: 'user/message', content: '原文' })
  })
})

describe('open / read', () => {
  it('open 命中内存缓存（文件被删仍能打开）', async () => {
    const store = makeStore(fixed)
    await store.create(init)
    await fs.rm(path.join(dir, 'fixed-id'), { recursive: true, force: true })

    const session = await store.open('fixed-id')
    expect(session.id).toBe('fixed-id')
  })

  it('open 不存在的 id → not_found（不静默新建）', async () => {
    const store = makeStore()
    await expect(store.open('nope')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('空文件 → corrupt', async () => {
    await writeRaw('empty', [])
    const store = makeStore()
    await expect(store.open('empty')).rejects.toMatchObject({ kind: 'corrupt' })
  })

  it('首个有效事件不是 header → corrupt', async () => {
    await writeRaw('no-header', [JSON.stringify({ type: 'turn/start', turnNo: 1 })])
    const store = makeStore()
    await expect(store.open('no-header')).rejects.toMatchObject({ kind: 'corrupt' })
  })

  it('中间行坏 JSON → 跳过并告警，会话仍可用', async () => {
    await writeRaw('broken', [
      JSON.stringify({
        type: 'session/header',
        id: 'broken',
        createdAt: '2026-10-17T00:00:00.000Z',
        provider: 'p',
        model: 'm',
        cwd: '.',
      }),
      '{"type":"user/message","content":"半行没写完', // 崩溃留下的残行
      JSON.stringify({ type: 'user/message', content: '完好' }),
    ])
    const store = makeStore()
    const session = await store.open('broken')

    expect(await store.read('broken')).toHaveLength(2)
    expect(session.meta.id).toBe('broken')
    expect(warns.some((w) => w.includes('unparsable'))).toBe(true)
  })

  it('read 返回拷贝：改动返回值不影响内部序列', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    const events = await store.read(id)
    events.push({ type: 'turn/start', turnNo: 99 })

    expect(await store.read(id)).toHaveLength(1)
  })

  it('id 只允许单一路径段：含 ../ 或分隔符一律 not_found，且不触碰根目录外的文件（review Y1）', async () => {
    // 回归：原实现把外部 id 直接拼进路径，`../outside` 可读写 sessions 根目录之外的
    // `session.jsonl`——open/read 是信息泄露，append 是向任意文件追加
    const sessions = path.join(dir, 'sessions')
    const outside = path.join(dir, 'outside')
    await fs.mkdir(sessions, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(
      path.join(outside, SESSION_FILE),
      `${JSON.stringify({ type: 'session/header', id: 'evil', createdAt: '2026-10-17T00:00:00.000Z', provider: 'p', model: 'm', cwd: '.' })}\n`,
      'utf8',
    )
    const store = createJsonlSessionStore({ dir: sessions })

    for (const bad of ['../outside', '..\\outside', 'a/b', 'a\\b', '..', '.', '']) {
      await expect(store.open(bad)).rejects.toMatchObject({ kind: 'not_found' })
      await expect(store.read(bad)).rejects.toMatchObject({ kind: 'not_found' })
      await expect(store.append(bad, { type: 'turn/start', turnNo: 1 })).rejects.toMatchObject({
        kind: 'not_found',
      })
    }
    // 根目录外的文件一个字节都没变（没被读出去，更没被追加）
    const text = await fs.readFile(path.join(outside, SESSION_FILE), 'utf8')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
  })
})

describe('subscribe', () => {
  it('订阅者收到后续 append 的事件', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    const seen: SessionEvent[] = []
    const off = store.subscribe(id, (e) => seen.push(e))

    await store.append(id, { type: 'user/message', content: '你好' })
    expect(seen).toEqual([{ type: 'user/message', content: '你好' }])

    off()
  })

  it('退订后不再收到事件', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    let count = 0
    const off = store.subscribe(id, () => {
      count += 1
    })

    await store.append(id, { type: 'turn/start', turnNo: 1 })
    off()
    await store.append(id, { type: 'turn/end', turnNo: 1 })
    expect(count).toBe(1)
  })

  it('单个订阅者抛错：不影响 append、其余订阅者照收（onError 收到错误）', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    const seen: string[] = []
    store.subscribe(id, () => {
      throw new Error('listener boom')
    })
    store.subscribe(id, (e) => seen.push(e.type))

    await expect(store.append(id, { type: 'user/message', content: 'x' })).resolves.toBeUndefined()
    expect(seen).toEqual(['user/message'])
    expect(listenerErrors).toHaveLength(1)
  })

  it('订阅未打开的会话 → not_found（不懒订阅）', () => {
    const store = makeStore()
    expect(() => store.subscribe('nope', () => {})).toThrow(SessionError)
  })

  it('旧退订句柄不影响重新注册的同一函数（review Y5）', async () => {
    // 回归：原实现按函数身份删，旧句柄会把"退订后重新订阅"的新订阅一起删掉
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    let hits = 0
    const fn = (): void => {
      hits += 1
    }
    const off = store.subscribe(id, fn)
    off()
    store.subscribe(id, fn)
    off() // 旧句柄再调一次：幂等，不得删掉新订阅

    await store.append(id, { type: 'turn/start', turnNo: 1 })
    expect(hits).toBe(1)
  })

  it('async 订阅者抛错：经 onError 记录，不逃逸为 unhandledRejection（review Y6）', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    const escaped: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      escaped.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    // 签名返回 void，但 TS 允许 async 函数：错误不会进同步 try/catch
    store.subscribe(id, (async () => {
      throw new Error('async listener boom')
    }) as unknown as SessionListener)

    await store.append(id, { type: 'turn/start', turnNo: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    process.off('unhandledRejection', onUnhandled)

    expect(listenerErrors).toHaveLength(1)
    expect(escaped).toHaveLength(0)
  })
})

describe('list', () => {
  it('按 createdAt 降序，并跳过损坏的会话目录', async () => {
    const headerOf = (id: string, createdAt: string): string =>
      JSON.stringify({ type: 'session/header', id, createdAt, provider: 'p', model: 'm', cwd: '.' })
    await writeRaw('s-old', [headerOf('s-old', '2026-01-01T00:00:00.000Z')])
    await writeRaw('s-new', [headerOf('s-new', '2026-01-02T00:00:00.000Z')])
    await fs.mkdir(path.join(dir, 's-broken'), { recursive: true }) // 目录里没有 session.jsonl

    const metas = await makeStore().list()
    expect(metas.map((m) => m.id)).toEqual(['s-new', 's-old'])
    expect(warns.some((w) => w.includes('s-broken'))).toBe(true)
  })

  it('根目录不存在（还没有任何会话）→ 空列表，不抛错', async () => {
    const store = createJsonlSessionStore({ dir: path.join(dir, 'not-created-yet') })
    expect(await store.list()).toEqual([])
  })

  it('目录被人工重命名后，list 返回的 id 仍可 open（review Y4）', async () => {
    // 回归：原先 list 回 header 里的 id，而 open 按目录名拼路径——重命名后
    // "列表里看得见、打不开"。存储键（目录名）才是可操作键
    const store = makeStore()
    await writeRaw('renamed', [
      JSON.stringify({
        type: 'session/header',
        id: 'original',
        createdAt: '2026-10-17T00:00:00.000Z',
        provider: 'p',
        model: 'm',
        cwd: '.',
      }),
    ])

    const metas = await store.list()
    expect(metas.map((m) => m.id)).toEqual(['renamed'])
    await expect(store.open(metas[0]!.id)).resolves.toMatchObject({ id: 'renamed' })
  })
})

describe('settled / clear', () => {
  it('clear 清空内存（订阅与缓存都失效），但不删文件', async () => {
    const store = makeStore(fixed)
    const { id } = await store.create(init)
    store.clear()

    // 磁盘仍在：open 会重新载入，只是内存里的订阅没了
    expect(() => store.subscribe(id, () => {})).toThrow(SessionError)
    await expect(store.open(id)).resolves.toMatchObject({ id: 'fixed-id' })
  })

  it('settled() 可在无写入时安全调用', async () => {
    const store = makeStore()
    await expect(store.settled()).resolves.toBeUndefined()
  })
})
