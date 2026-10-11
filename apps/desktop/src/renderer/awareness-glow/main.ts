import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import { applyAppearance } from '../shared/appearance.js'

/**
 * 流光与提示条「正在感知」卡片共用同一个强调色来源（2026-10-11）：四边光幕的
 * 单色配色全部从 `--aurora-blue` 混合而来，所以这里也要跑 `applyAppearance`。
 * 本窗口不走 `bootstrapApp` / Pinia（浮层保持零启动开销），直接读一次设置 +
 * 订阅 `settings:changed` 跟随；首读失败按主题默认强调色兜底，等下一次广播。
 */
void window.aurora.settings
  .get()
  .then((result) => {
    if (result.ok) applyAppearance(result.value.appearance)
  })
  .catch(() => {})
window.aurora.settings.onChanged((settings) => applyAppearance(settings.appearance))

createApp(App).mount('#app')
