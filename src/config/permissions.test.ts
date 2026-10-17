import { describe, expect, it } from 'vitest'

import type { PermissionAction } from '../contracts.js'
import { resolvePermission } from './permissions.js'

/**
 * 权限匹配单元测试（设计 §6.1 / §4.3）：架构 §5.4 Q6 的三级规则
 * —— 精确键 > 前缀通配（最长前缀优先，X4 修订） > 兜底 ask。
 *
 * 字面量统一标注为 `Record<string, PermissionAction>`：否则 `'auto'` 会被推成 `string`。
 */

describe('resolvePermission · 精确键优先', () => {
  it('存在完全同名的键时直接用其策略', () => {
    const permissions: Record<string, PermissionAction> = { bash: 'ask', 'mcp__*': 'auto' }
    expect(resolvePermission(permissions, 'bash')).toBe('ask')
  })

  it('精确键优先于能匹配同一工具名的通配键', () => {
    // 'mcp__github' 同时命中精确键与 'mcp__*'，必须取精确键的 deny
    const permissions: Record<string, PermissionAction> = { 'mcp__*': 'auto', mcp__github: 'deny' }
    expect(resolvePermission(permissions, 'mcp__github')).toBe('deny')
  })
})

describe('resolvePermission · 前缀通配', () => {
  it('前缀通配命中（mcp__* 匹配 mcp__ 开头的工具名）', () => {
    const permissions: Record<string, PermissionAction> = { 'mcp__*': 'auto', read: 'auto' }
    expect(resolvePermission(permissions, 'mcp__github')).toBe('auto')
    expect(resolvePermission(permissions, 'mcp__fs')).toBe('auto')
  })

  it('多个通配键取前缀最长者（更具体的规则赢，而非声明序在前者）', () => {
    // 修订后语义（X4）：'mcp__g*' 比 'mcp__*' 更具体，必须赢
    const permissions: Record<string, PermissionAction> = { 'mcp__*': 'auto', 'mcp__g*': 'deny' }
    expect(resolvePermission(permissions, 'mcp__github')).toBe('deny')
    // 未被更长前缀覆盖的工具名仍走较短前缀
    expect(resolvePermission(permissions, 'mcp__fs')).toBe('auto')
  })

  it('跨层合并后，项目层更具体的规则能压住全局层的宽泛规则（X4 回归）', () => {
    // 全局 {"mcp__*":"auto"} + 项目 {"mcp__github*":"deny"} 的合并结果：
    // 键序为 ["mcp__*", "mcp__github*"]（全局层在前），按声明序会让 deny 永不生效
    const merged: Record<string, PermissionAction> = { 'mcp__*': 'auto', 'mcp__github*': 'deny' }
    expect(resolvePermission(merged, 'mcp__github_list')).toBe('deny')
    expect(resolvePermission(merged, 'mcp__gitlab_x')).toBe('auto')
  })

  it('前缀匹配是大小写敏感且要求完整前缀', () => {
    const permissions: Record<string, PermissionAction> = { 'mcp__*': 'auto' }
    expect(resolvePermission(permissions, 'MCP__github')).toBe('ask')
    expect(resolvePermission(permissions, 'mcp_')).toBe('ask')
    expect(resolvePermission(permissions, 'other')).toBe('ask')
  })

  it('* 不在末尾的键按普通精确键处理，不会被当成通配', () => {
    const permissions: Record<string, PermissionAction> = { 'a*b': 'auto' }
    expect(resolvePermission(permissions, 'axb')).toBe('ask') // 通配不生效
    expect(resolvePermission(permissions, 'a*b')).toBe('auto') // 仅精确同名命中
  })
})

describe('resolvePermission · 兜底与三值', () => {
  it('全部未命中时兜底 ask（含空表）', () => {
    expect(resolvePermission({}, 'bash')).toBe('ask')
    expect(resolvePermission({ read: 'auto' }, 'bash')).toBe('ask')
  })

  it('继承键不被误判为已配置（hasOwnProperty 而非取值判空）', () => {
    // 工具名 'toString' 在 Object.prototype 上可取值，但不是用户配置
    expect(resolvePermission({}, 'toString')).toBe('ask')
  })

  it('三值语义：auto / ask / deny 各自原样返回', () => {
    const permissions: Record<string, PermissionAction> = { a: 'auto', b: 'ask', c: 'deny' }
    expect(resolvePermission(permissions, 'a')).toBe('auto')
    expect(resolvePermission(permissions, 'b')).toBe('ask')
    expect(resolvePermission(permissions, 'c')).toBe('deny')
  })
})
