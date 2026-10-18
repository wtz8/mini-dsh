import os from 'node:os'
import path from 'node:path'

/**
 * 工具的相对路径解析基准。
 *
 * **这是 04 §5 那句跨模块承诺的唯一落点**：环境段告诉模型"所有相对路径都按上面的
 * 工作目录解析"，而那个工作目录取自 `process.cwd()`。若工具的基准不是它，系统提示
 * 就在骗模型（resume 到别处创建的会话时两边会不一致）。
 *
 * 六个内置工具一律经本函数解析路径，不要在工具里直接 `path.resolve`。
 */

/**
 * 把用户/模型给的路径解析为绝对路径。
 *
 * 规则：
 * 1. `~` 与 `~/x` 展开为 home 目录（模型常写 `~/.minidsh/...`）；
 * 2. 相对路径按**调用时刻**的 `process.cwd()` 解析（目录可能被工具改变）；
 * 3. 绝对路径原样规范化。
 *
 * @param input 原始路径（非空字符串）
 * @returns 规范化后的绝对路径
 * @throws Error 输入不是非空字符串（属参数错误，由 pipeline 转 `invalid_args`/`execution_error`）
 */
export function resolvePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path must be a non-empty string')
  }
  const raw = input.trim()
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(os.homedir(), raw.slice(2))
  }
  return path.resolve(process.cwd(), raw)
}

/**
 * 把路径转成模型友好的展示形式：`cwd` 之下的路径显示为相对路径，
 * 之外的保持绝对路径（便于模型判断"文件在项目里还是系统里"）。
 *
 * @param absolute 已解析的绝对路径
 * @returns 展示用路径（统一用 `/` 分隔，避免 Windows 反斜杠在 markdown 里被当转义）
 */
export function displayPath(absolute: string): string {
  const rel = path.relative(process.cwd(), absolute)
  const shown = rel === '' ? '.' : rel
  const use = shown.startsWith('..') || path.isAbsolute(shown) ? absolute : shown
  return use.split(path.sep).join('/')
}
