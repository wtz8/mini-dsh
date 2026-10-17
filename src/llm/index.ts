/**
 * 02-llm 模块出口（宿主侧）。
 *
 * 07 CLI 与集成测试一律经本文件 import，不深引用 `sse.ts` / `wire.ts` 等内部文件。
 *
 * 出口分两类（沿用 01 的 X6 约定）：
 * - 本文件的 `createLlmPlugin` / `registerLlmBuiltin` 是**宿主侧**能力（07 启动装配用），
 *   不经 `src/index.ts`；
 * - `createToolCallAccumulator` 是**插件侧**能力（06 在回合循环里用），因此额外经
 *   `src/index.ts` 转发，否则 06 只能深引用本模块内部路径。
 *
 * 注：`createOpenAiAdapter` / `SseParser` 一并导出，因为它们是可脱离组合根直接单测的
 * 实现面（设计 §6.1），而非仅供内部使用的私有函数。
 */

export { createOpenAiAdapter } from './adapter.js'
export { createLlmPlugin, registerLlmBuiltin } from './plugin.js'
export { SseParser } from './sse.js'
export { createToolCallAccumulator } from './accumulate.js'
export { PROVIDER_DEEPSEEK } from './types.js'
export type { FetchLike, LlmPluginOptions, OpenAiAdapterOptions } from './types.js'
export type { SseFrame } from './sse.js'
export type { ToolCallAccumulator } from './accumulate.js'
