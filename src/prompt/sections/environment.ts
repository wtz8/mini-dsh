import type { PromptSection } from '../../contracts.js'
import { PROMPT_ORDER } from '../order.js'
import type { EnvFacts } from '../types.js'

/**
 * 运行环境段（order 200，**动态段**：每次 render 重新取 env）。
 *
 * 动态的必要性（设计 D5/Q2）：`cwd`、时刻、已注册工具数都会随会话推进变化，
 * 06 每 step 调一次 render；若取 setup 时刻的快照，长会话里模型看到的是启动时的环境。
 */

/** 段 id（`disabled` 配置与错误信息里用）。 */
export const ENVIRONMENT_ID = 'core/environment'

/** 段构造选项：环境事实提供者（惰性，render 时调用）。 */
export interface EnvironmentSectionOptions {
  /** 环境事实提供者；**每次 render 调用一次** */
  env: () => EnvFacts
}

/**
 * 读取当前工作目录；读取失败时返回 `'unknown'`。
 *
 * `process.cwd()` 在**目录被删除**或权限不足时会抛（ENOENT/EACCES）——REPL 里
 * 用户完全可能在会话中途删掉当前目录。这里兜底而不是让 render 抛错：少一条
 * 环境信息只是让模型多问一句，整个回合失败则什么都做不了（设计 §5）。
 *
 * @param read 目录读取函数（注入点，便于单测模拟抛错；缺省 `process.cwd`）
 */
export function safeCwd(read: () => string = () => process.cwd()): string {
  try {
    return read()
  } catch {
    return 'unknown'
  }
}

/**
 * 格式化成本地时间 `YYYY-MM-DD HH:mm:ss`（手写，零依赖）。
 *
 * 不用 `toISOString()`：那是 UTC，与段里标注的"本地时区"自相矛盾——模型据此
 * 判断"刚才/今天"这类相对时间会整体偏掉一个时区。
 */
export function formatDateTime(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${date} ${time}`
}

/**
 * 取本地时区名（如 `'Asia/Shanghai'`）；不可用时返回 `'unknown'`。
 *
 * `Intl` 是内置对象，不引入运行时依赖；仍包 try/catch 是因为少数裁剪过的运行时
 * 没有完整 ICU 数据。
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 构造运行环境段。
 *
 * @param options.env 环境事实提供者（惰性；段本身不做任何 IO）
 * @returns `PromptSection`；`model` / `contextWindow` 缺省时对应行不渲染
 * @throws 由注入的 `env()` 抛出的错误**原样上抛**（容器 `render()` 不吞错，设计 Q6）
 */
export function createEnvironmentSection(options: EnvironmentSectionOptions): PromptSection {
  const { env } = options
  return {
    id: ENVIRONMENT_ID,
    order: PROMPT_ORDER.environment,
    render: () => {
      const facts = env()
      const lines = [
        '# 运行环境',
        '',
        `- 工作目录：${facts.cwd}`,
        `- 操作系统：${facts.platform} / ${facts.arch}`,
        `- 当前时间：${formatDateTime(facts.now)}（本地时区 ${localTimeZone()}）`,
      ]
      // 模型与上下文窗口来自 ctx.config：纯函数层拿不到，缺省即不渲染该行
      if (facts.model !== undefined) lines.push(`- 模型：${facts.model}`)
      if (facts.contextWindow !== undefined) {
        lines.push(`- 上下文窗口：${facts.contextWindow} tokens`)
      }
      lines.push('', '所有相对路径都按上面的工作目录解析。')
      return lines.join('\n')
    },
  }
}
