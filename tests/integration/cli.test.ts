import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config, Ctx, Unsubscribe } from '../../src/index.js'
import { boot, definePlugin, registerBuiltin, shutdown } from '../../src/index.js'
import { createAgentPlugin } from '../../src/agent/index.js'
import { createDefaultConfig } from '../../src/config/index.js'
import { createLlmPlugin } from '../../src/llm/index.js'
import type { FetchLike } from '../../src/llm/index.js'
import { createPromptPlugin } from '../../src/prompt/index.js'
import { createSessionPlugin } from '../../src/session/index.js'
import { createToolsPlugin } from '../../src/tools/index.js'
import {
  createApproveHandler,
  createCli,
  main,
  withDefaultPlugins,
} from '../../src/cli/index.js'
import type { CliHandle, CliIO, LineReader, ProjectAudit } from '../../src/cli/index.js'
import { initialSessionId } from '../../src/cli/main.js'

/**
 * 07-cli 集成测试（设计 §6.2）：**真实组合根 + 真实 JSONL 会话 + 真实工具 +
 * 真实 prompt 段**，只在两个出口注入伪实现——网络（伪 fetch，与 02/06 集成同式）
 * 与终端（伪 stdin/stdout/stderr）。
 *
 * 九条链路对应 §6.2：默认 plugins / 一问一答 / 审批放行 / 审批拒绝 / 两段式中断 /
 * LlmError 分类 / resume / 项目配置信任确认 / dispose 超时兜底。
 */

const KEY_ENV = 'DEEPSEEK_API_KEY'

/** 一次请求的响应：一组 SSE 分片，或一个 HTTP 状态码（用于错误链路）。 */
type Queued = Array<string> | number

interface Fake {
  fetchImpl: FetchLike
  calls: Array<{ body: string }>
}

/** 按队列依次应答：队列项是分片数组或状态码。 */
function queuedFetch(queue: Queued[]): Fake {
  const calls: Array<{ body: string }> = []
  const encoder = new TextEncoder()
  const fetchImpl = ((_url: unknown, init?: RequestInit) => {
    calls.push({ body: String(init?.body ?? '{}') })
    const item = queue.shift() ?? []
    if (typeof item === 'number') {
      return Promise.resolve(new Response('provider error', { status: item }))
    }
    const chunks = item
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

/** 只发一片就挂住的伪 fetch（取消链路用）：signal 触发时把流置错。 */
function hangingFetch(firstChunk: string): Fake {
  const calls: Array<{ body: string }> = []
  const encoder = new TextEncoder()
  const fetchImpl = ((_url: unknown, init?: RequestInit) => {
    calls.push({ body: String(init?.body ?? '{}') })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstChunk))
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'))
          } catch {
            /* 已关闭则忽略 */
          }
        })
      },
    })
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  }) as unknown as FetchLike
  return { fetchImpl, calls }
}

function textChunk(delta: string): string {
  return `data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}\n\n`
}

function doneChunk(): string {
  return 'data: [DONE]\n\n'
}

const USAGE = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n'

/** 脚本化输入：`null` = EOF，`'HANG'` = 这一次读取永不返回（模拟用户还没敲）。 */
type Script = Array<string | null | 'HANG'>

/**
 * 伪 IO。
 *
 * 注意：`out` / `err` 是 `CliIO` 的**写入**方法，读取方法必须另取名字
 * （否则对象字面量里后写的同名键会静默覆盖写入方法）。
 */
interface FakeIO extends CliIO {
  readonly outLines: string[]
  readonly errLines: string[]
  stdout(): string
  stderr(): string
}

function fakeIO(inputs: Script): FakeIO {
  const outLines: string[] = []
  const errLines: string[] = []
  let index = 0
  /** `HANG` 的兑现口（close 时以 null 唤醒）。 */
  let wake: ((line: string | null) => void) | undefined
  const lines: LineReader = {
    next: async () => {
      const item = inputs[index++]
      if (item === 'HANG') return await new Promise<string | null>((resolve) => (wake = resolve))
      return item ?? null
    },
    ask: async (prompt) => {
      outLines.push(prompt)
      const item = inputs[index++]
      if (item === 'HANG') return await new Promise<string | null>((resolve) => (wake = resolve))
      return item ?? null
    },
    interrupt: () => undefined,
    close: () => {
      wake?.(null)
      wake = undefined
    },
  }
  const io: FakeIO = {
    out: (text) => outLines.push(text),
    err: (text) => errLines.push(text),
    lines,
    isTTY: true,
    outLines,
    errLines,
    stdout: () => outLines.join(''),
    stderr: () => errLines.join(''),
  }
  return io
}

/** 轮询等待条件成立（避免依赖固定 sleep）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: 条件在超时前未成立')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const unsubscribes: Array<Unsubscribe> = []
const contexts: Ctx[] = []
const tempDirs: string[] = []
let workDir: string
let sessionsDir: string

async function newDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 清空全部 builtin 注册（同进程内第二次 boot 前必须调用，否则同名重复注册抛错）。 */
function resetBuiltins(): void {
  for (const off of unsubscribes) off()
  unsubscribes.length = 0
}

function makeConfig(patch: Partial<Config> = {}): Config {
  const config = createDefaultConfig()
  config.model.apiKeyEnv = KEY_ENV
  Object.assign(config, patch)
  return config
}

interface Harness {
  ctx: Ctx
  config: Config
  io: FakeIO
  handle: CliHandle
}

/**
 * 装配一套"07 式的 CLI"：默认插件表 + 伪 fetch + 伪终端 + 审批通道。
 *
 * 与 `main()` 的差别只在注入点（fetch / session 目录 / IO），装配顺序与 §4.1 一致。
 */
async function bootCli(options: {
  fake: Fake
  inputs: Script
  patch?: Partial<Config>
  resume?: string
  /** 项目层体检结果（O6）；传入则横幅会多出提示行 */
  audit?: ProjectAudit
}): Promise<Harness> {
  const io = fakeIO(options.inputs)
  // O1：这里刻意喂 plugins 为空的配置，让 withDefaultPlugins 去补——补不出来
  // 后面所有链路都跑不起来
  const base = makeConfig(options.patch)
  base.plugins = []
  const config = withDefaultPlugins(base)
  expect(config.plugins.map((entry) => entry.source)).toContain('builtin:agent-loop')

  unsubscribes.push(registerBuiltin('llm', createLlmPlugin({ fetchImpl: options.fake.fetchImpl })))
  unsubscribes.push(registerBuiltin('session', createSessionPlugin({ dir: sessionsDir })))
  unsubscribes.push(registerBuiltin('prompt', createPromptPlugin()))
  unsubscribes.push(registerBuiltin('tools', createToolsPlugin()))

  const approve = createApproveHandler(io)
  let agentUnsub = registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId: options.resume }))
  unsubscribes.push(() => agentUnsub())

  let ctx = await boot(config)
  contexts.push(ctx)

  const restart = async (id: string): Promise<Ctx | undefined> => {
    await shutdown(ctx)
    agentUnsub()
    agentUnsub = registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId: id }))
    try {
      ctx = await boot(config)
      contexts.push(ctx)
      return ctx
    } catch (err) {
      io.err(`${err instanceof Error ? err.message : String(err)}\n`)
      return undefined
    }
  }

  // O7：会话 id 的推定必须是真实实现（initialSessionId），不能抄一份——
  // 少了这一步，横幅与 /session 恒为 unknown，O7 在集成层等于零覆盖
  const sessionId = await initialSessionId(ctx, options.resume)
  const handle = createCli({ ctx, config, io, restart, sessionId, audit: options.audit })
  return { ctx, config, io, handle }
}

beforeEach(async () => {
  vi.stubEnv(KEY_ENV, 'sk-integration')
  workDir = await newDir('mdsh-cli-it-')
  sessionsDir = await newDir('mdsh-cli-sessions-')
})

afterEach(async () => {
  for (const ctx of contexts) await shutdown(ctx)
  contexts.length = 0
  resetBuiltins()
  vi.unstubAllEnvs()
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('07-cli 集成', () => {
  it('链路 1 · 默认 plugins 生效（O1）+ 一问一答：流式渲染与回合摘要', async () => {
    const fake = queuedFetch([[textChunk('你好'), USAGE, doneChunk()]])
    const h = await bootCli({ fake, inputs: ['你好吗', null] })

    const code = await h.handle.start()
    expect(code).toBe(0)

    // 默认表的实质：工具段进了系统提示、agent 控制面可用
    expect(h.ctx.tools.list().length).toBeGreaterThan(0)
    expect(h.ctx.prompt.render()).toContain('read')
    expect(() => h.ctx.agent.resolve()).not.toThrow()

    const stdout = h.io.stdout()
    expect(stdout).toContain('你好') // 流式增量
    expect(stdout).toContain('turn 1')
    expect(stdout).toContain('steps 1')
    expect(stdout).toContain('7/3') // usage：input/output
    expect(h.io.stderr()).toBe('')
  })

  it('链路 2 · 审批放行（y ⇒ ask 工具真实执行并落 log）', async () => {
    const target = path.join(workDir, 'out.txt')
    const fake = queuedFetch([
      [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'write', arguments: JSON.stringify({ path: target, content: 'hi' }) } },
                ],
              },
            },
          ],
        })}\n\n`,
        doneChunk(),
      ],
      [textChunk('写好了'), doneChunk()],
    ])

    const h = await bootCli({ fake, inputs: ['写个文件', 'y', null] })
    expect(await h.handle.start()).toBe(0)

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('hi')
    const stdout = h.io.stdout()
    expect(stdout).toContain('需要授权') // 审批提示
    expect(stdout).toContain('write') // 工具行
    expect(stdout).toContain('↳ ✓')
  })

  it('链路 3 · 审批拒绝（n ⇒ 失败关闭，工具未执行）', async () => {
    const target = path.join(workDir, 'denied.txt')
    const fake = queuedFetch([
      [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'write', arguments: JSON.stringify({ path: target, content: 'hi' }) } },
                ],
              },
            },
          ],
        })}\n\n`,
        doneChunk(),
      ],
      [textChunk('好的不写'), doneChunk()],
    ])

    const h = await bootCli({ fake, inputs: ['写个文件', 'n', null] })
    expect(await h.handle.start()).toBe(0)

    await expect(fs.stat(target)).rejects.toThrow() // 文件根本没被创建
    const stdout = h.io.stdout()
    expect(stdout).toContain('↳ ✗ permission_denied')
    expect(stdout).toContain('好的不写') // 回合继续到第二步
  })

  it('链路 4 · 两段式中断：第一次取消回合，第二次退出（O3）', async () => {
    const fake = hangingFetch(textChunk('开始说'))
    const h = await bootCli({ fake, inputs: ['讲个故事', 'HANG'] })

    const done = h.handle.start()
    await waitFor(() => fake.calls.length > 0)

    h.handle.interrupt() // 第一段：取消在途回合
    await waitFor(() => h.io.stdout().includes('turn 1')) // 回合已收尾（摘要行）

    h.handle.interrupt() // 第二段：退出
    expect(await done).toBe(0)

    const stdout = h.io.stdout()
    expect(stdout).toContain('已请求取消')
    expect(stdout).toContain('正在退出')
    expect(stdout).toContain('已取消')
  })

  it('链路 5 · LlmError 分类：500 打印诊断后 REPL 继续（D4）', async () => {
    const fake = queuedFetch([500, [textChunk('这次好了'), doneChunk()]])
    const h = await bootCli({ fake, inputs: ['第一次', '第二次', null] })

    const code = await h.handle.start()
    expect(code).toBe(0)

    const stderr = h.io.stderr()
    expect(stderr).toContain('llm:')
    expect(stderr).toContain('500')
    // 会话没丢：第二次输入照样跑通
    expect(h.io.stdout()).toContain('这次好了')
    expect(fake.calls).toHaveLength(2)
  })

  it('链路 6 · --resume 与 /resume：跨内核继续同一会话的 turn 计数', async () => {
    // 阶段一：造一个跑过一回合的会话
    const first = await bootCli({ fake: queuedFetch([[textChunk('第一回合'), doneChunk()]]), inputs: ['1', null] })
    await first.handle.start()
    const metas = await first.ctx.sessions.list()
    const sessionId = metas[0]?.id ?? ''
    expect(sessionId).not.toBe('')

    // 阶段二：--resume 到它，turn 从 log 继续
    resetBuiltins()
    const second = await bootCli({
      fake: queuedFetch([[textChunk('第二回合'), doneChunk()], [textChunk('第三回合'), doneChunk()]]),
      inputs: ['2', `/resume ${sessionId}`, '/session', '3', null],
      resume: sessionId,
    })
    expect(await second.handle.start()).toBe(0)

    const stdout = second.io.stdout()
    expect(stdout).toContain('turn 2') // resume 成功：计数接着上一会话
    expect(stdout).toContain('已切换到会话') // /resume 触发内核重启
    expect(stdout).toContain('turn 3') // 重启后仍在同一会话，计数继续
    // 重启后 /session 必须显示切换到的那个 id（此前只断言了文案，id 错了也照样绿）
    expect(stdout).toContain(`会话 ${sessionId} · 已跑回合`)
    expect(second.ctx.agent.resolve().sessionId).toBe(sessionId)
  })

  it('链路 6b · 会话 id 取自控制面（Y4）而非 list 推定：多会话下 /session 是本次新建那条', async () => {
    // X1 的教训：id 不能靠订阅 header 事件取。Y4 之后取 `AgentControl.sessionId`——
    // 确定取值，不再有"同毫秒 createdAt 推定错"的边界。这条链路锁住它。
    const first = await bootCli({ fake: queuedFetch([[textChunk('旧回合'), doneChunk()]]), inputs: ['1', null] })
    await first.handle.start()
    const olderId = (await first.ctx.sessions.list())[0]?.id ?? ''
    expect(olderId).not.toBe('')

    resetBuiltins()
    const second = await bootCli({ fake: queuedFetch([[textChunk('新回合'), doneChunk()]]), inputs: ['/session', null] })
    expect(await second.handle.start()).toBe(0)

    const fromAgent = second.ctx.agent.resolve().sessionId
    const shown = /会话 (\S+) · 已跑回合/.exec(second.io.stdout())?.[1] ?? ''
    expect(await second.ctx.sessions.list()).toHaveLength(2) // 确实新建了一个
    expect(fromAgent).not.toBe(olderId) // 控制面绑定的是新建会话
    expect(shown).not.toBe('unknown')
    expect(shown).toBe(fromAgent) // UI 显示的就是控制面的 id，不经过 list 推定
    expect(shown).not.toBe(olderId)
  })

  it('链路 6c · --resume 不存在的会话 ⇒ 启动期 BootError ⇒ 退出码 1（O4）', async () => {
    // 06 §8-Q1：会话在 setup 内 open，不存在的 id 应当在**启动期**失败，
    // 而不是等用户敲下第一个回车才炸。此前集成只测了 resume 的成功路径。
    resetBuiltins()
    vi.stubEnv(KEY_ENV, 'sk-integration')
    vi.stubEnv('USERPROFILE', await newDir('mdsh-cli-home-'))

    const io = fakeIO([null])
    const code = await main(['--resume', 'no-such-session'], io)

    expect(code).toBe(1) // 启动期错误：退出码 1，不是"打印后继续"
    expect(io.stderr()).toContain('启动失败')
    expect(io.stderr()).toContain('已挂载插件') // BootError 的 mounted 名单
    expect(io.stdout()).not.toContain('mdsh 0.1.0') // 横幅都没打出来
  })

  it('链路 7b · 横幅的项目配置提示行（O6 的可见部分）', async () => {
    const audit: ProjectAudit = {
      file: path.join('project', 'minidsh.json'),
      localPlugins: ['./toy.mjs'],
      overridesEndpoint: true,
      insecureEndpoint: true,
    }
    const h = await bootCli({ fake: queuedFetch([[textChunk('好'), doneChunk()]]), inputs: [null], audit })
    expect(await h.handle.start()).toBe(0)

    const stdout = h.io.stdout()
    expect(stdout).toContain('改写了接入点或凭据来源') // overridesEndpoint
    expect(stdout).toContain('明文 http 且非本机') // insecureEndpoint
  })

  it('链路 7 · 项目配置信任确认（F-02）：拒绝退出码 1，--trust-project 放行', async () => {
    resetBuiltins()
    const projectDir = await newDir('mdsh-cli-project-')
    await fs.writeFile(path.join(projectDir, 'minidsh.json'), JSON.stringify({ plugins: [{ source: './toy.mjs' }] }))
    await fs.writeFile(path.join(projectDir, 'toy.mjs'), "export default () => ({ name: 'toy', setup() {} })\n")
    const cwdBefore = process.cwd()
    process.chdir(projectDir)
    // main 内部用默认 home：挪到临时目录，避免污染真实 ~/.minidsh
    vi.stubEnv('USERPROFILE', await newDir('mdsh-cli-home-'))

    try {
      const denied = fakeIO(['n'])
      expect(await main([], denied)).toBe(1)
      expect(denied.stderr()).toContain('--trust-project')

      const allowed = fakeIO([null])
      expect(await main(['--trust-project'], allowed)).toBe(0)
      expect(allowed.stdout()).toContain('mdsh 0.1.0')
    } finally {
      process.chdir(cwdBefore)
    }
  })

  it(
    '链路 8 · dispose 超时兜底（O5）：挂起的插件不会让退出流程永不返回',
    async () => {
      resetBuiltins()
      const homeDir = await newDir('mdsh-cli-home-')
      const globalDir = path.join(homeDir, '.minidsh')
      await fs.mkdir(globalDir, { recursive: true })
      await fs.writeFile(
        path.join(globalDir, 'config.json'),
        JSON.stringify({
          plugins: [
            { source: 'builtin:llm' },
            { source: 'builtin:session' },
            { source: 'builtin:prompt' },
            { source: 'builtin:tools' },
            { source: 'builtin:agent-loop' },
            { source: 'builtin:stuck' },
          ],
        }),
      )
      vi.stubEnv(KEY_ENV, 'sk-integration')
      vi.stubEnv('USERPROFILE', homeDir)

      // 一个 dispose 永不返回的插件：内核不设超时，兜底责任在 07
      const off = registerBuiltin(
        'stuck',
        definePlugin(() => ({
          name: 'stuck',
          setup: () => undefined,
          dispose: () => new Promise<void>(() => undefined),
        })),
      )

      const started = Date.now()
      const code = await main(['--config-dir', globalDir], fakeIO([null]))
      const elapsed = Date.now() - started
      off()

      expect(code).toBe(0)
      expect(elapsed).toBeGreaterThanOrEqual(2500) // 真的等到了兜底窗口（3s）
      // 上界放得比"3s + 调度抖动"宽得多：全量并行跑 60 个测试文件时机器负载高，
      // 卡几秒很常见；真正要守的是"没被永久挂住"，测试用例自身 15s 超时是最后防线
      expect(elapsed).toBeLessThan(12_000)
    },
    15000,
  )
})
