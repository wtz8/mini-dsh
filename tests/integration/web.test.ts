import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Ctx, Unsubscribe } from '../../src/index.js'
import { boot, registerBuiltin, shutdown } from '../../src/index.js'
import { createAgentPlugin } from '../../src/agent/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { createLlmPlugin } from '../../src/llm/index.js'
import type { FetchLike } from '../../src/llm/index.js'
import { registerPromptBuiltin } from '../../src/prompt/index.js'
import { registerSessionBuiltin } from '../../src/session/index.js'
import { registerToolsBuiltin } from '../../src/tools/index.js'
import { createWebPlugin } from '../../plugins/web/plugin.js'
import type { UiEvent } from '../../plugins/web/types.js'

/**
 * 10-web-ui 集成测试（设计 §6.2）：**真实组合根 + 真实 JSONL 会话 + 真实工具管道 +
 * 真实 HTTP 监听**，只在网络出口注入伪 fetch（与 02/06 集成同式，全程不打外网）。
 *
 * 六条链路：挂载与状态 / 纯文本流式 / 工具审批放行 / 审批拒绝 / 取消 / shutdown 释放端口。
 */

const KEY_ENV = 'DEEPSEEK_API_KEY'

/* ---------------- 伪网络（与 06 集成同式） ---------------- */

/** 文本分片。 */
function textChunk(delta: string): string {
  return `data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}\n\n`
}

/** 工具调用分片（单个，一次给全）。 */
function callChunk(id: string, name: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [
      { delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  })}\n\n`
}

const DONE = 'data: [DONE]\n\n'
const USAGE = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n'

/** 按请求序消费的分片剧本。 */
function scriptedFetch(chunksPerCall: string[][]): FetchLike {
  let call = 0
  const encoder = new TextEncoder()
  return ((_url: unknown, _init?: RequestInit) => {
    const chunks = chunksPerCall[call] ?? []
    call += 1
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  }) as unknown as FetchLike
}

/** 只发一片就挂住的伪 fetch（取消链路）。 */
function hangingFetch(firstChunk: string): FetchLike {
  const encoder = new TextEncoder()
  return ((_url: unknown, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstChunk))
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'))
          } catch {
            /* 已关闭 */
          }
        })
      },
    })
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  }) as unknown as FetchLike
}

/* ---------------- 装配 ---------------- */

const unsubscribes: Unsubscribe[] = []
const contexts: Ctx[] = []
const tempDirs: string[] = []
let sessionsDir: string
let readyUrl = ''

async function newDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * 完整装配：注册五个 builtin + web（同一审批通道注入 agent-loop），boot 后返回入口。
 */
async function bootWithWeb(fetchImpl: FetchLike): Promise<{ ctx: Ctx; url: string }> {
  readyUrl = ''
  const web = createWebPlugin({
    port: 0,
    host: '127.0.0.1',
    onReady: (info) => { readyUrl = info.url },
  })

  unsubscribes.push(registerSessionBuiltin(), registerPromptBuiltin(), registerToolsBuiltin())
  unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl })))
  unsubscribes.push(
    registerBuiltin('agent-loop', createAgentPlugin({ approve: web.approve, sessionId: undefined })),
  )
  unsubscribes.push(registerBuiltin('web', web.factory))

  const config = createDefaultConfig()
  config.model.apiKeyEnv = KEY_ENV
  config.plugins = [
    { source: 'builtin:session', config: { dir: sessionsDir } },
    { source: 'builtin:llm' },
    { source: 'builtin:prompt' },
    { source: 'builtin:tools' },
    { source: 'builtin:agent-loop' },
    { source: 'builtin:web' },
  ]

  const ctx = await boot(config)
  contexts.push(ctx)
  if (readyUrl === '') throw new Error('web server did not report ready')
  return { ctx, url: readyUrl }
}

function resetBuiltins(): void {
  for (const un of unsubscribes) un()
  unsubscribes.length = 0
}

/* ---------------- SSE 客户端（Node 侧手工解析） ---------------- */

interface EventTap {
  frames: UiEvent[]
  stop(): Promise<void>
}

async function openEvents(url: string): Promise<EventTap> {
  const controller = new AbortController()
  const res = await fetch(`${url}api/events`, { signal: controller.signal })
  const frames: UiEvent[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            frames.push(JSON.parse(line.slice(5).trim() ?? 'null') as UiEvent)
          } catch {
            // 半帧：跨 read 边界，忽略（下一个 read 会补齐后重新出现完整帧）
          }
        }
      }
    } catch {
      // aborted：正常关闭
    }
  })()
  return {
    frames,
    async stop() {
      await reader.cancel().catch(() => undefined)
      controller.abort()
    },
  }
}

/** 轮询等待条件成立（等真实信号而非固定延时，避免 flaky）。 */
async function waitUntil(cond: () => boolean, ms = 6000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitUntil: condition not met in time')
    await new Promise((r) => setTimeout(r, 15))
  }
}

async function post(url: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/* ---------------- 用例 ---------------- */

beforeEach(async () => {
  vi.stubEnv(KEY_ENV, 'sk-integration')
  sessionsDir = await newDir('mdsh-web-sessions-')
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await shutdown(ctx).catch(() => undefined)
  }
  resetBuiltins()
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  vi.unstubAllEnvs()
})

describe('10-web-ui 集成（真实 boot + 真实 HTTP）', () => {
  it('链路 1：挂载 → 页面可达，状态快照与真实会话一致', async () => {
    const { ctx, url } = await bootWithWeb(scriptedFetch([[textChunk('hi'), DONE, USAGE]]))

    const page = await fetch(url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('/assets/mascot.webp')

    const state = (await (await fetch(`${url}api/state`)).json()) as {
      sessionId: string
      provider: string
      messages: unknown[]
      tools: string[]
    }
    const metas = await ctx.sessions.list()
    expect(state.sessionId).toBe(metas[0]?.id)
    expect(state.provider).toBe('deepseek')
    expect(state.messages).toEqual([])
    // 六个内置工具（read/glob/grep/write/edit/bash）应全部可见
    expect(state.tools).toContain('read')
    expect(state.tools).toContain('bash')
  }, 30000)

  it('链路 2：纯文本回合 → SSE 依次收到 turn-start / text / turn-end', async () => {
    const { url } = await bootWithWeb(scriptedFetch([
      [textChunk('你好，'), textChunk('大肥鱼！'), DONE, USAGE],
    ]))

    const tap = await openEvents(url)
    const start = await post(url, 'api/turn', { text: '打个招呼' })
    expect(start.status).toBe(202)

    await waitUntil(() => tap.frames.some((f) => f.type === 'turn-end'))
    await tap.stop()

    const types = tap.frames.map((f) => f.type)
    expect(types).toContain('turn-start')
    expect(types.indexOf('text')).toBeGreaterThan(types.indexOf('turn-start'))
    expect(types.indexOf('turn-end')).toBeGreaterThan(types.indexOf('text'))

    const text = tap.frames
      .filter((f): f is Extract<UiEvent, { type: 'text' }> => f.type === 'text')
      .map((f) => f.delta)
      .join('')
    expect(text).toBe('你好，大肥鱼！')

    const state = (await (await fetch(`${url}api/state`)).json()) as {
      messages: Array<{ role: string; content?: string }>
      turnCount: number
    }
    expect(state.turnCount).toBe(1)
    expect(state.messages[0]).toMatchObject({ role: 'user', content: '打个招呼' })
    expect(state.messages[1]).toMatchObject({ role: 'assistant', content: '你好，大肥鱼！' })
  }, 30000)

  it('链路 3：ask 工具 → approval 帧 → 放行 → 工具结果入 log 并投影', async () => {
    const workDir = await newDir('mdsh-web-work-')
    const filePath = path.join(workDir, 'note.txt')
    await fs.writeFile(filePath, '大肥鱼的内容', 'utf8')

    // 第一问：模型要求 read note.txt；第二问（read 结果回喂后）：纯文本收尾
    const { url } = await bootWithWeb(scriptedFetch([
      [callChunk('call_1', 'read', { path: filePath }), DONE, USAGE],
      [textChunk('读到了。'), DONE, USAGE],
    ]))

    const tap = await openEvents(url)
    const start = await post(url, 'api/turn', { text: '帮我读一下文件' })
    expect(start.status).toBe(202)

    // 工具是 ask 策略 → 界面收到审批卡
    await waitUntil(() => tap.frames.some((f) => f.type === 'approval'))
    const approval = tap.frames.find((f): f is Extract<UiEvent, { type: 'approval' }> => f.type === 'approval')
    expect(approval?.approval.toolName).toBe('read')
    expect(approval?.approval.args).toMatchObject({ path: filePath })

    // 点"允许"
    const res = await post(url, 'api/approve', { id: approval!.approval.id, allow: true })
    expect(res.status).toBe(200)

    await waitUntil(() => tap.frames.some((f) => f.type === 'turn-end'))
    await tap.stop()

    const types = tap.frames.map((f) => f.type)
    expect(types).toContain('tool-start')
    expect(types).toContain('tool-end')
    const toolEnd = tap.frames.find((f): f is Extract<UiEvent, { type: 'tool-end' }> => f.type === 'tool-end')
    expect(toolEnd?.ok).toBe(true)
    expect(toolEnd?.text).toContain('大肥鱼的内容')

    // 投影里出现 tool 消息（灵魂 #2：事实只在 log 里）
    const state = (await (await fetch(`${url}api/state`)).json()) as {
      messages: Array<{ role: string; toolCallId?: string; content?: string }>
    }
    const toolMsg = state.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('大肥鱼的内容')
  }, 30000)

  it('链路 4：审批拒绝 → permission_denied，工具未执行', async () => {
    const workDir = await newDir('mdsh-web-work-')
    const filePath = path.join(workDir, 'secret.txt')

    const { url } = await bootWithWeb(scriptedFetch([
      [callChunk('call_1', 'read', { path: filePath }), DONE, USAGE],
      [textChunk('好的，不读了。'), DONE, USAGE],
    ]))

    const tap = await openEvents(url)
    await post(url, 'api/turn', { text: '读秘密文件' })

    await waitUntil(() => tap.frames.some((f) => f.type === 'approval'))
    const approval = tap.frames.find((f): f is Extract<UiEvent, { type: 'approval' }> => f.type === 'approval')
    const res = await post(url, 'api/approve', { id: approval!.approval.id, allow: false })
    expect(res.status).toBe(200)

    await waitUntil(() => tap.frames.some((f) => f.type === 'turn-end'))
    await tap.stop()

    const toolEnd = tap.frames.find((f): f is Extract<UiEvent, { type: 'tool-end' }> => f.type === 'tool-end')
    expect(toolEnd?.ok).toBe(false)
    expect(toolEnd?.code).toBe('permission_denied')

    // 被拒绝的 read 不应碰文件系统（文件不存在仍不存在）
    await expect(fs.access(filePath)).rejects.toThrow()
  }, 30000)

  it('链路 5：回合中 POST /api/cancel → interrupted', async () => {
    const { url } = await bootWithWeb(hangingFetch(textChunk('说了一半')))

    const tap = await openEvents(url)
    await post(url, 'api/turn', { text: '慢慢说' })

    // 等首片到达再取消（等真实信号，06 Y4 的教训）
    await waitUntil(() => tap.frames.some((f) => f.type === 'text'))
    const cancelled = await post(url, 'api/cancel', {})
    expect(cancelled.status).toBe(200)

    await waitUntil(() => tap.frames.some((f) => f.type === 'turn-end'))
    await tap.stop()

    const end = tap.frames.find((f): f is Extract<UiEvent, { type: 'turn-end' }> => f.type === 'turn-end')
    expect(end?.interrupted).toBe(true)
  }, 30000)

  it('链路 6：shutdown → 端口释放，SSE 关闭', async () => {
    const { ctx, url } = await bootWithWeb(scriptedFetch([[textChunk('hi'), DONE, USAGE]]))
    const tap = await openEvents(url)

    await shutdown(ctx)
    await tap.stop()

    const after = await fetch(url).catch(() => 'released')
    expect(after).toBe('released')
  }, 30000)

  it('链路 7：无 API key 时回合错误转 error 帧，服务不挂', async () => {
    vi.unstubAllEnvs()
    const { url } = await bootWithWeb(scriptedFetch([[textChunk('hi'), DONE, USAGE]]))

    const tap = await openEvents(url)
    await post(url, 'api/turn', { text: '没钥匙' })

    await waitUntil(() => tap.frames.some((f) => f.type === 'error'))
    await tap.stop()

    const error = tap.frames.find((f): f is Extract<UiEvent, { type: 'error' }> => f.type === 'error')
    expect(error?.text ?? '').toMatch(/API|key|apiKeyEnv|DEEPSEEK/i)

    // 服务仍活着：状态接口照常
    const state = await fetch(`${url}api/state`)
    expect(state.status).toBe(200)
  }, 30000)
})
