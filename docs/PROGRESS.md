# MiniDSH 开发进度跟踪

> **跨会话交接的唯一事实源**。每个模块一个新对话，新对话先读 `AGENT.md` 再读本文件。
> 收尾时必更新：步骤打勾、LOC 实绩、遗留与阻塞、顶部"下一步动作"。

## 下一步动作（下一个会话从这里开始）

**当前焦点：04-prompt 已提交（2026-10-17），下一个模块是 05-tools（完全未开始，连设计文档都没有；预算 ~2.5k，是迄今最大的模块）**

- [ ] **第一件事：开 05-tools 新对话**——按 `AGENT.md` 交接协议读 `AGENT.md` → 本文件 → `04-prompt.md`（Baseline，重点 §2.2 的 `PROMPT_ORDER` 与文末"与 05/06/08 的职责边界"）→ `architecture.md` 0.1.5 §5（工具契约与 `ToolDefinition`）→ 产出 `docs/design/05-tools.md`（Draft）
- [ ] **05 必须承接的跨模块承诺（写进 05 设计文档与 DoD）**：
  - 工具 schema 以 `order: PROMPT_ORDER.tools`（**350**）注册一个 prompt 段，工具清单只有这一个真值出口（04 §7 附则）
  - **工具路径解析基准 = `process.cwd()`**：04 环境段写死"所有相对路径都按上面的工作目录解析"，05 不以它为基准这句话就是假的（04 §5 末行 / 本文件遗留表）
  - 消费 01 的 `resolvePermission`（工具执行的权限闸门）与 02 的 `createToolCallAccumulator`（均已就位，经 `src/index.ts` 出口）
- [ ] 05 的评审要留意 04 复核发现的同式漏洞写法：插件实例配置 narrow 必须拒数组（`Array.isArray`，见 `04-prompt.md` §7 Y1 与本文件遗留表）
- [x] **04 已提交**（2026-10-17）：`feat(prompt): core sections and builtin:prompt plugin`；含 `04-prompt.md` 归档 Baseline、`containers.ts` 空段过滤（Q4）、复核评审修复 Y1（P3，实例配置传数组被静默忽略）、门禁 **276 例**全绿、`src/prompt/` **491 行**

- [x] ~~review `docs/design/03-session.md`（七节 + §8 决议表）与 Q1 拍板~~ → **已完成**：2026-10-17 所有者按建议项拍板 Q1–Q10；基线 `architecture.md` **0.1.4 → 0.1.5**（`SessionStore` 新增 `read`），四处落点已同步
- [x] ~~03 实现~~ → **已完成**：`src/session/` 八文件 930 行 + `src/errors.ts` 增 `SessionError`（41 行）；`deriveMessages` 经 `src/index.ts` 转发
- [x] ~~03 单测 + 集成测试~~ → **已完成**：单测 58 例、集成 7 例 / 5 链路，门禁 **239 例**全绿
- [x] **03 已提交**（2026-10-17）：`feat(session): jsonl append-only store with log projection`；含 `03-session.md` 归档 Baseline、`architecture.md` 0.1.5、本文件计数订正（238→239 例、902→930 行，Y1 修复的增量此前漏记）
- [ ] 待办（跨模块，非 03 阻塞项）：`05-tools` 会消费 `resolvePermission` 与 `createToolCallAccumulator`（均已就位）；`06-agent` 会消费 `deriveMessages`（03 出口，**已就位**）；`07-cli` 的 DoD 必须包含"默认 `plugins` 非空"（见遗留表）

- [x] M0 已提交：`8813692 feat(skeleton): plugin kernel, composition root and contracts`（25 文件 5032 行，文档 + 实现 + 测试一个 commit）；`00-skeleton.md` 状态已改 **Baseline**
- [x] **第二轮 review 的修复已提交**（`fix(skeleton): harden dispose contract and waterfall payload replacement`）：dispose 两条约定（contracts.ts JSDoc + 设计 §4.2/§5）、瀑布载荷只认对象、`BootError.mounted` 只读数组（X7）、测试整洁三处。门禁全绿（49 例 / 1157 行）
- [x] 01-config 新对话开场：读 `AGENT.md` → 本文件 → `docs/design/00-skeleton.md`（Baseline，重点 §2.3 Config 与 §4.1 的 deepFreeze 归属）→ 确认状态为 Reviewed 才动工
- [x] **01-config 设计文档已产出并拍板**：`docs/design/01-config.md`（**Reviewed**，七节齐全 + §8 决议表）。§8 的 Q1–Q7 已由 owner 全部按建议项决议（未知字段忽略 / 默认 plugins 空数组 / 不向上查找 / ConfigError 落 errors.ts / 合并后一次校验 / baseUrl 不校验 / plugins[].config 不校验）；§8 末尾附"D 是怎么来的"（骨架只签到签名层 + D 与 X 的区分）
- [x] **01 实现已完成**：`src/config/` 七文件（defaults / merge / validate / permissions / load / types / index）+ `src/errors.ts` 新增 `ConfigError`（经 `src/index.ts` 转发）；门禁全绿 —— typecheck / lint / **108 例**（M0 49 + 01 单测 52 + 01 集成 7）
- [x] **01 首轮 review 已完成并修复**（9 条：P0 权限收紧失效 / BOM；P1 resolvePermission 出口 / Config 增字段守卫；P2 logLevel 兜底 / 空权限键 / 注释矛盾 / 字符串归一化；另补 5 例测试）——门禁全绿 **114 例**（M0 49 + 01 单测 58 + 01 集成 7+1），`src/config/` 420 行仍在预算内
- [x] **owner 已复核并采纳 X4**（权限通配由"声明序"改"最长前缀"）：`architecture.md` §5.4 规则 2 的修订说明已去掉"待复核"字样，版本 **0.1.3 → 0.1.4**，§12 修订记录已登记；`01-config.md` §7 的 X4 行与 DoD 首条同步标记采纳
- [x] **01-config 已提交**：`4e97e17 feat(config): three-layer config loading, validation and permission resolution`（19 文件 +1686/−10；含 01-config.md Baseline 定稿、architecture.md 0.1.4、`ConfigError` 与 `resolvePermission` 经 `src/index.ts` 转发）
- [x] ~~然后开 02-llm 新对话~~（移交下方"当前焦点"接管）
- [x] **02 review 已完成并修复**（2026-10-17，攻击式评审：3 轮探针共 19 例实证，**无 P0**）：发现 1 个 P1（`[DONE]` 哨兵不容错）+ 3 个 P2（flush 的 done 状态机不一致 / `data: null` 空闲帧中断流 / 请求构造错误误分类为 `network`），全部修复并补 **6 例**回归测试；另登记 U1（`finally` 中 await `reader.cancel()`，偏离设计伪代码但理由充分）与 P2-4（HTTP 错误体全量读入，属设计取舍，不改）
- [x] **02-llm 已提交**：`02-llm.md` 状态改 **Baseline**，偏离记录 Y1–Y4 与"评审排除的误报"表已回写 §7；门禁 **174 例**全绿，`src/llm/` **647 行**

**M0 交付实况（2026-10-16）**：typecheck / lint / test 全绿（45 单测 + 4 集成 = 49 例）；`src/` 实绩 **1157 行**（预算 ~1.2k ±20% 内）；关键文件 `src/contracts.ts`（492）、`src/plugin/boot.ts`（254）、`src/plugin/containers.ts`（166）、`src/plugin/event-bus.ts`（94）、`src/plugin/logger.ts`（56）、`src/plugin/ctx.ts`（42）、`src/errors.ts`（42）、`src/index.ts`（17）；工程脚手架（package.json / tsconfig / eslint.config.js / vitest.config.ts）一并就位。

**首轮 review 修复（2026-10-16，全部已回写设计文档）**：2 个真 bug + 6 项改进——①`factory()` 返回非插件时二次抛 TypeError 绕过清理 → 加形状校验；②`shutdown` 不幂等 → 清空挂载序；③`builtinPlugins` 裸 Map 改为 `registerBuiltin()` 出口（X6，内置模块不再深引用内部路径）；④setup 半失败者纳入逆序 dispose（X5，R3 补强）；⑤`logger.ts` 补 8 例单测（此前零覆盖）；⑥`formatMeta` 对 Error 输出 stack 而非 `{}`；⑦非法 logLevel 兜底 info；⑧瀑布 `null` 载荷与 ctx.ts JSDoc 更正、集成链路 4 改为验证公共 API 出口面。偏离记录 X5–X6 已补记 `00-skeleton.md` §7。

**第二轮 review 修复（2026-10-16，针对修复后新语义的派生义务）**：①插件 `dispose` 必须容忍 setup 未完成（X5 派生，写入 contracts.ts JSDoc 与设计 §4.2）；②`dispose` 不设超时、由 07 用 `Promise.race` 兜底（写入 §4.2 与本节遗留表）；③瀑布载荷只在返回值为对象时替换（X7，原判断会让 `false`/`0`/`''` 浇坏载荷）；④`BootError.mounted` 收窄为 `readonly string[]`（X7）；⑤`render()` 补 O(n log n) 调用提示；⑥测试整洁三处（补遗漏的 shutdown、fixture 路径改 `path.join`、去掉 stderr spy 的 `as never`）。偏离 X7 已补记 `00-skeleton.md` §7。

**01 交付实况（2026-10-16）**：门禁全绿（typecheck / lint / 108 例 = M0 49 + 01 单测 52 + 集成 7）；`src/config/` **388 行**（预算 ~0.4k，区间 320–480 内）——defaults 31 / merge 45 / validate 141 / permissions 36 / load 82 / types 39 / index 14；另在 `src/errors.ts` 增 `ConfigError` 30 行（单独计，属 M0 文件）。实现期偏离 **X1–X3** 已补记 `01-config.md` §7：X1 校验器也跳 `__proto__`（公共导出可被直接喂 JSON.parse 产物）、X2 `ConfigOverride` 用 type 别名（TS 隐式索引签名不给 interface）、X3 集成 fixture 目录独立（M0 的 `fixtures/` 在 afterAll 整目录删除，并行会互相踩踏）。另回写 `00-skeleton.md` §2.1 一行：errors.ts 自 01 起新增 ConfigError。

**01 首轮 review 修复（2026-10-16，攻击式评审后回写，门禁 114 例全绿）**：共 9 条，偏离 **X4–X8** 已补记 `01-config.md` §7（X1–X3 为实现期）。①**X4 权限通配改"最长前缀优先"**（P0，安全语义）：`permissions` 跨层逐键合并后键序由"哪层先合并"决定，按架构原决议的"声明序取首个命中"会让全局层 `mcp__*` 永久压住项目层 `mcp__github*` —— 权限收紧静默失效。**已同步修订 `architecture.md` §5.4 规则 2 并附修订说明，属基线改动待 owner 复核**。②**X5 剥离 UTF-8 BOM**：记事本保存的配置会让 `JSON.parse` 报 `Unexpected token 'ï»¿'`，Windows 上必踩。③**X6 `resolvePermission` 经 `src/index.ts` 转发**：它是插件侧能力（05 要用），否则 05 只能深引用内部路径。④**X7 拒绝 permissions 空键**（设计本就要求非空，实现漏了，空键是永不命中的死配置）。⑤**X8 `requireString` 返回 trim 后的值**（`' p '` 不该透传给 02）。⑥`logLevel` 缺省补 `'info'`（实现原返回 `undefined`，与 §4.2 不符）。⑦修正 `types.ts` 注释（permissions 是逐键合并，非整值替换）。⑧补 5 例测试：BOM、跨层 permissions 合并、空键、logLevel 兜底、字符串归一化，另加一条集成回归（跨层更具体规则生效）。⑨设计 §4.2 补"Config 增字段须同步 validate.ts"的同步义务，守卫是 `validate.test.ts` 的"默认配置通过校验且字段完整保留"（此例此前已存在，现补注释点明其守卫作用）。**已核查排除**：loadConfig 返回值与 flags 入参不共享子对象引用，此前担心的 deepFreeze 污染不成立。

**02 交付实况（2026-10-17）**：门禁全绿（typecheck / lint / **168 例** = 01 的 114 + 02 单测 49 + 02 集成 5）；`src/llm/` **628 行**（sse 110 / wire 174 / adapter 171 / accumulate 59 / plugin 58 / types 33 / index 23），另在 `src/errors.ts` 增 `LlmError` 约 48 行（属 M0 文件，单独计）——合计约 0.68k，低于 ~1.5k 预算（理由记入设计 §7 预算说明）。单测分布：sse 13 / wire 13 / adapter 13 / accumulate 6 / plugin 4；集成 4 链路 5 例（注册解析 / 流式+工具调用聚合 / 取消 / API key 缺失），**全程不打网络**（伪 fetch + 真实 `Response`/`ReadableStream` + 真实 boot）。实现期偏离 **X1–X3** 已补记 §7：X1 额外导出 `PROVIDER_DEEPSEEK`（避免 provider 名字面量在注册处与断言处漂移）；X2 `plugin.ts` 的 `registerBuiltin` 直接从 `../plugin/boot.js` 引入（绕 `src/index.ts` 会形成 index → llm → index 循环）；X3 取消路径**不断言** `reader.cancel()`（流已 errored 时 cancel 按规范是 no-op，连接由 fetch 的 signal 销毁），"关流"改由"提前 break"用例断言。另有一处实测修正：集成链路 1 的 `plugin/mounted` 名单含探针自身（`llm-probe`），与 M0 语义一致（监听器在 setup 内注册，会收到自身挂载广播），已在用例注释点明。

**基线修订 0.1.5（2026-10-17，03 的 Q1）**：`SessionStore` 新增 `read(id): Promise<SessionEvent[]>`——原契约只写不读，§6 要求的 `deriveMessages` 没有输入来源。四处落点已同步：`architecture.md` §5.2 + §12、`src/contracts.ts`、`src/plugin/containers.ts`（委托）、`src/plugin/containers.test.ts`（stubStore 补 `read` + 未挂载断言）；`00-skeleton.md` §2 已补记一行。纯新增方法，不改任何既有签名。

**03 交付实况（2026-10-17）**：门禁全绿（typecheck / lint / **239 例** = 02 的 174 + 03 单测 58 + 03 集成 7）；`src/session/` **930 行**（store 364 / jsonl 143 / plugin 112 / derive 95 / validate 92 / types 67 / ids 36 / index 21），另 `src/errors.ts` 增 `SessionError` 41 行（属 M0 文件，单独计）——合计约 0.97k，低于 ~1.5k 预算（超出初稿 0.73k 估算的约 200 行主要来自 store 的错误分类与 `validate.ts` 的七变体逐字段校验，理由记入设计 §7 预算说明）。单测分布：ids 4 / jsonl 10 / validate 5 / derive 12 / store 21 / plugin 6；集成 5 链路 7 例（挂载与容器 / 落盘+投影 / 事件广播 / **resume 跨实例恢复** / compaction），**全程真实 fs**（tmp 目录，fixture 目录 `tests/integration/session-fixtures/` 与 01/02 分开）。实现期偏离 **X1–X2** 已补记 §7：X1 `list()` 预读首行 8KB + 越界退化整读（D7 的"省 IO"落到实处）；X2 目录被重命名时 `meta.id` 以 header 为准（不以 corrupt 拒绝）。review 期修复 **Y1（P1）**：崩溃半行无行尾 `\n` 会把下一次 append 的事件并进坏行一起丢失（内存里有、磁盘上没有，resume 后消失）→ `appendLine` 写前补换行"封口"。另登记 5 项**探针证伪的误报**（并发 append 乱序、1MB 行性能、根目录散落文件、compaction 末事件、`read` 对象改写）。
实测 `src/` 全量非测试代码 **3294 行**（模块口径合计 3154，差额为 M0 顶层文件 `contracts.ts`/`errors.ts`/`index.ts` 自 03 起的增量）。

**04 交付实况（2026-10-17）**：门禁全绿（typecheck / lint / **276 例** = 03 的 239 + 04 单测 29 + 容器回归 3 + 04 集成 5）；`src/prompt/` **491 行**（plugin 106 / environment 95 / core 70 / types 51 / tool-use 45 / identity 37 / guidelines 36 / order 28 / index 23；Y1 修复 +2 行），预算 ~0.5k 的区间（400–600）内——与 02/03 不同，本模块**不显著低于预算**，因为文案是实体内容压不掉。单测分布：order 2 / identity 2 / guidelines 2 / tool-use 4 / environment 8 / core 4 / plugin 7；集成 5 链路 5 例（挂载与排序 / 可扩展 / **未挂载返回空串** / 条件+惰性 / 禁用），**零 IO 故无 fixture 目录**。实现期偏离 **X1–X4** 已补记 §7：X1 `PromptPluginOptions` 改 type 别名（lint 禁空接口）；X2 `PROMPT_ORDER` 补 `guidelines: 800`（设计常量表漏列，否则 05/08 会误占该 order）；X3 `safeCwd(read?)` 抽出可注入（"cwd 被删"无法在单测里真复现）；X4 容器回归补 3 例（多出的两例是"空白但非空不过滤"与"段抛错上抛不吞"）。自检评审（读码 + 1 轮 7 例探针）**未发现 P0/P1**，登记 4 项**探针证伪的误报**（render 性能 5000 次 336ms / 挂两次的错误形态可读 / 两次 render 相等是同秒巧合 / 默认路径无连续空行）。另在 `00-skeleton.md` §3 补记一行：`PromptRegistry.render()` 自 04 起**跳过空串段**（实现行为调整，非签名变更）。实测 `src/` 全量非测试代码 **3800 行**（模块口径合计 **3643** = 3154 + 489，差额 157 为 M0 顶层文件增量）。**复核评审（2026-10-17 晚，读码 + 1 轮 8 例探针）**：自检的 4 项误报结论逐项重测全部维持；坐实并修复 1 个 P3 —— **Y1**：实例配置误传数组（`typeof [] === 'object'`）时 `disabled` 被静默忽略，改为 `Array.isArray` 一并抛 `'must be an object'`（断言补进既有用例，门禁仍 **276 例**全绿）；证伪"invalid Date 渲染 NaN"（非真实输入面）。已回写 `04-prompt.md` §7。

**02 review 修复实况（2026-10-17，攻击式评审后回写，门禁 174 例全绿）**：评审方式为"读码 + 实证"——除逐行审查外，另写 3 轮共 **19 例临时探针**验证可疑点（探针跑完即删，不入库），**未发现 P0**。修复 **Y1–Y4**（编号 Y 区别于实现期的 X）：①**Y1（P1）`[DONE]` 哨兵不容错**——`parseBlock` 只剥离冒号后一个空格且比对前未 trim，`data: [DONE] `（尾随空格）与 `data:  [DONE]`（多空格，SSE 规范允许）都不被识别，落入 `JSON.parse` 抛 `protocol`，**而失败发生在流末、模型输出已产出、token 已消耗**，整个回合却被判失败；修复为比对前 trim。②**Y2（P2）`flush()` 路径的 `[DONE]` 不置 `#done`**——`#drain` 的 `final` 分支漏了置位，与 push 路径及类 JSDoc"其后一切输入都丢弃"矛盾。③**Y3（P2）非对象 SSE 帧中断整条流**——网关的 `data: null` 空闲帧被判"不是对象"而抛 `protocol`；容忍层放在 adapter 的 `frameEvents`（编排层），`toStreamEvents` 保持线格式映射的严格语义不变，故既有测试无需改动。④**Y4（P2）请求构造错误被误分类为 `network`**——`buildRequestBody` 在 `try` 内，契约外畸形请求的 `TypeError` 被包装成 `LlmError{kind:'network'}`，07 会把本地 bug 提示成"网络故障"；修复为把构造移到 `try` 之外。新增 **6 例**回归测试（sse 3 / adapter 3），单测分布更新为 sse 16 / wire 13 / adapter 16 / accumulate 6 / plugin 4；`src/llm/` 628 → **647 行**（增量全部来自容错分支与其注释）。另登记两项**不改**：**U1**（`finally` 中 `await reader.cancel()`，偏离设计 §4.1 伪代码的 `void ...`，但等待 cancel 完成使"提前 break"用例能确定性断言，理由充分）；**P2-4**（HTTP 错误体先 `await response.text()` 全量读入再截断 500，与设计 §4.1 伪代码一致，属设计取舍）。**评审排除的误报 4 项**（探针证伪，已记入设计 §7 以免后续重复怀疑）：消费者在 `for await` 体内抛错不会被 catch 误包装（错误原样冒泡）；SSE 无 O(n²) 性能问题（8000 帧 / 1.1MB 单 chunk 仅 4.7ms）；`data:   x` 保留多余空格符合 RFC 8895；`LlmError` 的 instanceof 正常（target/lib = ES2022）。

## 模块进度总表

图例：`—` 未开始 / `·` 进行中 / `✓` 完成 / `✗` 阻塞

| # | 模块 | 需求 | 设计文档 | package | 单测 | 集成测试 | Review | Commit | 预算 | 实绩 |
|---|---|---|---|---|---|---|---|---|---:|---:|
| 00 | skeleton（M0） | ✓ | ✓ Baseline | ✓ 1157 行 | ✓ 45 例 | ✓ 4 链路 | ✓ | ✓ | ~1.2k | 1157 |
| 01 | config | ✓ | ✓ Baseline | ✓ 420 行 | ✓ 58 例 | ✓ 8 例 / 4 链路 | ✓ | ✓ `4e97e17` | ~0.4k | 420 |
| 02 | llm | ✓ | ✓ Baseline | ✓ 647 行 | ✓ 55 例 | ✓ 5 例 / 4 链路 | ✓ | ✓ `871bd91` | ~1.5k | 647 |
| 03 | session | ✓ | ✓ Baseline | ✓ 930 行 | ✓ 58 例 | ✓ 7 例 / 5 链路 | ✓ | ✓ | ~1.5k | 930 |
| 04 | prompt | ✓ | ✓ Baseline | ✓ 491 行 | ✓ 29 例 | ✓ 5 例 / 5 链路 | ✓ | ✓ | ~0.5k | 491 |
| 05 | tools | — | — | — | — | — | — | — | ~2.5k | — |
| 06 | agent | — | — | — | — | — | — | — | ~2.0k | — |
| 07 | cli | — | — | — | — | — | — | — | ~1.0k | — |
| 08 | plugin-memory | — | — | — | — | — | — | — | ~0.2k | — |
| 09 | plugin-mcp | — | — | — | — | — | — | — | ~0.7k | — |
| | **合计** | | | | | | | | **~11.5k** | **3645** |

（目标 ~10k，硬上限 20k；统计口径见 `process.md` §6，排除测试代码）

## 关键文档状态

| 文档 | 版本/状态 | 说明 |
|---|---|---|
| `docs/architecture.md` | **0.1.5** · Reviewed | 2026-10-16 所有者拍板 Q1–Q6，开放问题已全部关闭；01 review 提出的"权限通配改最长前缀优先"**已于 2026-10-16 复核采纳**，§5.4 规则 2 修订定稿、§12 已登记，不再有待复核项。**2026-10-17 升 0.1.5**：§5.2 `SessionStore` 新增 `read(id)`（03 的 Q1 拍板，理由与影响面见 §12 的 0.1.5 行） |
| `docs/process.md` | Reviewed | 流程规范（含集成测试步骤与交接跟踪）；2026-10-16 文件头状态与 PROGRESS.md 统一为 Reviewed；M0 提交后修正 §6 的 LOC 统计口径（git pathspec 的 `**` 不匹配目录顶层文件，须并列单层 pattern，见下"口径陷阱"） |
| `docs/design/00-skeleton.md` | **Baseline** · 2026-10-16 | M0 设计；评审补齐 5 处硬缺口（事件类型表、import 路径解析、Ctx.sessions 声明类型、WeakMap 挂载序、错误类落点），R1–R4 拍板见 §8 决议表；二次评审补 4 处澄清（deepFreeze 归属恒定 boot、factory 失败路径、SessionEvent 变体集合对 03 封闭、重复 boot 未定义），见 §8 末段；**实现已完成（③④⑤ 全绿），偏离记录 X1–X6 已补记 §7**；首轮代码 review 的 2 个真 bug 与 6 项改进已修复并回写 §4.1/§4.2/§5/§6/§7，**待用户确认 commit 后改 Baseline** |
| `docs/design/01-config.md` | **Baseline** · 2026-10-16（`4e97e17`） | 01 设计：三层合并（global `~/.minidsh/config.json` → project `minidsh.json` → flags）+ 默认值（含 R4 的 `logLevel: 'info'`）+ 手写校验 + `resolvePermission`（精确键 > 最长前缀通配 > 兜底 `ask`）；**只加载不冻结**（deepFreeze 归属 boot）。差异 D1–D5 见 §2.1，偏离 X1–X8 已补记 §7；DoD 全部勾选，已随模块提交归档 |
| `docs/design/03-session.md` | **Baseline** · 2026-10-17 | 03 设计：`builtin:session` 插件 + JSONL append-only 存储（`src/session/` 八文件）+ `deriveMessages` 纯函数投影 + `SessionError`。要点：store 与插件分离（D3）、sessions 目录走 `plugins[].config` 不加 Config 字段（D4）、`list()` 只读首事件（D7）、投影裁剪残缺 toolCalls 与孤立 tool 结果（D8）、`subscribe` 未知 id 抛错（D9）。差异 D1–D9 见 §2.4；**§8 的 Q1–Q10 已于 2026-10-17 全部按建议项拍板**，Q1 的基线修订（0.1.5）已执行；**实现已完成（③④⑤ 全绿，239 例）**，实现期偏离 X1–X2、review 期修复 Y1（P1）与"评审排除的误报"表已回写 §7；**已于 2026-10-17 随模块提交归档为 Baseline** |
| `docs/design/04-prompt.md` | **Baseline** · 2026-10-17 | 04 设计：`builtin:prompt` 内容插件 + `src/prompt/` 九文件。要点：**容器在 M0 已是最终实现，04 只注册段不 mount**（D1，未挂时 `render()` 返回 `''` 而非 `'not mounted'`）、四段（identity 100 / environment 200 动态 / tool-use 300 条件 / guidelines 800）、段内容与插件分离（`createCoreSections` 纯函数 + getter 注入，D3/D5）、导出 `PROMPT_ORDER` 常量表并给 05 预留 `tools: 350`、08 预留 `memory: 900`（D6）、tool-use 不列工具名（D7）、不做项目指令文件（D8）。差异 D1–D8 见 §2.4；Q1–Q10 已全部拍板；实现期偏离 X1–X4、复核评审修复 **Y1**（实例配置拒数组）与误报表已回写 §7；**已随模块提交归档** |
| `docs/design/02-llm.md` | **Baseline** · 2026-10-17 | 02 设计：`builtin:llm` 插件 + 手写 SSE 的 OpenAI 兼容流式 adapter（`src/llm/` 六文件）+ `LlmError` + `createToolCallAccumulator`。要点：只注册 `deepseek`（Q1）、错误以 `LlmError{kind}` 抛出（Q2，StreamEvent 表封闭不能加 error 变体）、聚合助手归 02（Q3）、`registerLlmBuiltin()` + `createLlmPlugin({fetchImpl})` 显式注册与注入（Q4）、`stream()` 配置类错误同步抛（D4）、不重试（D5）、不在 setup 自检 provider（D7）。差异 D1–D7 见 §2.4；**Q1–Q7 已于 2026-10-17 全部拍板（均按建议项）**，实现已完成（③④⑤ 全绿），实现期偏离 X1–X3 已补记 §7；**review 已完成（攻击式评审，3 轮探针 19 例实证、无 P0），review 期修复 Y1–Y4 与"排除的误报"表已回写 §7，文档随模块提交归档为 Baseline** |

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
| — | **工具路径解析基准必须与 04 的环境段一致**：环境段末尾写死"所有相对路径都按上面的工作目录解析"，取的是 `process.cwd()` | **已定**（04 §5）：05 的工具实现必须以 `process.cwd()` 为相对路径基准，否则系统提示里的这句承诺是假的（resume 到别处创建的会话时两边会不一致） | 05 |
| — | **系统提示每 step 都变**（环境段的秒级时间戳） | **已知取舍，不改**：会削弱 provider 侧前缀缓存命中；但模型需要真实时间处理"刚才/今天"，且 mini 版不统计缓存（02 非目标）。日后要优化就把时间行挪到最后一个段 | 04（记录）→ 06/07 |
| — | **provider 不认 `stream_options`**（少数 OpenAI 兼容网关会对未知字段报 400） | **已知风险，不处理**：02 按 `{kind:'http', status:400}` 上抛，不降级重试（02 §5 边界表 / Q5）。用户侧解法是换 baseUrl 或等后续加兼容开关 | 02（记录）→ 07 错误提示 |
| — | **03 的插件配置 narrow 不拒数组**：`session/plugin.ts` 与 04 修复前的同式写法——`config` 误传数组时 `typeof [] === 'object'` 放行、配置被静默忽略（04 已修为 Y1，03 已归档 Baseline 不回改） | **已定，不修**：实例配置来源是 `loadConfig()` 校验过的 JSON，数组形态属用户手写错误且影响仅是"配置不生效"；若 09 或后续插件再写 narrow，直接沿用 04 Y1 的 `Array.isArray` 防线 | 后续插件作者 |

## 约定备忘（跨会话不变）

- 仓库：`mini-dsh/` 为独立 git 仓库；上级 `MiniDSH/` 不是仓库。
- 未获用户明确要求，**绝不自动提交**；提交前展示变更摘要。
- 一次只推进一个模块；交接信息写本文件，不依赖对话历史。
- 实现偏离设计文档时，必须回写设计文档"验收标准"下，不能只留在对话里。
