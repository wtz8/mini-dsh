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
 * - `deriveMessages`：session log → `ChatMessage[]` 的纯函数投影（03 提供、06 消费，
 *   属插件侧能力；灵魂 #2 的唯一出口）；
 * - `PROMPT_ORDER`：prompt section 的 order 区间约定（04 提供、05/08 消费：order 是
 *   跨插件共享的排序资源，各模块写字面量必然漂移）；
 * - `createCoreSections`：内置 prompt 段组装（04 提供、07 消费：做"精简模式"时复用）；
 * - 运行时错误类 `ToolRejected` / `BootError` / `ConfigError` / `LlmError` / `SessionError`
 *   （01 起新增配置错误类，02 起新增 LLM 调用错误类，03 起新增会话存储错误类）。
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
/** 03 的插件侧能力：06 每 step 用它把 session log 投影成模型可见消息（灵魂 #2 的唯一出口） */
export { deriveMessages } from './session/derive.js'
/** 04 的插件侧能力：order 区间约定（05 用 `tools`、08 用 `memory`）与内置段组装 */
export { PROMPT_ORDER } from './prompt/order.js'
export { CORE_SECTION_IDS, createCoreSections } from './prompt/core.js'
export { ToolRejected, BootError, ConfigError, LlmError, SessionError } from './errors.js'
export type { LlmErrorKind, SessionErrorKind } from './errors.js'
