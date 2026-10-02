/**
 * `config.get`（脱敏）里网页端关心的 LLM 切片解析（docs/12 §10）。
 *
 * 单独成模块是为了**能被单测覆盖**：`store.ts` 顶部就 `import { computed, reactive, ref } from 'vue'`
 * 并建了模块级响应式状态，在 node 环境里 import 它有副作用；而这段解析是纯函数，
 * 它决定「模型下拉的候选 / 思考等级 / 占比分母」三处显示，值得钉住。
 *
 * ⚠️ 取值口径在 v23 起是**模型级**的：`contextWindow` / `reasoningEffort` 在
 * `llm.providers.<id>.modelParams.<该 provider 的 model>` 下，与主进程的
 * `resolveModelParams(provider)` 同源（键未命中 / 字段缺失按字段回落 `0` / `'auto'`）。
 * 这里手写收窄而不是直接调 `resolveModelParams`，是因为 SPA 的既有约定是
 * **运行时零依赖 `@aurora/shared`**（见 `api.ts` 顶部注释；引它会经 zod 链把体积带进前端包）。
 */
import type { ReasoningEffort } from '@aurora/shared'

/** config.get 回传（脱敏）里网页端关心的 LLM 切片：模型切换与 contextWindow 占比展示用 */
export interface RemoteLlmConfig {
  /** 当前激活 provider id（对应 `llm.active`） */
  active: string
  providers: Record<
    string,
    { model: string; modelList: string[]; contextWindow: number; reasoningEffort: ReasoningEffort }
  >
}

export function extractRemoteLlm(data: unknown): RemoteLlmConfig | null {
  if (typeof data !== 'object' || data === null) return null
  const llm = (data as { llm?: unknown }).llm
  if (typeof llm !== 'object' || llm === null) return null
  const active = (llm as { active?: unknown }).active
  const providers = (llm as { providers?: unknown }).providers
  const result: RemoteLlmConfig = {
    active: typeof active === 'string' ? active : '',
    providers: {},
  }
  if (typeof providers !== 'object' || providers === null) return result
  for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const provider = raw as Record<string, unknown>
    const modelList = Array.isArray(provider.modelList)
      ? provider.modelList.filter((m): m is string => typeof m === 'string')
      : []
    const model = typeof provider.model === 'string' ? provider.model : ''
    // contextWindow / reasoningEffort 在 v23 下沉到**模型级**（`modelParams[模型]`）：
    // 取值口径 = 该 provider 的当前 `model`（真正生效的那个），与主进程的
    // `resolveModelParams(provider)` 同源；键未命中 / 字段缺失按字段回落 0 / 'auto'。
    // 逐层收窄（provider → 该模型的条目），别把 undefined 漏进下面的类型判断。
    const modelParams = provider.modelParams
    const rawEntry =
      typeof modelParams === 'object' && modelParams !== null
        ? (modelParams as Record<string, unknown>)[model]
        : undefined
    const modelEntry: Record<string, unknown> =
      typeof rawEntry === 'object' && rawEntry !== null ? (rawEntry as Record<string, unknown>) : {}
    result.providers[id] = {
      model,
      modelList,
      contextWindow: typeof modelEntry.contextWindow === 'number' ? modelEntry.contextWindow : 0,
      reasoningEffort:
        modelEntry.reasoningEffort === 'low' ||
        modelEntry.reasoningEffort === 'medium' ||
        modelEntry.reasoningEffort === 'high'
          ? modelEntry.reasoningEffort
          : 'auto',
    }
  }
  return result
}
