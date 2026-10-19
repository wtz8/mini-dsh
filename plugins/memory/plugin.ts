import type { Ctx, PluginFactory } from '../../src/index.js'
import { definePlugin } from '../../src/index.js'
import { createMemorySection } from './section.js'
import { createMemoryTool } from './tool.js'
import { DEFAULT_MEMORY_FILE, type MemoryOptions } from './types.js'

/**
 * memory 插件工厂（薄接线层，设计 D2：段与工具是纯函数，插件只 narrow 配置 + 注册）。
 *
 * 本插件是**本地插件**（不进 `builtin:` 表）：用户在配置里显式列出
 * `{ "source": "./dist/plugins/memory/index.js" }` 启用；项目配置中的本地插件
 * 会走 07 的 F-02 首次信任确认。注册即享有 05 的完整管道（schema 校验、权限门、
 * 截断、入 log）——`memory` 工具未命中精确键时按权限匹配规则兜底 `ask`。
 */

/** 插件名（`plugin/mounted` 事件与 07 信任确认中显示的名字）。 */
export const MEMORY_PLUGIN_NAME = 'memory'

/**
 * narrow 实例级配置 `plugins[].config.file`。
 *
 * @returns 记忆文件路径；`undefined` 表示该配置未提供
 * @throws Error 配置不是对象（**数组也算非法**：`typeof [] === 'object'`，放行会让
 *   整个配置被静默忽略——04 Y1 / 05 同一条防线），或 `file` 不是非空字符串
 */
function narrowFile(config: unknown): string | undefined {
  if (config === undefined || config === null) return undefined
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('memory plugin config: must be an object')
  }
  const file = (config as { file?: unknown }).file
  if (file === undefined) return undefined
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('memory plugin config: `file` must be a non-empty string')
  }
  return file
}

/**
 * 构造 memory 插件工厂。
 *
 * setup 内注册 `memory/main` 段（order 900）与 `memory` 工具；同 id 段 /
 * 同名工具重复注册（如插件被挂两次）由容器抛错，组合根转 `BootError`（M0 语义）。
 *
 * 无 `dispose`：不持有任何资源（段与工具是闭包，随注册表生命周期），与 04/05 同式。
 *
 * @param options 记忆文件路径预设（生产不传；实例配置 `file` 优先于它）
 * @returns 插件工厂（`plugins/memory/index.ts` 的 default 导出即本工厂的一份实例）
 */
export function createMemoryPlugin(options: MemoryOptions = {}): PluginFactory {
  return definePlugin(() => ({
    name: MEMORY_PLUGIN_NAME,

    /**
     * 挂载：注册段与工具。
     *
     * @throws Error 实例配置非法（窄化失败）、同 id 段/同名工具重复注册
     *   ——均由组合根转 `BootError`
     */
    setup(ctx: Ctx, config?: unknown): void {
      const file = narrowFile(config) ?? options.file ?? DEFAULT_MEMORY_FILE
      ctx.prompt.section(createMemorySection({ file }))
      ctx.tools.register(createMemoryTool({ file }))
    },
  }))
}
