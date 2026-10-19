# 09-plugin-mcp 设计

> 状态：**Baseline**（2026-10-19 所有者拍板 **§8 的 Q1–Q14 全部按建议项**；实现与测试完成后经**所有者 review**（读码 + 临时探针实证）通过，评审期修复 **Y1–Y2** 已回写 §7）
> 预算：~0.7k 行（架构 §4）
> 上游依赖：`00-skeleton.md`（Baseline，本地插件加载语义、dispose 契约）、`01-config.md`（Baseline，`plugins[].config` 注入与冻结、权限三值）、`04-prompt.md`（Baseline，**重点 §2.2 `PROMPT_ORDER` 与 D7 的信任边界文案、Y3 工具输出软约束**）、`05-tools.md`（Baseline，**重点 §8 附则"08/09 只 `ctx.tools.register(def)` 即享有管道"、§4 pipeline 顺序与截断、Y3 的 spawn error 监听**）、`06-agent.md`（Baseline，并发调度与取消边界）、`07-cli.md`（Baseline，**重点 §8 附则"与 08/09 的职责边界"、Y9 的 `BOOT_TIMEOUT_MS=15s`**）、`08-plugin-memory.md`（Baseline，**重点 §7 D1 的本地插件生产形态**）、`architecture.md` **0.1.9**（§5.1 插件协议、§5.2 服务面、§5.4 工具契约、§8 示例配置）

## 1. 背景与目标

09 是骨架的**第二个非内置插件**，也是唯一一个会**拉起子进程、走网络无关 IPC** 的模块：架构 §4 的"MCP stdio 客户端（tools/list + tools/call）"，落在 `plugins/mcp/`。它把 [Model Context Protocol](https://modelcontextprotocol.io) 生态接进 MiniDSH——外部工具 server 以子进程形式拉起，其工具注册进 05 的工具表，从此与内置工具在模型眼里没有区别。

对应骨架契约：

- architecture §5.1 挂载规则 2：本地插件经 `import()` 加载其 `default` 导出；08 的 D1 已把"产物形态"钉为 `dist/plugins/<name>/index.js`（0.1.8 订正）。
- architecture §5.4 工具契约：注册 `ToolDefinition` 即自动获得 schema 校验、权限门、截断、入 log。
- architecture §5.4 权限匹配规则：通配键 `mcp__*` 命中全部 MCP 工具（05 §8 附则：MCP 工具名**必须** `mcp__` 开头）。
- architecture §10 对照表："记忆 = MCP 生态（第三方 server）→ memory 插件 + mcp 插件，均非核心"。

**参考实现调研结论**（deepseek-harness `86a402200d`，`packages/mcp/mcp-client/`，约 1170 行产品代码 + 2800 行测试）：原版是一个**薄桥接层**——JSON-RPC 分帧、握手、分页、协议版本协商全部委托官方 SDK `@modelcontextprotocol/client` 2.2.0，自己只写四块：

1. **传输工厂**（46 行）：stdio spawn + 环境变量清洗（丢弃父环境中匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 的变量）；
2. **连接监督**（409 行）：代际管理、有界指数退避重连（500ms 起、30s 封顶、连续 10 次放弃、稳定 30s 后清零预算）、关闭确认屏障（防子进程重叠）；
3. **工具桥**（511 行）：`publicToolName` 命名算法、**两阶段原子注册交换**、结果内容投影（text/image/resource_link 与各自的降级占位）、`isError` → throw；
4. **插件生命周期**（203 行）：配置 schema、`apply()` 阻塞等待首次连接 + 工具发现完成。

对 mini 版的启示是**分工而非功能清单**：原版自己写的四块里，"命名契约"与"结果投影"是零依赖下也要写、且是外部行为可观察的部分；"重连监督"与"协议协商"是原版借 SDK 才有的余量，mini 应明确放弃（Q11 / Q5）。而 JSON-RPC 分帧这一块，原版**没有可抄的代码**（SDK 拥有），mini 必须自写——这是本模块 0.7k 预算的主要增量。

目标（一句话）：配置里列出若干 stdio MCP server，boot 时逐个拉起并完成握手与工具发现，其工具以 `mcp__<server>__<tool>` 之名注册进 05 的工具表模型即可调用，调用全过程经 05 的 guarded pipeline（权限门、截断、入 log）。

**非目标**（防范围膨胀，逐条对应原版能力与本模块的取舍）：

- **不做 HTTP / SSE transport**：仅 `stdio`（架构 §4 已定）；
- **不做重连**（Q11）：断连即永久失效，不做退避、不做代际管理、不做"工具暂时不可用"的中间态；
- **不做协议版本协商**（Q5）：固定声明一个版本，不实现 2024-11-05 ↔ 2026-07-28 的兼容矩阵；
- **不做 MCP resources / prompts / sampling / roots / elicitation**：原版也只支持"resources 按需读"，mini 连按需读都不做；
- **不做 `tools/list` 分页**（Q12）：只读第一页；
- **不做图像附件**：image/audio 块一律投影为占位文本（mini 无附件存储，02 也未做多模态）；
- **不做工具选择/过滤**：server 暴露多少工具就注册多少（登记遗留：工具多时 token 与选择准确率由用户自己承担，解法是别挂这个 server 或在权限里 `deny`）；
- **不做热插拔与 `/mcp` 命令**：07 §8 附则——命令是宿主主权，不为插件留缝；
- **不注册 prompt 段**（D4）：工具清单已由 05 的 `tools/catalog` 段承载，MCP 工具自动出现在其中；
- **不改 `contracts.ts` 任何签名、不改 `Config` 形状**（配置全走 `plugins[].config`）；
- **不做 `annotations`（readOnlyHint 等）到权限的映射**：权限是 01 的配置面，映射会引入"远端声明影响本地安全策略"的信任问题。

## 2. 对外契约

模块落在 `plugins/mcp/`。**它是本地插件，不进 `builtin:` 表**（07 §8 附则：默认插件表只列 `builtin:*`；08/09 由用户在配置里显式列出，走 F-02 信任确认）。boot 只取 `default` 导出（00 §4.1 `resolveFactory`），因此 `index.ts` 的默认导出是唯一硬性契约，其余导出服务测试与复用。

插件 import 的 SDK 面是 `src/index.ts`（架构 §3 不变量：插件不深引用内部路径）。本模块用到：`definePlugin` 与契约类型。

### 2.1 插件入口（`plugins/mcp/index.ts`）

```ts
/** 插件工厂（boot 经 `import()` 取此 default 导出）。 */
export default createMcpPlugin()
```

### 2.2 模块出口（`plugins/mcp/index.ts` 的具名导出）

```ts
/** 插件名（`plugin/mounted` 事件与 07 信任确认中显示的名字）。 */
export const MCP_PLUGIN_NAME = 'mcp'
/** 公开工具名前缀（05 §8 附则：`mcp__*` 通配键依赖此前缀）。 */
export const MCP_TOOL_PREFIX = 'mcp__'
/** 公开工具名长度上限（与命名算法配套，超长则截断 + 追加短哈希）。 */
export const MAX_PUBLIC_TOOL_NAME_LENGTH = 64
/** 单次 `tools/call` 的默认超时（毫秒）；可在 server 配置里覆盖。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** 单个 server 从 spawn 到 `tools/list` 返回的整体默认超时（毫秒）。 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

/** 单个 server 的启动规格（实例配置 `plugins[].config.servers[name]` 的形状）。 */
export interface McpServerSpec {
  /** 可执行文件；按 `process.cwd()` 之外的 PATH 查找，不做 shell 包装（Q10） */
  command: string
  args?: string[]
  /** 追加/覆盖给子进程的环境变量；值形如 `'$ENV:NAME'` 时取父进程同名变量（Q14） */
  env?: Record<string, string>
  cwd?: string
  requestTimeoutMs?: number
  startupTimeoutMs?: number
}

/** 插件/纯函数层的共同选项（生产全缺省；测试注入固定值或伪 spawn）。 */
export interface McpOptions {
  servers?: Record<string, McpServerSpec>
  /** spawn 注入口（02 的 `fetchImpl` 同式）：单测用它喂伪子进程，生产走 `child_process.spawn` */
  spawn?: SpawnLike
  /** 启动失败策略（Q4）：`'fail'` 让 setup 抛错转 BootError；`'tolerate'` 只记 log、该 server 零工具 */
  onStartupError?: 'fail' | 'tolerate'
}

/**
 * 公开工具名（模型看到的名字）：`mcp__<server>__<raw>`，非法字符替换为 `_`，
 * 超长则截断并追加短哈希防碰撞（§4.2）。原版同名算法，属 v1 契约。
 * @throws Error `server` 名不匹配 `/^[A-Za-z0-9_-]{1,32}$/`
 */
export function publicToolName(server: string, raw: string): string

/** 把 MCP 的 `inputSchema` 收窄为 05 的 `JsonSchema` 子集（§4.3）。 */
export function normalizeInputSchema(input: unknown): JsonSchema

/** 把 `tools/call` 的 `content` 数组投影为模型可见文本（§4.5）。 */
export function projectContent(content: unknown, rawName: string): string

/** 把远端工具定义 + client 组装成 05 的 `ToolDefinition`（§4.4）。 */
export function createMcpTool(server: string, def: McpRemoteTool, client: McpClient): ToolDefinition

/**
 * 构造 MCP 插件工厂：setup 内并行拉起全部 server、发现工具并注册。
 * 实例级配置 `plugins[].config = { servers?: {...}, onStartupError?: 'fail' | 'tolerate' }`。
 */
export function createMcpPlugin(options?: McpOptions): PluginFactory
```

### 2.3 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | **插件用 TS 编写，经 tsc 编译后从 `dist/plugins/mcp/index.js` 加载**；配置里的 `source` 指向**文件**而非目录 | 与 08 D1 同式：boot 的 `resolveFactory` 对非 `builtin:` 来源做 `path.resolve(cwd, source)` → `file://` → `import()`，Node ESM 不支持目录 import（`ERR_UNSUPPORTED_DIR_IMPORT`）。架构 §8 的 09 示例已随 0.1.8 订正为 `./dist/plugins/mcp/index.js` |
| D2 | **核心与插件分离**：命名/协议/投影是纯函数或可注入组件，插件只做配置 narrow + 接线 | 与 03 D3 / 04 D3 / 05 D3 / 06 D3 / 08 D2 同式：全部语义可脱离组合根单测（注入伪 spawn 与内存管道），插件退化为薄层 |
| D3 | **不新增错误类**：协议/IO/超时失败一律抛普通 `Error`，由 05 管道转 `execution_error` | 与 08 D3 同式：`errors.ts` 的四类按"阶段"划分，MCP 调用失败是工具执行期失败，架构 §5.4"错误是工具结果的一种"已覆盖 |
| D4 | **不注册 prompt 段** | 工具清单由 05 的 `tools/catalog` 段（order 350，每 step 现查 `ctx.tools.list()`）承载，MCP 工具自动出现在其中，无需 09 再出一段；原版注入的 "server instructions" 亦不做（省 ~0.1k，且跨 server 的指令文本进系统提示的收益不抵复杂度） |
| D5 | **spawn 与 log 可注入**（`McpOptions.spawn`） | 与 02 的 `createLlmPlugin({ fetchImpl })`、08 的 `MemoryOptions.file` 同式：单测要确定性驱动外部 IO 边界，注入优于在单测里真拉子进程（且 08 的 D2 已确立"纯函数 + 薄接线"） |
| D6 | **不支持工具注销**：工具在 setup 期一次性注册，进程内永久存在 | `ToolRegistry` 契约只有 `register/list/get`，无注销口子（架构 §5.2）；这直接决定了工具发现必须在 setup 内完成（§4.1），也决定了断连后工具仍留在表里（Q11 的取舍根源） |

## 3. 数据结构

```text
plugins/mcp/
├── types.ts      # 常量 + McpServerSpec / McpOptions + JSON-RPC 消息类型（~80 行）
├── naming.ts     # publicToolName + server 名校验（~45 行）
├── schema.ts     # normalizeInputSchema：MCP inputSchema → 05 的 JsonSchema 子集（~50 行）
├── result.ts     # projectContent：content 数组 → 模型可见文本（~50 行）
├── rpc.ts        # JSON-RPC 会话：行分帧 + 请求关联 + 超时（纯，可注入）（~110 行）
├── client.ts     # spawn + 行泵 + 握手 + tools/list + tools/call + dispose（~170 行）
├── tools.ts      # 远端工具定义 → ToolDefinition（~70 行）
├── plugin.ts     # narrow 配置 + 并行起 server + 注册 + dispose（~120 行）
└── index.ts      # default 导出 + 具名出口（~25 行）
```

预估合计 **~720 行**（预算 ~0.7k）。

### 3.1 配置形状（实例配置，与架构 §8 示例一致）

```jsonc
{ "source": "./dist/plugins/mcp/index.js",
  "config": { "servers": {
      "github": { "command": "npx",
                  "args": ["-y", "@modelcontextprotocol/server-github"],
                  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$ENV:GITHUB_TOKEN" } },
      "local":  { "command": "node", "args": ["./tools/my-server.mjs"], "requestTimeoutMs": 30000 }
  }}}
```

- server 名（`servers` 的键）是**本地命名空间**，约束 `/^[A-Za-z0-9_-]{1,32}$/`（原版同约束）：它是公开工具名的一部分，必须是可出现在函数名里的字符集。远端 `serverInfo.name` **不被采信**（远端自报的名字不受本地字符集约束，用它命名会让权限通配键与工具名都变得不可预期）。
- 键序即注册序（`Object.entries` 对字符串键保持插入序），保证系统提示里工具顺序确定。

### 3.2 协议消息类型

```ts
/** 出站请求（`id` 自增，含方法与参数）。 */
interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
/** 出站通知（无 `id`，不进等待表）。 */
interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
/** 入站消息：响应（有 `id`）与通知（无 `id`）在同一条流上，靠 `id` 区分。 */
type JsonRpcMessage =
  | { jsonrpc?: string; id: number; result?: unknown; error?: { code: number; message: string } }
  | { jsonrpc?: string; id?: undefined; method?: string; params?: unknown }
```

远端工具定义（`tools/list` 的元素，只取本模块用到的字段）：

```ts
interface McpRemoteTool {
  name: string
  description?: string
  inputSchema?: unknown   // 经 normalizeInputSchema 收窄后才交给 05
}
```

### 3.3 公开工具名规则（`publicToolName`）

```text
joined     = `mcp__${server}__${raw}`
normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
若 normalized === joined 且长度 ≤ 64 ⇒ 原样返回
否则 ⇒ 截断到 (64 - 12 - 1) 字符 + '_' + sha256(`${server}\0${raw}`) 前 12 位十六进制
```

- **wire 上永远用 `raw`**：`tools/call` 发 `params.name = raw`，公开名从不发给 server、也从不反解析（与原始版一致）。
- 清洗/截断是**有损**的，故追加短哈希保证不同 `(server, raw)` 永不碰撞（`mcp__s__admin.reset` 与 `mcp__s__admin_reset` 若不哈希会撞名，撞名会让 05 的容器抛 `already registered`）。
- 两阶段用法：两个 server 各有一个 `search` → `mcp__github__search` / `mcp__web__search` 共存。

## 4. 核心流程

### 4.1 插件 setup

```text
createMcpPlugin(options) → setup(ctx, config?)
  servers = narrowServers(config) ?? options.servers ?? {}
  clients = []
  # 并行启动（Q3）：每个 server 独立 spawn，各自受 startupTimeoutMs 约束
  results = await Promise.allSettled(entries.map(([name, spec]) => startServer(name, spec)))
  # 失败处置（Q4）：任一失败且 onStartupError='fail' ⇒ 先关掉已起的子进程，再抛错 → BootError
  # 注册序 = 配置键序（并行只影响等待，不影响注册顺序）
  for [name, r] of 按配置键序:
      if r.ok: for t of r.tools: ctx.tools.register(createMcpTool(name, t, r.client))
```

- **并行而非串行**（Q3）：启动是 IO 密集（npx 首次拉包动辄 10s+），串行会让 N 个 server 的启动耗时**求和**，两个慢 server 就会撞上 07 的 `BOOT_TIMEOUT_MS=15s`（07 Y9）；并行把总耗时从求和变成取最大。
- **注册在全部启动完成之后**：工具顺序只由配置键序决定，与完成先后无关（否则系统提示里工具顺序会随调度抖动）。
- **失败时先自清**：`Promise.allSettled` 后若决定抛错，先把本次已起的子进程全部 kill（不等它们退出），再抛。
  **表述订正（2026-10-19 评审实证）**：原写的"09 自己是抛错者，不会被 dispose"只对 **factory 阶段**失败成立（那时插件尚未进挂载序）；**setup 阶段**失败不同——boot 在调 setup **之前**就把插件 push 进挂载序（00 X5 的落点，`boot.ts` 5c），故 `failBoot` 里的 `shutdown` 会把 setup 抛错者一并逆序 dispose（探针 P10 实证：两个 mcp 实例撞名 ⇒ `BootError`，两个 fixture 子进程 pid 均退出）。自清仍然保留，理由改为：①更早（不必等逆序清理轮到自己）；②不依赖宿主是否走内核清理路径（直接 `createMcpPlugin` 的宿主可能不调 `dispose`）。00 §4.1 注释预告的场景本身依旧成立。
- **`narrowServers`** 沿用 04 Y1 / 08 的防线：配置非对象（**含数组**）→ 抛错；`servers` 非对象或是数组 → 抛错；server 名不匹配字符集 → 抛错；spec 非对象 → 抛错；`command` 非非空字符串 → 抛错；`args` 不是字符串数组 → 抛错；`env` 值非字符串 → 抛错。全部由组合根转 `BootError`（死配置早暴露）。

### 4.2 启动单个 server（`startServer`）

```text
spawn(spec)                                   # stdio: ['pipe','pipe','pipe']
  ├─ 'error' 事件（含 ENOENT）⇒ reject（05 Y3：不监听会 unhandled 'error' 炸进程）
  ├─ stderr 每行 ⇒ log.debug 截断后丢弃（Q13，绝不进工具结果）
  └─ stdout 按行 ⇒ rpc.receive(line)
await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},                        # 不声明任何客户端能力
      clientInfo: { name: 'minidsh-mcp', version: '0.1.0' } }, { timeoutMs: startupTimeoutMs })
  capabilities.tools 缺失 ⇒ 工具集视为空（仍算成功）
rpc.notify('notifications/initialized')
res = await rpc.request('tools/list', {}, { timeoutMs: startupTimeoutMs })
  res.nextCursor 存在 ⇒ log.warn 提示"该 server 还有更多工具未被发现"（Q12）
  同一 server 内 rawName 重复 ⇒ 视为非法响应 ⇒ 该 server 启动失败
return { client, tools }
```

- **整个启动序列共用一个 `startupTimeoutMs`**（含 spawn + initialize + tools/list）：省掉三处独立计时器，且用户可配的是"这个 server 起来最多等多久"这一个语义。
- **协议版本**：固定声明 `'2025-06-18'`，**不校验** server 回的 `protocolVersion`（Q5）。
- **Windows 的 `.cmd`**（Q10）：`npx` 在 Windows 上是 `npx.cmd`，直接 `spawn('npx')` 会 ENOENT。不做自动包装——`shell: true` 会引入 shell 注入面，自动补 `.cmd` 需要 PATH 探测；改为在 ENOENT 的错误消息里明确提示"Windows 下请写 `npx.cmd`"。

### 4.3 行分帧与请求关联（`rpc.ts`，纯）

```text
receive(line):
  line.trim() 为空 ⇒ 忽略
  解析失败（非法 JSON）⇒ 记 log.warn 并忽略（不炸流：一条坏行不该毁掉整条连接）
  无 id  ⇒ 通知：目前只忽略（mini 不消费 server 通知）
  有 id  ⇒ 取出等待者：
      error  ⇒ reject(Error(`MCP 错误 ${code}: ${message}`))
      result ⇒ resolve(result)
      未知 id ⇒ 忽略（迟到/重复响应）

request(method, params, { timeoutMs, signal }):
  id = ++counter
  send(JSON.stringify({ jsonrpc:'2.0', id, method, params }) + '\n')
  return Promise.race([
      pending（由 receive 兑现，并在 finally 里清定时器与 abort 监听）,
      timeoutMs 到时 ⇒ reject(Error(`MCP 请求 ${method} 超时（${timeoutMs}ms）`)),
      signal.abort ⇒ notify('notifications/cancelled', { requestId: id }) 后 reject(取消)
  ])
```

- **分帧是换行分隔的 JSON**（newline-delimited JSON，非 LSP 的 `Content-Length` 头），原版 SDK 亦如此——fixture 与真实 server 都按 `JSON.stringify(msg) + '\n'` 写。
- **取消时发 `notifications/cancelled`**（Q8）：best-effort（写到已关闭的 stdin 会抛 EPIPE，吞掉即可）。这让 server 有机会中止自己的长任务，与 07 的"取消要立刻见效"一致。
- **pending 表在连接关闭时统一 reject**（`failAll`）：否则子进程崩溃后挂在 `await` 上的工具调用永远不返回，回合会卡在那里。

### 4.4 工具执行（`tools/call`）

```text
createMcpTool(server, def, client) ⇒ {
  name: publicToolName(server, def.name),
  description: def.description?.trim() || `（MCP server ${server} 提供的工具 ${def.name}）`,
  schema: normalizeInputSchema(def.inputSchema),
  concurrency: 'parallel',                    # Q7
  execute(args, env):
      # 05 的管道已保证 args 通过 schema 校验；这里只需把它交出去
      result = await client.callTool(def.name, args,
                 { timeoutMs: spec.requestTimeoutMs, signal: env.signal })
      # 超时/取消由 callTool 内部 race，reject 后由管道判 execution_error / cancelled
      if (result.isError === true) throw new Error(projectContent(result))  # 让模型看到显式失败
      return projectContent(result.content, def.name)
}
```

- **`concurrency: 'parallel'`**（Q7）：JSON-RPC 的 `id` 关联天然支持在途并发，06 按 `config.tools.maxParallel`（默认 4）统一限流；MCP 调用是远端 IO，串行会让同一 step 内的 N 个调用耗时代数增长。
- **`isError` 必须抛**（与原版一致）：逐个步骤中"工具返回了错误但结果是 ok"是最坏的一类假象——模型会把它当成事实续写。
- **超时归属**（Q8）：05 的 `timeoutFor` 通道由 06 在 setup 时注入、实际只供 bash 用（05 §8 附则），09 作为插件拿不到该通道，故在 `execute` 内自己 race。代价是超时产出的错误码是 `execution_error` 而非 `timeout`（消息里写明"超时 N ms"），07 与模型都看得到原因。

### 4.5 结果投影（`projectContent`）

| MCP `content` 块 | 投影 |
|---|---|
| `{ type:'text', text }` | 按序 `\n` 拼接 |
| `{ type:'image' \| 'audio' \| 'resource' }` | 占位文本 `[不支持的 MCP 内容类型：<type>]`（mini 无附件存储） |
| `{ type:'resource_link', name, uri }` | `资源链接：<name>（<uri>）` |
| 空数组 / 非数组 / 字段缺失 | `（<rawName> 未返回可展示内容）` |

- 投影出的文本过长由 05 的 64k 中段截断兜底（05 §4.6），09 不再截一次。
- **stderr 永不进结果**（Q13）：server 的 stderr 是排障线索而非事实，且是不可信输入（PB-03 同式：注入面在工具输出侧，stderr 更脏）。

### 4.6 dispose

```text
dispose():
  for client of clients:  await client.dispose()
client.dispose():
  rpc.failAll(Error('MCP server 连接已关闭'))    # 先让在途调用返回，避免悬挂
  child.stdin.destroy()                          # 05 Y6 的经验：先断管道，进程握着管道时不会退出
  child.kill()
  await Promise.race([once(child, 'close'), delay(2000)])   # 等退出但绝不无限等
```

- **必须容忍 setup 未完成**（00 X5 派生的义务）：`clients` 可能为空或部分填充，dispose 不得假设全部起好了。
- **不等待孙进程**：`npx` 拉起的 node 是孙进程，`child.kill()` 只杀到 npx——这是与 05 F-04 **同源**的 Windows 局限（零依赖拿不到 Job Object API / 进程组 detach），登记为 F-05，不修代码。
- 2s 上限是为了不把 07 的退出流程挂住（07 另有 `Promise.race` 兜底，但 N 个 server × 无限等待会先耗尽它）。

## 5. 边界情况与错误处理

| # | 情况 | 行为 |
|---|---|---|
| 1 | 配置 `servers` 为空对象 / 未提供 | 插件正常挂载、零工具（用户先列着稍后填）；不视为错误 |
| 2 | 配置非法（非对象 / 数组 / server 名非法 / `command` 空 / `args` 非字符串数组 / `env` 值非字符串） | setup 抛错 → `BootError`（04 Y1 / 08 同防线） |
| 3 | spawn 失败（命令不存在、Windows 的 `npx`） | 按 `onStartupError` 处置（Q4）；错误消息提示 Windows 下用 `npx.cmd` |
| 4 | server 启动超时（spawn + 握手 + 发现超 `startupTimeoutMs`） | 同上；子进程被 kill |
| 5 | server 有响应但 `capabilities.tools` 缺失 | 该 server 零工具，算启动成功 |
| 6 | `initialize` 返回 JSON-RPC error | 按 Q4 处置（响应合法、协议层拒绝 ≠ 崩溃） |
| 7 | 同一 server 内 `tools/list` 出现重复 `rawName` | 该 server 启动失败（否则公开名撞车会让 05 容器抛 `already registered`，整个 boot 挂掉） |
| 8 | 公开名与既有工具撞名（`mcp__x__y` 已被别的插件占了） | 05 容器抛 `already registered` → `BootError`（M0 语义，不静默改名） |
| 9 | 调用超时 | `execute` reject → 管道产出 `execution_error`，消息含"超时 N ms"；连接保持可用 |
| 10 | 调用中回合被取消 | 发 `notifications/cancelled` → reject → 管道产出 `cancelled`；连接保持可用 |
| 11 | 调用期间子进程崩溃 | `rpc.failAll` 让在途调用 reject → `execution_error`（消息含"连接已关闭"）；该 server 此后**永久不可用**（Q11 不重连），工具仍在表里 |
| 12 | `tools/call` 返回 `isError: true` | 抛错 → `execution_error`，模型看到显式失败 |
| 13 | 模型传的参数不符 schema | 05 管道先拦（`invalid_args`），`execute` 根本不会被调用（08 评审误报 3 的同款结论） |
| 14 | `content` 为空数组 / 含未知块类型 | 占位文本（§4.5），不报错 |
| 15 | stdout 出现非法 JSON 行 | 记 `log.warn` 并忽略该行，连接继续（一条坏行不该毁掉整条连接） |
| 16 | `tools/list` 响应含 `nextCursor` | 记 `log.warn`（Q12 不做分页），本次仍只注册第一页 |
| 17 | 权限：默认配置 `permissions: {}` | 兜底 `ask`（01 既定），每个 MCP 工具首次调用都要用户点头；放开的写法是 `"mcp__*": "auto"`（架构 §8 示例给了 `ask`） |
| 18 | `permissions` 里 `mcp__github*` 与 `mcp__*` 同时存在 | 01 的"最长前缀"规则生效（架构 0.1.4），更具体的赢——这正是 `mcp__` 前缀约定的价值 |
| 19 | `builtin:tools` 未挂载（配置顺序写反） | `ctx.tools.register` 抛 `'not mounted'` → `BootError`，错误信息自明 |
| 20 | 09 未挂载 / 未配置任何 server | 05 的 `tools/catalog` 段不含 MCP 工具，其他一切照常 |
| 21 | 全局配置里启用本插件 | `source` 按 **cwd** 解析（M0 语义，不改）：须写**绝对路径**，与 08 §5 表 #11 同式取舍 |
| 22 | `--config-dir` 换了全局配置目录 | 不影响本插件（server 配置在 `plugins[].config` 里，与路径无关） |
| 23 | 子进程输出巨量 stderr | 每行截断后记 `log.debug`（Q13），管道持续被消费不会堵死 |
| 24 | `env` 值写 `'$ENV:NAME'` 但父进程没有该变量 | 该 server 启动**失败**（Q14），不静默传空值——空 token 会让 server 起来后每次调用都报鉴权错，比启动失败更难懂 |

## 6. 测试计划

### 6.1 单元测试（`plugins/mcp/*.test.ts`，与源码同目录）

**`naming.test.ts`（5 例）**：

1. 基本形态：`publicToolName('github', 'create_issue') === 'mcp__github__create_issue'`。
2. 非法字符清洗：`('s', 'admin.reset')` → `mcp__s__admin_reset_<12位hex>`（清洗只要有损就走哈希路径，§3.3 / 偏离 X4）。
3. 超长截断 + 哈希：长名产出 ≤ 64 字符、以 12 位十六进制结尾。
4. 防碰撞：`('s', 'admin.reset')` 与 `('s', 'admin-reset')`（清洗后撞车的一对）在截断场景下仍不同。
5. server 名非法（空 / 含空格 / 超 32 字符）⇒ 抛错。

**`schema.test.ts`（6 例）**：

6. 标准 `inputSchema` 直通（含 `required`）。
7. 根缺 `type` ⇒ 补 `'object'`；根 `type` 不是 object ⇒ 强制为 `'object'`（05 的 `validateArgs` 只认根为 object）。
8. `$ref` / `oneOf` / `format` / `default` 等关键字被丢弃（05 的 `asPropSchema` 只认六种 `type`，未知关键字不约束也不报错）。
9. `required` 非数组 ⇒ 丢弃；`additionalProperties` 非布尔（JSON Schema 允许是 schema 对象）⇒ 丢弃。
10. `properties` 非对象 ⇒ 置 `{}`（无参工具：`{ type:'object', properties:{} }`）。
11. 输出可直接喂 05 的 `validateArgs` 且不抛（与 05 的契约对齐，防"投影出的 schema 反而通不过 05 的校验"）。

**`result.test.ts`（5 例）**：

12. 多个 text 块按 `\n` 拼接。
13. `image` / `audio` / `resource` ⇒ 占位文本，且**不**把 base64 吐给模型。
14. `resource_link` ⇒ 含名称与 uri。
15. 空数组 / 非数组 / 缺失 ⇒ "未返回可展示内容"提示。
16. 未知块类型 ⇒ `[不支持的 MCP 内容类型：x]`。

**`rpc.test.ts`（8 例，伪 send + 喂行字符串，不拉子进程）**：

17. 请求行格式：`{ jsonrpc, id, method, params }` + `\n`，`id` 自增。
18. 响按 `id` 分发到正确的等待者（并发两个请求交错返回不乱序）。
19. 通知（无 id）不进等待表、不抛。
20. 未知 `id` 的响应被忽略。
21. 超时 ⇒ reject 且消息含方法名与毫秒数。
22. 外部 `failAll`（模拟子进程崩溃）⇒ 全部在途请求 reject。
23. 非法 JSON 行被忽略且不抛（`receive` 不炸）。
24. 取消 ⇒ 先发 `notifications/cancelled`（断言 `requestId` 与请求 id 一致）再 reject。

**`client.test.ts`（5 例，注入伪 spawn，与 02 的伪 fetch 同式）**：

25. 握手序列顺序正确：`initialize` → `notifications/initialized` → `tools/list`，且 `initialize` 的 `protocolVersion` / `capabilities` / `clientInfo` 形状符合 §4.2。
26. `capabilities.tools` 缺失 ⇒ 空工具集、不抛。
27. `tools/list` 返回的两个工具被解析为 `McpRemoteTool`；`nextCursor` 存在时记 warn 且仍只取一页。
28. `tools/call` 的 `params.name` 是 **raw**（不是公开名）。
29. 伪子进程 `'close'` ⇒ 在途调用收到"连接已关闭"。

**`tools.test.ts`（4 例）**：

30. `ToolDefinition` 形态：name 是公开名、`concurrency: 'parallel'`、`schema` 已归一。
31. `description` 缺失 ⇒ 兜底文案（含 server 名与 raw 名）。
32. `isError: true` ⇒ 抛错（执行后 catch 断言消息来自 content）。
33. 执行结果文本与 `projectContent` 一致。

**`plugin.test.ts`（9 例，伪 ctx + 伪 spawn）**：

34. 插件名与 default 导出形态（`{ name, setup }`，过 00 的 `assertPlugin` 语义）。
35. 注册数量 = 全部 server 的工具总数，且顺序按配置键序（并行完成序不同也不影响）。
36. narrow：合法配置通过；非法（配置是数组 / `servers` 是数组 / server 名含空格 / `command` 空 / `args` 非数组 / `env` 值非字符串）⇒ setup 抛错。
37. `onStartupError: 'fail'` ⇒ 启动失败时抛错，且**已起的子进程被 kill**（断言伪 spawn 的 kill 调用数 = 已起的 server 数）。
38. `onStartupError: 'tolerate'` ⇒ 启动失败时不抛，该 server 零工具，其余照常注册。
39. 空 `servers` ⇒ 挂载成功、零工具。
40. dispose：全部 client 被关；setup 未完成（抛错路径）时 dispose 不炸（00 X5 义务）。
41. `env` 的 `'$ENV:NAME'` 解析为父进程环境变量（Q14）。
42. `'$ENV:NAME'` 取不到 ⇒ 该 server 启动失败（按 Q4 处置），不静默传空值。

合计约 **42 例**（naming 5 / schema 6 / result 5 / rpc 8 / client 5 / tools 4 / plugin 9）。

### 6.2 集成测试（`tests/integration/plugin-mcp.test.ts`，真实组合根 + 真实子进程）

fixture 为仓库内 `tests/integration/mcp-fixtures/server.mjs`（单文件，按 argv 开关切换行为，约 60 行；与 03 的 `session-fixtures/` 同式，便于评审时阅读）：`--mode=echo`（握手 + 两个工具，其中一个 `isError`）、`--mode=slow`（`tools/call` 睡 5s，用于取消与超时）、`--mode=crash`（握手后立刻退出）、`--mode=notools`（无 `capabilities.tools`）。

1. **本地路径加载链路（本模块的核心验证）**：`boot({ plugins: [builtin:tools, { source: '<dist 或 TS 源的 mcp/index>', config: { servers: { demo: { command: process.execPath, args: [fixture, '--mode=echo'] } } } }] })` ⇒ 收到 `plugin/mounted`；`ctx.tools.list()` 含 `mcp__demo__echo`；`toToolSchemas` 含它（模型可见面）；`ctx.prompt.render()` 的 `# 可用工具` 段列出该工具（05 D4 惰性在真实链路成立）。
2. **端到端调用链路**：经 `createToolRunner`（权限 `auto` 注入）真实调用 `mcp__demo__echo` ⇒ 结果文本正确、`tool/result` 已入 session log（灵魂 #2：模型可见事实可追溯）。
3. **权限门链路**：`permissions: { 'mcp__*': 'ask' }` 且无审批处理器 ⇒ 失败关闭 `permission_denied`，且 **server 未被调用**（用标记文件断言：fixture 被调用时写标记，断言其不存在——05 Y8 的"标记判据"经验，防空断言）。
4. **取消链路**：回合信号 abort ⇒ 结果码 `cancelled`，且 fixture 侧收到 `notifications/cancelled`（同样用标记文件断言，**等事件而非等时间**——06 Y4 / 05 Y5 的教训）。
5. **isError 链路**：调用 `mcp__demo__boom` ⇒ 结果 `ok:false` 且 `error.code === 'execution_error'`，消息来自 server 返回的文本。
6. **启动失败链路**：`command` 指向不存在的文件 + `onStartupError: 'tolerate'` ⇒ boot 成功、无该 server 工具、其余链路不受影响（`'fail'` 路径在单测 37/38 覆盖，避免集成测试里制造 BootError 的清理噪声）。
7. **dispose 链路**：`shutdown(ctx)` 后子进程确实退出（`process.kill(pid, 0)` 抛 ESRCH），且 dispose 总耗时有上界。

## 7. 验收标准（DoD）

- [x] 本文档状态 **Reviewed**（§8 的 Q1–Q14 已由所有者拍板，2026-10-19 全部按建议项）
- [x] 实现落在**一个** package：`plugins/mcp/`（九文件，见 §3）
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（**660 例** = 08 交付的 608 + 本模块单测 45 + 集成 7）
- [x] §6.1 单测点与 §6.2 集成链路全部覆盖并通过（**实绩 45 例单测** = naming 5 / schema 6 / result 5 / rpc 8 / client 8 / tools 4 / plugin 9：client 除 29b「spawn error ⇒ 启动失败」外，评审期再补 25b「stdout 流错误不炸进程」与 30「startupTimeoutMs 是共用 deadline」；集成 7 链路全数落地，fixture 四模式全覆盖）
- [x] 工程脚手架改动仅限：`eslint.config.js` 增一条 `.mjs` 的 Node globals 声明（裸 ESM 夹具不过 tsc，`no-undef` 需要；见偏离 X2）。`tsconfig.json` / `vitest.config.ts` 未动——08 已把 `plugins/**` 加进 include
- [x] 公共导出全部有中文 JSDoc（用途/参数/返回值/副作用/错误行为）
- [x] 零运行时依赖（`dependencies` 仍为空；`child_process` / `crypto` / `readline` 均为 Node 内置）
- [x] 工具名一律以 `mcp__` 开头且经 `publicToolName` 产出（05 §8 附则），不写字面量
- [x] 未改 `contracts.ts` 任何签名、未改 01–08 实现代码（`git status` 复核：除上述 eslint 一条与文档外零触碰）
- [x] spawn 一律监听 `'error'` 事件，且 stdin/stdout/stderr 的管道 `'error'` 均有吞掉处理（05 Y3 教训的加强版）
- [x] dispose 容忍 setup 未完成（00 X5 义务），单 server 退出确认上限 2s、绝不无限等
- [x] LOC 实绩已按 `process.md` §6 口径统计并登记（见下）
- [x] 所有者已 review 代码（读码 + **两轮 11 例临时探针**实证，跑完即删；评审期修复 **Y1–Y2** 已回写 §7，补 2 例回归，门禁 **660 例**全绿）
- [x] 设计文档转 Baseline，`docs/PROGRESS.md` 已更新（**commit 待所有者确认**，流程第 ⑦ 步）

**LOC 实绩**：`plugins/mcp/` **1207 行**（预算 ~0.7k，**超 72%**；按 **2026-10-19 全项目规则"行数不设硬限制，可以超过"**（`AGENT.md` §4-4）**仅登记、不阻断**。分项：client **348** / rpc 227 / plugin 212 / types 131 / tools 70 / result 67 / naming 58 / schema 52 / index 42。测试另计 1257 行（单测 45 例 + 集成 7 链路 + fixture）。评审期 +27 行全部落在 `client.ts`（Y1 的 error 监听与 dispose 收流 14 行、Y2 的 deadline 与其注释 13 行）。

**预算观察**（规则不要求说明理由，此处仅留趋势数据）：超支结构与 08 一致——注释与防御性分支为主：①`client.ts`（预估 170 实绩 348）：死亡守卫（X3）、管道与 readline 双层 error 吞掉（Y1）、`$ENV:` 解析与 Windows ENOENT 提示各有整段 JSDoc；②`rpc.ts`（预估 110 实绩 227）：超时/取消/发送失败三路 settle 的幂等清理是正确性关键，注释密度高；③`plugin.ts`（预估 120 实绩 212）：narrow 防线七类非法形状的逐条校验与错误文案。逻辑行占比约一半。

**生产形态冒烟**：`pnpm build` 后 `dist/plugins/mcp/index.js` 可被 Node 直接 `import()`，default 工厂产出 `{ name: 'mcp', setup, dispose }`，`publicToolName('github', 'create_issue') === 'mcp__github__create_issue'`——架构 §8 示例配置（0.1.8 订正后）指向的产物形态真实可用。

### 偏离记录（实现期，编号 X）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | `createMcpTool` 增加第 4 参数 `requestTimeoutMs?: number`（§2.2 签名未列） | server 级超时（`McpServerSpec.requestTimeoutMs`）须随工具定义传入 execute 闭包；缺省回落 `DEFAULT_REQUEST_TIMEOUT_MS`，与文档签名兼容（可选参数） |
| X2 | `eslint.config.js` 增一条 `files: ['**/*.mjs']` 的 Node globals 声明 | DoD 原预期"无需改脚手架"，但 `.mjs` 集成夹具是裸 Node ESM 脚本、不经 tsc，`no-undef` 对 `process` / `setTimeout` 报错；一条声明是必要的最小改动 |
| X3 | `client.ts` 增加死亡守卫：spawn 'error' 或进程 'close' 后记录 `deadReason`，此后 `start` / `callTool` **入口即抛**该原因 | 设计 §4 未写明"连接死亡**之后**新发起的调用"的行为——单测 29 抓出的真实缺陷：`failAll` 只救在途请求，close 之后的新请求会挂到 60s 超时为止。补上后行为与 §5 表 11 语义一致（调用得到明确死因），且补全 Q11"不重连，死了就是死了"的完整语义 |
| X4 | 单测期望订正：§6.1 第 2 条原文"非法字符清洗 → `mcp__s__admin_reset`"与 §3.3 算法不一致 | 按 §3.3（也是原版算法），清洗只要有损（`normalized !== joined`）就走哈希路径——即使结果不长。实绩断言为 `mcp__s__admin_reset_<12位hex>`。算法为准，§6.1 该条系笔误 |
| X5 | 集成测试 7 条链路各显式声明 `20_000ms` 测试超时 | vitest 默认 5s；真实子进程（node 冷启动）在慢机器上 boot 就要 2–3s，链路 6 一次拉三个进程。显式放宽避免环境相关的假失败 |

### 评审记录（2026-10-19，读码 + 临时探针实证，探针跑完即删）

**方式**：逐行读码九文件（1207 行）+ 两轮共 **11 例临时探针**（`plugins/mcp/__probe.test.ts`、`__probe2.test.ts`，跑完即删、不入库）。探针的作用是**证伪**：读码阶段列了 9 条怀疑，实证后 2 条坐实为缺陷（Y1–Y2）、4 条证伪（M1–M4）、3 条为不改的观察（O1–O3）。

#### 修复（评审期，编号 Y）

| # | 偏离 | 理由 |
|---|---|---|
| Y1 | **两个 readline interface 自身未监听 `'error'`**（P2 真缺陷） | Node 的 readline 会把 input 流的 `'error'` **转发为 interface 的 `'error'`**；只给 `child.stdout` / `child.stderr` 装 noop 只吞掉了流那一层，interface 层无监听器时，一次 stdout 出错（EPIPE / ECONNRESET）就是 **uncaught exception ⇒ 整个 CLI 进程崩掉**（05 Y3 的同款教训）。DoD 原写"stdin/stdout/stderr 的管道 `'error'` 均有吞掉处理"，实际漏了这一层，声称的覆盖不成立。修法：给两个 interface 各装一个 noop `'error'`；顺带在 `dispose()` 内 `close()` 行泵并 `destroy()` stdout/stderr（F-05 孤儿进程握着读端时，未销毁的读端是活跃 handle，CLI 只能落到 bin 的 100ms 强制退出而非自然收尾）。**判据有效性**：补用例 25b，摘掉修复后该用例如实抛 `Error: read ECONNRESET` |
| Y2 | **`startupTimeoutMs` 是"每请求各计一份"而非"整个序列共用"**（P3，实现与 §4.2 文字不符） | §4.2 明写"整个启动序列共用一个 `startupTimeoutMs`（含 spawn + initialize + tools/list）"，但伪代码把同一预算分别传给两个请求，实现照伪代码写。实测（预算 600ms、两段各耗 400ms）：总耗时 **816ms 且成功**——默认 10s 时最坏 **~20s**，越过 07 的 `BOOT_TIMEOUT_MS=15s`，用户看到的是"插件挂载超过 15000ms 未返回"而不是"MCP server 启动失败"，诊断性反而更差，且 boot 超时后子进程要靠 bin 收尸。修法：`start()` 内取 `deadline`，两次请求分到**剩余时间**。代价：慢 server 的失败形态变成 `tools/list 超时（Nms）`，仍是自明文案。**判据有效性**：补用例 30，摘掉修复后该用例 `resolved "[{name:'echo'}]" instead of rejecting` |

#### 评审排除的误报（探针证伪，勿再怀疑）

| # | 怀疑 | 结论与证据 |
|---|---|---|
| M1 | 注册阶段 `ctx.tools.register` 抛错（工具撞名）⇒ 已 push 进 `clients` 的连接泄漏、子进程成孤儿 | **证伪**：boot 在调 setup **之前**就把插件 push 进挂载序（00 X5 / `boot.ts` 5c），setup 抛错者由 `failBoot` → `shutdown` 逆序 dispose。`__probe2` P10 **真实 boot 探针**：两个 mcp 实例撞名 ⇒ `BootError`，两个 fixture pid 在 5s 内**均退出**；伪 ctx 直调 `plugin.setup` 时看到 `[false,false]` 是因为绕过了内核（补调 `dispose()` 即 `[true,true]`）。**连带订正**：§4.1 原写"抛错者不会被 dispose"只对 factory 阶段成立，已订正 |
| M2 | `child.stdout!` 非空断言在 spawn ENOENT 下不安全（不存在的命令） | **证伪**：ENOENT 时 stdin/stdout/stderr **三个管道均非 null**（探针实测），`'error'` 事件随后送达并已转为 fatal reason |
| M3 | rpc 超时定时器 `unref()` 会让超时失效（进程可能在超时前退出） | **证伪**：200ms 预算实测 **206ms** 触发。`unref` 只影响"定时器是否拖住进程退出"，而调用方都在 await、且子进程管道本身是 ref'd handle |
| M4 | dispose 后 stdout 读端未销毁 ⇒ CLI 退出挂死 | **部分证伪**：`bin/mdsh.js` 有 100ms unref 兜底 `process.exit`，不会挂死；但会走强制退出而非自然收尾（stdout 可能未 flush 完）。故仍随 Y1 一并销毁读端，属加固而非修缺陷 |

#### 不改的观察（P3，登记）

| # | 观察 | 结论 |
|---|---|---|
| O1 | 配置 `servers: null` 被**静默忽略**，而数组等其它非法形状一律抛错 | `null` 与"未提供"在 JSON 里同义，narrow 统一放行；死配置早暴露的价值在此处很弱（后果只是零工具）。不改 |
| O2 | `description` 前后空白**原样透传**（§4.4 伪代码是 `?.trim()` 后的值） | 仅影响系统提示里的首尾空白，无害；改了反而与"原样呈现 server 自述"冲突。不改 |
| O3 | `isError` 为非布尔真值（如字符串 `'true'`）**不触发抛错** | `=== true` 是刻意的严格语义：放宽为真值判断会把 `isError: 'false'`（非空字符串）误判成失败。畸形 server 属例外，不改 |

### 附：与 05 / 06 / 07 / 08 的职责边界

- **05**：09 只 `ctx.tools.register(def)`，自动获得 schema 校验、权限门、截断、入 log；不自带管道、不自行 append `tool/result`。05 侧的既有义务（D4 惰性 render）在 09 挂载后自动成立。
- **06**：`toToolSchemas(ctx.tools.list())` 每 step 现场取，MCP 工具自动进模型可见面；06 按 `concurrency` 与 `maxParallel` 调度，不认识 MCP。06 的 `timeoutFor` 通道不向插件开放（Q8）。
- **07**：不认识本插件。用户启用方式 = 在配置里显式列出 `{ "source": "./dist/plugins/mcp/index.js", "config": {...} }`（项目配置走 07 的 F-02 信任确认；全局配置须用绝对路径）。`mcp__*` 的 `ask` 走 07 已有的同一条审批通道。07 不为 09 提供任何命令或诊断口子。
- **08**：与 09 互不知晓（架构 §3：插件间不 import 彼此）。两者都是 `plugins/` 下的本地插件，可同时挂载；工具命名空间不交叉（`memory` 无前缀，`mcp__*` 有前缀）。

## 8. 决策点记录

> **2026-10-19 所有者拍板：Q1–Q14 全部按建议项通过。**

| # | 问题 | 建议 |
|---|---|---|
| Q1 | transport 范围 | **只做 stdio**（架构 §4 已定），不做 HTTP/SSE。理由：stdio 是 MCP 生态的绝对主流（官方 server 默认形态），HTTP transport 要引入 URL 校验、header、重连语义，与 Q11 的"不重连"冲突时会变成半吊子 |
| Q2 | 配置形态 | **保持架构 §8 的 `servers` 地图**（一个插件实例管多个 server），不做"一个 server 一个插件实例"。理由：①架构 §8 的示例就是地图形态（0.1.8 已为 09 订正过 `source`），改它要动基线文档；②地图形态下 07 的 F-02 信任确认只弹一次；③启动失败策略（Q4）有全局与局部两个层次时，地图形态表达更自然 |
| Q3 | 启动并发 | **并行启动（`Promise.allSettled` + 各自超时），串行注册**。理由：npx 首次拉包动辄 10s+，串行求和会撞上 07 的 `BOOT_TIMEOUT_MS=15s`；并行取最大值。注册序固定为配置键序，保证系统提示稳定 |
| Q4 | 启动失败策略 | **默认 `fail`（fail-fast），提供 `onStartupError: 'tolerate'` 开关**。理由：骨架 00 的既定语义是"任一失败则启动失败，不做部分可用"，08 也把死配置早暴露做成硬防线；MCP server 起不来几乎总是配置错（命令不存在 / npx 离线 / Windows 的 `.cmd`），静默降级会让"我配了 github 工具但模型说没有"成为最难排查的一类问题。代价：挂了 server 的机器离线时 CLI 起不来——故留 `tolerate` 逃生口 |
| Q5 | 协议版本与握手 | **固定声明 `protocolVersion: '2025-06-18'`，不校验 server 回的版本**；`capabilities` 发空对象；必发 `notifications/initialized`。理由：`tools/list` / `tools/call` 在 2024-11-05 之后无破坏性变化，严格版本协商是几十行的兼容矩阵且不带来任何功能。登记为已知取舍 |
| Q6 | 工具命名 | **照抄原版 `publicToolName`**（`mcp__<server>__<raw>` + 非法字符替换 `_` + 超长截断追加 12 位 SHA-256 短哈希）。理由：这是业界通行形态（Claude Code / Codex 同形），也是 05 的 `mcp__*` 通配键成立的前提；哈希防碰撞让"撞名导致 05 容器抛错"不可能发生。server 名约束 `/^[A-Za-z0-9_-]{1,32}$/`，**不采信远端 `serverInfo.name`** |
| Q7 | `concurrency` | **`'parallel'`**（05 §8 附则的建议项）。理由：JSON-RPC 的 `id` 关联天然支持在途并发，06 按 `maxParallel`（默认 4）统一限流；MCP 是远端 IO，串行会把同一 step 内 N 个调用变成代数级耗时。风险：极少数 server 内部不处理并发——由用户在权限层 `deny` 或换 server，mini 不做探测 |
| Q8 | 超时与取消归属 | **09 在 `execute` 内自己 race**（默认 60s，可配 `requestTimeoutMs`），取消时先发 `notifications/cancelled` 再 reject。理由：05 的 `timeoutFor` 通道由 06 在 setup 时注入、实际只供 bash 用，09 作为插件拿不到。代价：超时产出的错误码是 `execution_error`（消息含"超时 N ms"）而非 `timeout`——两者对模型与用户都可读，不为它去改 06 的接线 |
| Q9 | 子进程环境变量 | **继承全部 `process.env`，配置 `env` 覆盖，不做密钥清洗**。理由：原版的清洗（丢弃匹配 `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 的变量）会连带洗掉 server 真正需要的 `GITHUB_PERSONAL_ACCESS_TOKEN`，用户必须逐个显式补回；mini 的信任模型（F-02/F-03 已登记）是"用户自己写的配置自己负责" |
| Q10 | Windows 下的 `.cmd` | **不做自动包装，ENOENT 时给出可操作错误信息**（提示"Windows 下请写 `npx.cmd`"）。理由：`shell: true` 引入 shell 注入面，自动补 `.cmd` 需要 PATH 探测（零依赖下不划算）。`npx` 是 MCP 生态最高频的启动方式，这条提示能省掉用户半小时 |
| Q11 | 重连 | **不做重连**。理由：原版那 409 行的连接监督（代际、退避、尝试预算、关闭确认屏障）是为"长驻服务 + 热重载"设计的；mini 无热卸载（架构 §10 已砍），且 D6 决定了工具一旦注册就不能注销——断连后留着工具名、调用时给出"连接已关闭"的明确失败，比"静默消失"或"半套工具"都好。代价：server 崩溃后需重启 CLI |
| Q12 | `tools/list` 分页 | **不做分页**，响应含 `nextCursor` 时记 `log.warn`。理由：mini 不做分页可省一条循环与"防死循环"上限保护；warn 让"工具少了"可被察觉而非静默。真实 server 一页装不下的工具量本身也是该被拒绝的配置 |
| Q13 | stderr 与结果投影 | **stderr pipe 后逐行截断记 `log.debug`，永不进工具结果**；结果只投影 `content`（text 拼接 / 非文本占位 / 空则提示 / `isError` 抛错）。理由：stderr 是排障的唯一线索（很多 server 把错误打印到 stderr），但它是不可信输入（PB-03 同式），给模型看等于开一条注入通道 |
| Q14 | 密钥如何进子进程 | **支持 `env` 值形如 `'$ENV:NAME'` 时取父进程同名变量**（取不到则该 server 启动失败，不静默传空）。理由：架构 §7 的既定原则是"API key 一律走环境变量，不落盘"，而 MCP server 普遍需要 token（github/filesystem 都要）——若不提供这条通道，用户只能把明文 token 写进 `minidsh.json`，而那是**项目级**配置文件、极可能被提交进版本库，等于为 0.7k 的模块引入一条违反架构原则的路径。成本约 15 行 + 2 例测试。代价：`'$ENV:'` 开头的字面量无法表达（现实中不存在这种需求） |
