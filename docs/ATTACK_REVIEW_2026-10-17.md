# mini-dsh 攻击性代码审查：潜在 Bug 与策略边界

- 审查日期：2026-10-17
- 基线：HEAD `5b64ef5`；同时审查了当前未提交的 `src/index.ts`、`src/plugin/containers.ts`、`src/prompt/**`，并阅读了随之新增的 prompt 测试。
- 范围：当前已实现的插件内核、配置、LLM、session、prompt 模块，以及相关架构/模块设计约定。
- 方法：静态追踪公开入口、数据流、错误路径、并发路径和策略边界。未运行测试或动态探针。
- 当前尚无工具执行管线、agent、CLI、MCP、memory 模块；所以能审查权限选择器和 prompt，但不能验证 deny/ask/auto 在工具执行时的实际效果。

## 结论

当前实现有较好的模块边界和不少明确契约，但仍有安全边界、数据一致性及失败语义问题需要处理。最高优先级是 session ID 路径穿越、项目配置的信任模型、动态值进入 system prompt，以及后续工具管线必须让权限决策与实际执行对象保持一致。

等级定义：**P1** 表示触及安全/权限边界或可能造成敏感数据暴露；**P2** 表示可造成模型请求、会话或生命周期错误；**P3** 表示低频协议/运维边界。注明“条件性”的发现只有在相应信任边界或输入条件出现时才触发。

## 已实现代码中的缺陷

### F-01 — P1：session ID 可穿越出 sessions 根目录

`open`、`read`、`append` 最终把外部传入的 ID 直接拼进文件路径，`#fileOf` 未校验路径段，也未确认解析后的路径仍在根目录内。含 `../`（Windows 上为 `..\\`）的 ID 可使这些操作访问根目录之外、末尾为 `session.jsonl` 的文件；若目标文件能被解析为 session 日志，`append` 会继续向它追加内容。

位置：`src/session/store.ts:101-103, 156-170, 211-213`

建议：所有公开入口统一校验 ID 为单一路径段，并在路径解析后做根目录包含性检查；拒绝分隔符、`.`、`..` 和绝对路径。不要只依赖 ID 生成器，因为这些 API 也接受调用方提供的 ID。

### F-02 — P1（条件性）：项目配置可加载任意本地 Node 插件代码

`loadConfig` 默认读取当前工作目录中的 `minidsh.json`；插件 `source` 除 `builtin:` 外会按 cwd 解析，再直接 `import()`。只要宿主对不可信项目加载并 boot 这份配置，项目就能指定本地模块，在宿主 Node 权限下执行代码并读取环境变量、文件和凭据。代码注释也明确当前没有插件沙箱。

位置：`src/config/load.ts:72-77`、`src/plugin/boot.ts:90-115`

这是信任模型问题，不是说可信用户配置下的插件加载本身错误。若项目配置会自动生效，应明确告诉用户项目配置/插件是可执行代码，并对项目级插件设置显式信任确认或禁用策略；不能把“配置文件”当成纯数据。

### F-03 — P1（条件性）：项目配置可把任意环境变量作为 Bearer 凭据发往任意 URL

`model.apiKeyEnv` 由配置提供，LLM adapter 会读取对应环境变量，并将其作为 `Authorization: Bearer ...` 发给 `model.baseUrl`。`baseUrl` 未限制 scheme 或主机。不可信项目配置可把 `apiKeyEnv` 指向其他敏感环境变量，再把 `baseUrl` 指向攻击者服务；触发模型请求即可外传该值。即使密钥变量固定，HTTP endpoint 也会暴露 Bearer token。

位置：`src/config/validate.ts:83-90`、`src/llm/adapter.ts:87-100, 171-177`

建议：把自定义 endpoint 与环境变量读取视为可信配置能力。项目层配置不应无提示覆盖全局凭据来源；远程 endpoint 默认要求 HTTPS，并对项目层 endpoint/key-env 覆盖设置信任边界。本地 HTTP 服务应作为明确的受信例外。

### F-04 — P2：权限键有首尾空格时静默失效

校验只拒绝全空白键，但保留非空键的原始空格。配置 `{ " bash ": "deny" }` 能通过校验；运行时查找 `bash` 时不命中，回退为 `ask`。这不会直接把 `deny` 提升为 `auto`，但会让配置的拒绝策略失效并转成交互请求；若无交互宿主处理不当，最终执行边界就不明确。

位置：`src/config/validate.ts:112-127`、`src/config/permissions.ts:27-49`

建议：拒绝带首尾空格的键，或在解析时规范化并对规范化后的重复键报错。策略配置不应静默退化成另一个策略。

### F-05 — P2：工具调用 ID 兜底值会在不同模型响应间重复

当 provider 没给 tool-call ID 时，聚合器用 `call_${index}` 兜底；每个 accumulator 都从 index 0 开始，因此不同响应的第一个调用都会得到 `call_0`。session 投影会预扫描整段日志中的结果 ID，再按 ID 判断 assistant 调用是否已完成。较早响应的 `call_0` 结果可能让较新的 `call_0` 声明被误判为已完成；取消或缺少结果时，会向模型投影没有对应结果的 tool call。重复 ID 也可能让一对一 pending 集合错误配对。

位置：`src/llm/accumulate.ts:35-56`、`src/session/derive.ts:49-85`

建议：跨响应生成唯一 ID（例如加入 request/turn 标识），或在协议层拒绝缺失 ID；session 恢复时按事件顺序建立调用状态，不能用“后面某处出现过同 ID 结果”证明当前声明已完成。

### F-06 — P2：SSE 的 CRLF 在分片边界被误拆成两个换行

行尾归一化是逐个 chunk 做的。如果一个 chunk 以 `\r` 结束、下一个以 `\n` 开始，第一片把 `\r` 转成 `\n`，第二片又保留 `\n`，解析器看到 `\n\n`，误以为空行结束了 SSE event。合法的多行 data event（例如 `data: a\r` / `\ndata: b\r\n\r\n`）会被拆成两个 frame，违背多条 `data:` 行合并的预期。

位置：`src/llm/sse.ts:74-78`

建议：把待处理的末尾 `\r` 留到下一片判断，或先拼接原始 chunk 再归一化；边界用例需覆盖 `\r` 与 `\n` 分属两片和多行 `data:`。

### F-07 — P2：退订句柄不真正幂等，旧句柄可能取消新订阅

事件总线和 session store 都按回调函数身份删除订阅。退订后若同一个函数对象重新注册，再调用旧退订句柄会删掉新订阅。`registerBuiltin` 的退订句柄只按名称删除：旧句柄在同名插件重新注册后也能删掉新 factory。相关契约和注释都承诺重复退订安全，实际行为不满足。

位置：`src/plugin/event-bus.ts:50-59, 74-80`、`src/session/store.ts:182-194`、`src/plugin/boot.ts:29-34`、`src/contracts.ts:16-20`

建议：每次注册保存独立 subscription token；退订闭包只移除自己创建的那条记录，并在首次调用后标记已取消。

### F-08 — P2：并发创建相同 session ID 时检查与创建不是原子的

`create` 先 `access` 检查文件，再递归建目录，最后用 append 写 header。两个并发调用或两个进程使用同一 ID 时，可能同时通过检查并向同一文件追加两条 header；后续加载只接受第一条 header，内存状态与磁盘创建者也会出现歧义。当前有碰撞检查，但没有排他创建。

位置：`src/session/store.ts:67-93`、`src/session/jsonl.ts:101-105`

建议：通过排他创建目录/文件（例如 `mkdir` 不使用 `recursive` 并处理 `EEXIST`，或 `open(..., 'wx')`）完成原子占位，再写 header。

### F-09 — P2：并发 shutdown 会重复 dispose，取消信号晚于 dispose

`shutdown` 在所有 `dispose` await 完成后才清空共享挂载数组；两个并发调用都能拿到同一非空数组并重复 dispose。另一个边界是 `AbortController.abort()` 放在 dispose 全部结束之后：若插件的 dispose 等待由 `ctx.signal` 取消的任务结束，该任务永远收不到取消信号，shutdown 会卡住。

位置：`src/plugin/boot.ts:214-228`

建议：首次 shutdown 时同步标记关闭状态并共享一个 shutdown Promise；明确取消信号的时序。若 dispose 允许等待 signal，应先发出取消；否则应在契约中禁止这种等待。

### F-10 — P2：异步监听器的 rejection 不会被同步 try/catch 捕获

通知事件和 session listener 的签名返回 `void`，但 TypeScript 允许 async 函数赋给此类回调。分发器只捕获同步 throw；async listener 返回的 rejected Promise 会逃逸，不会调用约定中的 `onError`。waterfall 会 await，因此不同类型监听器的失败语义不一致。

位置：`src/plugin/event-bus.ts:56-72`、`src/session/store.ts:336-345`

建议：明确禁止 async listener 并加类型/lint约束，或接受 Promise 并显式等待、捕获；通知广播还要定义串行还是并发等待。

### F-11 — P2：从 `flags` 注入的插件配置会被 boot 反向冻结

配置校验会新建 `plugins` 数组和条目，但 `plugins[].config` 仍是原对象引用；`deepMerge` 对数组也整值替换并保留引用。于是 `loadConfig({ flags })` 的返回值和调用方 `flags.plugins[].config` 共享嵌套对象，之后 `boot(config)` 的 `deepFreeze(config)` 会把调用方传入对象也冻结。调用方后续修改 flags 可能突然抛错。

位置：`src/config/merge.ts:28-44`、`src/config/validate.ts:129-135`、`src/plugin/boot.ts:150-156`

建议：在 `validateConfig`/`loadConfig` 边界深拷贝任意插件 config，或 boot 冻结内部副本而非调用方对象。

### F-12 — P2：append 保存调用方事件对象引用，后续变更会令内存与 JSONL 分叉

append 落盘后把原始 `event` 引用直接放进缓存。调用方在 `await append()` 之后修改对象，会改变后续 `read()` 返回的缓存内容，但磁盘 JSONL 不变；当前进程与重启恢复的历史就不一致。若写链前面还有等待项，调用方在落盘前修改对象也会改变实际写入内容。

位置：`src/session/store.ts:168-180`

建议：append 入口立即序列化/深拷贝为不可变快照，并用同一快照落盘、缓存和派发。

### F-13 — P2：人工重命名 session 目录后，list 返回的 ID 不能用于 open

设计允许目录名与 header ID 不同；但 `list()` 遍历目录名后返回 `header.id`，而 `open(id)` 按 `id` 拼目录路径。目录被重命名后，列表给出的 header ID 会指向旧目录，用户无法用 list 结果重新打开该条目。设计允许重命名，但 list/open 的 ID 约定没有闭合。

位置：`src/session/store.ts:101-103, 111-145`、`docs/design/03-session.md:320`

建议：明确公开 ID 以目录名还是 header ID 为准，并让 list/open 使用同一个键；若保留 header ID 展示，应额外返回真实存储键供 open 使用。

### F-14 — P1（条件性）：未转义的动态环境值可注入 system prompt

环境段把 `cwd` 和模型标识直接插入 system prompt。POSIX 路径允许换行，项目配置里的 `model.provider`/`model.name` 也只要求是非空字符串；因此恶意工作目录名或配置值可插入新行，伪造新的系统指令。该内容与可信指令处于同一个 system 字符串中，影响高于普通工具输出注入。

位置：`src/prompt/sections/environment.ts:77-92`、`src/prompt/plugin.ts:50-58`、`src/config/validate.ts:83-90`

建议：对所有动态事实做结构化编码（如 JSON 字符串转义）并用明确边界包裹；拒绝/转义控制字符。不要把不可信值直接模板插入 system prompt。

### F-15 — P2：工具输出被称为“事实”，没有声明它是不可信数据

工具使用段写着“工具返回的内容即事实”，却没有说明工具返回文本可能包含恶意指令、仿冒系统提示或要求泄露数据的提示注入。读取 README、网页、日志或代码注释时，模型可能把内容里的指令当成任务要求。即使工具输出在消息角色上不是 system，这段文案仍缺少必要的信任边界说明。

位置：`src/prompt/sections/tool-use.ts:22-30`

建议：明确工具结果是待分析的数据，不是新的授权或更高优先级指令；其中要求执行命令、泄密、扩大权限的内容必须服从原始用户请求与硬策略。更重要的是，工具安全必须由运行时权限门保证，不能只靠 prompt 文案。

### F-16 — P2（策略边界）：核心安全提示可整体缺席或被配置禁用

默认配置的 `plugins` 为空；`builtin:prompt` 需要宿主显式注册并在配置中启用。未挂该插件时，`ctx.prompt.render()` 按设计返回空串。插件配置还允许禁用 `core/tool-use`、`core/guidelines` 等段。因而启动配置少一项或项目配置禁用段后，模型可能在没有核心提示的情况下运行。此行为是当前设计允许的，不能当作硬授权策略。

位置：`src/config/defaults.ts:10-29`、`src/plugin/boot.ts:165-196`、`src/prompt/plugin.ts:82-90`、`src/prompt/core.ts:50-69`、`src/plugin/containers.ts:103-115`

建议：07 启动层确保核心 prompt 默认注册；对核心策略段是否允许项目配置禁用应单独决策。deny/ask、文件范围、危险命令等硬边界必须由工具管线强制，不能因 prompt 段被禁用而消失。

### F-17 — P3：Prompt section 的 order 缺少有限数值校验

`PromptRegistryImpl` 接受任何实现了 TypeScript 接口的插件对象，注册时只检查 ID 是否重复。若插件传入 `order: NaN`，排序比较器返回 `NaN`，JS sort 会把它按相等处理，绕过“同 order 按 ID 字典序”的约定；同一 prompt 的顺序会依赖注册顺序。外部 JS 插件也不受 TS 编译约束。

位置：`src/plugin/containers.ts:84-107`、`src/contracts.ts:199-205`

建议：注册时校验 `id` 非空、`order` 为有限数值、`render` 是函数；可选地保存冻结副本，避免注册后被插件改写。

## 策略边界：实现符合既定设计，但有高影响决策

### PB-01 — 全局 `deny` 不是项目配置的强制上限

权限表逐层合并后丢失配置来源，匹配只看最具体规则。例：全局 `mcp__* = deny`，项目 `mcp__github* = auto`，最终匹配 `mcp__github_*` 会得到 `auto`。这是架构在 2026-10-16 明确采纳的“更具体规则总是赢”，不是实现偏差；但它意味着全局配置不能强制封禁某类工具。

位置：`src/config/permissions.ts:27-49`、`docs/architecture.md:239-245`

若全局配置代表组织/管理员策略，应保留来源并增加不可被项目层放宽的 ceiling/deny override；若全局只是默认值，应明确项目配置能提升到 `auto`。

### PB-02 — `resolvePermission` 只是选择器，尚无运行时执行门

当前能确认的只有匹配结果。`tools` 执行管线尚未实现，因此现在不能证明 `deny` 会阻止执行、`ask` 会等待明确批准、`auto` 只作用于最终实际执行的工具。

05-tools 实现必须满足以下边界：

1. `deny` 不展示审批提示，也不调用工具；拒绝仍写入 `tool/result`。
2. 无 UI/审批处理器、审批超时或用户拒绝时，`ask` 必须失败关闭，不能默认当成 `auto`。
3. 授权针对最终执行的工具名和参数。`tools/pre-execute` waterfall 可替换 invocation；若先授权、后允许监听器改写 `name`/`args`，会出现检查 A、执行 B。应在所有改写完成后校验并授权同一不可变快照，或禁止授权后改变身份/参数。
4. schema 校验、权限检查、最终 registry lookup、执行必须绑定同一个 invocation，避免检查对象与执行对象不一致。

架构定义了 schema → pre-execute → execute 的结果约定，但当前无对应源码：`docs/architecture.md:230-245`。

### PB-03 — prompt 是软约束，不能替代运行时策略

工具输出可能提示注入；核心段也可以被禁用，prompt 插件还可能未挂载。所有危险操作的授权、拒绝、路径限制和参数校验都必须在工具执行代码中强制。不能因为 system prompt 里写了某条规则，就认为该边界已实现。

## 低优先级协议与运维边界

- **P3：HTTP 错误响应体先完整读入内存，再截断日志。** 大响应体会造成不必要内存占用或等待。位置：`src/llm/adapter.ts:108-116`。
- **P3：usage 与 tool-call index 只检查有限数值。** 负数/小数 token 数可通过；缺失或畸形 index 被归入 0，可能把多个流片合并到同一个 slot。位置：`src/llm/wire.ts:108-136`。
- **已知运维限制：** HTTP 与流读取没有超时；当前设计把超时/重试交给上层。若 CLI 未传入 AbortSignal 或未设置全局超时，网络连接可长期挂住。这属于设计边界，尚不能作为违反当前契约的 bug。

## 建议处理顺序

1. 修 F-01；明确 F-02/F-03 项目配置与凭据的信任边界。
2. 处理 F-14/F-15 的 prompt 输入信任边界，并决定 F-16 的默认启用与可禁用策略。
3. 在工具实现前拍板 PB-01 全局策略语义，把 PB-02 的授权顺序写进 05-tools 契约。
4. 修 F-05 工具调用 ID/日志投影和 F-06 SSE 分片边界，避免生成不合法的模型对话。
5. 修 F-07 退订幂等、F-08 创建原子性、F-09 shutdown 并发/取消次序。
6. 处理 F-11/F-12 配置和事件对象别名，并统一 F-13 session 对外 ID；用注册校验收口 F-17。

本报告未修改源码、测试或仓库现有文档，也未运行测试。由于仓库目录对当前运行账户只有读取权限，报告保存于本任务的可写产物目录，而非仓库内。
