/**
 * Center 官方模型在设置页的解析口径（docs/08 §8 / docs/12 §12.2）。
 *
 * 主进程按 `center.officialModels.<cap>.model` 读时覆写官方请求；渲染层拿到的
 * `center-*` 镜像 provider 仍是目录默认模型，因此展示与主进程同链解析：
 * 目录在场按「选中项 → defaultModel → 首个」，目录缺席退「selection || 镜像值」。
 */
import type {
  CenterOfficialModelCatalogEntry,
  CenterOfficialServiceCatalog,
} from '@aurora/shared/browser'

export type OfficialNonLlmCapability = 'imagegen' | 'tts' | 'stt'

export interface EffectiveOfficialModel {
  model: string
  entry?: CenterOfficialModelCatalogEntry
}

export function resolveEffectiveOfficialModel(
  service: CenterOfficialServiceCatalog | undefined,
  selectionModel: string,
  providerModel: string,
): EffectiveOfficialModel {
  const wanted = selectionModel.trim()
  if (service === undefined) {
    return { model: wanted !== '' ? wanted : providerModel.trim() }
  }
  const selected = wanted === '' ? undefined : service.models.find((item) => item.id === wanted)
  const entry =
    selected ?? service.models.find((item) => item.id === service.defaultModel) ?? service.models[0]
  return { model: entry?.id ?? providerModel.trim(), entry }
}

/** 官方行摘要：参数优先取目录所选条目（与实际请求同源），目录缺席退镜像 provider。 */
export function officialModelDetails(
  capability: OfficialNonLlmCapability,
  model: string,
  entry: CenterOfficialModelCatalogEntry | undefined,
  provider:
    | { size?: string; voice?: string; format?: string; language?: string; speed?: number }
    | undefined,
): string[] {
  if (capability === 'imagegen') {
    return [`模型 ${model || '未配置'}`, `尺寸 ${entry?.size ?? provider?.size ?? 'auto'}`]
  }
  if (capability === 'tts') {
    return [
      `模型 ${model || '未配置'}`,
      `音色 ${entry?.voice?.trim() || provider?.voice?.trim() || '未配置'}`,
      `格式 ${entry?.format ?? provider?.format ?? 'mp3'}`,
    ]
  }
  return [
    `模型 ${model || '未配置'}`,
    `语言 ${entry?.language?.trim() || provider?.language?.trim() || '自动检测'}`,
  ]
}
