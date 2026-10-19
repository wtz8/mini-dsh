import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolEnv } from '../../contracts.js'
import { createGlobTool } from './glob.js'

/** `glob` 工具：`**` / `*` / `?`、基准目录、跳过 node_modules 与 .git、截断提示。 */

let dir: string
const tool = createGlobTool()

function env(signal = new AbortController().signal): ToolEnv {
  return { callId: 'c1', sessionId: 's1', signal }
}

async function seed(): Promise<void> {
  await fs.mkdir(path.join(dir, 'src/deep'), { recursive: true })
  await fs.mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true })
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })
  await fs.writeFile(path.join(dir, 'root.ts'), '')
  await fs.writeFile(path.join(dir, 'src/a.ts'), '')
  await fs.writeFile(path.join(dir, 'src/deep/b.ts'), '')
  await fs.writeFile(path.join(dir, 'src/deep/c.md'), '')
  await fs.writeFile(path.join(dir, 'node_modules/pkg/x.ts'), '')
  await fs.writeFile(path.join(dir, '.git/hook.ts'), '')
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdsh-glob-'))
  await seed()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('glob 工具', () => {
  it('`*.ts` 按文件名匹配，含子目录（与 ripgrep -g 语义一致）', async () => {
    const out = await tool.execute({ pattern: '*.ts', path: dir }, env())
    expect(out).toContain('root.ts')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/deep/b.ts')
    expect(out).not.toContain('c.md')
  })

  it('`src/*.ts` 只匹配该层（模式含 / 时对整条相对路径匹配）', async () => {
    const out = await tool.execute({ pattern: 'src/*.ts', path: dir }, env())
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('src/deep/b.ts')
  })

  it('`**/*.ts` 递归匹配任意层', async () => {
    const out = await tool.execute({ pattern: '**/*.ts', path: dir }, env())
    expect(out).toContain('src/deep/b.ts')
  })

  it('`?` 匹配单个字符', async () => {
    const out = await tool.execute({ pattern: 'src/?.ts', path: dir }, env())
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('src/deep/b.ts')
  })

  it('跳过 node_modules 与 .git', async () => {
    const out = await tool.execute({ pattern: '**/*.ts', path: dir }, env())
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('.git')
  })

  it('无匹配返回（无匹配）', async () => {
    const out = await tool.execute({ pattern: '*.nope', path: dir }, env())
    expect(out).toBe('（无匹配）')
  })

  it('limit 截断时附说明', async () => {
    const out = await tool.execute({ pattern: '*.ts', path: dir, limit: 1 }, env())
    expect(out).toContain('已截断')
    expect(out).toContain('仅显示前 1 条')
  })

  // Y7：`walkFiles` 被取消时静默返回半截（truncated=false）。若工具不自己拦，取消会
  // 变成"一份看起来完整的匹配列表"——下一回合模型据此下结论，而事实只搜了一部分。
  it('已取消时抛错，而不是返回“（无匹配）”', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ pattern: '*.ts', path: dir }, env(controller.signal))).rejects.toThrow(/取消/)
  })
})
