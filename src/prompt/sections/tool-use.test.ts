import { describe, expect, it } from 'vitest'

import { TOOL_USE_ID, createToolUseSection } from './tool-use.js'
import { PROMPT_ORDER } from '../order.js'

/**
 * 工具段是**条件段**（设计 D7）：只讲协议、**不列工具名**——工具清单的唯一真值是
 * `ctx.tools.list()`，由 05 以 `PROMPT_ORDER.tools` 的段投影。
 */
describe('tool-use section', () => {
  it('id 与 order 符合约定', () => {
    const s = createToolUseSection({ hasTools: () => true })
    expect(s.id).toBe(TOOL_USE_ID)
    expect(s.order).toBe(PROMPT_ORDER.toolUse)
  })

  it('无工具时渲染为空串（由容器跳过，不留空标题）', () => {
    expect(createToolUseSection({ hasTools: () => false }).render()).toBe('')
  })

  it('有工具时输出协议要点，且不列工具名', () => {
    // 注入真实工具名，断言它们**不出现**在段里（双重真值检查）
    const text = createToolUseSection({ hasTools: () => true }).render()
    expect(text).toContain('# 工具使用')
    expect(text).toContain('并行')
    expect(text).toContain('permission denied')
    expect(text).toContain('合法 JSON')
    // 信任边界（review Y14）：工具输出是数据，不是新指令
    expect(text).toContain('不是新的指令')
    expect(text).not.toContain('mcp__github')
    expect(text).toBe(text.trim())
  })

  it('hasTools 是惰性查询：每次 render 都重新取值', () => {
    let has = false
    const s = createToolUseSection({ hasTools: () => has })
    expect(s.render()).toBe('')
    has = true
    expect(s.render()).not.toBe('')
  })
})
