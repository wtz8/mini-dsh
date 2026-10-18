import { resolvePermission } from '../config/index.js'

import type { CliCommand, CliIO, CommandOutcome } from './types.js'

/**
 * slash 命令表（Q5：七条）。
 *
 * 命令是**宿主主权**：`COMMANDS` 是常量表而非扩展点——插件想加命令必须改本模块
 * （mini 版不为"插件扩展 REPL"留缝，架构 §3 也把命令画在宿主框内）。
 * 因此 08/09 若要 `/memory` 之类的命令，走的是"改 07"而不是"注册"。
 *
 * 每个命令的 `run` 都从 `CommandContext` 现取 `ctx`：`/resume` 重启内核后
 * ctx 引用会变，命令不得缓存它。
 */

/** `/help` 的表格渲染（命令表即唯一事实源，不另写一份清单）。 */
function renderHelp(io: CliIO): void {
  const width = COMMANDS.reduce((max, cmd) => Math.max(max, cmd.usage.length), 0)
  io.out('命令:\n')
  for (const cmd of COMMANDS) {
    io.out(`  ${cmd.usage.padEnd(width)}  ${cmd.summary}\n`)
  }
  io.out('\n直接输入文本即发起一个回合。\n')
}

/** 从 unknown 提取单行消息（命令内部的失败只给一行，不上 stack）。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const COMMANDS: readonly CliCommand[] = [
  {
    name: 'help',
    usage: '/help',
    summary: '列出全部命令',
    async run({ io }): Promise<CommandOutcome> {
      renderHelp(io)
      return { kind: 'continue' }
    },
  },
  {
    name: 'exit',
    usage: '/exit',
    summary: '退出（同 /quit）',
    async run({ io }) {
      io.out('再见。\n')
      return { kind: 'exit' }
    },
  },
  {
    name: 'quit',
    usage: '/quit',
    summary: '退出（同 /exit）',
    async run({ io }) {
      io.out('再见。\n')
      return { kind: 'exit' }
    },
  },
  {
    name: 'session',
    usage: '/session',
    summary: '当前会话 id 与已跑回合数',
    async run({ ctx, io, state }) {
      const id = state.sessionId
      if (id === undefined) {
        // X1：不是"没收到 header"（header 在 boot 期间就写完了），而是启动时没能确定 id
        io.out('当前会话：unknown（启动时尚未确定会话 id）\n')
        return { kind: 'continue' }
      }
      let turns = 0
      try {
        const events = await ctx.sessions.read(id)
        turns = events.filter((event) => event.type === 'turn/start').length
      } catch (err) {
        io.err(`读取会话失败：${messageOf(err)}\n`)
      }
      io.out(`会话 ${id} · 已跑回合 ${turns}\n`)
      return { kind: 'continue' }
    },
  },
  {
    name: 'sessions',
    usage: '/sessions',
    summary: '列出最近 10 个会话',
    async run({ ctx, io }) {
      try {
        const metas = await ctx.sessions.list()
        if (metas.length === 0) {
          io.out('（没有历史会话）\n')
          return { kind: 'continue' }
        }
        // 最新的在前：**直接沿用 `list()` 的顺序**——03 的 `SessionStore.list()` 已保证
        // 按 `createdAt` 降序（同值再按 id 降序保证稳定）。这里再排一次既重复了 store
        // 的契约，同值时又会丢掉 id 兜底，且 `localeCompare` 对 ISO 串带 locale 依赖
        // （与 store 的码位比较可能分叉）——与 `initialSessionId` 是同一处病灶，Y1 只
        // 修了那边，这里是漏网点（07 Y6）
        const recent = metas.slice(0, 10)
        for (const meta of recent) {
          io.out(`  ${meta.id}  ${meta.createdAt}  ${meta.provider}/${meta.model}  ${meta.cwd}\n`)
        }
      } catch (err) {
        io.err(`列出会话失败：${messageOf(err)}\n`)
      }
      return { kind: 'continue' }
    },
  },
  {
    name: 'tools',
    usage: '/tools',
    summary: '已注册工具及其权限策略（auto/ask/deny）',
    async run({ ctx, config, io }) {
      const defs = ctx.tools.list()
      if (defs.length === 0) {
        io.out('（没有已注册的工具：builtin:tools 未挂载或工具被禁用）\n')
        return { kind: 'continue' }
      }
      for (const def of defs) {
        const action = resolvePermission(config.permissions, def.name)
        const mode = def.concurrency === 'exclusive' ? ' · exclusive' : ''
        io.out(`  ${def.name} · ${action}${mode}\n`)
      }
      return { kind: 'continue' }
    },
  },
  {
    name: 'resume',
    usage: '/resume <id>',
    summary: '切换到指定会话（重启内核）',
    async run({ io }, arg) {
      if (arg === '') {
        io.err('用法：/resume <id>（用 /sessions 查看 id）\n')
        return { kind: 'continue' }
      }
      return { kind: 'resume', id: arg }
    },
  },
]

/**
 * 按名字查找命令（不含斜杠）。
 *
 * @returns 命令；未命中返回 `undefined`（调用方打印"未知命令"）
 */
export function findCommand(name: string): CliCommand | undefined {
  return COMMANDS.find((cmd) => cmd.name === name)
}

