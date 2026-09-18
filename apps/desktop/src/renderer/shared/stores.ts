/**
 * 渲染层共享状态（Pinia）。
 *
 * 三个方向：
 * - 设置（settings:get / settings:changed）
 * - 模式与引导（mode:* / mode:changed / guide:*）
 * - 窗口可见性（window:* / window:stateChanged）
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AppInfo,
  ModeChangedEvent,
  ModeId,
  ModeSummary,
  PerceptionSummary,
  Settings,
  WindowName,
  WindowState,
} from '@aurora/shared'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings | null>(null)
  const appInfo = ref<AppInfo | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    const [settingsResult, infoResult] = await Promise.all([
      window.aurora.settings.get(),
      window.aurora.app.getInfo(),
    ])
    if (settingsResult.ok) settings.value = settingsResult.value
    else error.value = settingsResult.message
    if (infoResult.ok) appInfo.value = infoResult.value
    loading.value = false
  }

  async function update(
    patch: Parameters<typeof window.aurora.settings.update>[0],
  ): Promise<boolean> {
    const result = await window.aurora.settings.update(patch)
    if (result.ok) {
      settings.value = result.value
      error.value = null
      return true
    }
    error.value = result.message
    return false
  }

  async function reset(): Promise<boolean> {
    const result = await window.aurora.settings.reset()
    if (result.ok) {
      settings.value = result.value
      await refreshAppInfo()
      return true
    }
    error.value = result.message
    return false
  }

  async function setSecrets(entries: Record<string, string>): Promise<boolean> {
    const result = await window.aurora.settings.setSecrets(entries)
    if (result.ok) {
      await load()
      return true
    }
    error.value = result.message
    return false
  }

  async function refreshAppInfo(): Promise<void> {
    const result = await window.aurora.app.getInfo()
    if (result.ok) appInfo.value = result.value
  }

  function bind(): () => void {
    return window.aurora.settings.onChanged((next) => {
      settings.value = next
    })
  }

  const needsOnboarding = computed(() => appInfo.value?.needsOnboarding ?? true)
  const cryptoAvailable = computed(() => appInfo.value?.cryptoAvailable ?? true)
  const activeProvider = computed(() => {
    const current = settings.value
    if (!current || current.llm.active === '') return null
    const provider = current.llm.providers[current.llm.active]
    return provider ? { id: current.llm.active, ...provider } : null
  })

  return {
    settings,
    appInfo,
    error,
    loading,
    load,
    update,
    reset,
    setSecrets,
    refreshAppInfo,
    bind,
    needsOnboarding,
    cryptoAvailable,
    activeProvider,
  }
})

export const useModeStore = defineStore('modes', () => {
  const modes = ref<ModeSummary[]>([])
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    const result = await window.aurora.mode.list()
    if (result.ok) modes.value = result.value
    else error.value = result.message
  }

  async function setCurrent(id: ModeId): Promise<boolean> {
    const result = await window.aurora.mode.set(id)
    if (result.ok) {
      modes.value = result.value
      error.value = null
      return true
    }
    error.value = result.message
    return false
  }

  async function resetGuide(id: ModeId): Promise<void> {
    const result = await window.aurora.mode.resetGuide(id)
    if (result.ok) modes.value = result.value
  }

  async function completeGuide(id: ModeId): Promise<void> {
    const result = await window.aurora.mode.completeGuide(id)
    if (result.ok) modes.value = result.value
  }

  function bind(): () => void {
    return window.aurora.mode.onChanged((event: ModeChangedEvent) => {
      modes.value = event.modes
    })
  }

  const current = computed(() => modes.value.find((mode) => mode.active) ?? null)
  const needsGuide = computed(() => current.value !== null && !current.value.guideCompleted)

  return { modes, error, load, setCurrent, resetGuide, completeGuide, bind, current, needsGuide }
})

export const useWindowStore = defineStore('windows', () => {
  const state = ref<WindowState>({ visible: {}, primary: null })

  async function load(): Promise<void> {
    const result = await window.aurora.window.getState()
    if (result.ok) state.value = result.value
  }

  async function show(name: WindowName): Promise<void> {
    const result = await window.aurora.window.show(name)
    if (result.ok) state.value = result.value
  }

  async function hide(name: WindowName): Promise<void> {
    const result = await window.aurora.window.hide(name)
    if (result.ok) state.value = result.value
  }

  async function toggle(name: WindowName): Promise<void> {
    const result = await window.aurora.window.toggle(name)
    if (result.ok) state.value = result.value
  }

  async function showChat(): Promise<void> {
    const result = await window.aurora.window.showChat()
    if (result.ok) state.value = result.value
  }

  async function showMiniChat(): Promise<void> {
    const result = await window.aurora.window.showMiniChat()
    if (result.ok) state.value = result.value
  }

  function bind(): () => void {
    return window.aurora.window.onStateChanged((next) => {
      state.value = next
    })
  }

  return { state, load, show, hide, toggle, showChat, showMiniChat, bind }
})

export const usePerceptionStore = defineStore('perception', () => {
  const summary = ref<PerceptionSummary | null>(null)

  async function refresh(): Promise<void> {
    const result = await window.aurora.perception.summary()
    if (result.ok) summary.value = result.value
  }

  return { summary, refresh }
})
