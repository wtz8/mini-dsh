import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 记忆文件的读写原语（纯函数层，设计 D2：不依赖 ctx，路径由调用方给）。
 *
 * 行为约定见设计文档 §3.1（文件格式不变式）、§4.2（段的读取与截断）、
 * §4.3（工具的追加）。本文件不 import SDK——段与工具层负责路径解析。
 */

/** 截断结果：正文 + 是否发生过截断（截断标注行由调用方拼）。 */
export interface TruncatedMemory {
  text: string
  truncated: boolean
}

/** 从 unknown 错误提取可读消息（拼进降级文本）。 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 展示用路径分隔归一化：Windows 反斜杠在 markdown 里会被当转义，统一成 `/`。
 * （05 的 `displayPath` 未转发到 SDK 面；本模块只需要分隔符归一，不转发是刻意收紧。）
 */
export function toSlashes(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * 同步读取记忆文件正文（`PromptSection.render()` 是同步签名，只能用同步 IO；
 * 本地小文件 readFileSync 亚毫秒级，每 step 一次可忽略——04 已实测全量 render ≈0.07ms）。
 *
 * @param absPath 已解析的绝对路径
 * @returns trim 后的正文；文件不存在（ENOENT）或全空白时返回 `undefined`
 * @throws Error ENOENT 之外的 IO 错误原样上抛（由段层降级为文本，设计 §8-Q8）
 */
export function readMemoryFile(absPath: string): string | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(absPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const text = raw.trim()
  return text === '' ? undefined : text
}

/**
 * 把记忆正文截断到字节预算内：**保留尾部**（append-only 下最新记忆在文件尾，
 * 比头部更可能相关，设计 §8-Q5），截断处对齐到行边界。
 *
 * @param text 完整正文（已 trim）
 * @param maxBytes UTF-8 字节预算
 * @returns 预算内原样返回 `truncated: false`；超出时返回尾部片段
 */
export function truncateMemory(text: string, maxBytes: number): TruncatedMemory {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const lines = text.split('\n')
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(lines[i] ?? '', 'utf8') + (kept.length > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) {
      if (kept.length === 0) {
        // 极端情形：最后一行自身即超预算——按字节硬切其尾部。Buffer.subarray 保证
        // 不超预算，边界处可能切出 UTF-8 替换字符（可读性损失可接受）
        const tail = Buffer.from(lines[i] ?? '', 'utf8').subarray(-maxBytes).toString('utf8')
        return { text: tail, truncated: true }
      }
      break
    }
    bytes += lineBytes
    kept.unshift(lines[i] ?? '')
  }
  return { text: kept.join('\n'), truncated: kept.length < lines.length }
}

/**
 * 追加一条记忆（异步）。保证设计 §3.1 的两条不变式：
 *
 * 1. 文件非空且不以 `\n` 结尾时，先补一个换行（条目不粘连）；
 * 2. 追加内容尾部恰好一个 `\n`。
 *
 * @param absPath 已解析的绝对路径（父目录不存在时自动创建）
 * @param content 条目原文（内部做 `trimEnd`；空白判定归工具层，设计 §5-#7）
 * @returns 实际追加的字节数（含分隔前缀，用于结果回报）
 * @throws Error IO 失败原样上抛（由 05 管道转 `execution_error`，本层不组装结果）
 */
export async function appendMemory(absPath: string, content: string): Promise<number> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true })
  // 只读最后 1 字节判断尾换行，不整读文件（记忆可能很大）
  let size = 0
  try {
    size = (await fsp.stat(absPath)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  let prefix = ''
  if (size > 0) {
    const fh = await fsp.open(absPath, 'r')
    try {
      const last = Buffer.alloc(1)
      await fh.read(last, 0, 1, size - 1)
      if (last[0] !== 0x0a) prefix = '\n'
    } finally {
      await fh.close()
    }
  }
  const chunk = prefix + content.trimEnd() + '\n'
  await fsp.appendFile(absPath, chunk, 'utf8')
  return Buffer.byteLength(chunk, 'utf8')
}
