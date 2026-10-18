import type { Config, PluginEntry } from '../contracts.js'

import { DEFAULT_PLUGIN_SOURCES } from './types.js'

/**
 * 默认插件表与"默认 plugins 非空"的兜底（O1）。
 *
 * 背景：01 §2.1 D1 拍板"默认 `plugins` 为 `[]`"，因为当时各 builtin 尚未就位。
 * 但这条默认值一直没被补上，后果是 —— 01 之后、07 之前，任何
 * `loadConfig() + boot()` 都挂载 0 个插件：CLI 起来却没有 llm / session / tools，
 * 直到运行时 `ctx.agent.resolve()` 抛 `'not mounted'` 才暴露，定位困难
 * （PROGRESS 遗留表已把它标为阻塞项）。
 *
 * 补齐动作放在 **07 侧**而非回改 01（Q2 / D3）：语义是"宿主的兜底"而不是
 * "配置的默认值"——只在用户一行都没配时才发生。
 */

/** 默认插件表（`plugins[].source` 顺序即挂载顺序，见 `DEFAULT_PLUGIN_SOURCES`）。 */
export const DEFAULT_PLUGINS: readonly PluginEntry[] = DEFAULT_PLUGIN_SOURCES.map((source) => ({ source }))

/**
 * `config.plugins` 为空时补默认表。
 *
 * **纯函数**：不改入参（`Config` 由 01 产出、尚未冻结，07 不得就地改写调用方
 * 持有的对象），返回浅拷贝后的新 Config。
 *
 * @param config `loadConfig()` 的产出
 * @returns 插件表非空的配置：用户配了则原样返回，没配则补 `DEFAULT_PLUGINS`
 */
export function withDefaultPlugins(config: Config): Config {
  if (config.plugins.length > 0) return config
  // 每次新建数组与元素：boot 会 deepFreeze 整棵 config，共享常量会被冻住
  return { ...config, plugins: DEFAULT_PLUGIN_SOURCES.map((source) => ({ source })) }
}
