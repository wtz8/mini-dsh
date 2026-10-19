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
    expect(input.listenerCount('error')).toBe(0)
  })

  // review Y7：并发审批场景。单槽等待者会被后到的 ask() 覆盖——前一个的
  // resolve 被静默丢弃，只能等 60s 审批超时。队列化后每个等待者各得一行。
  it('⑮b 并发 ask 各得一行（FIFO，后到者不覆盖先到者）', async () => {
    const prompts: string[] = []
    const input = new Readable({ read() {} })
    const lines = createLineReader(input, (text) => prompts.push(text))
    const a = lines.ask('Q1 ')
    const b = lines.ask('Q2 ')
    input.push('y\nn\n')
    expect(await a).toBe('y')
    expect(await b).toBe('n')
    expect(prompts).toEqual(['Q1 ', 'Q2 '])
    lines.close()
  })

  it('⑮c interrupt 打断全部进行中的 ask，next 留在队列里继续等', async () => {
    const input = new Readable({ read() {} })
    const lines = createLineReader(input)
    const a = lines.ask('Q1 ')
    const b = lines.ask('Q2 ')
    const c = lines.next()
    lines.interrupt()
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    // next 不被打断（否则 REPL 会误判 EOF 退出），由后续输入结算
    input.push('later\n')
    expect(await c).toBe('later')
    lines.close()
  })

  // review Y7：逐 chunk toString('utf8') 会把半个汉字拆成 U+FFFD（中文输入被
  // 静默破坏并永久进 log）；StringDecoder 把残缺字节留到下一片拼回。
  it('⑮d 多字节字符被 chunk 边界切断：拼回完整汉字，不出现替换符', async () => {
    const bytes = Buffer.from('你好\n', 'utf8') // 「你」= E4 BD A0
    const chunks = [bytes.subarray(0, 1), bytes.subarray(1)]
    const input = new Readable({
      read() {
        this.push(chunks.shift() ?? null)
      },
    })
    const lines = createLineReader(input)
    expect(await lines.next()).toBe('你好')
    lines.close()
  })

  it('⑮e 流出错（stdin 故障）时等待者按 EOF 结算，不永久挂住', async () => {
    const input = new Readable({ read() {} })
    const lines = createLineReader(input)
    const pending = lines.ask('?')
    input.emit('error', new Error('device gone'))
    expect(await pending).toBeNull()
    // 此后按 EOF 语义：恒为 null
    expect(await lines.next()).toBeNull()
    lines.close()
  })
})
