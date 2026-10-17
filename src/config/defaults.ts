import type { Config } from '../contracts.js'

/**
 * 生成一份全新的默认配置。
 *
 * **必须是工厂而非常量**（设计 §2.1 D5）：默认值对象若为模块级常量，`boot()` 内的
 * `deepFreeze` 会把它冻结，进程内第二次 `loadConfig()` / `boot()`（测试与重挂载场景）
 * 就会拿到已冻结的共享对象——既污染全局，也让"合并阶段写入默认值"在 strict 下抛错。
 *
 * 默认值来源：架构 §8 的配置示例与 R4 决议（`logLevel` 默认 `'info'`）；
 * `plugins` 默认空数组（D1 / §8-Q2，builtin 列表待 07 补齐）。
 *
 * @returns 字段齐全、可独立修改的 Config 新对象
 */
export function createDefaultConfig(): Config {
  return {
    model: {
      provider: 'deepseek',
      name: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    contextWindow: 131_072,
    tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120_000 } },
    compaction: { thresholdRatio: 0.8, keepTurns: 4 },
    // 空表：全部工具名走 resolvePermission 的兜底 'ask'（架构 §5.4 Q6）
    permissions: {},
    plugins: [],
    logLevel: 'info',
  }
}
