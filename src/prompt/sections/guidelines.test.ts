import { describe, expect, it } from 'vitest'

import { GUIDELINES_ID, createGuidelinesSection } from './guidelines.js'
import { PROMPT_ORDER } from '../order.js'

/** 工作准则段是**恒定段**（设计 §3.1）：五条准则全部指向"少做不该做的事"。 */
describe('guidelines section', () => {
  it('id 与 order 符合约定（排在最后，紧邻用户输入前）', () => {
    const s = createGuidelinesSection()
    expect(s.id).toBe(GUIDELINES_ID)
    expect(s.order).toBe(PROMPT_ORDER.guidelines)
    expect(s.order).toBeGreaterThan(PROMPT_ORDER.toolUse)
  })

  it('五条准则的关键短语齐全，且文本无首尾空行', () => {
    const text = createGuidelinesSection().render()
    expect(text).toContain('# 工作准则')
    expect(text).toContain('先读后改')
    expect(text).toContain('最小改动')
    expect(text).toContain('不确定就问')
    expect(text).toContain('结论要有据')
    expect(text).toContain('中文')
    expect(text).toBe(text.trim())
  })
})
