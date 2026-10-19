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

/** base36 字符表（随机段逐字符取样用，review Y10）。 */
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * 生成一个会话 id。
 *
 * @param now 时间源（仅测试注入；生产用 `new Date()`）
 * @returns `YYYYMMDD-HHmmss-<base36 6 位>`
 */
export function createSessionId(now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // 逐字符均匀取样（review Y10）：原实现 `Math.random().toString(36)` 滤掉非
  // [0-9a-z] 后取 6 位，但十进制小数 toString 的整数部分恒为 "0"——随机段首字符
  // 恒 '0'，同秒碰撞空间缩 36 倍（实测 2 万个样本首字符集合 = {'0'}）。逐字符
  // 取样让 6 位都用满 base36；科学计数法的 'e'/'-'/'.' 问题也随之消失
  const rand = Array.from({ length: 6 }, () => BASE36.charAt(Math.floor(Math.random() * 36))).join('')
  return `${date}-${time}-${rand}`
}
