import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config, Ctx, PluginEntry, ToolDefinition } from '../../src/index.js'
import { boot, createToolRunner, definePlugin, deriveMessages, registerBuiltin, shutdown, toToolSchemas } from '../../src/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { registerSessionBuiltin } from '../../src/session/index.js'
import { registerToolsBuiltin } from '../../src/tools/index.js'

/**
 * 05-tools 集成测试（设计 §6.2）：**真实组合根 + 真实 fs + 真实 session 落盘**。
 *
 * 六条链路：挂载与段排序 / 端到端（结果入 log 并可投影）/ 权限门（deny 与 ask 失败关闭）/
 * 瀑布改写作用于执行对象 / 未挂载 / MCP 式动态注册。
 */

const unsubscribes: Array<() => void> = []
const contexts: Ctx[] = []
let workDir: string
let sessionsDir: string

function makeConfig(plugins: PluginEntry[], permissions: Config['permissions'] = {}): Config {
  const config = createDefaultConfig()
  config.plugins = plugins
  config.permissions = permissions
  return config
}

function basePlugins(): PluginEntry[] {
  return [
    { source: 'builtin:session', config: { dir: sessionsDir } },
    { source: 'builtin:prompt' },
    { source: 'builtin:tools' },
  ]
}

async function bootAll(plugins: PluginEntry[], permissions: Config['permissions'] = {}): Promise<Ctx> {
  unsubscribes.push(registerSessionBuiltin(), registerPromptBuiltin(), registerToolsBuiltin())
  const ctx = await boot(makeConfig(plugins, permissions))
  contexts.push(ctx)
  return ctx
}

/** 一个 run 上下文：回合/步号固定，信号独立。 */
function runContext(sessionId: string): { sessionId: string; turnNo: number; stepNo: number; signal: AbortSignal } {
  return { sessionId, turnNo: 1, stepNo: 1, signal: new AbortController().signal }
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-tools-it-'))
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-tools-sessions-'))
})

afterEach(async () => {
  for (const ctx of contexts) await shutdown(ctx)
  contexts.length = 0
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
  await fs.rm(workDir, { recursive: true, force: true })
  await fs.rm(sessionsDir, { recursive: true, force: true })
})

describe('05-tools 集成', () => {
  it('链路 1 · 挂载：六个工具注册，tools 段落在 300 与 800 之间', async () => {
    const ctx = await bootAll(basePlugins())

    expect(ctx.tools.list().map((d) => d.name)).toEqual(['read', 'write', 'edit', 'glob', 'grep', 'bash'])

    const text = ctx.prompt.render()
    expect(text).toContain('# 工具使用')
    expect(text).toContain('# 可用工具')
    expect(text).toContain('# 工作准则')
    expect(text.indexOf('# 工具使用')).toBeLessThan(text.indexOf('# 可用工具'))
    expect(text.indexOf('# 可用工具')).toBeLessThan(text.indexOf('# 工作准则'))
  })

  it('链路 2 · 端到端：结果入 session log，并能投影成配对的 tool 消息', async () => {
    const ctx = await bootAll(basePlugins(), { read: 'auto' })
    const file = path.join(workDir, 'note.txt')
    await fs.writeFile(file, 'hello from integration\n', 'utf8')

    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })
    const callId = 'call_it_1'
    await ctx.sessions.append(session.id, { type: 'turn/start', turnNo: 1 })
    await ctx.sessions.append(session.id, {
      type: 'assistant/message',
      content: '',
      toolCalls: [{ id: callId, name: 'read', arguments: JSON.stringify({ path: file }) }],
      usage: { inputTokens: 1, outputTokens: 1 },
    })

    const runner = createToolRunner(ctx, { approve: async () => true })
    const result = await runner.run({ id: callId, name: 'read', arguments: JSON.stringify({ path: file }) }, runContext(session.id))

    expect(result.ok).toBe(true)
    expect(result.content).toContain('hello from integration')

    const events = await ctx.sessions.read(session.id)
    const stored = events.filter((e) => e.type === 'tool/result')
    expect(stored).toHaveLength(1)

    const messages = deriveMessages(events)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant && assistant.role === 'assistant' ? assistant.toolCalls?.[0]?.id : undefined).toBe(callId)
    const toolMessage = messages.find((m) => m.role === 'tool')
    expect(toolMessage && toolMessage.role === 'tool' ? toolMessage.content : '').toContain('hello from integration')
  })

  it('链路 3a · deny：不执行、不审批，但仍写入 tool/result', async () => {
    const ctx = await bootAll(basePlugins(), { bash: 'deny' })
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })
    const sentinel = path.join(workDir, 'should-not-exist.txt')
    let approvals = 0

    const runner = createToolRunner(ctx, {
      approve: async () => {
        approvals += 1
        return true
      },
    })
    const result = await runner.run(
      { id: 'c1', name: 'bash', arguments: JSON.stringify({ command: `echo x > "${sentinel}"` }) },
      runContext(session.id),
    )

    expect(result.error?.code).toBe('permission_denied')
    expect(approvals).toBe(0)
    await expect(fs.access(sentinel)).rejects.toThrow()
    const events = await ctx.sessions.read(session.id)
    expect(events.filter((e) => e.type === 'tool/result')).toHaveLength(1)
  })

  it('链路 3b · ask 且无审批通道：失败关闭，文件未创建', async () => {
    const ctx = await bootAll(basePlugins(), { write: 'ask' })
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })
    const target = path.join(workDir, 'ask-target.txt')

    const runner = createToolRunner(ctx) // 不传 approve
    const result = await runner.run(
      { id: 'c2', name: 'write', arguments: JSON.stringify({ path: target, content: 'x' }) },
      runContext(session.id),
    )

    expect(result.error?.code).toBe('permission_denied')
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('链路 4 · 改写：pre-execute 换掉 path 后，实际读的是改写后的文件', async () => {
    const original = path.join(workDir, 'original.txt')
    const swapped = path.join(workDir, 'swapped.txt')
    await fs.writeFile(original, 'ORIGINAL', 'utf8')
    await fs.writeFile(swapped, 'SWAPPED', 'utf8')

    unsubscribes.push(
      registerBuiltin(
        'tools-rewriter',
        definePlugin(() => ({
          name: 'tools-rewriter',
          setup(ctx: Ctx): void {
            ctx.events.onWaterfall('tools/pre-execute', (inv) => {
              if (inv.name !== 'read') return
              return { ...inv, args: { ...inv.args, path: swapped } }
            })
          },
        })),
      ),
    )
    const ctx = await bootAll([...basePlugins(), { source: 'builtin:tools-rewriter' }], { read: 'auto' })
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    const runner = createToolRunner(ctx)
    const result = await runner.run(
      { id: 'c3', name: 'read', arguments: JSON.stringify({ path: original }) },
      runContext(session.id),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('SWAPPED')
    expect(result.content).not.toContain('ORIGINAL')
  })

  it('链路 5 · 未挂载 builtin:tools：无工具段，调用得 execution_error', async () => {
    const ctx = await bootAll([{ source: 'builtin:session', config: { dir: sessionsDir } }, { source: 'builtin:prompt' }])
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    expect(ctx.prompt.render()).not.toContain('# 可用工具')

    const runner = createToolRunner(ctx)
    const result = await runner.run({ id: 'c4', name: 'read', arguments: '{"path":"x"}' }, runContext(session.id))
    expect(result.error?.code).toBe('execution_error')
    expect(result.error?.message).toContain('unknown tool')
  })

  it('链路 6 · 动态注册（09 预演）：段、投影、管道三处同时可见', async () => {
    const ctx = await bootAll(basePlugins(), { 'mcp__*': 'auto' })
    const session = await ctx.sessions.create({ provider: 'deepseek', model: 'deepseek-chat', cwd: workDir })

    const mcpTool: ToolDefinition = {
      name: 'mcp__demo__ping',
      description: 'ping a demo MCP server',
      schema: { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'] },
      concurrency: 'parallel',
      execute: async (args) => `pong:${args['echo'] as string}`,
    }
    ctx.tools.register(mcpTool)

    expect(ctx.prompt.render()).toContain('mcp__demo__ping')
    expect(toToolSchemas(ctx.tools.list()).map((s) => s.name)).toContain('mcp__demo__ping')

    const runner = createToolRunner(ctx)
    const result = await runner.run(
      { id: 'c5', name: 'mcp__demo__ping', arguments: JSON.stringify({ echo: 'hi' }) },
      runContext(session.id),
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe('pong:hi')
  })
})
