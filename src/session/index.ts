/**
 * 03-session 模块出口（宿主侧）。
 *
 * 插件侧能力（`deriveMessages`）另经 `src/index.ts` 转发——06 在回合循环里用它做
 * log 投影，不转发则只能深引用 `src/session/derive.js`（02 的 X3 约定）。
 */

export type {
  JsonlSessionStore,
  SessionEntry,
  SessionListener,
  SessionPluginConfig,
  SessionPluginOptions,
  SessionStoreOptions,
} from './types.js'
export { SESSION_FILE } from './types.js'
export { createSessionId } from './ids.js'
export { isSessionEvent } from './validate.js'
export { deriveMessages } from './derive.js'
export { createJsonlSessionStore } from './store.js'
export { BUILTIN_SESSION, createSessionPlugin, registerSessionBuiltin } from './plugin.js'
