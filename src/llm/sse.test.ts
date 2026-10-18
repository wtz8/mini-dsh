import { describe, expect, it } from 'vitest'

import { SseParser } from './sse.js'

/**
 * SSE 解析器单元测试（设计 §6.1）：分片切断、CRLF、多 data 行、注释与无关字段、
 * `[DONE]`、心跳、flush 残帧。
 */

describe('SseParser · 基本分帧', () => {
  it('单帧解析：data 行产出 data 帧', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"a":1}\n\n')).toEqual([{ kind: 'data', data: '{"a":1}' }])
  })

  it('一个分片含多帧时一次全部产出', () => {
    const parser = new SseParser()
    const frames = parser.push('data: 1\n\ndata: 2\n\n')
    expect(frames).toEqual([
      { kind: 'data', data: '1' },
      { kind: 'data', data: '2' },
    ])
  })

  it('帧被切成 3 片喂入：跨片累积，只在块完整时产出', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"con')).toEqual([])
    expect(parser.push('tent":"he')).toEqual([])
    expect(parser.push('llo"}\n\n')).toEqual([{ kind: 'data', data: '{"content":"hello"}' }])
  })

  it('CRLF 终止（\\r\\n\\r\\n）同样切块', () => {
    const parser = new SseParser()
    expect(parser.push('data: x\r\n\r\n')).toEqual([{ kind: 'data', data: 'x' }])
  })

  it('多个 data 行按 SSE 规范以 \\n 连接（RFC 8895）', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\ndata: b\n\n')).toEqual([{ kind: 'data', data: 'a\nb' }])
  })

  it('CRLF 被分片切断（\\r 在片尾、\\n 在片首）不误判空行，多 data 行仍合并（review Y5）', () => {
    // 回归：逐片归一化会把片尾的 \r 变成 \n、片首的 \n 原样保留，拼出 \n\n，
    // 于是一个合法的多行 data 事件被拆成两个 frame
    const parser = new SseParser()
    expect(parser.push('data: a\r')).toEqual([])
    expect(parser.push('\ndata: b\r\n\r\n')).toEqual([{ kind: 'data', data: 'a\nb' }])
  })

  it('流末尾遗留的裸 \\r 在 flush 时仍按行结束符处理（review Y5）', () => {
    const parser = new SseParser()
    parser.push('data: tail\r')
    expect(parser.flush()).toEqual([{ kind: 'data', data: 'tail' }])
  })
})

describe('SseParser · 忽略与非帧', () => {
  it('注释行（含心跳）与 event/id/retry 字段被忽略', () => {
    const parser = new SseParser()
    expect(parser.push(': ping\nevent: message\nid: 42\nretry: 100\ndata: x\n\n')).toEqual([
      { kind: 'data', data: 'x' },
    ])
  })

  it('块内没有 data 字段时不产帧（只有 event 的块）', () => {
    const parser = new SseParser()
    expect(parser.push('event: ping\n\n')).toEqual([])
  })

  it('心跳空 data（data: 后无内容）不产帧', () => {
    const parser = new SseParser()
    expect(parser.push('data:\n\n')).toEqual([])
    expect(parser.push('data: \n\n')).toEqual([])
  })

  it('字段名后无冒号的行被忽略', () => {
    const parser = new SseParser()
    expect(parser.push('garbage\n\n')).toEqual([])
  })
})

describe('SseParser · [DONE] 与 flush', () => {
  it('[DONE] 产出 done 帧', () => {
    const parser = new SseParser()
    expect(parser.push('data: [DONE]\n\n')).toEqual([{ kind: 'done' }])
  })

  it('[DONE] 之后的输入全部丢弃（防御 provider 多发）', () => {
    const parser = new SseParser()
    parser.push('data: [DONE]\n\n')
    expect(parser.push('data: {"a":1}\n\n')).toEqual([])
    expect(parser.flush()).toEqual([])
  })

  it('flush 解析尾部未以空行终止的残帧', () => {
    const parser = new SseParser()
    expect(parser.push('data: tail')).toEqual([])
    expect(parser.flush()).toEqual([{ kind: 'data', data: 'tail' }])
  })

  it('flush 对空缓冲不产帧，且重复 flush 安全', () => {
    const parser = new SseParser()
    expect(parser.push('data: x\n\n')).toHaveLength(1)
    expect(parser.flush()).toEqual([])
    expect(parser.flush()).toEqual([])
  })

  it('[DONE] 带尾随空格仍识别为 done（否则流末会被当成非法 JSON 而判死整条流）', () => {
    expect(new SseParser().push('data: [DONE] \n\n')).toEqual([{ kind: 'done' }])
    expect(new SseParser().push('data: [DONE]\t\n\n')).toEqual([{ kind: 'done' }])
  })

  it('冒号后多个空格（SSE 规范允许）的 [DONE] 仍识别为 done', () => {
    // 实现只剥离冒号后的第一个空格，比对哨兵时统一 trim，故多空格不影响识别
    expect(new SseParser().push('data:  [DONE]\n\n')).toEqual([{ kind: 'done' }])
  })

  it('flush 产出的 [DONE] 与 push 路径一致：其后输入同样丢弃', () => {
    const parser = new SseParser()
    expect(parser.push('data: [DONE]')).toEqual([]) // 缺终止空行，留在缓冲
    expect(parser.flush()).toEqual([{ kind: 'done' }])
    // 状态机必须与 push 路径一致：done 之后再喂入不得产出帧
    expect(parser.push('data: {"a":1}\n\n')).toEqual([])
    expect(parser.flush()).toEqual([])
  })
})
