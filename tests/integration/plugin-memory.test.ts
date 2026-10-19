import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config, Ctx, PluginEntry } from '../../src/index.js'
import { boot, createToolRunner, shutdown } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { registerSessionBuiltin } from '../../src/session/index.js'
import { registerToolsBuiltin } from '../../src/tools/index.js'

/**
 * 08-plugin-memory 集成测试（设计 §6.2）：**真实组合根 + 真实 fs**。
 *
 * 四条链路：本地路径加载（本模块的核心验证——首个非 builtin 插件）/
 * 写入即见（工具经完整管道执行，下个 render 惰性可见）/ 权限门（ask 无审批
 * 通道时失败关闭）/ 空文件（段整体消失）。
 *
 * 插件经 `source` 指向 TS 源文件加载：测试运行在 vite-node 下，boot 的
 * 动态 `import()` 可解析 `.ts`；生产环境则指向编译产物 `dist/plugins/memory/index.js`。
 */

/** 插件 TS 源的绝对路径（resolveFactory 对绝对路径原样采用）。 */
const PLUGIN_SOURCE = path.resolve(import.meta.dirname, '../../plugins/memory/index.ts')

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []
let workDir: string
let sessionsDir: string
let memoryFile: string

function basePlugins(): PluginEntry[] {
  return [
    { source: 'builtin:session', config: { dir: sessionsDir } },
    { source: 'builtin:prompt' },
    { source: 'builtin:tools' },
    { source: PLUGIN_SOURCE, config: { file: memoryFile } },
  ]
}

async function bootAll(permissions: Config['permissions'] = {}): Promise<Ctx> {
  unsubscribes.push(registerSessionBuiltin(), registerPromptBuiltin(), registerToolsBuiltin())
  const config = createDefaultConfig()
  config.plugins = basePlugins()
  config.permissions = permissions
  const ctx = await boot(config)
  contexts.push(ctx)
  return ctx
}

function runContext(sessionId: string): { sessionId: string; turnNo: number; stepNo: number; signal: AbortSignal } {
  return { sessionId, turnNo: 1, stepNo: 1, signal: new AbortController().signal }
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-mem-it-'))
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-mem-it-sessions-'))
  memoryFile = path.join(workDir, 'memory', 'MEMORY.md')
})

afterEach(async () => {
  for (const ctx of contexts) await shutdown(ctx)
  contexts.length = 0
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
  await fs.rm(workDir, { recursive: true, force: true })
  await fs.rm(sessionsDir, { recursive: true, force: true })
})

describe('08-plugin-memory 集成', () => {
  it('链路 1 · 本地路径加载：import() 挂载成功，段与工具就位，无记忆文件时段消失', async () => {
    const ctx = await bootAll()

    // 工具注册进同一张表（05 §8 附则：register 即享有管道）
    expect(ctx.tools.get('memory').name).toBe('memory')
    // 记忆文件不存在：render 不含记忆段（连引导语都不输出），其余段不受影响
    const text = ctx.prompt.render()
    expect(text).not.toContain('# 记忆')
    expect(text).toContain('# 工作准则')
  })

  it('链路 2 · 写入即见：工具经管道执行落盘、结果入 log，下一次 render 惰性可见', async () => {
    const ctx = await bootAll({ memory: 'auto' })
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    const runner = createToolRunner(ctx, { approve: async () => true })
    const result = await runner.run(
      { id: 'call_mem_1', name: 'memory', arguments: JSON.stringify({ content: '- 2026-10-19 项目约定：中文注释' }) },
      runContext(session.id),
    )

    expect(result.ok).toBe(true)
    expect(await fs.readFile(memoryFile, 'utf8')).toBe('- 2026-10-19 项目约定：中文注释\n')

    // 写入事实入 session log（灵魂 #2：可追溯）
    const events = await ctx.sessions.read(session.id)
    expect(events.filter((e) => e.type === 'tool/result')).toHaveLength(1)

    // 惰性读取：同一个段的下一次 render 即含新条目（设计 §4.2）
    expect(ctx.prompt.render()).toContain('- 2026-10-19 项目约定：中文注释')
  })

  it('链路 3 · 权限门：ask 且无审批通道时失败关闭，文件不被写', async () => {
    const ctx = await bootAll({ memory: 'ask' })
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    // 不传 approve：模拟无审批通道的宿主（05 PB-02② 的失败关闭）
    const runner = createToolRunner(ctx)
    const result = await runner.run(
      { id: 'call_mem_2', name: 'memory', arguments: JSON.stringify({ content: '不该落盘' }) },
      runContext(session.id),
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('permission_denied')
    await expect(fs.stat(memoryFile)).rejects.toThrow()
    // 拒绝结果同样入 log
    const events = await ctx.sessions.read(session.id)
    expect(events.filter((e) => e.type === 'tool/result')).toHaveLength(1)
  })

  it('链路 4 · 空文件：文件存在但全空白时段整体消失', async () => {
    await fs.mkdir(path.dirname(memoryFile), { recursive: true })
    await fs.writeFile(memoryFile, '  \n\n', 'utf8')
    const ctx = await bootAll()
    expect(ctx.prompt.render()).not.toContain('# 记忆')
  })
})
