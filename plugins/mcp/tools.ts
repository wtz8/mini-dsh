import type { ToolDefinition, ToolEnv } from '../../src/index.js'

import type { McpClient } from './client.js'
import { publicToolName } from './naming.js'
import { normalizeInputSchema } from './schema.js'
import { projectContent } from './result.js'
import { DEFAULT_REQUEST_TIMEOUT_MS, type McpRemoteTool } from './types.js'

/**
 * 远端工具 → 05 的 `ToolDefinition`（设计 §4.4）。
 *
 * 注册进 05 的工具表即自动享有 guarded pipeline（schema 校验、权限门、
 * 截断、入 log）——本模块**不需要也不允许**自带任何管道（05 §8 附则）。
 *
 * 职责只有三件事：
 * 1. 名字：公开名 `mcp__<server>__<raw>`（权限按它匹配 `mcp__*` 通配键）；
 * 2. schema：MCP 的 `inputSchema` 收窄为 05 的子集；
 * 3. execute：把参数交给 client 的 `tools/call`（wire 用 raw 名），
 *    超时/取消在 `callTool` 内 race（Q8），`isError` 必须抛错让模型看到显式失败。
 */

/**
 * 组装一个 MCP 工具的本地定义。
 *
 * @param server 本地配置的 server 名（公开名命名空间）
 * @param def `tools/list` 返回的远端工具定义
 * @param client 该 server 的连接（execute 闭包持有）
 * @param requestTimeoutMs 单次调用超时（毫秒），缺省 {@link DEFAULT_REQUEST_TIMEOUT_MS}
 * @returns `ToolDefinition`（`concurrency: 'parallel'`，Q7：JSON-RPC 的 id 关联
 *   天然支持在途并发，由 06 按 `config.tools.maxParallel` 统一限流）
 */
export function createMcpTool(
  server: string,
  def: McpRemoteTool,
  client: McpClient,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): ToolDefinition {
  // 描述缺失时兜底：模型至少知道"这是哪个 server 提供的什么工具"
  const description =
    def.description?.trim() !== '' && def.description !== undefined
      ? def.description
      : `（MCP server ${server} 提供的工具 ${def.name}）`
  const schema = normalizeInputSchema(def.inputSchema)

  return {
    name: publicToolName(server, def.name),
    description,
    schema,
    concurrency: 'parallel',
    async execute(
      args: Record<string, unknown>,
      env: ToolEnv,
    ): Promise<string> {
      // 05 的管道已保证 args 通过 schema 校验；这里原样交给 server。
      // 取消经 env.signal 传入：rpc 会先发 notifications/cancelled 再失败，
      // 管道据 signal.aborted 判定为 cancelled（而非 execution_error）。
      const outcome = await client.callTool(def.name, args, {
        timeoutMs: requestTimeoutMs,
        signal: env.signal,
      })
      const text = projectContent(outcome.content, def.name)
      // isError 是 server 明示的执行失败：抛错让 05 转为 execution_error。
      // 不抛的话模型会把错误文本当事实续写——比失败本身糟糕得多。
      if (outcome.isError) {
        throw new Error(`MCP 工具 ${def.name} 报告执行失败：${text}`)
      }
      return text
    },
  }
}
