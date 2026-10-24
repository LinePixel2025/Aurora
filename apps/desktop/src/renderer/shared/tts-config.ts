/**
 * 「TTS 是否可用」的唯一判据（渲染层）。
 *
 * 三个消费方共用这一份：对话窗的朗读按钮门控、自动朗读、流光提醒的语音播报。
 * 四处各写一遍必然漂移 —— 表现是「按钮出现了但点了没反应」或「提醒静默不读」。
 *
 * 四个条件缺一不可：总开关打开、`tts.active` 指向一个存在的 provider、
 * 且该 provider 的 `baseUrl` / `model` / `voice` 都填了（docs/06 §13）。
 * 缺任何一个都返回 false，调用方据此**根本不渲染**朗读入口 / 直接跳过朗读。
 */

/** 只取判定需要的字段：允许传入任何与 `TtsSettings` 同形的对象（含 Proxy / 部分构造） */
export interface TtsReadinessInput {
  enabled: boolean
  active: string
  providers: Record<string, { baseUrl: string; model: string; voice: string } | undefined>
}

export function isTtsConfigured(tts: TtsReadinessInput | undefined): boolean {
  if (tts === undefined) return false
  if (!tts.enabled || tts.active === '') return false
  const provider = tts.providers[tts.active]
  if (provider === undefined) return false
  return (
    provider.baseUrl.trim() !== '' && provider.model.trim() !== '' && provider.voice.trim() !== ''
  )
}
