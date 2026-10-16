# MiniDSH 开发进度跟踪

> **跨会话交接的唯一事实源**。每个模块一个新对话，新对话先读 `AGENT.md` 再读本文件。
> 收尾时必更新：步骤打勾、LOC 实绩、遗留与阻塞、顶部"下一步动作"。

## 下一步动作（下一个会话从这里开始）

**当前焦点：M0 已入库，开 01-config 新对话**

- [x] M0 已提交：`8813692 feat(skeleton): plugin kernel, composition root and contracts`（25 文件 5032 行，文档 + 实现 + 测试一个 commit）；`00-skeleton.md` 状态已改 **Baseline**
- [ ] 01-config 新对话开场：读 `AGENT.md` → 本文件 → `docs/design/00-skeleton.md`（Baseline，重点 §2.3 Config 与 §4.1 的 deepFreeze 归属）→ 确认状态为 Reviewed 才动工
- [ ] 01-config 第一件事：写 `docs/design/01-config.md`（Draft），内容含 `loadConfig()` 三层合并（全局 `~/.minidsh/config.json` → 项目 `minidsh.json` → flags）、默认值合并（含 `logLevel` 默认 `'info'`，R4）、**只加载不冻结**（deepFreeze 归属恒定为 boot，见 00-skeleton.md §2.3）
- [ ] 01 交付时注册 builtin 用 `registerBuiltin()`（经 `src/index.ts` 导出，返回退订句柄），不要深引用 `src/plugin/boot.ts`

**M0 交付实况（2026-10-16）**：typecheck / lint / test 全绿（44 单测 + 4 集成 = 48 例）；`src/` 实绩 **1133 行**（预算 ~1.2k ±20% 内）；关键文件 `src/contracts.ts`（480）、`src/plugin/boot.ts`（254）、`src/plugin/containers.ts`（161）、`src/plugin/event-bus.ts`（92）、`src/plugin/logger.ts`（56）、`src/plugin/ctx.ts`（42）、`src/errors.ts`（42）、`src/index.ts`（17）；工程脚手架（package.json / tsconfig / eslint.config.js / vitest.config.ts）一并就位。

**首轮 review 修复（2026-10-16，全部已回写设计文档）**：2 个真 bug + 6 项改进——①`factory()` 返回非插件时二次抛 TypeError 绕过清理 → 加形状校验；②`shutdown` 不幂等 → 清空挂载序；③`builtinPlugins` 裸 Map 改为 `registerBuiltin()` 出口（X6，内置模块不再深引用内部路径）；④setup 半失败者纳入逆序 dispose（X5，R3 补强）；⑤`logger.ts` 补 8 例单测（此前零覆盖）；⑥`formatMeta` 对 Error 输出 stack 而非 `{}`；⑦非法 logLevel 兜底 info；⑧瀑布 `null` 载荷与 ctx.ts JSDoc 更正、集成链路 4 改为验证公共 API 出口面。偏离记录 X5–X6 已补记 `00-skeleton.md` §7。

## 模块进度总表

图例：`—` 未开始 / `·` 进行中 / `✓` 完成 / `✗` 阻塞

| # | 模块 | 需求 | 设计文档 | package | 单测 | 集成测试 | Review | Commit | 预算 | 实绩 |
|---|---|---|---|---|---|---|---|---|---:|---:|
| 00 | skeleton（M0） | ✓ | ✓ Reviewed | ✓ 1133 行 | ✓ 44 例 | ✓ 4 链路 | ✓ | — | ~1.2k | 1133 |
| 01 | config | — | — | — | — | — | — | — | ~0.4k | — |
| 02 | llm | — | — | — | — | — | — | — | ~1.5k | — |
| 03 | session | — | — | — | — | — | — | — | ~1.5k | — |
| 04 | prompt | — | — | — | — | — | — | — | ~0.5k | — |
| 05 | tools | — | — | — | — | — | — | — | ~2.5k | — |
| 06 | agent | — | — | — | — | — | — | — | ~2.0k | — |
| 07 | cli | — | — | — | — | — | — | — | ~1.0k | — |
| 08 | plugin-memory | — | — | — | — | — | — | — | ~0.2k | — |
| 09 | plugin-mcp | — | — | — | — | — | — | — | ~0.7k | — |
| | **合计** | | | | | | | | **~11.5k** | **1133** |

（目标 ~10k，硬上限 20k；统计口径见 `process.md` §6，排除测试代码）

## 关键文档状态

| 文档 | 版本/状态 | 说明 |
|---|---|---|
| `docs/architecture.md` | 0.1.3 · Reviewed | 2026-10-16 所有者拍板 Q1–Q6，开放问题已全部关闭 |
| `docs/process.md` | Reviewed | 流程规范（含集成测试步骤与交接跟踪）；2026-10-16 文件头状态与 PROGRESS.md 统一为 Reviewed；M0 提交后修正 §6 的 LOC 统计口径（git pathspec 的 `**` 不匹配目录顶层文件，须并列单层 pattern，见下"口径陷阱"） |
| `docs/design/00-skeleton.md` | **Baseline** · 2026-10-16 | M0 设计；评审补齐 5 处硬缺口（事件类型表、import 路径解析、Ctx.sessions 声明类型、WeakMap 挂载序、错误类落点），R1–R4 拍板见 §8 决议表；二次评审补 4 处澄清（deepFreeze 归属恒定 boot、factory 失败路径、SessionEvent 变体集合对 03 封闭、重复 boot 未定义），见 §8 末段；**实现已完成（③④⑤ 全绿），偏离记录 X1–X6 已补记 §7**；首轮代码 review 的 2 个真 bug 与 6 项改进已修复并回写 §4.1/§4.2/§5/§6/§7，**待用户确认 commit 后改 Baseline** |

## 遗留与阻塞

| # | 事项 | 状态 | 归属 |
|---|---|---|---|
| R1 | `PermissionAction` 增加 `'deny'`（静默拒绝，不询问用户） | **已拍板** | M0 §8 → 01/05 按三值实现 |
| R2 | `Logger` 不加 `child(prefix)`，四方法够用 | **已拍板** | M0 §8 |
| R3 | boot 失败**执行**清理：逆序 dispose 已挂载插件 → abort → 抛 BootError | **已拍板** | M0 §4.1/§4.2 |
| R4 | `Config` 增加可选 `logLevel`（默认 'info'），默认值合并归 01 | **已拍板** | M0 §2.3 → 01 |
| — | M0 内置插件表为空表，`builtin:llm` 等随 02–06 模块注册进表 | 已定 | 各模块 |
| — | 架构层未定义类型的留白已在 `00-skeleton.md` §2 补齐 | 已定 | M0 |

## 遗留与阻塞（补充）

| # | 事项 | 状态 | 归属 |
|---|---|---|---|
| — | LOC 统计口径陷阱：`git ls-files 'src/<m>/**/*.ts'` 漏计目录顶层文件（M0 实测漏 539 行） | **已修**（process.md §6 / 00-skeleton.md §7 已并列单层 pattern） | 01 起每个模块统计时按新命令执行 |

## 约定备忘（跨会话不变）

- 仓库：`mini-dsh/` 为独立 git 仓库；上级 `MiniDSH/` 不是仓库。
- 未获用户明确要求，**绝不自动提交**；提交前展示变更摘要。
- 一次只推进一个模块；交接信息写本文件，不依赖对话历史。
- 实现偏离设计文档时，必须回写设计文档"验收标准"下，不能只留在对话里。
