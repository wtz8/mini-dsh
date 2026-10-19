import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Ctx, PromptSection, ToolDefinition } from '../../src/index.js'
import { createMemoryPlugin, MEMORY_PLUGIN_NAME } from './plugin.js'
import { DEFAULT_MEMORY_FILE } from './types.js'

/**
 * plugin.ts 单测（设计 §6.1，伪 ctx）：插件形状 / 注册行为 /
 * 实例配置优先级与 narrow 防线 / 默认接线。
 */

/** 捕获注册的伪 ctx（只实现本插件用到的两个面）。 */
function fakeCtx(): { ctx: Ctx; sections: PromptSection[]; tools: ToolDefinition[] } {
  const sections: PromptSection[] = []
  const tools: ToolDefinition[] = []
  const ctx = {
    prompt: { section: (s: PromptSection) => sections.push(s) },
    tools: { register: (d: ToolDefinition) => tools.push(d) },
  } as unknown as Ctx
  return { ctx, sections, tools }
}

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdsh-mem-plugin-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('createMemoryPlugin', () => {
  it('插件形状：固定名字 + setup 函数（过 00 的 assertPlugin 语义）', async () => {
    const plugin = await createMemoryPlugin()()
    expect(plugin.name).toBe(MEMORY_PLUGIN_NAME)
    expect(typeof plugin.setup).toBe('function')
  })

  it('setup 注册一个段与一个工具', async () => {
    const { ctx, sections, tools } = fakeCtx()
    const plugin = await createMemoryPlugin()()
    plugin.setup(ctx, undefined)
    expect(sections.map((s) => s.id)).toEqual(['memory/main'])
    expect(tools.map((t) => t.name)).toEqual(['memory'])
  })

  it('实例配置 file 优先于构造选项（经段渲染的路径可观测）', async () => {
    const fromConfig = path.join(dir, 'from-config.md')
    const fromOptions = path.join(dir, 'from-options.md')
    const { ctx, sections } = fakeCtx()
    const plugin = await createMemoryPlugin({ file: fromOptions })()
    plugin.setup(ctx, { file: fromConfig })
    // 文件不存在时段为 ''，无法观测路径——写入 fromConfig 后渲染，应显示它而非 fromOptions
    await fsp.writeFile(fromConfig, '条目\n', 'utf8')
    const text = sections[0]!.render()
    expect(text).toContain(fromConfig.split(path.sep).join('/'))
    expect(text).not.toContain(fromOptions.split(path.sep).join('/'))
  })

  it('非法实例配置（数组 / file 非字符串 / file 空白）一律 setup 抛错', async () => {
    const plugin = await createMemoryPlugin()()
    expect(() => plugin.setup(fakeCtx().ctx, ['file'])).toThrow('must be an object')
    expect(() => plugin.setup(fakeCtx().ctx, { file: 42 })).toThrow('non-empty string')
    expect(() => plugin.setup(fakeCtx().ctx, { file: '  ' })).toThrow('non-empty string')
  })

  it('默认接线：不传任何配置时使用 DEFAULT_MEMORY_FILE（常量即架构 §7 路径）', async () => {
    expect(DEFAULT_MEMORY_FILE).toBe('~/.minidsh/memory/MEMORY.md')
    const { ctx, sections, tools } = fakeCtx()
    const plugin = await createMemoryPlugin()()
    plugin.setup(ctx) // 不抛错即注册成功；默认文件不存在的渲染语义由 section.test 覆盖
    expect(sections).toHaveLength(1)
    expect(tools).toHaveLength(1)
  })
})
