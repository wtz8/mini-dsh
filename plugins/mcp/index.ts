/**
 * MCP 插件入口（`plugins/mcp/index.ts`）。
 *
 * - **default 导出**：boot 经 `import()` 取此工厂（00 §4.1 `resolveFactory`
 *   只认 default）。生产配置写
 *   `{ "source": "./dist/plugins/mcp/index.js", "config": { "servers": {...} } }`。
 * - **具名导出**：常量、类型与纯函数出口，服务单测与复用（与 08 的
 *   `plugins/memory/index.ts` 同式）。
 */

import { createMcpPlugin } from './plugin.js'

export default createMcpPlugin()

export { MCP_PLUGIN_NAME, MCP_TOOL_PREFIX } from './types.js'
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  MAX_PUBLIC_TOOL_NAME_LENGTH,
} from './types.js'
export type { McpOptions, McpServerSpec, SpawnLike } from './types.js'
export type { McpRemoteTool, McpCallOutcome } from './types.js'

/** 命名算法（v1 契约，Q6）。 */
export { publicToolName, assertServerName } from './naming.js'
/** inputSchema 收窄（§4.3）。 */
export { normalizeInputSchema } from './schema.js'
/** 结果投影（§4.5）。 */
export { projectContent } from './result.js'
/** 远端工具 → ToolDefinition（§4.4）。 */
export { createMcpTool } from './tools.js'

/** 单 server 连接（可注入 spawn，供高级用法与测试直接构造）。 */
export { createMcpClient } from './client.js'
export type { McpClient, McpClientOptions, McpCallOptions } from './client.js'

/** JSON-RPC 会话（纯逻辑层，服务测试与协议复用）。 */
export { createJsonRpcSession } from './rpc.js'
export type { JsonRpcSession, JsonRpcRequestOptions } from './rpc.js'

/** 插件工厂（default 导出的构造器本体）。 */
export { createMcpPlugin } from './plugin.js'
