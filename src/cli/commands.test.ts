import type { Config, Ctx, SessionEvent, SessionMeta, ToolDefinition } from '../contracts.js'
import { describe, expect, it } from 'vitest'

import { COMMANDS, findCommand } from './commands.js'
import type { CliIO, CommandContext, ReplState } from './types.js'

/**
 * slash 命令单测（设计 §6.1 第 26–32 条）。
 *
 * 命令体只经 `CommandContext` 取用 ctx / config / io，因此这里用伪 ctx 就能测，
 * 不需要真内核。
 */

/** 一份带三值权限与三个工具的配置。 */
function config(): Config {
  return {
    model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    contextWindow: 131072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    permissions: { read: 'auto', write: 'ask', bash: 'deny' },
    plugins: [],
  }
}

function tool(name: string, concurrency?: 'parallel' | 'exclusive'): ToolDefinition {
  return {
    name,
    description: `${name} 工具`,
    schema: { type: 'object', properties: {} },
    ...(concurrency === undefined ? {} : { concurrency }),
    execute: async () => 'ok',
  }
}

interface Harness {
  cmd: CommandContext
  out: string[]
  err: string[]
}

function harness(options?: { events?: SessionEvent[]; sessionId?: string; metas?: SessionMeta[] }): Harness {
  const out: string[] = []
  const err: string[] = []
  const io: CliIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: null as never,
    isTTY: true,
  }
  const events = options?.events ?? []
  // 顺序按 `SessionStore.list()` 的契约：createdAt 降序（最新的在前）；
  // 命令层**不做二次排序**——排序契约只在 store 一处（07 Y1 / Y6）
  const metas =
    options?.metas ??
    [
      { id: 'new', createdAt: '2026-02-01T00:00:00.000Z', provider: 'deepseek', model: 'deepseek-chat', cwd: '/b' },
      { id: 'old', createdAt: '2026-01-01T00:00:00.000Z', provider: 'deepseek', model: 'deepseek-chat', cwd: '/a' },
    ]
  const ctx = {
    sessions: {
      read: async () => events,
      list: async () => [...metas],
    },
    tools: { list: () => [tool('read'), tool('write'), tool('bash', 'exclusive')] },
  } as unknown as Ctx
  const state: ReplState = {
    ctx,
    sessionId: options?.sessionId,
    exiting: false,
    lastInterruptAt: 0,
  }
  return { cmd: { ctx, config: config(), io, state }, out, err }
}

/** 取一条命令（不存在则抛，便于用例定位）。 */
function command(name: string): (typeof COMMANDS)[number] {
  const cmd = findCommand(name)
  if (!cmd) throw new Error(`missing command ${name}`)
  return cmd
}

describe('slash 命令', () => {
  it('㉖ /help 列出全部命令名与用法', async () => {
    const { cmd, out } = harness()
    const outcome = await command('help').run(cmd, '')
    expect(outcome.kind).toBe('continue')
    const text = out.join('')
    for (const cmd of COMMANDS) {
      expect(text).toContain(cmd.usage)
      expect(text).toContain(cmd.summary)
    }
  })

  it('㉗ /exit 与 /quit 都是退出', async () => {
    const first = harness()
    expect(await command('exit').run(first.cmd, '')).toEqual({ kind: 'exit' })
    const second = harness()
    expect(await command('quit').run(second.cmd, '')).toEqual({ kind: 'exit' })
  })

  it('㉘ /session 打印会话 id 与已跑回合数（按 turn/start 计数）', async () => {
    const { cmd, out } = harness({
      sessionId: 's1',
      events: [
        { type: 'session/header', id: 's1', createdAt: 'now', provider: 'p', model: 'm', cwd: '/w' },
        { type: 'turn/start', turnNo: 1 },
        { type: 'turn/end', turnNo: 1 },
        { type: 'turn/start', turnNo: 2 },
      ],
    })
    expect(await command('session').run(cmd, '')).toEqual({ kind: 'continue' })
    const text = out.join('')
    expect(text).toContain('s1')
    expect(text).toContain('已跑回合 2')
  })

  it('㉘b /session 在 id 未知时显示 unknown（不抛错）', async () => {
    const { cmd, out } = harness({ sessionId: undefined })
    expect(await command('session').run(cmd, '')).toEqual({ kind: 'continue' })
    expect(out.join('')).toContain('unknown')
  })

  it('㉙ /sessions 列出会话，最新的在前', async () => {
    const { cmd, out } = harness()
    expect(await command('sessions').run(cmd, '')).toEqual({ kind: 'continue' })
    const lines = out.join('')
    expect(lines).toContain('new')
    expect(lines).toContain('old')
    expect(lines.indexOf('new')).toBeLessThan(lines.indexOf('old'))
  })

  it('㉙b /sessions 只显示最近 10 条（多余的截断）', async () => {
    const metas: SessionMeta[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s${String(i).padStart(2, '0')}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      provider: 'deepseek',
      model: 'deepseek-chat',
      cwd: '/w',
    })).reverse() // 最新在前，与 list() 契约一致
    const { cmd, out } = harness({ metas })
    await command('sessions').run(cmd, '')
    const shown = out.join('').split('\n').filter((line) => line.trim().startsWith('s'))
    expect(shown).toHaveLength(10)
    expect(shown[0]).toContain('s11') // 最新的一条
    expect(out.join('')).not.toContain('s00')
  })

  it('㉚ /tools 展示每个工具的权限三值与 exclusive 标记', async () => {
    const { cmd, out } = harness()
    expect(await command('tools').run(cmd, '')).toEqual({ kind: 'continue' })
    const text = out.join('')
    expect(text).toContain('read · auto')
    expect(text).toContain('write · ask')
    expect(text).toContain('bash · deny · exclusive')
  })

  it('㉛ /resume 缺参数给用法提示并要求继续；带参数返回 resume', async () => {
    const empty = harness()
    expect(await command('resume').run(empty.cmd, '')).toEqual({ kind: 'continue' })
    expect(empty.err.join('')).toContain('/resume <id>')

    const withId = harness()
    expect(await command('resume').run(withId.cmd, 'abc')).toEqual({ kind: 'resume', id: 'abc' })
  })

  it('㉜ 未知命令在表里查不到（由 REPL 打印提示）', () => {
    expect(findCommand('nope')).toBeUndefined()
    expect(findCommand('help')).toBeDefined()
  })
})
