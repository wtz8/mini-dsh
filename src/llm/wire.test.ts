import { describe, expect, it } from 'vitest'

import type { LLMRequest } from '../contracts.js'
import { buildRequestBody, buildRequestUrl, toStreamEvents } from './wire.js'

/**
 * 线格式单元测试（设计 §6.1）：请求体构造、消息/tools 映射、chunk → StreamEvent 映射。
 */

/** 最小合法请求：signal 必填，其余取最小形态。 */
function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('buildRequestUrl', () => {
  it('baseUrl 去尾斜杠后拼 /chat/completions', () => {
    expect(buildRequestUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions')
    expect(buildRequestUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/chat/completions')
    expect(buildRequestUrl('https://api.deepseek.com///')).toBe('https://api.deepseek.com/chat/completions')
  })
})

describe('buildRequestBody', () => {
  it('含 model / stream / stream_options 与用户消息', () => {
    const body = JSON.parse(buildRequestBody(request())) as Record<string, unknown>
    expect(body['model']).toBe('deepseek-chat')
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('system 非空时插在最前；缺省或空串时不插 system 消息', () => {
    const withSystem = JSON.parse(buildRequestBody(request({ system: 'you are' }))) as {
      messages: unknown[]
    }
    expect(withSystem.messages[0]).toEqual({ role: 'system', content: 'you are' })

    const noSystem = JSON.parse(buildRequestBody(request({ system: '' }))) as { messages: unknown[] }
    expect(noSystem.messages).toHaveLength(1)
    expect(noSystem.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('assistant 消息的 toolCalls 映为 function 形态', () => {
    const body = JSON.parse(
      buildRequestBody(
        request({
          messages: [
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"p":1}' }] },
          ],
        }),
      ),
    ) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }],
    })
  })

  it('tool 消息映为 tool_call_id', () => {
    const body = JSON.parse(
      buildRequestBody(request({ messages: [{ role: 'tool', toolCallId: 'c1', content: 'ok' }] })),
    ) as { messages: unknown[] }
    expect(body.messages[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' })
  })

  it('tools 非空时映射为 function 形态；为空数组时不发 tools 键', () => {
    const withTools = JSON.parse(
      buildRequestBody(
        request({
          tools: [{ name: 'read', description: 'read file', schema: { type: 'object', properties: {} } }],
        }),
      ),
    ) as Record<string, unknown>
    expect(withTools['tools']).toEqual([
      {
        type: 'function',
        function: { name: 'read', description: 'read file', parameters: { type: 'object', properties: {} } },
      },
    ])

    const noTools = JSON.parse(buildRequestBody(request())) as Record<string, unknown>
    expect(noTools).not.toHaveProperty('tools')
  })

  it('maxTokens 缺省时不发 max_tokens；有值时透传', () => {
    expect(JSON.parse(buildRequestBody(request())) as Record<string, unknown>).not.toHaveProperty('max_tokens')
    expect((JSON.parse(buildRequestBody(request({ maxTokens: 128 }))) as Record<string, unknown>)['max_tokens']).toBe(
      128,
    )
  })
})

describe('toStreamEvents', () => {
  it('content 映为 text 事件；空串不产事件', () => {
    expect(toStreamEvents({ choices: [{ delta: { content: 'hel' } }] })).toEqual([{ type: 'text', delta: 'hel' }])
    expect(toStreamEvents({ choices: [{ delta: { content: '' } }] })).toEqual([])
  })

  it('tool_calls 映为 tool-call 事件（首片带 id/name，后续只带 arguments）', () => {
    expect(
      toStreamEvents({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'read', arguments: '{"p' } },
                { index: 1, function: { arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      { type: 'tool-call', delta: { index: 0, id: 'c1', name: 'read', argumentsDelta: '{"p' } },
      { type: 'tool-call', delta: { index: 1, argumentsDelta: '{}' } },
    ])
  })

  it('usage 映为 usage 事件；只取第一个 choice', () => {
    expect(
      toStreamEvents({
        choices: [{ delta: { content: 'x' } }, { delta: { content: 'ignored' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ).toEqual([
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: 'text', delta: 'x' },
    ])
  })

  it('usage 缺 total_tokens 时不给 totalTokens；整个 usage 块缺失则不产事件', () => {
    expect(toStreamEvents({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    ])
    expect(toStreamEvents({ choices: [{ finish_reason: 'stop' }] })).toEqual([])
  })

  it('未知字段被忽略（provider 扩展不解释）', () => {
    expect(toStreamEvents({ id: 'x', created: 1, model: 'm', choices: [{ delta: { content: 'a' } }] })).toEqual([
      { type: 'text', delta: 'a' },
    ])
  })

  it('chunk 不是对象时抛错（adapter 会转成 protocol 错误）', () => {
    expect(() => toStreamEvents('not an object')).toThrow(/not an object/)
  })
})
