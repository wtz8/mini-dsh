import { describe, expect, it } from 'vitest'

import { estimateRequestTokens, estimateTokens, needsCompaction } from './tokens.js'

/**
 * token 启发式估算（设计 §6.1）：**纯函数**四条规则——CJK 1/字、其余 1/4 字、
 * 每条消息 +4、每个工具 schema +8（含 name/description/JSON）。
 */

describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯 ASCII 按 1/4 字符向上取整', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil(11 / 4))
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('纯中文按 1 token/字', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('中英混排分别计算后相加', () => {
    expect(estimateTokens('你好ab')).toBe(2 + Math.ceil(2 / 4))
  })

  it('全角标点计入 CJK', () => {
    // U+FF0C / U+3002 均落在 CJK 区间
    expect(estimateTokens('，。')).toBe(2)
  })
})

describe('estimateRequestTokens', () => {
  it('system + 消息正文 + 每条消息 4 的开销', () => {
    const total = estimateRequestTokens({
      system: 'abcd', // 1
      messages: [
        { role: 'user', content: 'abcd' }, // 1 + 4
      ],
      tools: [],
    })
    expect(total).toBe(1 + 1 + 4)
  })

  it('assistant 的 toolCalls 计入（name + arguments + 开销）', () => {
    const withCall = estimateRequestTokens({
      system: '',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }],
        },
      ],
      tools: [],
    })
    const without = estimateRequestTokens({
      system: '',
      messages: [{ role: 'assistant', content: '' }],
      tools: [],
    })
    const expectedDelta =
      estimateTokens('read') + estimateTokens('{"path":"a.txt"}') + 4
    expect(withCall - without).toBe(expectedDelta)
  })

  it('tool 消息只算正文', () => {
    const total = estimateRequestTokens({
      system: '',
      messages: [{ role: 'tool', toolCallId: 'c1', content: 'abcd' }],
      tools: [],
    })
    expect(total).toBe(1 + 4)
  })

  it('工具 schema 按 JSON 计入，且有 8 的结构开销', () => {
    const total = estimateRequestTokens({
      system: '',
      messages: [],
      tools: [{ name: 'read', description: 'read a file', schema: { type: 'object', properties: {} } }],
    })
    const expected =
      estimateTokens('read') +
      estimateTokens('read a file') +
      estimateTokens(JSON.stringify({ type: 'object', properties: {} })) +
      8
    expect(total).toBe(expected)
  })
})

describe('needsCompaction', () => {
  it('低于阈值不压缩', () => {
    expect(needsCompaction(49, 100, 0.5)).toBe(false)
  })

  it('**等于**阈值即压缩（阈值是上界，踩线就该压）', () => {
    expect(needsCompaction(50, 100, 0.5)).toBe(true)
  })

  it('高于阈值压缩', () => {
    expect(needsCompaction(51, 100, 0.5)).toBe(true)
  })

  it('contextWindow 非正时不压缩（防御异常配置）', () => {
    expect(needsCompaction(1000, 0, 0.5)).toBe(false)
  })
})
