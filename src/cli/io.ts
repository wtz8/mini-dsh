import type { Readable } from 'node:stream'

import type { CliIO, LineReader } from './types.js'

/**
 * 宿主 IO：stdin 行泵与进程 IO 面（D2）。
 *
 * 为什么不用 `node:readline`（D6）：REPL 与审批共用同一 stdin——审批发生在
 * `run()` 的 await 期间，此刻 REPL 不在读行。用 readline 需要在两条消费路径之间
 * `pause/resume`，还要自己接管"暂停期间到达的未消费数据"；行泵把
 * **缓冲队列 + 单一等待者**收在一处，语义直白，且能直接吃 `Readable.from([...])`
 * 做单测（无需真 TTY）。
 */

/** 等待者：区分身份，因为 `interrupt()` 只该打断 `ask`（§3.3）。 */
interface Waiter {
  kind: 'next' | 'ask'
  resolve: (line: string | null) => void
}

/**
 * 构造行泵。
 *
 * 行为约定：
 * - 按 `\n` 切行，尾部 `\r` 去掉（Windows 的 CRLF，§5 边界表 20）；
 * - 行被缓冲在队列里，**回合期间到达的输入不会丢**，回合结束后由 REPL 依次取用；
 * - EOF（`end` / `close`）时若缓冲区还有残余（最后一行没有换行符），补为一行；
 *   此后所有 `next()` / `ask()` 恒返回 `null`。
 *
 * @param input 输入流（生产传 `process.stdin`，测试传 `Readable.from([...])`）
 * @param out 提示输出（`ask(prompt)` 用它打印；不传则丢弃 prompt）
 * @returns 行读取器；**用完必须 `close()`**，否则流上的监听会拖住事件循环
 */
export function createLineReader(input: Readable, out?: (text: string) => void): LineReader {
  let buffer = ''
  const queue: string[] = []
  let waiter: Waiter | undefined
  let eof = false

  /** 有等待者就结算一次（一次一行，保持"单一等待者"语义）。 */
  function deliver(): void {
    if (!waiter) return
    if (queue.length > 0) {
      const line = queue.shift() ?? ''
      const settled = waiter
      waiter = undefined
      settled.resolve(line)
      return
    }
    if (eof) {
      const settled = waiter
      waiter = undefined
      settled.resolve(null)
    }
  }

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      queue.push(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
    deliver()
  }

  /** EOF：残余补为一行，之后一律 `null`。 */
  function onEnd(): void {
    if (buffer.length > 0) {
      queue.push(buffer.replace(/\r$/, ''))
      buffer = ''
    }
    eof = true
    deliver()
  }

  input.on('data', onData)
  input.on('end', onEnd)
  // 流被销毁（stdin 关闭）时同样按 EOF 处理，避免等待者永远挂住
  input.on('close', onEnd)

  /** 取一行：`next` 与 `ask` 的唯一区别是身份（决定能否被 interrupt 打断）。 */
  function take(kind: 'next' | 'ask'): Promise<string | null> {
    if (queue.length > 0) return Promise.resolve(queue.shift() ?? null)
    if (eof) return Promise.resolve(null)
    return new Promise<string | null>((resolve) => {
      waiter = { kind, resolve }
    })
  }

  return {
    next(): Promise<string | null> {
      return take('next')
    },
    ask(prompt: string): Promise<string | null> {
      if (prompt !== '' && out) out(prompt)
      return take('ask')
    },
    interrupt(): void {
      // 只打断进行中的 ask：REPL 的 next() 若被当成 EOF 会误退出整个程序
      if (waiter && waiter.kind === 'ask') {
        const settled = waiter
        waiter = undefined
        settled.resolve(null)
      }
    },
    close(): void {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('close', onEnd)
      eof = true
      queue.length = 0
      if (waiter) {
        const settled = waiter
        waiter = undefined
        settled.resolve(null)
      }
    },
  }
}

/**
 * 生产用 IO 面：接 `process.stdin` / `stdout` / `stderr`。
 *
 * `isTTY` 取 `process.stdin.isTTY`——它决定两件事（§4.6 / Q4）：非交互时
 * 不打提示符，且审批一律失败关闭（无 TTY 就无从取得用户同意）。
 */
export function createProcessIO(): CliIO {
  const out = (text: string): void => {
    process.stdout.write(text)
  }
  return {
    out,
    err: (text: string): void => {
      process.stderr.write(text)
    },
    lines: createLineReader(process.stdin, out),
    isTTY: Boolean(process.stdin.isTTY),
  }
}
