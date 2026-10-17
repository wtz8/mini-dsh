# 03-session 设计

> 状态：**Baseline**（2026-10-17 随模块提交归档；§8 的 Q1–Q10 由所有者全部按建议项拍板，Q1 的基线修订见 §2.5；实现期偏离 X1–X2、review 期修复 Y1 见 §7 偏离记录）
> 预算：~1.5k 行（架构 §4；本次范围预计 ~0.75k，见 §7 预算说明）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §5.2 的 `SessionStore` / `SessionStoreContainer.mount` 委托式容器、§5.4 的 Session log 事件表）、`01-config.md`（Baseline，重点 §2.3 Config 字段增补规则）、`02-llm.md`（Baseline，重点 §2 出口面约定与 §7 的 X2/X3：插件侧能力经 `src/index.ts` 转发、内置模块用 `registerBuiltin()` 显式注册并返回退订句柄）、`architecture.md` 0.1.5（§5.2 服务面、§5.3 通知事件表、§5.4 事件表、§6 数据流、§7 存储布局、§11-Q4）

## 1. 背景与目标

03 交付架构灵魂 **#2（Model-visible means logged）** 的可运行形态：模型可见的会话事实只来自 session log 的投影，**不存在第二份"内存对话状态"**。

对应骨架契约：

- architecture §5.2 `SessionStore { create / open / list / append / subscribe }` 与 `SessionStoreContainer { mount(impl) }`：M0 已交付委托式容器（未 mount 前抛 `'not mounted'`），由 03 的 `builtin:session` 在 setup 内经 `mount()` **一次性注入**真实实现（eat own dogfood：会话能力本身也是插件）。
- architecture §5.4 Session log 事件表（七个变体，**变体集合对 03 封闭**，新增 = 改基线）。
- architecture §5.3 通知事件 `session/append: { sessionId, event }`（log 落盘后的进程内广播）。
- architecture §6 数据流：`messages = deriveMessages(session)` —— **log 投影是 `LLMRequest.messages` 的唯一来源**。
- architecture §7 + §11-Q4 存储布局：`~/.minidsh/sessions/<id>/session.jsonl`（一会话一目录，为附件留位）。

目标（一句话）：让 06 只需

```ts
const s = await ctx.sessions.create({ provider, model, cwd })
await ctx.sessions.append(s.id, { type: 'user/message', content: text })
const events = await ctx.sessions.read(s.id)          // ← §8-Q1 新增的读取口
const messages = deriveMessages(events)               // ← 03 导出的纯函数投影
req = { system: ctx.prompt.render(), messages, model, tools, signal }
```

就能拿到"与磁盘上 JSONL 严格一致"的模型可见面，且**崩溃后可原样恢复**。

**非目标**（明确不做，防范围膨胀）：

- 不做 session 多版本迁移链、zstd 压缩、generation（架构 §10 已砍）。
- 不做跨进程锁、多进程写同一会话（mini 版单进程 REPL；并发只解决**同进程内**的 append 串序，§4.3）。
- 不做会话删除 / 重命名 / 导出 / 附件（`sessions/<id>/` 的目录形态已为附件留位，03 不实现）。
- 不做事件级查询、索引、全文检索（只有"全量读 + 全量投影"）。
- 不做 token 估算与压缩**决策**（06 决定何时压缩、summary 怎么来；03 只定义 compaction 事件的**投影语义**）。
- 不做工具输出截断（05 的第一道闸；03 忠实记录）。
- 不改 `SessionEvent` 变体集合。

## 2. 对外契约

模块落在 `src/session/`。导出面分两类（沿用 02 X3 约定：**宿主侧**只经 `src/session/index.ts`；**插件侧**能力额外经 `src/index.ts` 转发，否则 06 只能深引用内部路径）。

### 2.1 宿主侧（`src/session/index.ts`）

```ts
/**
 * JSONL 会话存储（03 的真实实现，无 ctx 依赖——纯 IO + 内存层）。
 * 结构上是 `SessionStore` 的子类型，多出的两个方法只给持有者（插件/test）用。
 */
export interface JsonlSessionStore extends SessionStore {
  /** 等待全部在途写入落盘（退出前 flush；append 均已 await，正常路径无需调用） */
  settled(): Promise<void>
  /** 清空内存缓存与订阅（不删文件）；dispose 时调用 */
  clear(): void
}

/** 存储构造选项（生产只传 `dir`；其余为注入点） */
export interface SessionStoreOptions {
  /** sessions 根目录；缺省 `~/.minidsh/sessions`（架构 §7） */
  dir?: string
  /** 事件落盘后的回调——插件侧接 `ctx.events.emit('session/append', …)` */
  onAppend?: (sessionId: string, event: SessionEvent) => void
  /** 非致命诊断（坏行跳过、list 跳过损坏会话）；插件侧接 `ctx.log.warn` */
  onWarn?: (message: string) => void
  /** 订阅者抛错；插件侧接 `ctx.log.error`（与 EventBus 的"emit 永不抛"同义） */
  onError?: (message: string, err: unknown) => void
  /** id 生成（测试注入固定 id 用）；缺省 `createSessionId()` */
  idFactory?: () => string
}

/** 构造 JSONL 会话存储；可脱离组合根单测（给定 tmp 目录即可） */
export function createJsonlSessionStore(options?: SessionStoreOptions): JsonlSessionStore

/** 会话 id 生成：`YYYYMMDD-HHmmss-<base36 6 位>`（见 §4.1） */
export function createSessionId(): string

/**
 * 构造 `builtin:session` 插件工厂。
 * @param options.dir 覆盖 sessions 根目录（生产不传；测试注入 tmp 目录）
 */
export function createSessionPlugin(options?: { dir?: string }): PluginFactory

/**
 * 把 `builtin:session` 注册进内核 builtin 表（07 启动时对各 builtin 模块各调一次）。
 * @returns 退订句柄
 * @throws Error 同名重复注册
 */
export function registerSessionBuiltin(): Unsubscribe
```

### 2.2 插件侧（额外经 `src/index.ts` 转发）

```ts
/**
 * log 投影：把 append-only 事件序列投影为模型可见的 `ChatMessage[]`。
 *
 * **纯函数**：不读盘、不缓存、不改入参；同一输入必得同一输出。
 * 这是灵魂 #2 的唯一出口——06 不得在内存里另存一份"对话历史"。
 *
 * 投影规则见 §4.4（含 compaction 截断、残缺 toolCalls 丢弃、孤立 tool 结果跳过）。
 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[]
```

### 2.3 新增运行时错误类

`SessionError extends Error`，落点 `src/errors.ts`（与 `ToolRejected` / `BootError` / `ConfigError` / `LlmError` 同处），经 `src/index.ts` 转发：

```ts
/** `not_found`：id 不存在；`io`：读写/建目录失败；`corrupt`：文件结构损坏 */
export type SessionErrorKind = 'not_found' | 'io' | 'corrupt'
export class SessionError extends Error {
  readonly kind: SessionErrorKind
  readonly file?: string   // 出错的文件路径（便于 07 打印定位）
}
```

与既有错误类的分工：`ConfigError` 在 `boot()` **之前**、`BootError` 在 `boot()` **期间**、`LlmError` 在**回合运行期**（02）、本错误在**会话 IO 期**（03，同样属运行期但发生在 `sessions.*` 调用点）。07 可分别捕获：会话不存在 → 提示可用 id；io → 提示磁盘权限；corrupt → 提示文件损坏。

### 2.4 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | **`SessionStore` 新增 `read(sessionId): Promise<SessionEvent[]>`**（§8-Q1，**基线修订，已拍板并于 2026-10-17 执行**：`architecture.md` **0.1.4 → 0.1.5**） | 现有契约**只写不读**：`create/open/list/append/subscribe` 没有任何"取回事件序列"的口子，而 §6 的 `deriveMessages` 需要全量 log 作输入——契约存在真实缺口。不补的话 06 只剩三条路：①用 `subscribe` 自建内存投影（**违反灵魂 #2**）；②让 `open()` 返回的 `Session` 挂 `events` 快照（经容器后静态类型塌缩为 `Session`，06 需类型断言，且"句柄即快照"语义模糊）；③直接 import 03 内部模块（违反"插件间不 import 彼此"）。加 `read` 是唯一既保住灵魂 #2 又不动既有签名的路径：**纯新增方法**，不改任何既有签名。影响面见 §2.5 |
| D2 | 新增 `SessionError`（`src/errors.ts`，§8-Q2） | 与 02 新增 `LlmError` 同构：`open`/`list` 的失败需要**机器可判**分类（07 对"id 不存在 / 磁盘不可写 / 文件损坏"的提示完全不同），靠 message 猜不可接受 |
| D3 | **store 与插件分离**：`createJsonlSessionStore` 不依赖 `ctx`，事件/日志通道以回调注入（§4.5） | store 可脱离组合根单测（给 tmp 目录即可，无需伪 ctx）；插件是薄适配层（mount + 接总线 + narrow 实例配置）。插件间不 import 彼此、也不让 store 反向依赖内核 |
| D4 | sessions 目录**不加进 `Config`**，走插件实例配置 `plugins[].config = { dir }` + 插件构造选项注入 | 01 已 Baseline，Config 增字段须同步 `validate.ts`（01 §4.2 同步义务）；且这正是 `plugins[].config` 的用途（架构 §5.1）。与 02 的 `createLlmPlugin({fetchImpl})` 同式，默认行为不变（架构 §7 布局） |
| D5 | 不做删除/重命名/迁移/附件 | 架构 §10 已砍迁移与压缩体系；目录形态留位但 03 不实现。mini 版会话只增不减 |
| D6 | 不做 fsync / WAL / 写入校验 | 崩溃最多丢**最后一行**；读侧以"跳过坏行"兜底（§5）。持久强度按"REPL 工具"定位，不按数据库定位 |
| D7 | `list()` 只解析每个 jsonl 的**第一个有效事件**（header），不加载全量 | 列表是低频操作（07 的 `/resume`）；会话多时省 IO。损坏/空文件跳过并 `onWarn`，不抛 |
| D8 | 投影对"残缺 `toolCalls`"与"孤立 `tool/result`"做**裁剪**（§4.4） | 契约未定义，但 OpenAI 兼容面要求 `role:'tool'` 消息严格配对前序 `tool_calls`：**有 tool_calls 无结果**、**有 tool 消息无调用**都会被 provider 判 400。裁剪发生在 03（投影层），05/06 不必各自防 |
| D9 | `subscribe` 未知 id 抛 `SessionError{not_found}`（不懒订阅） | 订阅必须在 `create`/`open`（均为 await）之后，无竞态；"静默永不触发的订阅"是难排查的 bug 源，早暴露更好。代价是调用方需保证顺序——07 的渲染器本来也走总线事件而非 `subscribe` |

### 2.5 D1 的基线修订影响面（2026-10-17 已执行完毕）

`read` 进契约共同步四处，均为**纯新增**、不改既有签名：

1. `docs/architecture.md` §5.2：`SessionStore` 签名块加 `read(sessionId: string): Promise<SessionEvent[]>` 一行；§12 登记版本 **0.1.4 → 0.1.5**（理由引用本文 D1），并按 §12 规则触发重新 review。
2. `src/contracts.ts`：`SessionStore` 加 `read` 及 JSDoc（返回按写入顺序的事件快照，浅拷贝数组）。`SessionStoreContainer` 因 `extends SessionStore` 自动获得，无需改动接口体。
3. `src/plugin/containers.ts`：`SessionStoreContainerImpl` 加 `read` 委托（与其余五个方法同式，`async` 包装使未挂载以 rejection 呈现）。
4. `src/plugin/containers.test.ts`：`stubStore()` 补 `read` 实现；"未 mount 前所有 SessionStore 方法抛 not mounted"用例补 `read` 断言。

另在 `docs/design/00-skeleton.md` §2 记一行（服务面清单同步），不改其结论。

## 3. 数据结构

```text
src/session/
├── types.ts        # 模块内类型：SessionStoreOptions / SessionPluginConfig / SessionEntry
├── ids.ts          # createSessionId()：时间戳 + base36 随机
├── jsonl.ts        # 行序列化 / 行解析 / 读全量 / 单行追加（唯一碰到 fs 的文件）
├── validate.ts     # isSessionEvent()：读回时的最小结构校验（防坏行污染投影）
├── derive.ts       # deriveMessages()：纯函数投影（核心算法）
├── store.ts        # createJsonlSessionStore：内存缓存 + 串行写链 + 订阅派发
├── plugin.ts       # createSessionPlugin / registerSessionBuiltin（薄适配层）
└── index.ts        # 模块出口（宿主侧）
src/errors.ts       # + SessionError（D2，约 35 行，单独计）
```

**磁盘格式**（`~/.minidsh/sessions/<id>/session.jsonl`）：

```text
{"type":"session/header","id":"20261017-153012-k3f9a2","createdAt":"2026-10-17T07:30:12.345Z","provider":"deepseek","model":"deepseek-chat","cwd":"D:\\MiniDSH"}
{"type":"turn/start","turnNo":1}
{"type":"user/message","content":"读一下 README"}
{"type":"assistant/message","content":"","toolCalls":[{"id":"call_0","name":"read","arguments":"{\"path\":\"README.md\"}"}],"usage":{...}}
{"type":"tool/result","toolCallId":"call_0","result":{"callId":"call_0","name":"read","ok":true,"content":"# MiniDSH …"}}
{"type":"turn/end","turnNo":1}
```

- 一行一个事件，`JSON.stringify(event) + '\n'`；UTF-8；读时逐行 `JSON.parse`，去尾 `\r`、跳过空行（容忍 `\r\n` 与文件尾换行）。
- 第一行为 `session/header`（`create` 时同步写入，故文件不会为空）。
- JSONL 天然支持 append-only 与"崩溃后手工检视"，零依赖原则下没有比它更合适的格式。

**内存结构**（store 私有）：

```ts
interface SessionEntry {
  meta: SessionMeta
  file: string                                  // <dir>/<id>/session.jsonl
  events: SessionEvent[]                        // 全量（mini 版规模可控，§5 有说明）
  listeners: Set<(e: SessionEvent) => void>
}
// Map<sessionId, SessionEntry>；#chain: Promise<void> 为串行写链
```

## 4. 核心流程

### 4.1 id 生成（`ids.ts`）

```text
createSessionId() = `${YYYYMMDD}-${HHmmss}-${base36 随机 6 位}`   // 例：20261017-153012-k3f9a2
```

- 时间戳取本地时间（`getFullYear/Month/...` 逐字段补零），随机段由 `Math.random().toString(36).slice(2, 8)` 取 6 位小写字母数字。
- 为什么不用 `crypto.randomUUID()`：id 前缀是时间戳 → **目录名字典序 ≈ 创建顺序**，`ls ~/.minidsh/sessions` 与 `list()` 都直观；且不含 `:``/`，Windows 文件系统安全。
- 碰撞：同秒 + 6 位 base36 ≈ 1/2.8e8，且 `create` 会检测目标文件已存在并抛错（§5），不会静默混写。

### 4.2 `create` / `open` / `list`

```text
create(opts)                                          # 架构 §5.2
  id = idFactory()                                    # 注入点（测试固定 id）
  dir = <root>/<id>; file = dir/session.jsonl
  mkdir(dir, {recursive:true})
  file 已存在 → throw SessionError{io}                # 绝不追加到既有文件（会混写两个会话）
  写 header 行（await）
  entry = { meta:{id, createdAt:new Date().toISOString(), provider, model, cwd}, file, events:[header], listeners:∅ }
  sessions.set(id, entry)
  return { id, meta }                                 # 只回契约面，内存 entry 不外泄

open(id)                                              # resume
  命中缓存 → return { id, meta }
  file 不存在 → throw SessionError{not_found, file}
  读文件（其它 IO 错误 → {io}）→ 逐行解析：
      坏行 → 跳过 + onWarn（不抛，§5）
      第一个有效事件必须是 session/header，否则 → {corrupt}
  缓存全量 events → return { id, meta }

list()
  readdir(<root>) → 对每个子目录 <d>：解析 <root>/<d>/session.jsonl 的第一个有效事件
      目录无该文件 / 空文件 / 首事件非 header / 读失败 → 跳过 + onWarn
  按 createdAt 降序（ISO 同格式可直接字符串比较，最新在前）
```

### 4.3 `append`（串行写链）

```text
append(id, event)
  entry = sessions.get(id) ?? await #loadFromDisk(id)     # 未 open 则尝试恢复，失败 → {not_found}
  #chain = #chain.then(() => appendLine(entry.file, event))   # 串行化：并发调用按调用顺序落盘
  await #chain
  entry.events.push(event)                                  # 落盘后才进内存
  逐个派发 listeners：try/catch → onError（单个抛错不影响其余、不影响 append）
  onAppend?.(id, event)                                     # 插件接 ctx.events.emit('session/append')
```

要点：

- **落盘 → 内存 → 派发**的顺序：崩溃一致性上"宁可写了没通知，不可通知了没写"；订阅者看到的内存快照已含该事件。
- 串行写链解决真问题：06 并行执行工具后 `Promise.all(append(tool/result))`，若不串行，行序不确定 → 投影顺序漂移、resume 后顺序与运行时不一致（违反"log 是唯一事实源"）。
- 超大单行（工具输出）由 05 截断把关；03 只照写（§5 有崩溃半行的限制说明）。

### 4.4 `deriveMessages` 投影（核心算法，`derive.ts`）

```text
deriveMessages(events):
  1. ci = 最后一个 compaction 事件的下标（无则 -1）
  2. out = []
     if ci >= 0: out.push({ role:'user', content: events[ci].summary })   # 摘要作为首条 user 消息（§8-Q10）
  3. start = ci + 1                       # 切点之后全部保留（§8-Q8：按事件位置，而非 turnNo 过滤）
  4. resultIds = { e.result.callId | e ∈ events[start..] 且 e.type==='tool/result' }
  5. seen = new Set<string>()             # 已投影且已被消费的 callId
     for e of events[start..]:
       'user/message'        → out.push({role:'user', content:e.content})
       'assistant/message'   → calls = (e.toolCalls ?? []).filter(c => resultIds.has(c.id))   # 残缺丢弃（D8）
                               if (e.content === '' && calls.length === 0) continue            # 空回复不投影
                               msg = {role:'assistant', content:e.content}
                               if (calls.length) msg.toolCalls = calls
                               out.push(msg); for (c of calls) seen.add(c.id)
       'tool/result'         → if (!seen.has(e.result.callId)) continue                        # 孤立结果跳过（D8）
                               out.push({role:'tool', toolCallId:e.result.callId, content:e.result.content})
                               seen.delete(e.result.callId)                                    # 一对一消费
       'session/header' | 'turn/start' | 'turn/end' | 'compaction' → 忽略（模型不可见/无对应形态）
  6. return out
```

关键语义（每条都有对应用例，见 §6.1）：

- **`session/header` / `turn/*` 不投影**：`ChatMessage` 只有 user/assistant/tool 三种形态，回合边界与元信息对模型不可见（系统信息走 `LLMRequest.system`，由 04 拼装）。
- **compaction**：切点之前的整段历史被 summary 一条 user 消息取代。`compaction.boundary`（turnNo）作为**语义标注**保留在 log 里（供 06 自省与人读），投影以**事件位置**为准——对异常时序（如 boundary 回合的事件出现在 compaction 之后）更鲁棒。多个 compaction 取**最后一个**。
- **残缺 toolCalls 丢弃**（取消/崩溃后 resume）：assistant 声明了 `toolCalls` 却没有对应 `tool/result` 时，只保留 `content`。不补占位 `tool` 消息——03 不编造会话事实。
- **孤立 tool/result 跳过**：切点之后只剩结果、其 assistant 在切点之前被截掉时，该 tool 消息无主，投影会构造出 provider 必拒的请求。
- **空回复**：`content === ''` 且无有效 `toolCalls` 的 assistant 消息跳过（避免给模型发空消息）；content 空但有已执行的 toolCalls 则保留（合法且常见）。
- **纯函数**：不读盘、不改入参、同输入同输出；06 可在每 step 安全调用。

### 4.5 插件层与事件接线（`plugin.ts`）

```text
createSessionPlugin({ dir })
  setup(ctx, config?)                       # config = plugins[].config，narrow 为 { dir?: string }
    root = config?.dir ?? options.dir ?? path.join(os.homedir(), '.minidsh', 'sessions')
    store = createJsonlSessionStore({
      dir: root,
      onAppend: (id, e) => ctx.events.emit('session/append', { sessionId: id, event: e }),
      onWarn:   (m)     => ctx.log.warn(m),
      onError:  (m, x)  => ctx.log.error(m, x),
    })
    ctx.sessions.mount(store)               # 一次性注入；第二次 mount 由内核抛错
  dispose()
    await store?.settled()                  # 等在途写入落盘（可选链：X5 约定 dispose 必须容忍 setup 未完成）
    store?.clear()                          # 清内存缓存与订阅，不删文件
```

- 插件名固定 `builtin:session`；`registerSessionBuiltin()` = `registerBuiltin('session', createSessionPlugin())`，返回退订句柄（与 02 同式）。
- `dir` 若为相对路径，按 `process.cwd()` 解析（与 boot 解析本地插件路径同式）；非字符串或空串 → 抛错（转 BootError）。
- **store 拿不到 ctx** 是刻意的（D3）：诊断与广播经回调注入，store 本身零依赖内核。

## 5. 边界情况与错误处理

| 情况 | 行为 |
|---|---|
| `create` 时根目录不存在 | `mkdir(recursive)` 自动创建 |
| `create` 时目标 `session.jsonl` 已存在（id 碰撞或外部残留） | 抛 `SessionError{io}`，**绝不追加**（追加会混写两个会话，比失败更糟） |
| `create` 时 mkdir/写入失败（EACCES / ENOSPC） | `SessionError{io}`，会话未建立（不进缓存） |
| `open` 不存在的 id | `SessionError{not_found}`（**不静默新建**——输错 id 不该变成"开了新会话"，§8-Q5） |
| `open` 文件为空 / 第一个有效事件不是 header | `SessionError{corrupt}` |
| `open` / `list` 时中间行不是合法 JSON（崩溃留下的半行） | **跳过该行** + `onWarn`，继续；不抛（否则会话永久不可用，§8-Q6） |
| **上一次崩溃留下半行（无行尾 `\n`）后再次 `append`** | **先补一个 `\n` 封口再写新行**（review 期 **Y1** 修复，P1）。不补的话新事件会被**拼进那条坏行**，读侧按行解析时整行作废——一次崩溃就从"丢半行"变成"丢半行 + 丢崩溃后第一条"，且内存里有、磁盘上没有，**resume 后凭空消失** |
| `open` 时行是合法 JSON 但不是合法 `SessionEvent` | 同上：跳过 + `onWarn`（`validate.ts` 做最小结构校验，防畸形行让 06 崩在别处） |
| `open` 其它 IO 错误（EACCES / EISDIR） | `SessionError{io}` |
| `append` 到未 open 的 id | 先尝试从磁盘加载（resume 语义），失败则 `not_found` |
| 同进程并发 `append` | 写链串行，落盘顺序 = 调用顺序；内存 push 与派发随之同序 |
| 监听器抛错 | 捕获 → `onError`，其余监听器与 `append` 本身不受影响（`append` 是持久化路径，绝不因订阅者失败） |
| `subscribe` 未知 id | `SessionError{not_found}`（D9，不懒订阅） |
| `read` 未知 id | 同 `append`：先尝试加载，失败则 `not_found` |
| `read` 返回值被外部改写 | **数组层面隔离**（返回浅拷贝数组，增删不影响内部）；**事件对象是共享引用**——改写其字段会污染内存（**不影响磁盘**，resume 后恢复原样）。这是已记录的轻量约定：调用方不应改写（`store.ts` 的 `read` JSDoc 已写明）；不加防御性冻结，与"内核零策略"一致。探针 A3 实证确认 |
| 会话目录被人工重命名（目录名 ≠ header 里的 id） | **以文件里 header 记录的值为准**：`Session.meta.id` 取自 header，`Session.id` 取请求 id（二者正常相同）。不报 `corrupt`——人可能重命名目录来整理会话，比"改个名就让会话打不开"更宽容（X2） |
| 根目录里有散落文件（不是目录） | 跳过 + `onWarn`，`list()` 不崩（探针 B1 实证） |
| 超大事件行（>1MB 工具输出） | 照写；崩溃时可能留半行 → 读时跳过 + warn。**已知限制**：05 的输出截断是控制行长度的主防线，03 不二次截断 |
| 事件内容含换行 / 引号 / 中文 | `JSON.stringify` 天然转义，UTF-8 原样写入，往返无损 |
| `list()` 遇到损坏会话目录 | 跳过 + `onWarn`，其余照常返回（列表不该因一个坏目录整体失败） |
| dispose 后继续调用 store | 未定义；插件 dispose 后 `ctx` 不再使用（07 保证）。内核零策略，不加运行时防护 |
| `builtin:session` 未挂载（或 mount 前调用） | 容器抛 `'not mounted'`（M0 语义，集成链路 1 回归） |
| 会话规模超出内存 | **已知限制**：全量事件常驻内存。按 REPL 单次会话规模（数千事件）可接受；若 06 的压缩策略失效导致无限增长，属 06 的压缩阈值问题，不在 03 兜底 |
| `settled()` | 等待写链完成；`append` 本就已 await，正常路径无需调用，仅退出/测试用 |

## 6. 测试计划

### 6.1 单元测试（`src/session/*.test.ts`，与源码同目录）

**ids.test.ts（4 例）**：格式匹配 `/^\d{8}-\d{6}-[0-9a-z]{6}$/`；时间戳逐字段补零；连续 200 次不重复；随机段恒为 6 位 `[0-9a-z]`（科学计数法的 `e`/`-`/`.` 已被滤掉）。实绩 4 例。

**jsonl.test.ts（10 例）**：序列化为单行 + `\n`；中文/换行/引号/制表符往返无损；解析时去尾 `\r`、跳过空行；坏 JSON 与"合法 JSON 但结构不对"都返回 `undefined` 而不抛；两次追加后文件为两行且首行可单独读出；空文件 `readFirstLine` 返回空串；首行超预读窗口时退化为整文件读；**崩溃半行后追加会先补换行封口（Y1 回归）**。实绩 10 例。

**validate.test.ts（5 例）**：七个变体各一组合法样例通过；`type` 未知 → false；`user/message` 缺 `content` → false；`tool/result.result` 非对象 → false；`null` / 字符串 / 数组 → false。

**derive.test.ts（12 例）**：①`session/header` 与 `turn/*` 不投影；②user → assistant 顺序；③assistant 带 toolCalls + 后续 tool/result → 两者都投影且 `toolCallId` 关联；④**取消场景**：assistant 带 toolCalls 但无 result → toolCalls 被丢弃、只留 content；⑤**compaction**：切点后只剩新回合且 summary 作为首条 user 消息；⑥多个 compaction 取最后一个；⑦**孤立 tool/result**（切点后无对应 assistant）→ 跳过；⑧content 空且无 toolCalls 的 assistant → 跳过；⑨content 空但有已执行 toolCalls → 保留；⑩空输入 → `[]`；⑪多工具结果按 result 顺序投影；⑫投影不修改入参数组。

**store.test.ts（20 例，tmp 目录 + afterEach 递归清理）**：`create` 落盘（真实读文件断言首行是 header）；`create` 时文件已存在 → `{io}`；`append` 追加一行且内存同步；**并发 `append` 落盘顺序 = 调用顺序**（读文件逐行断言）；`append` 未 open 的 id → 从磁盘加载成功；`append` 未知 id → `{not_found}`；`open` 缓存复用（删文件后仍能 open）；`open` 不存在 → `{not_found}`；`open` 空文件 → `{corrupt}`；`open` 首事件非 header → `{corrupt}`；坏行跳过且 `onWarn` 被调用；`subscribe` 收到后续 append；`unsubscribe` 后不再收到；监听器抛错不影响 `append` 与其它监听器（`onError` 被调用）；`list()` 按 createdAt 降序且跳过损坏会话；`read()` 返回拷贝（改动返回值不影响后续 `read`）。

**plugin.test.ts（6 例）**：插件名固定 `builtin:session`；setup 向伪 ctx 的 `sessions.mount` 注入实现；`onAppend` 回调把事件转成 `session/append` 总线载荷（断言伪 `emit` 收到的 `{sessionId, event}`）；实例配置 `plugins[].config.dir` 可覆盖目录（断言文件真落在注入目录）；`config.dir` 非法（空串 / 非字符串）→ setup 抛错；dispose **容忍 setup 未完成**（X5 约定）且挂载后能清内存。实绩 6 例。

### 6.2 集成测试（`tests/integration/session.test.ts`，真实组合根 + 真实 tmp 目录）

1. **挂载与容器链路**：`registerSessionBuiltin()` → `boot({plugins:[{source:'builtin:session'}]})`（dir 注入 tmp）→ 断言收到 `plugin/mounted`；`create` → `read` 含 header；`list()` 含该会话 meta；**另一份配置不挂 `builtin:session`** → `create` 抛 `'not mounted'`（M0 容器语义回归）。
2. **落盘 + 投影链路**：create → append `turn/start` / `user/message` / `assistant/message`(带 toolCalls) / `tool/result` / `turn/end` → `read` → `deriveMessages` → 断言 messages 形态；并**真实读文件逐行断言 JSONL 内容**（验证持久化而非内存态）。
3. **事件广播链路**：boot 后 `ctx.events.on('session/append', …)` → append 一条 `user/message` → 断言收到 `{sessionId, event}`（验证插件把总线接进 store，D3 的接线点）。
4. **resume 链路（核心）**：create + append 若干事件 → `shutdown(ctx)` → 用**同 dir 新建插件实例** boot → `open(id)` → `read(id)` → 断言事件序列与写入前**逐项相等**（append-only 持久化 + 跨实例恢复，resume 的全部价值所在）。
5. **compaction 链路**：append 两个回合 → append `compaction{summary,boundary}` → append 第三个回合 → `deriveMessages` 断言只剩 summary + 第三回合。

fixture：`tests/integration/session-fixtures/`（与 01 的 `config-fixtures/`、02 的 `llm-fixtures/` 分开，理由同 01 X3：共用目录在 vitest 并行执行时互相踩踏）。每个用例用 `fs.mkdtemp` 建独立子目录，`afterEach` 清理。

## 7. 验收标准（DoD）

- [x] 本文档状态 **Reviewed**，且 §8 的 Q1–Q10 已拍板（2026-10-17 全部按建议项）；**Q1 的基线修订已执行完毕**（`architecture.md` 0.1.4 → 0.1.5，四处落点见 §2.5）
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（**238 例** = 02 交付时的 174 + 03 单测 57 + 03 集成 7）
- [x] 公共导出均有中文 JSDoc（用途/参数/返回值/副作用/错误行为）：`createJsonlSessionStore` / `createSessionPlugin` / `registerSessionBuiltin` / `createSessionId` / `deriveMessages` / `SessionError` 六项齐备
- [x] §6.1 单元测试点全部有对应用例且通过（`src/session/` 六个测试文件，**57 例**：ids 4 / jsonl 10 / validate 5 / derive 12 / store 20 / plugin 6）
- [x] §6.2 集成测试五条链路全部通过（`tests/integration/session.test.ts`，**7 例 / 5 链路**；`contexts` 在 afterEach 统一 shutdown，builtin 注册统一退订，fixture 目录 afterAll 清理）
- [x] `src/session/` LOC **902 行**（预算 ~1.5k，偏差方向为低于；分项见下）
- [x] **零运行时依赖**：`package.json` 的 `dependencies` 仍为空（JSONL 用 `node:fs/promises`，id 用 `Math.random`，无任何第三方）
- [x] 未改动 `contracts.ts` 中任何**既有**骨架签名（`SessionEvent` 变体集合、`Session` / `SessionMeta` / `SessionInit` / `SessionStore` 五个方法原样；仅按 Q1 新增 `read`）
- [x] `docs/PROGRESS.md` 已更新（03 步骤、LOC 实绩、04-prompt 的下一步动作）
- [ ] 所有者已 review 代码（自检已完成：读码 + 2 轮共 10 例临时探针实证，探针跑完即删不入库；发现并修复 1 个 P1，见下方 Y1）

**LOC 实绩**：`src/session/` **902 行** —— store 336 / jsonl 143 / plugin 112 / derive 95 / validate 92 / types 67 / ids 36 / index 21；另 `src/errors.ts` 增 `SessionError` **41 行**（属 M0 文件，单独计）。合计约 **0.94k**，低于 ~1.5k 预算。

**预算说明**：架构 §4 给 03 的 ~1.5k 是含"多版本迁移 / 压缩存储 / 附件 / 索引查询"的原始估计。按本次范围（D5–D7 砍掉迁移、附件、索引；不做 fsync/WAL）实绩为 0.94k，**偏差方向为低于预算**，理由与 02 同式：mini 版只保留"append-only + 全量投影"这一条主路径，持久强度按 REPL 工具而非数据库定位。相对设计初稿的 ~0.73k 估算多出的约 200 行主要来自两处：①`store.ts` 的错误分类与写链注释（每条 `SessionError` 都带 `kind` + `file` + `cause`）；②`validate.ts` 的七变体逐字段校验（92 行）——它换来的是"畸形行不会让 06 崩在与真正原因无关的地方"。若后续 06/07 提出会话删除、附件或索引需求再回头扩容，现在不预留。

### 偏离记录（实现期，编号 X）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | `list()` 采用"预读首行 8KB + 越界退化整文件读"，而非整文件读后取首行 | 设计 D7 只承诺"只解析首行"，实现把"只读首行"也做了：长会话（工具输出多）的 jsonl 可能数百 KB，列表时把全部文件整读一遍会明显拖慢 07 的 `/resume`。退化分支是防御：预读窗口内没遇到换行（理论上的超长 header）时退回整读，宁可多读一次，也不把半行误判成坏行让会话从列表消失 |
| X2 | `open()` 返回的 `Session.id` 取**请求 id**、`meta.id` 取**文件里 header 记录的值** | 二者正常相同；目录被人工重命名时以 header 为准（不报 `corrupt`）——人可能靠重命名目录整理会话，"改个名就让会话打不开"比"两个 id 字段偶尔不一致"更糟。探针 B6 实证 |

### 偏离记录（review 期修复，2026-10-17，编号 Y）

评审采用 02 确立的方式：读码 + 临时探针实证（2 轮共 10 例，探针跑完即删不入库）。

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| Y1 | **（P1）崩溃留下的半行会连带吞掉崩溃后第一条事件**：半行没有行尾 `\n`，下一次 `append` 的内容被拼进那条坏行，读侧按行解析时整行作废——一次崩溃从"丢半行"变成"丢半行 + 丢第一条"，且**内存里有、磁盘上没有**，resume 后凭空消失 | `appendLine` 写前检查文件末字节：非 `\n` 则先补一个换行"封口"再写新行（半行本身仍按坏行跳过） | 探针 A1：修复前用新实例从磁盘读只剩 header（`raw tail` 显示两条事件被并进同一行）；修复后磁盘上两条都在（已补 `jsonl.test.ts` 回归） |

**评审排除的误报**（探针证伪，记录以免后续重复怀疑）：

| 怀疑 | 结论 |
|---|---|
| 并发 `append` 会乱序 | **不成立**：探针 A2 的 10 次并发落盘顺序为 0…9（写链串行化生效） |
| 1MB 单行写入/读取有性能问题 | **不成立**：探针 B5 写入 + 新实例读取共 18ms |
| 根目录散落非目录文件会让 `list()` 崩 | **不成立**：探针 B1 跳过并告警，列表照常返回 |
| compaction 是最后一个事件时投影会出错 | **不成立**：探针 B4 只剩一条摘要 user 消息，符合 §4.4 规则 |
| `read` 返回的事件对象被改写会污染内部 | **成立但属已记录的约定**（探针 A3）：数组层面隔离、事件对象共享引用、不影响磁盘；不改（加防御性冻结违背内核零策略） |

## 8. 决策点记录

> **2026-10-17 所有者拍板：Q1–Q10 全部按建议项通过**，基线已同步至 0.1.5。

| # | 问题 | 决议 |
|---|---|---|
| Q1 | 是否给 `SessionStore` 加 `read(sessionId): Promise<SessionEvent[]>`（**改基线，0.1.4 → 0.1.5**） | **同意**（已执行）。现有契约只写不读，`deriveMessages` 无输入来源；三个替代方案分别违反灵魂 #2 / 需类型断言 / 违反"插件间不 import"。纯新增方法，影响面见 §2.5 |
| Q2 | 是否新增 `SessionError`（`kind: not_found / io / corrupt`） | **新增**（与 02 的 `LlmError` 同构）。07 对三种失败的提示完全不同，需要机器可判分类 |
| Q3 | sessions 目录是否进 `Config` | **不进**。默认 `~/.minidsh/sessions`，经 `plugins[].config = { dir }` 覆盖（这正是实例级配置的用途，且不回改 01） |
| Q4 | 会话 id 格式 | **`YYYYMMDD-HHmmss-<base36 6 位>`**。目录名字典序 ≈ 创建顺序（便于 `ls` 与人工排查），文件系统安全；不用 UUID |
| Q5 | `open` 不存在的 id 如何行为 | **抛 `not_found`**，不静默新建（静默新建会让"输错 id"变成"开了新会话"，用户感知为数据丢失） |
| Q6 | 读到坏行（崩溃留下的半行）如何处理 | **跳过 + warn，不抛**。结构性损坏（空文件 / 首有效事件非 header）才抛 `corrupt`——否则一次崩溃让会话永久不可用 |
| Q7 | 投影对"残缺 toolCalls"（assistant 声明了调用但无结果）如何处理 | **丢弃该 toolCalls**，不补占位 tool 消息（03 不编造会话事实）。不裁会让 provider 判 400（有 tool_calls 必须配 tool 消息） |
| Q8 | compaction 切点按"事件位置"还是"turnNo 过滤" | **按最后一个 compaction 事件的数组位置**。`boundary` 字段保留作语义标注；按位置对异常时序更鲁棒 |
| Q9 | 全量事件是否常驻内存 | **是**（mini 版单次会话规模可控），`read` 返回浅拷贝。见 §5 的已知限制 |
| Q10 | compaction 的 summary 以什么角色前置 | **`role:'user'`**。`ChatMessage` 只有 user/assistant/tool 三种形态，无 system（系统信息走 `LLMRequest.system`，由 04 拼装） |

### 附：本模块与 06 的职责边界

03 提供**事实的存储与投影**，06 提供**何时写什么**：06 决定回合边界（`turn/start` / `turn/end`）、何时 append `assistant/message`（含 `interrupted` 前缀）、何时压缩并生成 summary（`compaction` 事件的 `summary` / `boundary` 由 06 产出）。03 不参与任何运行时决策，也不读 `ctx.config`——它只知道"事件序列 → 消息序列"这一条纯函数关系。这与 02 的分工同构：02 只做"一次请求 → 事件流"，重试与压缩决策留给上层。
