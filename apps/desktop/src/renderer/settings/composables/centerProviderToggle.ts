export interface CenterProviderActivation {
  enabled: boolean
  active: string
}

/**
 * TTS / STT / 生图官方开关切换时的 active 规则。
 *
 * 首次开启自动切到中心 Provider；关闭时只有当前默认仍是中心 Provider 才回落本地。
 * 用户已经切到本地后，官方开关开启/关闭都不再覆盖该选择。
 */
export function resolveCenterProviderToggle(
  state: CenterProviderActivation,
  centerProviderId: string,
  enabling: boolean,
  fallbackProviderId: string,
): Partial<CenterProviderActivation> {
  if (enabling) {
    return state.enabled ? {} : { enabled: true, active: centerProviderId }
  }
  if (state.active === centerProviderId) return { active: fallbackProviderId }
  return {}
}
