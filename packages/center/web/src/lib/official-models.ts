/**
 * 管理端「官方模型」配置的纯逻辑（docs/12 §12）。
 *
 * 单独成模块是为了**能被单测覆盖**（`OfficialModelsAdmin.vue` 一 import 就会建响应式状态）；
 * 这里三件事都是纯函数：能力元数据、草稿默认值、拉取合并、保存前校验与脏值判定。
 *
 * ⚠️ **权威判据在服务端**（`packages/center/src/model-services.ts` 的 `updateService`：
 * 协议白名单、启用必须填 baseUrl / 至少一个开放模型 / 必须有 Key，且非法配置整条拒绝）。
 * 这里这一份只是把明显能拦的错误提前到点击保存之前，**别在两边各写一半规则**：
 * 服务端报错原文照旧展示，前端不替它下结论。
 *
 * ⚠️ 运行时零依赖 `@aurora/shared`（见 `api.ts` 顶部注释），只 `import type`。
 */
import type {
  CenterOfficialCapability,
  CenterOfficialModelEntry,
  CenterOfficialServiceConfig,
} from '@aurora/shared'

export interface CapabilityTypeOption {
  value: string
  label: string
  /** 该协议在 Base URL 之后拼的上游路径（写进字段说明，省得管理员去猜） */
  endpoint: string
}

export interface CapabilityMeta {
  id: CenterOfficialCapability
  label: string
  hint: string
  types: CapabilityTypeOption[]
}

/** 四类能力与各自的协议（与 `model-services.ts` 的 `ALLOWED_TYPES` 一一对应） */
export const CAPABILITIES: CapabilityMeta[] = [
  {
    id: 'llm',
    label: '语言模型',
    hint: '客户端会话与自动化使用它，请求经 Center 转发，上游 Key 不下发。',
    types: [
      { value: 'openai-compat', label: 'OpenAI 兼容', endpoint: '/chat/completions' },
      { value: 'openai-responses', label: 'OpenAI Responses', endpoint: '/responses' },
    ],
  },
  {
    id: 'imagegen',
    label: '图像生成',
    hint: 'generate_image 与网页端的生图请求使用它。',
    types: [{ value: 'openai-compat', label: 'OpenAI 兼容', endpoint: '/images/generations' }],
  },
  {
    id: 'tts',
    label: '语音合成',
    hint: '消息朗读使用它，音色与格式按每个模型条目配置。',
    types: [
      { value: 'openai-compat', label: 'OpenAI 兼容', endpoint: '/audio/speech' },
      {
        value: 'dashscope',
        label: 'DashScope 原生',
        endpoint: '/api/v1/services/aigc/multimodal-generation/generation',
      },
    ],
  },
  {
    id: 'stt',
    label: '语音识别',
    hint: '录音转写使用它，语言按每个模型条目配置。',
    types: [
      { value: 'openai-compat', label: 'OpenAI 兼容', endpoint: '/audio/transcriptions' },
      {
        value: 'dashscope-native',
        label: 'DashScope 原生',
        endpoint: '/api/v1/services/aigc/multimodal-generation/generation',
      },
    ],
  },
]

export function capabilityMeta(id: CenterOfficialCapability): CapabilityMeta {
  return CAPABILITIES.find((item) => item.id === id) ?? (CAPABILITIES[0] as CapabilityMeta)
}

/** 某个能力的协议选项（找不到时退回第一项，模板里不必再判空） */
export function capabilityTypes(id: CenterOfficialCapability): CapabilityTypeOption[] {
  return capabilityMeta(id).types
}

/** 新建 / 拉取到一个模型时的默认参数：与服务端 `normalizeModels` 的缺省值保持一致 */
export function createModelEntry(capability: CenterOfficialCapability): CenterOfficialModelEntry {
  if (capability === 'llm') {
    return { id: '', enabled: true, reasoningEffort: 'auto', contextWindow: 0, vision: false }
  }
  if (capability === 'imagegen') return { id: '', enabled: true, size: 'auto' }
  if (capability === 'tts') return { id: '', enabled: true, voice: '', speed: 1, format: 'mp3' }
  return { id: '', enabled: true, language: 'zh' }
}

/**
 * 「拉取模型」的结果合并进当前草稿。
 *
 * 旧实现是**整表替换**：上游没返回的已配置模型（换过上游、只在别的端点开放、手写的别名）
 * 会被静默删掉，勾好的开放状态也一起丢。现在：
 * - 既有条目**原样保留**（含开放位与能力参数），顺序不动；
 * - 上游新增的 id 追加在末尾，默认 **未开放** —— 一次拉回上百个模型时不该自动对客户端开放；
 * - 空 id 与重复 id 跳过。
 */
export function mergeFetchedModels(
  capability: CenterOfficialCapability,
  current: CenterOfficialModelEntry[],
  fetchedIds: string[],
): { models: CenterOfficialModelEntry[]; added: number; kept: number } {
  const models = current.map((model) => ({ ...model }))
  const seen = new Set(models.map((model) => model.id.trim()).filter((id) => id !== ''))
  let added = 0
  for (const raw of fetchedIds) {
    const id = raw.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    models.push({ ...createModelEntry(capability), id, enabled: false })
    added += 1
  }
  return { models, added, kept: models.length - added }
}

/** 行内错误：模型 ID 为空 / 与前面的条目重复（服务端会静默丢弃这两种行） */
export function modelRowIssues(models: CenterOfficialModelEntry[]): Map<number, string> {
  const issues = new Map<number, string>()
  const seen = new Set<string>()
  models.forEach((model, index) => {
    const id = model.id.trim()
    if (id === '') {
      issues.set(index, '模型 ID 不能为空')
      return
    }
    if (seen.has(id)) {
      issues.set(index, '模型 ID 与上面的条目重复')
      return
    }
    seen.add(id)
  })
  return issues
}

/**
 * 保存前的前置校验（服务端同一套规则的提前版）。
 *
 * `draft.apiKeySet` 表示**这次保存之后**会不会有 Key：用户在界面上「清除已存 Key」时
 * 组件会把它置 false，于是这条校验能拦住「清空 Key 却仍然启用」。
 */
export function validateDraft(draft: CenterOfficialServiceConfig, apiKeyInput: string): string[] {
  const issues: string[] = []
  if (modelRowIssues(draft.models).size > 0)
    issues.push('模型 ID 不能为空、也不能与上面的条目重复。')
  if (!draft.enabled) return issues
  if (draft.baseUrl.trim() === '') issues.push('启用前必须填写 Base URL。')
  if (draft.models.filter((model) => model.enabled).length === 0) {
    issues.push('启用前至少开放一个模型。')
  }
  if (apiKeyInput.trim() === '' && !draft.apiKeySet) {
    issues.push('启用前必须填写并保存 API Key。')
  }
  return issues
}

/**
 * 单个模型的比较投影：**显式列全所有可能字段并补齐默认值**。
 *
 * 不能直接 `JSON.stringify(model)`：键的顺序取决于它是「服务端回来的」还是「本地新建的」，
 * 键序不同就会被判成有改动（脏点常亮）。这里按固定顺序拼串，字段缺失按服务端缺省值补。
 * 例外是 `reasoningEffort`：**未指定（undefined）与显式 auto 在服务端是两种落盘结果**，
 * 不能用 `?? 'auto'` 抹平 —— 管理员从「未指定」改成「auto」时脏点必须亮。
 */
function modelSignature(model: CenterOfficialModelEntry): string {
  return [
    model.id.trim(),
    (model.label ?? '').trim(),
    model.enabled ? '1' : '0',
    model.reasoningEffort === undefined ? '（未指定）' : model.reasoningEffort,
    String(model.contextWindow ?? 0),
    model.vision === true ? '1' : '0',
    (model.size ?? '').trim(),
    (model.voice ?? '').trim(),
    String(model.speed ?? 1),
    (model.format ?? '').trim(),
    (model.language ?? '').trim(),
  ].join('\u0000')
}

/** 草稿 vs 已保存快照：用于「有未保存的修改」标记与页签上的脏点 */
export function isDirty(
  draft: CenterOfficialServiceConfig,
  saved: CenterOfficialServiceConfig,
  apiKeyInput: string,
): boolean {
  if (apiKeyInput.trim() !== '') return true
  if (draft.apiKeySet !== saved.apiKeySet) return true
  if (draft.enabled !== saved.enabled) return true
  if (draft.type !== saved.type) return true
  if (draft.baseUrl.trim() !== saved.baseUrl.trim()) return true
  if (draft.defaultModel !== saved.defaultModel) return true
  if (draft.models.length !== saved.models.length) return true
  return draft.models.some((model, index) => {
    const other = saved.models[index]
    return other === undefined || modelSignature(model) !== modelSignature(other)
  })
}
