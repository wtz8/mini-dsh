import type { PermissionAction } from '../contracts.js'

/**
 * 权限策略匹配（架构 §5.4 Q6 规则：**解析归 01、匹配归 05**）。
 *
 * 三级顺序：
 * 1. **精确键**：`permissions` 中存在与工具名完全相同的键 → 直接用其策略；
 * 2. **前缀通配键**：形如 `前缀*` 的键中，取**前缀最长**的命中者；只支持 `前缀*`
 *    形式，不做完整 glob；
 * 3. **兜底**：全部未命中 → `'ask'`（询问用户，最保守）。
 *
 * **为什么是"最长前缀"而不是"声明序"**（review 修订，见设计 §4.3 / X4）：
 * `permissions` 是三层配置**逐键深合并**的产物，合并后键的排列顺序由"哪一层先被
 * 合并"决定（全局层键恒排在项目层之前），与用户在任一文件里看到的书写顺序都不同。
 * 若按声明序取首个命中，全局层的宽泛规则（如 `mcp__*`）会永久压住项目层更严格的
 * 规则（如 `mcp__github*`）——**权限收紧静默失效**，且无任何诊断。改判"最长前缀"
 * 后，语义退化为"更具体的规则总是赢"，与用户在单文件内的直觉一致，也不再依赖
 * 不可见的键序。
 *
 * 裸 `"*"` 键在校验期已被拒绝（§4.2），故步骤 2 不会退化成"匹配一切"。
 * 含 `*` 但不在末尾的键（如 `a*b`）按普通精确键处理，永远不会被通配命中。
 *
 * @param permissions 已解析的权限表（通常取自 `ctx.config.permissions`，冻结后只读安全）
 * @param toolName 工具名（与 `ToolDefinition.name` 同值）
 * @returns 该工具名的生效策略
 */
export function resolvePermission(
  permissions: Readonly<Record<string, PermissionAction>>,
  toolName: string,
): PermissionAction {
  // 1. 精确键优先：用 hasOwnProperty 而非 `permissions[toolName] !== undefined`，
  //    避免继承键（Object.prototype 上的同名属性）被误判为已配置
  if (Object.prototype.hasOwnProperty.call(permissions, toolName)) {
    return permissions[toolName] as PermissionAction
  }
  // 2. 前缀通配：最长前缀优先（严格大于保证同长时取声明序在前者）
  let bestKey: string | undefined
  let bestPrefixLength = -1
  for (const key of Object.keys(permissions)) {
    if (key.length <= 1 || !key.endsWith('*')) continue
    const prefix = key.slice(0, -1)
    if (prefix.length > bestPrefixLength && toolName.startsWith(prefix)) {
      bestKey = key
      bestPrefixLength = prefix.length
    }
  }
  if (bestKey !== undefined) return permissions[bestKey] as PermissionAction
  // 3. 兜底
  return 'ask'
}
