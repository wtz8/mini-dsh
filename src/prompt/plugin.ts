import type { Ctx, PluginFactory, Unsubscribe } from '../contracts.js'
// registerBuiltin 是内核为内置模块开的唯一注册出口。与 02/03 同式：直接从 boot.js 取
// 而非绕回 `src/index.ts`——后者会转发本模块的 `PROMPT_ORDER`，形成
// index → prompt → index 的循环引用；boot.js 不反向依赖任何功能模块，取它无环。
import { registerBuiltin } from '../plugin/boot.js'
import { definePlugin } from '../plugin/define-plugin.js'
import { createCoreSections } from './core.js'
import { safeCwd } from './sections/environment.js'
import type { EnvFacts, PromptPluginConfig, PromptPluginOptions } from './types.js'

/**
 * `builtin:prompt` 插件：把内置核心段注册进 `ctx.prompt`（架构 §5.2 装配语义）。
 *
 * **eat own dogfood**：系统提示的内容本身也是插件提供的——内核不知道"MiniDSH 是谁"，
 * 06 只用 `ctx.prompt.render()`，未挂载时拿到的是空串（D1：prompt 容器是最终实现，
 * 不是委托式容器，故**不抛** `'not mounted'`，与 `ctx.sessions` 不同）。
 *
 * 本插件是**薄接线层**：段文案在 `createCoreSections()` 里（纯函数），插件只负责
 * 把 `process.*` / `ctx.config` / `ctx.tools` 接成 getter 并注册。
 */

/** 插件名（`config.plugins[].source` 写作 `builtin:prompt`）。 */
export const BUILTIN_PROMPT = 'builtin:prompt'

/**
 * narrow 实例级配置 `plugins[].config.disabled`。
 *
 * @returns 禁用 id 列表；`undefined` 表示该配置未提供
 * @throws Error 配置不是对象（**数组也算非法**：`typeof [] === 'object'`，不放行
 *   会把整个配置静默忽略，用户无从察觉——与本模块"死配置早暴露"的立场相悖），
 *   或 `disabled` 不是字符串数组（转 BootError，fail-fast）
 */
function narrowDisabled(config: unknown): string[] | undefined {
  if (config === undefined || config === null) return undefined
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('builtin:prompt config: must be an object')
  }
  const disabled = (config as PromptPluginConfig).disabled
  if (disabled === undefined) return undefined
  if (!Array.isArray(disabled) || disabled.some((id) => typeof id !== 'string')) {
    throw new Error('builtin:prompt config: `disabled` must be an array of strings')
  }
  return disabled
}

/**
 * 生产用环境事实提供者（插件接线）：把 `process.*` 与 `ctx.config` 合成 `EnvFacts`。
 *
 * 刻意做成**函数而非 setup 时的常量**：段在 render 时才调用它，于是工作目录与
 * 时刻永远是当前值（设计 D5）。
 */
function createEnvProvider(ctx: Ctx): () => EnvFacts {
  return () => ({
    cwd: safeCwd(),
    platform: process.platform,
    arch: process.arch,
    now: new Date(),
    model: `${ctx.config.model.provider}/${ctx.config.model.name}`,
    contextWindow: ctx.config.contextWindow,
  })
}

/**
 * 构造 `builtin:prompt` 插件工厂。
 *
 * @param options 注入点（生产不传；测试注入固定 env / hasTools / disabled）
 * @returns 插件工厂；同进程可构造多份（各带自己的注入项）
 */
export function createPromptPlugin(options: PromptPluginOptions = {}): PluginFactory {
  const injected = options
  return definePlugin(() => ({
    name: BUILTIN_PROMPT,

    /**
     * 挂载：组装核心段并注册进 `ctx.prompt`。
     *
     * `hasTools` 传的是**闭包查询**而非当前快照：本插件通常先于 `builtin:tools`
     * 挂载（按 §8 示例的 plugins 顺序），此刻 `ctx.tools` 还是空表——只有惰性查询
     * 才能保证首个 step 的 render 看到真实工具（设计 §4.3）。
     *
     * @throws Error 实例配置非法或 `disabled` 含未知 id，或同 id 重复注册
     *   （如挂了两次 `builtin:prompt`）——均由组合根转为 `BootError`
     */
    setup(ctx: Ctx, config?: unknown): void {
      const disabled = [...(injected.disabled ?? []), ...(narrowDisabled(config) ?? [])]
      const sections = createCoreSections({
        env: injected.env ?? createEnvProvider(ctx),
        hasTools: injected.hasTools ?? ((): boolean => ctx.tools.list().length > 0),
        disabled,
      })
      for (const section of sections) ctx.prompt.section(section)
    },
    // 不实现 dispose：本插件不持有任何资源（段是闭包，随注册表生命周期；
    // 契约的 `Plugin.dispose` 是可选的）。X5"容忍 setup 未完成"对本插件自动成立。
  }))
}

/**
 * 把 `builtin:prompt` 注册进内核 builtin 表（07 启动时对各 builtin 模块各调一次）。
 *
 * @returns 退订句柄：从表中移除本插件工厂（测试换注自己的变体时用）
 * @throws Error 同名重复注册
 */
export function registerPromptBuiltin(): Unsubscribe {
  return registerBuiltin('prompt', createPromptPlugin())
}
