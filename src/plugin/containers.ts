import type {
  AgentControl,
  AgentRegistry,
  LlmAdapterFactory,
  LlmRegistry,
  PromptRegistry,
  PromptSection,
  Session,
  SessionEvent,
  SessionInit,
  SessionMeta,
  SessionStore,
  SessionStoreContainer,
  ToolDefinition,
  ToolRegistry,
  Unsubscribe,
} from '../contracts.js'

/**
 * 各服务面容器的最小实现（设计 §3）。
 *
 * 容器全部由内核在 boot 时创建，readonly 引用注入 Ctx；
 * registry 型服务面（llm/tools/prompt/agent）由对应 builtin 插件 `register` 填充，
 * SessionStoreContainer 由 03 的 `builtin:session` 插件经 `mount` 注入。
 *
 * 错误约定：查重抛 `'already registered'` 类错误；未注册/未挂载抛 `'not mounted'`——
 * 在 setup 内抛出会被组合根转为 BootError（fail-fast）。
 */

/** 公共错误文案前缀，便于测试与排障断言。 */
const errDuplicate = (what: string, name: string): string => `${what} '${name}' already registered`
const errNotMounted = (what: string, name = ''): string => `${what}${name ? ` '${name}'` : ''} not mounted`

/**
 * LLM adapter 注册表实现：`register` 查重、`resolve` 未注册抛错。
 * resolve 的 name 即 provider 名（`config.model.provider`，架构 §5.2 解析约定）。
 */
export class LlmRegistryImpl implements LlmRegistry {
  readonly #factories = new Map<string, LlmAdapterFactory>()

  /** @throws 同名重复注册 */
  register(name: string, factory: LlmAdapterFactory): void {
    if (this.#factories.has(name)) throw new Error(errDuplicate('llm adapter', name))
    this.#factories.set(name, factory)
  }

  /** @throws 未注册 */
  resolve(name: string): LlmAdapterFactory {
    const factory = this.#factories.get(name)
    if (!factory) throw new Error(errNotMounted('llm adapter', name))
    return factory
  }
}

/** 工具注册表实现：`register` 查重 + 形状校验、`list` 只读快照、`get` 未注册抛错。 */
export class ToolRegistryImpl implements ToolRegistry {
  readonly #defs: ToolDefinition[] = []
  readonly #byName = new Map<string, ToolDefinition>()

  /**
   * 注册一个工具定义。
   *
   * 注册期校验形状（review Y8，与 `PromptRegistry.section` 的 Y10 防线同式）：
   * `ToolDefinition` 是 TypeScript 接口，外部 JS 插件不受编译约束。畸形定义
   * （name/description 非字符串、schema 非对象、execute 非函数）此前会一直
   * 漂移到运行期才在 HTTP 请求构造或调度处炸出，错误信息与罪魁祸首相距甚远。
   * `concurrency` 可缺省（缺省 = parallel，与调度侧约定一致），但给了就必须是
   * 两个合法值之一。
   *
   * @throws Error 形状非法或同名重复注册（setup 内抛出由组合根转 BootError）
   */
  register(def: ToolDefinition): void {
    if (typeof def !== 'object' || def === null) {
      throw new Error('tool definition must be an object')
    }
    const { name, description, schema, concurrency, execute } = def
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('tool definition: `name` must be a non-empty string')
    }
    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error(`tool '${name}': \`description\` must be a non-empty string`)
    }
    if (typeof schema !== 'object' || schema === null) {
      throw new Error(`tool '${name}': \`schema\` must be an object`)
    }
    if (concurrency !== undefined && concurrency !== 'exclusive' && concurrency !== 'parallel') {
      throw new Error(`tool '${name}': \`concurrency\` must be 'exclusive' | 'parallel'`)
    }
    if (typeof execute !== 'function') {
      throw new Error(`tool '${name}': \`execute\` must be a function`)
    }
    if (this.#byName.has(name)) throw new Error(errDuplicate('tool', name))
    this.#byName.set(name, def)
    this.#defs.push(def)
  }

  /** 返回注册顺序的只读快照（浅拷贝，调用方增删不影响注册表）。 */
  list(): ReadonlyArray<ToolDefinition> {
    return [...this.#defs]
  }

  /** @throws 未注册 */
  get(name: string): ToolDefinition {
    const def = this.#byName.get(name)
    if (!def) throw new Error(errNotMounted('tool', name))
    return def
  }
}

/**
 * prompt section 注册表实现：`render` 按 order 升序、同 order 按 id 字典序，
 * 以 `\n\n` 拼接——**系统提示的唯一出口**（架构 §5.2 装配语义）。
 */
export class PromptRegistryImpl implements PromptRegistry {
  readonly #sections = new Map<string, PromptSection>()

  /**
   * 注册一个 prompt section。
   *
   * 注册期校验形状（review Y10）：`PromptSection` 是 TypeScript 接口，而外部 JS
   * 插件不受编译约束。此前只查 id 重复，若插件传入 `order: NaN`，排序比较器返回
   * `NaN`（JS sort 视为相等），"同 order 按 id 字典序"的约定被绕过，段序退化为
   * 注册顺序——系统提示的排版会无声漂移。`id` / `render` 同理。
   *
   * 存**冻结副本**：插件注册后改写自己对象上的 `id`/`order` 不影响注册表（渲染
   * 仍用其 `render` 闭包）。
   *
   * @throws Error 形状非法或同 id 重复注册（setup 内抛出由组合根转 BootError）
   */
  section(s: PromptSection): void {
    if (typeof s !== 'object' || s === null) {
      throw new Error('prompt section must be an object')
    }
    const { id, order, render } = s
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('prompt section: `id` must be a non-empty string')
    }
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new Error(`prompt section '${id}': \`order\` must be a finite number`)
    }
    if (typeof render !== 'function') {
      throw new Error(`prompt section '${id}': \`render\` must be a function`)
    }
    if (this.#sections.has(id)) throw new Error(errDuplicate('prompt section', id))
    this.#sections.set(id, Object.freeze({ id, order, render }))
  }

  /**
   * 拼装系统提示：每次调用都重新排序（section 数在 M0 很小，排序开销可忽略；
   * 若 05 把大量工具 schema 注册为 section 后再成为瓶颈，可在此加脏标记缓存）。
   *
   * **渲染结果为空串的段会被跳过**（04 设计 D2/Q4）：条件段（无工具时的 tool-use、
   * 无 MEMORY 文件时的 memory 段）返回 `''`，不过滤会拼出连续 `\n\n\n`，且无从
   * 判断段是否生效。只过滤**严格空串**，不 trim——段作者的首尾空白属其排版意图。
   *
   * @throws section 的 render() 抛错时上抛（prompt 是每 step 的必经路径，不吞错）
   */
  render(): string {
    // order 升序为第一关键字，id 字典序为第二关键字（设计 §2.1 的既定排序规则）
    const sorted = [...this.#sections.values()].sort((a, b) =>
      a.order !== b.order ? a.order - b.order : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    const parts: string[] = []
    for (const s of sorted) {
      const text = s.render()
      if (text === '') continue
      parts.push(text)
    }
    return parts.join('\n\n')
  }
}

/**
 * 会话存储容器（设计 D1）：委托式容器，真实实现由 03 的 `builtin:session`
 * 插件在 setup 时经 `mount(impl)` 一次性注入。
 * 未 mount 前所有 `SessionStore` 方法抛 `'not mounted'`；第二次 `mount` 抛错。
 */
export class SessionStoreContainerImpl implements SessionStoreContainer {
  #impl: SessionStore | undefined

  /** @throws 第二次调用（一次性注入通道） */
  mount(impl: SessionStore): void {
    if (this.#impl) throw new Error('session store already mounted')
    this.#impl = impl
  }

  /** 取已注入的实现；未注入则抛 `'not mounted'`。 */
  #store(): SessionStore {
    if (!this.#impl) throw new Error(errNotMounted('session store'))
    return this.#impl
  }

  /** Promise 方法经 async 包装：未挂载时以 rejection 而非同步异常呈现（Promise 契约面）。 */
  async create(opts: SessionInit): Promise<Session> {
    return this.#store().create(opts)
  }

  async open(id: string): Promise<Session> {
    return this.#store().open(id)
  }

  async list(): Promise<SessionMeta[]> {
    return this.#store().list()
  }

  async read(id: string): Promise<SessionEvent[]> {
    return this.#store().read(id)
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    return this.#store().append(sessionId, event)
  }

  subscribe(sessionId: string, fn: (e: SessionEvent) => void): Unsubscribe {
    return this.#store().subscribe(sessionId, fn)
  }
}

/**
 * agent 注册表实现：单槽位（M0 一个进程只有一个 agent loop）。
 * `register` 重复注册抛错；`resolve` 未注册抛 `'not mounted'`。
 */
export class AgentRegistryImpl implements AgentRegistry {
  #ctl: AgentControl | undefined

  /** @throws 重复注册 */
  register(ctl: AgentControl): void {
    if (this.#ctl) throw new Error('agent control already registered')
    this.#ctl = ctl
  }

  resolve(): AgentControl {
    if (!this.#ctl) throw new Error(errNotMounted('agent control'))
    return this.#ctl
  }
}
