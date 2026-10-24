/**
 * 插件共享状态（docs/14 §5，P3）：已安装插件快照、命令表、面板表与主题应用。
 *
 * 数据只有一个来源 `plugins:list`；`plugins:changed` 到达时整体重拉。
 * 主题在这里统一应用（所有 `trackPlugins` 的窗口各持有一份，CSS 变量是逐文档的），
 * 顺序保证：设置 store 先应用外观，插件令牌后叠加（见 `pluginTheme.ts`）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  PluginCommandInfo,
  PluginPanelInfo,
  PluginSummary,
  PluginThemeInfo,
} from '@aurora/shared'
import { applyPluginTheme } from './pluginTheme.js'
import { useSettingsStore } from './stores.js'

export const usePluginsStore = defineStore('plugins', () => {
  const settings = useSettingsStore()
  const list = ref<PluginSummary[]>([])
  const error = ref<string | null>(null)
  const loaded = ref(false)

  async function reload(): Promise<void> {
    const result = await window.aurora.plugins.list()
    if (result.ok) {
      list.value = result.value
      error.value = null
    } else {
      error.value = result.message
    }
    loaded.value = true
  }

  /** 订阅集合变化（插件启停 / 崩溃 / 开发目录重载 / 安装卸载） */
  function bind(): () => void {
    return window.aurora.plugins.onChanged(() => void reload())
  }

  const enabledPlugins = computed(() =>
    list.value.filter((plugin) => plugin.enabled && plugin.status !== 'disabled'),
  )
  const commands = computed<PluginCommandInfo[]>(() =>
    enabledPlugins.value.flatMap((plugin) => plugin.commands),
  )
  const panels = computed<PluginPanelInfo[]>(() =>
    enabledPlugins.value.flatMap((plugin) => plugin.panels),
  )
  const themes = computed<PluginThemeInfo[]>(() =>
    enabledPlugins.value.flatMap((plugin) => plugin.themes),
  )

  function commandByName(name: string): PluginCommandInfo | undefined {
    return commands.value.find((command) => command.name === name)
  }

  const activeTheme = computed<PluginThemeInfo | null>(() => {
    const active = settings.settings?.plugins.activeTheme
    if (active === undefined || active.pluginId === '' || active.themeId === '') return null
    return (
      themes.value.find(
        (theme) => theme.pluginId === active.pluginId && theme.id === active.themeId,
      ) ?? null
    )
  })

  watch(
    [activeTheme, () => settings.settings],
    () => applyPluginTheme(document.documentElement, activeTheme.value),
    { immediate: true, deep: true },
  )

  return {
    list,
    error,
    loaded,
    reload,
    bind,
    enabledPlugins,
    commands,
    panels,
    themes,
    commandByName,
    activeTheme,
  }
})
