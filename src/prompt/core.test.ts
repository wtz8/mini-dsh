import { describe, expect, it } from 'vitest'

import { CORE_SECTION_IDS, createCoreSections } from './core.js'
import { ENVIRONMENT_ID } from './sections/environment.js'
import { GUIDELINES_ID } from './sections/guidelines.js'
import { IDENTITY_ID } from './sections/identity.js'
import { TOOL_USE_ID } from './sections/tool-use.js'
import { PROMPT_ORDER } from './order.js'
import type { EnvFacts } from './types.js'

/**
 * `createCoreSections` 是纯函数层（设计 D3）：不依赖 ctx，事实经 getter 注入，
 * 因此段文案可以脱离组合根单测。
 */

function fixedEnv(): () => EnvFacts {
  return () => ({
    cwd: 'D:\\MiniDSH',
    platform: 'win32',
    arch: 'x64',
    now: new Date(2026, 9, 17, 21, 3, 13),
    model: 'deepseek/deepseek-chat',
    contextWindow: 131072,
  })
}

describe('createCoreSections', () => {
  it('默认返回全部四段，order 与 PROMPT_ORDER 一致且按升序排列', () => {
    const sections = createCoreSections({ env: fixedEnv(), hasTools: () => true })
    expect(sections.map((s) => s.id)).toEqual([
      IDENTITY_ID,
      ENVIRONMENT_ID,
      TOOL_USE_ID,
      GUIDELINES_ID,
    ])
    expect(sections.map((s) => s.order)).toEqual([
      PROMPT_ORDER.identity,
      PROMPT_ORDER.environment,
      PROMPT_ORDER.toolUse,
      PROMPT_ORDER.guidelines,
    ])
  })

  it('disabled 过滤生效：禁两段则只剩两段且保持原顺序', () => {
    const sections = createCoreSections({
      env: fixedEnv(),
      disabled: [ENVIRONMENT_ID, GUIDELINES_ID],
    })
    expect(sections.map((s) => s.id)).toEqual([IDENTITY_ID, TOOL_USE_ID])
  })

  it('disabled 含未知 id 时抛错，且错误信息里带该 id（死配置早暴露）', () => {
    expect(() => createCoreSections({ disabled: ['core/identty', 'core/whatever'] })).toThrow(
      /core\/identty/,
    )
    // 全部合法 id 都不应触发
    expect(() => createCoreSections({ disabled: [...CORE_SECTION_IDS] })).not.toThrow()
  })

  it('段文本均不含首尾空行（分隔符由容器统一给，段自带会产生三连换行）', () => {
    const sections = createCoreSections({ env: fixedEnv(), hasTools: () => true })
    for (const s of sections) {
      const text = s.render()
      expect(text.length).toBeGreaterThan(0)
      expect(text).toBe(text.trim())
      expect(text.startsWith('\n')).toBe(false)
      expect(text.endsWith('\n')).toBe(false)
    }
  })
})
