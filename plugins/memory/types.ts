/**
 * 08-plugin-memory 的模块内类型与共享常量（设计 §3）。
 */

/**
 * 默认记忆文件（架构 §7 目录布局）。
 *
 * 经 05 的 `resolvePath` 解析：`~` 展开为 home 目录。注意它**不随** 07 的
 * `--config-dir` 联动（`Config` 不携带 globalDir，设计 §8-Q2）——
 * 换位置请用实例配置 `plugins[].config.file`。
 */
export const DEFAULT_MEMORY_FILE = '~/.minidsh/memory/MEMORY.md'

/**
 * 插件与纯函数层的共同选项（生产全缺省；测试注入 tmp 路径）。
 */
export interface MemoryOptions {
  /**
   * 记忆文件路径（相对路径按 cwd 解析、`~` 展开——与六个内置工具同一基准）。
   * 实例配置 `plugins[].config.file` 同义且优先于构造选项（设计 §4.1）。
   */
  file?: string
}
