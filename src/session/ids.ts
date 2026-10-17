/**
 * 会话 id 生成（03 设计 §4.1）。
 *
 * 格式：`YYYYMMDD-HHmmss-<base36 6 位>`，例 `20261017-153012-k3f9a2`。
 *
 * 为什么不用 `crypto.randomUUID()`：id 前缀是本地时间戳，于是**目录名字典序 ≈ 创建
 * 顺序**——`ls ~/.minidsh/sessions` 与人工排查都直观；且字符集合只含数字、小写字母
 * 与连字符，Windows / POSIX 文件系统都安全。
 *
 * 碰撞概率：同秒 + 6 位 base36 ≈ 1/2.8e8；即便真撞上，`create` 会检测到目标文件
 * 已存在并抛 `SessionError{kind:'io'}`，**绝不追加**（追加会混写两个会话）。
 */

/** 补零到指定宽度（时间戳逐字段拼接用）。 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * 生成一个会话 id。
 *
 * @param now 时间源（仅测试注入；生产用 `new Date()`）
 * @returns `YYYYMMDD-HHmmss-<base36 6 位>`
 */
export function createSessionId(now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // Math.random().toString(36) 在极小数（<1e-7）时会退化为科学计数法并带 'e'/'-'/'.'，
  // 故先滤掉非 [0-9a-z] 字符再取 6 位；不足 6 位时右侧补 '0'（概率极低，仅为保格式稳定）。
  const rand = Math.random()
    .toString(36)
    .replace(/[^0-9a-z]/g, '')
    .slice(0, 6)
    .padEnd(6, '0')
  return `${date}-${time}-${rand}`
}
