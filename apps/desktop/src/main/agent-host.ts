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
 */
export function createProviderFactory(
  settings: SettingsStoreLike,
  logger: Logger,
): AgentProviderFactory {
  return {
    create(): ProviderConfig | undefined {
      const llm: LlmSettings = settings.get().llm
      const providerId = llm.active
      if (providerId === '') {
        logger.debug('尚未选择默认模型配置')
        return undefined
      }
      const config: LlmProviderConfig | undefined = llm.providers[providerId]
      if (config === undefined) {
        logger.warn('默认模型配置不存在', { providerId })
        return undefined
      }
      if (config.baseUrl.trim() === '' || config.model.trim() === '') {
        logger.warn('模型配置缺少 baseUrl 或 model', { providerId })
        return undefined
      }

      const apiKey = settings.getSecret(`llm.providers.${providerId}.apiKey`)
      if (apiKey === '') {
        logger.warn('模型配置缺少 API Key（可能加密不可用或尚未填写）', { providerId })
        return undefined
      }

      return {
        provider: new OpenAiCompatProvider({
          id: providerId,
          baseUrl: config.baseUrl,
          apiKey,
          defaultModel: config.model,
          onRetry: (info) =>
            logger.warn('LLM 请求重试', {
              providerId,
              attempt: info.attempt,
              code: info.code,
              delayMs: info.delayMs,
            }),
        }),
        model: config.model,
        temperature: config.temperature,
      }
    },
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
