/**
 * 01-config 模块出口。
 *
 * 宿主（07 CLI）与集成测试一律经本文件 import，不深引用 `defaults.ts` / `load.ts`
 * 等内部文件。
 *
 * 出口分两类（X6 修订）：
 * - `loadConfig` / `createDefaultConfig` 是**宿主侧**能力（架构 §5.5：config 不属于
 *   插件系统），不经 `src/index.ts`；
 * - `resolvePermission` 是**插件侧**能力（05 在 pre-execute 调用），因此额外经
 *   `src/index.ts` 转发——否则 05 只能深引用 `src/config/permissions.js`，违反
 *   M0 确立的"内置模块不深引用内部路径"约定。
 */

export { loadConfig } from './load.js'
export { createDefaultConfig } from './defaults.js'
export { deepMerge, isPlainObject } from './merge.js'
export { validateConfig } from './validate.js'
export { resolvePermission } from './permissions.js'
export type { ConfigOverride, LoadConfigOptions } from './types.js'
