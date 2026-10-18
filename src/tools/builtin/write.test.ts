import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../contracts.js'
import { createWriteTool } from './write.js'

/** `write` 工具：整文件覆盖 + 自动建父目录 + 目标是目录时报错。 */

let dir: string
const tool = createWriteTool()

function env(): ToolEnv {
  return { callId: 'c1', sessionId: 's1', signal: new AbortController().signal }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-write-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('write 工具', () => {
  it('写入新文件（含多级父目录自动创建）', async () => {
    const target = path.join(dir, 'a/b/c.txt')
    const out = await tool.execute({ path: target, content: 'hello' }, env())
    expect(await fs.readFile(target, 'utf8')).toBe('hello')
    expect(out).toContain('已写入')
    expect(out).toContain('5 字节')
  })

  it('覆盖已有内容', async () => {
    const target = path.join(dir, 'x.txt')
    await fs.writeFile(target, 'old content', 'utf8')
    await tool.execute({ path: target, content: 'new' }, env())
    expect(await fs.readFile(target, 'utf8')).toBe('new')
  })

  it('字节数按 UTF-8 计算（中文 3 字节）', async () => {
    const target = path.join(dir, 'cn.txt')
    const out = await tool.execute({ path: target, content: '中文' }, env())
    expect(out).toContain('6 字节')
  })

  it('目标是目录时报错且不破坏目录', async () => {
    await expect(tool.execute({ path: dir, content: 'x' }, env())).rejects.toThrow(/目录|EISDIR|权限/)
    expect((await fs.stat(dir)).isDirectory()).toBe(true)
  })
})
