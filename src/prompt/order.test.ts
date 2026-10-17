import { describe, expect, it } from 'vitest'

import { PROMPT_ORDER } from './order.js'

/**
 * order 是**跨插件共享的排序资源**（设计 D6）：05 用 `tools`、08 用 `memory`、
 * 07 用 `first`。常量表本身要能自解释"区间"，故断言其单调性。
 */
describe('PROMPT_ORDER', () => {
  it('各键取值唯一，且按声明顺序升序（区间约定不自相矛盾）', () => {
    const values = Object.values(PROMPT_ORDER)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })

  it('05 的工具 schema 位落在 04 的协议段与 08 的记忆段之间', () => {
    expect(PROMPT_ORDER.toolUse).toBeLessThan(PROMPT_ORDER.tools)
    expect(PROMPT_ORDER.tools).toBeLessThan(PROMPT_ORDER.memory)
  })
})
