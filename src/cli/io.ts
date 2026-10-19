import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

import type { CliIO, LineReader } from './types.js'

/**
 * 宿主 IO：stdin 行泵与进程 IO 面（D2）。
 *
 * 为什么不用 `node:readline`（D6）：REPL 与审批共用同一 stdin——审批发生在
 * `run()` 的 await 期间，此刻 REPL 不在读行。用 readline 需要在两条消费路径之间
 * `pause/resume`，还要自己接管"暂停期间到达的未消费数据"；行泵把
 * **缓冲队列 + FIFO 等待者队列**收在一处，语义直白，且能直接吃 `Readable.from([...])`
 * 做单测（无需真 TTY）。
 *
 * 等待者为什么是**队列**而不是单槽（review Y7）：默认配置下（`permissions: {}`
 * ⇒ 全部工具 `ask`、`tools.maxParallel: 4`）一步内会有多个工具并发走到审批，
 * 单槽 `waiter` 会被后到的 `ask()` 覆盖——前 N-1 个等待者的 resolve 被静默丢弃，
 * 只能等 60s 审批超时后误判 `permission_denied`。队列 + FIFO 结算后，
 * 每个等待者都能拿到一行输入（一次一行，先到先得）。
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
 * - 多字节字符被 chunk 边界切断时经 `StringDecoder` 拼回（review Y7）：
 *   逐 chunk `toString('utf8')` 会把半个汉字拆成替换符 U+FFFD，中文输入被静默破坏；
 * - EOF（`end` / `close` / `error`）时若缓冲区还有残余（最后一行没有换行符），
 *   补为一行；此后所有 `next()` / `ask()` 恒返回 `null`；
 * - 流错误同样按 EOF 收尾——没有 `'error'` 监听的流会抛进程级异常，
 *   而等待者挂住比"按 EOF 退出"更糟（review Y7）。
 *
 * @param input 输入流（生产传 `process.stdin`，测试传 `Readable.from([...])`）
 * @param out 提示输出（`ask(prompt)` 用它打印；不传则丢弃 prompt）
 * @returns 行读取器；**用完必须 `close()`**，否则流上的监听会拖住事件循环
 */
export function createLineReader(input: Readable, out?: (text: string) => void): LineReader {
  let buffer = ''
  const queue: string[] = []
  let waiters: Waiter[] = []
  let eof = false

  /** 有等待者就按 FIFO 结算：队列有行给行，EOF 给 null，直到喂不饱为止。 */
  function deliver(): void {
    while (waiters.length > 0) {
      if (queue.length > 0) {
        const line = queue.shift() ?? ''
        const settled = waiters.shift()
        settled?.resolve(line)
        continue
      }
      if (eof) {
        const settled = waiters.shift()
        settled?.resolve(null)
        continue
      }
      break
    }
  }

  /** 跨 chunk 的多字节残缺字节由 decoder 拼回（见类 JSDoc）。 */
  const decoder = new StringDecoder('utf8')

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    // 一次扫描切出全部完整行（上一实现逐行 slice，行多时是 O(n²)）
    let from = 0
    for (;;) {
      const index = buffer.indexOf('\n', from)
      if (index < 0) break
      queue.push(buffer.slice(from, index).replace(/\r$/, ''))
      from = index + 1
    }
    if (from > 0) buffer = buffer.slice(from)
    deliver()
  }

  /** EOF：残余补为一行（decoder 里若还压着残缺字节，按替换符收尾），之后一律 `null`。 */
  function onEnd(): void {
    // decoder.end() 只在确有残缺字节时返回替换符，正常情况下为空串；
    // 多次调用（end 之后又收到 close）安全：后续调用恒返回空串
    const tail = decoder.end()
    if (buffer.length > 0 || tail !== '') queue.push((buffer + tail).replace(/\r$/, ''))
    buffer = ''
    if (!eof) {
      eof = true
      deliver()
    }
  }

  /** 流错误：与 EOF 同途结算（等待者拿 null 而非永久挂住），错误本身不上抛。 */
  function onError(): void {
    onEnd()
  }

  input.on('data', onData)
  input.on('end', onEnd)
  // 流被销毁（stdin 关闭）时同样按 EOF 处理，避免等待者永远挂住
  input.on('close', onEnd)
  // 无 'error' 监听的 Readable 抛错会带崩进程；挂上并按 EOF 收尾
  input.on('error', onError)

  /** 取一行：`next` 与 `ask` 的唯一区别是身份（决定能否被 interrupt 打断）。 */
  function take(kind: 'next' | 'ask'): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      waiters.push({ kind, resolve })
      // 入队后立即尝试结算：队列里已有缓冲行（或已 EOF）时当场返回，
      // 不给"插队"留窗口——多个等待者时后来者不能跳过先到者
      deliver()
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
      // 只打断进行中的 ask：REPL 的 next() 若被当成 EOF 会误退出整个程序。
      // 并发审批（review Y7）下可能有多个 ask 在等——全部打断，next 留在队列里
      const remaining: Waiter[] = []
      for (const w of waiters) {
        if (w.kind === 'ask') w.resolve(null)
        else remaining.push(w)
      }
      waiters = remaining
    },
    close(): void {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('close', onEnd)
      input.off('error', onError)
      eof = true
      queue.length = 0
      const pending = waiters
      waiters = []
      for (const w of pending) w.resolve(null)
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
