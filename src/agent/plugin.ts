import type { Ctx, PluginFactory, Unsubscribe } from '../contracts.js'
import { createBashTimeoutResolver, createToolRunner } from '../index.js'
import { registerBuiltin } from '../plugin/boot.js'
import { definePlugin } from '../plugin/define-plugin.js'
import { createAgentControl } from './loop.js'
import { BUILTIN_AGENT, MAX_STEPS_PER_TURN } from './types.js'
import type { AgentControlHandle, AgentPluginConfig, AgentPluginOptions } from './types.js'

/**
 * `builtin:agent-loop` 插件：把回合循环注册进 `ctx.agent`（架构 §5.2：
 * registry 型服务面由对应 builtin 插件 `register` 填充）。
 *
 * **eat own dogfood**：agent 能力本身也是插件——内核不知道回合循环的存在，
 * 07 经 `ctx.agent.resolve()` 拿控制面，未挂载时拿到 `'not mounted'`。
 *
 * 本插件只做三件事：装配 runner、解析/创建会话、注册控制面；
 * 循环本体在 `loop.ts`（设计 D3）。
 */

/**
 * 从实例配置（`plugins[].config`）narrow 步数上限。
 *
 * 与 04 / 05 同式：配置非法一律**抛错**（转 `BootError`，fail-fast），
 * 而不是静默忽略——"配了却不生效"最难排查。
 * 数组要显式拒绝（04 Y1 的教训：`typeof [] === 'object'`）。
 *
 * @returns 配置里的步数上限；未配置返回 `undefined`
 * @throws Error 配置不是对象 / `maxStepsPerTurn` 不是正整数
 */
function narrowMaxSteps(config: unknown): number | undefined {
  if (config === undefined) return undefined
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('builtin:agent-loop config: must be an object')
  }
  const raw = (config as AgentPluginConfig).maxStepsPerTurn
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error('builtin:agent-loop config: `maxStepsPerTurn` must be a positive integer')
  }
  return raw
}

/**
 * 审批通道的接线说明（实现期偏离 X3，取代设计 D9 / Q12 的原方案）。
 *
 * 原设计打算由 06 用回合信号包装 `approve`，让"取消"与"用户答复"赛跑。
 * **实测不需要**：05 的 `requestApproval` 内部已经把 `combinedSignal(rc)`（回合级 ∪
 * 进程级）与审批结果赛跑，信号一到就直接产出 `cancelled` 结果。06 再包一层只会让
 * "拒绝（permission_denied）"与"取消（cancelled）"两条路径竞态，错误码变得不确定。
 *
 * 因此 `approve` **原样透传**给 runner：取消期间的审批由 05 判为 `cancelled`
 * （比 permission_denied 更准确），无 approve 时由 05 判为 `permission_denied`
 * （失败关闭，PB-02 ②）。
 */

/**
 * 构造 `builtin:agent-loop` 插件工厂。
 *
 * @param options.sessionId 复用的会话 id（07 的 /resume）；省略则新建
 * @param options.approve `ask` 策略的审批通道；缺省 ⇒ 所有 `ask` 失败关闭
 * @param options.maxStepsPerTurn 单回合步数上限（实例配置可覆盖）
 * @returns 插件工厂；同进程可构造多份（测试用）
 */
export function createAgentPlugin(options: AgentPluginOptions = {}): PluginFactory {
  const requestedSession = options.sessionId
  const approve = options.approve
  const optionSteps = options.maxStepsPerTurn

  return definePlugin(() => {
    /** 控制面句柄（dispose 用；**setup 未完成时保持 undefined**，故一律可选链） */
    let control: AgentControlHandle | undefined

    return {
      name: BUILTIN_AGENT,

      /**
       * 挂载：装配 runner → 解析/创建会话 → 注册控制面。
       *
       * **会话在 setup 内解析**（设计 §8-Q1）：resume 一个不存在的 id 应在**启动期**
       * 报错（`SessionError{not_found}` → `BootError`），而不是等用户第一次回车。
       *
       * @throws Error 实例配置非法 / 会话不存在 / 重复注册（均由组合根转 `BootError`）
       */
      async setup(ctx: Ctx, config?: unknown): Promise<void> {
        const maxStepsPerTurn = narrowMaxSteps(config) ?? optionSteps ?? MAX_STEPS_PER_TURN

        // 一次装配、每 step 复用（05 §4.3 的接线约定）
        const runner = createToolRunner(ctx, {
          // 原样透传：取消与超时的判定都在 05 内部完成（见本文件顶部说明 / X3）
          approve,
          // 06 不认 bash 的超时字段名，由 05 的工厂给出解析函数
          timeoutFor: createBashTimeoutResolver(ctx.config),
        })

        const session =
          requestedSession !== undefined
            ? await ctx.sessions.open(requestedSession)
            : await ctx.sessions.create({
                provider: ctx.config.model.provider,
                model: ctx.config.model.name,
                cwd: process.cwd(),
              })

        control = createAgentControl({
          ctx,
          sessionId: session.id,
          // 惰性解析 adapter（02 D7：provider 自检归使用点，不在 setup 内做）
          resolveAdapter: () =>
            ctx.llm.resolve(ctx.config.model.provider)(ctx.config.model),
          runner,
          maxStepsPerTurn,
        })

        ctx.agent.register(control)
      },

      /**
       * 卸载：中止在途回合并等其收尾（设计 D10）。
       *
       * **必须容忍 setup 未完成**（内核 X5）：boot 失败清理时 `control` 可能是
       * `undefined`，故一律可选链。**不设超时**——由 07 的退出流程兜底。
       */
      async dispose(): Promise<void> {
        await control?.abortAndWait('shutdown')
      },
    }
  })
}

/**
 * 把默认 `builtin:agent-loop` 注册进内核 builtin 表。
 *
 * 默认形态**没有 approve**——所有 `ask`（含权限兜底）都会失败关闭。
 * 07 应当用自己的实例替换：
 * `registerBuiltin('agent-loop', createAgentPlugin({ approve, sessionId }))`。
 *
 * @returns 退订句柄：从表中移除本插件工厂
 * @throws Error 同名重复注册
 */
export function registerAgentBuiltin(): Unsubscribe {
  return registerBuiltin('agent-loop', createAgentPlugin())
}
