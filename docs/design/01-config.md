# 01-config 设计

> 状态：**Baseline**（2026-10-16 所有者拍板 §8 的 Q1–Q7，全部按建议项决议；实现完成、首轮 review 修复完毕，X4 复核采纳后定稿）
> 预算：~0.4k 行（320–480 区间，±20%）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §2.3 的 Config 形状与 deepFreeze 归属）、architecture.md 0.1.3（§5.4 权限匹配规则 Q6、§5.5 启动序列、§7 目录布局、§8 配置形态）

## 1. 背景与目标

`Config` 是骨架级词汇：模型接入面、工具并发与超时、压缩阈值、权限策略、插件表——全部模块的运行参数都来自它。M0 把 `Config` 的类型定在 `contracts.ts`，但**没有实现加载**：冒烟测试用的是硬编码最小 config。架构 §5.5 已定 `loadConfig()` 的三层来源（全局 `~/.minidsh/config.json` → 项目 `minidsh.json` → flags），本模块交付它的实现。

对应骨架契约：

- architecture.md §5.5：`mdsh [flags] → loadConfig() → boot(config)`，config **不属于插件系统**，由宿主在 `boot()` **之前**调用，不以插件形式挂载。
- architecture.md §5.4 权限匹配规则（Q6）：精确键 > `前缀*` 通配键 > 兜底 `ask`，裸 `*` 视为配置错误。**解析归 01、匹配归 05**——01 交付可独立调用的匹配函数，05 在 pre-execute 里调用它。
- `00-skeleton.md` §2.3 / R4：`logLevel` 默认 `'info'` 的**默认值合并且仅归 01**；`deepFreeze` 归属恒定为 `boot()`，01 **只加载与合并、不冻结**。

目标（一句话）：把"三层来源 + 默认值 + 校验 + 权限解析"收敛成 `src/config/` 一个 package，让 07 CLI 只需 `await loadConfig({ flags })` 就能拿到可直接喂给 `boot()` 的 `Config`。

**非目标**（明确不做，避免范围膨胀）：

- 不做 argv/flags 的解析（07 CLI 的 `--model` / `--verbose` 等开关解析归 07），01 只定义 flags 的**入参形状与合并规则**。
- 不做环境变量插值（`${VAR}` 展开）、不做 YAML、不做 `.minidshrc` 等别名——配置格式 JSON 是 Q2 决议。
- 不做配置文件的 watch / 热重载（架构 §10 明确砍掉原版 HMR）。
- 不做 JSON Schema 导出与自动文档；校验器手写、零依赖。
- 不读取 `apiKeyEnv` 指向的环境变量值（见 §5 边界表）。

## 2. 对外契约

模块落在 `src/config/`，宿主（07 CLI）与集成测试经 `src/config/index.ts` 出口 import，不深引用内部文件。

```ts
/** 配置覆盖层：三层来源（全局/项目/flags）与默认值合并的输入形态，全部字段可选 */
export interface ConfigOverride {
  model?: Partial<ModelConfig>
  contextWindow?: number
  tools?: { maxParallel?: number; bash?: Partial<Config['tools']['bash']> }
  compaction?: Partial<Config['compaction']>
  permissions?: Record<string, PermissionAction>
  plugins?: PluginEntry[]
  logLevel?: Config['logLevel']
}

/** loadConfig 入参；缺省值见各字段注释，测试可注入临时目录 */
export interface LoadConfigOptions {
  /** 全局配置**目录**（其下 config.json）；默认 `path.join(os.homedir(), '.minidsh')` */
  globalDir?: string
  /** 项目配置**目录**（其下 minidsh.json）；默认 `process.cwd()` */
  projectDir?: string
  /** 最高优先级覆盖层（07 CLI 传入）；`undefined` 字段不参与合并 */
  flags?: ConfigOverride
}

/**
 * 加载配置：读三层 JSON → 深合并（数组替换）→ 补默认值 → 校验。
 * @returns 未冻结的 Config（冻结归属恒定为 boot()，见 00-skeleton §2.3）
 * @throws ConfigError 任一层 JSON 非法 / 合并结果校验失败
 */
export function loadConfig(opts?: LoadConfigOptions): Promise<Config>

/** 生成一份全新的默认配置（每次调用返回独立对象，不共享可变引用） */
export function createDefaultConfig(): Config

/** 合并 override 到 base（纯函数，不改入参）；对象递归深合并，数组与非对象整值替换 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown> | undefined): T

/** 校验并收窄为 Config；未知字段忽略（待拍板 Q1） */
export function validateConfig(raw: unknown): Config

/**
 * 权限策略匹配（架构 §5.4 Q6 规则）：精确键 → 前缀通配键（最长前缀优先）→ 兜底 'ask'。
 * 01 解析配置并保证入参合法（裸 '*' 在校验期已被拒）；05 在 pre-execute 调用本函数。
 */
export function resolvePermission(
  permissions: Readonly<Record<string, PermissionAction>>,
  toolName: string,
): PermissionAction
```

**出口分两类**（X6）：`loadConfig` / `createDefaultConfig` 是宿主侧能力，只经
`src/config/index.ts`；`resolvePermission` 是**插件侧**能力（05 要用），额外经
`src/index.ts` 转发——否则 05 只能深引用内部路径，违反 M0 的 X6 约定。

**新增运行时错误类** `ConfigError extends Error`，落点 `src/errors.ts`（与 `ToolRejected` / `BootError` 同处，错误类集中一处），经 `src/index.ts` 转发；携带 `path?: string`（出错的配置字段路径，如 `config.tools.maxParallel`）与 `file?: string`（出错的配置文件路径）。07 CLI 捕获它打印诊断并以退出码 1 退出。

### 2.1 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | 默认 `plugins` 为**空数组**，而非 architecture §8 示例中的 builtin 列表 | 01 交付时 `builtin:llm` / `builtin:session` 等尚未注册（02–06 才交付），非空默认会让 `boot()` 因 builtin 未命中直接失败。默认列表待 07 交付时补齐（见 §8-Q2 与遗留表） |
| D2 | 项目配置**不向上递归查找**，只在 `projectDir` 下找 `minidsh.json` | mini 版无 workspace/monorepo 概念，07 CLI 的启动目录即工作目录；向上查找要定义"项目根"判定（package.json / .git），属产品化工程（架构 §10 砍点） |
| D3 | 校验只在**三层合并后的最终对象**上执行一次，而非逐层校验 | 校验器只需处理"字段齐全"的形态，逻辑与错误信息都更简单；代价是错误信息不带来源层（只给字段路径），诊断由 07 的 `--verbose` 另行打印来源（见遗留表） |
| D4 | 新增 `ConfigError` 运行时错误类，落 `src/errors.ts` | M0 已确立"错误类集中一处"；01 的错误需被 07 区分捕获（打印字段路径 + 退出码 1），普通 `Error` 无法承载 `path`/`file` |
| D5 | `createDefaultConfig()` 是**工厂**而非导出常量 | 默认值对象若是模块级常量，boot 内的 `deepFreeze` 会把它冻结，进程内第二次 `loadConfig`/`boot`（测试与重挂载场景）会拿到已冻结的共享对象；工厂每次返回新对象，消除跨调用污染 |

> D2/D3/D5 均为实现形态的澄清，不触碰任何骨架签名；D1 是对 §8 示例的默认取值调整，请 owner 在 §8-Q2 拍板。

## 3. 数据结构

```text
src/config/
├── defaults.ts       # createDefaultConfig()（工厂，见 D5）
├── merge.ts          # deepMerge（纯函数；数组替换；__proto__ 防护）
├── validate.ts       # validateConfig（手写校验器，产出带路径的 ConfigError）
├── permissions.ts    # resolvePermission（Q6 三级匹配）
├── load.ts           # loadConfig（读文件 → 合并 → 校验）
└── index.ts          # 模块出口（宿主与集成测试的 import 面）
```

**三层来源与优先级**（后者覆盖前者）：

| 层 | 路径 | 缺省 | 缺失时 |
|---|---|---|---|
| 1 全局 | `<globalDir>/config.json` | `~/.minidsh/config.json` | 文件不存在 → 跳过（ENOENT 静默） |
| 2 项目 | `<projectDir>/minidsh.json` | `<cwd>/minidsh.json` | 同上 |
| 3 flags | 调用方传入的 `ConfigOverride` | 无 | 不参与合并 |

**默认值**（缺字段或该层未提供时的兜底）：

```ts
{
  model: { provider: 'deepseek', name: 'deepseek-chat',
           baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  contextWindow: 131072,
  tools: { maxParallel: 4, bash: { shell: 'auto', timeoutMs: 120_000 } },
  compaction: { thresholdRatio: 0.8, keepTurns: 4 },
  permissions: {},                 // 空表 → 全部走兜底 'ask'
  plugins: [],                     // D1
  logLevel: 'info',                // R4：默认值合并归 01
}
```

**合并规则**（`deepMerge`）：

1. 遍历 override 的**自有可枚举**键；值为 `undefined` → 跳过（flags 未设置的字段不覆盖下层）。
2. base 与 override 两侧同为"纯对象"（`typeof === 'object'`、非 `null`、非数组）→ 递归合并。
3. 其余情况一律**整值替换**：数组整体替换（`plugins` 不做拼接）、原始值替换、`null` 替换（`null` 在校验期报错，见 §5）。
4. `__proto__` 键直接丢弃（原型污染防护：`JSON.parse` 会产出该自有键，直接赋值会触发 setter）。
5. 纯函数：不修改 base / override 任一入参（合并结果基于 base 的浅拷贝构造）。

## 4. 核心流程

### 4.1 loadConfig() 时序

```text
loadConfig(opts)
 1. 解析目录：globalDir = opts.globalDir ?? path.join(os.homedir(), '.minidsh')
              projectDir = opts.projectDir ?? process.cwd()
 2. 读两层文件（串行 await fs.readFile，UTF-8）：
      ENOENT                → 该层视为未提供（返回 undefined）
      其它 IO 错误（EACCES/EISDIR…） → ConfigError{ file }
      JSON.parse 失败       → ConfigError{ file, 语法错误信息 }
      JSON 顶层不是纯对象   → ConfigError{ file }（数组/字符串/null 均非法）
 3. base = createDefaultConfig()                     # 全新对象，D5
 4. merged = deepMerge(base, global) → deepMerge(_, project) → deepMerge(_, flags)
 5. config = validateConfig(merged)                  # 唯一一次校验（D3）
 6. return config                                    # 不冻结（归属 boot，00-skeleton §2.3）
```

步骤 2 的两层读取互不依赖，但保持串行以固定错误优先级：全局层先读先报错（用户更可能先写错全局配置）。

### 4.2 validateConfig() 校验表

按字段逐项校验，任一项失败即抛 `ConfigError{ path }`，**fail-fast**（首个错误即抛出，不聚合）。

| 字段 | 校验 |
|---|---|
| `model.provider` / `name` / `apiKeyEnv` | 非空字符串 |
| `model.baseUrl` | 非空字符串（不校验 URL 合法性——手写 URL 解析超出预算，02 建连时会自然失败） |
| `contextWindow` | > 0 的整数 |
| `tools.maxParallel` | ≥ 1 的整数 |
| `tools.bash.shell` | `'auto'` / `'bash'` / `'powershell'` 枚举 |
| `tools.bash.timeoutMs` | > 0 的整数 |
| `compaction.thresholdRatio` | `0 < x ≤ 1` 的数字 |
| `compaction.keepTurns` | ≥ 0 的整数 |
| `permissions` | 纯对象；键为非空字符串（空键与纯空白键报错，X7），值必须是 `'auto'` / `'ask'` / `'deny'` 三值之一；**裸 `"*"` 键视为配置错误**（Q6） |
| `plugins` | 数组；每项为纯对象且 `source` 为非空字符串；`config` 若存在则**不校验**（任意形态，插件自行 narrow） |
| `logLevel` | 缺省补 `'info'`（X6：实现原先返回 `undefined`，与本节不符，已修正）；显式给出时须为 `'debug'` / `'info'` / `'warn'` / `'error'` |
| 字符串字段 | 判空前先 `trim`，并**返回 trim 后的值**（X8：`" deepseek "` 归一化为 `"deepseek"`，不带空白透传给 02） |
| 未知字段 | 忽略（待拍板 Q1） |

> **Config 增字段的同步义务**：`validateConfig` 是**白名单重建**（只返回已知字段），
> 因此后续模块给 `Config` 增字段时，必须同时改 `createDefaultConfig()` 与
> `validate.ts`，否则新字段被静默丢弃、降级为默认值且无诊断。`validate.test.ts` 的
> "默认配置通过校验，且字段被完整保留"即此守卫——漏改 `validate.ts` 会立刻红。

### 4.3 resolvePermission() 匹配

```text
resolvePermission(permissions, toolName)
 1. Object.prototype.hasOwnProperty.call(permissions, toolName) → 直接返回该值   # 精确键优先
 2. 遍历键：键形如 `前缀*`（以 '*' 结尾且长度 > 1）且 toolName.startsWith(前缀)
      → 取**前缀最长**的命中者（严格大于，故同长时取声明序在前者）
 3. 未命中 → 返回 'ask'                                                          # 兜底
```

- **为什么是"最长前缀"而非"声明序"**（X4，架构 §5.4 规则 2 的修订）：`permissions`
  是三层**逐键深合并**的产物，合并后键序由"哪一层先被合并"决定（全局层键恒排在项目层
  之前），与用户在任一文件里看到的书写顺序都不一致。按声明序取首个命中会让全局层的
  宽泛规则（`mcp__*`）永久压住项目层更严格的规则（`mcp__github*`）——**权限收紧静默
  失效且无诊断**。判"最长前缀"后语义退化为"更具体的规则总是赢"，且不依赖不可见键序。
- 两个长度相同的前缀若能同时匹配同一工具名，则它们必是同一前缀（即同一键），故"同长
  取声明序在前者"实际不可达，仅作为实现上的确定性兜底。
- 通配键只支持 `前缀*` 形式，不做完整 glob（Q6）；其它含 `*` 的键（如 `a*b`）在校验期按普通精确键放过，永远不会被通配命中——视为用户手误，不额外报错（保持校验器简单）。
- 裸 `"*"` 已在校验期拒绝，故步骤 2 不会退化成"匹配一切"。
- 无法"跨层删除"某个权限键：深合并只覆盖不删除，项目层要撤销全局层的授权只能显式改写同名键（`null` 会在校验期报错）。收紧某子族时用更长的 `前缀*` 键即可（X4 后生效）。
- `permissions` 是冻结后的对象（经 boot 注入 `ctx.config`），读取安全；函数本身不做防御性拷贝。

## 5. 边界情况与错误处理

| 情况 | 行为 |
|---|---|
| 全局/项目文件不存在（ENOENT） | 静默跳过该层，不报错（首次启动、单文件配置均属正常） |
| 文件带 UTF-8 BOM（Windows 记事本保存） | **剥离 BOM 后正常解析**（X5）。`JSON.parse` 本身不认 BOM，不剥离会让记事本编辑过的配置直接启动失败，且报错是 `Unexpected token 'ï»¿'` |
| 文件存在但 IO 失败（权限、是目录） | `ConfigError{ file }`（不降级为"跳过"——静默丢配置比启动失败更难排查） |
| 文件内容不是合法 JSON（含空文件） | `ConfigError{ file }`，message 带 `JSON.parse` 的原始错误 |
| JSON 顶层是数组 / 字符串 / `null` | `ConfigError{ file }` |
| 字段类型不符、取值越界、枚举非法 | `ConfigError{ path }`，fail-fast |
| `permissions` 出现裸 `"*"` 键 | `ConfigError{ path: 'config.permissions.*' }`（Q6：视为配置错误，启动失败） |
| `permissions` 值不是三值之一 | `ConfigError{ path: 'config.permissions.<键>' }` |
| 未知字段 | 忽略（待拍板 Q1）；`__proto__` 键额外丢弃（原型污染防护） |
| 值显式为 `null` | 合并阶段保留 → 校验期按"类型不符"报错（不静默当缺省） |
| flags 字段为 `undefined` | 不参与合并（不覆盖下层）；这是 flags 层"未设置"的唯一表达方式 |
| `plugins` 在三层都给了 | 整值替换，不拼接（数组合并语义不清，D3 一致的取舍） |
| `apiKeyEnv` 指向的环境变量不存在 | **01 不校验**——01 不知道本次运行是否真的要发请求；由 02 的 adapter 取用时抛错（fail-fast 落在使用点） |
| `loadConfig()` 返回值被修改 | 允许——返回值**未冻结**，冻结由 `boot()` 内的 `deepFreeze` 负责（00-skeleton §2.3） |
| 同进程内多次 `loadConfig()` | 每次独立：`createDefaultConfig()` 返回新对象（D5），不存在跨调用污染 |
| `loadConfig` 抛错后进程状态 | 无副作用（未创建任何资源、未调用 boot）；07 捕获后打印 `path` / `file` 并退出码 1 |

## 6. 测试计划

### 6.1 单元测试（`src/config/*.test.ts`，与源码同目录）

**merge.test.ts**：对象递归深合并；数组整值替换（不拼接）；`undefined` 不覆盖；两侧同为对象才递归（否则替换）；`null` 覆盖后保留；`__proto__` 键被丢弃（且不污染 `Object.prototype`）；纯函数性（入参对象在调用后内容不变）。

**defaults.test.ts**：`createDefaultConfig()` 返回完整 `Config`（含 `logLevel: 'info'`）；**两次调用返回不同对象**（D5 的回归测试）；修改返回值不影响后续调用。

**validate.test.ts**：合法配置通过并返回原对象；逐项非法值各一例（`model.*` 空串 / `contextWindow` 非正整数 / `maxParallel` < 1 / `shell` 非法枚举 / `timeoutMs` ≤ 0 / `thresholdRatio` 越界 / `keepTurns` 负 / `permissions` 值非法 / 裸 `"*"` / `plugins` 非数组 / `plugins[]` 缺 `source` / `logLevel` 非法）；`ConfigError` 携带正确 `path`；`plugins[].config` 任意形态均通过；未知字段被忽略且不影响结果。

**permissions.test.ts**：精确键命中；前缀通配命中（`mcp__*` 匹配 `mcp__github`）；**精确键优先于**通配键；多个通配键按声明序取首个；全部未命中兜底 `'ask'`；空表兜底 `'ask'`；`deny` / `auto` 值正确返回；前缀不匹配（大小写、`mcp__` vs `mcp`）。

**load.test.ts**：三层优先级（flags > project > global > defaults）；缺文件层被跳过；JSON 语法错误 → `ConfigError{ file }`；顶层非对象 → `ConfigError`；IO 错误（用目录路径模拟 EISDIR）→ `ConfigError`；返回值**未被冻结**（`Object.isFrozen` 为 false，冻结归属回归测试）；`opts.globalDir` / `opts.projectDir` 可注入临时目录；flags 的 `undefined` 字段不覆盖下层。

### 6.2 集成测试（`tests/integration/config.test.ts`）

以**真实文件系统 + 真实组合根**驱动（不 mock `fs` 与内核）：

1. **三层合并链路**：`os.mkdtemp` 建临时全局目录与项目目录，分别写 `config.json` / `minidsh.json`（各覆盖不同字段）+ 传入 flags → `loadConfig()` → `boot(config)`（plugins 留空或挂 fixture toy 插件）→ 断言 `ctx.config` 的合并结果与三层优先级一致；断言 `ctx.config` **已被冻结**（改写抛 `TypeError`，含 `plugins[].config`）→ `shutdown(ctx)`。
2. **logLevel 端到端链路**（R4 的落点验证）：临时配置写 `logLevel: 'debug'` → loadConfig → boot → spy `process.stderr`，`ctx.log.debug(...)` **有输出**；另一例不配 `logLevel`，断言 `ctx.log.debug(...)` **被过滤**、而 `info` 有输出——验证 01 的默认值与合并真的喂到了 M0 的 Logger，而非只停留在配置对象里。
3. **权限策略链路**：临时配置写 `permissions`（含精确键 + `前缀*` 通配键 + `deny`）→ loadConfig → 对 `ctx.config.permissions` 调用 `resolvePermission`，断言三值语义与 Q6 优先级；再断言**裸 `"*"` 配置让 `loadConfig` 抛 `ConfigError` 且 `boot` 未被调用**（启动前失败）。
4. **配置错误 → 启动失败链路**：临时目录写非法 JSON → `loadConfig` 抛 `ConfigError` 并带 `file`；断言此时未创建任何 Ctx（无 `boot` 调用、无插件挂载），07 的"启动失败"路径在此之前的输入即可复现。

临时目录与文件在 `afterEach` 中清理；不使用网络与外部进程。fixture 探针插件放在 `tests/integration/config-fixtures/`（**与 M0 的 `fixtures/` 分开**，理由见 §7-X3：后者在 `afterAll` 整目录删除，vitest 并行执行会互相踩踏）。

## 7. 验收标准（DoD）

- [x] 本文档状态 Reviewed，实现未偏离（差异仅限 §2.1 D1–D5 且已获同意；实现期与 review 期偏离见下方"偏离记录" X1–X8，均不触碰契约签名）
  - ✅ **X4 是唯一触及架构语义的条目**（权限通配由"声明序"改"最长前缀"），已同步修订 `architecture.md` §5.4 规则 2；**2026-10-16 所有者复核采纳，架构文档版本 0.1.3 → 0.1.4**，该修订不再是待办；其余 X1–X3、X5–X8 均为实现/文档澄清
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（**114 例** = M0 的 49 + 01 单测 58 + 01 集成 8；review 修复后 +6）
- [x] 公共导出均有中文 JSDoc（用途/参数/返回值/副作用/错误行为）；`loadConfig` / `resolvePermission` / `createDefaultConfig` / `deepMerge` / `validateConfig` / `ConfigError` 六项齐备
- [x] §6.1 单元测试点全部有对应用例且通过（`src/config/` 五个测试文件，**58 例**：merge 8 / defaults 6 / validate 18 / permissions 10 / load 15）
- [x] §6.2 集成测试点全部有对应用例且通过（`tests/integration/config.test.ts`，**8 例 / 4 条链路**）
- [x] LOC ≤ ~0.4k ±20%（`git ls-files 'src/config/**/*.ts' 'src/config/*.ts' | grep -v '\.test\.ts$' | xargs wc -l`）——**实绩 420 行**（区间 320–480，review 修复 +32）：defaults 31 / merge 45 / validate 150 / permissions 50 / load 85 / types 39 / index 20。**不含** `src/errors.ts` 中 `ConfigError` 的 30 行增量（属 M0 文件，单独计）。注：统计当日文件尚未入库，`git ls-files` 不列未跟踪文件，实际按目录内文件统计
- [x] `loadConfig()` 返回值未被冻结（冻结归属 boot 的回归断言在位：单测 load + 集成链路 1 的 `frozen` / `frozenInstance`）
- [x] `docs/PROGRESS.md` 已更新（01 步骤打勾、LOC 实绩、02-llm 的下一步动作）
- [x] 所有者已 review 代码（X4 复核采纳）
- [x] 设计文档状态更新为 Baseline，并按 process.md §5 提交（`feat(config): three-layer config loading, validation and permission resolution`）

### 偏离记录（实现时补记，2026-10-16；均不改任何契约签名）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | `validateConfig` 在遍历 `permissions` 时同样跳过 `__proto__` 键（与 `deepMerge` 的防护一致） | `deepMerge` 的丢弃只发生在合并阶段；校验器是独立导出的公共函数，可被直接喂入 `JSON.parse` 的产物（`Object.keys` 会列出该自有键），若不拦截，"构造结果对象时赋值"这一步本身就会污染原型 |
| X2 | `ConfigOverride` 声明为 `type` 别名而非 `interface` | TS 的隐式索引签名**只给对象类型字面量**（type alias），不给 interface；`deepMerge` 的形参是 `Record<string, unknown>`，用 interface 会以 "Index signature for type 'string' is missing" 编译失败。此为语言机制约束，非设计变更 |
| X3 | 集成测试的 fixture 目录用 **`tests/integration/config-fixtures/`**，与 M0 的 `tests/integration/fixtures/` 分开 | 后者在 `afterAll` 里整目录 `fs.rm`；vitest 并行执行多个测试文件时，共用目录会让两者互相删除对方的 fixture（真实竞态） |
| X4 | 通配权限取**最长前缀**命中者，而非架构 §5.4 原决议的"按声明序取首个命中" | `permissions` 是三层逐键深合并的产物，键序由"哪一层先被合并"决定（全局层键恒排在项目层之前），与任一文件里的书写顺序都不一致。按声明序会让全局层的 `mcp__*` 永久压住项目层的 `mcp__github*` —— **权限收紧静默失效**。已同步修订 `architecture.md` §5.4 规则 2（**基线改动，2026-10-16 所有者复核采纳，版本 0.1.4**） |
| X5 | `readJsonFile` 读文件后剥离 UTF-8 BOM 再 `JSON.parse` | Windows 记事本保存 UTF-8 会写前导 `U+FEFF`，`JSON.parse` 报 `Unexpected token 'ï»¿'`——用户无从理解。一行剥离即可，不增加预算 |
| X6 | `resolvePermission` 额外经 `src/index.ts` 转发（其余导出仍是宿主侧，不经该出口） | 它是**插件侧**能力：05 要在 pre-execute 调用。不放进 `src/index.ts` 的话，05 只能深引用 `src/config/permissions.js`，违反 M0 X6"内置模块不深引用内部路径" |
| X7 | `validateConfig` 拒绝 `permissions` 的**空键与纯空白键**（path `config.permissions.<empty>`） | 设计 §4.2 本就要求"键为非空字符串"，实现漏了。空键永远不会被任何工具名命中（工具名非空）也不会被前缀命中，是纯死配置——静默放过比启动失败更难排查 |
| X8 | `requireString` 返回 **trim 后**的值（原实现只用它判空、原样返回） | `" deepseek "` 这类手写意外若原样透传，02 会拿带空格的模型名去建连，失败点离配置太远。判空与归一化应同源 |

## 8. 决策点记录（2026-10-16 所有者拍板，全部按建议项决议）

| # | 问题 | 决议 |
|---|---|---|
| Q1 | 配置中出现**未知字段** | **忽略**。01 无 logger 可 warn；`Config` 是骨架级词汇、后续模块可增补字段，严格报错会让"升级后旧配置启动不了"。`__proto__` 键额外丢弃（原型污染防护） |
| Q2 | 默认 `plugins` 是否预置 builtin 列表 | **空数组**（D1）。01 阶段 builtin 表为空，预置会让 `boot()` 直接失败；`builtin:llm`/`session`/`prompt`/`tools`/`agent-loop` 的默认列表待 02–06 就位后由 **07** 补齐 |
| Q3 | 项目配置是否向上递归查找 `minidsh.json` | **否**（D2）。无 workspace 概念，07 CLI 的启动目录即项目根 |
| Q4 | `ConfigError` 落点 | **`src/errors.ts`**（D4），与 `ToolRejected` / `BootError` 同处，经 `src/index.ts` 转发 |
| Q5 | 校验时机 | **合并后一次**（D3）。错误信息只给字段路径，诊断时的"三层来源"打印归 07 的 `--verbose` |
| Q6 | `baseUrl` 是否校验 URL 合法性 | **不校验**。手写 URL 解析超预算，02 建连时会自然失败 |
| Q7 | `plugins[].config` 是否校验 | **不校验**。任意形态，由插件在 setup 内自行 narrow（与 `00-skeleton` §2.3 一致） |

### 附：差异点（D）是怎么来的

骨架设计（`architecture.md` §5）**有意只定义到签名与规则层**——§5 开头明写"实现细节一律留给模块设计文档"。因此每个模块第一次落地时，必然会遇到一批"骨架没管、但代码必须定"的实现形态问题。`process.md` §4 模板为此专设了 §2"与骨架设计中契约草图的差异说明"一栏，要求把它们**显式摆到 review 桌上**，而不是悄悄写进代码。

本模块的五条按来源分三类：

| 来源 | 条目 | 说明 |
|---|---|---|
| **骨架留白 → 模块首次落地必须拍板** | D2 项目配置是否向上查找、D3 校验时机、D5 默认值工厂 vs 常量 | 骨架给了"三层来源"的规则，没给查找范围、校验时机与默认值对象的生命周期；这些都是纯实现形态 |
| **骨架示例与交付时序冲突** | D1 默认 `plugins` | 架构 §8 的 JSON 示例里带 builtin 列表，那是**成品形态**（07 交付后的样子）；01 当下 builtin 表为空（M0 明示），照抄会让 boot 直接失败 |
| **新需求碰到既有约定** | D4 `ConfigError` 落点 | M0 只定了 `ToolRejected`/`BootError`，01 是第一个非内核模块、要有自己的错误类型，落点无先例 |

需要注意与 M0 的区分：**D 是设计期主动申报的差异**（review 时拍板），**X 是实现期才发现的偏离**（实测撞到后回写文档，如 M0 的 X1–X7）。01 的 X 表在动工前保持空表，实现过程中撞到再补记。
