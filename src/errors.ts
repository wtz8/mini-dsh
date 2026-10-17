/**
 * 运行时错误类。
 *
 * `contracts.ts` 是纯类型模块，错误类作为运行时值单独落在本文件
 * （骨架设计未指定错误类的文件归属，此为澄清而非偏离，见设计文档 §2.1）。
 */

/**
 * pre-execute 否决专用异常（架构 §5.3）：
 * CLI 权限监听器在 `tools/pre-execute` 瀑布事件中抛出，
 * 05 的 pipeline 捕获后转为 `permission_denied` 的 `ToolResult`——
 * 错误是工具结果的一种，不是异常路径（架构 §5.4）。
 */
export class ToolRejected extends Error {
  /**
   * @param message 否决原因（会作为 `ToolResult.error.message` 回给模型，应写成模型可读的说明）
   */
  constructor(message: string) {
    super(message)
    this.name = 'ToolRejected'
  }
}

/**
 * 配置错误（01 的 `loadConfig()` 出口）：JSON 非法或字段校验失败。
 *
 * 与 `BootError` 的分工：本错误发生在 **`boot()` 之前**（宿主加载配置阶段），
 * 因此不存在"已挂载插件需要清理"的语义；07 CLI 捕获后打印 `path` / `file`
 * 诊断并以退出码 1 退出，此时进程尚未创建任何资源。
 *
 * 落点与 `ToolRejected` / `BootError` 同处（设计 §2.1 D4 / §8-Q4）：错误类集中一处，
 * 并经 `src/index.ts` 转发。
 */
export class ConfigError extends Error {
  /** 出错的配置字段路径（如 `config.tools.bash.timeoutMs`）；文件级错误时缺省 */
  readonly path?: string
  /** 出错的配置文件绝对路径；字段校验错误时缺省 */
  readonly file?: string

  /**
   * @param message 人类可读的失败原因（英文，与内核其余错误保持一致）
   * @param options.path 字段路径（校验失败时给出，便于 07 直接打印定位）
   * @param options.file 配置文件路径（读取/解析失败时给出）
   */
  constructor(message: string, options?: { path?: string; file?: string }) {
    super(message)
    this.name = 'ConfigError'
    this.path = options?.path
    this.file = options?.file
  }
}

/**
 * 启动失败异常：boot 的 fail-fast 出口（设计 §4.1）。
 * 携带 `mounted`（已成功挂载的插件名，按挂载顺序）——
 * 07 CLI 负责打印名单与退出码 1；抛出前已按 §4.2 逆序 dispose 已挂载插件（R3 决议）。
 */
export class BootError extends Error {
  /** 已成功挂载的插件名（挂载顺序；失败的那个插件不在内）；只读数组，外部不得改写 */
  readonly mounted: readonly string[]

  /**
   * @param message 失败原因（含被指认的插件来源与底层错误信息）
   * @param mounted 已成功挂载的插件名列表（boot 失败清理后上抛；内部已复制，外部后续改动不影响本错误）
   */
  constructor(message: string, mounted: readonly string[]) {
    super(message)
    this.name = 'BootError'
    this.mounted = mounted
  }
}
