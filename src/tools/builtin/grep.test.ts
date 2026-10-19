import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../contracts.js'
import { createGrepTool } from './grep.js'

/** `grep` 工具：命中格式、大小写、glob 过滤、非法正则、无匹配、跳过二进制。 */

let dir: string
const tool = createGrepTool()

function env(signal = new AbortController().signal): ToolEnv {
  return { callId: 'c1', sessionId: 's1', signal }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-grep-'))
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src/a.ts'), 'const needle = 1\nconst other = 2\n', 'utf8')
  await fs.writeFile(path.join(dir, 'src/b.md'), 'needle in docs\n', 'utf8')
  await fs.writeFile(path.join(dir, 'src/c.ts'), 'NEEDLE upper\n', 'utf8')
  await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x00, 0x64]))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('grep 工具', () => {
  it('输出 路径:行号: 内容', async () => {
    const out = await tool.execute({ pattern: 'needle', path: dir }, env())
    expect(out).toContain('src/a.ts:1: const needle = 1')
  })

  it('ignoreCase 生效', async () => {
    const out = await tool.execute({ pattern: 'needle', path: dir, ignoreCase: true }, env())
    expect(out).toContain('src/c.ts:1: NEEDLE upper')
  })

  it('glob 过滤只搜匹配文件', async () => {
    const out = await tool.execute({ pattern: 'needle', path: dir, glob: '*.ts' }, env())
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('src/b.md')
  })

  it('非法正则报错（不停在无意义的 0 命中上）', async () => {
    await expect(tool.execute({ pattern: '([', path: dir }, env())).rejects.toThrow(/正则表达式非法/)
  })

  it('无匹配返回（无匹配）', async () => {
    expect(await tool.execute({ pattern: 'zzz-not-there', path: dir }, env())).toBe('（无匹配）')
  })

  it('二进制文件被跳过', async () => {
    const out = await tool.execute({ pattern: 'nee', path: dir }, env())
    expect(out).not.toContain('bin.dat')
  })

  it('limit 截断时附说明', async () => {
    const out = await tool.execute({ pattern: 'const', path: dir, limit: 1 }, env())
    expect(out).toContain('已截断')
  })

  // Y7：取消发生在遍历阶段时，`walkFiles` 返回空/半截列表。此时报「（无匹配）」等于
  // 告诉模型"确实没有这个字符串"，是错误事实；必须抛错让管道归为 cancelled。
  it('已取消时抛错，而不是返回“（无匹配）”', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ pattern: 'needle', path: dir }, env(controller.signal))).rejects.toThrow(/取消/)
  })
})
