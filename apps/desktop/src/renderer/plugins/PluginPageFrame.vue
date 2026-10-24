<script setup lang="ts">
/**
 * 插件页面宿主（docs/14 §2.4）：沙箱 webview + 专用 preload + 宿主侧 RPC 中继。
 *
 * 页面里只有 `window.auroraPlugin`（`request` / `onEvent`），它把请求 `sendToHost` 给这里；
 * 这里带上 guest 的 `webContentsId` 调 `plugins:pageRpc`，主进程据此确认页面归属，
 * 再转给插件进程的 `invokePanel`。页面本身没有 Node、没有 `window.aurora`、不能弹窗/下载。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PluginPushEvent } from '@aurora/shared'
import AppToast from '../shared/components/AppToast.vue'

const props = defineProps<{
  pluginId: string
  panelId?: string
  /** 桌面小组件里的页面：与 panelId 二选一，决定 RPC 走 invokeWidget */
  widgetId?: string
  entry: string
  title?: string
}>()

interface WebviewLike extends HTMLElement {
  src: string
  reload(): void
  stop(): void
  remove(): void
  getWebContentsId(): number
  send(channel: string, ...args: unknown[]): void
}

interface IpcMessageEvent extends Event {
  channel: string
  args: unknown[]
}

const hostEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const guestId = ref(0)
let view: WebviewLike | null = null
let disposed = false

const pageUrl = computed(() => {
  const path = props.entry.replace(/^\/+/, '')
  const suffix =
    props.widgetId === undefined
      ? `?panel=${encodeURIComponent(props.panelId ?? '')}`
      : `?widget=${encodeURIComponent(props.widgetId)}`
  return `aurora-plugin://${props.pluginId}/${path}${suffix}`
})

function reply(id: string, payload: Record<string, unknown>): void {
  try {
    view?.send('aurora:response', { id, ...payload })
  } catch {
    // guest 已销毁：请求方随页面一起消失，不必再处理
  }
}

/**
 * guest id：`dom-ready` 之前页面的首个请求就可能到达（页面脚本先于宿主事件跑完），
 * 因此拿不到缓存值时现场取一次 —— 不拿这个 id 主进程无法确认请求归属。
 */
function currentGuestId(): number {
  if (guestId.value > 0) return guestId.value
  try {
    const id = view?.getWebContentsId() ?? 0
    if (Number.isInteger(id) && id > 0) {
      guestId.value = id
      return id
    }
  } catch {
    // 尚未 attach
  }
  return 0
}

async function onIpcMessage(event: IpcMessageEvent): Promise<void> {
  if (event.channel !== 'aurora:request') return
  const message = event.args[0]
  if (typeof message !== 'object' || message === null) return
  const request = message as { id?: unknown; method?: unknown; params?: unknown }
  const id = typeof request.id === 'string' ? request.id : ''
  const method = typeof request.method === 'string' ? request.method : ''
  if (id === '' || method === '') return
  const currentGuest = currentGuestId()
  if (currentGuest <= 0) {
    reply(id, { ok: false, error: { message: '页面尚未就绪' } })
    return
  }
  try {
    const result = await window.aurora.plugins.pageRpc({
      pluginId: props.pluginId,
      ...(props.widgetId === undefined
        ? { panelId: props.panelId ?? '' }
        : { widgetId: props.widgetId }),
      guestId: currentGuest,
      method,
      params: request.params,
    })
    if (result.ok) reply(id, { ok: true, result: result.value })
    else reply(id, { ok: false, error: { message: result.message } })
  } catch (cause) {
    reply(id, {
      ok: false,
      error: { message: cause instanceof Error ? cause.message : String(cause) },
    })
  }
}

function mountWebview(): void {
  const host = hostEl.value
  if (host === null) return
  const element = document.createElement('webview') as unknown as WebviewLike
  element.setAttribute('partition', `plugin-${props.pluginId}`)
  element.setAttribute('style', 'width:100%;height:100%;display:flex;')
  element.addEventListener('dom-ready', () => {
    loading.value = false
    error.value = null
    try {
      guestId.value = element.getWebContentsId()
    } catch {
      // 尚未 attach：下一次 dom-ready 再取
    }
  })
  element.addEventListener('ipc-message', (event) => {
    void onIpcMessage(event as unknown as IpcMessageEvent)
  })
  element.addEventListener('did-start-loading', () => {
    loading.value = true
  })
  element.addEventListener('did-stop-loading', () => {
    loading.value = false
  })
  element.addEventListener('did-fail-load', (event) => {
    const failure = event as Event & {
      errorCode?: number
      errorDescription?: string
      validatedURL?: string
    }
    if (disposed) return
    // 首次导航在协议 handler 注册前可能被中止（ERR_ABORTED），紧随其后的显式 loadURL
    // 才是真正那次加载；把它当失败会把已渲染的页面盖成错误条。
    if (failure.errorCode === -3) return
    loading.value = false
    error.value = `页面加载失败：${failure.errorDescription ?? '未知原因'}`
  })
  host.appendChild(element)
  view = element
  // src 必须在入 DOM 之后再赋值：先赋属性再 append 时 Electron 不会触发 attach（实测）
  element.src = pageUrl.value
}

function reload(): void {
  error.value = null
  loading.value = true
  try {
    view?.reload()
  } catch {
    // guest 尚未 attach：忽略
  }
}

watch(pageUrl, () => {
  // 同一面板的入口不会变；这里兜住开发态热更新后 src 变化的情况
  if (view !== null) {
    try {
      view.remove()
    } catch {
      /* 已移除 */
    }
    view = null
  }
  mountWebview()
})

function forwardEvent(event: { event: string; payload?: unknown }): void {
  try {
    view?.send('aurora:event', { event: event.event, payload: event.payload })
  } catch {
    // guest 尚未 attach / 已销毁：页面自己会随生命周期消失
  }
}

let offPush: (() => void) | null = null
let offChanged: (() => void) | null = null
let reloadTimer: ReturnType<typeof setTimeout> | undefined

function matchesPush(event: { pluginId: string; panelId?: string; widgetId?: string }): boolean {
  if (event.pluginId !== props.pluginId) return false
  return props.widgetId === undefined
    ? event.panelId === props.panelId
    : event.widgetId === props.widgetId
}

onMounted(() => {
  mountWebview()
  // 面板页与小组件页各订阅自己的推送通道；成对释放，不能全局泄漏。
  const handler = (event: PluginPushEvent): void => {
    if (matchesPush(event)) forwardEvent(event)
  }
  offPush =
    props.widgetId === undefined
      ? window.aurora.plugins.onPanelEvent(handler)
      : window.aurora.plugins.onWidgetEvent(handler)
  // 插件重启 / 配置变更 / 重新就绪：页面必须重载，否则一直显示旧内容。
  offChanged = window.aurora.plugins.onChanged(() => {
    if (disposed || reloadTimer !== undefined) return
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      if (!disposed) reload()
    }, 300)
  })
})

onBeforeUnmount(() => {
  offChanged?.()
  offChanged = null
  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer)
    reloadTimer = undefined
  }
  offPush?.()
  offPush = null
  disposed = true
  try {
    view?.remove()
  } catch {
    /* 已销毁 */
  }
  view = null
})
</script>

<template>
  <div class="plugin-page" :data-plugin-id="pluginId" :data-panel-id="panelId">
    <header class="page-bar">
      <span class="page-title">{{ title ?? '插件页面' }}</span>
      <button type="button" class="reload-btn" @click="reload">刷新</button>
    </header>
    <div class="page-body">
      <div v-if="loading" class="page-overlay">正在加载插件页面…</div>
      <AppToast v-if="error" class="page-error" tone="error">{{ error }}</AppToast>
      <div ref="hostEl" class="page-host"></div>
    </div>
  </div>
</template>

<style scoped>
.plugin-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.page-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.page-title {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.reload-btn {
  padding: 2px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.page-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.page-host {
  width: 100%;
  height: 100%;
}

.page-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--text-sm);
  pointer-events: none;
}

.page-error {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  right: var(--space-2);
  z-index: 2;
}
</style>
