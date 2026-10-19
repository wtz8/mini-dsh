import { describe, expect, it } from 'vitest'

import { projectContent } from './result.js'

/**
 * result.ts 单测（设计 §6.1）：text 拼接 / 非文本占位（不泄 base64）/
 * resource_link / 空与畸形 / 未知类型。
 */

describe('projectContent', () => {
  it('12 · 多个 text 块按序以换行拼接', () => {
    const content = [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ]
    expect(projectContent(content, 'echo')).toBe('第一段\n第二段')
  })

  it('13 · image / audio / resource 降级为占位文本，base64 不进模型', () => {
    const content = [
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'audio', data: 'aGVsbG8=' },
      { type: 'resource', resource: { blob: 'aGVsbG8=' } },
    ]
    const out = projectContent(content, 'shot')
    expect(out).toContain('[不支持的 MCP 内容类型：image]')
    expect(out).toContain('[不支持的 MCP 内容类型：audio]')
    expect(out).toContain('[不支持的 MCP 内容类型：resource]')
    expect(out).not.toContain('aGVsbG8=')
  })

  it('14 · resource_link 投影为名称与 uri', () => {
    const content = [{ type: 'resource_link', name: 'README', uri: 'file:///repo/README.md' }]
    expect(projectContent(content, 'list')).toBe('资源链接：README（file:///repo/README.md）')
  })

  it('15 · 空数组 / 非数组 / 全部块无文本 ⇒ 占位提示', () => {
    const placeholder = '（echo 未返回可展示内容）'
    expect(projectContent([], 'echo')).toBe(placeholder)
    expect(projectContent(undefined, 'echo')).toBe(placeholder)
    expect(projectContent({ type: 'text' }, 'echo')).toBe(placeholder)
    expect(projectContent([{ type: 'text', text: '' }], 'echo')).toBe(placeholder)
  })

  it('16 · 未知块类型与非对象块 ⇒ 占位文本，不把原始内容序列化给模型', () => {
    const content = [{ type: 'video', blob: 'AAAA' }, '裸字符串', null]
    const out = projectContent(content, 'x')
    expect(out).toContain('[不支持的 MCP 内容类型：video]')
    expect(out).toContain('[不支持的 MCP 内容块]')
    expect(out).not.toContain('AAAA')
  })
})
