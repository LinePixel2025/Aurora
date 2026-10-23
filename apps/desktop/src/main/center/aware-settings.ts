/**
 * Center 感知的设置读层（docs/12 §12.2 / docs/08 §8）。
 *
 * 包一层 `SettingsStoreLike`：官方模型开关启用时，把保留 Provider 设为可用并把用户所选
 * 官方模型（`center.officialModels.<cap>.model` + 目录参数）**覆写进返回副本**——落盘镜像
 * 仍由 `syncProviders` 保持目录默认模型。llm 的选模在 `createProviderFactory` 自理，
 * 这里只切 `llm.active`。
 */
import type {
  CenterOfficialCapability,
  CenterOfficialServiceCatalog,
  Logger,
  Settings,
} from '@aurora/shared'
import { CENTER_OFFICIAL_PROVIDER_IDS } from '@aurora/shared'
import type { SettingsStoreLike } from '../contracts.js'
import {
  resolveOfficialModelEntry,
  withOfficialImageGenModel,
  withOfficialSttModel,
  withOfficialTtsModel,
} from './official-selection.js'

type NonLlmCapability = Exclude<CenterOfficialCapability, 'llm'>

export interface CenterAwareSettingsDeps {
  serviceOf(capability: CenterOfficialCapability): CenterOfficialServiceCatalog | undefined
  /** 目录已就绪（含本机缓存）；缺省按「已就绪」处理。未就绪 ≠ 官方不可用。 */
  catalogLoaded?: () => boolean
  /** 官方目录 / 镜像缺失时的回落提示（由调用方按能力去重）。 */
  noticeFallback(capability: CenterOfficialCapability): void
  logger?: Logger
}

export function createCenterAwareSettingsStore(
  base: SettingsStoreLike,
  deps: CenterAwareSettingsDeps,
): SettingsStoreLike {
  /** 所选模型被目录摘除时只 warn 一次（capability:model 维度），避免每次 get() 刷日志。 */
  const warnedStaleSelections = new Set<string>()
  const reservedSecretOf = (path: string): string | undefined => {
    for (const capability of ['tts', 'stt', 'imagegen'] as const) {
      const providerId = CENTER_OFFICIAL_PROVIDER_IDS[capability]
      if (
        path === `${capability}.providers.${providerId}.apiKey` ||
        path === `${capability}.providers.${providerId}.apiKeyEnc`
      ) {
        return base.getSecret('center.token')
      }
    }
    return undefined
  }
  const applyModelOverride = (
    next: Settings,
    capability: NonLlmCapability,
    providerId: string,
    selectionModel: string,
  ): void => {
    const resolved = resolveOfficialModelEntry(deps.serviceOf(capability), selectionModel)
    if (resolved === undefined) return
    if (resolved.fellBack) {
      const key = `${capability}:${selectionModel}`
      if (!warnedStaleSelections.has(key)) {
        warnedStaleSelections.add(key)
        deps.logger?.warn('Center 官方目录已不再开放所选模型，回落目录默认模型', {
          capability,
          selection: selectionModel,
          fallback: resolved.entry.id,
        })
      }
    }
    if (capability === 'imagegen') {
      const provider = next.imagegen.providers[providerId]
      if (provider !== undefined && provider.model !== resolved.entry.id) {
        next.imagegen.providers[providerId] = withOfficialImageGenModel(provider, resolved.entry)
      }
      return
    }
    if (capability === 'tts') {
      const provider = next.tts.providers[providerId]
      if (provider !== undefined && provider.model !== resolved.entry.id) {
        next.tts.providers[providerId] = withOfficialTtsModel(provider, resolved.entry)
      }
      return
    }
    const provider = next.stt.providers[providerId]
    if (provider !== undefined && provider.model !== resolved.entry.id) {
      next.stt.providers[providerId] = withOfficialSttModel(provider, resolved.entry)
    }
  }
  const applyOfficialSelection = (next: Settings): Settings => {
    for (const capability of ['llm', 'tts', 'stt', 'imagegen'] as const) {
      const selection = next.center.officialModels[capability]
      if (!selection.enabled) continue
      const providerId = CENTER_OFFICIAL_PROVIDER_IDS[capability]
      const available =
        deps.serviceOf(capability) !== undefined &&
        next[capability].providers[providerId] !== undefined
      if (available) {
        if (capability === 'llm') next.llm.active = providerId
        else {
          next[capability].enabled = true
          applyModelOverride(next, capability, providerId, selection.model)
        }
      } else {
        // 目录尚未加载（启动 / 刚登录）不是故障：静默沿用本机档，等目录到达再自然切回官方。
        if (deps.catalogLoaded?.() !== false) deps.noticeFallback(capability)
      }
    }
    return next
  }
  return {
    get: () => applyOfficialSelection(base.get()),
    getSecret(path) {
      return reservedSecretOf(path) ?? base.getSecret(path)
    },
    setSecret(path, plain) {
      if (reservedSecretOf(path) !== undefined) return false
      return base.setSecret(path, plain)
    },
    clearSecret(path) {
      if (reservedSecretOf(path) !== undefined) return
      base.clearSecret(path)
    },
    mutate(mutator) {
      return base.mutate(mutator)
    },
    update(patch) {
      return base.update(patch)
    },
    isCryptoAvailable: () => base.isCryptoAvailable(),
    needsOnboarding: () => base.needsOnboarding(),
    exportRedacted: () => applyOfficialSelection(base.exportRedacted()),
    flush: () => base.flush(),
    onChange: (listener) => base.onChange(listener),
  }
}
