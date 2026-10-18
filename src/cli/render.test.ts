import type { Config, Ctx, NotificationMap, ToolResult, Unsubscribe } from '../contracts.js'
import { describe, expect, it } from 'vitest'

import { attachRender, formatBanner, formatTurnSummary, oneLine } from './render.js'
import type { CliIO, ReplState } from './types.js'

/**
 * 渲染单测（设计 §6.1 第 21–25 条 / Q12）。
 *
 * 守的是三条口径：文本增量直接流出、**结果行由 `session/append(tool/result)` 驱动
 * 而非 `tool/end`**（后者早于入 log）、工具输出一律单行化截断。
 */

type Handler = (payload: unknown) => void

/** 只实现 `events` 的伪内核（渲染只订阅通知事件，不碰其它服务面）。 */
function fakeCtx(): {
  ctx: Ctx
  emit(type: keyof NotificationMap, payload: unknown): void
  count(type: keyof NotificationMap): number
} {
  const handlers = new Map<string, Handler[]>()
  const events = {
    on: (type: string, fn: Handler): Unsubscribe => {
      const list = handlers.get(type) ?? []
      list.push(fn)
      handlers.set(type, list)
      return () => {
        const current = handlers.get(type) ?? []
        const at = current.indexOf(fn)
        if (at >= 0) current.splice(at, 1)
      }
    },
  }
  return {
    ctx: { events } as unknown as Ctx,
    emit(type, payload): void {
      for (const fn of [...(handlers.get(String(type)) ?? [])]) fn(payload)
    },
    count(type): number {
      return (handlers.get(String(type)) ?? []).length
    },
  }
}

function fakeIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (text) => out.push(text), err: (text) => err.push(text), lines: null as never, isTTY: true },
    out,
    err,
  }
}

function state(ctx: Ctx): ReplState {
  return { ctx, sessionId: undefined, exiting: false, lastInterruptAt: 0 }
}

/** 构造一个 ToolResult（失败时带错误码）。 */
function result(ok: boolean, content: string, code: 'permission_denied' | 'execution_error' = 'execution_error'): ToolResult {
  return {
    callId: 'call_0',
    name: 'read',
    ok,
    content,
    ...(ok ? {} : { error: { code, message: content } }),
  }
}

function config(): Config {
  return {
    model: { provider: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    contextWindow: 131072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    permissions: {},
    plugins: [],
  }
}

describe('attachRender', () => {
  it('㉑ 文本增量直接流出；tool-call / usage / end 不产生输出', () => {
    const { ctx, emit } = fakeCtx()
    const { io, out } = fakeIO()
    attachRender(ctx, io, state(ctx))

    emit('stream/chunk', { sessionId: 's', delta: { type: 'text', delta: '你好' } })
    emit('stream/chunk', { sessionId: 's', delta: { type: 'tool-call', delta: { index: 0 } } })
    emit('stream/chunk', { sessionId: 's', delta: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } })
    emit('stream/chunk', { sessionId: 's', delta: { type: 'end' } })

    expect(out.join('')).toBe('你好')
  })

  it('㉒ 工具两行：tool/start 打"· name …"，tool/result 打结论', () => {
    const { ctx, emit } = fakeCtx()
    const { io, out } = fakeIO()
    attachRender(ctx, io, state(ctx))

    emit('tool/start', { sessionId: 's', callId: 'call_0', name: 'read' })
    emit('session/append', { sessionId: 's', event: { type: 'tool/result', toolCallId: 'call_0', result: result(true, 'ok') } })
    expect(out.join('')).toBe('\n· read …  ↳ ✓ ok\n')

    out.length = 0
    emit('tool/start', { sessionId: 's', callId: 'call_1', name: 'bash' })
    emit('session/append', {
      sessionId: 's',
      event: { type: 'tool/result', toolCallId: 'call_1', result: result(false, 'denied', 'permission_denied') },
    })
    expect(out.join('')).toContain('· bash …')
    expect(out.join('')).toContain('↳ ✗ permission_denied')
  })

  it('㉓ 超长工具输出被单行化并截断', () => {
    const { ctx, emit } = fakeCtx()
    const { io, out } = fakeIO()
    attachRender(ctx, io, state(ctx))

    const long = `${'a'.repeat(200)}\n${'b'.repeat(200)}`
    emit('tool/start', { sessionId: 's', callId: 'c', name: 'read' })
    emit('session/append', { sessionId: 's', event: { type: 'tool/result', toolCallId: 'c', result: result(true, long) } })

    const line = out.find((text) => text.includes('↳')) ?? ''
    expect(line).toHaveLength('  ↳ ✓ '.length + 120 + 1 + '\n'.length)
    expect(line).toContain('…')
    expect(line).not.toContain('\n\n')
  })

  it('㉔ session/header 只记 id，不打印', () => {
    const { ctx, emit } = fakeCtx()
    const { io, out } = fakeIO()
    const replState = state(ctx)
    attachRender(ctx, io, replState)

    emit('session/append', {
      sessionId: 's',
      event: { type: 'session/header', id: 's', createdAt: 'now', provider: 'p', model: 'm', cwd: '/w' },
    })
    expect(replState.sessionId).toBe('s')
    expect(out.join('')).toBe('')
  })

  it('㉕ 退订后不再产生输出，且监听器从总线摘除', () => {
    const { ctx, emit, count } = fakeCtx()
    const { io, out } = fakeIO()
    const unsubs = attachRender(ctx, io, state(ctx))
    expect(count('stream/chunk')).toBe(1)

    for (const off of unsubs) off()
    expect(count('stream/chunk')).toBe(0)

    emit('stream/chunk', { sessionId: 's', delta: { type: 'text', delta: 'x' } })
    expect(out.join('')).toBe('')
  })
})

describe('formatTurnSummary', () => {
  it('回合摘要含 turn / steps / tokens', () => {
    const text = formatTurnSummary({
      turnNo: 3,
      stepCount: 2,
      totalUsage: { inputTokens: 120, outputTokens: 45 },
      interrupted: false,
    })
    expect(text).toContain('turn 3')
    expect(text).toContain('steps 2')
    expect(text).toContain('120/45')
    expect(text).not.toContain('已取消')
  })

  it('interrupted 时前置"（已取消）"', () => {
    const text = formatTurnSummary({
      turnNo: 3,
      stepCount: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      interrupted: true,
    })
    expect(text).toContain('（已取消）')
  })
})

describe('formatBanner', () => {
  it('横幅含模型、会话 id 与接入点；会话未知时显示 unknown', () => {
    const text = formatBanner(config(), undefined)
    expect(text).toContain('deepseek/deepseek-chat')
    expect(text).toContain('session unknown')
    expect(text).toContain('https://api.deepseek.com')
    expect(text).toContain('DEEPSEEK_API_KEY')
  })

  it('接入点体检命中时给出提示（F-03）', () => {
    const cfg = config()
    cfg.model.baseUrl = 'http://example.com/v1'
    const text = formatBanner(cfg, 's1', {
      localPlugins: [],
      overridesEndpoint: true,
      insecureEndpoint: true,
      file: '/w/minidsh.json',
    })
    expect(text).toContain('改写了接入点')
    expect(text).toContain('明文 http')
  })
})

describe('oneLine', () => {
  it('换行折叠为空格，超出截断并加省略号', () => {
    expect(oneLine('a\nb', 10)).toBe('a b')
    expect(oneLine('a'.repeat(20), 5)).toBe(`${'a'.repeat(5)}…`)
  })
})
