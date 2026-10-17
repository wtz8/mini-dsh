import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config } from '../contracts.js'
import { ConfigError } from '../errors.js'
import { createDefaultConfig } from './defaults.js'
import { deepMerge, isPlainObject } from './merge.js'
import type { LoadConfigOptions } from './types.js'
import { validateConfig } from './validate.js'

/**
 * 配置加载（架构 §5.5）：`loadConfig()` 由宿主在 `boot()` **之前**调用，
 * 结果冻结后注入 `Ctx.config`——**config 不属于插件系统**（不以插件形式挂载）。
 *
 * 三层来源按优先级从低到高（后者覆盖前者）：
 * 1. 全局 `<globalDir>/config.json`（默认 `~/.minidsh/config.json`）；
 * 2. 项目 `<projectDir>/minidsh.json`（默认 `process.cwd()`，**不向上递归查找**，D2）；
 * 3. flags（07 CLI 传入的覆盖层）。
 *
 * 流程：读两层 JSON → 以默认值为 base 依次深合并 → 校验（D3）→ 返回。
 * **返回值未冻结**：`deepFreeze` 归属恒定为 `boot()`（`00-skeleton` §2.3）。
 */

/** 从 unknown 提取可读消息（底层 IO/解析错误要拼进 ConfigError）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 读取并解析一个配置文件层。
 *
 * - `ENOENT`（文件不存在）→ 返回 `undefined`：首次启动或只用单层配置都属正常，
 *   缺文件不得报错（否则用户必须同时维护两个文件）；
 * - 其它 IO 错误（EACCES / EISDIR…）→ `ConfigError`：静默丢配置比启动失败更难排查；
 * - JSON 语法错误（含空文件）或顶层不是纯对象 → `ConfigError`（带 `file`）。
 *
 * @param file 配置文件绝对路径
 * @returns 解析出的对象；文件不存在时为 `undefined`
 * @throws ConfigError 读取失败 / JSON 非法 / 顶层非对象
 */
async function readJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ConfigError(`failed to read config file '${file}': ${errMsg(err)}`, { file })
  }
  // UTF-8 BOM 剥离（X5）：Windows 记事本等编辑器保存 JSON 时会写入前导 U+FEFF，
  // `JSON.parse` 不认它（`Unexpected token 'ï»¿'`），报错信息用户无法理解。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`invalid JSON in config file '${file}': ${errMsg(err)}`, { file })
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`config file '${file}' must contain a JSON object`, { file })
  }
  return parsed
}

/**
 * 加载配置：默认值 → 全局 → 项目 → flags，逐层深合并后校验。
 *
 * @param opts 目录与 flags 覆盖；缺省时用 `~/.minidsh` 与 `process.cwd()`
 * @returns 合并校验后的 Config（**未冻结**，可安全喂给 `boot()`）
 * @throws ConfigError 任一文件不可读 / JSON 非法 / 合并结果校验失败
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const globalDir = opts.globalDir ?? path.join(os.homedir(), '.minidsh')
  const projectDir = opts.projectDir ?? process.cwd()
  // 串行读取以固定错误优先级：全局层先读先报错——用户更可能先写错全局配置
  const globalLayer = await readJsonFile(path.join(globalDir, 'config.json'))
  const projectLayer = await readJsonFile(path.join(projectDir, 'minidsh.json'))

  // 以默认值为 base（工厂产出新对象，D5），按优先级依次覆盖；数组整值替换
  let merged: Record<string, unknown> = createDefaultConfig() as unknown as Record<string, unknown>
  merged = deepMerge(merged, globalLayer)
  merged = deepMerge(merged, projectLayer)
  merged = deepMerge(merged, opts.flags)
  return validateConfig(merged)
}
