import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

/**
 * `glob` / `grep` 共用的目录遍历与 glob 匹配（零依赖）。
 *
 * 刻意不做的事（设计 Q7）：
 * - **不解析 `.gitignore`**：需要自己写 pattern 匹配 + 嵌套规则 + 取反语义，
 *   收益与"跳过两个大目录"重叠；
 * - **不跟随符号链接**：防环、防跳出工作目录；
 * - **跳过 `.git` / `node_modules`**：硬编码，不可配（配置文件里放不下更多策略）。
 */

/** 遍历时跳过的目录名（硬编码）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/** 单次遍历访问的条目上限：防止 monorepo 把一次工具调用拖成分钟级。 */
const DEFAULT_MAX_ENTRIES = 20_000

/** 目录深度上限。 */
const DEFAULT_MAX_DEPTH = 20

/** 遍历选项。 */
export interface WalkOptions {
  /** 相对路径过滤（不传 = 全部文件）；`relPath` 用 `/` 分隔 */
  match?: (relPath: string) => boolean
  /** 条目上限，默认 20_000 */
  maxEntries?: number
  /** 深度上限，默认 20 */
  maxDepth?: number
  /** 取消信号：每处理一个目录检查一次，已取消则尽早返回 */
  signal?: AbortSignal
}

/** 遍历结果。 */
export interface WalkResult {
  /** 相对 `baseDir` 的文件路径（`/` 分隔，升序） */
  files: string[]
  /** 是否因条目/深度上限提前停止 */
  truncated: boolean
}

/** 把平台分隔符统一成 `/`（输出稳定，测试与模型都更好读）。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * 递归遍历目录，返回全部（或过滤后的）文件相对路径。
 *
 * - 权限错误（EACCES）与遍历期间消失的目录**跳过并继续**：一个不可读的子目录
 *   不该让整次搜索失败；
 * - 不跟随符号链接（`dirent.isFile()` / `isDirectory()` 对链接均为 false）；
 * - 结果按路径升序，调用方可直接截断。
 *
 * @param baseDir 起点（已解析为绝对路径）
 * @param options 过滤与上限
 * @returns 文件相对路径与是否截断
 */
export async function walkFiles(baseDir: string, options: WalkOptions = {}): Promise<WalkResult> {
  const { match, maxEntries = DEFAULT_MAX_ENTRIES, maxDepth = DEFAULT_MAX_DEPTH, signal } = options
  const files: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: baseDir, depth: 0 }]
  let visited = 0
  let truncated = false

  while (stack.length > 0 && !truncated) {
    if (signal?.aborted) break
    const current = stack.pop()
    if (!current) break

    let entries: Dirent[]
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      // EACCES / ENOENT（遍历期间被删）：跳过该目录，不中断整体搜索
      continue
    }

    for (const entry of entries) {
      visited += 1
      if (visited > maxEntries) {
        truncated = true
        break
      }
      const abs = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (current.depth + 1 > maxDepth) continue
        stack.push({ dir: abs, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue // 符号链接 / 设备文件：不跟随
      const rel = toPosix(path.relative(baseDir, abs))
      if (!match || match(rel)) files.push(rel)
    }
  }

  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { files, truncated }
}

/**
 * 编译 glob 模式为匹配函数。
 *
 * 支持的语法：`**`（任意层）、`*`（段内任意字符）、`?`（段内单字符）。
 * **匹配基准**：模式含 `/` 时对整条相对路径匹配；不含 `/` 时对文件名（basename）匹配
 * ——后者与 ripgrep 的 `-g '*.ts'` 一致，`grep` 的 `glob` 过滤依赖这个语义。
 *
 * @param pattern glob 模式（`\` 会先归一成 `/`）
 * @returns 判断相对路径是否命中
 */
export function matchGlob(pattern: string): (relPath: string) => boolean {
  const normalized = pattern.split('\\').join('/')
  const onBasename = !normalized.includes('/')
  const re = globToRegExp(normalized)
  return (relPath: string): boolean => {
    const candidate = onBasename ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath
    return re.test(candidate)
  }
}

/** 把 glob 模式翻译为正则；只处理 `**` / `*` / `?`，其余字符按字面量转义。 */
function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 匹配零或多层目录；裸 `**` 匹配任意字符（含 `/`）
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
        continue
      }
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += escapeRegExp(ch ?? '')
  }
  out += '$'
  return new RegExp(out)
}

/** 转义正则元字符（逐字符调用）。 */
function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}
