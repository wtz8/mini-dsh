/**
 * SSE（Server-Sent Events）增量解析器 —— 手写，零运行时依赖（架构 §2 选型）。
 *
 * 用途：把 LLM provider 的流式响应体（解码后的文本分片）切成"帧"。
 * 只认 OpenAI 兼容面用得上的部分：**只读取 `data` 字段**，其余字段
 * （`event` / `id` / `retry`）与注释行（`:` 开头）一律忽略。
 *
 * 关键性质：**输入可在任意字节边界被切断**（TCP 分片），解析器用内部缓冲累积，
 * 未组成完整块的部分留待下一个分片，调用方无需关心分片边界。
 *
 * 容错取舍（设计 §4.3）：
 * - 行结束符归一化为 `\n`（`\r\n` 与裸 `\r` 都按换行处理）——JSON 载荷内不可能出现
 *   裸 CR（JSON 字符串里的回车被转义为 `\r` 两个字符），故归一化安全；
 * - 同一块内的多个 `data:` 行按 SSE 规范以 `\n` 连接（RFC 8895）；
 * - 流末尾若没有空行终止，`flush()` 会尝试解析残帧（部分 provider 结尾不补空行）；
 * - 空 `data`（keep-alive 心跳）不产出帧。
 */
export type SseFrame = { kind: 'data'; data: string } | { kind: 'done' }

/** `[DONE]` 哨兵：OpenAI 兼容面用它标记流正常结束。 */
const DONE_SENTINEL = '[DONE]'

/**
 * 解析一个块（以空行分隔的一段文本）为帧。
 *
 * @param block 单个事件块的原始文本（不含终止空行）
 * @returns 帧；块中没有有效 `data` 时返回 `undefined`
 */
function parseBlock(block: string): SseFrame | undefined {
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    // 归一化后不应再有 CR，此处仍防御性剥离（直接喂入未归一化文本的场景）
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    // 注释行（含心跳 `: ping`）：整行跳过
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon)
    if (field !== 'data') continue // 忽略 event / id / retry 等字段
    let value = line.slice(colon + 1)
    // SSE 规范允许冒号后跟一个可选空格
    if (value.startsWith(' ')) value = value.slice(1)
    dataLines.push(value)
  }
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n')
  if (data === '') return undefined // 心跳空 data
  // 哨兵比对前 trim：SSE 规范允许冒号后跟多个空格（本实现只剥离第一个，其余保留），
  // 部分 provider / 兼容网关还会多发尾随空格。若不 trim，`data: [DONE] ` 会被当成
  // 普通数据帧送去做 JSON.parse，在**流的最末尾**抛协议错误——此时模型输出已经产出、
  // token 已消耗，却因最后一帧的空白字符判定整个回合失败，代价与收益严重不匹配。
  if (data.trim() === DONE_SENTINEL) return { kind: 'done' }
  return { kind: 'data', data }
}

/**
 * SSE 增量解析器。用法：`push(分片)` 取帧，流结束时再 `flush()` 收尾。
 * 实例**不可复用**（有内部缓冲与 done 状态）；一次流用一个实例。
 */
export class SseParser {
  /** 未组成完整块的残留文本。 */
  #buffer = ''
  /** 已收到 `[DONE]`：其后的一切输入都丢弃（provider 不应再发，防御性处理）。 */
  #done = false
  /**
   * 上一片结尾的裸 `\r`，留到下一片判断（review Y5）。
   *
   * 为什么不能逐片归一化：若一片以 `\r` 结尾、下一片以 `\n` 开头，逐片处理会把
   * 前者转成 `\n`、后者保留 `\n`，拼出 `\n\n` ——解析器误判为空行，把一个合法的
   * 多行 `data:` 事件拆成两个 frame（`data: a` + `data: b` 本应按规范以 `\n`
   * 合并成一条）。留一个字符到下一片再判断，`\r\n` 才不会被拆散。
   */
  #pendingCR = false

  /**
   * 喂入一个文本分片，返回本次可产出的全部帧。
   *
   * @param chunk 解码后的文本分片（可为任意长度，含半个字符的多字节序列由调用方的
   *              `TextDecoder({stream:true})` 负责，本函数只按字节边界拼接字符串）
   * @returns 帧数组（无完整块时为空数组）
   */
  push(chunk: string): SseFrame[] {
    if (this.#done) return []
    this.#buffer += this.#normalize(chunk)
    return this.#drain(false)
  }

  /**
   * 流结束：解析缓冲区中尚未以空行终止的残帧。
   * @returns 残帧构成的帧数组（缓冲区为空/已 done 时为空数组）
   */
  flush(): SseFrame[] {
    if (this.#done) return []
    // 流末尾遗留的裸 `\r` 仍是一个行结束符：补成 `\n` 再按残帧解析
    if (this.#pendingCR) {
      this.#buffer += '\n'
      this.#pendingCR = false
    }
    return this.#drain(true)
  }

  /**
   * 归一化行结束符（`\r\n` 与裸 `\r` 都视为 `\n`），并跨分片保留结尾的裸 `\r`。
   *
   * @returns 归一化后的文本（不含结尾未决的 `\r`）
   */
  #normalize(chunk: string): string {
    let text = this.#pendingCR ? `\r${chunk}` : chunk
    if (text.endsWith('\r')) {
      this.#pendingCR = true
      text = text.slice(0, -1)
    } else {
      this.#pendingCR = false
    }
    return text.replace(/\r\n?/g, '\n')
  }

  /** 切出缓冲区中的完整块；`final` 为真时把剩余文本当作最后一块处理。 */
  #drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = []
    let separator = this.#buffer.indexOf('\n\n')
    while (separator !== -1) {
      const frame = parseBlock(this.#buffer.slice(0, separator))
      this.#buffer = this.#buffer.slice(separator + 2)
      if (frame) {
        frames.push(frame)
        if (frame.kind === 'done') {
          this.#done = true
          this.#buffer = ''
          this.#pendingCR = false
          return frames
        }
      }
      separator = this.#buffer.indexOf('\n\n')
    }
    if (final && this.#buffer !== '') {
      const frame = parseBlock(this.#buffer)
      this.#buffer = ''
      if (frame) {
        frames.push(frame)
        // 与 while 分支保持一致：残帧若是 [DONE]，同样要标记 done，否则 flush 之后
        // 再 push 仍会被解析，与类契约"收到 [DONE] 后丢弃其后一切输入"相矛盾
        if (frame.kind === 'done') this.#done = true
      }
    }
    return frames
  }
}
