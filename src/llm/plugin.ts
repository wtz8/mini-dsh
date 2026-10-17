import type { Ctx, PluginFactory, Unsubscribe } from '../contracts.js'
// registerBuiltin 是内核为内置模块开的唯一注册出口（与 `src/index.ts` 同源导出）。
// 这里直接从 boot.js 取而非绕回 `src/index.ts`：后者会转发本模块，形成
// index → llm → index 的循环引用；boot.js 不反向依赖任何模块，取它无环。
import { registerBuiltin } from '../plugin/boot.js'
import { definePlugin } from '../plugin/define-plugin.js'
import { createOpenAiAdapter } from './adapter.js'
import { PROVIDER_DEEPSEEK } from './types.js'
import type { LlmPluginOptions } from './types.js'

/**
 * `builtin:llm` 插件：把 LLM adapter 工厂注册进 `ctx.llm`（架构 §5.2：
 * registry 型服务面由对应 builtin 插件 `register` 填充）。
 *
 * **eat own dogfood**：LLM 能力本身也是一个插件——内核不知道 provider 的存在，
 * 06 经 `ctx.llm.resolve(config.model.provider)` 取工厂，表里没这个名字就 fail-fast。
 *
 * 只在 `ctx.llm` 注册 **一个** provider（`deepseek`，§8-Q1）：注册别名等于隐式承诺
 * 维护该 provider 的线格式差异，新 provider 应由其提供方自行 `register`。
 */

/**
 * 构造 `builtin:llm` 插件工厂。
 *
 * @param options.fetchImpl 注入的 fetch 实现（生产不传，用 `globalThis.fetch`）。
 *   注入点是插件构造层而非 adapter 层，因为契约的 `LlmAdapterFactory` 只收 `model`
 *   （设计 §2.4 D2）。
 * @returns 插件工厂；同进程可构造多份（各带自己的 fetchImpl，测试用）
 */
export function createLlmPlugin(options: LlmPluginOptions = {}): PluginFactory {
  const fetchImpl = options.fetchImpl
  return definePlugin(() => ({
    name: 'builtin:llm',
    /**
     * 挂载：注册 adapter 工厂。
     *
     * **不在 setup 内自检 `config.model.provider`**（D7）：若有插件在本插件之后
     * 注册其它 provider，自检会把它误判成"未注册"而启动失败。自检归使用点
     * （06 首次回合 resolve 失败即 fail-fast）或 07 的 REPL 就绪检查。
     *
     * @throws Error 同名重复注册（内核转 BootError）
     */
    setup(ctx: Ctx): void {
      ctx.llm.register(PROVIDER_DEEPSEEK, (model) => createOpenAiAdapter(model, { fetchImpl }))
    },
    // 不实现 dispose：本插件不持有任何资源（连接在一次 stream 内开关，见 adapter 的 finally）
  }))
}

/**
 * 把 `builtin:llm` 注册进内核 builtin 表（07 启动时对各个 builtin 模块各调一次）。
 *
 * @returns 退订句柄：从表中移除本插件工厂（测试换注自己的变体时用）
 * @throws Error 同名重复注册
 */
export function registerLlmBuiltin(): Unsubscribe {
  return registerBuiltin('llm', createLlmPlugin())
}
