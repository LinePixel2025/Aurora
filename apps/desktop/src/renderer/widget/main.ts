import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import { applyAppearance } from '../shared/appearance.js'

/** 浮层窗口（与流光同款）：自己读一次外观并跟随 `settings:changed`。 */
void window.aurora.settings
  .get()
  .then((result) => {
    if (result.ok) applyAppearance(result.value.appearance)
  })
  .catch(() => {})
window.aurora.settings.onChanged((settings) => applyAppearance(settings.appearance))

createApp(App).mount('#app')
