import type { PluginFactory } from '../contracts.js'

/**
 * `definePlugin`：插件工厂的身份透传函数（类型收窄糖）。
 *
 * 插件作者用它包裹工厂函数以获得完整的 `PluginFactory` 类型检查；
 * 运行时行为是恒等返回（不做任何包装/代理）。本地插件以
 * `export default definePlugin(() => ({ ... }))` 形式交付，组合根取模块的
 * `default` 导出作为工厂。
 *
 * @param factory 插件工厂（同步或异步返回 Plugin）
 * @returns 原样返回传入的工厂函数
 */
export function definePlugin(factory: PluginFactory): PluginFactory {
  return factory
}
