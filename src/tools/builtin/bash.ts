import { spawn, spawnSync } from 'node:child_process'

import type { JsonSchema, ToolDefinition } from '../../contracts.js'

/**
 * `bash` 工具：在工作目录下执行一次性 shell 命令。
 *
 * 明确不做（架构 §10 已砍 sandbox）：
 * - 不做持久 shell / PTY / 交互式 stdin：一次性 spawn，`stdio: ['ignore','pipe','pipe']`；
 * - 不做命令白名单：危险命令的边界是**权限门**（`bash` 默认 `ask`），不是字符串黑名单
 *   （黑名单永远能被绕开，只会给人虚假的安全感）。
 *
 * 退出码语义：**非零退出仍是 `ok:true`**——shell 正常结束，退出码是结果的一部分
 * （`grep` 没命中返回 1 是正常行为）。只有 spawn 失败 / 超时 / 取消才算工具失败。
 */

/** 单路输出（stdout 或 stderr）的累积上限：防止 `yes` 之类把内存吃光。 */
const OUTPUT_CAP_CHARS = 64 * 1024

/** shell 解析结果：可执行文件 + 固定前缀参数。 */
export interface ShellSpec {
  command: string
  /** 执行 `command` 字符串前需要的前缀参数（如 `-c`） */
  prefix: string[]
  /** 人类可读名字（错误文案用） */
  label: string
}

/** 构造 `bash` 工具的选项。 */
export interface BashToolOptions {
  /** 取自 `config.tools.bash.shell`；`auto` 时在构造期探测一次 */
  shell?: 'auto' | 'bash' | 'powershell'
}

/** `bash` 的参数 schema（`timeoutMs` 由 pipeline 的 `timeoutFor` 强制，工具只做提示）。 */
const schema: JsonSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1, description: '要执行的 shell 命令' },
    timeoutMs: { type: 'integer', minimum: 1, description: '建议超时（只能小于配置上限）' },
  },
  required: ['command'],
  additionalProperties: false,
}

/** 探测某个可执行文件能否启动（`-c 'exit 0'` 跑通即算可用）。 */
function canRun(command: string, prefix: string[]): boolean {
  try {
    const result = spawnSync(command, [...prefix, 'exit 0'], {
      timeout: 5000,
      windowsHide: true,
      stdio: 'ignore',
    })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * 解析 shell（设计 §4.5 / Q8）。
 *
 * `auto` 的探测**只在构造期做一次**（插件 setup 时）：每次调用都探测会让每个 `bash`
 * 调用多花几十毫秒；探测失败时**直接抛错**，让 boot 失败——没有 shell 的 `bash`
 * 工具是废工具，早失败优于运行时每次报错。
 *
 * @param mode 配置里的 shell 模式
 * @returns shell 描述
 * @throws Error `auto` 且 bash / powershell / sh 全部不可用
 */
export function resolveShell(mode: 'auto' | 'bash' | 'powershell' = 'auto'): ShellSpec {
  const bash: ShellSpec = { command: 'bash', prefix: ['-c'], label: 'bash' }
  const powershell: ShellSpec = {
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    prefix: ['-NoProfile', '-NonInteractive', '-Command'],
    label: 'powershell',
  }
  const sh: ShellSpec = { command: 'sh', prefix: ['-c'], label: 'sh' }

  if (mode === 'bash') return bash
  if (mode === 'powershell') return powershell

  if (canRun(bash.command, bash.prefix)) return bash
  if (canRun(powershell.command, powershell.prefix)) return powershell
  if (process.platform !== 'win32' && canRun(sh.command, sh.prefix)) return sh
  throw new Error('no usable shell found for `bash` tool (tried bash / powershell / sh)')
}

/** 杀掉进程树：Windows 用 taskkill /T，POSIX 先 SIGTERM 再 SIGKILL。 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // spawn 失败（taskkill 缺失的极端环境）是异步 'error' 事件，try/catch 拦不住——
    // 不挂监听器会让整个进程以 unhandled 'error' 崩溃；退回直接 kill 直接子进程
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => {
      try {
        process.kill(pid)
      } catch {
        // 进程已退出
      }
    })
    killer.unref()
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 进程已退出
  }
  const timer = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程已退出
    }
  }, 1500)
  // 不因这个兜底定时器拖住进程退出
  timer.unref()
}

/** 追加输出并保持上限；超限时标注被丢弃的量。 */
function appendCapped(buffer: string, chunk: string): string {
  if (buffer.length >= OUTPUT_CAP_CHARS) return buffer
  return buffer + chunk.slice(0, OUTPUT_CAP_CHARS - buffer.length)
}

/** 组装最终文本：stdout + stderr 段 + 退出码。 */
function formatOutput(stdout: string, stderr: string, code: number | null, signal: NodeJS.Signals | null): string {
  const parts: string[] = []
  const out = stdout.replace(/\s+$/, '')
  const err = stderr.replace(/\s+$/, '')
  if (out !== '') parts.push(out)
  if (err !== '') parts.push(`[stderr]\n${err}`)
  if (stdout.length >= OUTPUT_CAP_CHARS || stderr.length >= OUTPUT_CAP_CHARS) {
    parts.push(`（输出超过 ${OUTPUT_CAP_CHARS / 1024}KB，已截断）`)
  }
  parts.push(code === null ? `[退出码: 被信号 ${signal ?? 'unknown'} 终止]` : `[退出码: ${code}]`)
  return parts.join('\n')
}

/**
 * 构造 `bash` 工具定义。
 *
 * @param options.shell shell 模式（默认 `auto`，构造期探测）
 * @returns 工具定义（`concurrency: 'exclusive'`）
 * @throws Error 见 `resolveShell`
 */
export function createBashTool(options: BashToolOptions = {}): ToolDefinition {
  // 构造期解析一次：探测成本只在 setup 付一次，且失败即 boot 失败（Q8）
  const shell = resolveShell(options.shell ?? 'auto')

  return {
    name: 'bash',
    description: '在工作目录下执行 shell 命令，返回 stdout / stderr 与退出码',
    schema,
    concurrency: 'exclusive',
    execute: async (args, env): Promise<string> => {
      const command = args['command'] as string
      return new Promise<string>((resolve, reject) => {
        const child = spawn(shell.command, [...shell.prefix, command], {
          cwd: process.cwd(), // 设计 D6：与 04 环境段的"工作目录"一致
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        const onAbort = (): void => killTree(child.pid)

        const cleanup = (): void => {
          env.signal.removeEventListener('abort', onAbort)
        }
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }

        if (env.signal.aborted) onAbort()
        else env.signal.addEventListener('abort', onAbort, { once: true })

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = appendCapped(stdout, chunk.toString('utf8'))
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = appendCapped(stderr, chunk.toString('utf8'))
        })

        child.on('error', (err: Error) => {
          finish(() => reject(new Error(`无法启动 ${shell.label}：${err.message}`)))
        })

        child.on('close', (code, signal) => {
          finish(() => {
            if (env.signal.aborted) {
              reject(new Error('命令已取消（进程已终止）'))
              return
            }
            resolve(formatOutput(stdout, stderr, code, signal))
          })
        })
      })
    },
  }
}
