/**
 * 04-prompt 模块内类型（设计 §2.1）。
 *
 * 分两类：`EnvFacts` 是段的渲染素材（事实快照），`*Options` 是注入点。
 * 两个函数型注入项刻意是 **getter 而非快照**——段在 `render()` 时才调用它们，
 * 于是"挂载顺序"与"段内容"解耦（设计 §4.3）。
 */

/** 环境事实快照：environment 段的渲染素材（生产取自 process/config，测试注入固定值）。 */
export interface EnvFacts {
  /** 当前工作目录；不可用时为 `'unknown'`（见 environment.ts 的 `safeCwd`） */
  cwd: string
  /** 操作系统：`process.platform`（`'win32'` / `'linux'` / `'darwin'` …） */
  platform: string
  /** CPU 架构：`process.arch`（`'x64'` / `'arm64'` …） */
  arch: string
  /** 取"当前时刻"；environment 段每次 render 重新取值（设计 D5） */
  now: Date
  /** 模型标识，形如 `'deepseek/deepseek-chat'`；缺省时该行不渲染 */
  model?: string
  /** 上下文窗口 token 数（来自 `config.contextWindow`）；缺省时该行不渲染 */
  contextWindow?: number
}

/**
 * 核心段的构造选项（全部为注入点，生产由插件接线）。
 *
 * 缺省行为见 `createCoreSections`：env 读 `process.*` 与 `new Date()`，
 * hasTools 恒为 `false`（无工具时 tool-use 段不出场）。
 */
export interface CoreSectionsOptions {
  /** 环境事实提供者；**每次 render 调用一次** */
  env?: () => EnvFacts
  /** 是否已注册任何工具；**每次 render 调用一次**——返回 `false` 时 tool-use 段渲染为空串 */
  hasTools?: () => boolean
  /** 禁用的内置段 id；不在已知集合内 → 抛错（死配置早暴露，与 01 X7 同式） */
  disabled?: readonly string[]
}

/** 插件构造选项：与 `CoreSectionsOptions` 同形（生产不传，测试注入固定值）。 */
export type PromptPluginOptions = CoreSectionsOptions

/**
 * 插件实例级配置的形状（`plugins[].config`），由插件自行 narrow。
 *
 * 只认 `disabled`：这是"替换官方段"的唯一路径——契约没有 `unregister`
 * （架构 §10 已砍热卸载），想改文案只能禁用后自行注册同 order 的段。
 */
export interface PromptPluginConfig {
  disabled?: string[]
}
