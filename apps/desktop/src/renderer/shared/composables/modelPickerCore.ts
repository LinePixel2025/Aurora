import {
  CENTER_OFFICIAL_PROVIDER_IDS,
  isCenterOfficialProviderId,
  type LlmProviderConfig,
  type SessionModelOverrideLike,
  type Settings,
} from '@aurora/shared/browser'

export type ModelPickerSourceId = 'center' | 'local'

export interface ModelPickerChoice {
  providerId: string
  model: string
}

export interface ModelPickerOption extends ModelPickerChoice {
  key: string
  label: string
}

export interface ModelPickerSource {
  id: ModelPickerSourceId
  label: string
  options: ModelPickerOption[]
  defaultChoice: ModelPickerChoice
}

export interface ModelPickerState {
  sources: ModelPickerSource[]
  sourceId: ModelPickerSourceId | null
  choice: ModelPickerChoice | null
  overridden: boolean
  centerReadOnly: boolean
}

/**
 * 模型下拉的唯一解析口径。
 *
 * 优先级必须与主进程 `createProviderFactory` 一致：会话覆盖 > 全局 `llm.active`
 * （指向 `center-llm` 时才是 Center 官方，否则是本机 Provider）。Center 官方能力开启
 * 不再参与全局默认竞争；没有会话覆盖的旧会话只推导展示选择，不在这里产生任何写入。
 */
export function buildModelPickerState(
  settings: Settings,
  override?: SessionModelOverrideLike | null,
  centerAvailable = true,
): ModelPickerState {
  const center = centerSource(settings, centerAvailable)
  const local = localSource(settings)
  const sources = [center, local].filter((source): source is ModelPickerSource => source !== null)

  const validOverride = resolveOverride(settings, sources, override)
  const effective = validOverride ?? resolveGlobalChoice(settings, center, local)
  if (effective === null || sources.length === 0) {
    return {
      sources,
      sourceId: null,
      choice: null,
      overridden: false,
      centerReadOnly: false,
    }
  }

  const sourceId: ModelPickerSourceId =
    effective.providerId === CENTER_OFFICIAL_PROVIDER_IDS.llm ? 'center' : 'local'
  const source = sources.find((item) => item.id === sourceId)
  if (source === undefined) {
    return {
      sources,
      sourceId: null,
      choice: null,
      overridden: false,
      centerReadOnly: false,
    }
  }

  ensureChoice(source, effective)
  return {
    sources,
    sourceId,
    choice: effective,
    overridden: validOverride !== null,
    centerReadOnly: sourceId === 'center',
  }
}

export function modelChoiceKey(choice: ModelPickerChoice | null): string {
  return choice === null ? '' : JSON.stringify([choice.providerId, choice.model])
}

function centerSource(settings: Settings, centerAvailable: boolean): ModelPickerSource | null {
  if (!centerAvailable || !settings.center.officialModels.llm.enabled) return null
  const providerId = CENTER_OFFICIAL_PROVIDER_IDS.llm
  const provider = settings.llm.providers[providerId]
  if (provider === undefined) return null
  const models = providerModels(provider)
  if (models.length === 0) return null
  const options = models.map((model) => option(providerId, model, model))
  const preferred =
    models.find((model) => model === settings.center.officialModels.llm.model) ??
    models.find((model) => model === provider.model) ??
    models[0]!
  return {
    id: 'center',
    label: 'Center 官方',
    options,
    defaultChoice: { providerId, model: preferred },
  }
}

function localSource(settings: Settings): ModelPickerSource | null {
  const options: ModelPickerOption[] = []
  for (const [providerId, provider] of Object.entries(settings.llm.providers)) {
    if (isCenterOfficialProviderId(providerId)) continue
    for (const model of providerModels(provider)) {
      options.push(option(providerId, model, `${providerId} · ${model}`))
    }
  }
  if (options.length === 0) return null

  const activeProvider = settings.llm.providers[settings.llm.active]
  const preferred =
    !isCenterOfficialProviderId(settings.llm.active) &&
    activeProvider !== undefined &&
    activeProvider.model.trim() !== '' &&
    settings.llm.providers[settings.llm.active] !== undefined
      ? { providerId: settings.llm.active, model: activeProvider.model.trim() }
      : { providerId: options[0]!.providerId, model: options[0]!.model }

  return {
    id: 'local',
    label: '用户模型',
    options,
    defaultChoice: preferred,
  }
}

function resolveOverride(
  settings: Settings,
  sources: ModelPickerSource[],
  override: SessionModelOverrideLike | null | undefined,
): ModelPickerChoice | null {
  const providerId = override?.providerId.trim() ?? ''
  const model = override?.model.trim() ?? ''
  if (providerId === '' || model === '') return null
  if (settings.llm.providers[providerId] === undefined) return null
  const sourceId: ModelPickerSourceId = isCenterOfficialProviderId(providerId) ? 'center' : 'local'
  return sources.some((source) => source.id === sourceId) ? { providerId, model } : null
}

function resolveGlobalChoice(
  settings: Settings,
  center: ModelPickerSource | null,
  local: ModelPickerSource | null,
): ModelPickerChoice | null {
  // 只有 llm.active 指向官方时才优先 Center；本机默认优先，官方退回“可选来源”。
  if (isCenterOfficialProviderId(settings.llm.active)) {
    return center?.defaultChoice ?? local?.defaultChoice ?? null
  }
  return local?.defaultChoice ?? center?.defaultChoice ?? null
}

function providerModels(provider: LlmProviderConfig): string[] {
  const models: string[] = []
  const seen = new Set<string>()
  for (const candidate of [provider.model, ...provider.modelList]) {
    const model = candidate.trim()
    if (model === '' || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models
}

function option(providerId: string, model: string, label: string): ModelPickerOption {
  const choice = { providerId, model }
  return { ...choice, key: modelChoiceKey(choice), label }
}

function ensureChoice(source: ModelPickerSource, choice: ModelPickerChoice): void {
  if (
    source.options.some(
      (item) => item.providerId === choice.providerId && item.model === choice.model,
    )
  ) {
    return
  }
  source.options.push(option(choice.providerId, choice.model, `${choice.model}（不在列表中）`))
}
