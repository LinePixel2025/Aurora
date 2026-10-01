/**
 * 模型级生成参数（v23）的**写入**助手（docs/08 §1）。
 *
 * 为什么需要单独一个函数：`llm.providers.<id>.modelParams.<modelId>` 的三个子字段里
 * **只有 `reasoningEffort` 没有 `.default()`**（`contextWindow` / `vision` 都有默认值），
 * 而 `llm.providers` 是 `z.record` —— `SettingsStore` 的字段级回退**不下钻**这棵子树
 * （见 shared 的 `sanitizeWithDefaults` 对 `isDynamicPath` 的处理）。
 * 于是「只写被改动的那一项」这种写法会让整份配置在下次启动时被 `SettingsSchema.parse`
 * 判为损坏，走「备份 + 重建出厂配置」，用户的 provider / 凭据 / 项目配置**一起丢**。
 *
 * 所以主进程里所有「改模型参数」的写路径都走这里：按当前生效模型**整份替换**该条目，
 * 缺的键由 `resolveModelParams` 的按字段回落补齐。取值口径与消费端同源（同一个函数）。
 */
import { resolveModelParams, type LlmModelParams, type LlmProviderConfig } from '@aurora/shared'

/**
 * 返回 provider 的副本，其中**当前生效模型**（`provider.model`）的参数被 `patch` 覆盖。
 *
 * `provider.model` 为空串时原样返回 —— 没有「当前生效模型」可写，与迁移的
 * 「`model` 为空就不造模型条目」同一口径。其余模型的条目一个都不动。
 */
export function withModelParams(
  provider: LlmProviderConfig,
  patch: Partial<LlmModelParams>,
): LlmProviderConfig {
  const modelId = provider.model
  if (modelId === '') return provider
  return {
    ...provider,
    modelParams: {
      ...provider.modelParams,
      [modelId]: { ...resolveModelParams(provider, modelId), ...patch },
    },
  }
}
