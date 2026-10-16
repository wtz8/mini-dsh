import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLogger } from './logger.js'

/**
 * Logger 单元测试（设计 §6.1 补测）：级别过滤、stderr 目标、输出格式、
 * meta 序列化与降级四条行为。Logger 是 M0 内核直接交付的最终实现，此前无覆盖。
 */

/**
 * 捕获 stderr 写入内容（Logger 的输出目标；stdout 留给 07 渲染）。
 * `process.stderr.write` 有多组重载签名，此处按最宽的 `string | Uint8Array` 实现。
 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(process.stderr, 'write')
  spy.mockImplementation((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  return { lines, restore: () => spy.mockRestore() }
}

let capture = captureStderr()
afterEach(() => {
  capture.restore()
  capture = captureStderr()
})

describe('createLogger · 级别过滤', () => {
  it('低于阈值的调用被静默丢弃，等于/高于阈值的写出', () => {
    const log = createLogger('warn')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')

    expect(capture.lines).toEqual(['[warn] w\n', '[error] e\n'])
  })

  it('默认级别 info：debug 被丢弃，其余全出', () => {
    const log = createLogger('info')
    log.debug('d')
    log.info('i')
    expect(capture.lines).toEqual(['[info] i\n'])
  })

  it('级别取 debug 时全部输出；error 级别只出 error', () => {
    createLogger('debug').debug('d')
    expect(capture.lines).toEqual(['[debug] d\n'])

    capture.restore()
    capture = captureStderr()
    const errOnly = createLogger('error')
    errOnly.warn('w')
    errOnly.error('e')
    expect(capture.lines).toEqual(['[error] e\n'])
  })

  it('非法级别（来自未校验的 config）兜底为 info，不静默全放行', () => {
    const log = createLogger('verbose' as 'info')
    log.debug('d')
    log.info('i')
    expect(capture.lines).toEqual(['[info] i\n'])
  })
})

describe('createLogger · 输出格式与 meta', () => {
  it('格式为「[级别] 消息」，无 meta 时不带尾随空格，每条一行', () => {
    createLogger('info').info('hello')
    expect(capture.lines).toEqual(['[info] hello\n'])
  })

  it('多个 meta 以空格连接；字符串原样、对象 JSON 序列化', () => {
    createLogger('info').info('evt', 'plain', { a: 1 })
    expect(capture.lines).toEqual(['[info] evt plain {"a":1}\n'])
  })

  it('Error meta 输出 stack/message，而非 JSON.stringify 得到的 {}', () => {
    // 回归：JSON.stringify(new Error(...)) 恒为 {}，等于丢掉全部排障信息
    const err = new Error('boom')
    createLogger('info').error('failed', err)
    const line = capture.lines[0]!
    expect(line).toContain('[error] failed')
    expect(line).not.toContain('{}')
    expect(line).toContain('boom')
  })

  it('序列化失败（循环引用）退化为 String()，不把调用方炸掉', () => {
    const cyclic: Record<string, unknown> = { name: 'cyclic' }
    cyclic.self = cyclic

    expect(() => createLogger('info').info('msg', cyclic)).not.toThrow()
    expect(capture.lines[0]).toContain('[info] msg')
  })
})
