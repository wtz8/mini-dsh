# MiniDSH 开发进度跟踪

> **跨会话交接的唯一事实源**。每个模块一个新对话，新对话先读 `AGENT.md` 再读本文件。
> 收尾时必更新：步骤打勾、LOC 实绩、遗留与阻塞、顶部"下一步动作"。

## 下一步动作（下一个会话从这里开始）

**当前焦点：01-config 已全绿且 X4 复核通过，等待用户确认提交；提交后开 02-llm（新对话，先读 `AGENT.md` → 本文件 → `docs/design/01-config.md` + `architecture.md` §5 的 `LlmAdapter`/`StreamEvent`）**

- [x] M0 已提交：`8813692 feat(skeleton): plugin kernel, composition root and contracts`（25 文件 5032 行，文档 + 实现 + 测试一个 commit）；`00-skeleton.md` 状态已改 **Baseline**
- [x] **第二轮 review 的修复已提交**（`fix(skeleton): harden dispose contract and waterfall payload replacement`）：dispose 两条约定（contracts.ts JSDoc + 设计 §4.2/§5）、瀑布载荷只认对象、`BootError.mounted` 只读数组（X7）、测试整洁三处。门禁全绿（49 例 / 1157 行）
- [x] 01-config 新对话开场：读 `AGENT.md` → 本文件 → `docs/design/00-skeleton.md`（Baseline，重点 §2.3 Config 与 §4.1 的 deepFreeze 归属）→ 确认状态为 Reviewed 才动工
- [x] **01-config 设计文档已产出并拍板**：`docs/design/01-config.md`（**Reviewed**，七节齐全 + §8 决议表）。§8 的 Q1–Q7 已由 owner 全部按建议项决议（未知字段忽略 / 默认 plugins 空数组 / 不向上查找 / ConfigError 落 errors.ts / 合并后一次校验 / baseUrl 不校验 / plugins[].config 不校验）；§8 末尾附"D 是怎么来的"（骨架只签到签名层 + D 与 X 的区分）
- [x] **01 实现已完成**：`src/config/` 七文件（defaults / merge / validate / permissions / load / types / index）+ `src/errors.ts` 新增 `ConfigError`（经 `src/index.ts` 转发）；门禁全绿 —— typecheck / lint / **108 例**（M0 49 + 01 单测 52 + 01 集成 7）
- [x] **01 首轮 review 已完成并修复**（9 条：P0 权限收紧失效 / BOM；P1 resolvePermission 出口 / Config 增字段守卫；P2 logLevel 兜底 / 空权限键 / 注释矛盾 / 字符串归一化；另补 5 例测试）——门禁全绿 **114 例**（M0 49 + 01 单测 58 + 01 集成 7+1），`src/config/` 420 行仍在预算内
- [x] **owner 已复核并采纳 X4**（权限通配由"声明序"改"最长前缀"）：`architecture.md` §5.4 规则 2 的修订说明已去掉"待复核"字样，版本 **0.1.3 → 0.1.4**，§12 修订记录已登记；`01-config.md` §7 的 X4 行与 DoD 首条同步标记采纳
- [ ] **第一件事：提交 01-config** —— `feat(config): three-layer config loading, validation and permission resolution`（提交前展示变更摘要，用户确认后执行）。提交后把 `01-config.md` 状态改 Baseline
- [ ] 然后开 02-llm 新对话：读 `AGENT.md` → 本文件 → `docs/design/01-config.md`（Baseline）+ `architecture.md` §5（重点 `LlmAdapter` / `StreamEvent` / adapter 解析约定：resolve name = `config.model.provider`）
- [ ] 01 交付时注册 builtin 用 `registerBuiltin()`（经 `src/index.ts` 导出，返回退订句柄），不要深引用 `src/plugin/boot.ts`

**M0 交付实况（2026-10-16）**：typecheck / lint / test 全绿（45 单测 + 4 集成 = 49 例）；`src/` 实绩 **1157 行**（预算 ~1.2k ±20% 内）；关键文件 `src/contracts.ts`（492）、`src/plugin/boot.ts`（254）、`src/plugin/containers.ts`（166）、`src/plugin/event-bus.ts`（94）、`src/plugin/logger.ts`（56）、`src/plugin/ctx.ts`（42）、`src/errors.ts`（42）、`src/index.ts`（17）；工程脚手架（package.json / tsconfig / eslint.config.js / vitest.config.ts）一并就位。

**首轮 review 修复（2026-10-16，全部已回写设计文档）**：2 个真 bug + 6 项改进——①`factory()` 返回非插件时二次抛 TypeError 绕过清理 → 加形状校验；②`shutdown` 不幂等 → 清空挂载序；③`builtinPlugins` 裸 Map 改为 `registerBuiltin()` 出口（X6，内置模块不再深引用内部路径）；④setup 半失败者纳入逆序 dispose（X5，R3 补强）；⑤`logger.ts` 补 8 例单测（此前零覆盖）；⑥`formatMeta` 对 Error 输出 stack 而非 `{}`；⑦非法 logLevel 兜底 info；⑧瀑布 `null` 载荷与 ctx.ts JSDoc 更正、集成链路 4 改为验证公共 API 出口面。偏离记录 X5–X6 已补记 `00-skeleton.md` §7。

**第二轮 review 修复（2026-10-16，针对修复后新语义的派生义务）**：①插件 `dispose` 必须容忍 setup 未完成（X5 派生，写入 contracts.ts JSDoc 与设计 §4.2）；②`dispose` 不设超时、由 07 用 `Promise.race` 兜底（写入 §4.2 与本节遗留表）；③瀑布载荷只在返回值为对象时替换（X7，原判断会让 `false`/`0`/`''` 浇坏载荷）；④`BootError.mounted` 收窄为 `readonly string[]`（X7）；⑤`render()` 补 O(n log n) 调用提示；⑥测试整洁三处（补遗漏的 shutdown、fixture 路径改 `path.join`、去掉 stderr spy 的 `as never`）。偏离 X7 已补记 `00-skeleton.md` §7。

**01 交付实况（2026-10-16）**：门禁全绿（typecheck / lint / 108 例 = M0 49 + 01 单测 52 + 集成 7）；`src/config/` **388 行**（预算 ~0.4k，区间 320–480 内）——defaults 31 / merge 45 / validate 141 / permissions 36 / load 82 / types 39 / index 14；另在 `src/errors.ts` 增 `ConfigError` 30 行（单独计，属 M0 文件）。实现期偏离 **X1–X3** 已补记 `01-config.md` §7：X1 校验器也跳 `__proto__`（公共导出可被直接喂 JSON.parse 产物）、X2 `ConfigOverride` 用 type 别名（TS 隐式索引签名不给 interface）、X3 集成 fixture 目录独立（M0 的 `fixtures/` 在 afterAll 整目录删除，并行会互相踩踏）。另回写 `00-skeleton.md` §2.1 一行：errors.ts 自 01 起新增 ConfigError。

**01 首轮 review 修复（2026-10-16，攻击式评审后回写，门禁 114 例全绿）**：共 9 条，偏离 **X4–X8** 已补记 `01-config.md` §7（X1–X3 为实现期）。①**X4 权限通配改"最长前缀优先"**（P0，安全语义）：`permissions` 跨层逐键合并后键序由"哪层先合并"决定，按架构原决议的"声明序取首个命中"会让全局层 `mcp__*` 永久压住项目层 `mcp__github*` —— 权限收紧静默失效。**已同步修订 `architecture.md` §5.4 规则 2 并附修订说明，属基线改动待 owner 复核**。②**X5 剥离 UTF-8 BOM**：记事本保存的配置会让 `JSON.parse` 报 `Unexpected token 'ï»¿'`，Windows 上必踩。③**X6 `resolvePermission` 经 `src/index.ts` 转发**：它是插件侧能力（05 要用），否则 05 只能深引用内部路径。④**X7 拒绝 permissions 空键**（设计本就要求非空，实现漏了，空键是永不命中的死配置）。⑤**X8 `requireString` 返回 trim 后的值**（`' p '` 不该透传给 02）。⑥`logLevel` 缺省补 `'info'`（实现原返回 `undefined`，与 §4.2 不符）。⑦修正 `types.ts` 注释（permissions 是逐键合并，非整值替换）。⑧补 5 例测试：BOM、跨层 permissions 合并、空键、logLevel 兜底、字符串归一化，另加一条集成回归（跨层更具体规则生效）。⑨设计 §4.2 补"Config 增字段须同步 validate.ts"的同步义务，守卫是 `validate.test.ts` 的"默认配置通过校验且字段完整保留"（此例此前已存在，现补注释点明其守卫作用）。**已核查排除**：loadConfig 返回值与 flags 入参不共享子对象引用，此前担心的 deepFreeze 污染不成立。

## 模块进度总表

图例：`—` 未开始 / `·` 进行中 / `✓` 完成 / `✗` 阻塞

| # | 模块 | 需求 | 设计文档 | package | 单测 | 集成测试 | Review | Commit | 预算 | 实绩 |
|---|---|---|---|---|---|---|---|---|---:|---:|
| 00 | skeleton（M0） | ✓ | ✓ Baseline | ✓ 1157 行 | ✓ 45 例 | ✓ 4 链路 | ✓ | ✓ | ~1.2k | 1157 |
| 01 | config | ✓ | ✓ Reviewed（X4 已复核，提交后改 Baseline） | ✓ 420 行 | ✓ 58 例 | ✓ 8 例 / 4 链路 | ✓ | 待提交 | ~0.4k | 420 |
| 02 | llm | — | — | — | — | — | — | — | ~1.5k | — |
| 03 | session | — | — | — | — | — | — | — | ~1.5k | — |
| 04 | prompt | — | — | — | — | — | — | — | ~0.5k | — |
| 05 | tools | — | — | — | — | — | — | — | ~2.5k | — |
| 06 | agent | — | — | — | — | — | — | — | ~2.0k | — |
| 07 | cli | — | — | — | — | — | — | — | ~1.0k | — |
| 08 | plugin-memory | — | — | — | — | — | — | — | ~0.2k | — |
| 09 | plugin-mcp | — | — | — | — | — | — | — | ~0.7k | — |
| | **合计** | | | | | | | | **~11.5k** | **1577** |

（目标 ~10k，硬上限 20k；统计口径见 `process.md` §6，排除测试代码）

## 关键文档状态

| 文档 | 版本/状态 | 说明 |
|---|---|---|
| `docs/architecture.md` | **0.1.4** · Reviewed | 2026-10-16 所有者拍板 Q1–Q6，开放问题已全部关闭；01 review 提出的"权限通配改最长前缀优先"**已于 2026-10-16 复核采纳**，§5.4 规则 2 修订定稿、§12 已登记，不再有待复核项 |
| `docs/process.md` | Reviewed | 流程规范（含集成测试步骤与交接跟踪）；2026-10-16 文件头状态与 PROGRESS.md 统一为 Reviewed；M0 提交后修正 §6 的 LOC 统计口径（git pathspec 的 `**` 不匹配目录顶层文件，须并列单层 pattern，见下"口径陷阱"） |
| `docs/design/00-skeleton.md` | **Baseline** · 2026-10-16 | M0 设计；评审补齐 5 处硬缺口（事件类型表、import 路径解析、Ctx.sessions 声明类型、WeakMap 挂载序、错误类落点），R1–R4 拍板见 §8 决议表；二次评审补 4 处澄清（deepFreeze 归属恒定 boot、factory 失败路径、SessionEvent 变体集合对 03 封闭、重复 boot 未定义），见 §8 末段；**实现已完成（③④⑤ 全绿），偏离记录 X1–X6 已补记 §7**；首轮代码 review 的 2 个真 bug 与 6 项改进已修复并回写 §4.1/§4.2/§5/§6/§7，**待用户确认 commit 后改 Baseline** |
| `docs/design/01-config.md` | **Reviewed** · 2026-10-16 | 01 设计：三层合并（global `~/.minidsh/config.json` → project `minidsh.json` → flags）+ 默认值（含 R4 的 `logLevel: 'info'`）+ 手写校验 + `resolvePermission`（Q6 三级匹配）；**只加载不冻结**（deepFreeze 归属 boot）。差异 D1–D5 见 §2.1，§8 的 Q1–Q7 已按建议全部拍板；**实现已完成（③④⑤ 全绿，114 例），首轮 review 的 9 条修复已完成，偏离 X1–X8 已补记 §7；X4 已复核采纳，提交后改 Baseline** |

## 遗留与阻塞

| # | 事项 | 状态 | 归属 |
|---|---|---|---|
| R1 | `PermissionAction` 增加 `'deny'`（静默拒绝，不询问用户） | **已拍板** | M0 §8 → 01/05 按三值实现 |
| R2 | `Logger` 不加 `child(prefix)`，四方法够用 | **已拍板** | M0 §8 |
| R3 | boot 失败**执行**清理：逆序 dispose 已挂载插件 → abort → 抛 BootError | **已拍板** | M0 §4.1/§4.2 |
| R4 | `Config` 增加可选 `logLevel`（默认 'info'），默认值合并归 01 | **已拍板** | M0 §2.3 → 01 |
| — | M0 内置插件表为空表，`builtin:llm` 等随 02–06 模块注册进表 | 已定 | 各模块 |
| — | 默认 `plugins` 为 `[]`（01 §2.1 D1）：`builtin:llm`/`session`/`prompt`/`tools`/`agent-loop` 的默认列表待 02–06 就位后由 07 补齐 | **升级为阻塞项**：01 之后、07 补齐之前，任何 `loadConfig()+boot()` 都挂载 0 插件，CLI 起来却无 llm/session/tools，直到运行时 `resolve()` 抛 `'not mounted'` 才暴露，定位困难。07 的 DoD 必须包含"默认 plugins 非空" | 07 |
| — | 架构层未定义类型的留白已在 `00-skeleton.md` §2 补齐 | 已定 | M0 |

## 遗留与阻塞（补充）

| # | 事项 | 状态 | 归属 |
|---|---|---|---|
| — | LOC 统计口径陷阱：`git ls-files 'src/<m>/**/*.ts'` 漏计目录顶层文件（M0 实测漏 539 行） | **已修**（process.md §6 / 00-skeleton.md §7 已并列单层 pattern） | 01 起每个模块统计时按新命令执行 |
| — | **dispose 无超时**：单个挂起的 dispose 会让 `shutdown` 永不返回（实测确认） | **已定**（设计 §4.2 约定 2 / §5）：内核零策略，超时与强制退出由 07 的退出流程用 `Promise.race` 兜底 | 07 |
| — | **dispose 必须容忍 setup 未完成**：boot 失败清理会 dispose 半失败插件（X5），此时 setup 可能未跑完 | **已定**（设计 §4.2 约定 1 + `contracts.ts` 的 `Plugin.dispose` JSDoc）：资源访问一律用可选链 | 02–09 全体插件作者 |

## 约定备忘（跨会话不变）

- 仓库：`mini-dsh/` 为独立 git 仓库；上级 `MiniDSH/` 不是仓库。
- 未获用户明确要求，**绝不自动提交**；提交前展示变更摘要。
- 一次只推进一个模块；交接信息写本文件，不依赖对话历史。
- 实现偏离设计文档时，必须回写设计文档"验收标准"下，不能只留在对话里。
