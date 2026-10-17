/**
 * prompt section 的 order 区间约定（设计 §2.2 / D6）。
 *
 * 之所以作为**值**导出而不是各模块写字面量：order 是**跨插件共享的排序资源**
 * ——05（工具 schema）、08（MEMORY）、07（恢复说明）都要挑一个值，各自写数字
 * 必然漂移且互相看不见冲突（与 02 X1 导出 `PROVIDER_DEEPSEEK` 同理由）。
 *
 * 这只是**约定**不是约束：插件可填任意 number。`render()` 按 order 升序、
 * 同 order 按 id 字典序拼装（M0 既定语义）。
 */
export const PROMPT_ORDER = {
  /** 需要压在最前的段（如 07 的"本会话由 /resume 恢复"说明） */
  first: 0,
  /** 04：身份与定位 */
  identity: 100,
  /** 04：运行环境（动态段） */
  environment: 200,
  /** 04：工具调用协议（条件段） */
  toolUse: 300,
  /** 05：工具 schema 列表——04 预留的约定位，05 的 DoD 需遵守 */
  tools: 350,
  /** 04：工作准则 */
  guidelines: 800,
  /** 08：MEMORY.md 内容 */
  memory: 900,
  /** 其余自定义段的建议起点 */
  plugin: 1000,
} as const
