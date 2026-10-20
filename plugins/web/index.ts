/**
 * web 插件的公共出口（薄导出）。
 *
 * **刻意不导出 `default`**：本插件的审批通道必须由宿主拿到并注入 agent-loop
 * （`createAgentPlugin({ approve })`），若能被 `config.plugins[].source` 直接加载，
 * 宿主就拿不到那个通道，`ask` 策略的工具会全部**失败关闭**（05 的 PB-02 ②）。
 * 没有 default 时，组合根会给出"has no default factory export"的明确报错，
 * 好过让用户在界面上困惑"为什么什么都写不了"。
 *
 * 正确用法见 `startWebHost`（`bin/mdsh-web.js` 的入口）。
 */

export { createWebPlugin, narrowWebConfig } from './plugin.js'
export { createApprovalChannel } from './approval.js'
export { createWebServer, isLoopbackHost, normalizeBasePath, truncateForUi } from './server.js'
export type { ApprovalSink, ResolvedWebOptions, WebServer, WebServerDeps } from './server.js'
export { parseWebFlags, startWebHost, withWebPlugin, WEB_USAGE } from './host.js'
export type { WebHostFlags } from './host.js'
export {
  BUILTIN_WEB_SOURCE,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  UI_RESULT_CHARS,
  WEB_BOOT_TIMEOUT_MS,
  WEB_PLUGIN_NAME,
  WEB_SHUTDOWN_TIMEOUT_MS,
} from './types.js'
export type {
  ApprovalChannel,
  ApprovalHandler,
  PendingApproval,
  StateSnapshot,
  UiEvent,
  WebPlugin,
  WebPluginBundle,
  WebPluginConfig,
  WebPluginOptions,
} from './types.js'
