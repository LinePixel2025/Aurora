<script setup lang="ts">
/**
 * 声明式插件面板（docs/14 §3.4）：拉数据 → 渲染受控组件 → 动作回传。
 *
 * 面板数据来自 `plugins:panelData`（主进程校验插件/面板 id 与参数大小）；
 * 插件可以在响应里返回新的 schema（动态面板），校验失败就保留旧面板并报错。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PluginPanelSchema, PluginPushEvent, PluginUiAction, PluginUiNode } from '@aurora/shared/browser'
import AppToast from '../shared/components/AppToast.vue'
import PluginSchemaRenderer from './PluginSchemaRenderer.vue'
import { validatePanelSchema } from './pluginSchema.js'

const props = defineProps<{
  pluginId: string
  panelId: string
  title?: string
  active?: boolean
}>()

const schema = ref<PluginPanelSchema | null>(null)
const values = ref<Record<string, unknown>>({})
const loading = ref(false)
const error = ref<string | null>(null)
const toast = ref<string | null>(null)
const pending = ref<{ node: PluginUiNode; action: PluginUiAction } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
let offPanelEvent: (() => void) | null = null
let initialized = false

function showToast(message: string): void {
  toast.value = message
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 2600)
}

function applySchema(raw: unknown): void {
  const validated = validatePanelSchema(raw)
  if (!validated.ok || validated.schema === undefined) {
    error.value = `面板 schema 非法：${validated.errors[0] ?? '未知原因'}`
    return
  }
  schema.value = validated.schema
  error.value = null
}

async function invoke(method: string, params?: unknown): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await window.aurora.plugins.panelData({
      pluginId: props.pluginId,
      panelId: props.panelId,
      method,
      ...(params === undefined ? {} : { params }),
      values: { ...values.value },
    })
    if (!result.ok) {
      error.value = result.message
      return
    }
    if (typeof result.value.toast === 'string' && result.value.toast !== '') {
      showToast(result.value.toast)
    }
    if (result.value.schema !== undefined) applySchema(result.value.schema)
  } finally {
    loading.value = false
    initialized = true
  }
}

function refresh(): void {
  void invoke('refresh')
}

function onAction(node: PluginUiNode): void {
  const action = node.action
  if (action === undefined) return
  if (typeof action.confirm === 'string' && action.confirm !== '') {
    pending.value = { node, action }
    return
  }
  void invoke(action.method, action.params)
}

function confirmAction(): void {
  const current = pending.value
  pending.value = null
  if (current === null) return
  void invoke(current.action.method, current.action.params)
}

function updateValue(payload: { bind: string; value: unknown }): void {
  values.value = { ...values.value, [payload.bind]: payload.value }
}

watch(
  () => props.active,
  (active) => {
    if (active === true && !initialized && !loading.value) refresh()
  },
)

onMounted(() => {
  if (props.active !== false) refresh()
  // 插件主动推送（`ctx.ui.panelEvent`）：只认自己的 pluginId + panelId，收到后按
  // `method = 'event'` 调一次 invokePanel，并应用插件返回的新 schema / toast。
  offPanelEvent = window.aurora.plugins.onPanelEvent((event: PluginPushEvent) => {
    if (event.pluginId !== props.pluginId) return
    if (event.panelId !== props.panelId) return
    void invoke('event', { event: event.event, payload: event.payload })
  })
})

onBeforeUnmount(() => {
  offPanelEvent?.()
  offPanelEvent = null
  if (toastTimer !== undefined) clearTimeout(toastTimer)
})
</script>

<template>
  <div class="plugin-panel" :data-plugin-id="pluginId" :data-panel-id="panelId">
    <header class="panel-bar">
      <span class="panel-title">{{ title ?? '插件面板' }}</span>
      <button type="button" class="refresh-btn" title="刷新" :disabled="loading" @click="refresh">
        {{ loading ? '…' : '刷新' }}
      </button>
    </header>

    <div class="panel-body">
      <AppToast v-if="error" tone="error">{{ error }}</AppToast>
      <AppToast v-else-if="toast" tone="ok">{{ toast }}</AppToast>

      <div v-if="loading && schema === null" class="panel-empty muted">正在加载面板…</div>
      <PluginSchemaRenderer
        v-else-if="schema !== null"
        :nodes="schema.nodes"
        :values="values"
        :plugin-id="pluginId"
        @action="onAction"
        @update-value="updateValue"
      />
      <div v-else-if="error === null" class="panel-empty muted">插件面板暂无内容</div>

      <div v-if="pending !== null" class="confirm-bar">
        <span class="confirm-text">{{ pending.action.confirm }}</span>
        <div class="confirm-actions">
          <button type="button" class="confirm-primary" @click="confirmAction">确认</button>
          <button type="button" class="confirm-cancel" @click="pending = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.panel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.panel-title {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.refresh-btn {
  padding: 2px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.refresh-btn:hover:not(:disabled) {
  color: var(--text-primary);
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
  overflow: auto;
}

.panel-empty {
  padding: var(--space-4);
  text-align: center;
  font-size: var(--text-sm);
}

.confirm-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-overlay);
}

.confirm-text {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.confirm-actions {
  display: flex;
  gap: var(--space-1);
}

.confirm-primary,
.confirm-cancel {
  padding: 3px 12px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
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
