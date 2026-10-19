import { describe, expect, it } from 'vitest'

import { createSessionId } from './ids.js'

/**
 * 会话 id 生成（设计 §4.1）：`YYYYMMDD-HHmmss-<base36 6 位>`。
 * 关键性质是"字典序 ≈ 创建顺序"与"文件系统安全"，两者都靠格式保证。
 */

describe('createSessionId', () => {
  it('格式为 YYYYMMDD-HHmmss-<base36 6 位>', () => {
    const id = createSessionId(new Date(2026, 9, 17, 15, 30, 12))
    expect(id).toMatch(/^20261017-153012-[0-9a-z]{6}$/)
  })

  it('时间戳逐字段补零（个位月/日/时也会补齐两位）', () => {
    const id = createSessionId(new Date(2026, 0, 2, 3, 4, 5))
    expect(id.startsWith('20260102-030405-')).toBe(true)
  })

  it('同一进程内连续生成不重复', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(createSessionId())
    expect(ids.size).toBe(200)
  })

  it('随机段不含文件系统不安全字符（科学计数法的 e / - / . 已被滤掉）', () => {
    for (let i = 0; i < 200; i++) {
      const rand = createSessionId().split('-')[2] ?? ''
      expect(rand).toHaveLength(6)
      expect(rand).toMatch(/^[0-9a-z]{6}$/)
    }
  })

  // review Y10：原实现 `Math.random().toString(36)` 的整数部分恒为 "0"，
  // 随机段首字符恒 '0'（实测 2 万样本），同秒碰撞空间缩 36 倍。
  it('随机段首字符在全 base36 上分布（不再恒为 0，review Y10）', () => {
    const firsts = new Set<string>()
    for (let i = 0; i < 200; i++) {
      firsts.add((createSessionId().split('-')[2] ?? '').charAt(0))
    }
    // 200 个样本、36 个可能字符：均匀分布下应观察到远多于 1 个不同首字符。
    // 只断言 >10：给随机性留足余量，同时足以排除"恒为 0"的退化
    expect(firsts.size).toBeGreaterThan(10)
  })
})
