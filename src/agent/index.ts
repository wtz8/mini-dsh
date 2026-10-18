/**
 * 06-agent 模块出口（宿主侧）。
 *
 * 07 CLI 与集成测试一律经本文件 import，不深引用 `loop.ts` / `compact.ts` 等内部文件。
 *
 * 本模块**没有下游插件消费者**（唯一消费方是宿主 07），因此不像 02/03/05 那样
 * 往 `src/index.ts` 转发自己的实现——`src/index.ts` 只因本模块需要
 * `createBashTimeoutResolver` 而增补一行转发（设计 §2.3）。
 */

export { BUILTIN_AGENT, MAX_STEPS_PER_TURN, TRANSCRIPT_ITEM_CHARS, TRANSCRIPT_MAX_CHARS } from './types.js'
export type {
  AgentControlHandle,
  AgentDeps,
  AgentPluginConfig,
  AgentPluginOptions,
  CollectedStream,
  CompactOutcome,
  CompactRequest,
  RequestTokensInput,
  ScheduleOptions,
  ToolDefIndex,
  TurnState,
} from './types.js'

export { createAgentControl } from './loop.js'
export { compactSession, findCompactionCut, renderTranscript, SUMMARY_INSTRUCTION } from './compact.js'
export { scheduleToolCalls } from './schedule.js'
export { estimateRequestTokens, estimateTokens, needsCompaction } from './tokens.js'
export { createAgentPlugin, registerAgentBuiltin } from './plugin.js'
