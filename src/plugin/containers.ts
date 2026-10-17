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

/** 工具注册表实现：`register` 查重、`list` 只读快照、`get` 未注册抛错。 */
export class ToolRegistryImpl implements ToolRegistry {
  readonly #defs: ToolDefinition[] = []
  readonly #byName = new Map<string, ToolDefinition>()

  /** @throws 同名重复注册 */
  register(def: ToolDefinition): void {
    if (this.#byName.has(def.name)) throw new Error(errDuplicate('tool', def.name))
    this.#byName.set(def.name, def)
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

  /** @throws 同 id 重复注册 */
  section(s: PromptSection): void {
    if (this.#sections.has(s.id)) throw new Error(errDuplicate('prompt section', s.id))
    this.#sections.set(s.id, s)
  }

  /**
   * 拼装系统提示：每次调用都重新排序（section 数在 M0 很小，排序开销可忽略；
   * 若 05 把大量工具 schema 注册为 section 后再成为瓶颈，可在此加脏标记缓存）。
   * @throws section 的 render() 抛错时上抛（prompt 是每 step 的必经路径，不吞错）
   */
  render(): string {
    // order 升序为第一关键字，id 字典序为第二关键字（设计 §2.1 的既定排序规则）
    const sorted = [...this.#sections.values()].sort((a, b) =>
      a.order !== b.order ? a.order - b.order : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    return sorted.map((s) => s.render()).join('\n\n')
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
