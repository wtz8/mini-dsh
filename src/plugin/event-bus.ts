import type { EventBus, Logger, NotificationMap, Unsubscribe, WaterfallMap } from '../contracts.js'

/** 通知监听器的内部存储形态（载荷类型在注册入口收窄，存储侧擦除为 unknown）。 */
type NotifyListener = (p: unknown) => void
/**
 * 瀑布监听器的内部存储形态：载荷类型在注册入口收窄，存储侧擦除为 `unknown`。
 * 返回值语义：只有**对象**（`typeof === 'object'` 且非 `null`）才会替换载荷，
 * 其余一切值（含 `undefined` / `null` / `false` / `0`）均表示"保持原载荷"——
 * 严格按契约"返回同构对象则替换"实现，避免 falsy 返回值把载荷浇坏。
 */
type WaterfallListener = (p: unknown) => unknown | Promise<unknown>

/**
 * 判断回调是否返回了 thenable（review Y6）。
 *
 * 通知监听器签名返回 `void`，但 TypeScript 允许把 `async` 函数赋给它——此时回调内
 * 的抛错变成 rejected Promise，**逃过同步 `try/catch`**，最终成为 unhandledRejection。
 * 那既不符合"单个监听器抛错只记 log"的契约，也不受 `emit` 的控制。
 */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * 事件总线的内核实现（架构 §5.3，通知 + 瀑布两域）。
 *
 * - 两张 `Map<string, listener[]>`，监听器**按注册序追加**（数组尾部 push）；
 * - 派发期间对监听器数组做快照，单个监听器在回调中退订自身/他人不影响本次派发；
 * - 通知 `emit`：同步遍历，单个监听器抛错 `try/catch` 后经构造时注入的
 *   `Logger.error` 记录，继续下一个——**emit 永不抛**；
 * - 瀑布 `waterfall`：串行 `await`，返回值非 `undefined` 则替换载荷，
 *   抛错即否决上抛（pipeline 捕获 `ToolRejected` 转为 denied 结果）。
 */
export class EventBusImpl implements EventBus {
  /** 通知监听器表：事件名 -> 按注册序排列的监听器数组 */
  readonly #notify: Map<string, NotifyListener[]> = new Map()
  /** 瀑布监听器表：事件名 -> 按注册序排列的监听器数组 */
  readonly #waterfallListeners: Map<string, WaterfallListener[]> = new Map()
  /** 监听器抛错时的记录通道（通知域专用，瀑布域错误直接上抛）。 */
  readonly #log: Logger

  /**
   * @param log 通知监听器抛错时经 `log.error` 记 stderr（EventBus 在 Ctx 组装前创建，
   *             因此构造注入而非从 ctx 读取）
   */
  constructor(log: Logger) {
    this.#log = log
  }

  /** 取指定表的监听器数组，不存在则创建（惰性，避免为每个事件名预建空数组）。 */
  #bucket<K extends 'notify' | 'waterfall'>(kind: K, type: string): K extends 'notify' ? NotifyListener[] : WaterfallListener[] {
    const map = kind === 'notify' ? this.#notify : this.#waterfallListeners
    let arr = map.get(type)
    if (!arr) {
      arr = []
      map.set(type, arr)
    }
    return arr as K extends 'notify' ? NotifyListener[] : WaterfallListener[]
  }

  /** 通用退订句柄：按身份从数组移除（未找到则无操作，重复退订安全）。 */
  static #off(list: unknown[], fn: unknown): void {
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  /**
   * 注册通知监听器。
   *
   * 每次注册包一层独立 `token`，退订句柄只删自己那条并置 `active = false`
   * （review Y4）：若按回调函数身份删（原实现），"退订 → 同一函数重新注册 →
   * 再调旧句柄"会删掉**新**订阅，与契约"重复调用安全"的承诺不符。
   */
  on<K extends keyof NotificationMap>(type: K, fn: (p: NotificationMap[K]) => void): Unsubscribe {
    const bucket = this.#bucket('notify', type)
    // 每次注册包一层独立 token：退订句柄只删自己那条（review Y4）。身份独立即可
    // 保证幂等与"旧句柄不影响新订阅"；不再用 active 标记，因为派发是**快照遍历**
    // ——监听器在回调中退订他人，被退订者仍应收到本次事件（既有契约语义）。
    const token: NotifyListener = (payload) => fn(payload as NotificationMap[K])
    bucket.push(token)
    return () => EventBusImpl.#off(bucket, token)
  }

  emit<K extends keyof NotificationMap>(type: K, payload: NotificationMap[K]): void {
    // 快照遍历：监听器内退订不影响本次派发；空表直接返回
    const listeners = [...this.#bucket('notify', type)]
    for (const fn of listeners) {
      try {
        const ret: unknown = fn(payload)
        // async 监听器（异步函数赋给 void 签名是允许的）的 rejection 不会进同步
        // try/catch：显式挂 catch，否则逃逸成 unhandledRejection（review Y6）。
        // 经 `Promise.resolve` 适配而非裸调 `ret.catch`（review Y7）：监听器可能返回
        // **非标准 thenable**（有 then 无 catch），裸调会在 try 里同步抛 TypeError、
        // 被误记成"监听器抛错"，而真正的 rejection 仍可能逃逸；Promise 适配对任何
        // thenable 都成立
        if (isThenable(ret)) {
          void Promise.resolve(ret).catch((err: unknown) => {
            this.#log.error(`event listener of '${type}' threw`, err)
          })
        }
      } catch (err) {
        // 通知事件的错误策略（架构 §5.3）：吞掉 + 记 log，emit 永不抛
        this.#log.error(`event listener of '${type}' threw`, err)
      }
    }
  }

  onWaterfall<K extends keyof WaterfallMap>(
    type: K,
    fn: (p: WaterfallMap[K]) => WaterfallMap[K] | void | Promise<WaterfallMap[K] | void>,
  ): Unsubscribe {
    const bucket = this.#bucket('waterfall', type)
    // 与通知域同式：独立 token 作退订身份（review Y4）
    const token: WaterfallListener = (payload) => fn(payload as WaterfallMap[K])
    bucket.push(token)
    return () => EventBusImpl.#off(bucket, token)
  }

  async waterfall<K extends keyof WaterfallMap>(type: K, payload: WaterfallMap[K]): Promise<WaterfallMap[K]> {
    // 快照遍历：注册序即执行序，串行 await
    const listeners = [...this.#bucket('waterfall', type)]
    let current = payload
    for (const fn of listeners) {
      // 只有返回同构对象才替换载荷（契约语义）：仅排除 undefined 会让 `return false`
      // 之类的手误把载荷浇成 false，且因类型擦除而静默通过编译
      const next = await fn(current)
      if (typeof next === 'object' && next !== null) current = next as WaterfallMap[K]
    }
    return current
  }
}
