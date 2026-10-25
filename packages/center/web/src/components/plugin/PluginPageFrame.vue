<script setup lang="ts">
/**
 * Center 侧页面型插件面板宿主（docs/12 §6.5）。
 *
 * 桌面端用 `aurora-plugin://` + 专用 preload；网页端拿不到那条协议，因此页面来自
 * **已发布到本 Center 的市场包**（`/p/<pluginId>/<version>/<path>`），跑在
 * `sandbox="allow-scripts"` 的 iframe 里：opaque origin、无 Node、无父页 DOM 访问、
 * `connect-src 'none'`。页面唯一的外联通道是服务器注入的 `window.auroraPlugin`
 * （postMessage）→ 本组件 → `plugin.panelData`。
 *
 * 与桌面 `PluginPageFrame.vue` 的差异：不挂 webview / IPC，改挂 iframe + postMessage；
 * 页面语义（request/onEvent、`panel` 查询串）保持一致。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CENTER_PLUGIN_PAGE_HOST_SOURCE, CENTER_PLUGIN_PAGE_SOURCE } from '@aurora/shared/browser'
import {
  fetchPluginPanel,
  onPluginEvent,
  subscribePluginPanel,
  unsubscribePluginPanel,
  wsStatus,
} from '../../state'
import { pluginErrorText } from '../../lib/plugin-errors'
import { pluginAssetUrl } from './pluginSchema'

const props = defineProps<{
  clientId: string
  pluginId: string
  panelId: string
  version: string
  /** 清单里的页面入口（相对包根的路径） */
  entry: string
  offline?: boolean
}>()

/**
 * 页面级限流：并发 8、每秒 20 次。
 * 超时必须高于服务器侧 pending 20s：否则页面先报超时，而写操作可能已经在桌面落地，
 * 用户重试就会写两遍（与 hub 的 CENTER_PLUGIN_PENDING_TIMEOUT_MS 对齐）。
 */
const MAX_IN_FLIGHT = 8
const MAX_PER_SECOND = 20
const REQUEST_TIMEOUT_MS = 25_000

const frameEl = ref<HTMLIFrameElement | null>(null)
const loading = ref(true)
const missing = ref(false)
const error = ref('')
/** 页面自己导航走了（桥收到 pagehide 后上报）：从此不再转发任何请求 / 事件 */
const navigated = ref(false)

/**
 * 每次挂载一个关联令牌：页面导航后 `event.source` 已不是 `contentWindow`（旧文档的 source
 * 对不上新 WindowProxy），`bye` 只能靠令牌归属；也避免上一帧迟到的 bye 误断新面板。
 */
const bridgeToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

const pageUrl = (): string => {
  const entry = props.entry.trim().replace(/^\/+/, '')
  if (entry === '') return ''
  const url = `${pluginAssetUrl(props.pluginId, props.version, entry)}?panel=${encodeURIComponent(props.panelId)}`
  return `${url}&__auroraBridge=${encodeURIComponent(bridgeToken)}`
}

let disposed = false
const inFlight = new Set<string>()
let rateWindowStart = 0
let rateCount = 0
let offPluginEvent: (() => void) | null = null
let subscription: { clientId: string; pluginId: string; panelId: string } | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reply(id: string, payload: Record<string, unknown>): void {
  if (disposed || navigated.value) return
  const target = frameEl.value?.contentWindow
  if (target === null || target === undefined) return
  try {
    // opaque origin（sandbox 无 allow-same-origin）拿不到可用的 targetOrigin，只能 '*'
    target.postMessage({ source: CENTER_PLUGIN_PAGE_HOST_SOURCE, id, ...payload }, '*')
  } catch {
    // iframe 已销毁
  }
}

function fail(id: string, message: string): void {
  reply(id, { kind: 'response', ok: false, error: message })
}

function allowRate(): boolean {
  const now = Date.now()
  if (now - rateWindowStart >= 1000) {
    rateWindowStart = now
    rateCount = 0
  }
  rateCount += 1
  return rateCount <= MAX_PER_SECOND
}

async function onRequest(id: string, method: string, params: unknown): Promise<void> {
  if (inFlight.has(id)) return
  if (inFlight.size >= MAX_IN_FLIGHT) {
    fail(id, '插件页面请求过多，请稍后再试')
    return
  }
  if (!allowRate()) {
    fail(id, '操作过于频繁，请稍后再试')
    return
  }
  if (props.offline === true) {
    fail(id, '设备已离线，无法调用插件页面')
    return
  }
  if (params !== undefined && !isRecord(params)) {
    fail(id, 'params 必须是对象')
    return
  }
  inFlight.add(id)
  const timer = window.setTimeout(() => {
    if (!inFlight.delete(id)) return
    fail(id, '插件响应超时')
  }, REQUEST_TIMEOUT_MS)
  try {
    const result = await fetchPluginPanel({
      clientId: props.clientId,
      pluginId: props.pluginId,
      panelId: props.panelId,
      method,
      ...(isRecord(params) ? { params } : {}),
    })
    if (!inFlight.delete(id)) return
    window.clearTimeout(timer)
    reply(id, { kind: 'response', ok: true, result: result.data ?? {} })
  } catch (cause) {
    if (!inFlight.delete(id)) return
    window.clearTimeout(timer)
    fail(id, pluginErrorText(cause instanceof Error ? cause.message : String(cause)))
  }
}

/**
 * 页面自己导航走了：contentWindow 里已是另一份文档（外部站点也可能），
 * 继续 postMessage 等于把面板数据投给第三方。断流并提示重新打开。
 */
function onPageLeft(): void {
  if (disposed || navigated.value) return
  navigated.value = true
  loading.value = false
  inFlight.clear()
  release()
}

/**
 * 请求只认 `event.source === contentWindow`（origin 为 'null'，source 是唯一可靠依据）；
 * `bye` 在旧文档卸载时发出，导航后 source 已对不上新 WindowProxy，改用每帧令牌归属。
 */
function onWindowMessage(event: MessageEvent): void {
  const data = event.data
  if (!isRecord(data) || data['source'] !== CENTER_PLUGIN_PAGE_SOURCE) return
  if (data['kind'] === 'bye') {
    if (data['bridge'] === bridgeToken) onPageLeft()
    return
  }
  const frame = frameEl.value
  if (navigated.value || frame === null || event.source !== frame.contentWindow) return
  if (data['kind'] !== 'request') return
  const id = typeof data['id'] === 'string' ? data['id'] : ''
  const method = typeof data['method'] === 'string' ? data['method'] : ''
  if (id === '' || id.length > 32) return
  if (method === '' || method.length > 64) {
    fail(id, 'method 必须是 1–64 字符的字符串')
    return
  }
  void onRequest(id, method, data['params'])
}

function forwardEvent(event: { event: string; payload?: unknown }): void {
  if (disposed || navigated.value) return
  const target = frameEl.value?.contentWindow
  if (target === null || target === undefined) return
  try {
    target.postMessage(
      {
        source: CENTER_PLUGIN_PAGE_HOST_SOURCE,
        kind: 'event',
        event: event.event,
        payload: event.payload,
      },
      '*',
    )
  } catch {
    // iframe 已销毁
  }
}

function subscribe(): void {
  if (props.offline === true || navigated.value) return
  const next = { clientId: props.clientId, pluginId: props.pluginId, panelId: props.panelId }
  if (
    subscription !== null &&
    subscription.clientId === next.clientId &&
    subscription.pluginId === next.pluginId &&
    subscription.panelId === next.panelId
  ) {
    return
  }
  subscription = next
  void subscribePluginPanel(next.clientId, next.pluginId, next.panelId).catch(() => {
    // 订阅失败不影响页面加载：推送缺失最多是"不自动刷新"
  })
}

function release(): void {
  const current = subscription
  subscription = null
  if (current === null) return
  void unsubscribePluginPanel(current.clientId, current.pluginId, current.panelId).catch(() => {})
}

/** 打开前 HEAD 预检：版本没发布到本 Center 时明确提示，不静默白屏 */
async function precheck(): Promise<void> {
  const url = pageUrl()
  if (url === '') {
    missing.value = true
    loading.value = false
    return
  }
  try {
    const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    if (disposed) return
    missing.value = !response.ok
  } catch {
    if (disposed) return
    missing.value = false
  }
  if (missing.value) loading.value = false
}

watch(wsStatus, (status) => {
  if (status === 'open') subscribe()
})

onMounted(() => {
  window.addEventListener('message', onWindowMessage)
  offPluginEvent = onPluginEvent((event) => {
    if (event.clientId !== props.clientId) return
    if (event.pluginId !== props.pluginId || event.panelId !== props.panelId) return
    forwardEvent(event)
  })
  subscribe()
  void precheck()
})

onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('message', onWindowMessage)
  offPluginEvent?.()
  offPluginEvent = null
  release()
  inFlight.clear()
})
</script>

<template>
  <div class="plugin-frame" data-panel="plugin-page-frame">
    <p v-if="missing" class="frame-notice" data-field="plugin.page-unavailable">
      该版本的页面资源未发布到本 Center（v{{ version }}）。请让管理员从插件市场发布同版本后再试。
    </p>
    <p v-else-if="error !== ''" class="frame-error" data-field="plugin.page-error">{{ error }}</p>
    <div v-if="!missing" class="frame-host">
      <div v-if="loading" class="frame-loading">正在加载插件页面…</div>
      <div v-if="offline === true" class="frame-offline" data-field="plugin.page-offline">
        设备已离线，页面显示的是最后一次加载的内容
      </div>
      <iframe
        v-if="!navigated"
        ref="frameEl"
        class="frame-body"
        data-field="plugin.page-frame"
        :src="pageUrl()"
        :title="`${pluginId} · ${panelId}`"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        @load="loading = false"
        @error="error = '插件页面加载失败'"
      ></iframe>
      <p v-if="navigated" class="frame-notice frame-left" data-field="plugin.page-left">
        插件页面已离开托管地址，连接已断开。请点右上角「刷新」重新打开。
      </p>
    </div>
  </div>
</template>

<style scoped>
.plugin-frame {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.frame-host {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--glass-border-soft);
  border-radius: var(--radius-md);
  background: var(--glass-surface);
}

.frame-body {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 420px;
  border: 0;
  background: transparent;
}

.frame-loading,
.frame-offline,
.frame-notice,
.frame-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}

.frame-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  pointer-events: none;
}

.frame-offline {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  right: var(--space-2);
  z-index: 2;
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
  color: var(--text-secondary);
}

.frame-notice {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  line-height: var(--leading-normal);
}

.frame-left {
  margin: var(--space-3);
}

.frame-error {
  border-radius: var(--radius-sm);
  background: var(--error-fill);
  color: var(--error-text);
}
</style>
