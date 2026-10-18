import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../contracts.js'
import { createReadTool } from './read.js'

/** `read` 工具（设计 §3.2 / §6.1）：行号、分页、空文件、二进制、超长行。 */

let dir: string
const tool = createReadTool()

function env(): ToolEnv {
  return { callId: 'c1', sessionId: 's1', signal: new AbortController().signal }
}

async function write(name: string, content: string | Buffer): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, content)
  return file
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-read-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('read 工具', () => {
  it('按行编号返回，行号右对齐 6 位、tab 分隔', async () => {
    const file = await write('a.txt', 'alpha\nbeta\n')
    const out = await tool.execute({ path: file }, env())
    expect(out).toBe('     1\talpha\n     2\tbeta')
  })

  it('offset / limit 分页，并在尾部说明总行数与区间', async () => {
    const file = await write('b.txt', 'l1\nl2\nl3\nl4\nl5\n')
    const out = await tool.execute({ path: file, offset: 2, limit: 2 }, env())
    expect(out).toContain('     2\tl2')
    expect(out).toContain('     3\tl3')
    expect(out).not.toContain('l4')
    expect(out).toContain('共 5 行，已显示第 2–3 行')
  })

  it('起点超出范围时给出明确说明（而不是空输出）', async () => {
    const file = await write('c.txt', 'only\n')
    const out = await tool.execute({ path: file, offset: 10 }, env())
    expect(out).toContain('起点 10 超出范围')
  })

  it('空文件返回（空文件）而不是空串', async () => {
    const file = await write('empty.txt', '')
    expect(await tool.execute({ path: file }, env())).toContain('（空文件）')
  })

  it('二进制文件被拒绝（前 8KB 含 NUL）', async () => {
    const file = await write('bin.dat', Buffer.from([0x41, 0x00, 0x42]))
    await expect(tool.execute({ path: file }, env())).rejects.toThrow(/二进制/)
  })

  it('单行超长被截断并标注字符数', async () => {
    const file = await write('long.txt', 'x'.repeat(5000))
    const out = await tool.execute({ path: file }, env())
    expect(out).toContain('本行还有 1000 字符')
  })

  it('目标是目录时报错', async () => {
    await expect(tool.execute({ path: dir }, env())).rejects.toThrow(/目录/)
  })

  it('文件不存在时文案含绝对路径与 ENOENT 说明', async () => {
    const missing = path.join(dir, 'nope.txt')
    await expect(tool.execute({ path: missing }, env())).rejects.toThrow(/不存在/)
  })

  it('CRLF 行尾不产生多余空行', async () => {
    const file = await write('crlf.txt', 'a\r\nb\r\n')
    expect(await tool.execute({ path: file }, env())).toBe('     1\ta\n     2\tb')
  })
})
