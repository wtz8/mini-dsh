/**
 * MiniDSH 公共 API 出口（SDK 面，薄导出）。
 *
 * 插件作者（含各 builtin 插件与 toy 插件）一律经本入口 import，
 * 不深引用 `src/plugin/` 内部路径。导出面（设计 §1）：
 * - 全部契约类型（`contracts.ts` 纯类型模块的整体转发）；
 * - `definePlugin` 插件工厂糖；
 * - `registerBuiltin`：builtin 插件表的注册入口（02–09 各内置模块用，返回退订句柄）；
 * - 组合根 `boot` / `shutdown`；
 * - `resolvePermission`：权限匹配函数（01 解析、05 在 pre-execute 调用，属插件侧能力）；
 * - `createToolCallAccumulator`：tool-call 增量聚合器（02 提供、06 消费，属插件侧能力）；
 * - 运行时错误类 `ToolRejected` / `BootError` / `ConfigError` / `LlmError`
 *   （01 起新增配置错误类，02 起新增 LLM 调用错误类）。
 *
 * 01 的 `loadConfig()` 是宿主侧能力（架构 §5.5：config 不属于插件系统），
 * 不经本出口，宿主与集成测试从 `src/config/index.js` 引入。
 */

export type * from './contracts.js'
export { definePlugin } from './plugin/define-plugin.js'
export { boot, shutdown, registerBuiltin } from './plugin/boot.js'
export { resolvePermission } from './config/permissions.js'
/** 02 的插件侧能力：06 在回合循环里用它把 tool-call 增量拼回完整调用（设计 §2.2） */
export { createToolCallAccumulator } from './llm/accumulate.js'
export type { ToolCallAccumulator } from './llm/accumulate.js'
export { ToolRejected, BootError, ConfigError, LlmError } from './errors.js'
export type { LlmErrorKind } from './errors.js'
