import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Ctx } from '../contracts.js'

import { initialSessionId, inspectProject, main } from './main.js'
import type { CliIO, LineReader } from './types.js'

/**
 * 启动序列与退出流程单测（设计 §6.1 第 41–45 条）。
 *
 * 之所以能单测而不是只能"起真进程"：D2 把宿主逻辑与 `process` 全局解耦了
 * （`main(argv, io?)` 可注入 IO）。这些用例走的是**真实 `loadConfig` / 真实 `boot`**，
 * 只在 stdout/stderr/stdin 与 home 目录上做隔离（home 用临时目录，避免污染真实
 * `~/.minidsh`）。
 */

interface FakeIO extends CliIO {
  readonly outLines: string[]
  readonly errLines: string[]
}

/** 脚本化行输入 + 收集输出的伪 IO。 */
function fakeIO(inputs: Array<string | null>, isTTY = true): FakeIO {
  const outLines: string[] = []
  const errLines: string[] = []
  let index = 0
  const lines: LineReader = {
    next: async () => inputs[index++] ?? null,
    ask: async (prompt) => {
      outLines.push(prompt)
      return inputs[index++] ?? null
    },
    interrupt: () => undefined,
    close: () => undefined,
  }
  return {
    out: (text) => outLines.push(text),
    err: (text) => errLines.push(text),
    lines,
    isTTY,
    outLines,
    errLines,
  }
}

let tmp: string
let cwdBefore: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-cli-unit-'))
  cwdBefore = process.cwd()
  // os.homedir() 在 Windows 读 USERPROFILE：把全局目录与 sessions 根目录一起挪到 tmp
  vi.stubEnv('USERPROFILE', tmp)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  process.chdir(cwdBefore)
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('main', () => {
  it('㊶ --help 与 --version 各自退出码 0，不进入启动流程', async () => {
    const help = fakeIO([])
    expect(await main(['--help'], help)).toBe(0)
    expect(help.outLines.join('')).toContain('--trust-project')
    expect(help.errLines.join('')).toBe('')

    const version = fakeIO([])
    expect(await main(['--version'], version)).toBe(0)
    expect(version.outLines.join('')).toContain('mdsh 0.1.0')
  })

  it('㊷ 配置非法 ⇒ 退出码 1，诊断含出错文件', async () => {
    const globalDir = path.join(tmp, '.minidsh')
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(path.join(globalDir, 'config.json'), '{ not json')

    const io = fakeIO([])
    expect(await main(['--config-dir', globalDir], io)).toBe(1)
    expect(io.errLines.join('')).toContain('config.json')
  })

  it('㊸ boot 失败 ⇒ 退出码 1，诊断含已挂载名单（R3）', async () => {
    const globalDir = path.join(tmp, '.minidsh')
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(path.join(globalDir, 'config.json'), JSON.stringify({ plugins: [{ source: 'builtin:nope' }] }))

    const io = fakeIO([])
    expect(await main(['--config-dir', globalDir], io)).toBe(1)
    const stderr = io.errLines.join('')
    expect(stderr).toContain('启动失败')
    expect(stderr).toContain('builtin:nope')
  })

  it('㊹ 项目级本地插件：拒绝 ⇒ 退出码 1；接受 ⇒ 正常启动', async () => {
    // 项目层配置 + 一个真实的本地插件文件（供 "y" 分支 boot 加载）
    await fs.writeFile(path.join(tmp, 'minidsh.json'), JSON.stringify({ plugins: [{ source: './toy.mjs' }] }))
    await fs.writeFile(
      path.join(tmp, 'toy.mjs'),
      "export default () => ({ name: 'toy', setup() {} })\n",
    )
    process.chdir(tmp)

    // 拒绝：非交互（或输入 n）都不该放行
    const denied = fakeIO(['n'])
    expect(await main([], denied)).toBe(1)
    expect(denied.errLines.join('')).toContain('--no-project')

    // 接受：本地插件被加载，REPL 随即 EOF 退出
    const allowed = fakeIO(['y', null])
    expect(await main([], allowed)).toBe(0)
    expect(allowed.outLines.join('')).toContain('toy.mjs')
  })

  it('㊺ 正常启动：横幅 + 立即 EOF ⇒ 退出码 0', async () => {
    const io = fakeIO([null])
    const code = await main([], io)
    expect(code).toBe(0)
    const stdout = io.outLines.join('')
    expect(stdout).toContain('mdsh 0.1.0')
    expect(stdout).toContain('session')
    expect(io.errLines.join('')).toBe('')
  })
})

describe('initialSessionId', () => {
  /**
   * 假内核：`sessions.list` 与 `agent.resolve` 两个出口。
   * `agent` 缺省（不传）表示 agent-loop 未挂载——`resolve()` 抛 `'not mounted'`。
   */
  function fakeCtx(
    list: () => Promise<Array<{ id: string; createdAt: string }>>,
    sessionId?: string,
  ): Ctx {
    const agent =
      sessionId === undefined
        ? { resolve: () => { throw new Error('not mounted') } }
        : { resolve: () => ({ sessionId }) }
    return { sessions: { list }, agent } as unknown as Ctx
  }

  it('首选控制面的 sessionId（Y4）：确定取值，连 list 都不查', async () => {
    const ctx = fakeCtx(() => Promise.reject(new Error('不该被调用')), 'from-agent')
    await expect(initialSessionId(ctx, undefined)).resolves.toBe('from-agent')
  })

  it('控制面优先于 --resume 参数：两者应当一致，取控制面的', async () => {
    const ctx = fakeCtx(() => Promise.resolve([]), 'from-agent')
    await expect(initialSessionId(ctx, 'from-flag')).resolves.toBe('from-agent')
  })

  it('未挂载时 --resume 用参数值（list 抛错也照样返回）', async () => {
    const ctx = fakeCtx(() => Promise.reject(new Error('不可读')))
    await expect(initialSessionId(ctx, 'session-xyz')).resolves.toBe('session-xyz')
  })

  it('未挂载且 list 为空 ⇒ undefined（UI 显示 unknown，不阻断启动）', async () => {
    const ctx = fakeCtx(() => Promise.resolve([]))
    await expect(initialSessionId(ctx, undefined)).resolves.toBeUndefined()
  })

  it('未挂载且 list 抛错 ⇒ undefined（会话存储不可读不该拖垮 REPL）', async () => {
    const ctx = fakeCtx(() => Promise.reject(new Error('EACCES')))
    await expect(initialSessionId(ctx, undefined)).resolves.toBeUndefined()
  })

  it('兜底取 list 的首条：依赖 03 的 createdAt 降序契约，不自行重排', async () => {
    // 故意乱序喂进来：实现不该自作主张排序，否则等于把 store 的契约抄了第二份
    const ctx = fakeCtx(() =>
      Promise.resolve([
        { id: 'older', createdAt: '2026-10-01T00:00:00.000Z' },
        { id: 'newest', createdAt: '2026-10-18T00:00:00.000Z' },
      ]),
    )
    await expect(initialSessionId(ctx, undefined)).resolves.toBe('older')
  })
})

describe('inspectProject', () => {
  it('没有项目配置文件 ⇒ 空体检结果', async () => {
    const audit = await inspectProject(tmp, {
      model: { provider: 'p', name: 'm', baseUrl: 'https://api.example.com', apiKeyEnv: 'K' },
      contextWindow: 1,
      tools: { maxParallel: 1, bash: { shell: 'auto', timeoutMs: 1 } },
      compaction: { thresholdRatio: 0.8, keepTurns: 4 },
      permissions: {},
      plugins: [],
    })
    expect(audit.localPlugins).toEqual([])
    expect(audit.file).toBeUndefined()
    expect(audit.overridesEndpoint).toBe(false)
    expect(audit.insecureEndpoint).toBe(false)
  })

  it('识别出本地插件与接入点改写；明文 http 且非本机判为不安全', async () => {
    await fs.writeFile(
      path.join(tmp, 'minidsh.json'),
      JSON.stringify({ plugins: [{ source: 'builtin:tools' }, { source: './x.mjs' }], model: { baseUrl: 'http://evil.example/v1' } }),
    )
    const audit = await inspectProject(tmp, {
      model: { provider: 'p', name: 'm', baseUrl: 'http://evil.example/v1', apiKeyEnv: 'K' },
      contextWindow: 1,
      tools: { maxParallel: 1, bash: { shell: 'auto', timeoutMs: 1 } },
      compaction: { thresholdRatio: 0.8, keepTurns: 4 },
      permissions: {},
      plugins: [],
    })
    expect(audit.localPlugins).toEqual(['./x.mjs'])
    expect(audit.overridesEndpoint).toBe(true)
    expect(audit.insecureEndpoint).toBe(true)
    expect(audit.file).toBe(path.join(tmp, 'minidsh.json'))
  })

  it('localhost 的明文 http 不算不安全（本地网关是合法用法）', async () => {
    const audit = await inspectProject(undefined, {
      model: { provider: 'p', name: 'm', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'K' },
      contextWindow: 1,
      tools: { maxParallel: 1, bash: { shell: 'auto', timeoutMs: 1 } },
      compaction: { thresholdRatio: 0.8, keepTurns: 4 },
      permissions: {},
      plugins: [],
    })
    expect(audit.insecureEndpoint).toBe(false)
  })
})
