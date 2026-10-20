import type { Ctx, PluginFactory, StreamEvent, SessionEvent, TurnSummary, Unsubscribe } from '../../src/index.js'
import { definePlugin } from '../../src/index.js'

import { createApprovalChannel } from './approval.js'
import { createWebServer, isLoopbackHost, normalizeBasePath, truncateForUi } from './server.js'
import type { WebServer } from './server.js'
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_HOST, DEFAULT_PORT, WEB_PLUGIN_NAME } from './types.js'
import type { ApprovalChannel, PendingApproval, UiEvent, WebPluginBundle, WebPluginConfig, WebPluginOptions } from './types.js'

/**
 * web 插件工厂（薄接线层，D1：一切能力都是插件）。
 *
 * 本插件**不**把 HTTP 服务注册进 `ctx`：没有第二个插件需要消费它，注册只会
 * 污染服务面（与 06 的 `AgentControlHandle` 同式取舍）。它只做三件事：
 * ① 把内核事件翻译成 SSE 帧；② 提供审批通道供宿主注入 agent-loop；③ 管好自己的
 * 监听与端口生命周期。
 */

/**
 * narrow 实例级配置 `plugins[].config`（沿用 04 Y1 / 05 的同一条防线）。
 *
 * 为什么要拒绝数组：`typeof [] === 'object'`，若只判 `typeof` 就会放行，
 * 结果是整份配置被静默忽略——用户以为配了端口，实际一个都没生效。
 *
 * @param config `plugins[].config` 原值
 * @returns 窄化后的配置；未提供时为空对象
 * @throws Error 配置非对象（**含数组**）、端口越界/非整数、host 为空、basePath 形态非法
 */
export function narrowWebConfig(config: unknown): WebPluginConfig {
  if (config === undefined || config === null) return {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('web plugin config: must be an object')
  }
  const raw = config as { port?: unknown; host?: unknown; basePath?: unknown }
  const out: WebPluginConfig = {}

  if (raw.port !== undefined) {
    const port = raw.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('web plugin config: `port` must be an integer in [0, 65535]')
  }
    out.port = port
  }

  if (raw.host !== undefined) {
    if (typeof raw.host !== 'string' || raw.host.trim() === '') {
      throw new Error('web plugin config: `host` must be a non-empty string')
  }
    out.host = raw.host
  }

  if (raw.basePath !== undefined) {
    if (typeof raw.basePath !== 'string') {
      throw new Error('web plugin config: `basePath` must be a string')
  }
    // 形态校验交给 normalizeBasePath（拒绝不以 `/` 开头的写法）
    out.basePath = normalizeBasePath(raw.basePath)
  }

  return out
}

/**
 * 构造 web 插件。
 *
 * 返回值里**同时**给出插件工厂与审批通道（D3）：
 * - `factory` 写进 `config.plugins[]`（或经 `registerBuiltin` 注册）；
 * - `approve` 必须传给 `createAgentPlugin({ approve })`，否则所有 `ask` 策略的
 *   工具都会**失败关闭**（05 的 PB-02 ②），界面上表现为"什么都写不了"。
 *
 * **配置优先级**：显式选项（宿主档）> 实例配置 > 默认值。
 *
 * @param options 宿主档选项
 * @returns 插件工厂 + 审批通道
 */
export function createWebPlugin(options: WebPluginOptions = {}): WebPluginBundle {
  const channel: ApprovalChannel = createApprovalChannel({
    timeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  })

  const factory: PluginFactory = definePlugin(() => {
    /** setup 内注册的全部退订句柄 */
    const unsubs: Unsubscribe[] = []
    /** 服务句柄；setup 未跑到 listen 时为 `undefined`，dispose 一律可选链 */
    let server: WebServer | undefined
    /** 上下文；setup 之后才有值 */
    let ctx: Ctx | undefined

    /**
     * 取当前会话 id。
     *
     * **惰性解析**而非 setup 期固化：06 的 agent-loop 若排在 web **之后**，
     * setup 时 `ctx.agent.resolve()` 会抛 `'not mounted'`。配置顺序是用户的自由，
     * 这里不替它做假设（与 06 D3"不在 setup 内解析 adapter"同式）。
     *
     * @returns 会话 id；agent 未挂载时 `undefined`
     */
    function currentSessionId(): string | undefined {
      if (ctx === undefined) return undefined
      try {
        return ctx.agent.resolve().sessionId
      } catch {
        return undefined
      }
    }

    return {
      name: WEB_PLUGIN_NAME,

      /**
       * 挂载：校验配置 → 订阅事件 → 起服务。
       *
       * @throws Error host 非回环 / 端口非法 / 监听失败（`EADDRINUSE` 等）
       *   ——均由组合根转 `BootError`（fail-fast，无"起一半"的状态）
       */
      async setup(context: Ctx, config?: unknown): Promise<void> {
        ctx = context
        const fromConfig = narrowWebConfig(config)

        const host = options.host ?? fromConfig.host ?? DEFAULT_HOST
        if (!isLoopbackHost(host)) {
          throw new Error(
            `web plugin: refusing to bind non-loopback host '${host}' (local-only by design)`,
          )
        }

        const port = options.port ?? fromConfig.port ?? DEFAULT_PORT
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error('web plugin: `port` must be an integer in [0, 65535]')
        }

        const basePath = normalizeBasePath(options.basePath ?? fromConfig.basePath)

        // ① 事件总线 → SSE 帧（订阅先建，listen 前的广播自然空转）
        unsubs.push(wireEvents(context, channel, (ev) => server?.broadcast(ev)))

        // ② 起服务
        server = createWebServer(
          {
            port,
            host,
            basePath,
            heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
            onReady: options.onReady,
          },
          {
            ctx: context,
            approvals: channel,
            sessionId: () => currentSessionId() ?? 'unknown',
            async runTurn(text: string): Promise<TurnSummary> {
              const agent = context.agent.resolve()
              try {
                const summary = await agent.run({ text })
                server?.broadcast({
                  type: 'turn-end',
                  turnNo: summary.turnNo,
                  stepCount: summary.stepCount,
                  usage: summary.totalUsage,
                  interrupted: summary.interrupted,
                })
                return summary
              } catch (err) {
                // 回合级错误：转成帧推给浏览器，服务继续可用（07 D4 同立场）
                server?.broadcast({ type: 'error', text: errText(err) })
                throw err
              }
            },
          },
        )
        await server.ready()
        context.log.info(
          `web ui ready at http://${host}:${String(server.port ?? port)}${basePath}/`,
        )
      },

      /**
       * 卸载：退订 → 关端口 → 关闭审批通道（挂起请求按**拒绝**放行）。
       *
       * 必须容忍 setup 未完成（X5）：boot 失败清理会 dispose 半失败插件，
       * 此时 `server` 可能仍是 `undefined`，故一律可选链。
       */
      async dispose(): Promise<void> {
        for (let i = unsubs.length - 1; i >= 0; i--) {
          try {
            unsubs[i]?.()
          } catch {
            // 退订失败不影响其余清理
          }
        }
        unsubs.length = 0
        await server?.close()
        channel.close()
      },
    }
  })

  return {
    factory,
    approve: (invocation) => channel.ask(invocation),
  }
}

/** 取错误的可读文本（与 07 的 `describeError` 同口径，此处只取文本以免依赖 CLI）。 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 把内核事件接到 SSE 广播上。
 *
 * 事件选择（设计 §4.3）：
 * - `turn/start` / `tool/start` / `tool/end` 直接映射；
 * - 文本增量取自 `stream/chunk` 的 `text` 子类型；
 * - 工具**结果**取自 `session/append` 的 `tool/result`——总线上的 `tool/end`
 *   通知只带 `callId`/`name`，拿不到内容（灵魂 #2：事实只在 log 里）；
 * - 工具**参数**取自 `tools/pre-execute` 瀑布（纯观察，返回 undefined 不改载荷）。
 *
 * 只转发与当前会话同 id 的事件，避免多会话串台；拿不到当前会话 id 时
 * （agent 未挂载）降级为转发全部，保证诊断信息仍可见。
 *
 * @param ctx 上下文
 * @param channel 审批通道
 * @param emit 广播函数
 * @returns 退订句柄
 */
function wireEvents(ctx: Ctx, channel: ApprovalChannel, emit: (ev: UiEvent) => void): Unsubscribe {
  const offs: Unsubscribe[] = []
  /** callId → 参数文本（瀑布改写后的最终形态） */
  const argCache = new Map<string, string>()

  /**
   * 是否该转发该事件。
   *
   * @param sessionId 事件所属会话
   * @returns 转发返回 `true`
   */
  function forCurrentSession(sessionId: string): boolean {
    try {
      const current = ctx.agent.resolve().sessionId
      return current === sessionId
    } catch {
      // agent 未挂载：降级为全量转发
      return true
    }
  }

  // 工具参数：瀑布观察者（返回 undefined = 保持原载荷）
  offs.push(
    ctx.events.onWaterfall('tools/pre-execute', (invocation) => {
      try {
        argCache.set(invocation.callId, JSON.stringify(invocation.args, null, 2) ?? '')
      } catch {
        argCache.set(invocation.callId, String(invocation.args))
      }
      return undefined
    }),
  )

  offs.push(
    ctx.events.on('turn/start', (p) => {
      if (forCurrentSession(p.sessionId)) emit({ type: 'turn-start', turnNo: p.turnNo })
    }),
  )

  offs.push(
    ctx.events.on('stream/chunk', (p) => {
      if (!forCurrentSession(p.sessionId)) return
      const delta: StreamEvent = p.delta
      if (delta.type === 'text') emit({ type: 'text', delta: delta.delta })
    }),
  )

  offs.push(
    ctx.events.on('tool/start', (p) => {
      if (!forCurrentSession(p.sessionId)) return
      emit({
        type: 'tool-start',
        callId: p.callId,
        name: p.name,
        args: argCache.get(p.callId) ?? '',
      })
    }),
  )

  offs.push(
    ctx.events.on('session/append', (p) => {
      if (!forCurrentSession(p.sessionId)) return
      const event: SessionEvent = p.event
      if (event.type !== 'tool/result') return
      const result = event.result
      emit({
        type: 'tool-end',
        callId: result.callId,
        name: result.name,
        ok: result.ok,
        text: truncateForUi(result.content),
        ...(result.error === undefined ? {} : { code: result.error.code }),
      })
    }),
  )

  // 回合收尾：清掉参数缓存（防止长会话下 Map 无界增长）
  offs.push(
    ctx.events.on('turn/end', (p) => {
      if (forCurrentSession(p.sessionId)) argCache.clear()
    }),
  )

  /**
   * 审批变更 → 帧。
   *
   * 收口在通道订阅而非 HTTP handler：让**所有**已连接的浏览器（而不只是点
   * 按钮的那一个）同步看到"卡片消失"，且超时/关闭路径也走同一出口。
   */
  offs.push(
    channel.subscribe((change) => {
      if (change.kind === 'add') {
        emit({ type: 'approval', approval: copyApproval(change.approval) })
        return
      }
      if (change.kind === 'resolve') {
        emit({ type: 'approval-resolved', id: change.id, allow: change.allow })
      }
      // kind === 'close'：进程都在退出了，靠断连重建，不单独推帧
    }),
  )

  return () => {
    for (let i = offs.length - 1; i >= 0; i--) {
      try {
        offs[i]?.()
      } catch {
        // 退订失败不影响其余清理
      }
    }
  }
}

/** 拷贝成浏览器可见的审批记录（与通道内部对象解引用）。 */
function copyApproval(item: PendingApproval): PendingApproval {
  return { id: item.id, toolName: item.toolName, args: { ...item.args }, createdAt: item.createdAt }
}
