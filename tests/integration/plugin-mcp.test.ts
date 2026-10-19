import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config, Ctx, PluginEntry } from '../../src/index.js'
import { boot, createToolRunner, shutdown, toToolSchemas } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { registerSessionBuiltin } from '../../src/session/index.js'
import { registerToolsBuiltin } from '../../src/tools/index.js'

/**
 * 09-plugin-mcp 集成测试（设计 §6.2）：**真实组合根 + 真实子进程**。
 *
 * fixture 为 `tests/integration/mcp-fixtures/server.mjs`（单文件四模式），
 * 用 `process.execPath` 拉起——spawn / 行分帧 / 握手 / 关闭全部走真实链路，
 * 不 mock 任何内部实现。七条链路：本地路径加载 / 端到端调用 / 权限门 /
 * 取消 / isError / 启动失败（tolerate）/ dispose。
 *
 * 时序纪律：凡"server 做了什么"一律**等标记文件**（`--mark=`），不 sleep
 * 等时间（06 Y4 / 05 Y5 / 05 Y8 的教训）。
 */

/** 插件 TS 源的绝对路径（resolveFactory 对绝对路径原样采用；生产指向 dist 产物）。 */
const PLUGIN_SOURCE = path.resolve(import.meta.dirname, '../../plugins/mcp/index.ts')
/** fixture server 的绝对路径。 */
const FIXTURE = path.resolve(import.meta.dirname, 'mcp-fixtures/server.mjs')

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []
let workDir: string
let sessionsDir: string
/** 本轮用例的标记文件路径（fixture 把 `pid:` / `called:` / `cancelled` 写进来）。 */
let markFile: string

/** 构造一个指向 fixture 的 server 规格。 */
function fixtureServer(mode: string, extra: Record<string, unknown> = {}): {
  command: string
  args: string[]
  startupTimeoutMs: number
} & Record<string, unknown> {
  return {
    command: process.execPath,
    args: [FIXTURE, `--mode=${mode}`, `--mark=${markFile}`],
    startupTimeoutMs: 15_000,
    ...extra,
  }
}

function basePlugins(mcpConfig: unknown): PluginEntry[] {
  return [
    { source: 'builtin:session', config: { dir: sessionsDir } },
    { source: 'builtin:prompt' },
    { source: 'builtin:tools' },
    { source: PLUGIN_SOURCE, config: mcpConfig },
  ]
}

async function bootAll(
  mcpConfig: unknown,
  permissions: Config['permissions'] = {},
): Promise<Ctx> {
  unsubscribes.push(registerSessionBuiltin(), registerPromptBuiltin(), registerToolsBuiltin())
  const config = createDefaultConfig()
  config.plugins = basePlugins(mcpConfig)
  config.permissions = permissions
  const ctx = await boot(config)
  contexts.push(ctx)
  return ctx
}

function runContext(sessionId: string, signal = new AbortController().signal): {
  sessionId: string
  turnNo: number
  stepNo: number
  signal: AbortSignal
} {
  return { sessionId, turnNo: 1, stepNo: 1, signal }
}

/** 读标记文件内容（不存在返回空串）。 */
async function readMark(): Promise<string> {
  try {
    return await fs.readFile(markFile, 'utf8')
  } catch {
    return ''
  }
}

/** 轮询等待标记文件出现以指定标签开头的行（等事件，不等时间）。 */
async function waitForMark(label: string, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const content = await readMark()
    if (content.split('\n').some((l) => l.startsWith(label))) return content
    if (Date.now() > deadline) throw new Error(`等待标记 "${label}" 超时（当前内容：${content}）`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-mcp-it-'))
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-mcp-it-sessions-'))
  markFile = path.join(workDir, 'mark.log')
})

afterEach(async () => {
  for (const ctx of contexts) await shutdown(ctx)
  contexts.length = 0
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
  await fs.rm(workDir, { recursive: true, force: true })
  await fs.rm(sessionsDir, { recursive: true, force: true })
})

describe('09-plugin-mcp 集成', () => {
  it('链路 1 · 本地路径加载：import() 挂载成功，工具进表、进模型可见面、进系统提示', async () => {
    const ctx = await bootAll({ servers: { demo: fixtureServer('echo') } })

    // 工具注册进 05 的同一张表（05 §8 附则：register 即享有管道）
    const names = ctx.tools.list().map((t) => t.name)
    expect(names).toContain('mcp__demo__echo')
    expect(names).toContain('mcp__demo__boom')

    // 模型可见面：toToolSchemas 含 MCP 工具（06 每 step 现场取）
    const schemas = toToolSchemas(ctx.tools.list())
    const echo = schemas.find((s) => s.name === 'mcp__demo__echo')
    expect(echo?.description).toBe('原样返回参数中的 text')
    expect(echo?.schema.required).toEqual(['text'])

    // 05 的 tools/catalog 段惰性承载 MCP 工具（D4：不注册自有段）
    const text = ctx.prompt.render()
    expect(text).toContain('mcp__demo__echo')
    expect(text).toContain('# 工作准则')
  }, 20_000)

  it('链路 2 · 端到端调用：经完整管道执行、结果正确且入 log、server 确被调用', async () => {
    const ctx = await bootAll(
      { servers: { demo: fixtureServer('echo') } },
      { 'mcp__*': 'auto' },
    )
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    const runner = createToolRunner(ctx, { approve: async () => true })
    const result = await runner.run(
      { id: 'call_mcp_1', name: 'mcp__demo__echo', arguments: JSON.stringify({ text: '你好 MCP' }) },
      runContext(session.id),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toBe('echo:你好 MCP')
    // server 真的被调用了（标记判据，05 Y8 的防空断言经验）
    expect(await waitForMark('called:echo')).toContain('pid:')
    // 结果入 session log（灵魂 #2：模型可见事实可追溯）
    const events = await ctx.sessions.read(session.id)
    const toolResults = events.filter((e) => e.type === 'tool/result')
    expect(toolResults).toHaveLength(1)
  }, 20_000)

  it('链路 3 · 权限门：mcp__* 为 ask 且无审批通道 ⇒ 失败关闭，server 未被调用', async () => {
    const ctx = await bootAll(
      { servers: { demo: fixtureServer('echo') } },
      { 'mcp__*': 'ask' },
    )
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    // 不传 approve：模拟无审批通道的宿主（05 PB-02② 的失败关闭）
    const runner = createToolRunner(ctx)
    const result = await runner.run(
      { id: 'call_mcp_2', name: 'mcp__demo__echo', arguments: JSON.stringify({ text: '不该执行' }) },
      runContext(session.id),
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('permission_denied')
    // server 侧零调用痕迹（只应有 pid 启动行，没有任何 called: 行）
    const content = await waitForMark('pid:')
    expect(content).not.toContain('called:')
  }, 20_000)

  it('链路 4 · 取消：回合信号 abort ⇒ 结果为 cancelled，server 收到 notifications/cancelled', async () => {
    const ctx = await bootAll(
      { servers: { demo: fixtureServer('slow') } },
      { 'mcp__*': 'auto' },
    )
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    const runner = createToolRunner(ctx, { approve: async () => true })
    const controller = new AbortController()
    const pending = runner.run(
      { id: 'call_mcp_3', name: 'mcp__demo__sleep', arguments: JSON.stringify({}) },
      runContext(session.id, controller.signal),
    )
    // 等 server 确实收到调用再取消（否则取消可能发生在请求发出之前）
    await waitForMark('called:sleep')
    controller.abort()

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('cancelled')
    // 取消通知送达 server（Q8：给它中止长任务的机会）
    await waitForMark('cancelled')
  }, 20_000)

  it('链路 5 · isError：server 明示失败 ⇒ execution_error，消息来自 server 文本', async () => {
    const ctx = await bootAll(
      { servers: { demo: fixtureServer('echo') } },
      { 'mcp__*': 'auto' },
    )
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    const runner = createToolRunner(ctx, { approve: async () => true })
    const result = await runner.run(
      { id: 'call_mcp_4', name: 'mcp__demo__boom', arguments: JSON.stringify({}) },
      runContext(session.id),
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('execution_error')
    expect(result.content).toContain('故意失败')
    expect(await waitForMark('called:boom')).toBeTruthy()
  }, 20_000)

  it('链路 6 · 启动失败（tolerate）：坏命令 / crash / notools 三种形态都不拖垮 boot', async () => {
    const ctx = await bootAll({
      onStartupError: 'tolerate',
      servers: {
        missing: { command: 'definitely-missing-command-mdsh', startupTimeoutMs: 2_000 },
        crash: fixtureServer('crash'),
        notools: fixtureServer('notools'),
      },
    })

    const names = ctx.tools.list().map((t) => t.name)
    // 三个 server 均零工具，但没有一个让 boot 失败（其余链路照常）
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual([])
    expect(ctx.prompt.render()).toContain('# 工作准则')
    // crash 模式确实"活着退场"（标记判据）
    await waitForMark('crashed')
  }, 20_000)

  it('链路 7 · dispose：shutdown 后 fixture 子进程确实退出', async () => {
    const ctx = await bootAll({ servers: { demo: fixtureServer('echo') } })
    const content = await waitForMark('pid:')
    const pid = Number(content.split('\n').find((l) => l.startsWith('pid:'))?.slice('pid:'.length))
    expect(Number.isInteger(pid)).toBe(true)

    await shutdown(ctx)
    contexts.length = 0 // afterEach 不再重复 shutdown（幂等，但断言要精确）

    // 进程已死：kill(pid, 0) 只探活不发送信号，死 pid 抛 ESRCH
    await expect(
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 3_000
        const probe = (): void => {
          try {
            process.kill(pid, 0)
            if (Date.now() > deadline) reject(new Error(`pid ${pid} 3s 后仍存活`))
            else setTimeout(probe, 50)
          } catch {
            resolve(undefined)
          }
        }
        probe()
      }),
    ).resolves.toBeUndefined()
  }, 20_000)
})
