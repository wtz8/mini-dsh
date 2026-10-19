import { describe, expect, it } from 'vitest'

import type { ChatMessage, SessionEvent, TokenUsage } from '../contracts.js'
import { deriveMessages } from './derive.js'

/**
 * log → 模型可见消息的投影（设计 §4.4）：灵魂 #2 的唯一出口。
 * 本文件逐条覆盖四条核心规则与两个"请求合法性"裁剪（残缺 toolCalls / 孤立结果）。
 */

const usage: TokenUsage = { inputTokens: 1, outputTokens: 1 }

const header: SessionEvent = {
  type: 'session/header',
  id: 's1',
  createdAt: '2026-10-17T07:30:12.345Z',
  provider: 'deepseek',
  model: 'deepseek-chat',
  cwd: '.',
}

const assistant = (content: string, ids?: string[], interrupted?: boolean): SessionEvent => ({
  type: 'assistant/message',
  content,
  toolCalls: ids?.map((id) => ({ id, name: 'read', arguments: '{}' })),
  usage,
  ...(interrupted === undefined ? {} : { interrupted }),
})

const toolResult = (callId: string, content: string): SessionEvent => ({
  type: 'tool/result',
  toolCallId: callId,
  result: { callId, name: 'read', ok: true, content },
})

describe('deriveMessages · 基础形态', () => {
  it('空事件序列投影为空数组', () => {
    expect(deriveMessages([])).toEqual([])
  })

  it('header 与 turn 边界不投影（模型不可见）', () => {
    const events: SessionEvent[] = [
      header,
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: '读 README' },
      { type: 'turn/end', turnNo: 1 },
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([{ role: 'user', content: '读 README' }])
  })

  it('user → assistant 按写入顺序投影', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', content: '问' },
      assistant('答'),
      { type: 'user/message', content: '再问' },
      assistant('再答'),
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
      { role: 'user', content: '再问' },
      { role: 'assistant', content: '再答' },
    ])
  })

  it('assistant 带 toolCalls 且结果齐备时，调用与结果都投影并按 callId 关联', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', content: '读两个文件' },
      assistant('', ['c0', 'c1']),
      toolResult('c0', 'A 内容'),
      toolResult('c1', 'B 内容'),
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'user', content: '读两个文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c0', name: 'read', arguments: '{}' },
          { id: 'c1', name: 'read', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c0', content: 'A 内容' },
      { role: 'tool', toolCallId: 'c1', content: 'B 内容' },
    ])
  })
})

describe('deriveMessages · 请求合法性裁剪', () => {
  it('取消场景：assistant 声明了 toolCalls 但没有结果 → 丢弃 toolCalls（不补占位）', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', content: '读文件' },
      assistant('我先看看', ['c0'], true),
    ]
    // 有 tool_calls 却无对应 tool 消息会让 provider 判 400，故只留 content
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '我先看看' },
    ])
  })

  it('部分结果：只保留有结果的调用', () => {
    const events: SessionEvent[] = [
      assistant('', ['c0', 'c1']),
      toolResult('c1', '只有 c1 完成'),
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: '只有 c1 完成' },
    ])
  })

  it('孤立 tool/result（前序 assistant 已被压缩截断）→ 跳过', () => {
    const events: SessionEvent[] = [
      { type: 'compaction', summary: '之前聊了别的', boundary: 2 },
      toolResult('c9', '没有主人的结果'),
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([{ role: 'user', content: '之前聊了别的' }])
  })

  it('空回复（无 content 也无已执行调用）不投影', () => {
    const events: SessionEvent[] = [{ type: 'user/message', content: '问' }, assistant('')]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([{ role: 'user', content: '问' }])
  })

  it('content 为空但有已执行调用时保留（合法且常见）', () => {
    const events: SessionEvent[] = [assistant('', ['c0']), toolResult('c0', 'ok')]
    expect(deriveMessages(events)).toHaveLength(2)
  })

  it('重复 callId 按事件顺序配对：更早响应的结果不能证明更晚的声明已完成（review Y7）', () => {
    // provider 不给 tool-call id 时，02 用 `call_${index}` 兜底，不同响应的首个调用
    // 都叫 call_0。若按"整段日志里出现过同 id 结果"判断（原实现），第二条声明会
    // 被误判为已完成，投影出"有 tool_calls 无 tool 消息"的非法 assistant。
    const events: SessionEvent[] = [
      assistant('', ['call_0']),
      toolResult('call_0', '第一次的结果'),
      assistant('', ['call_0']), // 第二次响应：还没有结果（取消 / 崩溃）
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call_0', content: '第一次的结果' },
      // 第二条声明没有结果，且 content 为空 → 整条不投影（不是"带 tool_calls 的空助手"）
    ])
  })

  it('重复 callId 且两条都有结果时，一条结果只抵消一条声明（计数而非集合）', () => {
    const events: SessionEvent[] = [
      assistant('', ['call_0']),
      toolResult('call_0', 'A'),
      assistant('', ['call_0']),
      toolResult('call_0', 'B'),
    ]
    const out = deriveMessages(events)
    expect(out).toEqual<ChatMessage[]>([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call_0', content: 'A' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call_0', content: 'B' },
    ])
  })

  // review Y9：崩溃留下未结算声明、resume 后同 id 重新声明（且新声明者带文本——
  // 模型"边说话边调工具"的常见形态）。原 FIFO 配对把新结果记到旧声明头上，
  // 投影出 tool 消息不紧跟声明者的非法序列，provider 判 400 且每次 resume 复现。
  it('崩溃后同 id 重声明：结果记到最近声明，tool 消息紧跟其声明者（review Y9）', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: 'q' },
      assistant('', ['call_0']), // 旧声明：崩溃/取消，结果未落盘
      { type: 'turn/end', turnNo: 1 },
      { type: 'turn/start', turnNo: 2 },
      assistant('我先查一下文件。', ['call_0']), // resume 后同 id 重声明，带文本
      toolResult('call_0', 'a.ts'),
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'user', content: 'q' },
      // 旧声明无结果：不投影（content 为空且无已执行调用）
      { role: 'assistant', content: '我先查一下文件。', toolCalls: [{ id: 'call_0', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call_0', content: 'a.ts' },
    ])
  })
})

describe('deriveMessages · compaction', () => {
  it('切点之前的历史被 summary 一条 user 消息取代', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', turnNo: 1 },
      { type: 'user/message', content: '旧问题' },
      assistant('旧回答'),
      { type: 'compaction', summary: '旧回合摘要', boundary: 1 },
      { type: 'turn/start', turnNo: 2 },
      { type: 'user/message', content: '新问题' },
      assistant('新回答'),
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'user', content: '旧回合摘要' },
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '新回答' },
    ])
  })

  it('多个 compaction 取最后一个（最新摘要覆盖旧的）', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', content: '第 1 轮' },
      { type: 'compaction', summary: '摘要 1', boundary: 1 },
      { type: 'user/message', content: '第 2 轮' },
      { type: 'compaction', summary: '摘要 2', boundary: 2 },
      { type: 'user/message', content: '第 3 轮' },
    ]
    expect(deriveMessages(events)).toEqual<ChatMessage[]>([
      { role: 'user', content: '摘要 2' },
      { role: 'user', content: '第 3 轮' },
    ])
  })

  it('投影不修改入参数组（纯函数）', () => {
    const events: SessionEvent[] = [{ type: 'user/message', content: '问' }, assistant('答')]
    const snapshot = JSON.parse(JSON.stringify(events)) as unknown
    deriveMessages(events)
    expect(events).toEqual(snapshot)
  })
})
