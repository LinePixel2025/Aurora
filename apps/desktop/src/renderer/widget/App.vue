<script setup lang="ts">
/**
 * 桌面小组件（docs/14 §5.3）：一个窗口只渲染一个 widget。
 *
 * - `?pluginId=&widgetId=` 由主进程写入；
 * - 声明式 widget：`plugins:widgetData` 拉 schema，动作回传同一通道；
 * - 页面型 widget：复用 `PluginPageFrame`（内部 `plugins:pageRpc` 带 widgetId）；
 * - `plugins:widgetEvent` 只认自己的 pluginId + widgetId；插件恢复后自动重新拉取。
 *
 * 窗口本身无边框 / 透明 / 置顶：卡片外观与页头拖拽区都在这里画。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  PluginPanelSchema,
  PluginPushEvent,
  PluginSummary,
  PluginUiAction,
  PluginUiNode,
  PluginWidgetInfo,
} from '@aurora/shared'
import { deepClone } from '@aurora/shared/browser'
import AppToast from '../shared/components/AppToast.vue'
import PluginPageFrame from '../plugins/PluginPageFrame.vue'
import PluginSchemaRenderer from '../plugins/PluginSchemaRenderer.vue'
import { validatePanelSchema } from '../plugins/pluginSchema.js'

const params = new URLSearchParams(window.location.search)
const pluginId = params.get('pluginId') ?? ''
const widgetId = params.get('widgetId') ?? ''
/**
 * 原生材质：主进程确认 Acrylic 真正挂上时用 `material=acrylic` 写入 URL；
 * 之后随外观开关 / 平台能力变化由 `plugins:widgetMaterial` 推送（v37）。
 */
const material = ref<'none' | 'acrylic'>(params.get('material') === 'acrylic' ? 'acrylic' : 'none')
/** 建窗查询参数先给出首帧；插件摘要加载后再以清单值为准（开发态改清单可即时生效）。 */
const hideCloseButton = ref(params.get('hideCloseButton') === '1')

const info = ref<PluginWidgetInfo | null>(null)
const summary = ref<PluginSummary | null>(null)
const schema = ref<PluginPanelSchema | null>(null)
const values = ref<Record<string, unknown>>({})
const loading = ref(false)
const error = ref<string | null>(null)
const toast = ref<string | null>(null)

let offWidgetEvent: (() => void) | null = null
let offWidgetMaterial: (() => void) | null = null
let offChanged: (() => void) | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let retryCount = 0
/** 启动期 IPC handler 可能尚未注册：有界重试 + plugins:changed 双保险，不永久空窗。 */
const MAX_RETRIES = 20
const RETRY_DELAY_MS = 250

const title = computed(() => info.value?.title ?? '小组件')
const isPage = computed(() => info.value?.kind === 'page')
const statusHint = computed(() => {
  if (summary.value === null) return ''
  if (summary.value.status === 'ready') return ''
  if (summary.value.status === 'crashed') return '插件已崩溃'
  if (summary.value.enabled === false || summary.value.status === 'disabled') return '插件已停用'
  return ''
})

function showToast(message: string): void {
  toast.value = message
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 2400)
}

function applySchema(raw: unknown): void {
  const validated = validatePanelSchema(raw)
  if (!validated.ok || validated.schema === undefined) {
    error.value = `小组件 schema 非法：${validated.errors[0] ?? '未知原因'}`
    return
  }
  schema.value = validated.schema
  error.value = null
}

function scheduleRetry(): void {
  if (disposed || retryTimer !== undefined || retryCount >= MAX_RETRIES) return
  retryCount += 1
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void refreshIfReady()
  }, RETRY_DELAY_MS)
}

async function loadInfo(): Promise<PluginSummary | null> {
  try {
    const result = await window.aurora.plugins.list()
    if (!result.ok) {
      error.value = `插件界面加载失败：${result.message}`
      return null
    }
    const found = result.value.find((plugin) => plugin.id === pluginId) ?? null
    summary.value = found
    info.value = found?.widgets.find((widget) => widget.id === widgetId) ?? null
    hideCloseButton.value = info.value?.hideCloseButton === true
    if (found === null) {
      error.value = '插件不存在'
    } else if (info.value === null) {
      error.value = '小组件不存在'
    } else {
      // 成功一次后不再残留「启动期读取失败」的文案
      error.value = null
    }
    return found
  } catch (cause) {
    // invoke 在 handler 尚未注册时会 reject（而不是回 { ok: false }）。
    error.value = '插件界面正在启动，请稍候…'
    void cause
    return null
  }
}

async function invoke(method: string, params?: unknown): Promise<void> {
  if (isPage.value) return
  loading.value = true
  try {
    const result = await window.aurora.plugins.widgetData({
      pluginId,
      widgetId,
      method,
      ...(params === undefined ? {} : { params: deepClone(params) }),
      values: deepClone(values.value),
    })
    if (!result.ok) {
      error.value = result.message
      return
    }
    if (typeof result.value.toast === 'string' && result.value.toast !== '') {
      showToast(result.value.toast)
    }
    if (result.value.schema !== undefined) applySchema(result.value.schema)
    else error.value = null
  } finally {
    loading.value = false
  }
}

function onAction(node: PluginUiNode): void {
  const action: PluginUiAction | undefined = node.action
  if (action === undefined) return
  void invoke(action.method, action.params)
}

function updateValue(payload: { bind: string; value: unknown }): void {
  values.value = { ...values.value, [payload.bind]: payload.value }
}

async function hide(): Promise<void> {
  await window.aurora.plugins.setWidgetVisible({ pluginId, widgetId, visible: false })
}

let initialized = false

/**
 * 拉插件摘要并驱动首屏 / 后续重载。
 *
 * - 首次成功之前失败（IPC handler 未注册、插件尚未就绪）→ 有界重试；
 *   `plugins:changed` 也会再次触发，双保险；
 * - 页面型：每次变化都让 PluginPageFrame 重载 webview（插件重启后的内容不会停在旧页）；
 * - 声明式：每次变化都重拉 schema（旧 schema 在加载失败时保留）。
 */
async function refreshIfReady(): Promise<void> {
  const found = await loadInfo()
  if (found === null) {
    scheduleRetry()
    return
  }
  retryCount = 0
  if (!initialized) {
    initialized = true
    if (isPage.value) return
    offWidgetEvent = window.aurora.plugins.onWidgetEvent((event: PluginPushEvent) => {
      if (event.pluginId !== pluginId || event.widgetId !== widgetId) return
      void invoke('event', { event: event.event, payload: event.payload })
    })
    void invoke('refresh')
    return
  }
  // 页面型由 PluginPageFrame 自己订阅 plugins:changed 并 reload（chat 面板同一套），
  // 这里只处理声明式 widget，避免一次重启触发两次 webview 重载。
  if (isPage.value) return
  if (!loading.value) void invoke('refresh')
}

function retryNow(): void {
  error.value = null
  retryCount = 0
  void refreshIfReady()
}

onMounted(() => {
  // 先订阅、再加载：启动窗口期的一次推送也不能丢（与 bootstrapApp 同一硬口径）。
  offChanged = window.aurora.plugins.onChanged(() => {
    void refreshIfReady()
  })
  offWidgetMaterial = window.aurora.plugins.onWidgetMaterial((event) => {
    if (event.pluginId !== pluginId || event.widgetId !== widgetId) return
    material.value = event.material
  })
  void refreshIfReady()
})

onBeforeUnmount(() => {
  disposed = true
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
  offWidgetEvent?.()
  offWidgetEvent = null
  offWidgetMaterial?.()
  offWidgetMaterial = null
  offChanged?.()
  offChanged = null
  if (toastTimer !== undefined) clearTimeout(toastTimer)
})
</script>

<template>
  <div
    class="widget-card"
    :data-plugin-id="pluginId"
    :data-widget-id="widgetId"
    :data-material="material"
  >
    <header class="widget-head">
      <span class="widget-title">{{ title }}</span>
      <span v-if="statusHint !== ''" class="widget-status">{{ statusHint }}</span>
      <button
        v-if="!hideCloseButton"
        type="button"
        class="widget-hide"
        title="隐藏小组件"
        @click="hide"
      >
        ×
      </button>
    </header>

    <div class="widget-body">
      <PluginPageFrame
        v-if="isPage && info?.entry !== undefined"
        :plugin-id="pluginId"
        :widget-id="widgetId"
        :entry="info.entry"
        :title="title"
      />
      <template v-else>
        <AppToast v-if="error" tone="error" class="widget-message">{{ error }}</AppToast>
        <AppToast v-else-if="toast" tone="ok" class="widget-message">{{ toast }}</AppToast>
        <div v-if="loading && schema === null" class="widget-empty">正在加载小组件…</div>
        <PluginSchemaRenderer
          v-else-if="schema !== null"
          :nodes="schema.nodes"
          :values="values"
          :plugin-id="pluginId"
          @action="onAction"
          @update-value="updateValue"
        />
        <div v-else-if="error !== null" class="widget-empty">
          <p>{{ error }}</p>
          <button type="button" class="widget-retry" data-field="widget.retry" @click="retryNow">
            重试
          </button>
        </div>
        <div v-else-if="summary === null" class="widget-empty">正在读取插件…</div>
        <div v-else-if="statusHint === ''" class="widget-empty">小组件暂无内容</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.widget-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
  box-shadow: var(--shadow-hairline, 0 6px 24px rgba(0, 0, 0, 0.28));
  color: var(--text-primary);
  font-size: var(--text-sm);
}

/*
 * 玻璃卡片：仅当主进程确认原生 Acrylic 已挂上（material=acrylic）且外观毛玻璃开启时，
 * 把卡片内用到的实色令牌重映射到玻璃令牌；关毛玻璃或材质回落时保持上面的不透明外观。
 * 令牌在卡片上局部重定义，内部渲染器不用改就能一起透出系统材质。
 */
:global(:root[data-glass='on']) .widget-card[data-material='acrylic'] {
  --bg-raised: var(--bg-glass);
  --bg-overlay: var(--glass-panel);
  --fill-1: var(--glass-surface);
  --fill-2: var(--glass-surface-strong);
  border-color: var(--glass-border);
}

:global(:root[data-glass='on']) .widget-card[data-material='acrylic'] .widget-head {
  background: var(--glass-bar);
}

.widget-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
  height: 28px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--fill-1);
  /* 无边框窗口的拖动区；按钮必须 no-drag，否则点不动 */
  -webkit-app-region: drag;
}

.widget-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.widget-status {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  color: var(--warn-text, var(--text-muted));
}

.widget-hide {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  -webkit-app-region: no-drag;
}

.widget-hide:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.widget-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-3);
}

.widget-message {
  margin-bottom: var(--space-2);
}

.widget-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.widget-empty p {
  margin: 0;
}

.widget-retry {
  padding: 3px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.widget-retry:hover {
  color: var(--text-primary);
}
</style>
