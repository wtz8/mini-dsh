/**
 * MiniDSH 公共 API 出口（SDK 面，薄导出）。
 *
 * 插件作者（含各 builtin 插件与 toy 插件）一律经本入口 import，
 * 不深引用 `src/plugin/` 内部路径。导出面（设计 §1）：
 * - 全部契约类型（`contracts.ts` 纯类型模块的整体转发）；
 * - `definePlugin` 插件工厂糖；
 * - `registerBuiltin`：builtin 插件表的注册入口（02–09 各内置模块用，返回退订句柄）；
 * - 组合根 `boot` / `shutdown`；
 * - 运行时错误类 `ToolRejected` / `BootError`。
 */

export type * from './contracts.js'
export { definePlugin } from './plugin/define-plugin.js'
export { boot, shutdown, registerBuiltin } from './plugin/boot.js'
export { ToolRejected, BootError } from './errors.js'
