/**
 * 08-plugin-memory 的模块出口（设计 §2）。
 *
 * `default` 导出是组合根唯一的硬性契约：boot 经 `import()` 取模块的
 * `default` 作为插件工厂（00 §4.1 `resolveFactory`）。具名导出服务测试
 * 与复用——纯函数层（段/工具/读写原语）可脱离组合根单测（设计 D2）。
 */

import { createMemoryPlugin } from './plugin.js'

export { DEFAULT_MEMORY_FILE, type MemoryOptions } from './types.js'
export { appendMemory, readMemoryFile, truncateMemory, type TruncatedMemory } from './file.js'
export { createMemorySection, MEMORY_SECTION_ID, MEMORY_SECTION_MAX_BYTES } from './section.js'
export { createMemoryTool, MEMORY_TOOL_NAME } from './tool.js'
export { createMemoryPlugin, MEMORY_PLUGIN_NAME } from './plugin.js'

/** 插件工厂（组合根取此 default 导出；无实例配置时使用默认记忆文件）。 */
export default createMemoryPlugin()
