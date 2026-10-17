import { describe, expect, it } from 'vitest'

import {
  ENVIRONMENT_ID,
  createEnvironmentSection,
  formatDateTime,
  localTimeZone,
  safeCwd,
} from './environment.js'
import { PROMPT_ORDER } from '../order.js'
import type { EnvFacts } from '../types.js'

/** 固定事实：让段输出**逐字可预测**（时间用本地时区构造，与格式化口径一致）。 */
function fixedFacts(): EnvFacts {
  return {
    cwd: 'D:\\MiniDSH',
    platform: 'win32',
    arch: 'x64',
    now: new Date(2026, 9, 17, 21, 3, 13),
    model: 'deepseek/deepseek-chat',
    contextWindow: 131072,
  }
}

function renderWith(facts: EnvFacts): string {
  return createEnvironmentSection({ env: () => facts }).render()
}

describe('environment section', () => {
  it('id 与 order 符合约定', () => {
    const s = createEnvironmentSection({ env: fixedFacts })
    expect(s.id).toBe(ENVIRONMENT_ID)
    expect(s.order).toBe(PROMPT_ORDER.environment)
  })

  it('注入固定事实时输出逐字可预测', () => {
    expect(renderWith(fixedFacts())).toBe(
      [
        '# 运行环境',
        '',
        '- 工作目录：D:\\MiniDSH',
        '- 操作系统：win32 / x64',
        `- 当前时间：2026-10-17 21:03:13（本地时区 ${localTimeZone()}）`,
        '- 模型：deepseek/deepseek-chat',
        '- 上下文窗口：131072 tokens',
        '',
        '所有相对路径都按上面的工作目录解析。',
      ].join('\n'),
    )
  })

  it('model / contextWindow 缺省时对应行不渲染', () => {
    const text = renderWith({
      cwd: '/tmp',
      platform: 'linux',
      arch: 'arm64',
      now: new Date(2026, 0, 2, 3, 4, 5),
    })
    expect(text).not.toContain('模型')
    expect(text).not.toContain('上下文窗口')
    expect(text).toContain('- 操作系统：linux / arm64')
  })

  it('时间格式化逐字段补零（本地时区口径，不用 UTC）', () => {
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05')
    expect(formatDateTime(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31 23:59:59')
  })

  it('localTimeZone 返回非空字符串（无 ICU 数据时的兜底路径不在此触发）', () => {
    expect(localTimeZone().length).toBeGreaterThan(0)
  })

  it('每次 render 重新取 env（动态段：长会话跨日/改目录都能反映）', () => {
    let cwd = 'D:\\before'
    const s = createEnvironmentSection({ env: () => ({ ...fixedFacts(), cwd }) })
    expect(s.render()).toContain('D:\\before')
    cwd = 'D:\\after'
    expect(s.render()).toContain('D:\\after')
  })
})

describe('safeCwd', () => {
  it('默认读取 process.cwd()', () => {
    expect(safeCwd()).toBe(process.cwd())
  })

  it('读取抛错（目录被删除/无权限）时兜底为 unknown，不让 render 失败', () => {
    expect(safeCwd(() => { throw new Error('ENOENT') })).toBe('unknown')
  })
})
