<script setup lang="ts">
/**
 * 插件临时对话框（docs/14 §5.8）。
 *
 * - 声明式：`plugins:dialogData('open')` 拉 schema，宿主绘制「取消 / 确定」；
 * - 页面型：复用 `PluginPageFrame`（`plugins:pageRpc` 带 dialogId），页面自己提交 / 取消；
 * - 窗口由主进程创建并在结算后销毁：这里只负责把结果交给 `plugins:closeDialog`。
 *
 * 与桌面小组件相反，这扇窗可激活（可以键入文字），因此没有 `focusable:false` 的取舍。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  PluginDialogDataResult,
  PluginDialogInfoResult,
  PluginPanelSchema,
  PluginUiAction,
  PluginUiNode,
} from '@aurora/shared'
import { deepClone } from '@aurora/shared/browser'
import AppToast from '../shared/components/AppToast.vue'
import PluginPageFrame from '../plugins/PluginPageFrame.vue'
import PluginSchemaRenderer from '../plugins/PluginSchemaRenderer.vue'
import { validatePanelSchema } from '../plugins/pluginSchema.js'

const requestId = new URLSearchParams(window.location.search).get('requestId') ?? ''

const info = ref<PluginDialogInfoResult | null>(null)
const schema = ref<PluginPanelSchema | null>(null)
const values = ref<Record<string, unknown>>({})
const loading = ref(true)
const submitting = ref(false)
const error = ref<string | null>(null)
const toast = ref<string | null>(null)
const pending = ref<{ action: PluginUiAction } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
let closed = false

const title = computed(() => info.value?.title ?? '插件窗口')
const isPage = computed(() => info.value?.kind === 'page')

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
    error.value = `窗口 schema 非法：${validated.errors[0] ?? '未知原因'}`
    return
  }
  schema.value = validated.schema
  values.value = { ...collectBoundValues(validated.schema), ...values.value }
  error.value = null
  void nextTick(() => focusFirstInput())
}

/** 控件 `value` 是初始值：未修改时也随「确定」一起提交。 */
function collectBoundValues(current: PluginPanelSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const walk = (nodes: PluginUiNode[]): void => {
    for (const node of nodes) {
      if (node.bind !== undefined && node.value !== undefined && result[node.bind] === undefined) {
        result[node.bind] = node.value
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(current.nodes)
  return result
}

function focusFirstInput(): void {
  const el = document.querySelector<HTMLElement>(
    '.dialog-body input:not([type="checkbox"]):not([type="range"]), .dialog-body textarea, .dialog-body select',
  )
  el?.focus()
}

async function invoke(method: string, params?: unknown): Promise<PluginDialogDataResult | null> {
  loading.value = true
  error.value = null
  try {
    const result = await window.aurora.plugins.dialogData({
      requestId,
      method,
      ...(params === undefined ? {} : { params: deepClone(params) }),
      values: deepClone(values.value),
    })
    if (!result.ok) {
      error.value = result.message
      return null
    }
    if (typeof result.value.toast === 'string' && result.value.toast !== '') {
      showToast(result.value.toast)
    }
    if (result.value.schema !== undefined) applySchema(result.value.schema)
    if (typeof result.value.error === 'string' && result.value.error !== '') {
      error.value = result.value.error
    }
    return result.value
  } catch {
    error.value = '临时窗口已关闭'
    return null
  } finally {
    loading.value = false
  }
}

async function load(): Promise<void> {
  if (requestId === '') {
    error.value = '缺少对话框 id'
    loading.value = false
    return
  }
  try {
    const result = await window.aurora.plugins.dialogInfo({ requestId })
    if (!result.ok) {
      error.value = result.message
      loading.value = false
      return
    }
    info.value = result.value
    if (result.value.kind === 'page') {
      loading.value = false
      return
    }
    await invoke('open')
    if (schema.value === null && error.value === null) {
      error.value = '该对话框没有可显示的内容'
    }
  } catch {
    error.value = '临时窗口初始化失败'
    loading.value = false
  }
}

function updateValue(payload: { bind: string; value: unknown }): void {
  values.value = { ...values.value, [payload.bind]: payload.value }
}

function onAction(node: PluginUiNode): void {
  const action = node.action
  if (action === undefined) return
  if (typeof action.confirm === 'string' && action.confirm !== '') {
    pending.value = { action }
    return
  }
  void runAction(action)
}

async function runAction(action: PluginUiAction): Promise<void> {
  const result = await invoke(action.method, action.params)
  if (result?.close === true) {
    await close(result.submitted !== false, result.data)
  }
}

function confirmAction(): void {
  const current = pending.value
  pending.value = null
  if (current === null) return
  void runAction(current.action)
}

async function submit(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    const result = await invoke('submit')
    if (result === null) return
    if (result.close === false) {
      if (typeof result.error === 'string' && result.error !== '') error.value = result.error
      else if (typeof result.message === 'string' && result.message !== '')
        error.value = result.message
      return
    }
    await close(result.submitted !== false, result.data)
  } finally {
    submitting.value = false
  }
}

async function close(submitted: boolean, data?: unknown): Promise<void> {
  if (closed) return
  closed = true
  try {
    await window.aurora.plugins.closeDialog({
      requestId,
      submitted,
      values: deepClone(values.value),
      ...(data === undefined ? {} : { data: deepClone(data) }),
    })
  } catch {
    // 主进程已销毁窗口（超时 / 插件退出）：无事可做
  }
}

function cancel(): void {
  pending.value = null
  void close(false)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  if (pending.value !== null) {
    pending.value = null
    return
  }
  cancel()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (toastTimer !== undefined) clearTimeout(toastTimer)
})
</script>

<template>
  <div class="dialog-shell" :data-dialog-id="info?.dialogId ?? ''">
    <header class="dialog-head">
      <div class="dialog-heading">
        <span class="dialog-title" data-field="dialog.title">{{ title }}</span>
        <span v-if="info" class="dialog-plugin">{{ info.pluginName }}</span>
      </div>
      <button
        type="button"
        class="dialog-close"
        title="关闭"
        aria-label="关闭"
        data-field="dialog.close"
        @click="cancel"
      >
        ×
      </button>
    </header>

    <section class="dialog-body" :class="{ 'is-page': isPage }">
      <PluginPageFrame
        v-if="isPage && info?.entry !== undefined"
        :plugin-id="info.pluginId"
        :dialog-id="info.dialogId"
        :entry="info.entry"
        :show-bar="false"
      />
      <template v-else>
        <AppToast v-if="error" tone="error" class="dialog-message">{{ error }}</AppToast>
        <AppToast v-else-if="toast" tone="ok" class="dialog-message">{{ toast }}</AppToast>
        <div v-if="loading && schema === null" class="dialog-empty">正在加载…</div>
        <PluginSchemaRenderer
          v-else-if="schema !== null"
          :nodes="schema.nodes"
          :values="values"
          :plugin-id="info?.pluginId ?? ''"
          @action="onAction"
          @update-value="updateValue"
        />
        <div v-else-if="error !== null" class="dialog-empty">
          <p>{{ error }}</p>
          <button type="button" class="dialog-retry" data-field="dialog.retry" @click="load">
            重试
          </button>
        </div>
        <div v-else class="dialog-empty">对话框暂无内容</div>
      </template>

      <div v-if="pending !== null" class="confirm-bar">
        <span class="confirm-text">{{ pending.action.confirm }}</span>
        <div class="confirm-actions">
          <button type="button" class="confirm-primary" @click="confirmAction">确认</button>
          <button type="button" class="confirm-cancel" @click="pending = null">取消</button>
        </div>
      </div>
    </section>

    <footer v-if="!isPage && schema !== null" class="dialog-actions">
      <button type="button" class="action-cancel" data-field="dialog.cancel" @click="cancel">
        取消
      </button>
      <button
        type="button"
        class="action-submit"
        data-field="dialog.submit"
        :disabled="submitting || loading"
        @click="submit"
      >
        确定
      </button>
    </footer>
  </div>
</template>

<style scoped>
.dialog-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-overlay);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex: 0 0 auto;
  height: 40px;
  padding: 0 var(--space-2) 0 var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--fill-1);
  -webkit-app-region: drag;
}

.dialog-heading {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.dialog-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 600;
}

.dialog-plugin {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.dialog-close {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  -webkit-app-region: no-drag;
}

.dialog-close:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.dialog-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-4);
  overflow: auto;
}

/* 页面型对话框：webview 宿主占满正文区（它自己是 flex column 的 100% 高） */
.dialog-body.is-page {
  padding: 0;
}

.dialog-body :deep(.plugin-page) {
  flex: 1;
  min-height: 0;
}

.dialog-message {
  flex: 0 0 auto;
}

.dialog-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.dialog-retry {
  padding: 3px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  flex: 0 0 auto;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  background: var(--fill-1);
}

.action-cancel,
.action-submit {
  padding: 5px 16px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.action-cancel {
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.action-cancel:hover {
  color: var(--text-primary);
}

.action-submit {
  background: var(--aurora-blue);
  color: #fff;
}

.action-submit:disabled {
  opacity: 0.55;
  cursor: default;
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
