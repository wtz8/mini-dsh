import { describe, expect, it } from 'vitest'

import { USAGE, parseFlags } from './flags.js'

/**
 * flags 解析单测（设计 §6.1 第 1–5 条）。
 *
 * 解析是纯函数，无需任何 IO：同一份 argv 必须给出同一结果，且**失败一律显式**
 * （未知 flag / 缺值 / 级别非法都返回 `undefined`，不静默忽略）。
 */
describe('parseFlags', () => {
  it('① 空 argv 得到全默认值', () => {
    const flags = parseFlags([])
    expect(flags).toEqual({ noProject: false, trustProject: false, help: false, version: false })
  })

  it('② 取值型 flag 正常解析，短写 -r 等价于 --resume', () => {
    const long = parseFlags(['--resume', 'abc123'])
    expect(long?.resume).toBe('abc123')

    const short = parseFlags(['-r', 'abc123'])
    expect(short?.resume).toBe('abc123')

    const dir = parseFlags(['--config-dir', '/tmp/mdsh'])
    expect(dir?.globalDir).toBe('/tmp/mdsh')

    const level = parseFlags(['--log-level', 'debug'])
    expect(level?.logLevel).toBe('debug')
  })

  it('③ 缺参数值 / 值本身是另一个 flag ⇒ 解析失败', () => {
    expect(parseFlags(['--resume'])).toBeUndefined()
    expect(parseFlags(['--resume', '--no-project'])).toBeUndefined()
    expect(parseFlags(['--config-dir'])).toBeUndefined()
    expect(parseFlags(['--log-level', 'trace'])).toBeUndefined()
    expect(parseFlags(['--resume', '   '])).toBeUndefined()
  })

  it('④ 布尔型 flag 与 help/version 置位', () => {
    const flags = parseFlags(['--no-project', '--trust-project', '--help'])
    expect(flags?.noProject).toBe(true)
    expect(flags?.trustProject).toBe(true)
    expect(flags?.help).toBe(true)

    expect(parseFlags(['-h'])?.help).toBe(true)
    expect(parseFlags(['-v'])?.version).toBe(true)
  })

  it('⑤ 未知 flag 一律失败（不静默忽略）', () => {
    expect(parseFlags(['--nope'])).toBeUndefined()
    expect(parseFlags(['--resume', 'x', '--nope'])).toBeUndefined()
  })

  it('附带：USAGE 文案列出全部七个 flag 与两条交互说明', () => {
    for (const flag of ['--resume', '--config-dir', '--no-project', '--trust-project', '--log-level', '--help', '--version']) {
      expect(USAGE).toContain(flag)
    }
    expect(USAGE).toContain('Ctrl+C')
    expect(USAGE).toContain('/exit')
  })
})
