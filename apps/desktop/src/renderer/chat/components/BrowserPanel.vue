<script setup lang="ts">
/*
 * 右栏「浏览器」面板（2026-10-03，docs/07 §2.3）：内置 webview 浏览器。
 *
 * 安全口径：
 * - 地址栏只接受 http / https（file: / 内部协议在入口即拒绝）；
 * - webview **不带 allowpopups**（弹窗类 window.open 被 guest 层直接拦掉）；
 * - webviewTag 只在 chat 窗口开启（window-manager.ts），guest 是独立进程，
 *   不破坏渲染层沙箱。
 *
 * 已知限制（docs/07 §2.3 注明）：webview 元素**重挂载会重载页面**——切到别的 tab
 * 再切回来，当前页面会重新加载（v1 取舍；与终端的「常驻 shell」不同，浏览器没有
 * 可迁移的会话状态，接受这个简化）。
 */
import { onMounted, onUnmounted, ref } from 'vue'

const HOME_URL = 'https://www.bing.com'

const urlInput = ref('')
const loading = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)

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
  addEventListener(type: string, listener: () => void): void
}
let view: WebviewLike | null = null

function isAllowedUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim().includes('://') ? raw.trim() : `https://${raw.trim()}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function navigate(raw: string): void {
  if (view === null) return
  const url = isAllowedUrl(raw)
  if (url === null) {
    window.console?.warn('浏览器面板拒绝导航：', raw)
    return
  }
  view.src = url.toString()
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
  // 刻意**不设 allowpopups**：guest 的 window.open 一律被拦
  element.setAttribute('style', 'width:100%;height:100%;display:flex;')
  element.addEventListener('did-start-loading', () => {
    loading.value = true
  })
  element.addEventListener('did-stop-loading', () => {
    loading.value = false
    refreshNavState()
    if (view !== null) urlInput.value = view.src
  })
  element.addEventListener('did-navigate', refreshNavState)
  element.addEventListener('did-navigate-in-page', refreshNavState)
  hostEl.value?.appendChild(element)
  view = element
  goHome()
})

onUnmounted(() => {
  if (view !== null) {
    view.remove()
    view = null
  }
})
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
        placeholder="输入网址（http / https）"
        spellcheck="false"
        @keydown.enter="navigate(urlInput)"
      />
      <button type="button" class="bp-btn" title="主页" @click="goHome">⌂</button>
    </div>
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

.bp-host {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-base);
}
</style>
