# 02-llm 设计

> 状态：**Baseline**（2026-10-17 代码 review 通过并随模块提交归档；review 期修复 Y1–Y4 见 §7 偏离记录）
> 预算：~1.5k 行（架构 §4；本次范围预计 ~0.7k，见 §7 预算说明）
> 上游依赖：`00-skeleton.md`（Baseline，重点 §5.2/§5.4 的 LLM 契约与 `LlmRegistry` 容器实现）、`01-config.md`（Baseline，重点 §4.2 的 `model.*` 校验与 §5 边界表"apiKeyEnv 由 02 在使用点 fail-fast"）、`architecture.md` 0.1.4（§5.2 adapter 解析约定、§5.4 数据类型）

## 1. 背景与目标

02 交付架构灵魂 **#4（LLM adapter seam）** 的可运行形态：一个 `builtin:llm` 插件 + 一个手写 SSE 解析的 OpenAI 兼容流式客户端。DeepSeek 只是默认实现，provider 是可替换接口——但替换的方式是"往 `ctx.llm` 注册同名工厂"，不是改本模块。

对应骨架契约：

- architecture §5.2 `LlmRegistry { register(name, factory) / resolve(name) }`：M0 已交付容器实现（表为空），由 02 的 `builtin:llm` 在 setup 内 `register` 填充（eat own dogfood：LLM 能力本身也是插件）。
- architecture §5.4 `LlmAdapter { stream(req: LLMRequest): AsyncIterable<StreamEvent> }`、`LlmAdapterFactory = (model: ModelConfig) => LlmAdapter`、`StreamEvent` 四变体、`LLMRequest`。
- architecture §5.2 adapter 解析约定：**resolve 的 name 即 `config.model.provider`**（默认 `deepseek`），未知 provider 由 `resolve` 抛错、fail-fast。
- 01 §5 边界表：`apiKeyEnv` 指向的环境变量是否存在，**01 不校验**，由 02 取用时 fail-fast（该约定在本模块落地）。

目标（一句话）：让 06 只需

```ts
const factory = ctx.llm.resolve(ctx.config.model.provider)   // 'deepseek'
const adapter = factory(ctx.config.model)
for await (const ev of adapter.stream(req)) { /* text / tool-call / usage / end */ }
```

就能拿到按契约分好类的流事件，且全程**零运行时依赖**——SSE 手写、HTTP 用 Node 22 内置 `fetch`、解码用内置 `TextDecoder`。

**非目标**（明确不做，防范围膨胀）：

- 不做重试/退避、不做多 provider failover、不做非流式（`stream` 恒 `true`）。
- 不做 token 计数与上下文估算（06 的压缩阈值需要估算，归 06）。
- 不做 `response_format` / JSON mode / logprobs / seed / stop 等契约外字段透传。
- 不做 provider 特有扩展（如 DeepSeek 的 prompt cache 命中量不落 `TokenUsage`）。
- 不改 `StreamEvent` 变体集合——它是基线封闭表（M0 §5.4），错误一律以**抛异常**表达，不新增 `error` 变体。
- 不做 MCP（09）、不做本地模型的进程管理。

## 2. 对外契约

模块落在 `src/llm/`。导出面分两类（沿用 01 的 X6 约定：**宿主侧**只经 `src/llm/index.ts`；**插件侧**能力额外经 `src/index.ts` 转发，否则 06 只能深引用内部路径）。

### 2.1 宿主侧（`src/llm/index.ts`）

```ts
/** fetch 的最小形态（默认 `globalThis.fetch`，测试注入点） */
export type FetchLike = typeof globalThis.fetch

/** 插件实例级选项：生产不传，测试注入伪 fetch 用 */
export interface LlmPluginOptions {
  /** 注入的 fetch 实现；缺省用 `globalThis.fetch`（Node 22 内置） */
  fetchImpl?: FetchLike
}

/** adapter 构造选项（与插件选项同构，便于单测直接构造 adapter） */
export interface OpenAiAdapterOptions {
  fetchImpl?: FetchLike
}

/**
 * 构造 `builtin:llm` 插件工厂（可构造多份，各带自己的 fetchImpl）。
 * 插件在 setup 内向 `ctx.llm` 注册 `deepseek` 一个 provider（§8-Q1）。
 */
export function createLlmPlugin(options?: LlmPluginOptions): PluginFactory

/**
 * 把 `builtin:llm` 注册进内核 builtin 表（07 启动时调用，各 builtin 模块同式）。
 * @returns 退订句柄（测试可退订后换注自己的变体）
 * @throws Error 同名重复注册（内核语义）
 */
export function registerLlmBuiltin(): Unsubscribe

/**
 * OpenAI 兼容 adapter 工厂的落地实现（签名即 `LlmAdapterFactory`）。
 * 可直接单测，无需经组合根。
 */
export function createOpenAiAdapter(model: ModelConfig, options?: OpenAiAdapterOptions): LlmAdapter

/**
 * SSE 增量解析器（手写，零依赖）：喂入解码后的文本分片，吐出数据帧。
 * 可在任意字节边界切断输入（TCP 分片语义）。
 */
export class SseParser {
  push(chunk: string): SseFrame[]
  /** 流结束：尝试解析尾部未以空行终止的残帧 */
  flush(): SseFrame[]
}
export type SseFrame = { kind: 'data'; data: string } | { kind: 'done' }
```

### 2.2 插件侧（额外经 `src/index.ts` 转发）

```ts
/**
 * 工具调用增量聚合器（06 用，§8-Q3）。
 * OpenAI 线格式下 `id` / `name` 只在**首个分片**出现、`arguments` 需按 `index` 拼接——
 * 这是 provider 线格式知识，归 02 保管，06 不碰。
 */
export interface ToolCallAccumulator {
  /** 喂入一个 tool-call 增量（幂等：重复喂同一 delta 会重复拼接 arguments） */
  push(delta: ToolCallDelta): void
  /** 产出按 `index` 升序的完整调用列表 */
  result(): ToolCall[]
}
export function createToolCallAccumulator(): ToolCallAccumulator
```

### 2.3 新增运行时错误类

`LlmError extends Error`，落点 `src/errors.ts`（与 `ToolRejected` / `BootError` / `ConfigError` 同处，§8-Q2），经 `src/index.ts` 转发：

```ts
export type LlmErrorKind = 'config' | 'http' | 'network' | 'protocol' | 'aborted'
export class LlmError extends Error {
  readonly kind: LlmErrorKind
  /** HTTP 状态码；仅 kind==='http' 时有值 */
  readonly status?: number
}
```

与既有错误类的分工：`ConfigError` 在 `boot()` **之前**（配置加载期）、`BootError` 在 `boot()` 期间、`LlmError` 在**回合运行期**（06 调用 adapter 时）。三个错误类的生命周期互不重叠，07 可分别捕获并给出不同提示。

### 2.4 与骨架契约的差异说明（review 重点）

| # | 差异 | 理由 |
|---|---|---|
| D1 | 新增 `LlmError`（`src/errors.ts`） | 骨架只定 `ToolRejected` / `BootError`，运行期 LLM 失败无出口；`StreamEvent` 变体表是基线封闭的（M0 §5.4），不能加 `error` 变体，故错误只能以异常表达，而 06/07 需要机器可判的分类（`kind`） |
| D2 | `createOpenAiAdapter(model, options?)` 多一个可选参；`LlmAdapterFactory` 契约签名不变 | 契约的工厂只收 `model`，无法携带注入点。因此注入落在**更外层**（插件构造 `createLlmPlugin({fetchImpl})`），adapter 层保留同名可选参只为单测方便，不污染契约 |
| D3 | `createToolCallAccumulator` 经 `src/index.ts` 转发 | 它是**插件侧**能力（06 在回合循环里用）；不转发则 06 只能深引用 `src/llm/accumulate.js`，违反 M0 X6 |
| D4 | `stream()` 的**配置类**错误（缺 API key、signal 已 abort）在**调用点同步抛出**，而非首次 `next()` 时 | 契约签名 `stream(req): AsyncIterable<StreamEvent>` 不是 Promise，无法 `await` 校验；且 01 §5 明确"fail-fast 落在使用点"。同步抛出让"未设 API key"这类错误立刻出现在 06 的调用行，而不是藏到首次迭代 |
| D5 | 不做重试、不做超时（超时与退避不在 02） | 内核零策略：02 只做"一次请求 → 事件流"；重试语义（是否重发某回合）属 agent/CLI 决策。超时由调用方用 `AbortSignal` 自行实现（06 取消当前回合即 abort） |
| D6 | 请求 URL = `baseUrl`（去尾 `/`）+ `/chat/completions` | 契约只给 `baseUrl`，未定义端点路径；OpenAI 兼容面统一为 `/chat/completions`。`baseUrl` 的 URL 合法性由 01 §8-Q6 决议**不校验**，建连时自然失败 |
| D7 | `builtin:llm` **不在 setup 内自检** `config.model.provider` | 挂载顺序问题：若某第三方插件在 `builtin:llm` 之后注册另一个 provider，自检会把它误判为"未注册"而启动失败。故自检归使用点（06 首次回合 `resolve` 失败即 fail-fast），或由 07 在 REPL 就绪后做一次 |

## 3. 数据结构

```text
src/llm/
├── sse.ts          # SseParser：缓冲 + 空行切分 + data 行合并 + [DONE] + flush
├── wire.ts         # OpenAI 线格式：请求体构造 + ChatMessage/ToolSchema 映射 + chunk→StreamEvent
├── adapter.ts      # createOpenAiAdapter：fetch → SSE → StreamEvent 的编排与错误分类
├── accumulate.ts   # createToolCallAccumulator（delta → ToolCall[]）
├── plugin.ts       # createLlmPlugin / registerLlmBuiltin
└── index.ts        # 模块出口（宿主侧）
src/errors.ts       # + LlmError（D1，约 35 行，单独计）
```

**线格式子集**（只写本项目用得上的字段，未知字段一律忽略）：

```ts
// 请求体
{ model, messages, stream: true, stream_options: { include_usage: true },
  tools?: [{ type: 'function', function: { name, description, parameters } }],
  max_tokens?: number }

// 响应 chunk
{ choices?: [{ delta?: { content?: string
                         tool_calls?: [{ index: number; id?: string
                                         function?: { name?: string; arguments?: string } }]
                       }, finish_reason?: string | null }],
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
```

**映射规则**（§4.2/§4.3 详述）：

| `StreamEvent` | 来源 |
|---|---|
| `{type:'text', delta}` | `choices[0].delta.content` 为**非空字符串** |
| `{type:'tool-call', delta:{index, id?, name?, argumentsDelta?}}` | `choices[0].delta.tool_calls[i]`（`function.arguments` → `argumentsDelta`） |
| `{type:'usage', usage:{inputTokens, outputTokens, totalTokens?}}` | `usage.prompt_tokens` / `completion_tokens` / `total_tokens` |
| `{type:'end'}` | `data: [DONE]` 帧，或流提前 EOF |

## 4. 核心流程

### 4.1 `stream()` 时序

```text
stream(req)                                    # 普通函数（非 async generator）
 0. 同步校验（D4：调用点即失败）
      process.env[model.apiKeyEnv] 为空/空白 → throw LlmError{kind:'config'}（message 含环境变量名）
      req.signal.aborted                     → throw LlmError{kind:'aborted'}
 1. body = buildRequestBody(req)               # wire.ts，见 §4.2
 2. res = await fetchImpl(url, {method:'POST', headers, body, signal: req.signal})
      网络层 reject（DNS/ECONNREFUSED…）      → throw LlmError{kind:'network'}（message 含底层原因）
      AbortError                              → throw LlmError{kind:'aborted'}
 3. !res.ok（非 2xx）                          → text = await res.text()（截断 500 字符）
                                                throw LlmError{kind:'http', status: res.status}
 4. res.body 为 null                           → throw LlmError{kind:'protocol'}
 5. reader = res.body.getReader(); decoder = new TextDecoder('utf-8')
    try:
      while (true):
        { done, value } = await reader.read()
        done → parser.flush() → 处理残帧 → 若未发过 end 则 yield {type:'end'} → return
        for frame of parser.push(decoder.decode(value, {stream:true})):
          frame.kind === 'done' → yield {type:'end'}; return        # 标记 ended，不再解析后续
          frame.kind === 'data' → chunk = JSON.parse(frame.data)    # 失败 → {kind:'protocol'}
                                  for ev of toStreamEvents(chunk): yield ev
    finally:
      void reader.cancel().catch(() => {})   # 提前 break / abort / 异常都要关流，避免连接悬挂
```

要点：

- **同步校验先于网络**：缺 key 时一次请求都不发（集成测试链路 4 断言"fake fetch 未被调用"）。
- `stream()` 返回的是 AsyncIterable 对象；真正的网络动作发生在**首次 `next()`**（async generator 语义），但第 0 步的校验在调用点已完成。
- 多字节 UTF-8 被 TCP 分片切断由 `TextDecoder({stream:true})` 处理，不会出现半个汉字。
- `end` 事件**至多一次**：`[DONE]` 或 EOF，二者只取先到者。
- `usage` 只在 provider **真的给了**才发（§8-Q7：adapter 不编造零值），06 自行兜底。
- 02 **不写日志**：adapter 工厂签名只有 `model`，拿不到 `ctx.log`；诊断信息经 `LlmError` 上抛，由 06/07 决定如何呈现。

### 4.2 请求构造（`wire.ts`）

```text
buildRequestBody(req)
 url     = trimEnd(model.baseUrl, '/') + '/chat/completions'      # D6
 headers = { 'content-type': 'application/json',
             'authorization': `Bearer ${apiKey}`,
             'accept': 'text/event-stream' }
 messages = [ system ? {role:'system', content: req.system} : 无 ] ++ req.messages.map(toWireMessage)
 body    = { model: req.model, messages, stream: true, stream_options: {include_usage: true},
             ...(req.tools.length ? { tools: req.tools.map(toWireTool) } : {}),
             ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}) }
```

- `toWireMessage`：`user`/`assistant` 直映；`assistant.toolCalls` 非空时映为 `{id, type:'function', function:{name, arguments}}`；`tool` 映为 `{role:'tool', tool_call_id, content}`。
- `toWireTool`：`{type:'function', function:{name, description, parameters: t.schema}}`（`JsonSchema` 原样透传，05 产出即 OpenAI 兼容面）。
- `req.tools` 为空数组时**不发** `tools` 键（部分 provider 对空数组敏感）。
- `system` 为空/缺省时不插 system 消息（避免空串消息）。

### 4.3 SSE 解析（`sse.ts`）

缓冲 + 空行切分，容错优先：

1. 累积到 `buffer`，按 `\n\n` 切块（先按 `\n` 切行、每行去尾 `\r`，故 `\r\n\r\n` 同样生效）。
2. 块内逐行：以 `:` 开头 → 注释，跳过；只有 `data` 字段被读取，`event` / `id` / `retry` 等忽略；**多个 `data:` 行以 `\n` 连接**（RFC 8895）。
3. `data` 值为 `[DONE]` → 产出 `{kind:'done'}`，并**丢弃后续输入**（构造上表现为 adapter 直接结束迭代）。
4. 空 `data`（keep-alive 心跳）与无 `data` 字段的块 → 不产帧。
5. 未以空行终止的尾部：`flush()` 时尝试解析（容忍 provider 结尾不补空行），空缓冲不产帧。

### 4.4 工具调用聚合（`accumulate.ts`，§8-Q3）

```text
push(delta)  按 delta.index 分桶（Map<number, {id?, name?, args: string}>）
             首次出现的 id / name 写入后不再覆盖（后随分片只带 arguments）
             delta.argumentsDelta 追加到该桶的 args
result()     按 index 升序输出 ToolCall{ id: id ?? `call_${index}`, name: name ?? '', arguments: args }
```

- 缺失 `id` 时兜底 `call_<index>`：05/06 靠 `callId` 关联 `ToolResult` 与 `assistant/message.toolCalls`，空 id 会让关联链断裂，兜底比留空安全。
- 不校验 `index` 连续性（乱序到达也按 index 排序输出）。

## 5. 边界情况与错误处理

| 情况 | 行为 |
|---|---|
| `apiKeyEnv` 指向的环境变量未设置/空/纯空白 | `stream()` **同步**抛 `LlmError{kind:'config'}`，message 含环境变量名；**不发任何请求** |
| `req.signal` 调用前已 abort | 同步抛 `{kind:'aborted'}` |
| 网络失败（DNS、ECONNREFUSED、TLS） | `{kind:'network'}`，message 含底层原因（不重试，D5） |
| HTTP 非 2xx（含 401/429/500） | `{kind:'http', status}`，message 含响应体前 500 字符；**429/5xx 同样直接抛，不重试**（D5） |
| 响应 `body` 为 `null` | `{kind:'protocol'}` |
| 某个 SSE 帧不是合法 JSON | `{kind:'protocol'}`，message 带上该帧原文前 200 字符 |
| 某个 SSE 帧是合法 JSON 但**不是对象**（网关的 `data: null` 空闲帧等） | **忽略该帧，流继续**（review 期 Y3 修订）。容忍层在 adapter（编排层），`toStreamEvents` 保持线格式映射的严格抛错语义不变——为流末的空闲帧中断整条流，代价是丢掉已产出的模型输出与 usage |
| `[DONE]` 哨兵带尾随空格 / 冒号后多空格 | **仍识别为流结束**（review 期 Y1 修订）：比对哨兵前 trim。SSE 规范允许冒号后跟多个空格，实现只剥离第一个，故 `[DONE] ` 与 `  [DONE]` 都必须认——否则流末帧会被送进 `JSON.parse` 而抛 `protocol`，此时模型输出已产出、token 已消耗 |
| 迭代中 abort | fetch 以 AbortError reject → `{kind:'aborted'}`；`finally` 中 `reader.cancel()` |
| 调用方 `break` 提前退出 | generator `return()` → `finally` 中 `reader.cancel()`，**不抛错** |
| 流提前 EOF（无 `[DONE]`） | 补发一次 `{type:'end'}` 后正常结束 |
| `usage` 自始至终未出现 | 不发 usage 事件（Q7）；06 兜底零值 |
| `delta.content` 为空串 | 不发 `text` 事件（避免 06 空渲染） |
| 同一 chunk 同时含 content 与 tool_calls | 按序产出两个事件（text 在前） |
| provider 不认 `stream_options`（400） | 按 `{kind:'http'}` 上抛；**不降级重试**（已知风险，记入遗留表） |
| `model.baseUrl` 非法 / `name` 不存在 | 02 不校验，建连时以 http/network 错误呈现（01 §8-Q6 同理） |
| 并发多个 `stream()` | 无共享状态（adapter 无字段），互不干扰 |
| `builtin:llm` 的 dispose | **不实现 dispose**：无资源可释放（不持有连接，连接在单次 stream 内开关） |
| 请求构造期抛错（契约外畸形 `LLMRequest`，如缺 `tools`） | **原样抛 `TypeError`，不包装成 `LlmError`**（review 期 Y4 修订）。请求构造在 `try` **之外**：编程错误必须保持原样，否则 07 会把本地 bug 提示成"网络故障"，误导排查方向。契约内必填字段由 TS 类型保证，此路径只对 `as any` / JS 侧调用生效 |

## 6. 测试计划

### 6.1 单元测试（`src/llm/*.test.ts`，与源码同目录）

**sse.test.ts（~10 例）**：单帧解析；**帧被切成 3 片喂入**仍只产一帧；`\r\n\r\n` 终止；多 `data:` 行以 `\n` 合并；注释行 `:` 与 `event:`/`id:` 字段被忽略；`[DONE]`；心跳空 `data` 不产帧；无 `data` 字段的块不产帧；`flush()` 解析尾部残帧；`flush()` 对空缓冲不产帧。

**wire.test.ts（~9 例）**：请求体含 `model`/`stream`/`stream_options`/`messages`；`system` 缺省或空串时不插 system 消息；`assistant.toolCalls` 映为 function 形态；`tool` 消息映为 `tool_call_id`；`tools` 为空数组时不发 `tools` 键；`maxTokens` 缺省不发 `max_tokens`；chunk→事件（content / tool_calls / usage / 空 choices 无事件）；usage 字段映射；未知字段被忽略。

**adapter.test.ts（~11 例，注入 fake fetch，用真实 `Response` + `ReadableStream`）**：正常流事件序列（text → tool-call → usage → end）；多片 text 的 delta 原样透传；`[DONE]` 终结；EOF 无 `[DONE]` 也补发 end；HTTP 500 带响应体 → `{kind:'http', status:500}`；HTTP 401；网络 reject → `{kind:'network'}`；非法 JSON 帧 → `{kind:'protocol'}`；`body: null` → `{kind:'protocol'}`；**缺 API key 时同步抛**（断言 `expect(() => adapter.stream(req)).toThrow(LlmError)`，而非首次 `next()`）；迭代中 abort → `{kind:'aborted'}` 且 `reader.cancel` 被调用；提前 `break` → cancel 且不抛。

**accumulate.test.ts（~6 例）**：同 index 的 arguments 顺序拼接；多 index 按升序输出；`id`/`name` 以首次出现为准；缺失 id 兜底 `call_<index>`；空聚合 `result()` 为 `[]`；乱序到达仍按 index 排序。

**plugin.test.ts（~3 例）**：`createLlmPlugin()` 返回工厂、产物是 `{name, setup}` 插件；插件名固定 `builtin:llm`；未注入 `fetchImpl` 时也能构造 adapter（不实际发请求）。

### 6.2 集成测试（`tests/integration/llm.test.ts`，真实组合根，不打网络）

1. **注册与解析链路**：`registerLlmBuiltin()` → `boot({plugins:[{source:'builtin:llm'}]})` → 断言收到 `plugin/mounted`（`builtin:llm`）；`ctx.llm.resolve('deepseek')` 返回函数；**`resolve('openai')` 抛 `'not mounted'`**（Q1 决议的回归）；`shutdown(ctx)` 后 `registerLlmBuiltin` 的退订句柄可用（退订后重挂失败）。
2. **流式链路（注入 fetch 的真实 boot）**：`registerBuiltin('llm', createLlmPlugin({fetchImpl: fake}))` → boot → `resolve('deepseek')` → `factory(ctx.config.model)` → `stream(req)` → 断言事件序列与文本拼接结果；并由 fake 侧断言**请求**形态：URL 为 `<baseUrl>/chat/completions`、`authorization: Bearer <env>`、`stream_options.include_usage`、tools 已映射、`messages` 含 system。
3. **取消链路**：迭代中途 `controller.abort()` → 断言抛 `LlmError{kind:'aborted'}`，且 fake 侧记录的 reader 已被 cancel（无悬挂连接）。
4. **配置缺失链路（01 §5 的落点验证）**：临时删除/置空 `DEEPSEEK_API_KEY` → `stream()` 抛 `{kind:'config'}` 且 message 含 `DEEPSEEK_API_KEY`，**断言 fake fetch 一次都没被调用**（fail-fast 落在使用点、而非先建连再失败）。

fixture 目录：`tests/integration/llm-fixtures/`（与 01 的 `config-fixtures/` 分开，理由同 01 X3：共用目录会在 vitest 并行执行时互相踩踏）；本模块 fixture 主要是 fake fetch 脚本，放在测试文件内即可，目录仅在需要 `.mjs` 探针时创建。

## 7. 验收标准（DoD）

- [x] 本文档状态 **Baseline**，实现未偏离（差异仅限 §2.4 D1–D7 且已获同意；实现期偏离 X1–X3、**review 期修复 Y1–Y4** 见下方"偏离记录"，均不触碰契约签名）
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（**174 例** = 01 交付时的 114 + 02 单测 55 + 02 集成 5）
- [x] 公共导出均有中文 JSDoc（用途/参数/返回值/副作用/错误行为）：`createLlmPlugin` / `registerLlmBuiltin` / `createOpenAiAdapter` / `SseParser` / `createToolCallAccumulator` / `LlmError` 六项齐备
- [x] §6.1 单元测试点全部有对应用例且通过（`src/llm/` 五个测试文件，**55 例**：sse 16 / wire 13 / adapter 16 / accumulate 6 / plugin 4）
- [x] §6.2 集成测试四条链路全部通过（`tests/integration/llm.test.ts`，**5 例 / 4 链路**；`contexts` 在 afterEach 统一 shutdown，builtin 注册统一退订）
- [x] `src/llm/` LOC **647 行**（sse 119 / wire 174 / adapter 181 / accumulate 59 / plugin 58 / types 33 / index 23），另 `src/errors.ts` 中 `LlmError` 约 48 行（属 M0 文件，单独计）；均远低于 ~1.5k 预算（偏差方向为低于，理由见下方"预算说明"）
- [x] **零运行时依赖**：`package.json` 的 `dependencies` 仍为空，未引入 SSE/HTTP 相关库（SSE 手写、HTTP 用内置 `fetch`、解码用内置 `TextDecoder`）
- [x] 未改动 `contracts.ts` 中任何骨架签名（`StreamEvent`、`LlmAdapter`、`LlmAdapterFactory` 原样）
- [x] `docs/PROGRESS.md` 已更新（02 步骤、LOC 实绩、03-session 的下一步动作）
- [x] 所有者已 review 代码（2026-10-17，攻击式评审：3 轮探针共 19 例实证，**无 P0**；发现 1 个 P1 与 3 个 P2，已全部修复并补 6 例回归测试）
- [x] 设计文档状态更新为 Baseline，并按 process.md §5 提交

**预算说明**：架构 §4 给 02 的 ~1.5k 是含"多 provider 与重试策略"的初始估计。按本次决议（Q1 单 provider、D5 不重试、不做非流式）实绩为 **647 行 + `LlmError` 约 48 行 ≈ 0.70k**。**偏差方向为低于预算**：原因是本项目对 SSE 只取 `data` 字段的最小子集、不实现重连/重试/退避/多 provider 差异，且错误分类用 5 个 kind 就能覆盖 06/07 的分支需求。若后续 06/07 提出重试与非流式需求再回头扩容，现在不预留。（review 期修复使 `src/llm/` 由 628 → 647 行，增量 19 行全部来自容错分支与其回归测试说明，仍远低于预算。）

### 偏离记录（实现期撞到后补记，均不改契约签名）

| # | 偏离 | 理由 |
|---|---|---|
| X1 | 额外导出常量 `PROVIDER_DEEPSEEK`（`src/llm/types.ts` → `index.ts`） | provider 名在注册处（plugin.ts）与测试断言处都要用字面量；导出常量可避免两处字符串漂移，也让 07 的默认配置拼装有据可依。属新增导出，不影响任何既有签名 |
| X2 | `plugin.ts` 的 `registerBuiltin` 直接从 `../plugin/boot.js` 引入，而非绕回 `src/index.ts` | `src/index.ts` 会转发本模块的 `createToolCallAccumulator`，从 index 引入会形成 index → llm → index 的循环引用；`boot.js` 不反向依赖任何功能模块，取它无环。取用的仍是内核**导出**的注册函数，未触碰 `builtinPlugins` 表本身（M0 X6 的原意） |
| X3 | 取消（abort）路径**不断言** `reader.cancel()` 生效 | 实测：流因取消而 **errored** 后，`reader.cancel()` 按 Streams 规范是 no-op，底层连接由 `fetch` 的 signal 负责销毁。故"关流"的兜底改由"调用方提前 break"用例断言（那条流仍是 open 状态）。原设计 §5 表格未区分这两种退出，此处补明 |

### 偏离记录（review 期修复，2026-10-17）

评审采用攻击式方式：除读码外，另写 3 轮共 19 例临时探针做实证（探针跑完即删，不入库），**未发现 P0**。下列 Y1–Y4 为评审发现并已修复项，编号 `Y` 以区别于实现期的 `X`。

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| Y1 | **`[DONE]` 哨兵不容错**（P1）：`parseBlock` 只剥离冒号后一个空格、比对前未 trim，`data: [DONE] `（尾随空格）与 `data:  [DONE]`（多空格，SSE 规范允许）都不被识别，落入 `JSON.parse` 抛 `protocol`——**而失败发生在流末，此时模型输出已产出、token 已消耗**，整个回合却被判失败 | 比对哨兵前 `data.trim()`（边界表已同步） | 探针 K2/K3：修复前 `kind=protocol / invalid SSE payload: [DONE]` 且 `text` 事件已产出；修复后正常收尾（已补 `adapter.test.ts` 回归 + 2 例 `sse.test.ts`） |
| Y2 | **`flush()` 路径的 `[DONE]` 不置 `#done`**（P2）：`#drain` 的 `final` 分支漏了置位，导致 flush 产出 done 后再 `push` 仍被解析，与 push 路径及类自身 JSDoc"其后一切输入都丢弃"矛盾 | `final` 分支产出 done 帧后同样置位 | 探针 C1/I2：修复后再 push 返回 `[]`（已补 1 例 `sse.test.ts`） |
| Y3 | **非对象 SSE 帧中断整条流**（P2）：网关的 `data: null` 空闲帧被 `toStreamEvents` 判为"不是对象"而抛 `protocol`，丢掉已产出的输出 | 容忍层放 adapter 的 `frameEvents`：非对象帧（null / 数字 / 字符串 / 数组）**忽略**，`toStreamEvents` 保持线格式映射的严格抛错语义不变（故既有测试无需改动） | 探针 L1：修复前 `protocol / unexpected stream chunk`；修复后忽略并正常收尾（已补 1 例 `adapter.test.ts`） |
| Y4 | **请求构造错误被误分类为 `network`**（P2）：`buildRequestBody` 在 `try` 内，契约外畸形 `LLMRequest` 的 `TypeError` 被包装成 `LlmError{kind:'network'}`，07 会把本地 bug 提示成"网络故障" | 把 `buildRequestUrl` / `buildRequestBody` 移到 `try` **之外**，编程错误原样抛出 | 探针 G1：修复前 `kind=network`；修复后为 `TypeError` 且非 `LlmError`（已补 1 例 `adapter.test.ts`） |
| — | **U1 补记**：`finally` 中 `await reader.cancel()`，而设计 §4.1 伪代码是 `void ...`（不 await） | 保留 await：等待 cancel 完成使"已关闭"可被测试确定性观测（"提前 break"用例据此断言 `state.cancelled`）。属实现偏离设计伪代码，理由充分，登记备查 | `adapter.ts` 对应行注释已说明 |

**评审排除的误报**（探针证伪，记录以免后续重复怀疑）：

| 怀疑 | 结论 |
|---|---|
| 消费者在 `for await` 体内抛错会被 `catch` 误包装成 `network` | **不成立**：`for await` 体内 throw 由引擎直接传播，只触发 generator 的 `finally`，不进 `catch`；探针 A1 显示错误原样冒泡 |
| SSE 解析存在 `buffer.slice` 的 O(n²) 性能问题 | **不成立**：单个 chunk 含 8000 帧 / 1.1MB 仅 4.7ms，分 100 片喂入 2.6ms |
| `data:   x`（多空格）保留多余空格是 bug | **符合 RFC 8895**：冒号后最多一个可选空格，实现只剥离一个是正确的 |
| `LlmError` 的 `instanceof` 受编译目标影响 | **不成立**：`target` / `lib` 均为 ES2022，`ErrorOptions.cause` 原生支持 |
| HTTP 错误体被全量读入内存后再截断（P2-4） | **属设计取舍，非实现缺陷**：与设计 §4.1 伪代码一致。若 07 的错误提示场景在意，可改用 `response.body` 的 reader 按上限读取后再 cancel——**本次不改，登记备查** |

## 8. 决策点记录

| # | 问题 | 决议 |
|---|---|---|
| Q1 | `builtin:llm` 注册哪些 provider 名 | **只注册 `deepseek`**（默认 provider）。其它 provider 由后续模块或第三方插件自行 `register`——注册别名等于隐式承诺维护该 provider 的线格式差异。用户写 `provider:"openai"` 会以 `resolve` 抛 `'not mounted'` fail-fast（**已拍板 2026-10-17**） |
| Q2 | LLM 失败的错误出口 | **新增 `LlmError`**（`src/errors.ts`，`kind: config/http/network/protocol/aborted` + `status?`，经 `src/index.ts` 转发）。`StreamEvent` 变体表是基线封闭的，不能加 error 变体，只能抛异常；06/07 需要机器可判的分类而非靠 message 猜（**已拍板 2026-10-17**） |
| Q3 | tool-call 增量聚合归谁 | **02 提供 `createToolCallAccumulator` 并经 `src/index.ts` 转发**。线格式约定（`id`/`name` 只在首片、`arguments` 按 index 拼接）属 provider 知识，留在 adapter seam 内，06 不碰（**已拍板 2026-10-17**） |
| Q4 | 内置插件如何进表 + 测试如何避免打网络 | **`registerLlmBuiltin()` 显式注册（返回退订句柄）+ `createLlmPlugin({fetchImpl})` 可注入 fetch**。集成测试用自己的 `fetchImpl` 注册同名 builtin，仍走真实 boot，不 stub 全局 fetch（避免全局污染与并行竞态）（**已拍板 2026-10-17**） |
| Q5 | 是否做重试/退避 | **不做**（D5）。内核零策略：02 只做"一次请求 → 事件流"；重试属 agent/CLI 决策，超时由调用方用 `AbortSignal` 自行实现（**已拍板 2026-10-17**） |
| Q6 | `builtin:llm` 是否在 setup 内自检 `config.model.provider` | **不自检**（D7）。挂载顺序会让"后注册的 provider 插件"被误判成未注册而启动失败；自检归使用点（06 首次回合 resolve 失败即 fail-fast）或 07 的 REPL 就绪检查（**已拍板 2026-10-17**） |
| Q7 | provider 未给 `usage` 时是否补发零值 usage 事件 | **不补**。adapter 不编造数据；06 对缺失 usage 自行兜底零值（`TurnSummary.totalUsage` 需要一个值，兜底逻辑归 06）（**已拍板 2026-10-17**） |

### 附：本模块与 01 的关系

01 只保证"配置里有一个合法的 `model.{provider,name,baseUrl,apiKeyEnv}`"，并明确**不校验** `apiKeyEnv` 指向的环境变量是否存在（01 §5 边界表）。02 是这条约定的落点：`stream()` 的第一步就把环境变量取出来，缺失即 `{kind:'config'}` fail-fast——"fail-fast 落在使用点"的端到端验证见集成链路 4。
