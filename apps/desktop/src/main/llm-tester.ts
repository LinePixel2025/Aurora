/**
 * LLM 连接测试（docs/04 §P1、docs/08 §5）。
 *
 * 凭据只在主进程解密后用于构造 provider，永不回传渲染层。
 */
import type { ModelInfo, TestConnectionResult } from '@aurora/agent-core'
import type { LlmProviderType, Logger } from '@aurora/shared'
import type { LlmTesterLike, SettingsStoreLike } from './contracts.js'
import { createLlmProvider } from './llm-provider.js'

export interface LlmTesterOptions {
  settings: SettingsStoreLike
  logger: Logger
  /** 测试连接的有效超时（比对话短，避免设置页长时间等待） */
  timeoutMs?: number
  /**
   * 当前出网 fetch（docs/08 §6 系统代理）。
   * 「测试连接」必须走与真实请求同一条网络路径，否则会出现
   * 「测试通过但实际对话失败」（或反之），是最难排查的一类假阳性。
   */
  resolveFetch?: () => typeof fetch | undefined
}

export interface LlmTestRequest {
  providerId?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  /** 接口协议（v22）：渲染层把正在编辑的类型一并送来，未保存也能测到正确的端点 */
  type?: LlmProviderType
  withModels?: boolean
}

/** `resolve` 的产物：构造 provider 所需的全部目标信息（含接口协议）。 */
interface ResolvedLlmTarget {
  id: string
  baseUrl: string
  apiKey: string
  model: string
  /** 未指定时为 `undefined`，由 `createLlmProvider` 按 `openai-compat` 兜底 */
  type: LlmProviderType | undefined
}

export class LlmTester implements LlmTesterLike {
  private readonly settings: SettingsStoreLike
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly resolveFetch: (() => typeof fetch | undefined) | undefined

  constructor(options: LlmTesterOptions) {
    this.settings = options.settings
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.resolveFetch = options.resolveFetch
  }

  async test(request: LlmTestRequest): Promise<TestConnectionResult> {
    const resolved = this.resolve(request)
    if ('error' in resolved) {
      return { ok: false, latencyMs: 0, message: resolved.error }
    }
    const provider = this.createProvider(resolved)
    const result = await provider.testConnection()
    if (result.ok && request.withModels !== false) {
      // 保留返回的模型列表，供设置页展示
      this.logger.info('LLM 连接测试成功', {
        provider: resolved.id,
        latencyMs: result.latencyMs,
        models: result.models?.length ?? 0,
      })
    } else if (!result.ok) {
      this.logger.warn('LLM 连接测试失败', { provider: resolved.id, message: result.message })
    }
    return result
  }

  async listModels(request: LlmTestRequest): Promise<ModelInfo[]> {
    const resolved = this.resolve(request)
    if ('error' in resolved) throw new Error(resolved.error)
    return this.createProvider(resolved).listModels()
  }

  /**
   * 优先使用渲染层传来的草稿值（用户正在编辑、尚未保存），
   * 否则回落到已保存配置中解密出来的凭据。
   */
  private resolve(request: LlmTestRequest): ResolvedLlmTarget | { error: string } {
    const settings = this.settings.get()
    const providerId = request.providerId ?? settings.llm.active
    const saved = providerId === '' ? undefined : settings.llm.providers[providerId]

    const baseUrl = (request.baseUrl ?? saved?.baseUrl ?? '').trim()
    if (baseUrl === '') return { error: '请先填写 baseURL' }

    const model = (request.model ?? saved?.model ?? '').trim()
    if (model === '') return { error: '请先填写模型名' }

    // 接口协议：渲染层的草稿优先（用户刚切到 Responses 还没保存就要能测），
    // 否则用已保存配置。两者都缺时交给 `createLlmProvider` 按 openai-compat 兜底。
    const type = request.type ?? saved?.type

    const apiKey =
      request.apiKey !== undefined && request.apiKey !== ''
        ? request.apiKey
        : providerId === ''
          ? ''
          : this.settings.getSecret(`llm.providers.${providerId}.apiKey`)

    if (apiKey === '') {
      return { error: '缺少 API Key：请填写密钥（本地模型可留空但需服务端允许匿名访问）' }
    }

    return { id: providerId === '' ? 'draft' : providerId, baseUrl, apiKey, model, type }
  }

  private createProvider(input: {
    id: string
    baseUrl: string
    apiKey: string
    model: string
    type: LlmProviderType | undefined
  }) {
    const fetchImpl = this.netFetch()
    return createLlmProvider(input.type, {
      id: input.id,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      defaultModel: input.model,
      timeoutMs: this.timeoutMs,
      maxRetries: 1,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      onRetry: (info) => this.logger.debug('LLM 请求重试', info),
    })
  }

  /** 解析当前出网 fetch；解析失败按未提供处理（回落内核默认）。 */
  private netFetch(): typeof fetch | undefined {
    if (this.resolveFetch === undefined) return undefined
    try {
      return this.resolveFetch()
    } catch (error) {
      this.logger.debug('取网络客户端失败，回落默认实现', { error: String(error) })
      return undefined
    }
  }
}
