import type { EventBus, Logger, NotificationMap, Unsubscribe, WaterfallMap } from '../contracts.js'

/** 通知监听器的内部存储形态（载荷类型在注册入口收窄，存储侧擦除为 unknown）。 */
type NotifyListener = (p: unknown) => void
/**
 * 瀑布监听器的内部存储形态：载荷类型在注册入口收窄，存储侧擦除为 `unknown`。
 * 返回值语义：`undefined` 表示"不替换"，其余任意值（含 `null`）视作新载荷——
 * 实现侧额外排除 `null`，避免 `null` 把载荷浇成空（契约只认对象形态的替换）。
 */
type WaterfallListener = (p: unknown) => unknown | Promise<unknown>

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

  on<K extends keyof NotificationMap>(type: K, fn: (p: NotificationMap[K]) => void): Unsubscribe {
    this.#bucket('notify', type).push(fn as NotifyListener)
    return () => EventBusImpl.#off(this.#bucket('notify', type), fn)
  }

  emit<K extends keyof NotificationMap>(type: K, payload: NotificationMap[K]): void {
    // 快照遍历：监听器内退订不影响本次派发；空表直接返回
    const listeners = [...this.#bucket('notify', type)]
    for (const fn of listeners) {
      try {
        fn(payload)
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
    this.#bucket('waterfall', type).push(fn as WaterfallListener)
    return () => EventBusImpl.#off(this.#bucket('waterfall', type), fn)
  }

  async waterfall<K extends keyof WaterfallMap>(type: K, payload: WaterfallMap[K]): Promise<WaterfallMap[K]> {
    // 快照遍历：注册序即执行序，串行 await
    const listeners = [...this.#bucket('waterfall', type)]
    let current = payload
    for (const fn of listeners) {
      // 返回值非 undefined/null 则替换载荷继续；抛错即否决，上抛给调用方（不吞）
      const next = await fn(current)
      if (next !== undefined && next !== null) current = next as WaterfallMap[K]
    }
    return current
  }
}
