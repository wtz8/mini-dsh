import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { boot, shutdown } from '../../src/index.js'
import { BootError, ConfigError } from '../../src/index.js'
import { loadConfig, resolvePermission } from '../../src/config/index.js'

/**
 * 01-config 集成测试（设计 §6.2）：真实文件系统 + 真实组合根，不 mock `fs` 与内核。
 *
 * 四条链路：三层合并进内核、logLevel 端到端（R4 的落点）、权限策略解析、
 * 配置错误在 boot 之前失败。
 *
 * fixture 目录与 skeleton 集成测试的 `tests/integration/fixtures/` **分开**：后者在
 * `afterAll` 会整目录删除，共用会在 vitest 并行执行时互相踩踏。
 */

const FIXTURES_DIR = path.join('tests', 'integration', 'config-fixtures')

/**
 * 探针插件：把它在 setup 里"看到的"配置记录到 globalThis。
 * 这是"配置真的经 boot 进了 Ctx"而非只停留在 loadConfig 返回值里的证据。
 */
const PROBE_PLUGIN = `export default () => ({
  name: 'config-probe',
  setup(ctx, config) {
    globalThis.__m01Config.probe = {
      contextWindow: ctx.config.contextWindow,
      logLevel: ctx.config.logLevel,
      maxParallel: ctx.config.tools.maxParallel,
      provider: ctx.config.model.provider,
      permissions: ctx.config.permissions,
      frozen: Object.isFrozen(ctx.config),
      frozenInstance: Object.isFrozen(config),
      instanceConfig: config,
    }
  },
  dispose() {
    globalThis.__m01Config.disposed = true
  },
})
`

/** fixture 插件来源（相对 cwd，与 boot 的解析规则一致）。 */
const probeSource = (): string => path.join(FIXTURES_DIR, 'probe.mjs')

/**
 * 探针插件写入 globalThis 的观测状态（同进程动态 import 的天然通道，
 * fixture 是 .mjs 无法共享 TS 类型，故在此声明形状）。
 */
interface ProbeState {
  disposed: boolean
  probe?: {
    contextWindow: number
    logLevel?: string
    maxParallel: number
    provider: string
    frozen: boolean
    frozenInstance: boolean
    instanceConfig: unknown
  }
}

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidsh-it-config-'))
  tempDirs.push(dir)
  return dir
}
async function writeLayer(dir: string, name: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, name), JSON.stringify(value), 'utf8')
}

beforeAll(async () => {
  const dir = path.resolve(process.cwd(), FIXTURES_DIR)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'probe.mjs'), PROBE_PLUGIN, 'utf8')
})

afterAll(async () => {
  await fs.rm(path.resolve(process.cwd(), FIXTURES_DIR), { recursive: true, force: true })
})

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * 链路 1：三层合并 → boot → Ctx.config（含冻结归属）
 * ============================================================ */

describe('集成 · 三层合并链路', () => {
  it('全局/项目/flags 逐层合并后经 boot 进入 Ctx，且被 deepFreeze 冻结', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', {
      model: { provider: 'openai', name: 'gpt-4' },
      logLevel: 'warn',
      contextWindow: 1000,
    })
    await writeLayer(projectDir, 'minidsh.json', {
      contextWindow: 2000,
      tools: { maxParallel: 8 },
      permissions: { bash: 'auto' },
      plugins: [{ source: probeSource().replace(/\\/g, '/'), config: { probe: true } }],
    })
    ;(globalThis as Record<string, unknown>).__m01Config = { disposed: false }

    const config = await loadConfig({
      globalDir,
      projectDir,
      flags: { contextWindow: 3000 },
    })
    const ctx = await boot(config)

    // 优先级：flags > project > global > defaults
    expect(ctx.config.contextWindow).toBe(3000)
    expect(ctx.config.tools.maxParallel).toBe(8)
    expect(ctx.config.logLevel).toBe('warn')
    expect(ctx.config.model.provider).toBe('openai')
    // 默认值兜底（无人覆盖的键）
    expect(ctx.config.tools.bash.timeoutMs).toBe(120_000)
    expect(ctx.config.plugins).toHaveLength(1)

    // 插件侧看到的配置与 Ctx 一致：证明合并结果真的注入了内核
    const state = (globalThis as Record<string, unknown>).__m01Config as ProbeState
    expect(state.probe?.contextWindow).toBe(3000)
    expect(state.probe?.provider).toBe('openai')
    expect(state.probe?.frozen).toBe(true) // boot 内 deepFreeze（01 只加载）
    expect(state.probe?.frozenInstance).toBe(true) // 含 plugins[].config
    expect(state.probe?.instanceConfig).toEqual({ probe: true })

    // 冻结回归：改写 ctx.config 与实例配置都抛 TypeError
    expect(() => {
      ;(ctx.config as unknown as Record<string, unknown>).contextWindow = 1
    }).toThrow(TypeError)
    expect(() => {
      ;(ctx.config.plugins[0] as { config?: Record<string, unknown> }).config!['probe'] = false
    }).toThrow(TypeError)

    await shutdown(ctx)
    expect(state.disposed).toBe(true)
  })

  it('flags 里的插件实例配置不被 boot 反向冻结（review Y11：与调用方入参解耦）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    ;(globalThis as Record<string, unknown>).__m01Config = { disposed: false }

    // 调用方自己的对象：boot 的 deepFreeze 不得碰到它（否则调用方后续改 flags 抛 TypeError）
    const instanceConfig = { nested: { probe: true } }
    const flags = {
      plugins: [{ source: probeSource().replace(/\\/g, '/'), config: instanceConfig }],
    }
    const ctx = await boot(await loadConfig({ globalDir, projectDir, flags }))

    expect(Object.isFrozen(instanceConfig)).toBe(false)
    expect(Object.isFrozen(instanceConfig.nested)).toBe(false)
    // 内核用的是自己的副本，仍然照常冻结（插件不得改写实例配置）
    expect(Object.isFrozen(ctx.config.plugins[0]?.config)).toBe(true)
    await shutdown(ctx)
  })
})

/* ============================================================
 * 链路 2：logLevel 端到端（R4 的落点验证）
 * ============================================================ */
describe('集成 · logLevel 端到端链路', () => {
  /** 捕获 stderr 写入（Logger 的输出目标）。 */
  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write')
    spy.mockImplementation((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    return { lines, restore: () => spy.mockRestore() }
  }

  it('配置 logLevel=debug 时 debug 日志真的输出', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(projectDir, 'minidsh.json', { logLevel: 'debug' })

    const ctx = await boot(await loadConfig({ globalDir, projectDir }))
    const capture = captureStderr()
    ctx.log.debug('from config')
    capture.restore()

    expect(capture.lines).toEqual(['[debug] from config\n'])
    await shutdown(ctx)
  })

  it('未配置 logLevel 时默认 info：debug 被过滤、info 输出（R4 默认值合并归 01）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()

    const config = await loadConfig({ globalDir, projectDir })
    expect(config.logLevel).toBe('info')
    const ctx = await boot(config)

    const capture = captureStderr()
    ctx.log.debug('should be filtered')
    ctx.log.info('should be written')
    capture.restore()

    expect(capture.lines).toEqual(['[info] should be written\n'])
    await shutdown(ctx)
  })
})

/* ============================================================
 * 链路 3：权限策略链路
 * ============================================================ */

describe('集成 · 权限策略链路', () => {
  it('配置中的精确键 / 前缀通配 / 兜底在真实 config 上生效', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(projectDir, 'minidsh.json', {
      permissions: { bash: 'auto', 'mcp__*': 'deny', read: 'ask' },
    })

    const config = await loadConfig({ globalDir, projectDir })
    const ctx = await boot(config)

    // 精确键命中
    expect(resolvePermission(ctx.config.permissions, 'bash')).toBe('auto')
    expect(resolvePermission(ctx.config.permissions, 'read')).toBe('ask')
    // 前缀通配命中
    expect(resolvePermission(ctx.config.permissions, 'mcp__github')).toBe('deny')
    // 未命中 → 兜底 ask
    expect(resolvePermission(ctx.config.permissions, 'write')).toBe('ask')

    await shutdown(ctx)
  })

  it('全局层宽泛规则 + 项目层更具体规则：更具体者生效（X4 回归）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { permissions: { 'mcp__*': 'auto' } })
    await writeLayer(projectDir, 'minidsh.json', { permissions: { 'mcp__github*': 'deny' } })

    const config = await loadConfig({ globalDir, projectDir })
    const ctx = await boot(config)

    // 项目层想收紧的 github 子族必须真的收紧；其余 mcp 工具仍走全局层的 auto
    expect(resolvePermission(ctx.config.permissions, 'mcp__github_list')).toBe('deny')
    expect(resolvePermission(ctx.config.permissions, 'mcp__gitlab_x')).toBe('auto')

    await shutdown(ctx)
  })

  it('裸 "*" 键是配置错误：loadConfig 拒绝，启动在 boot 之前失败', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(projectDir, 'minidsh.json', { permissions: { '*': 'ask' } })

    const err = await loadConfig({ globalDir, projectDir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).path).toBe('config.permissions.*')
  })
})

/* ============================================================
 * 链路 4：配置错误 → 启动失败（boot 之前）
 * ============================================================ */

describe('集成 · 配置错误链路', () => {
  it('非法 JSON：ConfigError 带 file，且不进入 boot（无插件挂载）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await fs.writeFile(path.join(projectDir, 'minidsh.json'), '{"contextWindow": ', 'utf8')

    const err = await loadConfig({ globalDir, projectDir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).file).toBe(path.join(projectDir, 'minidsh.json'))
    // 与 BootError 的边界：配置错误发生在挂载之前，不带"已挂载名单"语义
    expect(err).not.toBeInstanceOf(BootError)
  })

  it('字段非法：ConfigError 带字段路径，boot 未被调用', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { contextWindow: 0 })

    const err = await loadConfig({ globalDir, projectDir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).path).toBe('config.contextWindow')
  })
})
