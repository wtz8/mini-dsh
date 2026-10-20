import type { ToolInvocation } from '../../src/index.js'

import { DEFAULT_APPROVAL_TIMEOUT_MS } from './types.js'
import type { ApprovalChange, ApprovalChannel, PendingApproval } from './types.js'

/**
 * 审批通道：把 05 的 `ApproveHandler`（同步语义的"问一句"）桥成浏览器里的
 * "挂起 → 用户点按钮 → 放行或拒绝"。
 *
 * 本文件是**纯逻辑**，不碰 HTTP、不碰 ctx，全部行为可单测。HTTP 侧只在
 * `server.ts` 里把它接到 `POST /api/approve` 上。
 *
 * 两条设计立场：
 * - **失败关闭**：超时 / 通道关闭 / 响应丢失，一律按**拒绝**放行。拿不到人的回复时，
 *   安全的默认是不动手（与 05 的 PB-02 ② 同立场）。
 * - **快照隔离**：交给 UI 的一切都是**深拷贝**（`pending()` 的元素含 `args` 重新克隆），
 *   UI 怎么改都影响不到真正执行的对象——"检查 A、执行 B" 这类 TOCTOU 正是
 *   05 权限门要防的，展示层不能开后门。
 */

/** 挂起中的一次审批等待。 */
interface Waiter {
  resolve(allow: boolean): void
  timer: NodeJS.Timeout | undefined
}

/**
 * 深拷贝一份「纯数据」参数快照。
 *
 * 工具参数来自 `JSON.parse(invocation.arguments)`，正常是可序列化的；
 * 但 05 的 pre-execute 瀑布允许监听器替换 `args`，理论上可能塞进不可序列化的值，
 * 因此这里做好降级：序列化失败就退一层浅拷贝（UI 只读展示，不回写执行），
 * 绝不让"展示"这件事把回合搞崩。
 *
 * @param args 冻结后的参数对象
 * @returns 可安全交给 UI 的副本
 */
function cloneArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    const copy = JSON.parse(JSON.stringify(args)) as unknown
    if (typeof copy === 'object' && copy !== null && !Array.isArray(copy)) {
      return copy as Record<string, unknown>
    }
    // 极端形态（数组/原始值被塞进 args）：包一层，保证 UI 侧拿到的是对象
    return { value: copy }
  } catch {
    return { ...args }
  }
}

/**
 * 创建审批通道。
 *
 * @param options.timeoutMs 单次审批等待上限（毫秒），默认 `DEFAULT_APPROVAL_TIMEOUT_MS`；
 *   `<= 0` 表示不设超时（只应出现在测试里——生产无超时会让回合无限挂住）
 * @returns 审批通道
 */
export function createApprovalChannel(options: { timeoutMs?: number } = {}): ApprovalChannel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  /** 待审批请求（id → 记录） */
  const requests = new Map<string, PendingApproval>()
  /** 挂起等待者（id → resolver） */
  const waiters = new Map<string, Waiter>()
  /** 变更订阅者 */
  const listeners = new Set<(change: ApprovalChange) => void>()
  let closed = false
  let seq = 0

  /**
   * 广播变更。
   *
   * 单个订阅者抛错只吞掉、不影响其余订阅者——与事件总线 `emit` 的约定同式
   * （架构 §5.3：`emit` 本身永不抛错）。
   */
  function notify(change: ApprovalChange): void {
    for (const fn of [...listeners]) {
      try {
        fn(change)
      } catch {
        // 订阅者自身的问题不应影响通道与其他订阅者
      }
    }
  }

  /**
   * 结算一次审批：清计时器、删记录、放行等待者、广播 resolve（带 allow 真值）。
   *
   * `waiters` 里没有该 id 时直接返回（防重复响应，B6）。
   */
  function settle(id: string, allow: boolean, broadcast: boolean): void {
    const waiter = waiters.get(id)
    if (waiter === undefined) return
    waiters.delete(id)
    requests.delete(id)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.resolve(allow)
    if (broadcast) notify({ kind: 'resolve', id, allow })
  }

  return {
    /**
     * 请求授权（作为 `ApproveHandler` 注入 05/06）。
     *
     * 通道已关闭时**立即返回 false**，不挂起（否则 dispose 后的在途回合会永远卡住）。
     *
     * @returns `true` 放行 / `false` 拒绝（含超时与通道关闭）
     */
    ask(invocation: Readonly<ToolInvocation>): Promise<boolean> {
      if (closed) return Promise.resolve(false)

      seq += 1
      const id = `a${String(seq)}`
      const approval: PendingApproval = {
        id,
        toolName: invocation.name,
        args: cloneArgs(invocation.args),
        createdAt: Date.now(),
      }
      requests.set(id, approval)

      // Promise executor 同步执行，因此 `waiters` 一定在 notify 之前填好——
      // 保证订阅者（Web UI）收到通知时能立刻响应这条审批
      const pending = new Promise<boolean>((resolve) => {
        const timer = timeoutMs > 0 ? setTimeout(() => settle(id, false, true), timeoutMs) : undefined
        waiters.set(id, { resolve, timer })
      })

      notify({ kind: 'add', approval })
      return pending
    },

    /**
     * 待审批列表快照（按 id 序号升序，即请求先后）。
     *
     * 元素逐个**深拷贝**：这是给浏览器重建视图用的，如果只做浅拷贝数组，
     * UI 改动 `args` 就会穿透到通道内部（评审发现的真缺陷，已有回归锁定）。
     */
    pending(): ReadonlyArray<PendingApproval> {
      return [...requests.values()]
        .sort((a, b) => Number.parseInt(a.id.slice(1), 10) - Number.parseInt(b.id.slice(1), 10))
        .map((a) => ({ id: a.id, toolName: a.toolName, args: cloneArgs(a.args), createdAt: a.createdAt }))
    },

    /**
     * 浏览器响应一次审批。
     *
     * @returns `true` 命中并结算；`false` 表示 id 不存在或已结算（重复响应）
     */
    respond(id: string, allow: boolean): boolean {
      if (!waiters.has(id)) return false
      settle(id, allow, true)
      return true
    },

    /** 订阅变更；返回退订句柄（重复调用幂等） */
    subscribe(fn: (change: ApprovalChange) => void): () => void {
      listeners.add(fn)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(fn)
      }
    },

    /** 关闭通道：全部挂起请求按**拒绝**放行，最后广播一次 close */
    close(): void {
      if (closed) return
      closed = true
      // 不逐条广播 resolve：一次 close 语义更清楚（UI 整体清空）
      for (const id of [...waiters.keys()]) settle(id, false, false)
      requests.clear()
      notify({ kind: 'close' })
    },
  }
}
