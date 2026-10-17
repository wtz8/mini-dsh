import path from 'node:path'

import type { Ctx, PluginFactory, Unsubscribe } from '../contracts.js'
// registerBuiltin 是内核为内置模块开的唯一注册出口。与 02 同式：直接从 boot.js 取
// 而非绕回 `src/index.ts`——后者会转发本模块的 `deriveMessages`，形成
// index → session/plugin → index 的循环引用；boot.js 不反向依赖任何功能模块，取它无环。
import { registerBuiltin } from '../plugin/boot.js'
import { definePlugin } from '../plugin/define-plugin.js'
import { createJsonlSessionStore } from './store.js'
import type { JsonlSessionStore, SessionPluginOptions } from './types.js'

/**
 * `builtin:session` 插件：把 JSONL 会话存储注入 `ctx.sessions`（架构 §5.2：
 * `SessionStoreContainer` 由内置插件经 `mount` 一次性注入）。
 *
 * **eat own dogfood**：会话能力本身也是插件——内核不知道 JSONL 的存在，06 只用
 * `ctx.sessions.*`，未挂载时拿到的是 `'not mounted'`。
 *
 * 本插件是**薄适配层**（设计 D3）：store 不知道 ctx 的存在，事件广播与日志经回调
 * 接进来；插件也顺手把实例级配置（`plugins[].config.dir`）narrow 成目录路径。
 */

/** 插件名（`config.plugins[].source` 写作 `builtin:session`）。 */
export const BUILTIN_SESSION = 'builtin:session'

/**
 * 解析 sessions 根目录：实例配置 > 插件构造选项 > 默认 `~/.minidsh/sessions`。
 *
 * 相对路径按 `process.cwd()` 解析（与 boot 解析本地插件路径同式）。
 *
 * @returns 根目录绝对路径；**`undefined` 表示"用 store 自己的默认值"**
 * @throws Error `plugins[].config.dir` 不是非空字符串（由组合根转 BootError，fail-fast）
 */
function resolveDir(injected: string | undefined, config: unknown): string | undefined {
  if (typeof config === 'object' && config !== null) {
    const dir = (config as { dir?: unknown }).dir
    if (dir !== undefined) {
      if (typeof dir !== 'string' || dir.trim() === '') {
        throw new Error('builtin:session config: `dir` must be a non-empty string')
      }
      return path.resolve(dir)
    }
  }
  if (injected !== undefined) {
    if (typeof injected !== 'string' || injected.trim() === '') {
      throw new Error('builtin:session option: `dir` must be a non-empty string')
    }
    return path.resolve(injected)
  }
  return undefined
}

/**
 * 构造 `builtin:session` 插件工厂。
 *
 * @param options.dir 覆盖 sessions 根目录（生产不传；测试注入 tmp 目录）
 * @returns 插件工厂；同进程可构造多份（各带自己的目录，测试用）
 */
export function createSessionPlugin(options: SessionPluginOptions = {}): PluginFactory {
  const injected = options.dir
  return definePlugin(() => {
    // 每个插件实例持有自己的 store 引用，供 dispose 使用
    let store: JsonlSessionStore | undefined
    return {
      name: BUILTIN_SESSION,

      /**
       * 挂载：构造 store 并注入 `ctx.sessions`。
       *
       * @throws Error 目录配置非法，或 `mount` 被二次调用（内核语义，转 BootError）
       */
      setup(ctx: Ctx, config?: unknown): void {
        store = createJsonlSessionStore({
          dir: resolveDir(injected, config),
          // 事件落盘后才广播：订阅者看到的 log 已经持久化（store 内部的顺序保证）
          onAppend: (sessionId, event) => {
            ctx.events.emit('session/append', { sessionId, event })
          },
          onWarn: (message) => {
            ctx.log.warn(message)
          },
          onError: (message, err) => {
            ctx.log.error(message, err)
          },
        })
        ctx.sessions.mount(store)
      },

      /**
       * 卸载：等在途写入落盘后清内存。
       *
       * **必须容忍 setup 未完成**（内核 X5 约定）：boot 失败清理会 dispose setup
       * 半途抛错的插件，此时 `store` 可能还是 `undefined`——故一律用可选链。
       * **不删文件**：会话是用户的持久数据，进程退出不该销毁它。
       */
      async dispose(): Promise<void> {
        await store?.settled()
        store?.clear()
      },
    }
  })
}

/**
 * 把 `builtin:session` 注册进内核 builtin 表（07 启动时对各 builtin 模块各调一次）。
 *
 * @returns 退订句柄：从表中移除本插件工厂（测试换注自己的变体时用）
 * @throws Error 同名重复注册
 */
export function registerSessionBuiltin(): Unsubscribe {
  return registerBuiltin('session', createSessionPlugin())
}
