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
})
