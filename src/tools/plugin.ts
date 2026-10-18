import type { Config, Ctx, PluginFactory, ToolDefinition, Unsubscribe } from '../contracts.js'
// registerBuiltin 是内核为内置模块开的唯一注册出口。与 02/03/04 同式：直接从 boot.js 取
// 而非绕回 `src/index.ts`——后者会转发本模块的 `createToolRunner`，形成
// index → tools/plugin → index 的循环引用；boot.js 不反向依赖任何功能模块，取它无环。
import { registerBuiltin } from '../plugin/boot.js'
import { definePlugin } from '../plugin/define-plugin.js'
import { createBashTool } from './builtin/bash.js'
import { createEditTool } from './builtin/edit.js'
import { createGlobTool } from './builtin/glob.js'
import { createGrepTool } from './builtin/grep.js'
import { createReadTool } from './builtin/read.js'
import { createWriteTool } from './builtin/write.js'
import { createToolsSection } from './section.js'
import type { ToolsPluginOptions } from './types.js'

/**
 * `builtin:tools` 插件：注册六个内置工具与 `tools` prompt 段。
 *
 * **eat own dogfood**：工具能力本身也是插件——内核不知道 `read`/`bash` 的存在，
 * 06 只经 `ctx.tools` 与 `createToolRunner` 交互。08 的 memory 工具、09 的 MCP 工具
 * 走同一个注册口，自动获得同一条 guarded pipeline。
 *
 * 本插件是**薄注册层**：工具实现是 `builtin/*.ts` 里的纯构造函数（设计 D3），
 * 插件只负责"注册哪些"与实例配置 narrow。
 */

/** 插件名（`config.plugins[].source` 写作 `builtin:tools`）。 */
export const BUILTIN_TOOLS = 'builtin:tools'

/** 内置工具名（注册顺序即模型看到的顺序，稳定顺序有利于 provider 前缀缓存）。 */
export const BUILTIN_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'bash'] as const

/**
 * 构造六个内置工具定义。
 *
 * @param config 最终配置（`bash` 的 shell 模式来自 `config.tools.bash`）
 * @returns 工具定义数组（顺序见 `BUILTIN_TOOL_NAMES`）
 * @throws Error `bash.shell === 'auto'` 且系统上找不到任何可用 shell
 */
export function createBuiltinTools(config: Config): ToolDefinition[] {
  return [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool({ shell: config.tools.bash.shell }),
  ]
}

/**
 * 构造 `bash` 的超时解析器（交给 `createToolRunner` 的 `timeoutFor`）。
 *
 * 语义（设计 §4.5 / Q8）：`config.tools.bash.timeoutMs` 是**上限**，模型给的
 * `timeoutMs` 只能调小不能调大——否则"给自己续命"就让配置形同虚设。
 * 其余工具无超时（架构 §5.4：只有声明了超时的工具才受限）。
 *
 * @param config 最终配置
 * @returns `timeoutFor` 函数
 */
export function createBashTimeoutResolver(
  config: Config,
): (name: string, args: Record<string, unknown>) => number | undefined {
  const cap = config.tools.bash.timeoutMs
  return (name, args) => {
    if (name !== 'bash') return undefined
    const requested = args['timeoutMs']
    if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
      return Math.min(requested, cap)
    }
    return cap
  }
}

/**
 * narrow 实例级配置 `plugins[].config.disabled`。
 *
 * @returns 禁用工具名列表；`undefined` 表示该配置未提供
 * @throws Error 配置不是对象（**数组也算非法**：`typeof [] === 'object'`，放行会让
 *   整个配置被静默忽略——与 04 Y1 同一条防线），或 `disabled` 不是字符串数组
 */
function narrowDisabled(config: unknown): string[] | undefined {
  if (config === undefined || config === null) return undefined
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('builtin:tools config: must be an object')
  }
  const disabled = (config as { disabled?: unknown }).disabled
  if (disabled === undefined) return undefined
  if (!Array.isArray(disabled) || disabled.some((name) => typeof name !== 'string')) {
    throw new Error('builtin:tools config: `disabled` must be an array of strings')
  }
  return disabled
}

/**
 * 构造 `builtin:tools` 插件工厂。
 *
 * @param options 覆盖工具集 / 预设禁用（生产不传；测试注入裁剪集）
 * @returns 插件工厂
 */
export function createToolsPlugin(options: ToolsPluginOptions = {}): PluginFactory {
  const injected = options
  return definePlugin(() => ({
    name: BUILTIN_TOOLS,

    /**
     * 挂载：注册工具与 `tools` 段。
     *
     * @throws Error 实例配置非法、`disabled` 含未知工具名、同工具名重复注册
     *   （如内置与 09 的 MCP 工具撞名）——均由组合根转 `BootError`
     */
    setup(ctx: Ctx, config?: unknown): void {
      const disabled = [...(injected.disabled ?? []), ...(narrowDisabled(config) ?? [])]
      const defs = injected.tools ? [...injected.tools] : createBuiltinTools(ctx.config)
      const available = new Set(defs.map((def) => def.name))
      const unknown = disabled.filter((name) => !available.has(name))
      if (unknown.length > 0) {
        throw new Error(`builtin:tools config: unknown tool(s) in \`disabled\`: ${unknown.join(', ')}`)
      }
      for (const def of defs) {
        if (!disabled.includes(def.name)) ctx.tools.register(def)
      }
      // 段总是注册（无工具时 render 为 ''，被 04 的空段过滤丢弃）；注册表是活引用，
      // 09 之后注册的 MCP 工具会自动出现在下一次 render 里（设计 D4）
      ctx.prompt.section(createToolsSection(ctx.tools))
    },
    // 不实现 dispose：不持有任何资源（工具是闭包，shell 探测结果是启动期常量）
  }))
}

/**
 * 把 `builtin:tools` 注册进内核 builtin 表（07 启动时对各 builtin 模块各调一次）。
 *
 * @returns 退订句柄：从表中移除本插件工厂（测试换注自己的变体时用）
 * @throws Error 同名重复注册
 */
export function registerToolsBuiltin(): Unsubscribe {
  return registerBuiltin('tools', createToolsPlugin())
}
