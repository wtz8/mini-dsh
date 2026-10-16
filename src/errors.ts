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
