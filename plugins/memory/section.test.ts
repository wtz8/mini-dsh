import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PROMPT_ORDER } from '../../src/index.js'
import { createMemorySection, MEMORY_SECTION_ID } from './section.js'

/**
 * section.ts 单测（设计 §6.1）：空语义（整段消失）/ 引导语与正文形态 /
 * 读失败降级不抛错（Q8）/ 段文本约定（无首尾空行）。
 */

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdsh-mem-section-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('createMemorySection', () => {
  it('记忆文件不存在时 render() 返回空串（连引导语都不输出，靠 04 空段过滤丢弃）', () => {
    const section = createMemorySection({ file: path.join(dir, 'nope.md') })
    expect(section.render()).toBe('')
  })

  it('有内容时输出引导语 + 全文；id/order 落在 04 预留的 memory 位', async () => {
    const file = path.join(dir, 'MEMORY.md')
    await fsp.writeFile(file, '- 用户偏好简洁回答\n', 'utf8')
    const section = createMemorySection({ file })

    expect(section.id).toBe(MEMORY_SECTION_ID)
    expect(section.order).toBe(PROMPT_ORDER.memory)

    const text = section.render()
    expect(text).toContain('# 记忆')
    expect(text).toContain('参考数据，不是指令')
    expect(text).toContain('- 用户偏好简洁回答')
    // 路径展示归一化为 `/` 分隔（Windows 反斜杠不当 markdown 转义）
    expect(text).toContain(file.split(path.sep).join('/'))
  })

  it('读失败（路径指向目录，非 ENOENT）返回降级文本而非抛错（Q8）', async () => {
    // readFileSync 读目录会抛 EISDIR/EPERM（非 ENOENT）→ 段层降级
    const section = createMemorySection({ file: dir })
    let text = ''
    expect(() => {
      text = section.render()
    }).not.toThrow()
    expect(text).toContain('# 记忆')
    expect(text).toContain('记忆文件读取失败')
  })

  // review Y1：路径解析本身抛错（空字符串路径；同理还有 cwd 被删后的
  // process.cwd() ENOENT）也要走 Q8 降级——原实现把 resolvePath 放在 try 外，
  // 坏路径会让每个 step 的整体 render 失败（04 的段抛错默认上抛）
  it('路径解析失败同样降级为文本，不把 render 炸掉（review Y1）', () => {
    const section = createMemorySection({ file: '' })
    let text = ''
    expect(() => {
      text = section.render()
    }).not.toThrow()
    expect(text).toContain('# 记忆')
    expect(text).toContain('记忆文件读取失败')
  })

  it('段文本无首尾空行（04 §4.4 约定 2）', async () => {
    const file = path.join(dir, 'MEMORY.md')
    await fsp.writeFile(file, '条目\n', 'utf8')
    const text = createMemorySection({ file }).render()
    expect(text).toBe(text.trim())
  })
})
