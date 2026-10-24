/**
 * 每个窗口入口共用的启动引导：创建 Pinia、加载共享状态、绑定 IPC 事件推送。
 */
import { createPinia, setActivePinia } from 'pinia'
import type { App } from 'vue'
import { useModeStore, usePerceptionStore, useSettingsStore, useWindowStore } from './stores.js'
import { usePluginsStore } from './plugins-store.js'

export interface BootstrapOptions {
  /** 是否订阅窗口可见性变化（提示条 / 交互窗 / 设置页 / 引导页需要） */
  trackWindows?: boolean
  /** 是否订阅设置变化 */
  trackSettings?: boolean
  /** 是否订阅模式变化 */
  trackModes?: boolean
  /** 是否读取系统感知（服务窗 / 提示条状态） */
  trackPerception?: boolean
  /** 是否加载插件列表并应用插件主题（chat / settings / edge-bar） */
  trackPlugins?: boolean
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
  const plugins = usePluginsStore()

  // ── 顺序硬口径（2026-10-10）：**先订阅、再加载**。不要改回「先 load 再 bind」。
  //
  // 旧接线的真实故障：`await Promise.all([settings.load(), modes.load()])` 之后才 `bind()`，
  // 落在两者之间的广播**永久丢失**（不是延迟）—— load 拿到的是切换**前**的快照，
  // 而那条广播不会再补。现场是「主进程当前模式已是新值、渲染层右栏永久停在旧模式」，
  // 且 `mode.set` 在「主进程已是目标值」时是 no-op（`packages/modes/src/manager.ts`
  // 相同 id 提前 return、不 emit），面板自己永远回不来（实测：chat-sidebar 探针
  // `contextCards` 恒为 work 的卡片，复现率低但一旦命中就是永久态）。
  //
  // 窗口期为什么真实存在：`edge-bar` 切模式时可能触发 `requestGuideIfNeeded` →
  // 主进程 proactive `showChat()` → `WindowManager.show()` 会 `ensure()` **建窗**，
  // 新窗口的 `bootstrapApp` 正好在"切换已发生、广播已发出"之后才跑起来。
  //
  // 先订阅意味着**加载应答可能比广播更晚返回** —— 这一点由各 store 的 `load()`
  // 自己兜住（`loadGate` 序号闸门：首读期间收到过推送就放弃这次读的写值，
  // 因为推送的载荷同样是主进程的权威全量状态、且比这份快照新）。见 stores.ts。
  if (options.trackSettings !== false) disposers.push(settings.bind())
  if (options.trackModes !== false) disposers.push(modes.bind())
  if (options.trackWindows) disposers.push(windows.bind())
  if (options.trackPlugins) disposers.push(plugins.bind())

  await settings.load()
  if (options.trackModes !== false) await modes.load()
  if (options.trackWindows) await windows.load()
  if (options.trackPlugins) await plugins.reload()
  if (options.trackPerception) void perception.refresh()

  window.addEventListener('beforeunload', () => {
    for (const dispose of disposers) dispose()
  })
}
