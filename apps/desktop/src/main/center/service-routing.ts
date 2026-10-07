import { isCenterOfficialProviderId } from '@aurora/shared'

export interface CapabilityProviderState<T> {
  enabled: boolean
  active: string
  providers: Record<string, T>
}

export type CapabilityRoute =
  | { mode: 'center'; fallbackProviderId?: string }
  | { mode: 'local'; providerId: string }
  | { mode: 'error'; message: string }

/**
 * TTS / STT / 生图的路由口径：`active` 是实际分派依据。
 *
 * Center 官方开关只决定 `center-*` 是否可用，不再无条件覆盖本地默认；官方请求失败时
 * 使用同一能力下第一个可用的本机 Provider 回落。
 */
export function resolveCapabilityRoute<T>(
  capabilityLabel: string,
  state: CapabilityProviderState<T>,
  officialEnabled: boolean,
  officialProviderId: string,
  isUsable: (providerId: string, provider: T) => boolean,
): CapabilityRoute {
  const active = state.active.trim()
  const activeProvider = state.providers[active]
  if (
    active !== '' &&
    active !== officialProviderId &&
    activeProvider !== undefined &&
    !isCenterOfficialProviderId(active) &&
    isUsable(active, activeProvider)
  ) {
    return { mode: 'local', providerId: active }
  }

  const fallbackProviderId = firstUsableLocalProvider(state.providers, isUsable)
  if (officialEnabled && active === officialProviderId) {
    return {
      mode: 'center',
      ...(fallbackProviderId === undefined ? {} : { fallbackProviderId }),
    }
  }

  if (fallbackProviderId !== undefined) {
    return { mode: 'local', providerId: fallbackProviderId }
  }
  return { mode: 'error', message: `${capabilityLabel}未配置可用的 Provider` }
}

export function firstUsableLocalProvider<T>(
  providers: Record<string, T>,
  isUsable: (providerId: string, provider: T) => boolean,
): string | undefined {
  for (const [providerId, provider] of Object.entries(providers)) {
    if (isCenterOfficialProviderId(providerId)) continue
    if (isUsable(providerId, provider)) return providerId
  }
  return undefined
}
