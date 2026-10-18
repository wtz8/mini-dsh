import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

import type { SessionEvent } from '../contracts.js'
import { isSessionEvent } from './validate.js'

/**
 * JSONL 读写（03 设计 §3）——**本模块唯一接触 `fs` 的文件**，其余文件保持纯逻辑。
 *
 * 格式：一行一个事件，`JSON.stringify(event) + '\n'`，UTF-8。
 * 读写都遵循"**容错优先**"：坏行不抛错、交给上层决定跳过还是报警；
 * 真正的 IO 错误（ENOENT / EACCES）以原始 `fs` 错误上抛，由 `store.ts` 映射成
 * `SessionError{kind}`——分类是存储层的事，这里不做。
 */

/** `list()` 预读首行的字节上限（header 恒为小行；见 `readFirstLine` 的退化分支）。 */
const FIRST_LINE_BYTES = 8192

/**
 * 序列化一个事件为一行（含行尾 `\n`）。
 *
 * `JSON.stringify` 天然转义换行与引号，故中文、多行工具输出均无损往返。
 */
export function serializeEvent(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * 复制一个事件为"与磁盘形态一致"的快照（review Y2）。
 *
 * 为什么用序列化往返而不是 `structuredClone`：落盘走的是 `JSON.stringify`，
 * 因此**序列化后再解析**得到的对象与"重启后从文件读回的形态"逐字段一致
 * （`undefined` 可选字段被丢弃、`toJSON` 参与等）。用同样的路径造快照，
 * 才能保证内存缓存与磁盘 JSONL 永远同构——否则 `read()` 的内存结果与 resume
 * 后的结果可能差一个 `undefined` 字段。
 *
 * @param event 调用方传入的事件
 * @returns 独立的事件副本（与写入磁盘的内容同构）
 */
export function cloneEvent(event: SessionEvent): SessionEvent {
  return JSON.parse(serializeEvent(event)) as SessionEvent
}

/**
 * 独占创建文件并写入首个事件（`create` 用，review Y3）。
 *
 * `flag: 'wx'` 把"存在性检查 + 创建 + 写入"压成一次**原子**文件操作：并发
 * `create` 同一 id（两个调用、两个进程）只有一个能成功，另一个得到 `EEXIST`。
 * 原先的 `access` 预检 + `appendFile` 是 check-then-act，两个调用可能同时通过
 * 检查并向同一文件追加两条 header（实测 50 轮复现 6 次）。
 *
 * @throws 原始 `fs` 错误（`EEXIST` 由 store 翻译为"目标已存在"）
 */
export async function createFile(file: string, event: SessionEvent): Promise<void> {
  await fs.writeFile(file, serializeEvent(event), { encoding: 'utf8', flag: 'wx' })
}

/**
 * 切分为逻辑行：去掉行尾 `\r`（容忍 `\r\n`），丢弃空行。
 *
 * 空行的两个来源是文件尾的正常换行与崩溃留下的空块，二者都不承载事件。
 */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line !== '') lines.push(line)
  }
  return lines
}

/**
 * 解析一行；**不是合法 `SessionEvent` 时返回 `undefined`**（不抛）。
 *
 * 半行 JSON（崩溃场景）与"合法 JSON 但结构不对"都归到这里，由调用方决定
 * 跳过 + 告警（设计 §5：坏行跳过，结构性损坏才抛 `corrupt`）。
 */
export function parseLine(line: string): SessionEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isSessionEvent(parsed) ? parsed : undefined
}

/**
 * 判断文件是否需要"补一个换行"才能安全追加下一行。
 *
 * **为什么需要**（review 期 Y1）：崩溃会把最后一行写成半行（没有行尾 `\n`）。
 * 此时若直接追加，新事件会被**拼进那条坏行**——读侧按行解析时整行作废，于是
 * 崩溃不止丢了半行，还连带吞掉崩溃后写的**第一条**事件（内存里有、磁盘上没有，
 * resume 后消失）。补一个 `\n` 把半行"封口"，新事件就能保住——半行本身仍按坏行跳过。
 *
 * @returns `true` 表示文件非空且最后一个字节不是 `\n`
 */
async function needsLeadingNewline(file: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(file)
  } catch {
    // 文件不存在（首次写入）或 stat 失败：都不需要前导换行
    return false
  }
  if (stat.size === 0) return false
  let handle: FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, stat.size - 1)
    return last[0] !== 0x0a
  } catch {
    // 读不到末尾（权限 / 被占用）：宁可不补，也不为修一次崩溃冒"本次写入失败"的风险
    return false
  } finally {
    await handle?.close()
  }
}

/**
 * 追加一行到文件末尾（不创建目录）。
 *
 * 原子性说明：单次 `appendFile` 是一趟 `write(2)`，POSIX 下小于 `PIPE_BUF`(4KB) 的
 * 写入保证原子；Windows 下同样是单次 `WriteFile`。超过该尺寸的行（大工具输出）在
 * 崩溃时可能留下半行——兜底在**读侧**（跳过坏行）+ 本函数的"封口"补偿（Y1），
 * 写侧不做 fsync（设计 D6）。
 *
 * @throws 原始 `fs` 错误（由 store 映射为 `SessionError{kind:'io'}`）
 */
export async function appendLine(file: string, event: SessionEvent): Promise<void> {
  const line = serializeEvent(event)
  // 上一次崩溃留下的半行：先补换行封口，避免把本次事件并进坏行一起丢失
  const data = (await needsLeadingNewline(file)) ? `\n${line}` : line
  await fs.appendFile(file, data, 'utf8')
}

/**
 * 读取整个文件文本。
 *
 * @throws 原始 `fs` 错误（ENOENT 由 store 映射为 `not_found`）
 */
export async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8')
}

/**
 * 只读取文件的**第一行**（`list()` 用，设计 D7：列表不加载全量事件）。
 *
 * 先预读 `FIRST_LINE_BYTES` 字节找换行；若窗口内没遇到换行（首行超长的异常情况），
 * 退化为整文件读——宁可多读一次，也不要把半行误判成坏行而让会话从列表里消失。
 *
 * @returns 首行文本；文件为空时返回空串
 * @throws 原始 `fs` 错误（文件不存在等）
 */
export async function readFirstLine(file: string, maxBytes = FIRST_LINE_BYTES): Promise<string> {
  let handle: FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    let newline = text.indexOf('\n')
    if (newline < 0) {
      // 预读窗口内没有换行：整文件读后再切首行（正常路径不会走到这里）
      text = await fs.readFile(file, 'utf8')
      newline = text.indexOf('\n')
    }
    return newline < 0 ? text : text.slice(0, newline)
  } finally {
    await handle?.close()
  }
}
