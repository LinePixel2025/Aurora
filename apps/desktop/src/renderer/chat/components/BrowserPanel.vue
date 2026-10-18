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
 *   主进程 `window-manager.ts` 的 `setWindowOpenHandler` 把 http(s) 目标交给渲染层
 *   **另开一个浏览器标签**（`browser:openTab`，2026-10-03））；
 * - webviewTag 只在 chat 窗口开启（window-manager.ts），guest 是独立进程，
 *   不破坏渲染层沙箱。
 *
 * 已知限制（docs/07 §2.3 注明）：webview 元素**重挂载会重载页面**——切到别的 tab
 * 再切回来，当前页面会重新加载（v1 取舍；与终端的「常驻 shell」不同，浏览器没有
 * 可迁移的会话状态，接受这个简化）。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, CircleStop, House, Plus, RotateCw, X } from '@aurora/shared/browser'

const HOME_URL = 'https://www.bing.com'

const props = defineProps<{
  target?: BrowserTarget | null
  active?: boolean
  /**
   * Agent 会话（v35，docs/06 §27）：非空表示这个标签被 Agent 控制 ——
   * 上报 webview 的 `webContentsId`、显示「Agent 操作中」徽章与停止按钮、
   * 并在控制期间**禁用空闲回收**（否则 10 分钟后页面会被换成 about:blank）。
   */
  agentSessionId?: string | null
  /** Agent 状态副文案（来自 browser:agentStatus，缺省按「操作中」显示） */
  agentDetail?: string
  /** Agent 会话是否正忙（徽章点动效） */
  agentBusy?: boolean
  /**
   * 兼容 UA（仅 Agent 标签，v35）：由 App.vue 按 `agent.browser.compatUserAgent`
   * 传 `navigator.userAgent` 剥掉 Electron token 后的值；缺省不设置属性。
   */
  userAgent?: string
}>()
/**
 * 上报两件事：
 * - `title`：标签标题（页面标题优先，页面没给就用主机名回落）；
 * - `new-tab`：用户在浏览器自己的工具条上点了「新建标签页」（2026-10-03）——
 *   由父级再开一个**同类标签**（右栏标签条是唯一记账方，面板不自己造标签）；
 * - `agent-attach`：webview 就绪后把 `webContentsId` 交给父级（再由父级回执主进程）；
 * - `agent-stop`：用户点停止按钮，结束 Agent 对该标签的控制（标签保留）。
 */
const emit = defineEmits<{
  (event: 'title', title: string): void
  (event: 'new-tab'): void
  (event: 'agent-attach', payload: { webContentsId: number }): void
  (event: 'agent-stop'): void
}>()

/** 主机名回落（离线 / 加载失败时页面标题往往不会有）：`https://a.b/c` → `a.b` */
function hostLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname === '' ? url : parsed.hostname
  } catch {
    return url
  }
}

const urlInput = ref('')
const loading = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)
/** 加载失败提示（did-fail-load；离线 / 域名不存在 / 代理不可用都会走到这里） */
const failure = ref('')

/**
 * 隐藏标签的**空闲页面回收**（2026-10-04 性能轮，docs/07 §2.3）。
 *
 * 浏览器标签首次激活后常驻，切走只是 `display:none`；但每个 webview 是独立 guest 进程，
 * 开过十几个网页就常驻十几个进程。这里在标签连续 10 分钟未激活时把页面导航到
 * `about:blank` 释放它（标签 / 地址 / 标题保留），再次激活按原地址重载 ——
 * 代价是一次可接受的重载，换回有界的常驻内存。
 */
const IDLE_RELEASE_MS = 10 * 60_000
const RELEASED_URL = 'about:blank'
let idleTimer: number | null = null
let releasedUrl: string | null = null

function isTabActive(): boolean {
  return props.active !== false
}

/** Agent 控制期间不做空闲回收：页面被换成 about:blank 会让 Agent 的 ref 与操作全部失效。 */
function isAgentControlled(): boolean {
  return (props.agentSessionId ?? '') !== ''
}

function cancelIdleRelease(): void {
  if (idleTimer === null) return
  window.clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleRelease(): void {
  cancelIdleRelease()
  if (view === null || isTabActive() || isAgentControlled()) return
  idleTimer = window.setTimeout(() => {
    idleTimer = null
    releaseIdlePage()
  }, IDLE_RELEASE_MS)
}

function releaseIdlePage(): void {
  if (view === null || isTabActive() || isAgentControlled()) return
  const current = currentUrl()
  if (current === '' || current === RELEASED_URL) return
  releasedUrl = current
  view.stop()
  view.src = RELEASED_URL
}

function restoreIdlePage(): void {
  cancelIdleRelease()
  if (releasedUrl === null || view === null) return
  const url = releasedUrl
  releasedUrl = null
  view.src = url
}

const hostEl = ref<HTMLElement | null>(null)
/** Agent 会话的 attach 只上报一次（dom-ready 会随每次导航重触发） */
let attachReported = false

/**
 * 当前真实地址：`webview.src` 只是**创建时的初始值**，主进程用 `guest.loadURL`
 * 驱动的导航不会回写这个属性（Agent 标签就是这样导航的）。统一用 `getURL()` 读 guest，
 * 拿不到时再回落 `src` —— 地址栏与空闲回收都靠它，别自己造第二份判断。
 */
function currentUrl(): string {
  if (view === null) return ''
  try {
    const live = view.getURL()
    return live === '' ? view.src : live
  } catch {
    return view.src
  }
}

/**
 * 把 webview 的 `getWebContentsId()` 交给父级（父级再 invoke `browser:agentReport`）。
 * guest 还没 attach 时该方法会抛错：静默等下一次 dom-ready，不伪造 id。
 */
function reportAgentAttach(): void {
  if (view === null || attachReported || !isAgentControlled()) return
  try {
    const id = view.getWebContentsId()
    if (!Number.isInteger(id) || id <= 0) return
    attachReported = true
    emit('agent-attach', { webContentsId: id })
  } catch {
    // 尚未 attach：等 dom-ready
  }
}
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
  /** Electron WebviewTag：guest 的 webContents id（Agent 驱动用它定位页面） */
  getWebContentsId(): number
  /** Electron WebviewTag：guest 当前真实 URL（`src` 不会随主进程 loadURL 回写） */
  getURL(): string
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
  cancelIdleRelease()
  releasedUrl = null
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
  cancelIdleRelease()
  releasedUrl = null
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
  /**
   * **必须设 `allowpopups`**（2026-10-03 二次修订，实测教训）：不带它时 guest 的
   * `window.open` / `target="_blank"` 请求在图层就被丢掉，**根本到不了主进程的
   * `setWindowOpenHandler`** —— 表现为「页内点链接毫无反应」，之前那版「同窗导航」的修法
   * 因此从来没真正生效过（只有真实点击才暴露：合成 click 没有用户手势，走的是另一条被拦的路径）。
   * 开了它也不会有真弹窗：主进程的 handler 对**一切**请求返回 `deny`，
   * http(s) 转成我们自己的浏览器标签（`browser:openTab`），其余协议直接拒绝。
   */
  element.setAttribute('allowpopups', '')
  element.setAttribute('style', 'width:100%;height:100%;display:flex;')
  // 兼容 UA（仅 Agent 标签）：必须在 append 之前设置，首个文档即用新 UA 加载
  if ((props.userAgent ?? '') !== '') element.setAttribute('useragent', props.userAgent ?? '')
  element.addEventListener('dom-ready', () => {
    reportAgentAttach()
  })
  element.addEventListener('did-start-loading', () => {
    loading.value = true
    // 先把标签标题落到主机名：离线 / 加载失败时不会有 page-title-updated，
    // 标签至少要能分辨「这是哪一页」（成功加载后会被真正的页面标题覆盖）
    // 空闲回收导航到 about:blank 时不改标题（保留用户最后看的那一页）
    if (view !== null && releasedUrl === null) emit('title', hostLabel(currentUrl()))
  })
  element.addEventListener('did-stop-loading', () => {
    loading.value = false
    refreshNavState()
    // 空闲回收导航到 about:blank 时不要把地址栏改掉（保留用户最后看的地址）
    if (view !== null && releasedUrl === null) {
      const live = currentUrl()
      // 工具展示的本地文件：地址栏回填原始路径（file:// URL 对用户没有可读性）
      urlInput.value =
        displayOverride !== null && displayOverride.url === live ? displayOverride.display : live
    }
  })
  element.addEventListener('did-navigate', refreshNavState)
  element.addEventListener('did-navigate-in-page', refreshNavState)
  // 页面标题 → 标签标题（`page-title-updated` 是 webview 的标准事件；拿不到就保持主机名）
  element.addEventListener('page-title-updated', (event: never) => {
    const detail = event as unknown as { title?: unknown }
    const title = typeof detail.title === 'string' ? detail.title.trim() : ''
    if (title !== '') emit('title', title)
  })
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
  } else if (isAgentControlled()) {
    /**
     * Agent 标签**先停在 about:blank**，由主进程在拿到 webContentsId、装好监听之后
     * 再 `loadURL`（v35）：这样页面加载期的 console / network / did-fail-load 才
     * 全都被记到（先导航再 attach 会漏掉加载期日志，实测冒烟里 console.error 丢失）。
     */
    view.src = RELEASED_URL
  } else {
    goHome()
  }
  scheduleIdleRelease()
})

onUnmounted(() => {
  cancelIdleRelease()
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

// 标签激活 / 隐藏：激活时恢复被回收的页面，隐藏时开始计时
watch(
  () => isTabActive(),
  (active) => {
    if (active) restoreIdlePage()
    else scheduleIdleRelease()
  },
  { immediate: true },
)

// Agent 控制开始 / 结束：开始即停掉空闲回收并补一次 attach 上报；结束时恢复回收计时
watch(
  () => isAgentControlled(),
  (controlled) => {
    if (controlled) {
      cancelIdleRelease()
      reportAgentAttach()
    } else {
      // 会话释放后同一个标签可能被下一次 Agent 会话复用（主进程复用映射时不再发
      // agentOpen，但异常释放后重开会走这条）—— 必须允许再次上报，否则新会话
      // 永远等不到 webContentsId（15s 超时）。
      attachReported = false
      scheduleIdleRelease()
    }
  },
)
</script>

<template>
  <div class="bp" data-field="chat.browser">
    <!--
      导航工具条：后退 / 前进 / 刷新（加载中变停止）/ 地址栏 / 主页。
      图标走 shared 的 lucide 清单（此前是 `‹ › ⟳ ⌂` 字形：在应用字体栈里又细又淡，
      浅色主题下几乎看不见，被当成「根本没有按钮」）。
    -->
    <div class="bp-bar" data-field="chat.browser-bar">
      <button
        type="button"
        class="bp-btn"
        title="后退"
        data-field="chat.browser-back"
        :disabled="!canGoBack"
        @click="view?.goBack()"
      >
        <ArrowLeft :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="bp-btn"
        title="前进"
        data-field="chat.browser-forward"
        :disabled="!canGoForward"
        @click="view?.goForward()"
      >
        <ArrowRight :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="bp-btn"
        :title="loading ? '停止加载' : '刷新'"
        data-field="chat.browser-reload"
        @click="loading ? view?.stop() : view?.reload()"
      >
        <X v-if="loading" :size="14" :stroke-width="1.8" aria-hidden="true" />
        <RotateCw v-else :size="13" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <input
        v-model="urlInput"
        class="bp-url"
        type="text"
        placeholder="输入网址或 localhost:端口"
        spellcheck="false"
        @keydown.enter="navigate(urlInput)"
      />
      <button
        type="button"
        class="bp-btn"
        title="主页"
        data-field="chat.browser-home"
        @click="goHome"
      >
        <House :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <!--
        新建标签页（2026-10-03 用户口径「浏览器标签页本身可以新建一个浏览器标签页」）：
        工具条右端一枚 ＋，就地再开一个浏览器标签（新标签加载主页）——
        入口不再只藏在右栏标签条的「＋」菜单里。关标签仍走标签条上的 ✕。
      -->
      <button
        type="button"
        class="bp-btn"
        title="新建标签页"
        data-field="chat.browser-new-tab"
        @click="emit('new-tab')"
      >
        <Plus :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </div>
    <!--
      Agent 操作条（v35，docs/06 §27）：让用户一眼看到「谁在操作这个页面」并能随时停止。
      只在 Agent 会话存在时渲染；停止只结束控制，标签页与页面内容保留给用户。
    -->
    <div v-if="agentSessionId" class="bp-agent" data-field="chat.browser-agent-badge">
      <span class="bp-agent-dot" :class="{ 'is-busy': agentBusy === true }" aria-hidden="true" />
      <span class="bp-agent-text tiny">Agent 操作中 · {{ agentDetail ?? '已就绪' }}</span>
      <button
        type="button"
        class="bp-btn bp-agent-stop"
        title="停止 Agent 操作浏览器"
        data-field="chat.browser-agent-stop"
        @click="emit('agent-stop')"
      >
        <CircleStop :size="13" :stroke-width="1.8" aria-hidden="true" />
      </button>
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
  min-width: 0;
  height: 100%;
  padding: var(--space-2);
  gap: var(--space-1);
}

.bp-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.bp-btn {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.bp-btn:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 置灰要「看得见但不亮」：0.35 透明度在浅色主题下约等于消失（用户口径：没有按钮） */
.bp-btn:disabled {
  color: var(--text-muted);
  opacity: 0.55;
  cursor: default;
}

.bp-url {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0 2px;
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

/* Agent 操作条：与工具条同一行高，不额外占垂直空间（页面可视区不缩水） */
.bp-agent {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: 0 2px 2px;
  color: var(--text-secondary);
}

.bp-agent-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-info, var(--accent));
}

/* 忙态加一圈柔和的呼吸环：与自感知流光的「正在工作」语义一致 */
.bp-agent-dot.is-busy {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  animation: bp-agent-pulse 1.4s ease-in-out infinite;
}

.bp-agent-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bp-agent-stop {
  flex: 0 0 auto;
}

@keyframes bp-agent-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
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
  min-width: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-base);
}
</style>
