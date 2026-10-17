# 04-prompt 设计

> 状态：**Baseline**（2026-10-17 所有者拍板 Q1–Q10 全部按建议项；实现、测试、复核评审（Y1）全部完成，随模块提交归档）
> 预算：~0.5k 行（架构 §4；本次范围预计 ~0.4k，见 §7 预算说明）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §3 的 `PromptRegistryImpl` 容器与"order 升序 + 同序 id 字典序 + `\n\n` 分隔"语义）、`01-config.md`（Baseline，重点 §2.3 Config 字段与 §4.2"Config 增字段须同步 validate"）、`02-llm.md`（Baseline，重点 §2 出口面约定与 §7 的 X2/X3：插件侧能力经 `src/index.ts` 转发、内置模块用 `registerBuiltin()` 显式注册并返回退订句柄）、`03-session.md`（Baseline，重点 D3"store 与插件分离"与 `registerSessionBuiltin()` 同式出口）、`architecture.md` 0.1.5（§5.2 装配语义、§5.4 `LLMRequest.system`、§6 数据流）

## 1. 背景与目标

04 交付架构 §5.2 装配语义里那句话的**内容侧**：

> `PromptRegistry.render()` 按 `order` 排序拼装全部 section，产出整体作为 `LLMRequest.system`（工具 schema 由 05 模块以一个 prompt section 注册，保持 render 是系统提示的唯一出口）。

对应骨架契约：

- architecture §5.2 `PromptRegistry { section(s) / render() }` 与 `PromptSection { id, order, render() }`：M0 已交付**最终实现**（`src/plugin/containers.ts` 的 `PromptRegistryImpl`），排序与分隔语义已定。
- architecture §5.4 `LLMRequest.system?: string` —— 系统提示是**每 step 现场拼装**、**不入 session log**（架构 §5.4 已决议：prompt 由配置与插件确定，可重建）。
- architecture §6 数据流：`system = ctx.prompt.render()`，每 step 调一次。
- architecture §5.4 工具契约旁注：工具 schema 由 **05** 以一个 prompt section 注册（保持 render 是唯一出口）。

**与 02/03 最关键的区别（本模块"薄"的根源）**：prompt 的容器在 M0 **已经是最终实现，不是委托式容器**——`section()` 与 `render()` 由内核直接可用，不存在"未挂载抛 `not mounted`"。因此 04 **不 mount 任何实现**，只往注册表里**注册内容**：`builtin:prompt` 是一个"内容插件"，不是"服务插件"（D1）。

目标（一句话）：让 06 只需

```ts
const req = {
  system: ctx.prompt.render(),              // 04：身份 + 环境 + 工具协议 + 准则
  messages: deriveMessages(await ctx.sessions.read(id)),   // 03
  model: ctx.config.model.name,
  tools: /* 05 */,
  signal,
}
```

就拿到一份结构稳定的系统提示，且**任何插件都能再往里加段**（08 的 MEMORY、07 的恢复说明），无需改动本模块。

**非目标**（明确不做，防范围膨胀）：

- 不做提示词工程调优、模板引擎、变量插值、条件表达式 DSL —— 段就是"返回字符串的同步函数"，仅此而已。
- 不做工具 schema（`ToolSchema[]` 与工具段归 **05**）。
- 不做项目指令文件（`minidsh.md` / `CLAUDE.md` 式上下文注入）与记忆文件（`MEMORY.md`）—— 归 **08**（架构 §10：记忆来自插件）。
- 不做 token 预算裁剪 / 段优先级淘汰（归 **06** 的压缩策略）。
- 不做系统提示持久化或 diff/审计（架构 §5.4 已决议不入 log）。
- 不改 `PromptRegistry` / `PromptSection` 签名，不新增运行时错误类（§2.3）。
- 不引入 `unregister` / `replace` —— 架构无热卸载（§10 已砍），注册即终态（禁用的替代方案见 D4）。

## 2. 对外契约

模块落在 `src/prompt/`。导出面分两类（沿用 02 X2 / X3 约定：**宿主侧**只经 `src/prompt/index.ts`；**插件侧**能力额外经 `src/index.ts` 转发，否则 05/08 只能深引用内部路径）。

### 2.1 宿主侧（`src/prompt/index.ts`）

```ts
/** 环境事实快照（段的渲染素材；生产由插件从 process/config 取，测试注入固定值） */
export interface EnvFacts {
  /** 当前工作目录；不可用时为 'unknown'（见 §5） */
  cwd: string
  /** `process.platform`（'win32' / 'linux' / 'darwin' …） */
  platform: string
  /** `process.arch`（'x64' / 'arm64' …） */
  arch: string
  /** 取"当前时刻"；environment 段每次 render 重新取值（D5） */
  now: Date
  /** `provider/name` 形式，如 'deepseek/deepseek-chat' */
  model?: string
  /** 上下文窗口 token 数（来自 `config.contextWindow`） */
  contextWindow?: number
}

/**
 * 核心段的构造选项（全部是注入点，生产由插件接线）。
 *
 * 两个函数型注入项刻意是 **getter 而非快照**：段在 `render()` 时才调用它们，
 * 于是"挂载顺序"与"段内容"解耦——`builtin:prompt` 即便先于 `builtin:tools` 挂载，
 * 首次 render 时工具已注册也能正确渲染工具段（§4.3）。
 */
export interface CoreSectionsOptions {
  /** 环境事实提供者；缺省读 `process.*` 与 `new Date()` */
  env?: () => EnvFacts
  /** 是否已注册任何工具；缺省 `() => false`——无工具时 tool-use 段返回 ''（D7 / §4.2） */
  hasTools?: () => boolean
  /** 禁用的内置段 id；不在已知集合内 → 抛错（死配置早暴露，与 01 X7 同式） */
  disabled?: readonly string[]
}

/**
 * 构造全部内置核心段（纯函数：不读 process、不依赖 ctx、不改入参）。
 * 与 03 的"store 与插件分离"同式（D3）——段内容可脱离组合根单测。
 */
export function createCoreSections(options?: CoreSectionsOptions): PromptSection[]

/** 插件构造选项（生产不传；测试注入固定 env / 禁用列表）；与核心段选项同形，故用别名 */
export type PromptPluginOptions = CoreSectionsOptions

/**
 * 构造 `builtin:prompt` 插件工厂：setup 内向 `ctx.prompt` 注册全部核心段。
 * 实例级配置 `plugins[].config = { disabled?: string[] }` 与构造选项同义，二者合并。
 */
export function createPromptPlugin(options?: PromptPluginOptions): PluginFactory

/**
 * 把 `builtin:prompt` 注册进内核 builtin 表（07 启动时对各 builtin 模块各调一次）。
 * @returns 退订句柄
 * @throws Error 同名重复注册（内核语义）
 */
export function registerPromptBuiltin(): Unsubscribe
```

### 2.2 插件侧（额外经 `src/index.ts` 转发）

```ts
/**
 * 段 order 的区间约定（不是强制约束，插件可填任意 number）。
 *
 * 之所以导出：order 是**跨插件的全局排序资源**——05（工具 schema）、08（MEMORY）、
 * 07（恢复说明）都要挑一个值，各模块各自写字面量必然漂移（与 02 X1 导出
 * `PROVIDER_DEEPSEEK` 同理由）。插件作者从 `src/index.js` 取，不 import 04 内部。
 */
export const PROMPT_ORDER = {
  /** 需要压在最前的段（如 07 的"本会话由 /resume 恢复"） */
  first: 0,
  identity: 100,     // 04：身份与定位
  environment: 200,  // 04：运行环境（动态）
  toolUse: 300,      // 04：工具调用协议（条件段）
  tools: 350,        // 05：工具 schema 列表（04 预留位，05 使用）
  guidelines: 800,   // 04：工作准则（X2：设计初稿的常量表漏列本项，实现补上）
  memory: 900,       // 08：MEMORY.md 内容
  plugin: 1000,      // 其余自定义段的建议起点
} as const
```

以及 `createCoreSections` 一并转发：想复用核心段并自行裁剪的宿主/插件（例如 07 提供"精简模式"）可以直接用它，不必 copy 文案。

### 2.3 不新增运行时错误类

`src/errors.ts` 已按"发生在哪一阶段"分类：`ConfigError`（boot 前）/ `BootError`（boot 中）/ `LlmError`（回合运行期）/ `SessionError`（会话 IO 期）。04 的失败只有两种，且都能复用既有通道：

- 同 id 重复注册 → 容器抛 `'prompt section ... already registered'` → 在 setup 内抛 → 组合根转 `BootError`（M0 语义，不改）。
- 实例配置非法（`disabled` 非数组 / 含非字符串 / 含未知 id）→ 抛 `TypeError`/`Error` → 同样转 `BootError`（与 03 的 `config.dir` 非法同式）。

prompt 拼装本身**没有运行期失败面**：段是同步纯函数，无 IO、无取消、无超时。因此本模块**不新增错误类**（Q6）。

### 2.4 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | **`builtin:prompt` 不 mount 实现，只注册 section**（与 03 的 `sessions.mount(store)` 不同） | `PromptRegistryImpl` 在 M0 已是最终实现（内核直接创建，非委托容器）。架构 §5.2 说 registry 型服务面"由 builtin 插件 register 填充"，prompt 正是 register 语义的字面落地；03 的 session 走 mount 是因为 M0 只有委托容器。**副作用**：未挂 `builtin:prompt` 时 `render()` 返回 `''` 而非抛 `'not mounted'`（Q9 确认，§5） |
| D2 | 容器 `render()` **跳过渲染结果为空串的段**（改 `containers.ts` 一行，不改签名） | 条件段（tool-use 在无工具时、08 在无 MEMORY 文件时）返回 `''`，不过滤会拼出连续 `\n\n\n`——空行本身无害但会随段数增长，且让"段是否生效"无法从输出判断。只过滤**严格空串**，不 trim（段作者的首尾空白属其排版意图）。待 Q4 拍板 |
| D3 | **段内容与插件分离**：`createCoreSections()` 是纯函数，事实经 getter 注入 | 与 03 D3 同式：段文案可脱离组合根单测（注入固定 `EnvFacts` 即可断言全文），插件退化为"接线薄层"（接 `process.*` / `ctx.config` / `ctx.tools`） |
| D4 | 禁用内置段走**构造选项 + 实例配置**，不引入 `unregister` | 契约没有移除口（架构 §10 已砍热卸载），加 `unregister` 是改基线。而"用户想换掉官方风格段"是真实需求：用 `disabled: ['core/guidelines']` + 自己注册同名 order 的段即可，无需内核支持替换 |
| D5 | 环境段与工具段**在 render 时求值**（getter 而非 setup 时快照） | `cwd`、时间、已注册工具数都会随会话推进变化（06 每 step 调 render）。若做成快照，长会话里模型看到的是启动时的环境；且快照会让"插件挂载顺序"变成语义的一部分（§4.3） |
| D6 | 导出 `PROMPT_ORDER` 常量表并预留 05/08 的 order 位 | order 是跨插件共享的排序资源；各模块各自写字面量必然漂移（02 X1 同理由）。`tools: 350` 是给 05 的**约定位**（05 的 DoD 需遵守），`memory: 900` 给 08 |
| D7 | tool-use 段**不列工具名**（只讲协议），工具名与 schema 归 05 的 `tools` 段 | 同一份真值不写两处：工具清单的权威来源是 `ctx.tools.list()`，由 05 直接投影。04 列名就等于第二份真值，工具动态增删（09 的 MCP 工具）时会不一致。04 只用"有没有工具"决定本段是否输出 |
| D8 | **不读项目指令文件 / MEMORY.md** | 架构 §10：记忆来自插件（08）。04 只交付"随产品发布的核心段"，项目级上下文归 08 |

## 3. 数据结构

```text
src/prompt/
├── types.ts         # EnvFacts / CoreSectionsOptions / PromptPluginConfig（模块内类型）
├── order.ts         # PROMPT_ORDER 常量表（跨模块排序约定，经 index.ts 转发）
├── sections/
│   ├── identity.ts      # 身份与定位（order 100）
│   ├── environment.ts   # 运行环境（order 200，动态）
│   ├── tool-use.ts      # 工具调用协议（order 300，条件段）
│   └── guidelines.ts    # 工作准则（order 800 起，见 Q1）
├── core.ts         # createCoreSections()：组装 + disabled 过滤 + 参数 narrow（纯函数）
├── plugin.ts       # createPromptPlugin / registerPromptBuiltin（薄接线层）
└── index.ts        # 模块出口（宿主侧）
```

> 段文件放 `sections/` 子目录：文案是本模块的主体（预计占 LOC 一半），平铺在 `src/prompt/` 会让"代码"与"文本"混排。统计口径按 process.md §6 的 `**` pattern 覆盖子目录。

### 3.1 四段文案草案（拍板后即为准；文案是交付物的一部分）

**`core/identity`（order 100）—— 恒定，不随环境变化**

```text
你是 MiniDSH，一个在用户终端里运行的 AI 编码助手。

- 你通过工具与用户协作完成工程任务：读文件、搜索代码、执行命令、改动代码。
- 你运行在用户的机器上，操作的是用户的真实项目目录，改动会真实生效。
- 你看不到本轮会话之外的内容；跨会话的记忆由 memory 插件提供，不要假设你记得过去的对话。
```

**`core/environment`（order 200）—— 动态，每次 render 重新取值**

```text
# 运行环境

- 工作目录：D:\MiniDSH
- 操作系统：win32 / x64
- 当前时间：2026-10-17 21:03:13（本地时区 Asia/Shanghai）
- 模型：deepseek/deepseek-chat
- 上下文窗口：131072 tokens

所有相对路径都按上面的工作目录解析。
```

时间格式化手写（`YYYY-MM-DD HH:mm:ss`，逐字段补零），时区用 `Intl.DateTimeFormat().resolvedOptions().timeZone`（内置，零依赖）。

**`core/tool-use`（order 300）—— 条件段，无工具时返回 `''`**

```text
# 工具使用

- 需要外部信息或要改变文件系统时使用工具，不要凭记忆猜测文件内容。
- 互不依赖的调用可以放在同一次回复里并行发出；有依赖关系的调用必须等前序结果。
- 参数必须是符合工具 schema 的合法 JSON。
- 工具会失败，也会被用户拒绝（permission denied）。读到错误就换参数或换路径，不要原样重试同一个失败调用。
- 工具返回的内容即事实：据此作答，不要在回复里大段复述原文。
```

**`core/guidelines`（order 800）—— 恒定**

```text
# 工作准则

- 先读后改：改动文件前先读取相关片段，确保改动基于真实内容。
- 最小改动：只做完成任务必需的修改，不顺手重构、不增删无关代码。
- 不确定就问：需求有歧义或影响面大时，先向用户确认再动手。
- 结论要有据：只说你验证过的内容；未验证的部分明确标注"未验证"。
- 回答简洁，使用中文（与用户语言保持一致）。
```

### 3.2 拼装结果形态

```text
你是 MiniDSH，…（identity）

# 运行环境
…（environment）

# 工具使用
…（tool-use）

# 工作准则
…（guidelines）
```

段间恰好一个 `\n\n`（容器分隔）；段内自身不含首尾空行（§4.4 约定），故连续空行只可能来自空段——由 D2 过滤掉。

## 4. 核心流程

### 4.1 插件 setup 时序

```text
createPromptPlugin(options) → setup(ctx, config?)
  disabled = [...(options?.disabled ?? []), ...narrowDisabled(config)]   # 实例配置 plugins[].config.disabled
  unknown = disabled.filter(id => !KNOWN_IDS.has(id))
  if (unknown.length) throw Error(...)                                    # 死配置早暴露 → BootError
  sections = createCoreSections({
    env:      options?.env      ?? (() => defaultEnv(ctx)),               # 惰性：render 时才调用
    hasTools: options?.hasTools ?? (() => ctx.tools.list().length > 0),
    disabled,
  })
  for (const s of sections) ctx.prompt.section(s)                         # 同 id 重复 → 容器抛 → BootError

defaultEnv(ctx):
  cwd = safeCwd()                       # process.cwd() 抛错时返回 'unknown'（§5）
  platform = process.platform; arch = process.arch; now = new Date()
  model = `${ctx.config.model.provider}/${ctx.config.model.name}`
  contextWindow = ctx.config.contextWindow
```

- 插件名固定 `builtin:prompt`；`registerPromptBuiltin()` = `registerBuiltin('prompt', createPromptPlugin())`，返回退订句柄（与 02/03 同式）。
- **无 `dispose`**：插件不持有任何资源（段是闭包，随注册表生命周期）。`Plugin.dispose` 是可选的，不定义即合法；X5 的"容忍 setup 未完成"对本模块自动成立。
- `ctx` 只在**闭包内**被引用（getter 捕获），不落进 `EnvFacts` 快照——这样段内容对 ctx 的依赖是"每次取最新"，而非"setup 时刻"。

### 4.2 render 拼装（容器语义 + D2）

```text
render():
  sorted = [...sections].sort(order 升序 → 同 order 按 id 字典序)     # M0 既有语义
  parts  = sorted.map(s => s.render()).filter(t => t !== '')          # ← D2 新增：跳过空段
  return parts.join('\n\n')
```

- 排序键与分隔符**保持 M0 原样**，04 只加空段过滤（待 Q4）。
- 复杂度 O(n log n)，n = 段数（十量级），06 每 step 调一次是预期用法（契约 JSDoc 已注明"勿在热循环内高频调用"）。
- **段 render 抛错不吞**（M0 既定，Q6 确认）：prompt 是每 step 的必经路径，静默降级会让模型在无系统提示下继续跑。内置段自身不抛（唯一可能抛的 `process.cwd()` 已兜底）；注入的 getter 若抛错，责任在注入者。

### 4.3 惰性求值的必要性（挂载顺序无关）

```text
boot: plugins = [builtin:prompt, builtin:tools, builtin:agent-loop]
        │
        ├─ prompt.setup 注册段（此时 ctx.tools 还是空表）
        ├─ tools.setup   注册 6 个内置工具
        └─ 首个 step：render() → tool-use 段的 hasTools() 这时才调用 → true → 段输出
```

若 `hasTools` 在 setup 时求快照，则段内容取决于 `config.plugins` 里 prompt 与 tools 的**书写顺序**——一个看不见的耦合。同理 `cwd`（工具可能改变目录）与时间（长会话跨日）都应取当下值。

### 4.4 段文本约定（写给后续所有段作者）

1. 段内可用 markdown 式 `# 标题` 与 `- 列表`（模型友好，且 07 若要把系统提示打出来给人看也易读）。
2. 段**首尾不留空行**：分隔符由容器统一给，段自己带首尾空行会产生三连换行。
3. 段内**不含用户输入/不可信内容**（用户输入走 `ChatMessage`，不走 system）——防止指令注入借道系统提示。
4. 段应**幂等**：同一环境下多次 `render()` 除时间字段外结果一致（identity / guidelines 严格恒定）。

## 5. 边界情况与错误处理

| 情况 | 行为 |
|---|---|
| 未挂载 `builtin:prompt`（或注册表为空） | `render()` 返回 `''`，**不抛错**（D1：容器是最终实现，不是委托容器）。06 拿到空 system 是"模型无系统提示"，不是启动失败 —— 07 的默认 `plugins` 必须含 `builtin:prompt`（并入 07 DoD，与 PROGRESS 遗留表"默认 plugins 非空"呼应） |
| 同 id 重复注册（挂了两次 `builtin:prompt`） | 容器抛 `'prompt section '<id>' already registered'` → setup 内抛 → 组合根清理后抛 `BootError`（M0 语义） |
| 实例配置 `disabled` 非数组 / 含非字符串 | narrow 时抛错 → `BootError`（与 03 的 `config.dir` 非法同式） |
| 实例配置 `disabled` 含未知 id | **抛错**（死配置早暴露，与 01 X7"拒绝 permissions 空键"同式）。用户拼错段 id 时静默忽略 = 禁用不生效却无从察觉 |
| `process.cwd()` 抛错（目录被删除 / 权限） | `defaultEnv` 兜底为 `'unknown'`，不中断 render（模型少一条环境信息远好于整个回合失败） |
| `ctx.config.model.name` 缺失 | 01 的 `validate.ts` 已保证 `provider` / `name` 为非空字符串；仍按模板拼接，不做二次校验（信任上游不变式） |
| 无工具注册（`builtin:tools` 未挂） | tool-use 段返回 `''`，被 D2 过滤，render 结果中该段整体消失（不是留一个空标题） |
| 工具在会话中途动态注册（09 的 MCP 工具） | 下次 render 自动反映（惰性求值，§4.3） |
| 段 `render()` 抛错 | 上抛，不吞（M0 既定）。内置段不抛；注入 getter 抛错由注入者负责 |
| 插件未挂载但 06 每 step 调 render | 返回 `''`，无副作用；`LLMRequest.system` 为空串（02 对空 system 的处理不在 04 范围） |
| `render()` 在 dispose 后被调用 | 未定义；插件 dispose 后 `ctx` 不再使用（07 保证）。内核零策略，不加运行时防护 |
| 段数极多（插件注册上百段） | 已知限制：每次 render 全量排序 + 全量渲染，O(n log n)。`PROMPT_ORDER.plugin: 1000` 之后由插件自行协调；若成为瓶颈归 06 的缓存策略，04 不加脏标记缓存（YAGNI） |
| **resume 后"工作目录"显示哪个** | **显示 `process.cwd()`（当下进程目录）**，不是会话 header 里记录的 `cwd`（创建时的历史值）。本段末尾那句"所有相对路径都按上面的工作目录解析"因此是一条**跨模块承诺**：05 的工具路径解析基准必须同为 `process.cwd()`，否则这句话是假的（已登记为 05 的 DoD 待办） |
| **系统提示每 step 都变**（时间字段秒级） | **已知取舍，不改**：这让每个 step 的 system 都可能不同，会削弱 provider 侧前缀缓存命中（DeepSeek 的 context caching 按前缀匹配）。不改粗粒度的理由：模型需要真实时间才能处理"刚才/今天"这类相对表述，而 mini 版不统计缓存命中（02 非目标）。日后若要优化，最小改动是把时间行挪到最后一个段 |
| 文案含中文 | 全模块 UTF-8；`LLMRequest.system` 经 JSON 传输天然无损（02 已验证中文往返） |

## 6. 测试计划

### 6.1 单元测试（`src/prompt/**/*.test.ts`，与源码同目录）

**`order.test.ts`（2 例）**：常量表各键唯一且升序符合 §2.2 的区间约定；`tools: 350` 落在 `toolUse: 300` 与 `memory: 900` 之间（守住给 05 的约定位）。

**`sections/identity.test.ts`（2 例）**：非空且含身份关键句（"MiniDSH" / "终端"）；**幂等**——两次 `render()` 严格相等且不因注入的 env 变化而改变。

**`sections/environment.test.ts`（5 例）**：注入固定 `EnvFacts` 时输出**逐字可预测**（含 cwd / platform / arch / 时间 `YYYY-MM-DD HH:mm:ss` / 时区 / model / contextWindow / "相对路径"提示）；时间补零正确（单位数月/日/时）；`model` / `contextWindow` 缺省时对应行不出现；默认 env provider 的 `cwd` 等于 `process.cwd()`；**`process.cwd()` 抛错时兜底为 `'unknown'`**（注入抛错的 provider）。

**`sections/tool-use.test.ts`（3 例）**：`hasTools() === false` → `''`；`true` → 含"工具使用"标题与并行/失败/不重试等要点；**不列任何工具名**（D7，注入工具名集合后断言输出不含它们）。

**`sections/guidelines.test.ts`（2 例）**：非空；含五条准则的关键短语（先读后改 / 最小改动 / 不确定就问 / 结论要有据 / 中文）。

**`core.test.ts`（4 例）**：默认返回四段且 `id` / `order` 与 `PROMPT_ORDER` 一致（顺序按 order 升序）；`disabled` 过滤生效（禁两段则只剩两段）；`disabled` 含未知 id → 抛错且**错误信息里带该 id**；段文本均**无首尾空行**（§4.4 约定 2，逐段 `trim()` 后与原文相等）。

**`plugin.test.ts`（7 例）**：插件名固定 `builtin:prompt`；setup 向伪 `ctx.prompt.section` 注册四段（断言 id 集合）；实例配置 `plugins[].config.disabled` 生效（与构造选项合并）；实例配置非法（非对象 / `disabled` 非字符串数组）→ setup 抛错；`disabled` 含未知 id → 抛错；**`env` / `hasTools` 是惰性调用**——setup 后计数为 0，render 后才为 1；**默认接线**——env 取 `process.cwd()` 与 `ctx.config.model`、hasTools 随 `ctx.tools` 变化。

**容器回归（`src/plugin/containers.test.ts` +3 例，Q4 采纳）**：①注册一个空串段 + 两个正常段 → 结果中该段整体消失（无多余空行）；②**空白但非空的段 `'  '` 不被过滤**（守住"只过滤严格空串、不 trim"的边界）；③**段 `render()` 抛错时上抛不吞**（Q6 的守卫，此前无用例）。"无 section 时返回 `''`"一例 M0 已有，不重复。

**实绩 29 例**：order 2 / identity 2 / guidelines 2 / tool-use 4 / environment 8 / core 4 / plugin 7。

### 6.2 集成测试（`tests/integration/prompt.test.ts`，真实组合根）

1. **挂载链路**：`registerPromptBuiltin()` → `boot({plugins:[{source:'builtin:prompt'}]})` → 收到 `plugin/mounted`；`ctx.prompt.render()` 含四个标题且顺序为 identity → environment → guidelines（按 `indexOf` 断言相对位置）。
2. **可扩展链路**：另挂一个 toy 插件注册 `order: PROMPT_ORDER.plugin` 的段 → render 结果中它**排在最后**，且与前一段之间恰好 `\n\n`（验证插件可在不改 04 的前提下扩展系统提示）。
3. **未挂载链路**：`boot` 的 plugins 不含 `builtin:prompt` → `ctx.prompt.render()` 返回 `''` 且**不抛错**（D1 的语义差异，与 session 的 `'not mounted'` 对照，是易被误解的点）。
4. **条件 + 惰性链路（核心）**：只挂 `builtin:prompt`（无工具）→ render **不含**"# 工具使用"；随后经 `ctx.tools.register(fakeDef)` 注册一个假工具 → **再次** render 含该段（证明 getter 惰性求值，挂载顺序无关，§4.3）。
5. **禁用链路**：`boot` 带实例配置 `{ source:'builtin:prompt', config:{ disabled:['core/guidelines'] } }` → render 不含准则段，其余三段仍在（D4 的替换路径可用）。

无需 fixture 目录（本模块零 IO），`contexts` 在 afterEach 统一 shutdown、builtin 注册统一退订（与 03 集成测试同式）。

## 7. 验收标准（DoD）

- [x] 本文档状态 **Reviewed**，且 §8 的 Q1–Q10 已由所有者拍板（2026-10-17 全部按建议项）
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（**276 例** = 03 交付时的 239 + 04 单测 29 + 容器回归 3 + 04 集成 5）
- [x] 公共导出均有中文 JSDoc（用途/参数/返回值/副作用/错误行为）：`createCoreSections` / `createPromptPlugin` / `registerPromptBuiltin` / `PROMPT_ORDER` / `CORE_SECTION_IDS` 五项齐备
- [x] §6.1 单元测试点全部有对应用例且通过（`src/prompt/` 六个测试文件，**29 例**，分布见 §6.1 末）
- [x] §6.2 集成测试五条链路全部通过（`tests/integration/prompt.test.ts`，**5 例 / 5 链路**）
- [x] `src/prompt/` LOC **491 行**（预算 ~0.5k，在区间 400–600 内；分项见下；含评审期 Y1 修复的 +2 行）
- [x] **零运行时依赖**：`package.json` 的 `dependencies` 仍为空（时间格式化与时区用内置 `Date` / `Intl`）
- [x] 未改动 `contracts.ts` 中**任何**骨架签名（`PromptSection` / `PromptRegistry` / `Ctx.prompt` 原样）
- [x] Q4 采纳后，`src/plugin/containers.ts` 的改动仅限 `render()` 内的空段过滤（不改签名、不改排序语义），并补 3 例回归
- [x] `PROMPT_ORDER.tools`（350）已写入本文档，供 **05** 的 DoD 遵守（工具 schema 段用该 order）
- [x] `docs/PROGRESS.md` 已更新（04 步骤、LOC 实绩、05-tools 的下一步动作）
- [x] 所有者已 review 代码（自检 + 复核两轮：读码 + 共 15 例临时探针实证，探针跑完即删不入库；自检**未发现 P0/P1**，复核坐实并修复 **Y1**（P3，实例配置拒数组），4 项误报结论逐项重测全部维持）

**LOC 实绩**：`src/prompt/` **491 行** —— plugin 106 / environment 95 / core 70 / types 51 / tool-use 45 / guidelines 36 / identity 37 / index 23 / order 28。文案（四段文本 + 其 JSDoc）约占一半，逻辑集中在 `core.ts`（组装 + `disabled` 校验）与 `environment.ts`（时间格式化 + `safeCwd` 兜底）。

**预算说明**：架构 §4 给 04 的 ~0.5k 与本次范围吻合（**与 02/03 不同，本模块不显著低于预算**）：M0 已把 registry 与拼装语义做掉，04 剩下的就是"文案 + 接线"，而文案是实体内容、压不掉。相对设计初稿 ~390 行的估算多出的约 100 行，主要来自三处：①`plugin.ts` 的配置 narrow 与两段注释（为何惰性、为何不 dispose）；②`environment.ts` 的 `safeCwd` / 时区兜底与其注释；③各段 JSDoc 里的"为什么"（为何不列工具名、为何准则放最后）。

### 偏离记录（实现期，编号 X）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | `PromptPluginOptions` 用 **type 别名**而非设计里的 `interface … extends CoreSectionsOptions {}` | 空接口会被 lint 的 `@typescript-eslint/no-empty-object-type` 拦（recommended 已启用）。语义完全等价：它就是 `CoreSectionsOptions` 的同形别名 |
| X2 | `PROMPT_ORDER` 增 **`guidelines: 800`**（设计 §2.2 的常量表漏列） | 段定义（`order.ts` 与 `createGuidelinesSection`）必须同源：若不进常量表，05/08 挑 order 时会误以为 800 是空位而占用，与准则段撞号 |
| X3 | `process.cwd()` 的兜底抽出为 **`safeCwd(read?)` 可注入** | 设计 §5 要求"cwd 读取失败兜底为 unknown"，但"目录被删"这条边界在单测里无法确定性复现（不能真删自己的 cwd）。做成可注入的纯函数后，用例直接喂一个抛错函数即可 |
| X4 | 容器回归补 **3 例**（而非设计的 2 例） | 除空段过滤外，另补两例守卫：①**空白但非空的段不被过滤**（守住"只过滤严格空串、不 trim"）；②**段 render 抛错时上抛不吞**（Q6 的决议此前无任何用例守卫，属真空） |

### 偏离记录（评审期，编号 Y）

| # | 偏离 | 理由 |
|---|---|---|
| Y1 | `narrowDisabled` 拒收**数组形态**的实例配置（`typeof [] === 'object'`，原校验会放行） | 复核评审探针实证：配置误写成 `config: ['core/guidelines']` 时 `disabled` 取不到、**整个配置被静默忽略**，四段全部照常注册——与本模块"死配置早暴露"（Q5/01 X7 同式）的立场直接相悖。修法为 `Array.isArray` 一并抛 `'must be an object'`，并在既有非法配置用例中补一条断言（用例总数不变，276 例全绿）。**注**：03 的 `session/plugin.ts` 配置 narrow 是同式写法、有同样的洞，但 03 已归档 Baseline 不回改，登记 PROGRESS 遗留表 |

### 评审排除的误报（探针实证，记录以免后续重复怀疑）

评审采用 02/03 确立的方式：读码 + 临时探针实证（自检 1 轮 7 例；**2026-10-17 复核评审再加 1 轮 8 例**，跑完即删不入库）。自检**未发现 P0/P1**；复核坐实 1 个 P3（即上方 Y1，配置数组被静默忽略），另证伪"invalid Date 渲染 NaN"（生产 `new Date()` 不会 invalid，非真实输入面）。复核对下表四项误报结论逐项重测，**全部维持原结论**（A 实测 5000 次 render 351.7ms ≈ 0.07ms/次；B 错误信息含段 id 可读；C 注入不同 `now` 输出立即分化，证明惰性生效；D 默认路径无 `\n\n\n`、tool-use 段整体消失、无 model 行）。

| 怀疑 | 结论 |
|---|---|
| `localTimeZone()` 每次 render 都构造 `Intl.DateTimeFormat()`，长会话会有性能问题 | **不成立**：探针 A 实测 5000 次全量 render + join 共 **336ms**（约 0.067ms/次）。06 每 step 调一次，开销不可测 |
| 同一 config 里挂两次 `builtin:prompt` 会得到难以定位的错误 | **不成立**：探针 D 实测为可读的 BootError —— `boot failed at 'builtin:prompt' … prompt section 'core/identity' already registered`，且 `mounted` 名单正确。无需额外处理 |
| 两次 render 结果相等说明动态段失效 | **不成立**：探针 E 的两次调用落在同一秒内（秒级精度），非逻辑问题；集成链路 4 已用"注册工具前后"证明惰性生效 |
| 默认路径（不传 env / hasTools）会拼出连续空行 | **不成立**：探针 C 实测 tool-use 段整体消失且无 `\n\n\n`；默认 env 无 `model`，对应行不渲染（符合"纯函数层拿不到 ctx"的设计） |

## 8. 决策点记录

> **2026-10-17 所有者拍板：Q1–Q10 全部按建议项通过。**

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 内置段集合 | **四段**：`core/identity`(100) / `core/environment`(200) / `core/tool-use`(300) / `core/guidelines`(800)。理由：覆盖"我是谁 / 我在哪 / 怎么用工具 / 怎么做事"四项最小必要；再拆（如独立 safety 段）对 mini 版属过度设计 |
| Q2 | environment 段是 render 时求值还是 setup 时快照 | **render 时求值**（D5）。长会话跨日、工具改目录都属正常；快照还会让段内容依赖 `plugins` 书写顺序 |
| Q3 | 是否导出 `PROMPT_ORDER` 常量表 | **导出**（经 `src/index.ts`）。order 是跨插件共享的排序资源，各模块写字面量必然漂移；05 用 350、08 用 900 写进约定 |
| Q4 | 容器 `render()` 是否跳过空串段 | **是**（改 M0 实现一行，不改签名）。条件段（无工具的 tool-use、无 MEMORY 的 memory 段）返回 `''`，不过滤会随段数堆积连续空行，且无法从输出判断段是否生效。**只过滤严格空串，不 trim** |
| Q5 | 是否支持禁用内置段 | **支持最小形态**：构造选项 + 实例配置 `disabled: string[]`，未知 id **抛错**（死配置早暴露）。不加 `unregister`（无热卸载，属改基线） |
| Q6 | 段 `render()` 抛错的行为；是否新增错误类 | **不吞错、上抛**（M0 既定）；**不新增错误类**——04 无运行期失败面（同步纯函数、无 IO），两类配置/注册错误都走既有 `BootError` 通道 |
| Q7 | tool-use 段是否列出当前已注册工具名 | **不列**（D7）。工具清单的权威来源是 `ctx.tools.list()`，由 05 投影为 `tools` 段；04 列名等于第二份真值，09 的 MCP 工具动态增删时会不一致。04 只用"有没有工具"决定是否输出本段 |
| Q8 | 是否内置读取项目指令文件（如 `minidsh.md` / `MEMORY.md`） | **不做**（D8，归 08）。架构 §10：记忆来自插件。04 只交付随产品发布的通用段 |
| Q9 | 未挂 `builtin:prompt` 时 `render()` 的语义 | **返回 `''`，不抛错**（D1：容器是最终实现而非委托容器）。同时写入 **07 的 DoD**：默认 `plugins` 必须含 `builtin:prompt`（与 PROGRESS 遗留表"默认 plugins 非空"合并） |
| Q10 | 段文案语言 | **中文**（项目"能用中文一律用中文"约定；且主要用户场景是中文）。工具名、路径、命令、字段名保持英文原样 |

### 附：本模块与 05 / 06 / 08 的职责边界

- **05**：以 `order: PROMPT_ORDER.tools`（350）注册一个段，内容为已注册工具的 `{name, description, schema}` 投影——**工具清单只有这一个真值出口**；04 不列名。
- **06**：每 step 调 `ctx.prompt.render()` 填 `LLMRequest.system`；压缩/裁剪策略归 06，04 不参与 token 预算。
- **08**：以 `order: PROMPT_ORDER.memory`（900）注册 MEMORY.md 内容段；无记忆文件时返回 `''`（被 D4/Q4 的空段过滤自然处理）。
- **07**：默认 `plugins` 含 `builtin:prompt`；若提供"精简模式"可直接用 `createCoreSections({disabled})` 组装自己的段集。
