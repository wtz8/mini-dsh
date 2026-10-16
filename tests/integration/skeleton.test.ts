import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

import { boot, shutdown } from '../../src/index.js'
import type { Config, Ctx } from '../../src/index.js'
import { BootError } from '../../src/index.js'

/**
 * M0 骨架集成测试（设计 §6.2）：以**真实组合根**驱动全链路，不 mock 内核。
 * fixture 插件为真实 .mjs 文件，放在 tests/integration/fixtures/ 下随测试生成与清理。
 * fixture 与测试通过 globalThis 上的状态袋交换观测数据（同进程动态 import 的天然通道）。
 */

/** 最小合法 config（M0 冒烟测试用硬编码 config，loadConfig 归 01）。 */
function makeConfig(pluginSources: string[]): Config {
  return {
    model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    contextWindow: 131072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120_000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    permissions: { bash: 'ask' },
    plugins: pluginSources.map((source) => ({ source })),
  }
}

/** 读取 fixture 写入 globalThis 的状态袋（不存在则返回空对象）。 */
function stateOf(key: string): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[key] as Record<string, unknown>
}
function setState(key: string, value: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>)[key] = value
}

/* ============================================================
 * fixture 插件（随测试生成与清理）
 * ============================================================ */

const FIXTURES_DIR = path.join('tests', 'integration', 'fixtures')

/** 冒烟链路 toy 插件：注册 prompt section + 收发事件 + dispose 置位（设计 §4.3）。 */
const TOY_PLUGIN = `import { definePlugin } from '../../../src/index.js'

export default definePlugin(() => ({
  name: 'toy',
  setup(ctx) {
    ctx.prompt.section({ id: 'toy', order: 100, render: () => 'TOY SECTION' })
    ctx.events.on('plugin/mounted', ({ name }) => {
      globalThis.__m0Toy.mounted.push(name)
    })
  },
  dispose() {
    globalThis.__m0Toy.disposed = true
  },
}))
`

/** 双插件协作链路 · A（服务提供方）：注册 prompt section。 */
const PROVIDER_PLUGIN = `export default () => ({
  name: 'provider',
  setup(ctx) {
    ctx.prompt.section({ id: 'provider', order: 10, render: () => 'PROVIDER SECTION' })
  },
})
`

/** 双插件协作链路 · B（消费方）：仅经 ctx 消费 A 注册的服务面（无相互 import）。 */
const CONSUMER_PLUGIN = `export default () => ({
  name: 'consumer',
  setup(ctx) {
    // A 已在前序挂载，此刻应能经 ctx 消费其注册的 section
    globalThis.__m0Duo.sawProviderSection = ctx.prompt.render().includes('PROVIDER SECTION')
    ctx.events.on('plugin/mounted', ({ name }) => {
      globalThis.__m0Duo.mountedOrder.push(name)
    })
  },
})
`

/**
 * 出口面链路 · barrel 插件：从公共 API 出口（`src/index.ts`）一次性 import 多个符号，
 * 验证"插件作者一律经 index 导入"这条路真的走得通（链路 1 只用到 definePlugin）。
 */
const BARREL_PLUGIN = `import { definePlugin, BootError, ToolRejected, registerBuiltin } from '../../../src/index.js'

export default definePlugin(() => ({
  name: 'barrel',
  setup() {
    globalThis.__m0Barrel.kinds = {
      definePlugin: typeof definePlugin,
      BootError: typeof BootError,
      ToolRejected: typeof ToolRejected,
      registerBuiltin: typeof registerBuiltin,
    }
    globalThis.__m0Barrel.bootErrorIsError = new BootError('x', []).message === 'x'
  },
}))
`

/** 叶子失败链路 · 前两个正常插件（带 dispose 观测）。 */
const OK_PLUGIN = (name: string) => `export default () => ({
  name: '${name}',
  setup(ctx) {
    globalThis.__m0Fail.setupOrder.push('${name}')
    ctx.prompt.section({ id: '${name}', order: 1, render: () => '${name}' })
  },
  dispose() {
    globalThis.__m0Fail.disposeOrder.push('${name}')
  },
})
`

/** 叶子失败链路 · 第三个插件：setup 抛错（带 dispose，验证半失败者也被清理，X5）。 */
const FAILING_PLUGIN = `export default () => ({
  name: 'failing',
  setup() {
    throw new Error('failing plugin setup boom')
  },
  dispose() {
    globalThis.__m0Fail.disposeOrder.push('failing')
  },
})
`

/** 叶子失败链路 · 第四个插件：断言其 setup 永不执行。 */
const NEVER_PLUGIN = `export default () => ({
  name: 'never',
  setup() {
    globalThis.__m0Fail.neverRan = true
  },
})
`

beforeAll(async () => {
  const dir = path.resolve(process.cwd(), FIXTURES_DIR)
  await fs.mkdir(dir, { recursive: true })
  const files: Array<[name: string, content: string]> = [
    ['toy.mjs', TOY_PLUGIN],
    ['barrel.mjs', BARREL_PLUGIN],
    ['provider.mjs', PROVIDER_PLUGIN],
    ['consumer.mjs', CONSUMER_PLUGIN],
    ['fail-a.mjs', OK_PLUGIN('fail-a')],
    ['fail-b.mjs', OK_PLUGIN('fail-b')],
    ['failing.mjs', FAILING_PLUGIN],
    ['never.mjs', NEVER_PLUGIN],
  ]
  for (const [name, content] of files) {
    await fs.writeFile(path.join(dir, name), content, 'utf8')
  }
})

afterAll(async () => {
  await fs.rm(path.resolve(process.cwd(), FIXTURES_DIR), { recursive: true, force: true })
})

/** fixture 的插件来源（相对 cwd 的路径；用 path.join 保证 Windows 分隔符一致）。 */
const src = (name: string): string => path.join(FIXTURES_DIR, name)

/* ============================================================
 * 链路 1：冒烟（设计 §4.3）
 * ============================================================ */

describe('集成 · 冒烟链路', () => {
  it('toy 插件挂载 → 注册 section → render 命中 → 收到自身事件 → 未挂载服务面抛错 → dispose 被调用', async () => {
    setState('__m0Toy', { mounted: [], disposed: false })

    const ctx: Ctx = await boot(makeConfig([src('toy.mjs')]))

    // prompt section 注册后 render 命中
    expect(ctx.prompt.render()).toContain('TOY SECTION')
    // toy 在 setup 内监听，收到包括自身在内的 plugin/mounted 事件
    expect(stateOf('__m0Toy').mounted).toEqual(['toy'])
    // 03 未挂载：SessionStoreContainer 全部方法抛 'not mounted'
    await expect(ctx.sessions.append('s1', { type: 'turn/start', turnNo: 1 })).rejects.toThrow(/not mounted/)
    await expect(ctx.sessions.list()).rejects.toThrow(/not mounted/)
    // 进程级取消信号在 shutdown 前未被触发
    expect(ctx.signal.aborted).toBe(false)

    await shutdown(ctx)
    expect(stateOf('__m0Toy').disposed).toBe(true)
    expect(ctx.signal.aborted).toBe(true)
  })
})

/* ============================================================
 * 链路 2：双插件协作（插件只经 ctx 交互）
 * ============================================================ */

describe('集成 · 双插件协作链路', () => {
  it('A 注册服务面、B 经 ctx 消费，挂载顺序语义正确', async () => {
    setState('__m0Duo', { sawProviderSection: false, mountedOrder: [] })

    const ctx = await boot(makeConfig([src('provider.mjs'), src('consumer.mjs')]))

    // B 在 setup 时即可消费 A 注册的 section（数组顺序 = 挂载顺序）
    expect(stateOf('__m0Duo').sawProviderSection).toBe(true)
    // B 监听时只剩 B 自身未广播（A 的事件先于 B 的监听注册）
    expect(stateOf('__m0Duo').mountedOrder).toEqual(['consumer'])

    await shutdown(ctx)
  })
})

/* ============================================================
 * 链路 3：叶子插件失败（R3 决议的清理语义）
 * ============================================================ */

describe('集成 · 叶子插件失败链路', () => {
  it('第三个插件 setup 抛错：BootError 名单含前两个，逆序 dispose，后续插件不执行', async () => {
    setState('__m0Fail', { setupOrder: [], disposeOrder: [], neverRan: false })

    let err: unknown
    try {
      await boot(makeConfig([src('fail-a.mjs'), src('fail-b.mjs'), src('failing.mjs'), src('never.mjs')]))
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(BootError)
    const bootErr = err as BootError
    // 名单只含成功挂载的前两个，不含半失败者与未执行者
    expect(bootErr.mounted).toEqual(['fail-a', 'fail-b'])
    expect(bootErr.message).toContain('failing')
    // 逆序清理：半失败者 failing 最后挂载故最先 dispose，再 fail-b、fail-a（R3 + X5）
    expect(stateOf('__m0Fail').disposeOrder).toEqual(['failing', 'fail-b', 'fail-a'])
    // 后续插件 setup 永不执行
    expect(stateOf('__m0Fail').neverRan).toBe(false)
  })
})

/* ============================================================
 * 链路 4：本地路径加载（真实 import()，非 stub）
 * ============================================================ */

describe('集成 · 公共 API 出口链路', () => {
  it('本地插件经 src/index.js 出口 import 全部 SDK 符号（definePlugin / 错误类 / registerBuiltin）', async () => {
    setState('__m0Barrel', { kinds: {}, bootErrorIsError: false })

    // barrel.mjs 只 import 公共出口（不深引用 src/plugin/*），相对 cwd 的路径经 file:// 真实加载
    const ctx = await boot(makeConfig([src('barrel.mjs')]))
    const state = stateOf('__m0Barrel')

    expect(state.kinds).toEqual({
      definePlugin: 'function',
      BootError: 'function',
      ToolRejected: 'function',
      registerBuiltin: 'function',
    })
    // 错误类是真实可用的类（而非只拿到一个函数壳）
    expect(state.bootErrorIsError).toBe(true)

    await shutdown(ctx)
  })
})
