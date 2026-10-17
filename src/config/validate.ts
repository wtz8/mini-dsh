import type { Config, PermissionAction, PluginEntry } from '../contracts.js'
import { ConfigError } from '../errors.js'
import { isPlainObject } from './merge.js'

/**
 * 手写配置校验器（设计 §4.2 校验表）。零依赖：不引任何 schema 库。
 *
 * 输入是**三层合并后的最终对象**（设计 D3 / §8-Q5），因此字段应当齐全——
 * 缺字段按 ConfigError 处理（`loadConfig` 已先补默认值，走到这里说明默认值没生效）。
 * 未知字段**忽略**（§8-Q1）：返回值只含已知字段，不把用户多余的键带进冻结后的
 * `Ctx.config`。
 */

const PERMISSION_ACTIONS: readonly PermissionAction[] = ['auto', 'ask', 'deny']
const SHELLS: readonly Config['tools']['bash']['shell'][] = ['auto', 'bash', 'powershell']
const LOG_LEVELS: readonly NonNullable<Config['logLevel']>[] = ['debug', 'info', 'warn', 'error']

/**
 * 抛出字段级 ConfigError。
 *
 * @param path 相对 `config` 的字段路径（根级传 `''`）
 * @param message 期望说明（拼成 `config.<path> <message>`）
 */
function fail(path: string, message: string): never {
  const full = path === '' ? 'config' : `config.${path}`
  throw new ConfigError(`${full} ${message}`, { path: full })
}

/** 校验并收窄为纯对象；非对象即抛（数组与 `null` 都不是对象）。 */
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, 'must be an object')
  return value
}

/**
 * 校验并收窄为非空字符串，并**返回 trim 后的值**（X8）。
 *
 * 空白串视同缺失；前后空白一律剥离——配置里 `" deepseek-chat "` 是手写时的意外，
 * 原样透传会让 02 拿带空格的模型名去建连，失败点离配置太远。
 */
function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string')
  return value.trim()
}

/** 校验并收窄为 ≥ min 的整数（拒绝 NaN / Infinity / 小数）。 */
function requireInt(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    fail(path, `must be an integer >= ${min}`)
  }
  return value
}

/** 校验并收窄为枚举字符串之一。 */
function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `must be one of ${allowed.join(' | ')}`)
  }
  return value as T
}

/** 校验压缩阈值：`0 < x <= 1`（0 会让它永不触发或恒触发，1 以上无意义）。 */
function requireRatio(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(path, 'must be a number in (0, 1]')
  }
  return value
}

/**
 * 校验合并后的配置对象并收窄为 `Config`。
 *
 * fail-fast：首个错误即抛出，不聚合多个错误（01 无 logger，聚合错误信息只能靠
 * 异常消息拼接，收益不抵复杂度）。
 *
 * @param raw 三层合并后的对象（通常由 `loadConfig` 传入）
 * @returns 仅含已知字段的 Config（**未冻结**，冻结归 `boot()`）
 * @throws ConfigError 任一字段缺失、类型不符或取值越界
 */
export function validateConfig(raw: unknown): Config {
  const root = requireObject(raw, '')

  // model：四个字段都是非空字符串；baseUrl 不校验 URL 合法性（§8-Q6，02 建连时自然失败）
  const modelRaw = requireObject(root.model, 'model')
  const model = {
    provider: requireString(modelRaw.provider, 'model.provider'),
    name: requireString(modelRaw.name, 'model.name'),
    baseUrl: requireString(modelRaw.baseUrl, 'model.baseUrl'),
    apiKeyEnv: requireString(modelRaw.apiKeyEnv, 'model.apiKeyEnv'),
  }

  // 校验顺序即 Config 的字段声明顺序（model → contextWindow → tools → …），
  // 使 fail-fast 时"首个报错字段"可预期
  const contextWindow = requireInt(root.contextWindow, 'contextWindow', 1)

  const toolsRaw = requireObject(root.tools, 'tools')
  const bashRaw = requireObject(toolsRaw.bash, 'tools.bash')
  const tools = {
    maxParallel: requireInt(toolsRaw.maxParallel, 'tools.maxParallel', 1),
    bash: {
      shell: requireEnum(bashRaw.shell, 'tools.bash.shell', SHELLS),
      timeoutMs: requireInt(bashRaw.timeoutMs, 'tools.bash.timeoutMs', 1),
    },
  }

  const compactionRaw = requireObject(root.compaction, 'compaction')
  const compaction = {
    thresholdRatio: requireRatio(compactionRaw.thresholdRatio, 'compaction.thresholdRatio'),
    keepTurns: requireInt(compactionRaw.keepTurns, 'compaction.keepTurns', 0),
  }

  // permissions：键为工具名或 `前缀*`；裸 '*' 按配置错误拒绝（架构 §5.4 Q6）
  const permissionsRaw = requireObject(root.permissions, 'permissions')
  const permissions: Record<string, PermissionAction> = {}
  for (const key of Object.keys(permissionsRaw)) {
    if (key === '*') {
      fail('permissions.*', "wildcard key '*' is not supported (use a 'prefix*' key or an exact tool name)")
    }
    // 空键（X7）：设计 §4.2 要求键为非空字符串。空键不会被任何工具名命中（工具名非空），
    // 也不会被前缀通配命中，是纯粹的死配置——静默放过比启动失败更难排查
    if (key.trim() === '') {
      fail('permissions.<empty>', 'permission key must be a non-empty string')
    }
    // 与 merge 同理：JSON.parse 能产出 '__proto__' 自有键，直接赋值会污染原型
    if (key === '__proto__') continue
    permissions[key] = requireEnum(permissionsRaw[key], `permissions.${key}`, PERMISSION_ACTIONS)
  }

  // plugins：数组，每项必须有非空 source；`config` 任意形态不校验（§8-Q7，插件自行 narrow）
  if (!Array.isArray(root.plugins)) fail('plugins', 'must be an array')
  const plugins: PluginEntry[] = root.plugins.map((item: unknown, index: number) => {
    const entryRaw = requireObject(item, `plugins[${index}]`)
    const source = requireString(entryRaw.source, `plugins[${index}].source`)
    return entryRaw.config === undefined ? { source } : { source, config: entryRaw.config }
  })

  // logLevel 缺省补 'info'（设计 §4.2 / R4；X6：原先返回 undefined，与文档不符）
  const logLevel =
    root.logLevel === undefined ? 'info' : requireEnum(root.logLevel, 'logLevel', LOG_LEVELS)

  return {
    model,
    contextWindow,
    tools,
    compaction,
    permissions,
    plugins,
    logLevel,
  }
}
