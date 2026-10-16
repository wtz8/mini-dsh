# AGENT.md

> **新会话入口**：任何接手 MiniDSH 开发的新对话，**第一步先读本文件**，再按 §1 交接协议定位当前进度。
> 本文件是流程索引，不是设计文档——设计内容一律以 `docs/` 下的文档为准。

## 0. 项目一句话

MiniDSH 是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（~46 万行 TS）的架构级迷你复刻：约 1 万行 TypeScript 重写其 agent 骨架，只保留四条灵魂（everything is a plugin / model-visible means logged / guarded tool pipeline / LLM adapter seam），放弃全部产品化工程。零运行时依赖。

本仓库 `mini-dsh/` 是**独立 git 仓库**（`mini-dsh/.git`，上级 `MiniDSH/` 不是仓库），所有 git 操作都在 `mini-dsh/` 内执行。

## 1. 会话交接协议（重要：每个模块一个新对话）

### 开场必做（接手时）

1. 读本文件（`mini-dsh/AGENT.md`）。
2. 读 `docs/PROGRESS.md` —— 进度跟踪的唯一事实源：当前焦点模块、该模块处于流程哪一步、未决问题、下一步动作。
3. 读当前模块的**设计文档**（`docs/design/<NN>-<module>.md`）+ 相关基线契约（`docs/architecture.md` §5）。
4. 确认设计文档状态为 `Reviewed` 才动工；状态不是 Reviewed → 先回到流程第 2 步。

### 收尾必做（交接前）

1. 更新 `docs/PROGRESS.md`：模块当前步骤打勾、LOC 实绩、新发现的问题写进"遗留与阻塞"。
2. 在 PROGRESS.md 顶部"**下一步动作**"写清楚下个会话要做的第一件事（一句话 + 涉及文件）。
3. 未提交的改动保留在工作区，**不自动 commit**——commit 只在流程第 7 步、用户明确同意后执行。
4. 若实现偏离设计文档，必须在设计文档"验收标准"下补记偏离说明，不能只留在对话里。

### 硬规则

- **一次只推进一个模块**，不跨模块散改；一个模块对应一个 package（目录）。
- 交接信息写进 `docs/PROGRESS.md`，**不依赖对话历史**——新对话看不到上一个对话的任何内容。

## 2. 完整开发流程

```text
① 需求        →  ② 设计文档  →  ③ 一个 package  →  ④ 单元测试
                                                        ↓
                                             ⑤ 集成测试  →  ⑥ Review  →  ⑦ Git commit
```

| 步骤 | 产物 | 门禁（不通过不得进入下一步） |
|---|---|---|
| ① 需求 | 需求澄清：目标、范围、与哪条契约相关 | 需求已落到模块粒度，无歧义 |
| ② 设计文档 | `docs/design/<NN>-<module>.md`（Draft）→ 所有者 review → `Reviewed` | 模板七节齐全；契约签名与架构 §5 一致；差异点已列明 |
| ③ 一个 package | `src/<module>/`（01–07）或 `plugins/<name>/`（08–09）内的实现代码 | `pnpm typecheck` 通过；公共导出有中文 JSDoc；契约签名不得与基线冲突 |
| ④ 单元测试 | `*.test.ts`（与源码同目录，vitest） | `pnpm test` 通过；覆盖设计文档 §6 列出的全部单测点 |
| ⑤ 集成测试 | `tests/integration/*.test.ts`（跨模块真实链路，可含临时文件/伪 adapter） | 通过；验证模块经组合根挂载后的真实行为，非 mock 内部 |
| ⑥ Review | 所有者 review 代码 | 逐条对照设计文档 §7 DoD；LOC 预算偏差已说明 |
| ⑦ Git commit | 一次提交 = 一个模块的完整产物 | conventional commits；提交前展示变更摘要，用户确认后才执行 |

模块顺序（即 `docs/design/` 编号，也是 `architecture.md` §4 依赖顺序）：
`00-skeleton`（M0）→ `01-config` → `02-llm` → `03-session` → `04-prompt` → `05-tools` → `06-agent` → `07-cli` → `08-plugin-memory` → `09-plugin-mcp`。

## 3. 文档索引

| 文档 | 职责 |
|---|---|
| `AGENT.md`（本文件） | 流程索引 + 交接协议，新对话必读 |
| `docs/PROGRESS.md` | 进度跟踪唯一事实源（模块状态、LOC、阻塞、下一步） |
| `docs/architecture.md` | 骨架设计，**基线文档，改动需重新 review** |
| `docs/process.md` | 开发流程规范、模板、DoD |
| `docs/design/<NN>-<module>.md` | 单模块设计（实现前编写，实现后归档为该模块权威说明） |

## 4. 硬性约束

1. **文档先行**：无 Reviewed 状态的设计文档，不得写实现代码。
2. **骨架契约不可擅改**：`architecture.md` §5 的类型签名，改动 = 改基线文档并重新 review。
3. **零运行时依赖**：`dependencies` 必须为空，SSE 解析 / JSON Schema 校验 / MCP 客户端全部手写。
4. **预算纪律**：模块 LOC 有预算（`architecture.md` §4），偏差超 ±20% 须在设计文档说明理由；产品代码硬上限 20k 行，测试不计入。
5. **中文优先**：文档与代码注释用中文；标识符、命令、字段名、commit message 保持英文。
6. **注释是大厂标准**：公共导出必有 JSDoc（用途/参数/返回值/副作用/错误行为），非显然逻辑有行内注释——review 时一并检查。
7. **一次一个模块**，一个 commit 对应一个模块或一个逻辑单元。
8. **不自动提交**：用户未明确要求，绝不 `git add` / `commit` / `push`；改动留在工作区。
9. **测试分层**：单测同目录 `*.test.ts`，集成测试 `tests/integration/`，二者都进 DoD。
10. **错误不是异常**：工具/pipeline 的错误一律作为结果产出（架构 §5.4），不要靠抛异常传语义。

## 5. 常用命令

```bash
cd mini-dsh
pnpm install          # 依赖只在开发期
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint flat config
pnpm test             # vitest run（单测 + 集成测试）
# LOC 统计（模块级，排除测试）
git ls-files 'src/<module>/**/*.ts' 'plugins/<name>/**/*.ts' | grep -v '\.test\.ts$' | xargs wc -l
```

## 6. 当前进度

见 `docs/PROGRESS.md`（每次交接必更新）。
