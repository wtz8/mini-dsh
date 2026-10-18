import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Config, Ctx, Plugin, PluginFactory, Unsubscribe } from '../contracts.js'
import { BootError } from '../errors.js'
import { createKernel } from './ctx.js'

/**
 * builtin 插件表（架构 §5.1 挂载规则 2）：`builtin:<name>` -> 工厂。
 * M0 时为**空表**——`builtin:llm` / `builtin:session` 等随 02–06 各模块
 * 交付时注册进表中（eat own dogfood：模块实现本身也是插件）。
 *
 * 表本身是模块级私有状态，对外唯一注册入口是 `registerBuiltin()`（经
 * `src/index.ts` 导出）——内置模块不得深引用本文件（设计 §1）。
 */
const builtinPlugins = new Map<string, PluginFactory>()

/**
 * 注册 builtin 插件工厂（02–09 各内置模块把自己的实现注册进表的唯一入口）。
 *
 * 表在进程内是全局的，而 builtin 插件按名解析，因此同名重复注册一律抛错
 * （fail-fast，避免后注册者静默覆盖前者）。
 *
 * @param name builtin 名（`config.plugins[].source` 写作 `builtin:<name>`）
 * @param factory 插件工厂
 * @returns 退订句柄：从表中移除该工厂；重复调用安全（测试与进程内重挂载场景用）。
 *   **只移除本次注册的那一份**（review Y8）：若同名被重新注册过，旧句柄不会误删
 *   新工厂（原实现按名称无条件 delete）
 * @throws Error 同名重复注册
 */
export function registerBuiltin(name: string, factory: PluginFactory): Unsubscribe {
  if (builtinPlugins.has(name)) throw new Error(`builtin plugin '${name}' already registered`)
  builtinPlugins.set(name, factory)
  return () => {
    if (builtinPlugins.get(name) === factory) builtinPlugins.delete(name)
  }
}

/**
 * 挂载序的持有方式（设计 §3）：`Ctx` 不携带私有字段，内核以模块级 WeakMap 记录。
 * 数组元素为"已开始挂载"的插件——含 setup 未成功者（X5），它们的 dispose 同样
 * 由 shutdown 逆序调用；`BootError.mounted` 名单在抛出时才从中剔除半失败者。
 */
const mountOrder = new WeakMap<Ctx, Plugin[]>()
/** shutdown 需要 abort 的 controller 同样不能挂到 ctx 上，与挂载序并行的内部记录。 */
const controllers = new WeakMap<Ctx, AbortController>()
/**
 * 首轮 shutdown 的进行中 Promise（review Y9）。
 *
 * 为什么需要：原先"结束时清空挂载序"只能保证**串行**重复调用幂等——两个并发
 * `shutdown` 都会在清空前拿到同一份非空数组，于是每个插件被 dispose 两次。
 * 用单飞记忆把并发调用收敛到同一轮清理。
 */
const shutdowns = new WeakMap<Ctx, Promise<void>>()

/**
 * 递归冻结：对 config 全树（含 `plugins[].config` 与数组元素）执行 `Object.freeze`。
 * 冻结归属恒定为 `boot()`（设计 §2.3）：01 的 `loadConfig()` 只加载与合并、不冻结，
 * 01 Baseline 前后本调用保持不变。
 *
 * @param target 冻结目标（对象/数组；原始值直接忽略）
 * @param seen 循环引用防护（config 来自 JSON 本应无环，防御性保留）
 */
function deepFreeze(target: object, seen: WeakSet<object> = new WeakSet()): void {
  if (seen.has(target)) return
  seen.add(target)
  Object.freeze(target)
  for (const key of Reflect.ownKeys(target)) {
    const value = (target as Record<PropertyKey, unknown>)[key]
    if (value !== null && typeof value === 'object') deepFreeze(value, seen)
  }
}

/** 从 Error/unknown 提取可读消息（底层失败原因要拼进 BootError 的 message）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 校验工厂产物确实是插件（设计 §5 边界表：`factory()` 返回非插件 = 该插件未挂载）。
 *
 * 第三方 JS 插件可能漏 `return` 或导出任意对象；若不在此拦截，`plugin.setup(...)`
 * 与失败路径里的 `plugin.name` 会以 `TypeError` **二次抛错**，从而绕过 `failBoot`
 * ——抛出的不是 `BootError`，且已挂载插件得不到清理（违反 R3 决议）。
 *
 * @throws Error 产物不是 `{ name: string, setup: function }` 形态的插件（来源由调用方拼进消息）
 */
function assertPlugin(plugin: unknown): asserts plugin is Plugin {
  const ok =
    typeof plugin === 'object' &&
    plugin !== null &&
    typeof (plugin as Plugin).name === 'string' &&
    typeof (plugin as Plugin).setup === 'function'
  if (!ok) {
    throw new Error(`factory did not return a plugin (need { name: string, setup: function })`)
  }
}

/**
 * 解析插件来源为工厂（设计 §4.1 步骤 5a）。
 *
 * - `builtin:<name>`：查 builtin 表，未命中抛错（转 BootError）；
 * - 其他：视为**相对 cwd** 的本地路径——ESM 相对说明符按导入者模块（本文件）解析，
 *   因此必须先 `path.resolve(process.cwd(), source)` 转绝对路径再转 `file://` URL
 *   （Windows 盘符路径必需），`await import(url)` 后取 `default` 导出；
 *   import 失败 / 无 default / default 不是工厂函数均抛错（转 BootError）。
 *
 * @param source 插件来源（`builtin:<name>` 或相对 cwd 的路径）
 * @returns 插件工厂
 * @throws Error 任一解析失败（由 boot 统一转 BootError）
 */
async function resolveFactory(source: string): Promise<PluginFactory> {
  if (source.startsWith('builtin:')) {
    const name = source.slice('builtin:'.length)
    const factory = builtinPlugins.get(name)
    if (!factory) throw new Error(`builtin plugin '${source}' not found`)
    return factory
  }
  const absolute = path.resolve(process.cwd(), source)
  const url = pathToFileURL(absolute)
  let mod: { default?: unknown }
  try {
    mod = (await import(url.href)) as { default?: unknown }
  } catch (err) {
    throw new Error(`failed to import plugin '${source}': ${errMsg(err)}`)
  }
  const factory = mod.default
  if (typeof factory !== 'function') {
    throw new Error(`plugin '${source}' has no default factory export`)
  }
  return factory as PluginFactory
}

/**
 * boot 失败路径（R3 决议）：挂载失败不是"无副作用"的——09 的 MCP 插件可能在
 * setup 中拉起 stdio 子进程，Windows 下父进程退出不保证子进程终止。因此失败前
 * **复用 shutdown 流程**清理挂载序中的插件（逆序 dispose，抛错只记 log、不掩盖
 * BootError，最后 abort），再抛 `BootError`（携带已**成功**挂载的名单）。
 *
 * @param mounted 已成功挂载的插件（BootError 名单来源；销毁范围由 shutdown 自行取用，
 *                可能比它多一个 setup 半失败者，见 X5）
 */
async function failBoot(ctx: Ctx, mounted: Plugin[], message: string): Promise<never> {
  // 名单必须在 shutdown 之前固化：shutdown 结束会清空挂载序（幂等的落点）
  const names = mounted.map((p) => p.name)
  await shutdown(ctx)
  throw new BootError(message, names)
}

/**
 * 组合根：按 `config.plugins` 数组顺序串行挂载插件（架构 §5.5，设计 §4.1）。
 *
 * 时序：deepFreeze(config) → AbortController → Logger/EventBus → 组装 Ctx →
 * 逐插件 [解析工厂 → factory() → 形状校验 → setup(ctx, entry.config)] → 每个挂载成功
 * `emit('plugin/mounted')`。任一步失败：先逆序 dispose 已挂载插件（含 setup 半失败者，
 * X5）再抛 BootError（fail-fast，无部分可用）。
 *
 * 重复/并发调用 `boot()` 为未定义行为，M0 不做防护（设计 §5）。
 *
 * @param config 尚未冻结的完整配置（boot 内部执行 deepFreeze）
 * @returns 组装完成、全部插件已挂载的 Ctx
 * @throws BootError 任一插件的解析/工厂/挂载失败（已清理半启动状态）
 */
export async function boot(config: Config): Promise<Ctx> {
  // 1. 递归冻结，含 plugins[].config；插件不得修改自身实例配置（strict 下写冻结对象抛 TypeError）
  deepFreeze(config)
  // 2. 进程级取消信号（触发逻辑——Ctrl+C 两段式——归 07，M0 只暴露通道）
  const controller = new AbortController()
  // 3–4. 创建 Logger/EventBus 与全部容器，组装 readonly 冻结的 Ctx
  const ctx = createKernel(config, controller.signal)
  const mounted: Plugin[] = []
  mountOrder.set(ctx, mounted)
  controllers.set(ctx, controller)

  // 5. 按配置数组顺序串行挂载
  for (const entry of config.plugins) {
    let plugin: Plugin
    try {
      // 5a. 来源解析（builtin 表 / cwd 相对路径 import） + 5b. 工厂实例化与形状校验
      const factory = await resolveFactory(entry.source)
      plugin = await factory()
      assertPlugin(plugin)
    } catch (err) {
      // import 失败 / 无 default / default 非函数 / builtin 未命中 / factory() 抛错 /
      // 产物不是插件：该插件未挂载（不在名单内），先清理已挂载者再抛 BootError
      return await failBoot(ctx, mounted, `boot failed at '${entry.source}': ${errMsg(err)}`)
    }
    // 5c. 先记入挂载序再调 setup：setup 半失败者（如已拉起子进程后抛错）也必须被
    // 逆序 dispose（R3 决议的延伸，X5）；此时它尚未成功挂载，故不计入 BootError 名单
    mounted.push(plugin)
    try {
      // 5d. 挂载钩子，注入实例级配置
      await plugin.setup(ctx, entry.config)
    } catch (err) {
      // 名单剔除半失败者：mounted 末位即它，已挂载名单为其之前的部分
      return await failBoot(
        ctx,
        mounted.slice(0, -1),
        `boot failed at '${entry.source}' (plugin '${plugin.name}') setup: ${errMsg(err)}`,
      )
    }
    // 5e. 挂载成功，广播
    ctx.events.emit('plugin/mounted', { name: plugin.name })
  }
  // 6. 全部挂载成功
  return ctx
}

/**
 * 卸载（设计 §4.2）：按挂载**逆序**调用各插件 `dispose?.()`（无 dispose 的跳过），
 * 单个 dispose 抛错记 `log.error` 继续下一个（不上抛、不中断）；最后 abort——
 * 触发 `ctx.signal`，中止进程内在途操作。
 *
 * 服务两个调用方：正常退出（07 CLI 的退出流程）与 boot 失败清理（R3 决议）。
 *
 * **幂等且并发安全**：首轮清理被记忆为单个 Promise（review Y9），并发调用共享同一
 * 轮 dispose；结束后清空挂载序，后续调用直接返回。`abort()` 本身亦为幂等操作。
 *
 * **abort 在全部 dispose 之后**（R3 决议的时序）：因此插件不得在 dispose 里等待
 * `ctx.signal` 触发的取消——那个信号要等 dispose 全部返回才会发出，等待会死锁。
 * 需要主动终止在途任务的插件应在 dispose 内自行 abort 自己的 controller。
 *
 * 挂载序中含"setup 未成功"的插件（X5）——它们同样会被 dispose，以实现 R3 的
 * 半启动清理语义；`BootError.mounted` 名单不含它们。
 *
 * @param ctx boot 返回的容器
 */
export async function shutdown(ctx: Ctx): Promise<void> {
  const inFlight = shutdowns.get(ctx)
  if (inFlight) return inFlight
  const run = (async (): Promise<void> => {
    const mounted = mountOrder.get(ctx) ?? []
    for (let i = mounted.length - 1; i >= 0; i--) {
      const plugin = mounted[i]!
      try {
        await plugin.dispose?.()
      } catch (err) {
        // dispose 失败只记录：既不中断逆序清理，也不掩盖正在上抛的 BootError
        ctx.log.error(`dispose of plugin '${plugin.name}' threw`, err)
      }
    }
    // 清空挂载序：串行重复调用不再触发第二轮 dispose（mounted 与 boot 持有同一数组引用）
    mounted.length = 0
    controllers.get(ctx)?.abort()
  })()
  shutdowns.set(ctx, run)
  return run
}
