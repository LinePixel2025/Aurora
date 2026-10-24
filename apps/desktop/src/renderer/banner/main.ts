import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import { startBannerAppearance } from './settings.js'

/**
 * 流光提醒窗口（docs/07 §2.2.3）：`?layer=glow` = 顶边光带，`?layer=card` = 置顶卡片。
 *
 * 与 `awareness-glow/main.ts` 同一套做法：浮层不启动 Pinia，只读一次设置并订阅
 * `settings:changed`；卡片层额外用它判断「TTS 配好了没有」（没配好就不朗读，见 settings.ts）。
 */
startBannerAppearance()

createApp(App).mount('#app')
