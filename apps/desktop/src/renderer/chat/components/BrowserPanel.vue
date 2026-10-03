<script lang="ts">
/** Agent 展示目标（`show_preview` 工具，2026-10-03）：`token` 变化即导航一次。
 *  单开一个 `<script>` 块放类型：`<script setup>` 里不允许 `export`（编译期直接报错）。 */
export interface BrowserTarget {
  /** 可直接加载的地址（http/https 或 file:// 本地文件） */
  url: string
  /** 地址栏展示用（本地文件显示原始路径，而不是 file:// URL） */
  display: string
  /** 来源标题（工具入参；当前只用于 title 提示） */
  title: string
  /** 单调递增的展示序号：同一目标再次展示也要重新导航 */
  token: number
}
</script>

<script setup lang="ts">
/*
 * 右栏「浏览器」面板（2026-10-03，docs/07 §2.3）：内置 webview 浏览器。
 *
 * 安全口径：
 * - 地址栏只接受 http / https（file: / 内部协议在入口即拒绝）；
 * - `file://` 只走 Agent 工具（`show_preview`）那条受主进程校验的通道 —— 目标必须落在
 *   会话边界根之内才可能到达这里，地址栏永远不接受它；
 * - webview **不带 allowpopups**（弹窗类 window.open 被 guest 层直接拦掉，
 *   主进程 `window-manager.ts` 的 `setWindowOpenHandler` 把 http(s) 目标改成同窗导航）；
 * - webviewTag 只在 chat 窗口开启（window-manager.ts），guest 是独立进程，
 *   不破坏渲染层沙箱。
 *
 * 已知限制（docs/07 §2.3 注明）：webview 元素**重挂载会重载页面**——切到别的 tab
 * 再切回来，当前页面会重新加载（v1 取舍；与终端的「常驻 shell」不同，浏览器没有
 * 可迁移的会话状态，接受这个简化）。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'

const HOME_URL = 'https://www.bing.com'

const props = defineProps<{ target?: BrowserTarget | null }>()

const urlInput = ref('')
const loading = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)
/** 加载失败提示（did-fail-load；离线 / 域名不存在 / 代理不可用都会走到这里） */
const failure = ref('')

const hostEl = ref<HTMLElement | null>(null)
/** webview 是 Electron 注册的自定义元素，Vue 编译器不认识 —— 用 createElement 绕开。
 *  类型只取最小面（沙箱渲染层没有 Electron 类型可用）：既有 WebviewTag 的方法面 */
interface WebviewLike {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  remove(): void
  addEventListener(type: string, listener: (event: never) => void): void
}
interface WebviewFailEvent {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}
let view: WebviewLike | null = null

/** 内网 / 本机地址：用户（或本地 dev server 场景）常直接敲 `localhost:3000`，缺省补 http */
const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i

/**
 * 地址栏输入 → 可加载的 URL（本地文件除外：那条只走工具通道）。
 * 无协议时按主机名分流：本机地址补 `http://`，其余补 `https://`。
 */
function isAllowedUrl(raw: string): URL | null {
  try {
    const trimmed = raw.trim()
    if (trimmed === '') return null
    const withScheme = trimmed.includes('://')
      ? trimmed
      : LOCAL_HOST_PATTERN.test(trimmed)
        ? `http://${trimmed}`
        : `https://${trimmed}`
    const url = new URL(withScheme)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** 地址栏导航：只吃 http / https；拒绝时给出可见提示（静默失败会被当成"浏览器坏了"） */
function navigate(raw: string): void {
  if (view === null) return
  const url = isAllowedUrl(raw)
  if (url === null) {
    failure.value = '地址栏只接受 http / https 网址'
    return
  }
  failure.value = ''
  view.src = url.toString()
}

/** 当前加载的是「工具展示的本地文件」时，地址栏用它记的原始路径 */
let displayOverride: { url: string; display: string } | null = null

/**
 * Agent 工具通道：目标已由主进程校验（http/https 或边界根内的本地文件）。
 * 本地文件记住「展示串 = 原始路径」—— 加载完成后地址栏显示路径而不是 `file://` URL
 * （`did-stop-loading` 里统一用 `view.src` 回填，那条会把 file:// 抄回地址栏）。
 */
function show(target: BrowserTarget): void {
  if (view === null) return
  failure.value = ''
  displayOverride = { url: target.url, display: target.display }
  view.src = target.url
}

function goHome(): void {
  navigate(HOME_URL)
}

function refreshNavState(): void {
  if (view === null) return
  canGoBack.value = view.canGoBack()
  canGoForward.value = view.canGoForward()
}

onMounted(() => {
  const element = document.createElement('webview') as unknown as WebviewLike & HTMLElement
  // 刻意**不设 allowpopups**：guest 的 window.open 一律被拦（http(s) 由主进程改成同窗导航）
  element.setAttribute('style', 'width:100%;height:100%;display:flex;')
  element.addEventListener('did-start-loading', () => {
    loading.value = true
  })
  element.addEventListener('did-stop-loading', () => {
    loading.value = false
    refreshNavState()
    if (view !== null) {
      // 工具展示的本地文件：地址栏回填原始路径（file:// URL 对用户没有可读性）
      urlInput.value =
        displayOverride !== null && displayOverride.url === view.src
          ? displayOverride.display
          : view.src
    }
  })
  element.addEventListener('did-navigate', refreshNavState)
  element.addEventListener('did-navigate-in-page', refreshNavState)
  element.addEventListener('did-fail-load', (event: never) => {
    const detail = event as unknown as WebviewFailEvent
    // -3 = ERR_ABORTED：用户主动停止 / 新导航打断旧导航，不是失败
    if (!detail.isMainFrame || detail.errorCode === -3) return
    failure.value = `无法加载 ${detail.validatedURL}：${detail.errorDescription}（${detail.errorCode}）`
  })
  hostEl.value?.appendChild(element)
  view = element
  if (props.target != null) {
    // 挂载即带目标（工具在别的 tab 上触发时，父级先切 tab 再传 target）
    show(props.target)
  } else {
    goHome()
  }
})

onUnmounted(() => {
  if (view !== null) {
    view.remove()
    view = null
  }
})

// 已经停在浏览器 tab 时再次展示：token 变化即重新导航
watch(
  () => props.target?.token,
  () => {
    if (props.target != null) show(props.target)
  },
)
</script>

<template>
  <div class="bp" data-field="chat.browser">
    <div class="bp-bar">
      <button
        type="button"
        class="bp-btn"
        title="后退"
        :disabled="!canGoBack"
        @click="view?.goBack()"
      >
        ‹
      </button>
      <button
        type="button"
        class="bp-btn"
        title="前进"
        :disabled="!canGoForward"
        @click="view?.goForward()"
      >
        ›
      </button>
      <button
        type="button"
        class="bp-btn"
        :title="loading ? '停止' : '刷新'"
        @click="loading ? view?.stop() : view?.reload()"
      >
        {{ loading ? '×' : '⟳' }}
      </button>
      <input
        v-model="urlInput"
        class="bp-url"
        type="text"
        placeholder="输入网址或 localhost:端口"
        spellcheck="false"
        @keydown.enter="navigate(urlInput)"
      />
      <button type="button" class="bp-btn" title="主页" @click="goHome">⌂</button>
    </div>
    <p v-if="failure !== ''" class="bp-failure tiny" data-field="chat.browser-failure">
      {{ failure }}
    </p>
    <div ref="hostEl" class="bp-host" data-field="chat.browser-host" />
  </div>
</template>

<style scoped>
.bp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: var(--space-2);
  gap: var(--space-1);
}

.bp-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.bp-btn {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
}

.bp-btn:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.bp-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.bp-url {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-xs);
}

.bp-url:focus {
  outline: none;
  border-color: var(--border-strong);
}

.bp-failure {
  flex: 0 0 auto;
  margin: 0;
  color: var(--status-error);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.bp-host {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-base);
}
</style>
