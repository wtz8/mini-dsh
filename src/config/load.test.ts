import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigError } from '../errors.js'
import { loadConfig } from './load.js'

/**
 * loadConfig 单元测试（设计 §6.1）：三层优先级、缺文件跳过、文件级错误、
 * 字段校验失败，以及"返回值未冻结"的回归点。
 */

/** 建临时目录（注册进清理列表，afterEach 统一删除）。 */
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidsh-config-'))
  created.push(dir)
  return dir
}

/** 写一层配置文件。 */
async function writeLayer(dir: string, name: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, name), JSON.stringify(value), 'utf8')
}

const created: string[] = []
afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('loadConfig · 三层合并与优先级', () => {
  it('flags > project > global > defaults', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { contextWindow: 1000, logLevel: 'warn' })
    await writeLayer(projectDir, 'minidsh.json', { contextWindow: 2000, tools: { maxParallel: 8 } })

    const config = await loadConfig({
      globalDir,
      projectDir,
      flags: { contextWindow: 3000 },
    })

    expect(config.contextWindow).toBe(3000) // flags 最高
    expect(config.logLevel).toBe('warn') // 仅全局层给
    expect(config.tools.maxParallel).toBe(8) // 仅项目层给
    expect(config.tools.bash.timeoutMs).toBe(120_000) // 无人覆盖 → 默认值
  })

  it('嵌套对象逐键合并，未被覆盖的键保留下层值', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { model: { provider: 'openai', name: 'gpt-4' } })
    await writeLayer(projectDir, 'minidsh.json', { model: { name: 'gpt-4o' } })

    const config = await loadConfig({ globalDir, projectDir })
    expect(config.model).toEqual({
      provider: 'openai', // 全局层保留
      name: 'gpt-4o', // 项目层覆盖
      baseUrl: 'https://api.deepseek.com', // 默认值
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
  })

  it('plugins 数组整值替换，不拼接', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { plugins: [{ source: 'builtin:llm' }] })
    await writeLayer(projectDir, 'minidsh.json', { plugins: [{ source: 'builtin:tools' }] })

    const config = await loadConfig({ globalDir, projectDir })
    expect(config.plugins).toEqual([{ source: 'builtin:tools' }])
  })

  it('permissions 跨层逐键合并：同名键被上层覆盖，异名键保留', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { permissions: { bash: 'auto', read: 'auto' } })
    await writeLayer(projectDir, 'minidsh.json', { permissions: { bash: 'deny' } })

    const config = await loadConfig({ globalDir, projectDir })
    // 注意是逐键合并而非整值替换：全局层的 read 保留，仅 bash 被项目层覆盖
    expect(config.permissions).toEqual({ bash: 'deny', read: 'auto' })
  })

  it('flags 中值为 undefined 的字段不覆盖下层', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(projectDir, 'minidsh.json', { contextWindow: 4096 })

    const config = await loadConfig({
      globalDir,
      projectDir,
      flags: { contextWindow: undefined, logLevel: 'debug' },
    })

    expect(config.contextWindow).toBe(4096)
    expect(config.logLevel).toBe('debug')
  })
})

describe('loadConfig · 文件缺失与默认值', () => {
  it('两层文件都不存在时跳过，返回纯默认值', async () => {
    const config = await loadConfig({ globalDir: await tempDir(), projectDir: await tempDir() })

    expect(config.contextWindow).toBe(131_072)
    expect(config.logLevel).toBe('info')
    expect(config.plugins).toEqual([])
  })

  it('UTF-8 BOM 开头的文件可正常解析（X5：记事本保存的配置不得启动失败）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    // 前导 U+FEFF：Windows 记事本保存 UTF-8 时的默认行为，JSON.parse 本身不认
    await fs.writeFile(path.join(globalDir, 'config.json'), '\uFEFF{"contextWindow": 4096}', 'utf8')

    const config = await loadConfig({ globalDir, projectDir })
    expect(config.contextWindow).toBe(4096)
  })

  it('目录不存在（ENOENT）同样视为该层缺失，不报错', async () => {
    const dir = await tempDir()
    const config = await loadConfig({
      globalDir: path.join(dir, 'no-such-dir'),
      projectDir: path.join(dir, 'also-missing'),
    })

    expect(config.contextWindow).toBe(131_072)
  })
})

describe('loadConfig · 文件级错误', () => {
  it('JSON 语法错误 → ConfigError 带 file', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await fs.writeFile(path.join(globalDir, 'config.json'), '{ not json', 'utf8')

    await expect(loadConfig({ globalDir, projectDir })).rejects.toMatchObject({
      name: 'ConfigError',
      file: path.join(globalDir, 'config.json'),
    })
  })

  it('空文件也属 JSON 非法（不是"该层缺失"）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await fs.writeFile(path.join(projectDir, 'minidsh.json'), '', 'utf8')

    await expect(loadConfig({ globalDir, projectDir })).rejects.toBeInstanceOf(ConfigError)
  })

  it('顶层不是对象（数组 / 字符串 / null）→ ConfigError', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(projectDir, 'minidsh.json', ['builtin:llm'])

    await expect(loadConfig({ globalDir, projectDir })).rejects.toBeInstanceOf(ConfigError)
  })

  it('其它 IO 错误（路径是目录 → EISDIR）不降级为"跳过"', async () => {
    const globalDir = await tempDir()
    // 把项目配置文件名建成目录，readFile 会以 EISDIR 失败
    await fs.mkdir(path.join(globalDir, 'minidsh.json'))

    await expect(loadConfig({ globalDir, projectDir: globalDir })).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('loadConfig · 校验失败与冻结归属', () => {
  it('合并结果非法 → ConfigError 带字段路径（全局层的错值也会被 flags 后的校验抓到）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    await writeLayer(globalDir, 'config.json', { contextWindow: 0 })

    const err = await loadConfig({ globalDir, projectDir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).path).toBe('config.contextWindow')
  })

  it('返回值未被冻结（deepFreeze 归属恒定为 boot）', async () => {
    const config = await loadConfig({ globalDir: await tempDir(), projectDir: await tempDir() })

    expect(Object.isFrozen(config)).toBe(false)
    expect(() => {
      config.contextWindow = 1
    }).not.toThrow()
  })

  it('同进程内多次加载互不污染（默认值为工厂产出，D5）', async () => {
    const globalDir = await tempDir()
    const projectDir = await tempDir()
    const first = await loadConfig({ globalDir, projectDir })
    first.tools.maxParallel = 99

    const second = await loadConfig({ globalDir, projectDir })
    expect(second.tools.maxParallel).toBe(4)
  })
})
