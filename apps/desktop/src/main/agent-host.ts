/**
 * AgentHost 装配层（docs/02 §3.1、docs/06 §5）。
 *
 * 本文件只做"接线"：把 `SettingsStore` 的凭据、当前模式提示词、系统感知、
 * Skill 注册表与 MCP Hub 组装成内核需要的依赖，再交给 `KernelAgentHost`。
 * 真实逻辑全部在 `packages/agent-core`（纯 Node、可单测）。
 */
import {
  OpenAiCompatProvider,
  describeError,
  isLlmError,
  type AgentProviderFactory,
  type ProviderConfig,
} from '@aurora/agent-core'
import type { AgentEvent, AgentHost, LlmSettings, LlmProviderConfig } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import type {
  ModeManagerLike,
  PerceptionLike,
  SendMessageRequest,
  SettingsStoreLike,
} from './contracts.js'

export interface AgentHostOptions {
  settings: SettingsStoreLike
  modes: ModeManagerLike
  perception: PerceptionLike
  logger: Logger
  /** 已装配好的内核 AgentHost（由 index.ts 构造） */
  kernel: AgentHost
  /**
   * 敏感工具确认（docs/06 §5）。运行时由主进程注入内核的 `runAgentLoop.confirmTool`；
   * 未提供时保持 P3 行为（仅按 `sensitivity` 留痕、不阻断执行）。
   */
  confirmTool?: ConfirmToolDecision
}

/**
 * 敏感工具执行前的用户确认回调（docs/06 §5）。
 * 形状与 `@aurora/agent-core` 的 `AgentLoopOptions.confirmTool` 一致：
 * 由内核在工具 `sensitivity === 'confirm'` 时调用，`false` 表示用户拒绝执行。
 */
export type ConfirmToolDecision = (info: {
  name: string
  input: unknown
  sessionId: string
  sensitivity: 'confirm'
}) => Promise<boolean>

/** 确认载体（结构上由 `proactive.ts` 的 `ProactiveScheduler` 满足） */
export interface SensitiveToolConfirmerLike {
  requestSensitiveToolConfirm(input: {
    sessionId: string
    toolName: string
    input: unknown
  }): Promise<boolean>
}

/**
 * 包装内核 AgentHost：替换掉 P1 的占位回复，并在事件流出口补上
 * LLM 错误码的中文可操作提示（IPC 契约与渲染层无需改动）。
 */
export class DesktopAgentHost implements AgentHost {
  private readonly options: AgentHostOptions
  private readonly detach: () => void
  private readonly listeners = new Set<(event: AgentEvent) => void>()

  constructor(options: AgentHostOptions) {
    this.options = options
    this.detach = options.kernel.onEvent((event) => this.dispatch(event))
  }

  isReady(): boolean {
    return this.options.kernel.isReady()
  }

  send(request: SendMessageRequest): Promise<{ requestId: string }> {
    return this.options.kernel.send(request)
  }

  abort(requestId: string): boolean {
    return this.options.kernel.abort(requestId)
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 敏感工具确认钩子：由 `index.ts` 在装配内核时交给 `KernelAgentHost`，
   * 再由内核透传给 `runAgentLoop`（docs/06 §5）。未配置时为 `undefined`。
   */
  get confirmTool(): ConfirmToolDecision | undefined {
    return this.options.confirmTool
  }

  /** 供设置页 / 诊断使用：当前系统提示词预览。 */
  async buildSystemPromptPreview(): Promise<string> {
    return [this.options.modes.systemPrompt(), await this.options.perception.contextSummary()]
      .filter((part) => part !== '')
      .join('\n\n')
  }

  dispose(): void {
    this.detach()
    this.listeners.clear()
  }

  private dispatch(event: AgentEvent): void {
    const outgoing =
      event.type === 'error'
        ? { ...event, message: explainError(event.code, event.message) }
        : event
    for (const listener of this.listeners) {
      try {
        listener(outgoing)
      } catch (error) {
        this.options.logger.warn('Agent 事件监听器抛错', { error: String(error) })
      }
    }
  }
}

/**
 * 用当前设置即时构造 provider（每次请求都重新读取 + 解密）。
 * 这样在设置页改完 API Key / 模型后**无需重启**即可生效。
 *
 * `resolveFetch` 同理按调用即时取值：系统代理改完，下一次请求就走新代理
 * （docs/08 §6；在此之前 `advanced.proxy` 是个没有消费方的死字段）。
 *
 * `create({ allowFallback: true })` 额外提供**启动自愈**：默认条目不可用时临时回退到
 * 另一个可用条目（只影响本次请求构造，不写配置）。见下方 `fallback`。
 */
export function createProviderFactory(
  settings: SettingsStoreLike,
  logger: Logger,
  resolveFetch?: () => typeof fetch | undefined,
): AgentProviderFactory {
  /**
   * 用某个已配置条目构造 provider。
   * 返回 `undefined` 的原因都会记日志（缺 baseUrl / model / 可用 Key），
   * 因此自愈回退时跳过哪些条目是可查的；`quiet` 用于探测回退候选（那些条目本就不是
   * 当前默认，缺 Key 属于正常状态，不该刷 warn）。
   */
  const build = (
    providerId: string,
    config: LlmProviderConfig,
    quiet = false,
  ): ProviderConfig | undefined => {
    if (config.baseUrl.trim() === '' || config.model.trim() === '') {
      if (!quiet) logger.warn('模型配置缺少 baseUrl 或 model', { providerId })
      return undefined
    }

    const apiKey = settings.getSecret(`llm.providers.${providerId}.apiKey`)
    if (apiKey === '') {
      if (!quiet) logger.warn('模型配置缺少 API Key（可能加密不可用或尚未填写）', { providerId })
      return undefined
    }

    // 「思考等级」按用户设置透传给内核；`auto` 约定为「不下发 reasoning_effort」，
    // 在内核边界之前就映射成 undefined —— 其它层不许再判断 `'auto'`。
    const reasoningEffort = config.reasoningEffort === 'auto' ? undefined : config.reasoningEffort

    return {
      provider: new OpenAiCompatProvider({
        id: providerId,
        baseUrl: config.baseUrl,
        apiKey,
        defaultModel: config.model,
        ...(fetchImplOf(resolveFetch) === undefined
          ? {}
          : { fetchImpl: fetchImplOf(resolveFetch) }),
        onRetry: (info) =>
          logger.warn(info.reason === undefined ? 'LLM 请求重试' : 'LLM 请求降级重试', {
            providerId,
            attempt: info.attempt,
            code: info.code,
            delayMs: info.delayMs,
            ...(info.reason === undefined ? {} : { reason: info.reason }),
          }),
      }),
      model: config.model,
      temperature: config.temperature,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }

  /**
   * 启动自愈（docs/06 §12）：默认条目不可用时，临时借一个**确实可用**的条目把本轮请求建起来。
   *
   * 这件事只影响本次请求构造：**不写配置**（`llm.active` 改不改由用户或设置页决定），
   * 否则一次模型调用就会悄悄改掉用户的选择。
   *
   * 触发场景有二：AI 把 `llm.active` 写空 / 写成一个不存在的 id（见 `set_setting` 的黑名单与
   * `SettingsStore.sanitize` 的重置），或用户在配置文件里手改错了字段。
   */
  const fallback = (llm: LlmSettings): ProviderConfig | undefined => {
    for (const [id, candidate] of Object.entries(llm.providers)) {
      if (id === llm.active) continue
      const built = build(id, candidate, true)
      if (built !== undefined) {
        logger.warn('默认模型配置不可用，已回退到可用条目', { active: llm.active, fallback: id })
        return built
      }
    }
    return undefined
  }

  return {
    create(options?: { allowFallback?: boolean }): ProviderConfig | undefined {
      const llm: LlmSettings = settings.get().llm
      const providerId = llm.active
      if (providerId === '') {
        logger.debug('尚未选择默认模型配置')
        return allowFallbackOf(options) ? fallback(llm) : undefined
      }
      const config: LlmProviderConfig | undefined = llm.providers[providerId]
      if (config === undefined) {
        logger.warn('默认模型配置不存在', { providerId })
        return allowFallbackOf(options) ? fallback(llm) : undefined
      }
      const built = build(providerId, config)
      if (built === undefined && allowFallbackOf(options)) return fallback(llm)
      return built
    },
  }
}

/** 只有显式要求自愈时才回退：普通调用（如设置页「测试连接」）必须如实报告失败。 */
function allowFallbackOf(options?: { allowFallback?: boolean }): boolean {
  return options?.allowFallback === true
}

/** 取当前出网 fetch；解析失败按「未提供」处理，让内核回落到全局 fetch。 */
function fetchImplOf(resolveFetch?: () => typeof fetch | undefined): typeof fetch | undefined {
  if (resolveFetch === undefined) return undefined
  try {
    return resolveFetch()
  } catch {
    return undefined
  }
}

/**
 * 把主动引导的确认载体适配成内核需要的 `confirmTool` 钩子（docs/06 §5）。
 *
 * - 设置项 `advanced.confirmSensitiveTools` 关闭时**每次调用即时判断**并直接放行
 *   （改设置无需重启；内核仍会按 `sensitivity` 写日志留痕）；
 * - 确认链路自身失败时按"拒绝"处理：确认交互不可用时宁可不执行敏感工具。
 */
export function createConfirmTool(options: {
  proactive: SensitiveToolConfirmerLike
  enabled: () => boolean
  logger?: Logger
}): ConfirmToolDecision {
  return async (info) => {
    if (!options.enabled()) return true
    try {
      return await options.proactive.requestSensitiveToolConfirm({
        sessionId: info.sessionId,
        toolName: info.name,
        input: info.input,
      })
    } catch (error) {
      options.logger?.warn('敏感工具确认链路失败，按拒绝处理', {
        tool: info.name,
        error: String(error),
      })
      return false
    }
  }
}

/** LLM 错误 → 可操作的中文提示（IPC 层只做透传，文案集中在这里）。 */
export function explainError(code: string, message: string): string {
  if (isLlmErrorCode(code)) return describeError(code, message)
  return message
}

const LLM_ERROR_CODES = [
  'E_AUTH',
  'E_RATE_LIMIT',
  'E_TIMEOUT',
  'E_NETWORK',
  'E_NOT_FOUND',
  'E_BAD_REQUEST',
  'E_SERVER',
  'E_ABORTED',
  'E_UNKNOWN',
] as const

function isLlmErrorCode(code: string): code is (typeof LLM_ERROR_CODES)[number] {
  return (LLM_ERROR_CODES as readonly string[]).includes(code)
}

export { isLlmError }
export type { AgentHost, AgentEvent }
