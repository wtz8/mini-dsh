import { describe, expect, it } from 'vitest'

import { MAX_PUBLIC_TOOL_NAME_LENGTH } from './types.js'
import { publicToolName } from './naming.js'

/**
 * naming.ts 单测（设计 §6.1）：基本形态 / 非法字符清洗（有损 ⇒ 哈希后缀）/
 * 超长截断 / 清洗后撞名的两对输入仍不碰撞 / server 名校验。
 *
 * 注意 §3.3 的算法语义：只要清洗**有损**（normalized !== joined）就走哈希
 * 路径——即使结果不长。这是防碰撞的代价，测试按此断言。
 */

describe('publicToolName', () => {
  it('1 · 基本形态：合法输入原样拼接，无哈希后缀', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(publicToolName('web', 'search')).toBe('mcp__web__search')
  })

  it('2 · 非法字符被替换且追加 12 位短哈希（清洗是有损的）', () => {
    const name = publicToolName('s', 'admin.reset')
    // 点号被替换为 _，但因为有损，须以 12 位十六进制结尾
    expect(name.startsWith('mcp__s__admin_reset_')).toBe(true)
    expect(name).toMatch(/[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(MAX_PUBLIC_TOOL_NAME_LENGTH)
  })

  it('3 · 超长名截断到上限并追加短哈希', () => {
    const name = publicToolName('demo', 'x'.repeat(100))
    expect(name.length).toBe(MAX_PUBLIC_TOOL_NAME_LENGTH)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
  })

  it('4 · 清洗后撞名的两个输入产出不同的公开名（哈希防碰撞）', () => {
    // 两个 raw 都会被清洗成 admin_reset，但原始字节不同 ⇒ 哈希不同
    const a = publicToolName('s', 'admin.reset')
    const b = publicToolName('s', 'admin?reset')
    expect(a.startsWith('mcp__s__admin_reset_')).toBe(true)
    expect(b.startsWith('mcp__s__admin_reset_')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('5 · server 名非法（空 / 含空格 / 超长 / 非法字符）⇒ 抛错', () => {
    expect(() => publicToolName('', 'x')).toThrow(/server 名/)
    expect(() => publicToolName('has space', 'x')).toThrow(/server 名/)
    expect(() => publicToolName('a'.repeat(33), 'x')).toThrow(/server 名/)
    expect(() => publicToolName('非法', 'x')).toThrow(/server 名/)
  })
})
