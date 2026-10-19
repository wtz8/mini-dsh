import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../src/index.js'
import { createMemoryTool, MEMORY_TOOL_NAME } from './tool.js'

/**
 * tool.ts 单测（设计 §6.1）：schema/并发属性形态 / 追加语义 / 空白 content 的
 * ok 结果 / 写失败上抛（交管道转 execution_error）/ 路径覆盖生效。
 *
 * 注意：测试一律注入 tmp 路径——缺省路径指向真实 home，绝不在测试里执行它。
 */

const env: ToolEnv = { callId: 'c1', sessionId: 's1', signal: new AbortController().signal }

let dir: string
let file: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdsh-mem-tool-'))
  file = path.join(dir, 'MEMORY.md')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('createMemoryTool', () => {
  it('定义形态：名称 / exclusive / schema（required + additionalProperties:false）', () => {
    const tool = createMemoryTool({ file })
    expect(tool.name).toBe(MEMORY_TOOL_NAME)
    expect(tool.name).toBe('memory')
    expect(tool.concurrency).toBe('exclusive')
    expect(tool.schema.required).toEqual(['content'])
    expect(tool.schema.additionalProperties).toBe(false)
    expect(Object.keys(tool.schema.properties)).toEqual(['content'])
  })

  it('正常追加：文件落盘且结果回报路径与字节数', async () => {
    const tool = createMemoryTool({ file })
    const result = await tool.execute({ content: '- 2026-10-19 用户偏好中文' }, env)
    expect(await fsp.readFile(file, 'utf8')).toBe('- 2026-10-19 用户偏好中文\n')
    expect(result).toContain('已追加到')
    expect(result).toContain(file.split(path.sep).join('/'))
  })

  it('空白 content：返回"未写入"的 ok 结果，文件不被创建', async () => {
    const tool = createMemoryTool({ file })
    const result = await tool.execute({ content: '  \n ' }, env)
    expect(result).toContain('未写入')
    await expect(fsp.stat(file)).rejects.toThrow()
  })

  it('写失败（路径是目录）原样抛错——工具层不自己组装 ToolResult', async () => {
    const tool = createMemoryTool({ file: dir })
    await expect(tool.execute({ content: '内容' }, env)).rejects.toThrow()
  })

  it('options.file 覆盖默认路径生效', async () => {
    const custom = path.join(dir, 'custom-memory.md')
    const tool = createMemoryTool({ file: custom })
    await tool.execute({ content: '条目' }, env)
    expect(await fsp.readFile(custom, 'utf8')).toBe('条目\n')
  })
})
