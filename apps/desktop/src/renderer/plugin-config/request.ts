import { ref } from 'vue'
import type { PluginWindowRequest } from '@aurora/shared'

/**
 * 插件配置窗口的当前请求。
 *
 * 必须在 `bootstrapApp()` 之前注册监听：主进程的 `showWithPayload()` 会在页面 load 完成
 * 后立刻推参数，而 bootstrap 里还有若干次 IPC 往返；只在 App.onMounted 里订阅会漏掉首包
 * （capture 实测窗口打开但 request 为 null）。
 */
export const windowRequest = ref<PluginWindowRequest | null>(null)

let bound = false

export function bindWindowRequest(): void {
  if (bound) return
  bound = true
  window.aurora.plugins.onWindowRequest((next) => {
    windowRequest.value = next
  })
}
