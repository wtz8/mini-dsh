/**
 * 04-prompt 模块出口（宿主侧）。
 *
 * 四类导出：`PROMPT_ORDER`（跨插件排序约定，插件侧另经 `src/index.ts` 转发）、
 * `createCoreSections`（纯函数段组装）、插件工厂与 builtin 注册、模块内类型。
 */

export { PROMPT_ORDER } from './order.js'
export { CORE_SECTION_IDS, createCoreSections } from './core.js'
export { BUILTIN_PROMPT, createPromptPlugin, registerPromptBuiltin } from './plugin.js'
export {
  ENVIRONMENT_ID,
  createEnvironmentSection,
  formatDateTime,
  localTimeZone,
  safeCwd,
} from './sections/environment.js'
export { GUIDELINES_ID, createGuidelinesSection } from './sections/guidelines.js'
export { IDENTITY_ID, createIdentitySection } from './sections/identity.js'
export { TOOL_USE_ID, createToolUseSection } from './sections/tool-use.js'
export type { CoreSectionsOptions, EnvFacts, PromptPluginConfig, PromptPluginOptions } from './types.js'
export type { EnvironmentSectionOptions } from './sections/environment.js'
export type { ToolUseSectionOptions } from './sections/tool-use.js'
