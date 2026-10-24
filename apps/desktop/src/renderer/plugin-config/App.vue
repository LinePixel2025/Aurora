<script setup lang="ts">
/**
 * 插件配置窗口（docs/07 §2.2.2）：单例 `plugin-config`。
 *
 * 入口是设置 → 插件列表的「配置」按钮；窗口通过 `plugins:windowRequest` 收到
 * `{ requestId, pluginId }`，再从 `plugins:list` 取摘要、从 `plugins:widgetLayout` 取
 * 桌面小组件布局。保存配置走 `plugins:setConfig`；重启后由主进程广播
 * `plugins:changed`，已打开的面板 / 页面 / 小组件各自重载。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  PluginSummary,
  PluginWidgetInfo,
  PluginWidgetLayout,
  PluginWidgetWindowLevel,
} from '@aurora/shared'
import { PLUGIN_PERMISSION_LABELS } from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import AppTooltip from '../shared/components/AppTooltip.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import PluginConfigForm from '../plugins/PluginConfigForm.vue'
import { usePluginsStore } from '../shared/plugins-store.js'
import { useWindowStore } from '../shared/stores.js'
import { windowRequest } from './request.js'

const windowStore = useWindowStore()
const pluginsStore = usePluginsStore()
const { dragClass } = useWindowDrag('plugin-config')

const request = windowRequest
const widgetLayout = ref<PluginWidgetLayout | null>(null)
const busy = ref<string | null>(null)
const notice = ref<string | null>(null)
const error = ref<string | null>(null)
const confirmingUninstall = ref(false)
const deleteData = ref(false)

let offChanged: (() => void) | null = null

const summary = computed<PluginSummary | null>(() => {
  const current = request.value
  if (current === null) return null
  return pluginsStore.list.find((plugin) => plugin.id === current.pluginId) ?? null
})

const statusTone = computed(() => {
  const plugin = summary.value
  if (plugin === null) return 'idle'
  if (plugin.status === 'ready' || plugin.status === 'starting') return 'running'
  if (plugin.status === 'crashed' || plugin.status === 'error') return 'error'
  return 'idle'
})

const statusText = computed(() => {
  const plugin = summary.value
  if (plugin === null) return ''
  const map: Record<PluginSummary['status'], string> = {
    disabled: '已停用',
    stopped: '待启动',
    starting: '启动中',
    ready: '运行中',
    crashed: '已崩溃',
    error: '启动失败',
  }
  return map[plugin.status]
})

const desktopWidgets = computed(
  () => summary.value?.widgets.filter((widget) => widget.slot === 'desktop') ?? [],
)

/** 切插件 / 重新打开时用 key 重置配置表单，避免旧草稿串到新插件。 */
const configKey = computed(() =>
  request.value === null ? '' : `${request.value.pluginId}:${request.value.requestId}`,
)

const widgetLevelOptions: ReadonlyArray<{
  value: 'auto' | PluginWidgetWindowLevel
  label: string
}> = [
  { value: 'auto', label: '跟随插件' },
  { value: 'floating', label: '置顶' },
  { value: 'normal', label: '普通' },
  { value: 'desktop', label: '桌面层' },
]

function fail(message: string): void {
  error.value = message
  notice.value = null
}

function succeed(message: string): void {
  notice.value = message
  error.value = null
}

function widgetVisible(widget: PluginWidgetInfo): boolean {
  return widgetLayout.value?.widgets[`${widget.pluginId}/${widget.id}`]?.visible ?? true
}

function widgetLevel(widget: PluginWidgetInfo): 'auto' | PluginWidgetWindowLevel {
  return (
    widgetLayout.value?.widgets[`${widget.pluginId}/${widget.id}`]?.windowLevelOverride ?? 'auto'
  )
}

async function loadLayout(): Promise<void> {
  try {
    const layout = await window.aurora.plugins.widgetLayout()
    if (layout.ok) widgetLayout.value = layout.value
  } catch {
    // 布局读取失败只影响小组件卡片，不阻断配置区
  }
}

async function refresh(): Promise<void> {
  await pluginsStore.reload()
  await loadLayout()
}

async function toggleWidgetVisible(widget: PluginWidgetInfo): Promise<void> {
  busy.value = `widget:${widget.id}`
  try {
    const result = await window.aurora.plugins.setWidgetVisible({
      pluginId: widget.pluginId,
      widgetId: widget.id,
      visible: !widgetVisible(widget),
    })
    if (!result.ok) fail(result.message)
    else await loadLayout()
  } finally {
    busy.value = null
  }
}

async function setWidgetLevel(widget: PluginWidgetInfo, rawLevel: string): Promise<void> {
  const option = widgetLevelOptions.find((item) => item.value === rawLevel)
  if (option === undefined) return
  busy.value = `widget:${widget.id}`
  try {
    const result = await window.aurora.plugins.setWidgetWindowLevel({
      pluginId: widget.pluginId,
      widgetId: widget.id,
      windowLevel: option.value,
    })
    if (!result.ok) fail(result.message)
    else await loadLayout()
  } finally {
    busy.value = null
  }
}

async function toggleEnabled(): Promise<void> {
  const plugin = summary.value
  if (plugin === null || plugin.isDev) return
  busy.value = 'enable'
  try {
    const result = await window.aurora.plugins.setEnabled({
      pluginId: plugin.id,
      enabled: !plugin.enabled,
    })
    if (!result.ok) fail(result.message)
    else await refresh()
  } finally {
    busy.value = null
  }
}

async function toggleTrusted(): Promise<void> {
  const plugin = summary.value
  if (plugin === null) return
  busy.value = 'trust'
  try {
    const result = await window.aurora.plugins.setTrusted({
      pluginId: plugin.id,
      trusted: !plugin.trusted,
    })
    if (!result.ok) fail(result.message)
    else await refresh()
  } finally {
    busy.value = null
  }
}

async function restart(): Promise<void> {
  const plugin = summary.value
  if (plugin === null) return
  busy.value = 'restart'
  try {
    const result = await window.aurora.plugins.restart({ pluginId: plugin.id })
    if (!result.ok) fail(result.message)
    else {
      await refresh()
      succeed(`已重启 ${plugin.name}，面板与小组件已刷新`)
    }
  } finally {
    busy.value = null
  }
}

async function rollback(): Promise<void> {
  const plugin = summary.value
  if (plugin === null) return
  busy.value = 'rollback'
  try {
    const result = await window.aurora.plugins.rollback({ pluginId: plugin.id })
    if (!result.ok) fail(result.message)
    else {
      await refresh()
      succeed(`已回滚到 ${result.value.version}`)
    }
  } finally {
    busy.value = null
  }
}

async function openFolder(): Promise<void> {
  const plugin = summary.value
  if (plugin === null) return
  const result = await window.aurora.plugins.openFolder({ pluginId: plugin.id })
  if (!result.ok) fail(result.message)
}

async function openLog(): Promise<void> {
  const plugin = summary.value
  if (plugin === null) return
  const result = await window.aurora.plugins.openLog({ pluginId: plugin.id })
  if (!result.ok) fail(result.message)
}

async function uninstall(): Promise<void> {
  const plugin = summary.value
  if (plugin === null) return
  busy.value = 'uninstall'
  try {
    const result = await window.aurora.plugins.uninstall({
      pluginId: plugin.id,
      deleteData: deleteData.value,
    })
    if (!result.ok) {
      fail(result.message)
      return
    }
    confirmingUninstall.value = false
    windowStore.hide('plugin-config')
  } finally {
    busy.value = null
  }
}

function close(): void {
  void windowStore.hide('plugin-config')
}

watch(
  request,
  (next) => {
    if (next === null) return
    confirmingUninstall.value = false
    deleteData.value = false
    error.value = null
    notice.value = null
    void loadLayout()
  },
  { immediate: true },
)

onMounted(() => {
  offChanged = window.aurora.plugins.onChanged(() => {
    void pluginsStore.reload()
  })
  void refresh()
})

onBeforeUnmount(() => {
  offChanged?.()
  offChanged = null
})
</script>

<template>
  <div class="plugin-config-window anim-window" data-field="plugin-config.page">
    <header class="titlebar-drag" :class="dragClass">
      <strong class="window-title">插件配置</strong>
      <WindowCaption window="plugin-config" class="window-caption" />
    </header>

    <main class="window-body anim-pane">
      <p v-if="request === null" class="empty">请从设置 → 插件列表的「配置」按钮打开。</p>
      <p v-else-if="summary === null" class="empty">插件已移除或尚未加载。</p>

      <div v-else class="page">
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>
        <AppToast v-else-if="notice" tone="ok">{{ notice }}</AppToast>

        <header class="plugin-head">
          <div class="head-main">
            <div class="head-title">
              <StatusDot :tone="statusTone" :title="statusText" :size="9" />
              <h1>{{ summary.name }}</h1>
              <span class="version mono">{{ summary.version }}</span>
              <span v-if="summary.isDev" class="badge">开发</span>
              <span class="state">{{ statusText }}</span>
            </div>
            <p class="description">{{ summary.description }}</p>
            <p class="meta tiny muted">{{ summary.author }} · {{ summary.installPath }}</p>
            <p v-if="summary.lastError" class="last-error">{{ summary.lastError }}</p>
          </div>
          <div class="head-actions">
            <label v-if="!summary.isDev" class="switch">
              <input
                type="checkbox"
                :checked="summary.enabled"
                :disabled="busy !== null"
                @change="toggleEnabled"
              />
              启用
            </label>
            <AppButton
              size="sm"
              variant="ghost"
              data-field="plugin-config.restart"
              :disabled="busy !== null || (!summary.isDev && !summary.enabled)"
              @click="restart"
            >
              重启
            </AppButton>
          </div>
        </header>

        <section class="section-card">
          <h2 class="section-title">配置</h2>
          <p class="section-desc">字段来自插件清单；保存后插件会收到 config.changed。</p>
          <PluginConfigForm
            :key="configKey"
            :plugin-id="summary.id"
            :fields="summary.configFields"
            @saved="succeed('配置已保存')"
          />
        </section>

        <section v-if="desktopWidgets.length > 0" class="section-card">
          <h2 class="section-title">桌面小组件</h2>
          <p class="section-desc">控制每个小组件是否显示在桌面，以及它的窗口层级。</p>
          <div
            v-for="widget in desktopWidgets"
            :key="widget.id"
            class="widget-row"
            :data-field="`plugin-config.widget.${widget.id}`"
          >
            <label class="widget-toggle">
              <input
                type="checkbox"
                :data-field="`plugins.widget-visible.${widget.id}`"
                :checked="widgetVisible(widget)"
                :disabled="busy !== null || !summary.enabled"
                @change="toggleWidgetVisible(widget)"
              />
              <span>{{ widget.title }}</span>
              <span v-if="widget.windowMaterial === 'acrylic'" class="badge">毛玻璃</span>
              <span class="tiny muted">{{ widget.kind === 'page' ? '页面型' : '声明式' }}</span>
            </label>
            <select
              class="widget-level"
              :data-field="`plugins.widget-level.${widget.id}`"
              :value="widgetLevel(widget)"
              :disabled="busy !== null || !summary.enabled"
              title="桌面层失败时回落普通窗口"
              aria-label="小组件窗口层级"
              @change="setWidgetLevel(widget, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="level in widgetLevelOptions" :key="level.value" :value="level.value">
                {{ level.label }}
              </option>
            </select>
          </div>
        </section>

        <section
          v-if="summary.permissions.length > 0"
          class="section-card"
          data-field="plugin-config.permissions"
        >
          <h2 class="section-title">权限</h2>
          <p class="section-desc">安装即信任：插件进程以当前用户权限运行，可读写文件与访问网络。</p>
          <div class="chips">
            <AppTooltip
              v-for="permission in summary.permissions"
              :key="permission"
              :text="PLUGIN_PERMISSION_LABELS[permission]"
            >
              <span class="chip mono">{{ permission }}</span>
            </AppTooltip>
          </div>
        </section>

        <section class="section-card">
          <h2 class="section-title">扩展点</h2>
          <ul
            v-if="
              summary.tools.length > 0 ||
              summary.commands.length > 0 ||
              summary.panels.length > 0 ||
              summary.widgets.length > 0
            "
            class="plain-list"
          >
            <li v-for="tool in summary.tools" :key="`tool-${tool.name}`">
              工具 · <span class="mono">{{ tool.fullName }}</span>
            </li>
            <li v-for="command in summary.commands" :key="`cmd-${command.name}`">
              命令 · <span class="mono">/{{ command.name }}</span> {{ command.title }}
            </li>
            <li v-for="panel in summary.panels" :key="`panel-${panel.id}`">
              面板 · {{ panel.title }}（{{ panel.kind === 'page' ? '页面' : '声明式' }}）
            </li>
            <li v-for="widget in summary.widgets" :key="`widget-${widget.id}`">
              小组件 · {{ widget.title }}（{{ widget.slot === 'desktop' ? '桌面' : '提示条' }}）
            </li>
            <li v-for="theme in summary.themes" :key="`theme-${theme.id}`">
              主题 · {{ theme.name }}
            </li>
          </ul>
          <p v-else class="muted tiny">该插件没有声明扩展点。</p>
        </section>

        <section class="section-card">
          <h2 class="section-title">管理</h2>
          <div class="actions">
            <label class="trust-row">
              <input
                type="checkbox"
                :checked="summary.trusted"
                :disabled="busy !== null"
                @change="toggleTrusted"
              />
              信任此插件：清单声明为安全的工具将免确认，其余工具仍需每次确认
            </label>
            <div class="row wrap">
              <AppButton
                v-if="summary.previousVersion !== undefined"
                size="sm"
                variant="ghost"
                :disabled="busy !== null"
                @click="rollback"
              >
                回滚到 {{ summary.previousVersion }}
              </AppButton>
              <AppButton size="sm" variant="ghost" @click="openFolder">打开目录</AppButton>
              <AppButton size="sm" variant="ghost" @click="openLog">查看日志</AppButton>
              <AppButton
                v-if="!summary.isDev"
                size="sm"
                variant="danger"
                :disabled="busy !== null"
                @click="confirmingUninstall = true"
              >
                卸载
              </AppButton>
            </div>
            <div v-if="confirmingUninstall" class="uninstall-confirm">
              <p class="tiny">卸载后插件目录会被删除，插件数据默认保留。</p>
              <label class="check-row">
                <input v-model="deleteData" type="checkbox" />
                同时删除插件数据与配置
              </label>
              <div class="row">
                <AppButton variant="danger" size="sm" :disabled="busy !== null" @click="uninstall">
                  确认卸载
                </AppButton>
                <AppButton size="sm" variant="ghost" @click="confirmingUninstall = false">
                  取消
                </AppButton>
              </div>
            </div>
          </div>
        </section>

        <footer class="footer">
          <AppButton size="sm" variant="ghost" @click="close">关闭</AppButton>
        </footer>
      </div>
    </main>
  </div>
</template>

<style scoped>
.plugin-config-window {
  display: grid;
  grid-template-rows: 42px minmax(0, 1fr);
  height: 100vh;
  min-width: 0;
  color: var(--text-primary);
  background: var(--glass-content);
}

.titlebar-drag {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 42px;
  padding-left: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--glass-bar);
}

.window-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}

.window-caption {
  position: absolute;
  top: 0;
  right: 0;
  height: 42px;
}

.window-body {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.empty {
  padding: var(--space-8);
  color: var(--text-muted);
  text-align: center;
}

.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-4) var(--space-5) var(--space-6);
}

.plugin-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.head-main {
  min-width: 0;
}

.head-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.head-title h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.version,
.mono {
  font-family: var(--font-mono);
}

.version {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.badge {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.state {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.description {
  margin: 6px 0 2px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}

.meta {
  margin: 0;
  overflow-wrap: anywhere;
}

.last-error {
  margin: 4px 0 0;
  color: var(--error-text);
  font-size: var(--text-sm);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
}

.switch,
.widget-toggle,
.trust-row,
.check-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.section-card {
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.section-title {
  margin: 0 0 4px;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.section-desc {
  margin: 0 0 var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.widget-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border-subtle);
}

.widget-row:first-of-type {
  border-top: 0;
}

.widget-toggle {
  flex-wrap: wrap;
}

.widget-toggle input {
  accent-color: var(--aurora-blue);
}

.widget-level {
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.plain-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.wrap {
  flex-wrap: wrap;
}

.trust-row {
  align-items: flex-start;
  line-height: var(--leading-normal);
}

.trust-row input {
  margin-top: 2px;
  accent-color: var(--aurora-blue);
}

.uninstall-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--error-fill);
}

.uninstall-confirm p {
  margin: 0;
}

.check-row input {
  accent-color: var(--aurora-blue);
}

.footer {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-2);
}

.tiny {
  font-size: var(--text-xs);
}

.muted {
  color: var(--text-muted);
}
</style>
