import { describe, expect, it } from 'vitest'

import { narrowWebConfig } from './plugin.js'
import { isLoopbackHost, normalizeBasePath, truncateForUi } from './server.js'

/**
 * 配置窄化与地址闸门单测（设计 §6.1）：
 * D4 的"只绑回环"在这里把关，narrow 的数组防线沿用 04 Y1。
 */

describe('narrowWebConfig', () => {
  it('未提供/为 null 时返回空对象', () => {
    expect(narrowWebConfig(undefined)).toEqual({})
    expect(narrowWebConfig(null)).toEqual({})
  })

  it('非对象（含数组）一律抛错', () => {
    expect(() => narrowWebConfig('x')).toThrow('must be an object')
    expect(() => narrowWebConfig([1, 2])).toThrow('must be an object')
  })

  it('合法字段逐一通过', () => {
    expect(narrowWebConfig({ port: 3080, host: 'localhost', basePath: '/mdsh' })).toEqual({
      port: 3080,
      host: 'localhost',
      basePath: '/mdsh',
    })
  })

  it('port：非整数 / 负数 / 越界一律抛错', () => {
    expect(() => narrowWebConfig({ port: 1.5 })).toThrow('`port` must be an integer')
    expect(() => narrowWebConfig({ port: -1 })).toThrow('`port` must be an integer')
    expect(() => narrowWebConfig({ port: 65536 })).toThrow('`port` must be an integer')
    expect(() => narrowWebConfig({ port: '3080' })).toThrow('`port` must be an integer')
    expect(narrowWebConfig({ port: 0 })).toEqual({ port: 0 })
  })

  it('host：空串/非字符串抛错', () => {
    expect(() => narrowWebConfig({ host: '' })).toThrow('`host` must be a non-empty string')
    expect(() => narrowWebConfig({ host: '  ' })).toThrow('`host` must be a non-empty string')
    expect(() => narrowWebConfig({ host: 1 })).toThrow('`host` must be a non-empty string')
  })

  it('basePath：合法形态归一化（去尾斜杠、根归一为空前缀）', () => {
    expect(narrowWebConfig({ basePath: '/' })).toEqual({ basePath: '' })
    expect(narrowWebConfig({ basePath: '' })).toEqual({ basePath: '' })
    expect(narrowWebConfig({ basePath: '/mdsh/' })).toEqual({ basePath: '/mdsh' })
    expect(() => narrowWebConfig({ basePath: 'mdsh' })).toThrow('must start with')
  })
})

describe('isLoopbackHost', () => {
  it('接受 localhost 与 127/8', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.1.2.3')).toBe(true)
  })

  it('接受 IPv6 回环的各写法', () => {
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::1%lo0')).toBe(true)
    expect(isLoopbackHost('[0:0:0:0:0:0:0:1]')).toBe(true)
  })

  it('拒绝 0.0.0.0 / 通配 / 局域网 / 公网地址', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
    expect(isLoopbackHost('8.8.8.8')).toBe(false)
  })

  it('拒绝写坏的 IPv4（段越界）', () => {
    expect(isLoopbackHost('127.0.0.999')).toBe(false)
  })
})

describe('normalizeBasePath', () => {
  it('根形态归一为空串', () => {
    expect(normalizeBasePath(undefined)).toBe('')
    expect(normalizeBasePath('')).toBe('')
    expect(normalizeBasePath('/')).toBe('')
  })

  it('普通前缀去尾斜杠', () => {
    expect(normalizeBasePath('/mdsh')).toBe('/mdsh')
    expect(normalizeBasePath('/mdsh/')).toBe('/mdsh')
  })

  it('不以 / 开头抛错', () => {
    expect(() => normalizeBasePath('mdsh')).toThrow()
  })
})

describe('truncateForUi', () => {
  it('短文本原样返回', () => {
    expect(truncateForUi('hello', 100)).toBe('hello')
  })

  it('超限文本头尾保留、中段省略，且总长受控', () => {
    const long = 'x'.repeat(5000)
    const out = truncateForUi(long, 1000)
    expect(out.length).toBeLessThanOrEqual(1100)
    expect(out.startsWith('x'.repeat(500))).toBe(true)
    expect(out.endsWith('x'.repeat(300))).toBe(true)
    expect(out).toContain('已省略')
  })
})
