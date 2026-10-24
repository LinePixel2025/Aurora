/**
 * 流光提醒窗口的**外观与语音就绪度**（docs/07 §2.2.3）。
 *
 * 两个窗口（光带 / 卡片）共用同一个渲染入口，`?layer=glow|card` 决定画哪一层：
 * - 光带层只需要强调色（光谱里有一档引用 `--aurora-blue`），因此同样要跑 `applyAppearance`；
 * - 卡片层还要知道「TTS 配好了没有」—— 没配好就**不朗读、也不报错**（口径同 docs/06 §13.5）。
 *
 * 本窗口不走 `bootstrapApp` / Pinia（浮层保持零启动开销）：读一次设置 + 订阅
 * `settings:changed` 跟随（照抄 `awareness-glow/main.ts` 的做法）。
 */
import { ref } from 'vue'
import type { TtsSettings } from '@aurora/shared'
import { applyAppearance } from '../shared/appearance.js'
import { isTtsConfigured } from '../shared/tts-config.js'

/** TTS 是否可用（供卡片层决定要不要朗读） */
export const ttsReady = ref(false)

export function startBannerAppearance(): void {
  const apply = (settings: {
    appearance: Parameters<typeof applyAppearance>[0]
    tts: TtsSettings
  }): void => {
    applyAppearance(settings.appearance)
    ttsReady.value = isTtsConfigured(settings.tts)
  }
  void window.aurora.settings
    .get()
    .then((result) => {
      if (result.ok) apply(result.value)
    })
    .catch(() => {
      // 首读失败按「未配置 TTS / 默认强调色」处理，等下一次 settings:changed 广播纠正
    })
  window.aurora.settings.onChanged((settings) => {
    apply(settings)
  })
}
