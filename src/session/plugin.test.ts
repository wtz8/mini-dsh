import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Ctx, SessionEvent } from '../contracts.js'
import { createSessionPlugin } from './plugin.js'
import type { JsonlSessionStore } from './types.js'

/**
 * `builtin:session` 插件（设计 §4.5）：薄适配层——构造 store、注入 `ctx.sessions`、
 * 把事件与日志接到总线/日志器上。这里用伪 ctx 验证"接线"，真实组合根链路见集成测试。
 */

let dir: string

interface FakeCtx {
  ctx: Ctx
  mounted: () => JsonlSessionStore | undefined
  emits: Array<{ type: string; payload: unknown }>
  warns: string[]
  errors: unknown[]
}

function fakeCtx(): FakeCtx {
  const emits: Array<{ type: string; payload: unknown }> = []
  const warns: string[] = []
  const errors: unknown[] = []
  let store: JsonlSessionStore | undefined

  const ctx = {
    events: {
      emit: (type: string, payload: unknown) => emits.push({ type, payload }),
      on: () => () => {},
      onWaterfall: () => () => {},
      waterfall: async (_type: string, payload: unknown) => payload,
    },
    sessions: {
      mount: (impl: JsonlSessionStore) => {
        store = impl
      },
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: (_m: string, err: unknown) => errors.push(err),
    },
  } as unknown as Ctx

  return { ctx, mounted: () => store, emits, warns, errors }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-session-plugin-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createSessionPlugin', () => {
  it('插件名固定为 builtin:session', async () => {
    const factory = createSessionPlugin({ dir })
    const plugin = await factory()
    expect(plugin.name).toBe('builtin:session')
  })

  it('setup 向 ctx.sessions 注入实现（mount 生效）', async () => {
    const fake = fakeCtx()
    const plugin = await createSessionPlugin({ dir })()
    await plugin.setup(fake.ctx, undefined)

    const store = fake.mounted()
    expect(store).toBeDefined()
    const session = await store?.create({ provider: 'p', model: 'm', cwd: '.' })
    expect(session?.id).toBeTruthy()
  })

  it('append 后经 onAppend 把事件转成 session/append 总线载荷', async () => {
    const fake = fakeCtx()
    const plugin = await createSessionPlugin({ dir })()
    await plugin.setup(fake.ctx, undefined)

    const store = fake.mounted()
    const event: SessionEvent = { type: 'user/message', content: '接线检查' }
    const session = await store!.create({ provider: 'p', model: 'm', cwd: '.' })
    await store!.append(session.id, event)

    expect(fake.emits).toEqual([{ type: 'session/append', payload: { sessionId: session.id, event } }])
  })

  it('实例配置 plugins[].config.dir 可覆盖目录（相对路径按 cwd 解析）', async () => {
    const fake = fakeCtx()
    const plugin = await createSessionPlugin()()
    await plugin.setup(fake.ctx, { dir: dir })

    const session = await fake.mounted()!.create({ provider: 'p', model: 'm', cwd: '.' })
    await fake.mounted()!.append(session.id, { type: 'turn/start', turnNo: 1 })
    // 文件真的落在注入的目录里
    const entries = await fs.readdir(dir)
    expect(entries).toContain(session.id)
  })

  it('实例配置 dir 非法（空串 / 非字符串）→ setup 抛错（组合根转 BootError）', async () => {
    const fake = fakeCtx()
    const plugin = await createSessionPlugin()()
    // setup 是同步的（无 IO），配置非法时同步抛错；boot 的 try/catch 同样会转成 BootError
    expect(() => plugin.setup(fake.ctx, { dir: '  ' })).toThrow(/non-empty string/)
    expect(() => plugin.setup(fake.ctx, { dir: 42 })).toThrow(/non-empty string/)
  })

  it('dispose 容忍 setup 未完成（内核 X5 约定），且在挂载后能清内存', async () => {
    // 未 setup 就 dispose：不得抛错（boot 失败清理路径会走到）
    const unmounted = await createSessionPlugin({ dir })()
    await expect(unmounted.dispose?.()).resolves.toBeUndefined()

    const fake = fakeCtx()
    const plugin = await createSessionPlugin({ dir })()
    await plugin.setup(fake.ctx, undefined)
    const session = await fake.mounted()!.create({ provider: 'p', model: 'm', cwd: '.' })
    await plugin.dispose?.()
    // 缓存已清：订阅同一个会话要先从磁盘重新载入
    expect(() => fake.mounted()!.subscribe(session.id, () => {})).toThrow()
  })
})
