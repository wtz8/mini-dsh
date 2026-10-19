import { createHash } from 'node:crypto'

import {
  MAX_PUBLIC_TOOL_NAME_LENGTH,
  NAME_HASH_LENGTH,
  SERVER_NAME_PATTERN,
} from './types.js'

/**
 * 公开工具名算法（设计 §3.3 / Q6，照抄原版 `publicToolName`，属 v1 契约）。
 *
 * 模型看到的名字是 `mcp__<server>__<raw>`；`mcp__` 前缀是 05 的权限通配键
 * `mcp__*` 成立的前提（05 §8 附则）。两个不变式：
 *
 * 1. **只含 `[A-Za-z0-9_-]` 且不超长**：非法字符替换 `_`，超长截断；
 * 2. **不同 `(server, raw)` 永不碰撞**：清洗/截断是有损的（`a.b` 与 `a-b`、
 *    截断掉的后缀），有损时追加 `server\0raw` 的 SHA-256 前 12 位十六进制。
 *    不这么做，撞名会让 05 的容器抛 `already registered`、整个 boot 挂掉。
 *
 * wire 上永远用 `raw`（`tools/call` 发原始名），公开名从不发给 server、
 * 也从不反解析。
 */

/**
 * 校验 server 名（`servers` 配置表的键）。
 *
 * @throws Error 名字不匹配 `/^[A-Za-z0-9_-]{1,32}$/`（由 narrow 转为启动失败）
 */
export function assertServerName(server: string): void {
  if (!SERVER_NAME_PATTERN.test(server)) {
    throw new Error(
      `MCP server 名 '${server}' 非法：须匹配 ${SERVER_NAME_PATTERN.source}（它是公开工具名的一部分）`,
    )
  }
}

/**
 * 生成公开工具名（模型可见）。
 *
 * @param server 本地配置的 server 名（命名空间，不采信远端 `serverInfo.name`）
 * @param raw 远端工具名（wire 名）
 * @returns `mcp__<server>__<raw>` 的安全投影；有损时截断 + 短哈希
 * @throws Error server 名非法（先于任何变换抛出，配置错误早暴露）
 */
export function publicToolName(server: string, raw: string): string {
  assertServerName(server)
  const joined = `mcp__${server}__${raw}`
  // server 名已被 assertServerName 约束为合法字符集，因此 joined 与
  // normalized 的差异只能来自 raw 部分——整串清洗等价于只清洗 raw。
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_TOOL_NAME_LENGTH) {
    return normalized
  }
  // 有损路径：截断到「上限 − 哈希 − 连接符」再拼 12 位十六进制短哈希
  const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, NAME_HASH_LENGTH)
  const keep = MAX_PUBLIC_TOOL_NAME_LENGTH - NAME_HASH_LENGTH - 1
  return `${normalized.slice(0, keep)}_${hash}`
}
