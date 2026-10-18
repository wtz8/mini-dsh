import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { displayPath, resolvePath } from './path.js'

/** 路径解析基准（设计 D6）：相对路径必须按 `process.cwd()`，`~` 展开为 home。 */
describe('resolvePath', () => {
  it('相对路径按 process.cwd() 解析', () => {
    expect(resolvePath('a/b.txt')).toBe(path.resolve(process.cwd(), 'a/b.txt'))
  })

  it('绝对路径原样规范化（不叠加 cwd）', () => {
    const abs = path.resolve(process.cwd(), 'x.txt')
    expect(resolvePath(abs)).toBe(abs)
  })

  it('展开 ~ 与 ~/sub', () => {
    expect(resolvePath('~')).toBe(os.homedir())
    expect(resolvePath('~/.minidsh/config.json')).toBe(path.join(os.homedir(), '.minidsh/config.json'))
  })

  it('空串与空白被拒绝', () => {
    expect(() => resolvePath('')).toThrow(/non-empty string/)
    expect(() => resolvePath('   ')).toThrow(/non-empty string/)
  })
})

describe('displayPath', () => {
  it('cwd 之下的路径显示为相对路径（统一用 /）', () => {
    const abs = path.resolve(process.cwd(), 'src/tools/index.ts')
    expect(displayPath(abs)).toBe('src/tools/index.ts')
  })

  it('cwd 之外的路径保持绝对路径', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\system.ini' : '/etc/hosts'
    expect(displayPath(outside)).toBe(outside.split(path.sep).join('/'))
  })
})
