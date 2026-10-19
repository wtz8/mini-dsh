import type { ChildProcess } from 'node:child_process'

import type { JsonSchema, Logger } from '../../src/index.js'

/**
 * MCP 插件的公共常量与类型词汇（设计 §3）。
 *
 * 本文件不含运行时逻辑：常量与类型是 `plugins/mcp/` 内部各文件及外部
 * （单测、复用方）共同消费的词汇表，经 `index.ts` 整体转发。
 */

/** 插件名（`plugin/mounted` 事件与 07 信任确认中显示的名字）。 */
export const MCP_PLUGIN_NAME = 'mcp'

/** 公开工具名前缀（05 §8 附则：`mcp__*` 通配键依赖此前缀，缺它权限兜底语义漂移）。 */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 公开工具名长度上限（设计 Q6，与原版一致）：DeepSeek 函数名契约的有效字符集
 * 与长度；超长则截断并追加 12 位短哈希防碰撞（见 `naming.ts`）。
 */
export const MAX_PUBLIC_TOOL_NAME_LENGTH = 64

/** 短哈希长度（十六进制字符数）；截断场景下追加在公开名尾部。 */
export const NAME_HASH_LENGTH = 12

/** server 名的合法字符集与长度（原版同约束；它将出现在公开工具名里）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 单次 `tools/call` 的默认超时（毫秒）；可在 server 配置 `requestTimeoutMs` 覆盖。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** 单个 server 从 spawn 到 `tools/list` 返回的整体默认超时（毫秒）。 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

/** dispose 时等待子进程退出的上限（毫秒）；绝不无限等（设计 §4.6）。 */
export const DISPOSE_CLOSE_TIMEOUT_MS = 2_000

/** stderr 单行进入日志前的截断长度（字符）；过长只留头部。 */
export const STDERR_LINE_MAX_CHARS = 500

/**
 * spawn 注入口签名（设计 D5）：与 `child_process.spawn` 兼容，
 * 测试注入伪实现以确定性驱动子进程边界（02 的 `fetchImpl` 同式）。
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess

/** 单个 MCP server 的启动规格（实例配置 `plugins[].config.servers[name]`）。 */
export interface McpServerSpec {
  /**
   * 可执行文件。不做 shell 包装（Q10）：Windows 下 `npx` 须写 `npx.cmd`，
   * 否则 spawn 报 ENOENT（错误消息会带提示）。
   */
  command: string
  /** 命令行参数。 */
  args?: string[]
  /**
   * 追加/覆盖给子进程的环境变量；值形如 `'$ENV:NAME'` 时取父进程同名变量（Q14），
   * 取不到则该 server 启动失败（不静默传空值）。
   */
  env?: Record<string, string>
  /** 子进程工作目录；缺省继承当前进程。 */
  cwd?: string
  /** 单次 `tools/call` 超时（毫秒）；缺省 {@link DEFAULT_REQUEST_TIMEOUT_MS}。 */
  requestTimeoutMs?: number
  /** spawn + 握手 + 工具发现的整体超时（毫秒）；缺省 {@link DEFAULT_STARTUP_TIMEOUT_MS}。 */
  startupTimeoutMs?: number
}

/** 插件/纯函数层的共同选项（生产全缺省；测试注入固定值或伪 spawn）。 */
export interface McpOptions {
  /** server 表；缺省全部来自实例配置 `plugins[].config.servers`。 */
  servers?: Record<string, McpServerSpec>
  /** spawn 注入口（单测用）；缺省走 `child_process.spawn`。 */
  spawn?: SpawnLike
  /**
   * 启动失败策略（Q4）：`'fail'`（缺省）让 setup 抛错转 `BootError`；
   * `'tolerate'` 只记 log、该 server 零工具。实例配置里的同名字段优先。
   */
  onStartupError?: 'fail' | 'tolerate'
}

/* -----------------------------------------------------------
 * JSON-RPC 词汇（stdio 上的换行分帧 JSON；见 rpc.ts / client.ts）
 * ----------------------------------------------------------- */

/** 出站请求（`id` 由会话自增分配）。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** 出站通知（无 `id`，不进等待表，无响应）。 */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** JSON-RPC error 响应的 `error` 字段形态。 */
export interface JsonRpcErrorShape {
  code: number
  message: string
}

/** `tools/list` 返回的远端工具定义（只保留本模块消费的字段）。 */
export interface McpRemoteTool {
  /** 远端工具名（wire 上用它调用，公开名是本地投影）。 */
  name: string
  /** 工具描述；缺失时由 `createMcpTool` 兜底。 */
  description?: string
  /** 参数 schema（MCP 侧为完整 JSON Schema，经 `normalizeInputSchema` 收窄后交给 05）。 */
  inputSchema?: unknown
}

/** `tools/call` 的响应（收窄后只保留 `content` 与 `isError`）。 */
export interface McpCallOutcome {
  /** content 块数组（原样，未投影）。 */
  content: unknown
  /** server 明示的执行失败（原版语义：为 true 时须抛错，让模型看到显式失败）。 */
  isError: boolean
}

/** 仅供类型引用收敛：模块内统一经 `src/index.js` 消费骨架词汇。 */
export type { JsonSchema, Logger }
