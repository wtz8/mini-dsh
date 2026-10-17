/**
 * 02-llm 的模块内类型（`src/llm/` 内部共享，宿主与插件经 `index.ts` 取用）。
 */

/**
 * fetch 的最小形态：默认实现是 Node 22 内置的 `globalThis.fetch`（架构 §2：零运行时依赖）。
 * 测试注入伪实现即可在不打网络的前提下验证整条流式链路。
 */
export type FetchLike = typeof globalThis.fetch

/**
 * adapter 构造选项。
 *
 * `LlmAdapterFactory` 的契约签名只收 `model`（架构 §5.4），无法携带注入点，
 * 因此注入落在**更外层的插件构造**（`createLlmPlugin({fetchImpl})`）；本选项保留
 * 同名参数只为让 `createOpenAiAdapter` 能脱离组合根直接单测（设计 §2.4 D2）。
 */
export interface OpenAiAdapterOptions {
  /** 注入的 fetch 实现；缺省用 `globalThis.fetch` */
  fetchImpl?: FetchLike
}

/** `builtin:llm` 插件的实例级选项（生产不传，测试注入伪 fetch）。 */
export interface LlmPluginOptions {
  /** 注入的 fetch 实现；缺省用 `globalThis.fetch` */
  fetchImpl?: FetchLike
}

/**
 * `builtin:llm` 注册的 provider 名（§8-Q1：只注册 `deepseek`，即默认 provider）。
 * resolve 的 name 即 `config.model.provider`（架构 §5.2 解析约定）。
 */
export const PROVIDER_DEEPSEEK = 'deepseek'
