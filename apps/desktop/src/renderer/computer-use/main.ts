import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import { applyAppearance } from '../shared/appearance.js'

/**
 * Computer Use 浮层 / HUD（v39，docs/06 §28）。
 *
 * 与自感知流光同款：零 Pinia 启动开销，只读一次设置并跟随 `settings:changed`；
 * 事件由主进程推送（`computerUse.event`）；虚拟光标只在 Agent 动作期间滑动（约 60fps）。
 */
void window.aurora.settings
  .get()
  .then((result) => {
    if (result.ok) applyAppearance(result.value.appearance)
  })
  .catch(() => {})
window.aurora.settings.onChanged((settings) => applyAppearance(settings.appearance))

createApp(App).mount('#app')
