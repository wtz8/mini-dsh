import { describe, expect, it, vi } from 'vitest'

import type {
  Ctx,
  PermissionAction,
  SessionEvent,
  ToolDefinition,
  ToolInvocation,
  ToolResult,
} from '../contracts.js'
import { ToolRejected } from '../errors.js'
import { createToolRunner } from './pipeline.js'
import type { ToolRunContext } from './types.js'

/**
 * guarded pipeline（设计 §4.1 / §4.2 / §6.1）—— 本模块的核心。
 *
 * 这里用假 ctx（真 EventBus 语义的最小复刻）而不是组合根：pipeline 的策略分支
 * （权限、改写、超时、取消、后处理）需要精确控制，组合根留到集成测试验证真实挂载。
 */

type PreFn = (p: ToolInvocation) => ToolInvocation | void | Promise<ToolInvocation | void>
type PostFn = (p: ToolResult) => ToolResult | void | Promise<ToolResult | void>

interface Harness {
  ctx: Ctx
  appended: SessionEvent[]
  emitted: Array<{ type: string; payload: unknown }>
  logs: string[]
  onPre: (fn: PreFn) => void
  onPost: (fn: PostFn) => void
  setAppendError: (value: boolean) => void
}

/** 组一个只满足 pipeline 需求的 Ctx：注册表、瀑布、append、log、signal。 */
function harness(defs: ToolDefinition[], permissions: Record<string, PermissionAction> = {}): Harness {
  const byName = new Map(defs.map((def) => [def.name, def]))
  const appended: SessionEvent[] = []
  const emitted: Array<{ type: string; payload: unknown }> = []
  const logs: string[] = []
  const pre: PreFn[] = []
  const post: PostFn[] = []
  let appendFails = false

  const ctx = {
    config: { permissions },
    events: {
      on: () => () => {},
      emit: (type: string, payload: unknown) => {
        emitted.push({ type, payload })
      },
      onWaterfall: (type: string, fn: unknown) => {
        if (type === 'tools/pre-execute') pre.push(fn as PreFn)
        else post.push(fn as PostFn)
        return () => {}
      },
      waterfall: async (type: string, payload: unknown) => {
        let current = payload
        for (const fn of type === 'tools/pre-execute' ? pre : post) {
          const out = await fn(current as never)
          if (out !== undefined && out !== null) current = out
        }
        return current
      },
    },
    tools: {
      register: () => {},
      list: () => [...byName.values()],
      get: (name: string) => {
        const def = byName.get(name)
        if (!def) throw new Error(`tool '${name}' not mounted`)
        return def
      },
    },
    sessions: {
      append: async (_id: string, event: SessionEvent) => {
        if (appendFails) throw new Error('disk full')
        appended.push(event)
      },
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => {
        logs.push(message)
      },
    },
    signal: new AbortController().signal,
  } as unknown as Ctx

  return {
    ctx,
    appended,
    emitted,
    logs,
    onPre: (fn) => pre.push(fn),
    onPost: (fn) => post.push(fn),
    setAppendError: (value) => {
      appendFails = value
    },
  }
}

/** 一个回声工具：把 `text` 原样返回，便于断言"执行的是哪份参数"。 */
function echoTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'echo',
    description: 'echo text',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (args) => args['text'] as string,
    ...overrides,
  }
}

let nextId = 0
function call(name: string, args: unknown, id = `call_${(nextId += 1)}`): { id: string; name: string; arguments: string } {
  return { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
}

function runContext(signal?: AbortSignal): ToolRunContext {
  return { sessionId: 's1', turnNo: 1, stepNo: 1, signal: signal ?? new AbortController().signal }
}

function appendCount(h: Harness): number {
  return h.appended.filter((event) => event.type === 'tool/result').length
}

describe('pipeline · 参数与注册表', () => {
  it('auto 权限：执行 → 结果入 log → tool/start / tool/end 各一次', async () => {
    const execute = vi.fn(async () => 'hello')
    const h = harness([echoTool({ execute })], { echo: 'auto' })
    const runner = createToolRunner(h.ctx)

    const result = await runner.run(call('echo', { text: 'hi' }), runContext())

    expect(result.ok).toBe(true)
    expect(result.content).toBe('hello')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(appendCount(h)).toBe(1)
    const appended = h.appended[0]
    expect(appended?.type === 'tool/result' && appended.result.callId).toBe(result.callId)
    expect(h.emitted.map((e) => e.type)).toEqual(['tool/start', 'tool/end'])
  })

  it('JSON 语法错误 → invalid_args，执行器零调用', async () => {
    const execute = vi.fn(async () => 'x')
    const h = harness([echoTool({ execute })], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', '{not json'), runContext())

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('invalid_args')
    expect(execute).not.toHaveBeenCalled()
    expect(appendCount(h)).toBe(1) // 错误也是结果，必须入 log
  })

  it('参数根为数组 / null / 标量 → invalid_args', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    const runner = createToolRunner(h.ctx)
    for (const raw of ['[]', 'null', '123', '"x"']) {
      const result = await runner.run(call('echo', raw), runContext())
      expect(result.error?.code).toBe('invalid_args')
    }
  })

  it('空 arguments → invalid_args（提示用 "{}"）', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', ''), runContext())
    expect(result.error?.code).toBe('invalid_args')
    expect(result.content).toContain('{}')
  })

  it('缺必填字段 → invalid_args', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', {}), runContext())
    expect(result.error?.code).toBe('invalid_args')
    expect(result.error?.message).toContain('text')
  })

  it('未注册工具 → execution_error（枚举里没有 unknown_tool，Q4）', async () => {
    const h = harness([], {})
    const result = await createToolRunner(h.ctx).run(call('nope', {}), runContext())
    expect(result.error?.code).toBe('execution_error')
    expect(result.error?.message).toContain("unknown tool 'nope'")
  })
})

describe('pipeline · 权限门（PB-02）', () => {
  it('deny：不执行、不审批，但仍写 tool/result（PB-02 ①）', async () => {
    const execute = vi.fn(async () => 'x')
    const approve = vi.fn(async () => true)
    const h = harness([echoTool({ execute })], { echo: 'deny' })
    const result = await createToolRunner(h.ctx, { approve }).run(call('echo', { text: 'a' }), runContext())

    expect(result.error?.code).toBe('permission_denied')
    expect(execute).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
    expect(appendCount(h)).toBe(1)
    expect(h.emitted).toHaveLength(0) // 没执行就不该有 tool/start
  })

  it('ask 且无审批处理器 → 失败关闭（PB-02 ②）', async () => {
    const execute = vi.fn(async () => 'x')
    const h = harness([echoTool({ execute })], { echo: 'ask' })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())

    expect(result.error?.code).toBe('permission_denied')
    expect(result.content).toContain('未提供审批通道')
    expect(execute).not.toHaveBeenCalled()
  })

  it('ask 且处理器返回 false / undefined → 拒绝', async () => {
    const h = harness([echoTool()], { echo: 'ask' })
    for (const value of [false, undefined]) {
      const approve = vi.fn(async () => value as boolean)
      const result = await createToolRunner(h.ctx, { approve }).run(call('echo', { text: 'a' }), runContext())
      expect(result.error?.code).toBe('permission_denied')
    }
  })

  it('ask 且处理器显式返回 true → 执行', async () => {
    const execute = vi.fn(async () => 'ok')
    const h = harness([echoTool({ execute })], { echo: 'ask' })
    const result = await createToolRunner(h.ctx, { approve: async () => true }).run(
      call('echo', { text: 'a' }),
      runContext(),
    )
    expect(result.ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('ask 处理器抛错 → 当作拒绝，并记 log.error', async () => {
    const h = harness([echoTool()], { echo: 'ask' })
    const approve = async (): Promise<boolean> => {
      throw new Error('prompt broken')
    }
    const result = await createToolRunner(h.ctx, { approve }).run(call('echo', { text: 'a' }), runContext())

    expect(result.error?.code).toBe('permission_denied')
    expect(h.logs.some((line) => line.includes('approval handler failed'))).toBe(true)
  })

  it('审批超时 → 失败关闭（approvalTimeoutMs 生效）', async () => {
    const h = harness([echoTool()], { echo: 'ask' })
    const approve = (): Promise<boolean> => new Promise(() => {})
    const result = await createToolRunner(h.ctx, { approve, approvalTimeoutMs: 20 }).run(
      call('echo', { text: 'a' }),
      runContext(),
    )
    expect(result.error?.code).toBe('permission_denied')
    expect(result.error?.message).toContain('超时')
  })

  it('等待审批期间回合被取消 → cancelled（不是 permission_denied）', async () => {
    const h = harness([echoTool()], { echo: 'ask' })
    const controller = new AbortController()
    const approve = (): Promise<boolean> => {
      setTimeout(() => controller.abort(), 10)
      return new Promise(() => {})
    }
    const result = await createToolRunner(h.ctx, { approve }).run(
      call('echo', { text: 'a' }),
      runContext(controller.signal),
    )
    expect(result.error?.code).toBe('cancelled')
  })
})

describe('pipeline · 瀑布改写（PB-02 ③④）', () => {
  it('pre-execute 改写参数后执行的是改写后的值', async () => {
    const execute = vi.fn(async (args: Record<string, unknown>) => args['text'] as string)
    const h = harness([echoTool({ execute })], { echo: 'auto' })
    h.onPre((inv) => ({ ...inv, args: { text: 'rewritten' } }))

    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'original' }), runContext())
    expect(result.content).toBe('rewritten')
    expect(execute).toHaveBeenCalledWith({ text: 'rewritten' }, expect.anything())
  })

  it('改写后参数不合法 → invalid_args，且不执行（复检生效）', async () => {
    const execute = vi.fn(async () => 'x')
    const h = harness([echoTool({ execute })], { echo: 'auto' })
    h.onPre((inv) => ({ ...inv, args: { text: 42 } }))

    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'ok' }), runContext())
    expect(result.error?.code).toBe('invalid_args')
    expect(result.error?.message).toContain('改写后')
    expect(execute).not.toHaveBeenCalled()
  })

  it('改写工具名后按新名字判权限（read → bash，bash 为 deny 时拒绝）', async () => {
    const read = echoTool({ name: 'read' })
    const bash = echoTool({ name: 'bash' })
    const h = harness([read, bash], { read: 'auto', bash: 'deny' })
    h.onPre((inv) => ({ ...inv, name: 'bash' }))

    const result = await createToolRunner(h.ctx).run(call('read', { text: 'a' }), runContext())
    expect(result.error?.code).toBe('permission_denied')
    expect(result.name).toBe('bash')
  })

  it('改写后的工具名不存在 → execution_error', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.onPre((inv) => ({ ...inv, name: 'ghost' }))
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.error?.code).toBe('execution_error')
    expect(result.error?.message).toContain('ghost')
  })

  it('pre-execute 抛 ToolRejected → permission_denied，message 透传（架构 §5.3）', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.onPre(() => {
      throw new ToolRejected('用户不同意执行')
    })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.error?.code).toBe('permission_denied')
    expect(result.error?.message).toBe('用户不同意执行')
  })

  it('pre-execute 抛其它异常 → execution_error（不静默吞插件 bug）', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.onPre(() => {
      throw new Error('listener boom')
    })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.error?.code).toBe('execution_error')
    expect(result.error?.message).toContain('listener boom')
  })

  it('授权与执行看到同一个冻结快照（approve 拿到 args 已被 Object.freeze）', async () => {
    const seen: { approveArgs?: unknown; execArgs?: unknown } = {}
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      seen.execArgs = args
      return 'ok'
    })
    const h = harness([echoTool({ execute })], { echo: 'ask' })
    const approve = async (inv: Readonly<ToolInvocation>): Promise<boolean> => {
      seen.approveArgs = inv.args
      expect(Object.isFrozen(inv)).toBe(true)
      expect(Object.isFrozen(inv.args)).toBe(true)
      return true
    }
    await createToolRunner(h.ctx, { approve }).run(call('echo', { text: 'x' }), runContext())

    expect(seen.approveArgs).toEqual({ text: 'x' })
    expect(seen.execArgs).toBe(seen.approveArgs)
  })
})

describe('pipeline · 执行、超时与取消', () => {
  it('execute 抛错 → execution_error（content 含 message，不含 stack）', async () => {
    const h = harness([echoTool({ execute: async () => {
      throw new Error('boom')
    } })], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.error?.code).toBe('execution_error')
    expect(result.content).toContain('boom')
  })

  it('execute 返回空串 → （无输出）', async () => {
    const h = harness([echoTool({ execute: async () => '' })], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.ok).toBe(true)
    expect(result.content).toBe('（无输出）')
  })

  it('timeoutFor 返回超时 → timeout，且工具收到 abort', async () => {
    let aborted = false
    const tool = echoTool({
      execute: (_args, env) =>
        new Promise<string>((_resolve, reject) => {
          env.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    })
    const h = harness([tool], { echo: 'auto' })
    const runner = createToolRunner(h.ctx, { timeoutFor: () => 20 })
    const result = await runner.run(call('echo', { text: 'a' }), runContext())

    expect(result.error?.code).toBe('timeout')
    expect(aborted).toBe(true)
    // tool/end 仍要发：CLI 靠它收掉 spinner
    expect(h.emitted.map((e) => e.type)).toEqual(['tool/start', 'tool/end'])
  })

  it('未声明超时的工具不会被超时打断', async () => {
    const h = harness([echoTool({ execute: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return 'slow but fine'
    } })], { echo: 'auto' })
    const result = await createToolRunner(h.ctx, { timeoutFor: () => undefined }).run(
      call('echo', { text: 'a' }),
      runContext(),
    )
    expect(result.ok).toBe(true)
  })

  it('调用前已取消 → cancelled，执行器零调用', async () => {
    const execute = vi.fn(async () => 'x')
    const h = harness([echoTool({ execute })], { echo: 'auto' })
    const controller = new AbortController()
    controller.abort()
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext(controller.signal))
    expect(result.error?.code).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('执行中取消 → cancelled', async () => {
    const controller = new AbortController()
    const tool = echoTool({
      execute: (_args, env) =>
        new Promise<string>((_resolve, reject) => {
          env.signal.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(() => controller.abort(), 10)
        }),
    })
    const h = harness([tool], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext(controller.signal))
    expect(result.error?.code).toBe('cancelled')
  })
})

describe('pipeline · 后处理、截断与入 log', () => {
  it('post-execute 可以改写内容', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.onPost((result) => ({ ...result, content: `[redacted] ${result.content}` }))
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'secret' }), runContext())
    expect(result.content).toBe('[redacted] secret')
  })

  it('post-execute 抛错 → 保留原结果并记 log.error（D5：副作用已发生）', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.onPost(() => {
      throw new Error('post boom')
    })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.ok).toBe(true)
    expect(result.content).toBe('a')
    expect(h.logs.some((line) => line.includes('post-execute'))).toBe(true)
  })

  it('post-execute 不能改 callId / name（否则日志配对错位）', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.onPost((result) => ({ ...result, callId: 'hacked', name: 'hacked' }))
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }, 'call_real'), runContext())
    expect(result.callId).toBe('call_real')
    expect(result.name).toBe('echo')
  })

  it('超长结果走中段截断（留头尾，标注丢弃量）', async () => {
    const long = `${'A'.repeat(80)}${'B'.repeat(200)}${'C'.repeat(80)}`
    const h = harness([echoTool({ execute: async () => long })], { echo: 'auto' })
    const result = await createToolRunner(h.ctx, { maxResultChars: 100 }).run(
      call('echo', { text: 'a' }),
      runContext(),
    )
    expect(result.content.length).toBeLessThan(long.length)
    expect(result.content).toContain('已截断')
    expect(result.content.startsWith('A')).toBe(true)
    expect(result.content.endsWith('C')).toBe(true)
  })

  it('append 失败不改变返回值（工具已执行，事实不能丢）', async () => {
    const h = harness([echoTool()], { echo: 'auto' })
    h.setAppendError(true)
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.ok).toBe(true)
    expect(h.logs.some((line) => line.includes('tool/result 写入会话失败'))).toBe(true)
  })

  it('run 永不抛错：执行器抛非 Error 值也转成 execution_error', async () => {
    const h = harness([echoTool({ execute: async () => {
      throw 'string thrown'
    } })], { echo: 'auto' })
    const result = await createToolRunner(h.ctx).run(call('echo', { text: 'a' }), runContext())
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('execution_error')
    expect(result.content).toContain('string thrown')
  })
})
