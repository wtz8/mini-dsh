import { describe, expect, it } from 'vitest'

import { APP_JS } from './assets/client.js'
import { PAGE_HTML } from './assets/page.js'
import { APP_CSS } from './assets/styles.js'

/**
 * 内联静态资源的格式自检（设计 §6.1）：
 * 这些字符串就是"前端构建产物"，语法坏了也要到打开浏览器时才暴露——
 * 因此在这里做静态检查，把故障挡在门禁里。
 */

describe('PAGE_HTML', () => {
  it('包含全部挂载点（JS 按 id 取元素，缺一个前端就静默失效）', () => {
    for (const id of [
      'stream',
      'approvals',
      'input',
      'send',
      'stop',
      'hint',
      'bubbles',
      'school',
      'm-session',
      'm-model',
      'm-tools',
      'mascot',
      'mascot-body',
      'fw-text',
      'conn-dot',
      'brand',
    ]) {
      expect(PAGE_HTML).toContain(`id="${id}"`)
    }
  })

  it('包含占位符（服务端替换点，丢了说明模板被改动）', () => {
    expect(PAGE_HTML).toContain('__BASE__')
    expect(PAGE_HTML).toContain('__THEME__')
  })

  it('大肥鱼元素齐备：吉祥物头像 / 每日鱼语 / 吉祥物 / 氛围层（无字标）', () => {
    expect(PAGE_HTML).toContain('mascot.webp')
    expect(PAGE_HTML).not.toContain('蓝色大肥鱼')
    expect(PAGE_HTML).toContain('每日鱼语')
    expect(PAGE_HTML).toContain('mascot')
    expect(PAGE_HTML).toContain('ambient')
  })

  it('无外链：不引任何 http(s) 资源', () => {
    expect(PAGE_HTML).not.toMatch(/(src|href)="https?:/)
  })

  it('标签配平（粗检：div 开闭数量一致）', () => {
    const open = (PAGE_HTML.match(/<div\b/g) ?? []).length
    const close = (PAGE_HTML.match(/<\/div>/g) ?? []).length
    expect(open).toBe(close)
  })
})

describe('APP_CSS', () => {
  it('双主题齐备（晴海白昼 / 深海夜）', () => {
    expect(APP_CSS).toContain('html[data-theme="light"]')
    expect(APP_CSS).toContain('html[data-theme="dark"]')
  })

  it('氛围层动画齐备：光晕 / 气泡 / 鱼群 / 吉祥物', () => {
    expect(APP_CSS).toContain('.caustics')
    expect(APP_CSS).toContain('.float-bubble')
    expect(APP_CSS).toContain('.fish')
    expect(APP_CSS).toContain('@keyframes breathe')
    expect(APP_CSS).toContain('@keyframes wave')
  })

  it('消息气泡与氛围气泡类名隔离（回归：撞名会让消息脱离文档流不可见）', () => {
    // .bubble 只作为消息气泡样式存在（无 position:absolute 的氛围属性）；
    // 行首锚定，排除 `.msg.user .bubble{` 这类复合选择器
    const msgBubble = APP_CSS.match(/(?:^|\n)\.bubble\{[^}]*\}/g) ?? []
    expect(msgBubble.length).toBe(1)
    expect(msgBubble[0]).not.toContain('position:absolute')
  })

  it('开关落点齐备（气泡 / 鱼群 / 吉祥物 / 减少动态）', () => {
    expect(APP_CSS).toContain('html[data-bubbles="0"]')
    expect(APP_CSS).toContain('html[data-school="0"]')
    expect(APP_CSS).toContain('html[data-mascot="0"]')
    expect(APP_CSS).toContain('html[data-reduce="1"]')
  })

  it('花括号配平', () => {
    const open = (APP_CSS.match(/\{/g) ?? []).length
    const close = (APP_CSS.match(/\}/g) ?? []).length
    expect(open).toBe(close)
  })

  it('不含模板字符串残留（`${}` 会进 TS 插值）', () => {
    expect(APP_CSS).not.toContain('${')
  })
})

describe('APP_JS', () => {
  it('语法可被 JS 引擎解析（new Function 静态检查）', () => {
    // 只解析不执行：语法错误在构造时就抛
    expect(() => new Function(APP_JS)).not.toThrow()
  })

  it('关键逻辑面齐备：SSE / 发送 / 审批 / 停止 / 主题', () => {
    expect(APP_JS).toContain('EventSource')
    expect(APP_JS).toContain('/api/turn')
    expect(APP_JS).toContain('/api/approve')
    expect(APP_JS).toContain('/api/cancel')
    expect(APP_JS).toContain('data-theme')
  })

  it('不含模板字符串残留（`${}` 与反引号会在 TS 编译期出问题）', () => {
    expect(APP_JS).not.toContain('${')
  })
})
