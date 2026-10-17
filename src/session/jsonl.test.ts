import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionEvent } from '../contracts.js'
import { appendLine, parseLine, readFirstLine, readText, serializeEvent, splitLines } from './jsonl.js'

/**
 * JSONL 读写（设计 §3）：一行一事件、坏行不抛、首行可单独读。
 * 本文件是 03 唯一触碰真实磁盘的单测（其余用 store 的 tmp 目录）。
 */

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-jsonl-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const header: SessionEvent = {
  type: 'session/header',
  id: 's1',
  createdAt: '2026-10-17T07:30:12.345Z',
  provider: 'deepseek',
  model: 'deepseek-chat',
  cwd: 'D:\\MiniDSH',
}

describe('serializeEvent / parseLine', () => {
  it('序列化为单行且以 \\n 结尾', () => {
    const line = serializeEvent({ type: 'turn/start', turnNo: 1 })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).toBe('{"type":"turn/start","turnNo":1}')
  })

  it('中文、换行与引号往返无损', () => {
    const event: SessionEvent = {
      type: 'user/message',
      content: '他说："读一下\nREADME.md"。\t路径 D:\\代码\\中文',
    }
    expect(parseLine(serializeEvent(event).slice(0, -1))).toEqual(event)
  })

  it('坏 JSON（崩溃留下的半行）返回 undefined 而不抛', () => {
    expect(parseLine('{"type":"user/message","content":"缺个括号')).toBeUndefined()
  })

  it('合法 JSON 但不是合法 SessionEvent 也返回 undefined', () => {
    expect(parseLine('{"type":"unknown/event"}')).toBeUndefined()
    expect(parseLine('null')).toBeUndefined()
    expect(parseLine('[1,2,3]')).toBeUndefined()
  })
})

describe('splitLines', () => {
  it('去尾 \\r 并跳过空行', () => {
    expect(splitLines('a\r\nb\n\n\nc')).toEqual(['a', 'b', 'c'])
  })

  it('空文本不产行', () => {
    expect(splitLines('')).toEqual([])
  })
})

describe('appendLine / readText / readFirstLine', () => {
  it('两次追加后文件为两行，首行可单独读出', async () => {
    const file = path.join(dir, 'session.jsonl')
    const second: SessionEvent = { type: 'user/message', content: '第一条\n含换行' }
    await appendLine(file, header)
    await appendLine(file, second)

    const text = await readText(file)
    expect(text).toBe(serializeEvent(header) + serializeEvent(second))

    // list() 依赖这条路径：不加载全量也能拿到 header
    const first = parseLine(await readFirstLine(file))
    expect(first).toEqual(header)
  })

  it('崩溃留下半行后追加：先补换行封口，本次事件不会并进坏行（review Y1）', async () => {
    const file = path.join(dir, 'crashed.jsonl')
    const partial = '{"type":"user/message","content":"崩溃时写了一半'
    await fs.writeFile(file, `${serializeEvent(header)}${partial}`, 'utf8')

    const event: SessionEvent = { type: 'user/message', content: '崩溃后写的事件' }
    await appendLine(file, event)

    const lines = splitLines(await readText(file))
    // 半行仍是坏行（按设计跳过），但新事件必须保住——否则 resume 后凭空消失
    expect(parseLine(lines[1] ?? '')).toBeUndefined()
    expect(parseLine(lines[2] ?? '')).toEqual(event)
  })

  it('readFirstLine 对空文件返回空串（调用方据此判为损坏）', async () => {
    const file = path.join(dir, 'empty.jsonl')
    await fs.writeFile(file, '', 'utf8')
    expect(await readFirstLine(file)).toBe('')
  })

  it('首行超过预读窗口时退化为整文件读（仍拿到完整首行）', async () => {
    const file = path.join(dir, 'long.jsonl')
    // 造一条远超 8192 字节的首行：超长 cwd 让 header 变胖
    const fat: SessionEvent = { ...header, cwd: 'x'.repeat(20000) }
    await appendLine(file, fat)
    await appendLine(file, { type: 'turn/start', turnNo: 1 })

    const first = parseLine(await readFirstLine(file))
    expect(first).toEqual(fat)
  })
})
