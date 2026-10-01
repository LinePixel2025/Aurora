/**
 * 模型级生成参数（v23）的**写入**助手（docs/08 §1）。
 *
 * 为什么需要单独一个函数：`llm.providers.<id>.modelParams.<modelId>` 是**嵌套在 `z.record`
 * 之下**的一层结构，`SettingsStore` 的字段级回退**不下钻**这棵子树
 * （见 shared 的 `sanitizeWithDefaults` 对 `isDynamicPath` 的处理）。「只写被改动的那一项」
 * 会留下**半截条目**：三个子字段现在都有 `.default()`（`auto` / `0` / `false`）兜底，
 * 所以不会立刻炸，但语义会变成「这次顺手把另外两项重置成了默认值」—— 一旦将来给某个
 * 字段加回约束，同一段代码就会静默出问题。三项一起写是**防御纵深**。
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

/**
 * 远程 `llm.switch` 的前置校验（纯函数 —— 真正的 handler 在 `index.ts` 里、依赖 Electron，
 * vitest 收不了它，这段判定此前**零覆盖**；抽出来才钉得住四条分支）。
 * 返回拒绝理由；`undefined` = 放行。
 *
 * 四条守卫的顺序与文案都要保持（Center 网页端按回执判断结果）：
 * ① `providerId` 不存在 → 拒（绝不新建条目）；
 * ② 要改模型 / 等级、但当前没有可用的激活 provider → 拒；
 * ③ 显式把 `model` 设成空串 → 拒；
 * ④ **只改等级**、而目标 provider 还没有生效模型 → 拒（等级是**模型级**的，没有可归属的键）。
 *    同一次请求里也给了 `model` 时放行 —— handler 会先落模型、等级跟着写在新模型名下，
 *    这一组合一直可用，别顺手把它也拦掉。
 */
export function llmSwitchRejection(
  providers: Readonly<Record<string, { model: string }>>,
  activeId: string,
  request: { providerId?: string; model?: string; reasoningEffort?: string },
): string | undefined {
  const targetId = request.providerId ?? activeId
  if (request.providerId !== undefined && providers[request.providerId] === undefined) {
    return `E_INVALID_ARGUMENT: provider 不存在（${request.providerId}）`
  }
  if (
    (request.model !== undefined || request.reasoningEffort !== undefined) &&
    providers[targetId] === undefined
  ) {
    return 'E_INVALID_ARGUMENT: 没有可用的激活 provider'
  }
  if (request.model !== undefined && request.model.trim() === '') {
    return 'E_INVALID_ARGUMENT: model 不能为空'
  }
  if (
    request.reasoningEffort !== undefined &&
    request.model === undefined &&
    (providers[targetId]?.model ?? '').trim() === ''
  ) {
    return 'E_INVALID_ARGUMENT: 该 provider 尚未设置模型，无法写入模型级参数'
  }
  return undefined
}
