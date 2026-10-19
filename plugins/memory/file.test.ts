import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendMemory, readMemoryFile, truncateMemory } from './file.js'

/**
 * file.ts 单测（设计 §6.1，tmp 目录真实 fs）：读取的空语义 / 尾部保留截断 /
 * 追加的两条不变式 / IO 失败上抛。
 */

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdsh-mem-file-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('readMemoryFile', () => {
  it('文件不存在（ENOENT）返回 undefined', () => {
    expect(readMemoryFile(path.join(dir, 'nope.md'))).toBeUndefined()
  })

  it('全空白文件视为空；有内容时返回 trim 后的正文', async () => {
    const blank = path.join(dir, 'blank.md')
    await fsp.writeFile(blank, '  \n\n  \n', 'utf8')
    expect(readMemoryFile(blank)).toBeUndefined()

    const full = path.join(dir, 'full.md')
    await fsp.writeFile(full, '\n  第一条记忆\n\n', 'utf8')
    expect(readMemoryFile(full)).toBe('第一条记忆')
  })
})

describe('truncateMemory', () => {
  it('预算内原样返回（truncated: false）', () => {
    const r = truncateMemory('短文本', 1024)
    expect(r).toEqual({ text: '短文本', truncated: false })
  })

  it('超预算保留尾部、对齐行边界', () => {
    // 每行 10 字节，预算 32 → 恰好容得下尾部 3 行（10+1+10+1+10）
    const lines = Array.from({ length: 10 }, (_, i) => `line${String(i).padStart(6, '0')}`)
    const r = truncateMemory(lines.join('\n'), 32)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe(lines.slice(-3).join('\n'))
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(32)
    expect(r.text).not.toContain('line000000')
  })

  it('单行即超预算的极端情形：按字节硬切尾部且不超预算', () => {
    const huge = 'x'.repeat(1000)
    const r = truncateMemory(huge, 100)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(100)
    expect(r.text.endsWith('xxx')).toBe(true)
  })
})

describe('appendMemory', () => {
  it('追加到不存在的文件：自动建父目录，内容尾部恰好一个换行', async () => {
    const file = path.join(dir, 'deep', 'nested', 'MEMORY.md')
    const bytes = await appendMemory(file, '第一条')
    expect(bytes).toBe(Buffer.byteLength('第一条\n', 'utf8'))
    expect(await fsp.readFile(file, 'utf8')).toBe('第一条\n')
  })

  it('追加到无尾换行的既有文件：先补换行（条目不粘连），尾部仍恰好一个换行', async () => {
    const file = path.join(dir, 'MEMORY.md')
    await fsp.writeFile(file, '旧条目无尾换行', 'utf8')
    await appendMemory(file, '新条目')
    expect(await fsp.readFile(file, 'utf8')).toBe('旧条目无尾换行\n新条目\n')
    // 再追加一条：已有尾换行，不再补
    await appendMemory(file, '第三条  \n\n') // 尾空白被 trimEnd 收敛
    expect(await fsp.readFile(file, 'utf8')).toBe('旧条目无尾换行\n新条目\n第三条\n')
  })

  it('追加 IO 失败（路径是目录）原样抛错', async () => {
    await expect(appendMemory(dir, '内容')).rejects.toThrow()
  })
})
