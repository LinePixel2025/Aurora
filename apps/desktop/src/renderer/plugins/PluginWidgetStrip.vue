<script setup lang="ts">
/**
 * 提示条里的插件小组件（docs/14 §5.4）。
 *
 * 只渲染 `slot = "edge-bar"` 的**声明式** widget（页面型在清单层就被拒绝）：
 * 不新开窗口、不嵌 webview，单条高度上限 220px，超出内部滚动。
 * 没有小组件时整块不渲染；拉取失败只显示一行极简占位，不弹全局错误。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  PluginPanelSchema,
  PluginPushEvent,
  PluginUiAction,
  PluginUiNode,
  PluginWidgetInfo,
} from '@aurora/shared'
import { deepClone } from '@aurora/shared/browser'
import AppToast from '../shared/components/AppToast.vue'
import PluginSchemaRenderer from '../plugins/PluginSchemaRenderer.vue'
import { validatePanelSchema } from '../plugins/pluginSchema.js'

interface StripItem {
  info: PluginWidgetInfo
  pluginName: string
  pluginReady: boolean
  schema: PluginPanelSchema | null
  error: string | null
  loading: boolean
  toast: string | null
  values: Record<string, unknown>
  pending: { node: PluginUiNode; action: PluginUiAction } | null
  toastTimer?: ReturnType<typeof setTimeout>
}

const items = reactive<StripItem[]>([])
const failed = ref(false)
let offWidgetEvent: (() => void) | null = null
let offChanged: (() => void) | null = null
let disposed = false

const visible = computed(() => items.length > 0)

function dropItem(item: StripItem): void {
  if (item.toastTimer !== undefined) clearTimeout(item.toastTimer)
  const index = items.indexOf(item)
  if (index >= 0) items.splice(index, 1)
}

function showToast(item: StripItem, message: string): void {
  item.toast = message
  if (item.toastTimer !== undefined) clearTimeout(item.toastTimer)
  item.toastTimer = setTimeout(() => {
    item.toast = null
  }, 2400)
}

function applySchema(item: StripItem, raw: unknown): void {
  const validated = validatePanelSchema(raw)
  if (!validated.ok || validated.schema === undefined) {
    item.error = `小组件 schema 非法：${validated.errors[0] ?? '未知原因'}`
    return
  }
  item.schema = validated.schema
  item.error = null
}

async function invoke(item: StripItem, method: string, params?: unknown): Promise<void> {
  item.loading = true
  try {
    const result = await window.aurora.plugins.widgetData({
      pluginId: item.info.pluginId,
      widgetId: item.info.id,
      method,
      ...(params === undefined ? {} : { params: deepClone(params) }),
      values: deepClone(item.values),
    })
    if (!result.ok) {
      item.error = result.message
      return
    }
    if (typeof result.value.toast === 'string' && result.value.toast !== '') {
      showToast(item, result.value.toast)
    }
    if (result.value.schema !== undefined) applySchema(item, result.value.schema)
    else item.error = null
  } finally {
    item.loading = false
  }
}

function onAction(item: StripItem, node: PluginUiNode): void {
  const action = node.action
  if (action === undefined) return
  if (typeof action.confirm === 'string' && action.confirm !== '') {
    item.pending = { node, action }
    return
  }
  void invoke(item, action.method, action.params)
}

function confirmAction(item: StripItem): void {
  const current = item.pending
  item.pending = null
  if (current === null) return
  void invoke(item, current.action.method, current.action.params)
}

function updateValue(item: StripItem, payload: { bind: string; value: unknown }): void {
  item.values = { ...item.values, [payload.bind]: payload.value }
}

async function load(): Promise<void> {
  const result = await window.aurora.plugins.list()
  if (disposed) return
  if (!result.ok) {
    failed.value = true
    return
  }
  failed.value = false
  const next: StripItem[] = []
  for (const plugin of result.value) {
    for (const widget of plugin.widgets) {
      if (widget.slot !== 'edge-bar' || widget.kind !== 'schema') continue
      const existing = items.find(
        (item) => item.info.pluginId === widget.pluginId && item.info.id === widget.id,
      )
      next.push({
        info: widget,
        pluginName: plugin.name,
        pluginReady: plugin.enabled && plugin.status === 'ready',
        schema: existing?.schema ?? null,
        error: existing?.error ?? null,
        loading: false,
        toast: null,
        values: existing?.values ?? {},
        pending: null,
      })
    }
  }
  for (const item of items) {
    if (!next.some((entry) => entry.info === item.info)) dropItem(item)
  }
  items.splice(0, items.length, ...next)
  for (const item of items) {
    if (item.schema === null && item.error === null && item.pluginReady)
      void invoke(item, 'refresh')
  }
}

function matches(event: PluginPushEvent, item: StripItem): boolean {
  return event.pluginId === item.info.pluginId && event.widgetId === item.info.id
}

onMounted(() => {
  void load()
  offWidgetEvent = window.aurora.plugins.onWidgetEvent((event: PluginPushEvent) => {
    for (const item of items) {
      if (matches(event, item))
        void invoke(item, 'event', { event: event.event, payload: event.payload })
    }
  })
  offChanged = window.aurora.plugins.onChanged(() => {
    void load()
  })
})

onBeforeUnmount(() => {
  disposed = true
  offWidgetEvent?.()
  offWidgetEvent = null
  offChanged?.()
  offChanged = null
  for (const item of items) {
    if (item.toastTimer !== undefined) clearTimeout(item.toastTimer)
  }
})
</script>

<template>
  <section v-if="visible" class="card widget-strip" data-field="edge-bar.plugin-widgets">
    <div class="section-heading">
      <span class="section-title">小组件</span>
    </div>
    <article
      v-for="item in items"
      :key="`${item.info.pluginId}/${item.info.id}`"
      class="widget-item"
      :data-plugin-id="item.info.pluginId"
      :data-widget-id="item.info.id"
    >
      <header class="widget-item-head">
        <span class="widget-item-title">{{ item.info.title }}</span>
        <span class="widget-item-plugin">{{ item.pluginName }}</span>
      </header>
      <div class="widget-item-body">
        <AppToast v-if="item.error" tone="error">{{ item.error }}</AppToast>
        <AppToast v-else-if="item.toast" tone="ok">{{ item.toast }}</AppToast>
        <div v-else-if="!item.pluginReady" class="widget-empty">插件未就绪</div>
        <div v-else-if="item.loading && item.schema === null" class="widget-empty">正在加载…</div>
        <PluginSchemaRenderer
          v-else-if="item.schema !== null"
          :nodes="item.schema.nodes"
          :values="item.values"
          :plugin-id="item.info.pluginId"
          @action="onAction(item, $event)"
          @update-value="updateValue(item, $event)"
        />
        <div v-else class="widget-empty">暂无内容</div>

        <div v-if="item.pending !== null" class="confirm-bar">
          <span class="confirm-text">{{ item.pending.action.confirm }}</span>
          <span class="confirm-actions">
            <button type="button" class="confirm-primary" @click="confirmAction(item)">确认</button>
            <button type="button" class="confirm-cancel" @click="item.pending = null">取消</button>
          </span>
        </div>
      </div>
    </article>
  </section>
  <section v-else-if="failed" class="card widget-strip" data-field="edge-bar.plugin-widgets">
    <p class="widget-fallback">插件小组件暂不可用</p>
  </section>
</template>

<style scoped>
.widget-strip {
  gap: var(--space-2);
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.section-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.widget-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-height: 220px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.widget-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex: 0 0 auto;
  padding: 4px var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.widget-item-title {
  font-size: var(--text-xs);
  color: var(--text-primary);
}

.widget-item-plugin {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.widget-item-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 0;
  padding: var(--space-2);
  overflow-y: auto;
}

.widget-empty,
.widget-fallback {
  padding: var(--space-2);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.confirm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
}

.confirm-text {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.confirm-actions {
  display: flex;
  gap: var(--space-1);
}

.confirm-primary,
.confirm-cancel {
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
}

.confirm-primary {
  background: var(--aurora-blue);
  color: #fff;
}

.confirm-cancel {
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}
</style>
