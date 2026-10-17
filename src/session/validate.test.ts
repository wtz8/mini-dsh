import { describe, expect, it } from 'vitest'

import { isSessionEvent } from './validate.js'

/**
 * 读回时的最小结构校验（设计 §3）：`JSON.parse` 的产物必须过这一关才能进投影，
 * 否则畸形行会让 06 在拼请求时崩在与真正原因无关的地方。
 */

describe('isSessionEvent', () => {
  it('七个变体的合法样例全部通过', () => {
    const samples: unknown[] = [
      { type: 'session/header', id: 's1', createdAt: 't', provider: 'p', model: 'm', cwd: '.' },
      { type: 'turn/start', turnNo: 1 },
      { type: 'turn/end', turnNo: 1 },
      { type: 'user/message', content: 'hi' },
      { type: 'assistant/message', content: 'hi', usage: { inputTokens: 1, outputTokens: 2 } },
      {
        type: 'assistant/message',
        content: '',
        toolCalls: [{ id: 'c0', name: 'read', arguments: '{}' }],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        interrupted: true,
      },
      {
        type: 'tool/result',
        toolCallId: 'c0',
        result: { callId: 'c0', name: 'read', ok: true, content: 'out' },
      },
      {
        type: 'tool/result',
        toolCallId: 'c0',
        result: {
          callId: 'c0',
          name: 'bash',
          ok: false,
          content: 'denied',
          error: { code: 'permission_denied', message: 'no' },
        },
      },
      { type: 'compaction', summary: '摘要', boundary: 3 },
    ]
    for (const sample of samples) expect(isSessionEvent(sample)).toBe(true)
  })

  it('未知事件类型一律拒绝（变体集合对 03 封闭）', () => {
    expect(isSessionEvent({ type: 'tool/call' })).toBe(false)
    expect(isSessionEvent({ type: 'system/message', content: 'x' })).toBe(false)
    expect(isSessionEvent({})).toBe(false)
  })

  it('非对象与数组一律拒绝', () => {
    expect(isSessionEvent(null)).toBe(false)
    expect(isSessionEvent('user/message')).toBe(false)
    expect(isSessionEvent(42)).toBe(false)
    expect(isSessionEvent([])).toBe(false)
  })

  it('缺少必需字段的变体被拒绝', () => {
    expect(isSessionEvent({ type: 'user/message' })).toBe(false) // 缺 content
    expect(isSessionEvent({ type: 'turn/start' })).toBe(false) // 缺 turnNo
    expect(isSessionEvent({ type: 'compaction', summary: 's' })).toBe(false) // 缺 boundary
    expect(
      isSessionEvent({ type: 'session/header', id: 's1', createdAt: 't', provider: 'p', model: 'm' }),
    ).toBe(false) // 缺 cwd
    expect(isSessionEvent({ type: 'assistant/message', content: 'x' })).toBe(false) // 缺 usage
  })

  it('字段类型不对或错误码不在枚举内时被拒绝', () => {
    expect(isSessionEvent({ type: 'user/message', content: 42 })).toBe(false)
    expect(isSessionEvent({ type: 'turn/start', turnNo: '1' })).toBe(false)
    expect(
      isSessionEvent({
        type: 'assistant/message',
        content: 'x',
        usage: { inputTokens: 1, outputTokens: '2' },
      }),
    ).toBe(false)
    expect(
      isSessionEvent({
        type: 'tool/result',
        toolCallId: 'c0',
        result: { callId: 'c0', name: 'r', ok: true, content: '', error: { code: 'weird', message: 'm' } },
      }),
    ).toBe(false)
    expect(isSessionEvent({ type: 'assistant/message', content: 'x', usage: {}, interrupted: 'yes' })).toBe(false)
  })
})
