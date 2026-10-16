import type { Config, Ctx, EventBus, Logger } from '../contracts.js'
import { EventBusImpl } from './event-bus.js'
import { createLogger } from './logger.js'
import { AgentRegistryImpl, LlmRegistryImpl, PromptRegistryImpl, SessionStoreContainerImpl, ToolRegistryImpl } from './containers.js'

/**
 * Ctx 组装（设计 §3）：创建全部容器，一次性组装并 `Object.freeze`。
 *
 * `Ctx` 本身不携带任何私有字段——挂载序、AbortController 等内部状态由
 * `boot.ts` 以模块级 WeakMap 持有，禁止"往 ctx 上偷偷挂内部状态"的写法。
 *
 * @param parts 组装输入：冻结后的 config、事件总线、日志器、进程级取消信号
 * @returns readonly 冻结的 Ctx
 */
export function assembleCtx(parts: { config: Config; events: EventBus; log: Logger; signal: AbortSignal }): Ctx {
  const ctx: Ctx = {
    config: parts.config,
    events: parts.events,
    llm: new LlmRegistryImpl(),
    tools: new ToolRegistryImpl(),
    prompt: new PromptRegistryImpl(),
    sessions: new SessionStoreContainerImpl(),
    agent: new AgentRegistryImpl(),
    log: parts.log,
    signal: parts.signal,
  }
  // 服务面引用恒定（架构 §5.2）：冻结后插件只能调用方法，不能替换引用
  return Object.freeze(ctx)
}

/**
 * 内核装配的便捷入口：按 config 的 logLevel 创建 Logger（缺省 'info'，R4 决议）
 * 与 EventBus，再组装 Ctx。boot() 的步骤 3–4 就在这里发生。
 *
 * @param config 已由 boot 完成 deepFreeze 的 config（冻结归属恒定为 boot，设计 §2.3）
 * @param signal 进程级取消信号（来自 boot 创建的 AbortController）
 */
export function createKernel(config: Config, signal: AbortSignal): Ctx {
  const log = createLogger(config.logLevel ?? 'info')
  const events = new EventBusImpl(log)
  return assembleCtx({ config, events, log, signal })
}
