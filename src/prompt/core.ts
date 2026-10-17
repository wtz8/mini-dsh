import type { PromptSection } from '../contracts.js'
import { ENVIRONMENT_ID, createEnvironmentSection, safeCwd } from './sections/environment.js'
import { GUIDELINES_ID, createGuidelinesSection } from './sections/guidelines.js'
import { IDENTITY_ID, createIdentitySection } from './sections/identity.js'
import { TOOL_USE_ID, createToolUseSection } from './sections/tool-use.js'
import type { CoreSectionsOptions, EnvFacts } from './types.js'

/**
 * 内置核心段的组装（设计 §4.1 / D3）：**纯函数**——不依赖 ctx、不改入参，
 * 事实经 getter 注入。与 03 的"store 与插件分离"同式，段文案可脱离组合根单测。
 */

/**
 * 全部内置段 id（按 order 升序）。
 *
 * 导出给两处用：`disabled` 的合法性校验，以及 07 想在配置错误里提示可选值时列举。
 */
export const CORE_SECTION_IDS = [IDENTITY_ID, ENVIRONMENT_ID, TOOL_USE_ID, GUIDELINES_ID] as const

/** 已知 id 集合（校验用）。 */
const KNOWN_IDS: ReadonlySet<string> = new Set<string>(CORE_SECTION_IDS)

/**
 * 缺省环境事实：读 `process.*` 与当下时刻。
 *
 * 不含 `model` / `contextWindow`——那两项来自 `ctx.config`，只有插件接线层拿得到
 * （纯函数层不碰 ctx，D3）。缺省 provider 用于"直接调 createCoreSections"的场景，
 * 生产路径由插件传入含 model 的 provider。
 */
function defaultEnvFacts(): EnvFacts {
  return {
    cwd: safeCwd(),
    platform: process.platform,
    arch: process.arch,
    now: new Date(),
  }
}

/**
 * 构造全部内置核心段。
 *
 * @param options.env 环境事实提供者（缺省读 process）；**每次 render 调用一次**
 * @param options.hasTools 工具存在性（缺省恒 `false` → tool-use 段不出场）
 * @param options.disabled 禁用的段 id（与插件实例配置合并后的结果）
 * @returns 按 order 升序排列的段数组（空 `disabled` 时为全部四段）
 * @throws Error `disabled` 含未知 id——拼错段 id 时静默忽略 = 禁用不生效却无从察觉，
 *   故按"死配置早暴露"处理（与 01 X7"拒绝 permissions 空键"同式）。
 *   在 setup 内抛出会被组合根转为 `BootError`（fail-fast）。
 */
export function createCoreSections(options: CoreSectionsOptions = {}): PromptSection[] {
  const disabled = new Set<string>(options.disabled ?? [])
  const unknown = [...disabled].filter((id) => !KNOWN_IDS.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `builtin:prompt: unknown section id(s) in \`disabled\`: ${unknown.join(', ')}` +
        ` (known: ${CORE_SECTION_IDS.join(', ')})`,
    )
  }

  const env = options.env ?? defaultEnvFacts
  const hasTools = options.hasTools ?? ((): boolean => false)
  const enabled = (id: string): boolean => !disabled.has(id)

  const sections: PromptSection[] = []
  if (enabled(IDENTITY_ID)) sections.push(createIdentitySection())
  if (enabled(ENVIRONMENT_ID)) sections.push(createEnvironmentSection({ env }))
  if (enabled(TOOL_USE_ID)) sections.push(createToolUseSection({ hasTools }))
  if (enabled(GUIDELINES_ID)) sections.push(createGuidelinesSection())
  return sections
}
