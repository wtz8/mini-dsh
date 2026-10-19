import type { Ctx, PluginFactory } from '../../src/index.js'
import { definePlugin } from '../../src/index.js'

import { createMcpClient } from './client.js'
import type { McpClient } from './client.js'
import { assertServerName } from './naming.js'
import { createMcpTool } from './tools.js'
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  MCP_PLUGIN_NAME,
  type McpOptions,
  type McpServerSpec,
} from './types.js'

/**
 * MCP 插件工厂（设计 §4.1：薄接线层）。
 *
 * 本插件是**本地插件**（不进 `builtin:` 表）：用户在配置里显式列出
 * `{ "source": "./dist/plugins/mcp/index.js", "config": { "servers": {...} } }`
 * 启用（架构 §8 示例；项目配置走 07 的 F-02 信任确认）。
 *
 * setup 语义（关键约束 D6：`ToolRegistry` 无注销口子 ⇒ 工具注册后进程内
 * 永久存在 ⇒ 发现必须在 setup 内完成）：
 * 1. **并行启动**全部 server（`Promise.all`，各受 `startupTimeoutMs` 约束）；
 *    启动是 IO 密集（npx 拉包动辄 10s+），串行求和会撞上 07 的 15s boot 超时；
 * 2. 任一失败且策略为 `fail`（缺省，Q4）⇒ **先关掉本次已起的子进程**再抛错
 *    ——boot 的 failBoot 只 dispose 已挂载名单里的插件，抛错者（本插件）不在
 *    名单内，不自清就会泄漏子进程（00 §4.1 注释早已预告的场景）；
 * 3. **串行注册**：注册序 = 配置键序（`Object.entries` 的插入序），与并行
 *    启动的完成先后无关——系统提示里的工具顺序必须确定。
 */

/** 单个 server 的启动结果（`Promise.all` 的元素形态；永不 reject）。 */
type StartOutcome =
  | { ok: true; name: string; spec: McpServerSpec; client: McpClient; tools: import('./types.js').McpRemoteTool[] }
  | { ok: false; name: string; err: Error }

/** 判断"普通对象"（排除 null 与数组；04 Y1 / 08 同一条防线）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * narrow 单个 server 规格（`servers[name]`）。
 *
 * @throws Error 形状非法（命令缺失 / args 非字符串数组 / env 值非字符串 /
 *   超时值非正数等）——由组合根转 `BootError`，死配置早暴露
 */
function narrowSpec(name: string, spec: unknown): McpServerSpec {
  if (!isPlainObject(spec)) {
    throw new Error(`mcp 插件配置：servers.${name} 必须是对象`)
  }
  const { command, args, env, cwd, requestTimeoutMs, startupTimeoutMs } = spec
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error(`mcp 插件配置：servers.${name}.command 必须是非空字符串`)
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    throw new Error(`mcp 插件配置：servers.${name}.args 必须是字符串数组`)
  }
  if (env !== undefined) {
    if (!isPlainObject(env)) {
      throw new Error(`mcp 插件配置：servers.${name}.env 必须是对象`)
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') {
        throw new Error(`mcp 插件配置：servers.${name}.env.${key} 的值必须是字符串`)
      }
    }
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
    throw new Error(`mcp 插件配置：servers.${name}.cwd 必须是非空字符串`)
  }
  for (const [field, value] of [
    ['requestTimeoutMs', requestTimeoutMs],
    ['startupTimeoutMs', startupTimeoutMs],
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new Error(`mcp 插件配置：servers.${name}.${field} 必须是正数`)
    }
  }
  return {
    command,
    ...(args !== undefined ? { args: args as string[] } : {}),
    ...(env !== undefined ? { env: env as Record<string, string> } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs: requestTimeoutMs as number } : {}),
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs: startupTimeoutMs as number } : {}),
  }
}

/** narrow 实例级配置（`plugins[].config`）。非法形状一律抛错（转 BootError）。 */
function narrowConfig(
  config: unknown,
): { servers?: Record<string, McpServerSpec>; onStartupError?: 'fail' | 'tolerate' } | undefined {
  if (config === undefined || config === null) return undefined
  if (!isPlainObject(config)) {
    throw new Error('mcp 插件配置：必须是对象')
  }
  const out: { servers?: Record<string, McpServerSpec>; onStartupError?: 'fail' | 'tolerate' } = {}
  const { servers, onStartupError } = config
  if (servers !== undefined && servers !== null) {
    if (!isPlainObject(servers)) {
      throw new Error('mcp 插件配置：servers 必须是对象（server 名 → 启动规格）')
    }
    const table: Record<string, McpServerSpec> = {}
    for (const [name, spec] of Object.entries(servers)) {
      // server 名是公开工具名的一部分：字符集/长度由命名层统一校验
      assertServerName(name)
      table[name] = narrowSpec(name, spec)
    }
    out.servers = table
  }
  if (onStartupError !== undefined && onStartupError !== 'fail' && onStartupError !== 'tolerate') {
    throw new Error("mcp 插件配置：onStartupError 只接受 'fail' 或 'tolerate'")
  }
  if (onStartupError !== undefined) out.onStartupError = onStartupError
  return out
}

/**
 * 构造 MCP 插件工厂。
 *
 * @param options 预设（生产不传；实例配置 `servers` / `onStartupError` 优先）
 * @returns 插件工厂（`plugins/mcp/index.ts` 的 default 导出即本工厂的一份实例）
 */
export function createMcpPlugin(options: McpOptions = {}): PluginFactory {
  return definePlugin(() => {
    /** setup 成功注册的连接（dispose 时统一关闭；setup 未完成时可能为空）。 */
    let clients: McpClient[] = []
    return {
      name: MCP_PLUGIN_NAME,

      /**
       * 挂载：并行启动 → 失败处置 → 按配置键序注册。
       *
       * @throws Error 配置非法 / 任一 server 启动失败且策略为 `fail`
       *   ——均由组合根转 `BootError`
       */
      async setup(ctx: Ctx, config?: unknown): Promise<void> {
        const narrowed = narrowConfig(config)
        const servers = narrowed?.servers ?? options.servers ?? {}
        const onStartupError = narrowed?.onStartupError ?? options.onStartupError ?? 'fail'
        const entries = Object.entries(servers)
        if (entries.length === 0) return // 空表：挂载成功、零工具（设计 §5 表 1）

        // ① 并行启动：每个 server 独立受 startupTimeoutMs 约束；失败的连接
        //    在此立即自清（子进程可能已拉起，如握手超时），不留孤儿
        const results: StartOutcome[] = await Promise.all(
          entries.map(async ([name, spec]): Promise<StartOutcome> => {
            try {
              const client = createMcpClient({
                server: name,
                spec,
                log: ctx.log,
                ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
              })
              try {
                const tools = await client.start(
                  spec.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
                )
                return { ok: true, name, spec, client, tools }
              } catch (err) {
                await client.dispose()
                throw err
              }
            } catch (err) {
              return {
                ok: false,
                name,
                err: err instanceof Error ? err : new Error(String(err)),
              }
            }
          }),
        )

        // ② 失败处置（Q4）：fail ⇒ 先自清再抛；tolerate ⇒ 记 log、该 server 零工具
        const failures = results.filter((r): r is Extract<StartOutcome, { ok: false }> => !r.ok)
        if (failures.length > 0 && onStartupError === 'fail') {
          await Promise.allSettled(
            results.filter((r) => r.ok).map((r) => (r.ok ? r.client.dispose() : undefined)),
          )
          throw new Error(
            `MCP server 启动失败：${failures.map((f) => `${f.name}：${f.err.message}`).join('；')}`,
          )
        }
        for (const f of failures) {
          ctx.log.error(`MCP server '${f.name}' 启动失败（tolerate），该 server 零工具`, f.err)
        }

        // ③ 串行注册：按配置键序，与并行完成先后无关（系统提示顺序必须确定）
        for (const r of results) {
          if (!r.ok) continue
          clients.push(r.client)
          for (const tool of r.tools) {
            // 同名注册（如两个 server 的公开名撞车）由 05 容器抛错 → BootError
            ctx.tools.register(createMcpTool(r.name, tool, r.client, r.spec.requestTimeoutMs))
          }
        }
      },

      /**
       * 卸载：关闭全部连接（幂等）。**容忍 setup 未完成**（00 X5 派生义务）：
       * `clients` 可能为空或部分填充，逐个关闭即可，不假设 setup 走完。
       */
      async dispose(): Promise<void> {
        const toClose = clients
        clients = []
        await Promise.allSettled(toClose.map((client) => client.dispose()))
      },
    }
  })
}
