import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config, Ctx, Plugin, PluginEntry, PluginFactory, Unsubscribe } from '../contracts.js'
import { BootError } from '../errors.js'
import { boot, registerBuiltin, shutdown } from './boot.js'

/* ============================================================
 * 测试基建
 * ============================================================ */

/** 最小合法 config（设计 §4.3：冒烟测试用组合根内硬编码的最小 config）。 */
function makeConfig(plugins: PluginEntry[]): Config {
  return {
    model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    contextWindow: 131072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120_000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    permissions: { bash: 'ask' },
    plugins,
  }
}

/** 测试内注册的临时 builtin（afterEach 统一退订，避免污染模块级 builtin 表）。 */
const unregisterBuiltins: Unsubscribe[] = []
function addBuiltin(name: string, factory: PluginFactory): PluginEntry {
  unregisterBuiltins.push(registerBuiltin(name, factory))
  return { source: `builtin:${name}` }
}
afterEach(() => {
  for (const off of unregisterBuiltins) off()
  unregisterBuiltins.length = 0
})

/** 临时 fixture 目录（os.tmpdir 下，测试后统一清理）。 */
let tmpDir: string
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidsh-m0-'))
})
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** 写入一个 fixture 插件文件，返回绝对路径。 */
async function writeFixture(rel: string, content: string): Promise<string> {
  const file = path.join(tmpDir, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
  return file
}

/** 可观测插件：记录 setup / dispose 调用顺序；给定 disposeImpl 则带 dispose 钩子。 */
function tracer(name: string, log: string[], disposeImpl?: () => void | Promise<void>): Plugin {
  return {
    name,
    setup: async () => {
      log.push(`setup:${name}`)
    },
    dispose: disposeImpl
      ? async () => {
          log.push(`dispose:${name}`)
          await disposeImpl()
        }
      : undefined,
  }
}

/* ============================================================
 * boot
 * ============================================================ */

describe('boot', () => {
  it('按 config.plugins 数组顺序挂载，plugin/mounted 事件按序广播', async () => {
    const mountedNames: string[] = []
    // 首个插件在 setup 内监听 plugin/mounted，可收到包括自身在内的全部事件
    const a = addBuiltin('order-a', () => ({
      name: 'a',
      setup: (ctx: Ctx) => {
        ctx.events.on('plugin/mounted', ({ name }) => mountedNames.push(name))
      },
    }))
    const b = addBuiltin('order-b', () => ({ name: 'b', setup: () => {} }))
    const c = addBuiltin('order-c', () => ({ name: 'c', setup: () => {} }))

    const ctx = await boot(makeConfig([a, b, c]))
    expect(mountedNames).toEqual(['a', 'b', 'c'])
    // boot 正常完成后进程级取消信号未被触发（触发逻辑归 07）
    expect(ctx.signal.aborted).toBe(false)
    await shutdown(ctx)
  })

  it('entry.config 冻结后作为 setup 第二参注入；未提供时为 undefined', async () => {
    const received: unknown[] = []
    const entry1 = addBuiltin('cfg', () => ({
      name: 'cfg',
      setup: (_ctx: Ctx, config?: unknown) => {
        received.push(config)
      },
    }))
    const ctx1 = await boot(makeConfig([{ ...entry1, config: { x: 1 } }]))
    expect(received[0]).toEqual({ x: 1 })
    await shutdown(ctx1)

    const entry2 = addBuiltin('cfg2', () => ({
      name: 'cfg2',
      setup: (_ctx: Ctx, config?: unknown) => {
        received.push(config)
      },
    }))
    const ctx2 = await boot(makeConfig([entry2]))
    expect(received[1]).toBeUndefined()
    await shutdown(ctx2)
  })

  it('setup 抛错：逆序 dispose（含半失败者）再抛 BootError，名单不含失败者，后续插件不再执行', async () => {
    const log: string[] = []
    let captured: Ctx | undefined
    const a = addBuiltin('leaf-a', () => tracer('a', log, () => {}))
    const b = addBuiltin('leaf-b', () => tracer('b', log, () => {}))
    const c = addBuiltin('leaf-c', () => ({
      name: 'c',
      // setup 内先捕获 ctx，供测试断言失败清理后的 signal 状态（R3 决议含 abort）
      setup: (ctx: Ctx) => {
        captured = ctx
        throw new Error('setup boom')
      },
      dispose: () => {
        // X5：半失败者同样被 dispose（它可能已在 setup 中拉起外部资源）
        log.push('dispose:c')
      },
    }))
    const d = addBuiltin('leaf-d', () => tracer('d', log))

    let err: unknown
    try {
      await boot(makeConfig([a, b, c, d]))
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(BootError)
    const bootErr = err as BootError
    // 名单只含已成功挂载的 a、b——半失败者 c 不在名单内
    expect(bootErr.mounted).toEqual(['a', 'b'])
    // 逆序清理：c（半失败者，最后挂载）先清理，再 b、a（X5）
    expect(log).toEqual(['setup:a', 'setup:b', 'dispose:c', 'dispose:b', 'dispose:a'])
    // 失败清理含 abort（R3 决议）；后续插件 d 的 setup 未执行
    expect(captured?.signal.aborted).toBe(true)
    expect(log).not.toContain('setup:d')
  })

  it('factory() 返回非插件（漏 return / 导出任意值）：抛 BootError 而非 TypeError，且已挂载者仍被清理', async () => {
    // 回归：若不做形状校验，plugin.setup 与失败路径里的 plugin.name 会二次抛 TypeError，
    // 绕过 failBoot —— 既不是 BootError，也不会清理已挂载插件（实测过的 bug）
    const log: string[] = []
    const a = addBuiltin('shape-a', () => tracer('a', log, () => {}))
    const bad = addBuiltin('shape-bad', () => undefined as unknown as Plugin)

    let err: unknown
    try {
      await boot(makeConfig([a, bad]))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BootError)
    expect((err as BootError).mounted).toEqual(['a'])
    expect((err as Error).message).toContain('did not return a plugin')
    expect(log).toEqual(['setup:a', 'dispose:a'])
  })

  it('registerBuiltin 重复注册抛错；退订句柄移除表项', async () => {
    const off = registerBuiltin('dup-name', () => ({ name: 'dup', setup: () => {} }))
    expect(() => registerBuiltin('dup-name', () => ({ name: 'dup2', setup: () => {} }))).toThrow(/already registered/)
    off()
    // 退订后 builtin 名不再命中（表项已移除）
    await expect(boot(makeConfig([{ source: 'builtin:dup-name' }]))).rejects.toThrow(/not found/)
  })

  it('旧退订句柄不删除同名重注册的新工厂（review Y8）', async () => {
    // 回归：原实现按名称无条件 delete，旧句柄会把后来注册的工厂一起删掉
    const first: PluginFactory = () => ({ name: 'stale-1', setup: () => {} })
    const offFirst = registerBuiltin('stale-name', first)
    offFirst()
    const second: PluginFactory = () => ({ name: 'stale-2', setup: () => {} })
    unregisterBuiltins.push(registerBuiltin('stale-name', second))
    offFirst() // 旧句柄再调一次：幂等

    const ctx = await boot(makeConfig([{ source: 'builtin:stale-name' }]))
    expect(ctx).toBeDefined() // 新工厂仍在表里，能正常挂载
    await shutdown(ctx)
  })

  it('factory() 抛错：同样先清理已挂载插件再抛 BootError', async () => {
    const log: string[] = []
    const a = addBuiltin('f-a', () => tracer('a', log, () => {}))
    const bad = addBuiltin('f-bad', () => {
      throw new Error('factory boom')
    })

    await expect(boot(makeConfig([a, bad]))).rejects.toThrow(BootError)
    expect(log).toEqual(['setup:a', 'dispose:a'])
  })

  it('builtin 未命中抛 BootError（mounted 为空表）', async () => {
    await expect(boot(makeConfig([{ source: 'builtin:no-such-plugin' }]))).rejects.toThrow(/not found/)
  })

  it('路径 import 失败抛 BootError', async () => {
    await expect(boot(makeConfig([{ source: './no/such/file.mjs' }]))).rejects.toThrow(/failed to import/)
  })

  it('default 导出不是函数抛 BootError（无 default / default 非 factory）', async () => {
    const noDefault = await writeFixture('no-default.mjs', 'export const x = 1\n')
    await expect(boot(makeConfig([{ source: noDefault }]))).rejects.toThrow(/no default factory export/)

    const notFn = await writeFixture('not-fn.mjs', 'export default 42\n')
    await expect(boot(makeConfig([{ source: notFn }]))).rejects.toThrow(/no default factory export/)
  })

  it('插件路径按 cwd 解析（非 boot.ts 所在目录）并转 file:// URL 加载', async () => {
    // fixture 写在 cwd 下的临时目录；若按 boot.ts 所在目录解析则必然找不到
    const relDir = '.tmp-boot-cwd-fixture'
    const file = path.join(process.cwd(), relDir, 'plugin.mjs')
    await fs.mkdir(path.join(process.cwd(), relDir), { recursive: true })
    await fs.writeFile(file, "export default () => ({ name: 'cwd-toy', setup() {} })\n", 'utf8')
    try {
      const ctx = await boot(makeConfig([{ source: `${relDir}/plugin.mjs` }]))
      expect(ctx.prompt.render()).toBe('') // 挂载成功即已证明路径解析正确
      await shutdown(ctx)
    } finally {
      await fs.rm(path.join(process.cwd(), relDir), { recursive: true, force: true })
    }
  })

  it('config 经 deepFreeze：顶层与 plugins[].config 的写均在 strict 模式抛 TypeError', async () => {
    const entry = addBuiltin('frozen', () => ({ name: 'frozen', setup: () => {} }))
    const config = makeConfig([{ ...entry, config: { x: 1 } }])
    const ctx = await boot(config)

    expect(() => {
      config.contextWindow = 99
    }).toThrow(TypeError)
    expect(() => {
      config.plugins.push({ source: 'late' })
    }).toThrow(TypeError)
    expect(() => {
      ;(config.plugins[0]!.config as Record<string, unknown>).x = 2
    }).toThrow(TypeError)
    await shutdown(ctx)
  })
})

/* ============================================================
 * shutdown
 * ============================================================ */

describe('shutdown', () => {
  it('按挂载逆序调用 dispose：缺 dispose 的跳过，dispose 抛错不影响后续，最后触发 signal', async () => {
    const log: string[] = []
    const a = addBuiltin('sd-a', () => tracer('a', log, () => {}))
    const b = addBuiltin('sd-b', () => tracer('b', log)) // 无 dispose
    const c = addBuiltin('sd-c', () =>
      tracer('c', log, async () => {
        throw new Error('dispose boom')
      }),
    )

    const ctx = await boot(makeConfig([a, b, c]))
    expect(ctx.signal.aborted).toBe(false)
    await shutdown(ctx)

    // c（抛错，只记 log）先于 a 被调用；b 无 dispose 被跳过
    expect(log).toEqual(['setup:a', 'setup:b', 'setup:c', 'dispose:c', 'dispose:a'])
    expect(ctx.signal.aborted).toBe(true)
  })

  it('shutdown 幂等：重复调用不再触发第二轮 dispose（07 退出路径与信号路径可能各调一次）', async () => {
    const log: string[] = []
    const a = addBuiltin('idem-a', () => tracer('a', log, () => {}))
    const b = addBuiltin('idem-b', () => tracer('b', log, () => {}))

    const ctx = await boot(makeConfig([a, b]))
    await shutdown(ctx)
    const afterFirst = [...log]
    await shutdown(ctx)

    expect(afterFirst).toEqual(['setup:a', 'setup:b', 'dispose:b', 'dispose:a'])
    expect(log).toEqual(afterFirst) // 第二轮无任何新增调用
    expect(ctx.signal.aborted).toBe(true)
  })

  it('并发 shutdown 共享同一轮清理：每个插件只 dispose 一次（review Y9）', async () => {
    // 回归：原实现"结束时清空挂载序"只能覆盖串行重复调用；两个并发调用会同时
    // 拿到同一份非空数组，各 dispose 一遍
    const log: string[] = []
    const a = addBuiltin('cc-a', () => tracer('a', log, () => {}))
    const b = addBuiltin('cc-b', () => tracer('b', log, () => {}))

    const ctx = await boot(makeConfig([a, b]))
    await Promise.all([shutdown(ctx), shutdown(ctx), shutdown(ctx)])

    expect(log).toEqual(['setup:a', 'setup:b', 'dispose:b', 'dispose:a'])
  })

  it('boot 失败清理与正常 shutdown 语义一致（复用同一流程）', async () => {
    const log: string[] = []
    const a = addBuiltin('mix-a', () => tracer('a', log, () => {}))
    const bad = addBuiltin('mix-bad', () => ({ name: 'bad', setup: () => { throw new Error('boom') } }))
    await expect(boot(makeConfig([a, bad]))).rejects.toBeInstanceOf(BootError)
    expect(log).toEqual(['setup:a', 'dispose:a'])
  })
})
