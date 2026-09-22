/**
 * 每个窗口入口共用的启动引导：创建 Pinia、加载共享状态、绑定 IPC 事件推送。
 */
import { createPinia, setActivePinia } from 'pinia'
import type { App } from 'vue'
import { useModeStore, usePerceptionStore, useSettingsStore, useWindowStore } from './stores.js'

export interface BootstrapOptions {
  /** 是否订阅窗口可见性变化（提示条 / 交互窗 / 设置页 / 引导页需要） */
  trackWindows?: boolean
  /** 是否订阅设置变化 */
  trackSettings?: boolean
  /** 是否订阅模式变化 */
  trackModes?: boolean
  /** 是否读取系统感知（服务窗 / 提示条状态） */
  trackPerception?: boolean
}

export async function bootstrapApp(app: App, options: BootstrapOptions = {}): Promise<void> {
  const pinia = createPinia()
  app.use(pinia)
  setActivePinia(pinia)

  const disposers: Array<() => void> = []

  const settings = useSettingsStore()
  const modes = useModeStore()
  const windows = useWindowStore()
  const perception = usePerceptionStore()

  await Promise.all([settings.load(), modes.load()])
  if (options.trackWindows !== false) await windows.load()

  if (options.trackSettings !== false) disposers.push(settings.bind())
  if (options.trackModes !== false) disposers.push(modes.bind())
  if (options.trackWindows) disposers.push(windows.bind())
  if (options.trackPerception) void perception.refresh()

  window.addEventListener('beforeunload', () => {
    for (const dispose of disposers) dispose()
  })
}
