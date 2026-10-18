import { BootError, ConfigError, LlmError, SessionError } from '../errors.js'

import type { ErrorDiagnosis } from './types.js'

/**
 * 错误分类：把四类运行时错误翻成**人类可读的诊断**（O4 / §4.7）。
 *
 * 为什么必须分类而不是统一打印 `err.message`：
 * - `ConfigError` / `BootError` 发生在 REPL 之前，**无法构成可用进程** ⇒ 退出码 1；
 * - `LlmError` / `SessionError` 发生在回合内 ⇒ 打印后回到提示符（D4），
 *   会话还在，用户改配置或换个措辞就能继续。
 *
 * 分类依据是各错误类的 `kind` 字段（01/02/03 分别为此设计），不靠 message 猜——
 * "没设 API key" 与 "HTTP 500" 的处置完全不同。
 */

/** 从 unknown 提取可读消息。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 生成诊断。
 *
 * @param err 任意抛出物（含非 Error）
 * @returns 诊断文案 + 建议退出码 + 是否值得重试
 */
export function describeError(err: unknown): ErrorDiagnosis {
  if (err instanceof ConfigError) {
    // file 与 path 二选一（01：文件级错误给 file，字段校验错误给 path）
    const where = err.file !== undefined ? `file: ${err.file}` : err.path !== undefined ? `path: ${err.path}` : undefined
    const hint = '可用 --config-dir 换全局配置目录，或 --no-project 跳过项目层'
    return {
      text: where === undefined ? `配置错误：${err.message}\n  ${hint}` : `配置错误：${err.message}\n  ${where}\n  ${hint}`,
      exitCode: 1,
      retryable: false,
    }
  }

  if (err instanceof BootError) {
    // mounted 名单是 R3 决议的产物：让用户看清"哪些插件已经起来了"
    const mounted = err.mounted.length > 0 ? err.mounted.join(', ') : '（无）'
    return {
      text: `启动失败：${err.message}\n  已挂载插件：${mounted}`,
      exitCode: 1,
      retryable: false,
    }
  }

  if (err instanceof LlmError) {
    switch (err.kind) {
      case 'config':
        return {
          text: `llm: ${err.message}\n  检查 model.apiKeyEnv 指向的环境变量是否已设置`,
          exitCode: 0,
          retryable: true,
        }
      case 'http':
        return {
          text: `llm: provider 返回 ${err.status ?? '非 2xx'}（${err.message}）\n  检查 model.baseUrl 与模型名`,
          exitCode: 0,
          retryable: true,
        }
      case 'network':
        return {
          text: `llm: 无法连接（${err.message}）\n  检查网络与 model.baseUrl`,
          exitCode: 0,
          retryable: true,
        }
      case 'protocol':
        return {
          text: `llm: 响应不是预期的 SSE 流（${err.message}）\n  baseUrl 是否指向 OpenAI 兼容端点？`,
          exitCode: 0,
          retryable: true,
        }
      case 'aborted':
        // 06 已在回合内把它消化成 interrupted，这里不该出现；出现也不必惊动用户
        return { text: `llm: 请求已取消（${err.message}）`, exitCode: 0, retryable: true }
    }
  }

  if (err instanceof SessionError) {
    const where = err.file !== undefined ? `\n  ${err.file}` : ''
    switch (err.kind) {
      case 'not_found':
        return {
          text: `session: 会话不存在（${err.message}）${where}\n  用 /sessions 查看可用会话，或用 mdsh --resume <id> 启动`,
          exitCode: 0,
          retryable: true,
        }
      case 'io':
        return { text: `session: 读写失败（${err.message}）${where}\n  检查磁盘空间与目录权限`, exitCode: 0, retryable: true }
      case 'corrupt':
        return { text: `session: 会话文件已损坏（${err.message}）${where}`, exitCode: 0, retryable: true }
    }
  }

  // 未知错误：不吞也不美化，但同样不终止 REPL（可能是某条输入的偶发触发）
  const name = err instanceof Error ? err.name : 'Error'
  return { text: `${name}: ${messageOf(err)}`, exitCode: 0, retryable: true }
}
