/**
 * Center 官方模型选模解析（docs/12 §12.2 / docs/08 §8）。
 *
 * 用户选的 `center.officialModels.<cap>.model` 在主进程**读时**覆写进 `center-*`
 * 镜像 Provider 副本；落盘镜像永远保持目录默认模型。解析链与 `syncProviders` 同源
 * （选中项 → defaultModel → models[0]），参数归一化也只在这里写一份。
 * 纯 Node 模块，不依赖 Electron。
 */
import type {
  CenterOfficialModelCatalogEntry,
  CenterOfficialServiceCatalog,
  ImageGenProviderConfig,
  SttProviderConfig,
  TtsProviderConfig,
} from '@aurora/shared'

export function normalizeImageSize(value: string | undefined): ImageGenProviderConfig['size'] {
  const allowed = ['512x512', '768x768', '1024x1024', '1024x1792', '1792x1024', 'auto'] as const
  return (allowed as readonly string[]).includes(value ?? '')
    ? (value as ImageGenProviderConfig['size'])
    : '1024x1024'
}

export function normalizeTtsFormat(value: string | undefined): TtsProviderConfig['format'] {
  const allowed = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const
  return (allowed as readonly string[]).includes(value ?? '')
    ? (value as TtsProviderConfig['format'])
    : 'mp3'
}

export interface ResolvedOfficialModel {
  entry: CenterOfficialModelCatalogEntry
  /** 用户显式选了模型但目录里已不存在（回落到目录默认模型） */
  fellBack: boolean
}

/**
 * 官方模型解析链：`selectionModel` 命中目录开放模型 → 用它；否则 defaultModel；否则首个。
 * `selectionModel` 为空串 = 未选择（按 defaultModel，不算回落）；目录缺席返回 undefined。
 */
export function resolveOfficialModelEntry(
  service: CenterOfficialServiceCatalog | undefined,
  selectionModel: string,
): ResolvedOfficialModel | undefined {
  if (service === undefined) return undefined
  const wanted = selectionModel.trim()
  const selected = wanted === '' ? undefined : service.models.find((item) => item.id === wanted)
  const entry =
    selected ?? service.models.find((item) => item.id === service.defaultModel) ?? service.models[0]
  if (entry === undefined) return undefined
  return { entry, fellBack: wanted !== '' && selected === undefined }
}

/** 把所选模型的参数覆写进镜像 Provider 副本（不原地改，字段口径与 syncProviders 一致）。 */
export function withOfficialImageGenModel(
  provider: ImageGenProviderConfig,
  entry: CenterOfficialModelCatalogEntry,
): ImageGenProviderConfig {
  return { ...provider, model: entry.id, size: normalizeImageSize(entry.size) }
}

export function withOfficialTtsModel(
  provider: TtsProviderConfig,
  entry: CenterOfficialModelCatalogEntry,
): TtsProviderConfig {
  return {
    ...provider,
    model: entry.id,
    voice: entry.voice ?? '',
    // speed 已在 Center 服务端夹到 [0.25, 4]，这里不再夹第二份
    speed: entry.speed ?? 1,
    format: normalizeTtsFormat(entry.format),
  }
}

export function withOfficialSttModel(
  provider: SttProviderConfig,
  entry: CenterOfficialModelCatalogEntry,
): SttProviderConfig {
  return { ...provider, model: entry.id, language: entry.language ?? 'zh' }
}
