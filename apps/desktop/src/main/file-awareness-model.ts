/** 文件自感知后台模型的唯一解析口径（docs/06 §26）。 */
import {
  isCenterOfficialProviderId,
  type Settings,
  type SessionModelOverrideLike,
} from '@aurora/shared'

export interface FileAwarenessCenterAvailability {
  enabled: boolean
  available: boolean
  tokenSet: boolean
}

export interface EffectiveFileAwarenessModel {
  providerId: string
  model: string
  /** true = 用户为自感知显式选择了模型；false = 跟随全局 llm.active。 */
  overridden: boolean
}

export function resolveFileAwarenessModel(settings: Settings): EffectiveFileAwarenessModel {
  const configured = settings.fileAwareness.backgroundModel
  const providerId = configured.providerId.trim()
  if (providerId !== '') {
    return {
      providerId,
      model: configured.model.trim(),
      overridden: true,
    }
  }
  const provider = settings.llm.providers[settings.llm.active]
  return {
    providerId: settings.llm.active,
    model: provider?.model.trim() ?? '',
    overridden: false,
  }
}

export function fileAwarenessModelOverride(
  settings: Settings,
): SessionModelOverrideLike | undefined {
  const selected = resolveFileAwarenessModel(settings)
  return selected.overridden
    ? { providerId: selected.providerId, model: selected.model }
    : undefined
}

export function hasExplicitFileAwarenessModel(settings: Settings): boolean {
  return settings.fileAwareness.backgroundModel.providerId.trim() !== ''
}

/**
 * 返回不可用原因；undefined = 可用于请求构造。
 *
 * 显式选择的模型不走静默回退：文件正文的接收方必须与用户在设置页看到的一致。
 */
export function fileAwarenessModelError(
  settings: Settings,
  getSecret: (path: string) => string,
  center?: FileAwarenessCenterAvailability,
): string | undefined {
  const selected = resolveFileAwarenessModel(settings)
  if (selected.providerId === '') return '尚未配置可用的 AI 模型'
  const provider = settings.llm.providers[selected.providerId]
  if (provider === undefined) {
    return selected.overridden
      ? '所选后台模型不存在，请在「文件自感知」中重新选择'
      : '当前主模型不存在，请在「AI 模型」中重新选择'
  }
  if (selected.model === '') {
    return selected.overridden ? '尚未选择自感知后台模型' : '当前主模型尚未填写模型名'
  }
  if (provider.baseUrl.trim() === '') {
    return selected.overridden ? '所选后台模型缺少 Base URL' : '当前主模型缺少 Base URL'
  }
  if (isCenterOfficialProviderId(selected.providerId)) {
    if (center?.enabled !== true) return 'Center 官方语言模型未启用'
    if (center.available !== true) return 'Center 官方模型目录当前不可用'
    if (center.tokenSet !== true) return 'Center 登录令牌不可用'
    return undefined
  }
  if (getSecret(`llm.providers.${selected.providerId}.apiKey`) === '') {
    return selected.overridden ? '所选后台模型缺少 API Key' : '当前主模型缺少 API Key'
  }
  return undefined
}
