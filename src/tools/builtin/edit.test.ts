import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../contracts.js'
import { createEditTool } from './edit.js'

/** `edit` 工具：精确替换——0 处报错、多处要求 replaceAll、失败不改文件。 */

let dir: string
const tool = createEditTool()

function env(): ToolEnv {
  return { callId: 'c1', sessionId: 's1', signal: new AbortController().signal }
}

async function write(name: string, content: string): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, content, 'utf8')
  return file
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-edit-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('edit 工具', () => {
  it('替换唯一一处并写入文件', async () => {
    const file = await write('a.txt', 'hello world\n')
    const out = await tool.execute({ path: file, oldString: 'world', newString: 'MiniDSH' }, env())
    expect(out).toContain('替换 1 处')
    expect(await fs.readFile(file, 'utf8')).toBe('hello MiniDSH\n')
  })

  it('命中多处且未开 replaceAll 时报错，文件保持原样', async () => {
    const file = await write('b.txt', 'a a a')
    await expect(tool.execute({ path: file, oldString: 'a', newString: 'b' }, env())).rejects.toThrow(/匹配到 3 处/)
    expect(await fs.readFile(file, 'utf8')).toBe('a a a')
  })

  it('replaceAll 替换全部命中', async () => {
    const file = await write('c.txt', 'a a a')
    const out = await tool.execute({ path: file, oldString: 'a', newString: 'b', replaceAll: true }, env())
    expect(out).toContain('替换 3 处')
    expect(await fs.readFile(file, 'utf8')).toBe('b b b')
  })

  it('0 处命中时报错并提示先 read', async () => {
    const file = await write('d.txt', 'nothing here')
    await expect(tool.execute({ path: file, oldString: 'absent', newString: 'x' }, env())).rejects.toThrow(/未找到匹配文本/)
  })

  it('oldString 为空串时直接拒绝（防止 indexOf("") 死循环）', async () => {
    const file = await write('e.txt', 'x')
    await expect(tool.execute({ path: file, oldString: '', newString: 'y' }, env())).rejects.toThrow(/不能为空串/)
  })

  it('newString 为空串等价于删除片段', async () => {
    const file = await write('f.txt', 'keep-REMOVE-keep')
    await tool.execute({ path: file, oldString: '-REMOVE', newString: '' }, env())
    expect(await fs.readFile(file, 'utf8')).toBe('keep-keep')
  })
})
