import { describe, expect, it, vi } from 'vitest'

import type {
  AgentControl,
  PromptSection,
  Session,
  SessionEvent,
  SessionStore,
  ToolDefinition,
} from '../contracts.js'
import {
  AgentRegistryImpl,
  LlmRegistryImpl,
  PromptRegistryImpl,
  SessionStoreContainerImpl,
  ToolRegistryImpl,
} from './containers.js'

/** 最小工具定义（仅注册表测试用，不真正执行）。 */
function toolDef(name: string): ToolDefinition {
  return {
    name,
    description: `${name} for test`,
    schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  }
}

function section(id: string, order: number, text?: string): PromptSection {
  return { id, order, render: () => text ?? `SECTION:${id}` }
}

describe('LlmRegistry', () => {
  it('register 后 resolve 返回同一工厂', () => {
    const reg = new LlmRegistryImpl()
    const factory = vi.fn()
    reg.register('deepseek', factory)
    expect(reg.resolve('deepseek')).toBe(factory)
  })

  it('同名重复注册抛错', () => {
    const reg = new LlmRegistryImpl()
    reg.register('deepseek', vi.fn())
    expect(() => reg.register('deepseek', vi.fn())).toThrow(/already registered/)
  })

  it('未注册的 name resolve 抛 not mounted', () => {
    const reg = new LlmRegistryImpl()
    expect(() => reg.resolve('unknown')).toThrow(/not mounted/)
  })
})

describe('ToolRegistry', () => {
  it('register 后 list 返回注册序快照，get 按名取回', () => {
    const reg = new ToolRegistryImpl()
    const bash = toolDef('bash')
    const read = toolDef('read')
    reg.register(bash)
    reg.register(read)
    expect(reg.list()).toEqual([bash, read])
    expect(reg.get('read')).toBe(read)

    // 快照语义：改动返回数组不影响注册表
    const snapshot = reg.list() as ToolDefinition[]
    snapshot.pop()
    expect(reg.list()).toHaveLength(2)
  })

  it('同名重复注册抛错', () => {
    const reg = new ToolRegistryImpl()
    reg.register(toolDef('bash'))
    expect(() => reg.register(toolDef('bash'))).toThrow(/already registered/)
  })

  it('未注册的 name get 抛 not mounted', () => {
    const reg = new ToolRegistryImpl()
    expect(() => reg.get('nope')).toThrow(/not mounted/)
  })
})

describe('PromptRegistry', () => {
  it('render 按 order 升序、同 order 按 id 字典序，以空行分隔拼接', () => {
    const reg = new PromptRegistryImpl()
    reg.section(section('b-second', 20))
    reg.section(section('a-first', 10))
    reg.section(section('z-同序末尾', 20))
    reg.section(section('y-同序前一个', 20))

    expect(reg.render()).toBe('SECTION:a-first\n\nSECTION:b-second\n\nSECTION:y-同序前一个\n\nSECTION:z-同序末尾')
  })

  it('无 section 时 render 返回空字符串', () => {
    expect(new PromptRegistryImpl().render()).toBe('')
  })

  it('同 id 重复注册抛错', () => {
    const reg = new PromptRegistryImpl()
    reg.section(section('dup', 1))
    expect(() => reg.section(section('dup', 2))).toThrow(/already registered/)
  })

  // 04 设计 D2/Q4：条件段（无工具时的 tool-use、无 MEMORY 时的 memory 段）返回空串，
  // 不过滤会拼出连续空行。只过滤**严格空串**，不 trim（段作者的首尾空白是排版意图）。
  it('render 跳过渲染结果为空串的段（不产生连续空行）', () => {
    const reg = new PromptRegistryImpl()
    reg.section(section('a', 10))
    reg.section(section('b-empty', 20, ''))
    reg.section(section('c', 30))
    reg.section(section('d-empty', 40, ''))

    expect(reg.render()).toBe('SECTION:a\n\nSECTION:c')
  })

  it('render 不过滤空白但非空的段（不 trim，尊重段作者排版）', () => {
    const reg = new PromptRegistryImpl()
    reg.section(section('a', 10, '  '))
    reg.section(section('b', 20))

    expect(reg.render()).toBe('  \n\nSECTION:b')
  })

  it('段 render 抛错时上抛，不吞（prompt 是每 step 必经路径）', () => {
    const reg = new PromptRegistryImpl()
    reg.section({ id: 'boom', order: 1, render: () => { throw new Error('section failed') } })
    expect(() => reg.render()).toThrow('section failed')
  })

  it('注册期校验形状：id 非空 / order 是有限数值 / render 是函数（review Y10）', () => {
    // 外部 JS 插件不受 TS 约束：order 为 NaN 时比较器返回 NaN（sort 视为相等），
    // "同 order 按 id 字典序"被绕过，段序退化为注册顺序
    const reg = new PromptRegistryImpl()
    expect(() => reg.section({ id: '', order: 1, render: () => '' })).toThrow(/`id` must be a non-empty string/)
    expect(() => reg.section({ id: 'a', order: Number.NaN, render: () => '' })).toThrow(/`order` must be a finite number/)
    expect(() => reg.section({ id: 'a', order: Number.POSITIVE_INFINITY, render: () => '' })).toThrow(/finite number/)
    expect(() => reg.section({ id: 'a', order: 1, render: 42 as never })).toThrow(/`render` must be a function/)
    expect(() => reg.section(null as never)).toThrow(/must be an object/)
  })

  it('注册时存冻结副本：插件事后改写自己的 order 不影响排序（review Y10）', () => {
    const reg = new PromptRegistryImpl()
    const a = section('a', 10)
    const b = section('b', 20)
    reg.section(a)
    reg.section(b)
    ;(a as { order: number }).order = 99
    expect(reg.render()).toBe('SECTION:a\n\nSECTION:b')
  })
})

describe('SessionStoreContainer', () => {
  /** 真实实现桩：记录调用以验证委托。 */
  function stubStore(): SessionStore & { appended: SessionEvent[] } {
    const appended: SessionEvent[] = []
    return {
      create: async () => ({ id: 's1', meta: { id: 's1', createdAt: '', provider: '', model: '', cwd: '' } }) as Session,
      open: async (id: string) => ({ id, meta: { id, createdAt: '', provider: '', model: '', cwd: '' } }),
      list: async () => [],
      read: async () => [{ type: 'turn/start', turnNo: 7 }] as SessionEvent[],
      append: async (_id: string, e: SessionEvent) => {
        appended.push(e)
      },
      subscribe: () => () => {},
      get appended() {
        return appended
      },
    }
  }

  it('未 mount 前所有 SessionStore 方法抛 not mounted', async () => {
    const container = new SessionStoreContainerImpl()
    const init = { provider: 'p', model: 'm', cwd: '.' }
    await expect(container.create(init)).rejects.toThrow(/not mounted/)
    await expect(container.open('s1')).rejects.toThrow(/not mounted/)
    await expect(container.list()).rejects.toThrow(/not mounted/)
    await expect(container.read('s1')).rejects.toThrow(/not mounted/)
    await expect(container.append('s1', { type: 'turn/start', turnNo: 1 })).rejects.toThrow(/not mounted/)
    expect(() => container.subscribe('s1', () => {})).toThrow(/not mounted/)
  })

  it('mount 后方法全部委托给注入的实现', async () => {
    const container = new SessionStoreContainerImpl()
    const stub = stubStore()
    container.mount(stub)

    await container.append('s1', { type: 'turn/start', turnNo: 1 })
    expect(stub.appended).toEqual([{ type: 'turn/start', turnNo: 1 }])

    const session = await container.open('s1')
    expect(session.id).toBe('s1')

    // read 是 0.1.5 新增的读取口（03 设计 §2.4 D1）：同样走委托
    expect(await container.read('s1')).toEqual([{ type: 'turn/start', turnNo: 7 }])
  })

  it('第二次 mount 抛错（一次性注入通道）', () => {
    const container = new SessionStoreContainerImpl()
    container.mount(stubStore())
    expect(() => container.mount(stubStore())).toThrow(/already mounted/)
  })
})

describe('AgentRegistry', () => {
  it('未注册时 resolve 抛 not mounted', () => {
    expect(() => new AgentRegistryImpl().resolve()).toThrow(/not mounted/)
  })

  it('register 后 resolve 返回同一控制面；重复注册抛错', () => {
    const reg = new AgentRegistryImpl()
    const ctl: AgentControl = {
      sessionId: 's1',
      run: async () => ({ turnNo: 1, stepCount: 0, totalUsage: { inputTokens: 0, outputTokens: 0 }, interrupted: false }),
      cancel: () => {},
    }
    reg.register(ctl)
    expect(reg.resolve()).toBe(ctl)
    expect(() => reg.register(ctl)).toThrow(/already registered/)
  })
})
