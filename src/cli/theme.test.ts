import { describe, expect, it } from 'vitest'

import { PLAIN_THEME, RULE_WIDTH, createTheme, detectRich } from './theme.js'

/**
 * 呈现主题单测（§4.3.1）。
 *
 * 守的是三条：
 * - **plain 是恒等变换**（不是"去掉颜色"）——管道输出必须与富化改造前逐字节一致；
 * - **rich 的每段输出都自带收尾 RESET**，否则后续输出会一直带色；
 * - `detectRich` 的四条否决规则各自成立。
 */

const RICH = createTheme(true)

/**
 * 剥除 ANSI 转义序列，用于断言"着色没有改变文本内容"。
 *
 * 控制字符经 `ESC` 常量拼接：ESLint 的 `no-control-regex` 对正则里的 `\x1b`
 * （含 `new RegExp` 的字符串参数）一律报错，运行时拼接则看不到。
 */
const ESC = '\u001b'
const stripAnsi = (text: string): string => text.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '')

describe('PLAIN_THEME', () => {
  it('每个样式函数都是恒等变换', () => {
    for (const fn of [PLAIN_THEME.brand, PLAIN_THEME.accent, PLAIN_THEME.dim, PLAIN_THEME.ok, PLAIN_THEME.bad, PLAIN_THEME.warn]) {
      expect(fn('工具 read')).toBe('工具 read')
      expect(fn('')).toBe('')
      expect(fn('\x1b[31m')).toBe('\x1b[31m') // 连转义串本身也原样透传（不二次加工）
    }
  })

  it('rule() 是等宽裸横线，不含 ANSI', () => {
    const rule = PLAIN_THEME.rule()
    expect(rule).toBe('─'.repeat(RULE_WIDTH))
    expect(rule).not.toContain('\x1b')
  })

  it('rich === false；RULE_WIDTH 在 80 列终端下不折行', () => {
    expect(PLAIN_THEME.rich).toBe(false)
    expect(RULE_WIDTH).toBeLessThanOrEqual(80)
  })
})

describe('createTheme', () => {
  it('rich=false 时返回同一个 plain 实例（引用相等，便于判断）', () => {
    expect(createTheme(false)).toBe(PLAIN_THEME)
  })

  it('rich=true 时每段输出以 ANSI 开头、以 RESET 结尾，剥除后等于原文', () => {
    const fns: Array<[string, (text: string) => string]> = [
      ['brand', RICH.brand],
      ['accent', RICH.accent],
      ['dim', RICH.dim],
      ['ok', RICH.ok],
      ['bad', RICH.bad],
      ['warn', RICH.warn],
    ]
    for (const [name, fn] of fns) {
      const text = fn('read')
      expect(text.startsWith('\x1b['), `${name} 应以 ANSI 开头`).toBe(true)
      expect(text.endsWith('\x1b[0m'), `${name} 应以 RESET 收尾`).toBe(true)
      expect(stripAnsi(text)).toBe('read')
    }
  })

  it('rich=true 时 rule() 含 ANSI，剥除后仍是等宽横线', () => {
    const rule = RICH.rule()
    expect(rule).toContain(ESC + '[')
    expect(stripAnsi(rule)).toBe('─'.repeat(RULE_WIDTH))
  })
})

describe('detectRich', () => {
  /** Linux 终端、无 NO_COLOR / TERM：基准为真。 */
  const base = { stdoutIsTTY: true, env: { TERM: 'xterm-256color' }, platform: 'linux' as NodeJS.Platform }

  it('stdout 不是 TTY ⇒ 不富化（管道 / 重定向 / CI 日志）', () => {
    expect(detectRich({ ...base, stdoutIsTTY: false })).toBe(false)
  })

  it('NO_COLOR 非空 ⇒ 不富化（尊重显式关闭）', () => {
    expect(detectRich({ ...base, env: { ...base.env, NO_COLOR: '1' } })).toBe(false)
  })

  it('TERM=dumb ⇒ 不富化', () => {
    expect(detectRich({ ...base, env: { TERM: 'dumb' } })).toBe(false)
  })

  it('旧版 conhost（win32 且无 WT_SESSION / TERM）⇒ 不富化', () => {
    expect(detectRich({ stdoutIsTTY: true, env: {}, platform: 'win32' })).toBe(false)
  })

  it('Windows Terminal / VS Code 集成终端（有 WT_SESSION 或 TERM）⇒ 富化', () => {
    expect(detectRich({ stdoutIsTTY: true, env: { WT_SESSION: 'abc' }, platform: 'win32' })).toBe(true)
    expect(detectRich({ ...base, platform: 'win32' })).toBe(true)
  })

  it('普通终端 ⇒ 富化', () => {
    expect(detectRich(base)).toBe(true)
  })
})
