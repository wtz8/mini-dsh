import { describe, expect, it } from 'vitest'

import { IDENTITY_ID, createIdentitySection } from './identity.js'
import { PROMPT_ORDER } from '../order.js'

/** 身份段是**恒定段**：不读环境、不读注册表，两次 render 必须严格相等。 */
describe('identity section', () => {
  it('id 与 order 符合约定', () => {
    const s = createIdentitySection()
    expect(s.id).toBe(IDENTITY_ID)
    expect(s.order).toBe(PROMPT_ORDER.identity)
  })

  it('恒定：两次 render 严格相等，且含身份关键表述', () => {
    const text = createIdentitySection().render()
    expect(text).toBe(createIdentitySection().render())
    expect(text).toContain('MiniDSH')
    expect(text).toContain('终端')
  })
})
