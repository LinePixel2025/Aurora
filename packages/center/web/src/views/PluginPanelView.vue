<script setup lang="ts">
/**
 * Center 插件面板页（#/plugin?client=&plugin=&panel=，docs/12 §6.5）。
 *
 * 内容**实时镜像**桌面右栏面板：声明式面板走 `plugin.panelData` 拉 schema / 提交动作，
 * 页面型面板交给 `PluginPageFrame`（市场 zip + sandbox iframe）；推送经 `plugin.event`。
 * 授权只认设备属主（服务器侧校验），多设备时页内切换。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClientPluginInfo, ClientPluginPanelInfo } from '@aurora/shared'
import type { PluginUiNode } from '@aurora/shared/browser'
import {
  currentUser,
  fetchPluginPanel,
  onPluginEvent,
  state,
  subscribePluginPanel,
  unsubscribePluginPanel,
  wsStatus,
} from '../state'
import { navigate, route } from '../router'
import { pluginErrorText } from '../lib/plugin-errors'
import PluginSchemaRenderer from '../components/plugin/PluginSchemaRenderer.vue'
import PluginPageFrame from '../components/plugin/PluginPageFrame.vue'
import {
  pluginAssetUrl,
  validatePanelSchema,
  type PluginPanelSchema,
} from '../components/plugin/pluginSchema'

interface PanelDevice {
  clientId: string
  name: string
  online: boolean
  plugin: ClientPluginInfo
  panel: ClientPluginPanelInfo
}

const pluginId = computed(() => route.value.query.get('plugin') ?? '')
const panelId = computed(() => route.value.query.get('panel') ?? '')
const requestedClientId = computed(() => route.value.query.get('client') ?? '')

/** 本人名下（含离线）拥有该面板的设备；离线设备保留在列表里，页内明确显示状态 */
const devices = computed<PanelDevice[]>(() => {
  const userId = currentUser.value?.id ?? ''
  const list: PanelDevice[] = []
  for (const entry of state.clients.values()) {
    if (entry.client.ownerUserId !== userId) continue
    const plugin = entry.status?.plugins?.find((item) => item.id === pluginId.value)
    const panel = plugin?.panels.find((item) => item.id === panelId.value)
    if (!plugin || !panel) continue
    list.push({
      clientId: entry.client.clientId,
      name: entry.client.name,
      online: entry.client.online,
      plugin,
      panel,
    })
  }
  return list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
})

/** 在线设备的 status 还没到：插件目录可能稍后才出现，先按「读取中」展示 */
const catalogPending = computed(() => {
  const userId = currentUser.value?.id ?? ''
  return [...state.clients.values()].some(
    (entry) => entry.client.ownerUserId === userId && entry.client.online && entry.status === null,
  )
})

const selectedClientId = ref(requestedClientId.value)

const activeDevice = computed(
  () => devices.value.find((device) => device.clientId === selectedClientId.value) ?? null,
)

const isPage = computed(() => activeDevice.value?.panel.kind === 'page')

watch(
  devices,
  (list) => {
    if (list.some((device) => device.clientId === selectedClientId.value)) return
    const next = list.find((device) => device.online) ?? list[0]
    selectedClientId.value = next?.clientId ?? ''
  },
  { immediate: true },
)

watch(requestedClientId, (clientId) => {
  if (clientId !== '' && devices.value.some((device) => device.clientId === clientId)) {
    selectedClientId.value = clientId
  }
})

/** 设备选择写回地址（刷新 / 分享保持同一台；hash 未变时不会触发重挂载） */
function onDeviceChange(event: Event): void {
  const clientId = (event.target as HTMLSelectElement).value
  if (clientId === '') return
  navigate('plugin', { client: clientId, plugin: pluginId.value, panel: panelId.value })
}

// ───────────────────────── 声明式面板：取值 / 拉 schema / 动作 ─────────────────────────

const schema = ref<PluginPanelSchema | null>(null)
const values = ref<Record<string, string | number | boolean>>({})
const loading = ref(false)
const error = ref('')
const toast = ref('')
const pending = ref<PluginUiNode | null>(null)
const pageReload = ref(0)
let toastTimer: number | undefined
/** 设备切换 / 卸载后，丢弃迟到的旧回执（否则 A 的 schema 会落到 B 上） */
let generation = 0

function showToast(message: string): void {
  toast.value = message
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
    toastTimer = undefined
  }, 2600)
}

function applySchema(raw: unknown): void {
  const validated = validatePanelSchema(raw)
  if (!validated.ok || validated.schema === undefined) {
    error.value = `面板 schema 非法：${validated.errors[0] ?? '未知原因'}`
    return
  }
  schema.value = validated.schema
  error.value = ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function invoke(method: string, params?: unknown): Promise<void> {
  const device = activeDevice.value
  if (!device) return
  if (!device.online) {
    error.value = '设备已离线，无法调用插件面板'
    return
  }
  const token = generation
  loading.value = true
  error.value = ''
  try {
    const reply = await fetchPluginPanel({
      clientId: device.clientId,
      pluginId: device.plugin.id,
      panelId: device.panel.id,
      method,
      ...(isRecord(params) ? { params } : {}),
      values: { ...values.value },
    })
    if (token !== generation) return
    if (typeof reply.toast === 'string' && reply.toast !== '') showToast(reply.toast)
    if (reply.schema !== undefined) applySchema(reply.schema)
  } catch (err) {
    if (token !== generation) return
    error.value = pluginErrorText(err instanceof Error ? err.message : String(err))
  } finally {
    if (token === generation) loading.value = false
  }
}

function refresh(): void {
  if (isPage.value) {
    // 页面型：iframe 自己拉数据，整帧重载即可（与桌面面板刷新语义一致）
    if (activeDevice.value?.online === true) pageReload.value += 1
    return
  }
  void invoke('refresh')
}

function onAction(node: PluginUiNode): void {
  const action = node.action
  if (action === undefined) return
  if (typeof action.confirm === 'string' && action.confirm !== '') {
    pending.value = node
    return
  }
  void invoke(action.method, action.params)
}

function confirmAction(): void {
  const node = pending.value
  pending.value = null
  const action = node?.action
  if (action === undefined) return
  void invoke(action.method, action.params)
}

function updateValue(payload: { bind: string; value: unknown }): void {
  const value = payload.value
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return
  values.value = { ...values.value, [payload.bind]: value }
}

const assetUrl = computed(() => {
  const device = activeDevice.value
  if (!device) return (src: string): string => src
  return (src: string): string => pluginAssetUrl(device.plugin.id, device.plugin.version, src)
})

// ───────────────────────── 订阅（推送只在声明式面板由本页管理） ─────────────────────────

let subscription: { clientId: string; pluginId: string; panelId: string } | null = null

async function syncSubscription(): Promise<void> {
  const device = activeDevice.value
  if (device === null || device.panel.kind !== 'schema') {
    await releaseSubscription()
    return
  }
  const next = { clientId: device.clientId, pluginId: device.plugin.id, panelId: device.panel.id }
  if (
    subscription !== null &&
    subscription.clientId === next.clientId &&
    subscription.pluginId === next.pluginId &&
    subscription.panelId === next.panelId
  ) {
    return
  }
  const previous = subscription
  subscription = next
  if (previous !== null) {
    await unsubscribePluginPanel(previous.clientId, previous.pluginId, previous.panelId).catch(
      () => {},
    )
  }
  await subscribePluginPanel(next.clientId, next.pluginId, next.panelId).catch((err: unknown) => {
    error.value = err instanceof Error ? err.message : '订阅插件面板失败'
  })
}

async function releaseSubscription(): Promise<void> {
  const current = subscription
  subscription = null
  if (current === null) return
  await unsubscribePluginPanel(current.clientId, current.pluginId, current.panelId).catch(() => {})
}

/** 设备切换 / 在线状态变化：清空旧面板与取值，重新订阅并拉一次（页面型由 frame 自己处理） */
const activeDeviceKey = computed(() => {
  const device = activeDevice.value
  return device === null
    ? ''
    : `${device.clientId}\u0000${device.plugin.id}\u0000${device.panel.id}\u0000${device.plugin.version}\u0000${device.online ? 'on' : 'off'}`
})

watch(
  activeDeviceKey,
  () => {
    const device = activeDevice.value
    generation += 1
    loading.value = false
    error.value = ''
    toast.value = ''
    pending.value = null
    schema.value = null
    values.value = {}
    if (device === null) return
    void syncSubscription()
    if (device.panel.kind === 'schema' && device.online) void invoke('refresh')
  },
  { immediate: true },
)

/** WS 重连后订阅表已在服务器侧清空，重新订阅一次（幂等） */
watch(wsStatus, (status) => {
  if (status === 'open') void syncSubscription()
})

let offPluginEvent: (() => void) | null = null

onMounted(() => {
  offPluginEvent = onPluginEvent((event) => {
    const device = activeDevice.value
    if (device === null || device.panel.kind !== 'schema') return
    if (event.clientId !== device.clientId) return
    if (event.pluginId !== device.plugin.id || event.panelId !== device.panel.id) return
    void invoke('event', {
      event: event.event,
      ...(event.payload === undefined ? {} : { payload: event.payload }),
    })
  })
})

onBeforeUnmount(() => {
  generation += 1
  offPluginEvent?.()
  offPluginEvent = null
  void releaseSubscription()
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})

const presenceLabel = computed(() => {
  const device = activeDevice.value
  if (device === null) return ''
  return device.online ? '在线' : '离线'
})
</script>

<template>
  <section
    class="page plugin-page"
    data-panel="plugin-panel"
    :data-plugin-id="pluginId"
    :data-panel-id="panelId"
  >
    <header class="plugin-head">
      <div class="plugin-head-text">
        <h1 class="page-title">{{ activeDevice?.panel.title ?? '插件面板' }}</h1>
        <p class="page-sub" data-field="plugin.origin">
          {{ activeDevice?.plugin.name ?? pluginId }}
          <template v-if="activeDevice"> · v{{ activeDevice.plugin.version }}</template>
          · 实时镜像自桌面侧栏
        </p>
      </div>
      <div class="plugin-head-actions">
        <label v-if="devices.length > 1" class="plugin-device">
          <span>设备</span>
          <select :value="selectedClientId" data-field="plugin.device" @change="onDeviceChange">
            <option v-for="device in devices" :key="device.clientId" :value="device.clientId">
              {{ device.name }}{{ device.online ? '' : '（离线）' }}
            </option>
          </select>
        </label>
        <span
          v-if="activeDevice"
          class="plugin-presence"
          :class="{ online: activeDevice.online }"
          data-field="plugin.presence"
        >
          {{ presenceLabel }}
        </span>
        <button
          class="ui-btn ui-btn--ghost"
          type="button"
          data-action="plugin.refresh"
          :disabled="activeDevice === null || activeDevice.online === false || loading"
          @click="refresh"
        >
          {{ loading ? '…' : '刷新' }}
        </button>
      </div>
    </header>

    <p v-if="error !== ''" class="ui-error" data-field="plugin.error">{{ error }}</p>
    <p v-if="toast !== ''" class="plugin-toast" data-field="plugin.toast" role="status">
      {{ toast }}
    </p>

    <div v-if="activeDevice === null" class="ui-card plugin-empty" data-field="plugin.unavailable">
      <span v-if="catalogPending">正在读取设备插件…</span>
      <template v-else>
        <p class="plugin-empty-text">
          该面板当前不可用：设备离线、插件未启用，或桌面端未开启「允许 Center 远程操作」。
        </p>
        <button class="ui-btn ui-btn--ghost" type="button" @click="navigate('console')">
          返回控制台
        </button>
      </template>
    </div>

    <PluginPageFrame
      v-else-if="isPage"
      :key="`${activeDevice.clientId}:${activeDevice.plugin.version}:${pageReload}`"
      :client-id="activeDevice.clientId"
      :plugin-id="activeDevice.plugin.id"
      :panel-id="activeDevice.panel.id"
      :version="activeDevice.plugin.version"
      :entry="activeDevice.panel.entry ?? ''"
      :offline="activeDevice.online === false"
    />

    <div v-else class="ui-card plugin-card" data-panel="plugin-schema">
      <div v-if="loading && schema === null" class="plugin-empty muted">正在加载面板…</div>
      <PluginSchemaRenderer
        v-else-if="schema !== null"
        :nodes="schema.nodes"
        :values="values"
        :plugin-id="activeDevice.plugin.id"
        :disabled="loading || activeDevice.online === false"
        :asset-url="assetUrl"
        @action="onAction"
        @update-value="updateValue"
      />
      <div v-else-if="error === ''" class="plugin-empty muted">插件面板暂无内容</div>

      <div v-if="pending !== null" class="confirm-bar" data-field="plugin.confirm">
        <span class="confirm-text">{{ pending.action?.confirm }}</span>
        <div class="confirm-actions">
          <button type="button" class="confirm-primary" @click="confirmAction">确认</button>
          <button type="button" class="confirm-cancel" @click="pending = null">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plugin-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}

.plugin-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.plugin-head-text {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.plugin-head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.plugin-device {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.plugin-device select {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.plugin-presence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.plugin-presence::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--status-idle);
}

.plugin-presence.online::before {
  background: var(--status-ok);
}

.plugin-card {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  padding: var(--space-4);
  overflow: auto;
}

.plugin-empty {
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  padding: var(--space-7) var(--space-4);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  text-align: center;
}

.plugin-empty-text {
  margin: 0;
  max-width: 46ch;
  line-height: var(--leading-normal);
}

.plugin-empty.muted {
  color: var(--text-muted);
}

.plugin-toast {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.confirm-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: auto;
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

/* ───────── 基础件（与 FilesView 同款，本页自持） ───────── */

.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast);
}

.ui-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.ui-btn--ghost {
  border-color: var(--border-subtle);
}

.ui-btn--ghost:hover:not(:disabled) {
  background: var(--fill-2);
}

.ui-card {
  background: var(--glass-surface);
  border: 1px solid var(--glass-border-soft);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}

.ui-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-sm);
}
</style>
