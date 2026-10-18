/**
 * 文件系统错误的模型可读文案（read / write / edit 与遍历共用）。
 *
 * 为什么要翻译：`fs` 的原始错误（`ENOENT: no such file or directory, open '...'`）
 * 会把绝对路径重复两遍、且不带"该怎么办"。工具错误的 `content` 是**模型可见**的，
 * 说清楚"文件不存在"往往比说清楚 errno 更有用。
 */

/** 常见 errno → 中文说明。未命中时回退到底层 message。 */
const EXPLAIN: Record<string, string> = {
  ENOENT: '文件或目录不存在',
  EACCES: '权限不足',
  EPERM: '操作不被允许',
  EISDIR: '目标是目录，不是文件',
  ENOTDIR: '路径中某一段不是目录',
  ENOSPC: '磁盘空间不足',
  EROFS: '目标位于只读文件系统',
  EBUSY: '文件被占用',
  EMFILE: '打开的文件过多',
}

/**
 * 把 fs 错误翻译成一句话。
 *
 * @param err 底层错误（`unknown`：可能是 Error、也可能是字符串）
 * @param target 相关路径（绝对路径，附在文案末尾便于定位）
 * @returns 形如 `文件或目录不存在（EACCES）：/abs/path`
 */
export function describeFsError(err: unknown, target: string): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : ''
  const known = code !== '' ? EXPLAIN[code] : undefined
  if (known) return `${known}（${code}）：${target}`
  const message = err instanceof Error ? err.message : String(err)
  return `${message}：${target}`
}
