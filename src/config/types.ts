import type { Config, PermissionAction, PluginEntry } from '../contracts.js'

/**
 * 配置覆盖层：三层来源（全局 / 项目 / flags）的输入形态，全部字段可选。
 *
 * 之所以手工列出各层形状而没有写 `DeepPartial<Config>`：泛型 `DeepPartial` 会把
 * `PluginEntry[]` 递归成"逐元素部分覆盖"，而 §3 的合并规则要求数组**整值替换**
 * （不拼接、不逐元素合并）。
 *
 * 注意合并语义是**逐层深合并**：`permissions` 作为纯对象会**逐键合并**（上层同名键
 * 覆盖、异名键保留），不是整值替换；只有数组（`plugins`）是整值替换。
 *
 * 用 `type` 而非 `interface`：只有类型别名（对象类型字面量）才有隐式索引签名，
 * 才能作为 `deepMerge` 的 `Record<string, unknown>` 实参；interface 没有。
 */
export type ConfigOverride = {
  model?: Partial<Config['model']>
  contextWindow?: number
  tools?: { maxParallel?: number; bash?: Partial<Config['tools']['bash']> }
  compaction?: Partial<Config['compaction']>
  permissions?: Record<string, PermissionAction>
  plugins?: PluginEntry[]
  logLevel?: Config['logLevel']
}

/**
 * `loadConfig()` 入参。
 *
 * 两个目录参数都是**目录**（其下分别是 `config.json` / `minidsh.json`），
 * 而非文件路径——便于测试注入临时目录，也便于 07 传入自定义的 `--config-dir`。
 */
export interface LoadConfigOptions {
  /** 全局配置目录；默认 `path.join(os.homedir(), '.minidsh')`（架构 §7） */
  globalDir?: string
  /** 项目配置目录；默认 `process.cwd()`（不向上递归查找，见设计 D2 / §8-Q3） */
  projectDir?: string
  /** 最高优先级覆盖层（07 CLI 的 flags）；`undefined` 字段不参与合并 */
  flags?: ConfigOverride
}
