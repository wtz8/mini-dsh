import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createLineReader } from './io.js'
import type { LineReader } from './types.js'

/**
 * 行泵单测（设计 §6.1 第 9–15 条）。
 *
 * 用 `Readable.from([...])` 注入而非真 TTY：这既是 D6 的收益之一，也是
 * "审批与 REPL 共用队列"这类时序语义能被确定断言的前提。
 */

/** 构造一个行泵，并收集它写出的 prompt。 */
function setup(chunks: readonly string[]): { lines: LineReader; prompts: string[]; input: Readable } {
  const prompts: string[] = []
  const input = Readable.from([...chunks])
  const lines = createLineReader(input, (text) => prompts.push(text))
  return { lines, prompts, input }
}

describe('createLineReader', () => {
  it('⑨ 一次到达多行 ⇒ 逐行返回', async () => {
    const { lines } = setup(['a\nb\nc\n'])
    expect(await lines.next()).toBe('a')
    expect(await lines.next()).toBe('b')
    expect(await lines.next()).toBe('c')
    lines.close()
  })

  it('⑩ 跨 chunk 的半行 ⇒ 拼接后才成行', async () => {
    const { lines } = setup(['he', 'llo', '\nwor', 'ld\n'])
    expect(await lines.next()).toBe('hello')
    expect(await lines.next()).toBe('world')
    lines.close()
  })

  it('⑪ CRLF 的尾部 \\r 被去掉（Windows）', async () => {
    const { lines } = setup(['a\r\nb\r\n'])
    expect(await lines.next()).toBe('a')
    expect(await lines.next()).toBe('b')
    lines.close()
  })

  it('⑫ EOF 后返回 null，且此后恒为 null', async () => {
    const { lines } = setup(['a\n'])
    expect(await lines.next()).toBe('a')
    expect(await lines.next()).toBeNull()
    expect(await lines.next()).toBeNull()
    expect(await lines.ask('?')).toBeNull()
    lines.close()
  })

  it('⑫b 末尾没有换行符的残余也算一行（管道输入常见形态）', async () => {
    const { lines } = setup(['no-newline'])
    expect(await lines.next()).toBe('no-newline')
    lines.close()
  })

  it('⑬ ask 写 prompt 后取一行；interrupt 只打断 ask，不影响随后的 next', async () => {
    const { lines, prompts } = setup(['y\nnext\n'])
    const pending = lines.ask('允许？[y/N] ')
    lines.interrupt()
    expect(await pending).toBeNull()
    expect(prompts).toEqual(['允许？[y/N] '])
    // 被 interrupt 消费掉的是 ask 而非队列：下一行仍归 next
    expect(await lines.next()).toBe('y')
    lines.close()
  })

  it('⑬b interrupt 不会把 REPL 的 next 变成 EOF（否则会误退出）', async () => {
    const { lines } = setup([])
    const pending = lines.next()
    lines.interrupt()
    // 仍挂起：断言它尚未结算
    const settled = await Promise.race([pending.then((v) => `value:${String(v)}`), Promise.resolve('pending')])
    expect(settled).toBe('pending')
    lines.close()
    expect(await pending).toBeNull()
  })

  it('⑭ 早到的输入被缓冲：回合期间敲入的行不会丢', async () => {
    const { lines, prompts } = setup(['y\nbuffered\n'])
    expect(await lines.ask('?')).toBe('y')
    expect(prompts).toEqual(['?'])
    // 第二行在 ask 期间就已到达，回合结束后由 REPL 取用
    expect(await lines.next()).toBe('buffered')
    lines.close()
  })

  it('⑮ close() 摘掉全部监听并唤醒等待者', async () => {
    const { lines, input } = setup(['a\n'])
    expect(input.listenerCount('data')).toBe(1)
    const pending = lines.ask('?')
    lines.close()
    expect(await pending).toBeNull()
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(input.listenerCount('close')).toBe(0)
  })
})
