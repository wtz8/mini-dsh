/**
 * 05-tools 模块出口（宿主侧）。
 *
 * 插件侧（06）需要的 `createToolRunner` / `toToolSchemas` 与相关类型另经
 * `src/index.ts` 转发——宿主只经本文件，插件只经 `src/index.js`（02 X2 / 04 同一约定）。
 */

export { createToolRunner } from './pipeline.js'
export { toToolSchemas } from './projection.js'
export { createToolsSection, TOOLS_SECTION_ID } from './section.js'
export {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  createBashTimeoutResolver,
  createBuiltinTools,
  createToolsPlugin,
  registerToolsBuiltin,
} from './plugin.js'
export type {
  ApproveHandler,
  ToolRunContext,
  ToolRunner,
  ToolRunnerOptions,
  ToolsPluginOptions,
} from './types.js'
export { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_MAX_RESULT_CHARS } from './types.js'
export { resolvePath, displayPath } from './path.js'
