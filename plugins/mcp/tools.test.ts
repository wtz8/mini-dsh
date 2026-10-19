import { describe, expect, it, vi } from 'vitest'

import type { ToolEnv } from '../../src/index.js'
import { createMcpTool } from './tools.js'
import type { McpClient, McpCallOptions } from './client.js'

/**
 * tools.ts 单测（设计 §6.1）：远端工具 → ToolDefinition 的组装语义。
 * client 用伪实现（只记录调用、返回固定结果），专注本层的职责：
 * 公开名 / 兜底描述 / schema 归一 / isError 抛错 / wire 用 raw 名 / 取消信号透传。
 */

/** 伪 client：记录 callTool 的入参，按用例预设返回。 */
function makeFakeClient(outcome: { content: unknown; isError: boolean }): McpClient & {
  calls: Array<{ rawName: string; args: Record<string, unknown>; options?: McpCallOptions }>
} {
  const calls: Array<{ rawName: string; args: Record<string, unknown>; options?: McpCallOptions }> = []
  return {
    serverName: 'demo',
    // start 在本层不消费，占位实现（plugin/client 层已覆盖真实语义）
    start: vi.fn(async () => []),
    async callTool(rawName, args, options) {
      calls.push({ rawName, args, options })
      return outcome
    },
    dispose: vi.fn(async () => {}),
    calls,
  }
}

/** 构造 ToolEnv（signal 可控）。 */
function makeEnv(signal = new AbortController().signal): ToolEnv {
  return { callId: 'call_1', sessionId: 'session_1', signal }
}

describe('createMcpTool', () => {
  it('30 · ToolDefinition 形态：公开名 / parallel / schema 已归一', () => {
    const client = makeFakeClient({ content: [], isError: false })
    const def = createMcpTool('github', { name: 'create_issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, client)
    expect(def.name).toBe('mcp__github__create_issue')
    expect(def.concurrency).toBe('parallel')
    expect(def.schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    })
    expect(typeof def.description).toBe('string')
  })

  it('31 · description 缺失或全空白 ⇒ 兜底文案（含 server 名与 raw 名）', () => {
    const client = makeFakeClient({ content: [], isError: false })
    const noDesc = createMcpTool('demo', { name: 'echo' }, client)
    expect(noDesc.description).toBe('（MCP server demo 提供的工具 echo）')
    const blankDesc = createMcpTool('demo', { name: 'echo', description: '   ' }, client)
    expect(blankDesc.description).toBe('（MCP server demo 提供的工具 echo）')
    // 有真实描述时不覆盖
    const realDesc = createMcpTool('demo', { name: 'echo', description: '回声工具' }, client)
    expect(realDesc.description).toBe('回声工具')
  })

  it('32 · isError: true ⇒ 抛错（模型看到显式失败），文本来自 content 投影', async () => {
    const client = makeFakeClient({
      content: [{ type: 'text', text: '仓库不存在' }],
      isError: true,
    })
    const def = createMcpTool('demo', { name: 'fetch_repo' }, client)
    await expect(def.execute({}, makeEnv())).rejects.toThrow(
      /fetch_repo 报告执行失败：仓库不存在/,
    )
  })

  it('33 · 正常执行：wire 用 raw 名、参数透传、结果为投影文本、signal 透传', async () => {
    const client = makeFakeClient({
      content: [
        { type: 'text', text: '第一行' },
        { type: 'image', data: 'aGk=' },
      ],
      isError: false,
    })
    const def = createMcpTool('demo', { name: 'echo' }, client, 5_000)
    const controller = new AbortController()
    const text = await def.execute({ q: '你好' }, makeEnv(controller.signal))

    expect(text).toBe('第一行\n[不支持的 MCP 内容类型：image]')
    // wire 上是 raw 名（公开名从不发给 server）
    expect(client.calls[0]!.rawName).toBe('echo')
    expect(client.calls[0]!.args).toEqual({ q: '你好' })
    // 超时预设与取消信号都透传给了 client（Q8）
    expect(client.calls[0]!.options?.timeoutMs).toBe(5_000)
    expect(client.calls[0]!.options?.signal).toBe(controller.signal)
  })
})
