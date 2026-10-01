/**
 * 按接口协议构造 LLM provider（docs/06 §3.2，v22）。
 *
 * 存在的唯一理由：**两处装配都要按 `llm.providers.<id>.type` 分派** ——
 * 会话用的 `createProviderFactory`（`agent-host.ts`）与设置页「测试连接」用的 `LlmTester`
 * （`llm-tester.ts`）。分派写成两处 `if` 是迟早会漂移的那种重复：用户在设置页测通了
 * Responses 接口、聊到一半却发现走的还是 chat-completions，排查成本极高。
 *
 * 不 import electron：单测可以直接覆盖「哪种 type 得到哪个类」。
 */
import {
  OpenAiCompatProvider,
  OpenAiResponsesProvider,
  type LlmProvider,
  type RetryInfo,
} from '@aurora/agent-core'
import type { LlmProviderType } from '@aurora/shared'

export interface LlmProviderBuildOptions {
  id: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  /** 注入 fetch（主进程注入 `netFetch` 以走 `advanced.proxy`）；缺省用全局 fetch */
  fetchImpl?: typeof fetch
  /** 单请求超时（设置页「测试连接」用更短的 15s） */
  timeoutMs?: number
  /** 失败重试次数（不含首次） */
  maxRetries?: number
  /** 重试 / 降级重试回调（主进程在此记 warn） */
  onRetry?: (info: RetryInfo) => void
}

/**
 * 两个实现都提供了 `listModels` / `testConnection`，但 `LlmProvider` 上它们是**可选**的
 * （接口为第三方实现留了余地）。这里在装配层把这一点收窄，免得每个调用点都写一遍 `?.`。
 */
export type BuiltLlmProvider = LlmProvider & {
  listModels: NonNullable<LlmProvider['listModels']>
}

/** 未知 / 缺失的 `type` 一律按 `openai-compat` 处理（与 Schema 默认值、迁移口径一致）。 */
export function createLlmProvider(
  type: LlmProviderType | undefined,
  options: LlmProviderBuildOptions,
): BuiltLlmProvider {
  const shared = {
    id: options.id,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    defaultModel: options.defaultModel,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  }
  if (type === 'openai-responses') return new OpenAiResponsesProvider(shared)
  return new OpenAiCompatProvider(shared)
}
