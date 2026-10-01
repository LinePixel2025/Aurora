<script setup lang="ts">
import GlobalConfirmBar from '../components/GlobalConfirmBar.vue'
import RemoteControlPanel from '../components/RemoteControlPanel.vue'
import SessionListPanel from '../components/SessionListPanel.vue'
import SessionView from '../components/SessionView.vue'
import {
  activeSession,
  clientsSorted,
  selectClient,
  selectedEntry,
  sessionViewTick,
  startSession,
  state,
} from '../store'
import { formatTime, platformLabel } from '../format'
import { computed, ref, watch } from 'vue'

/**
 * 控制台布局（v0.3.2 重构：对话主导，docs/12 §10）：
 * - **对话主区独占全高**，客户端选择收紧为顶部下拉；
 * - 「会话列表 / 远程控制」收进**右侧可折叠边栏**（两个 tab），收起后对话全宽，
 *   折叠状态存 localStorage（移动端不持久化）；
 * - 旧版「远程控制 + 会话列表 + 对话区」同列纵向堆叠（对话区被压在下面）已废弃；
 * - ≤ 720px：对话区全屏，边栏变**覆盖式抽屉**（滑出盖在对话上，选中会话后自动收起）。
 */

type SideTab = 'sessions' | 'remote'
const sideTab = ref<SideTab>('sessions')

const PANEL_KEY = 'aurora-center-side-panel'
const MOBILE_QUERY = '(max-width: 720px)'

function isMobile(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

const panelOpen = ref(window.localStorage.getItem(PANEL_KEY) !== '0')

function togglePanel(): void {
  panelOpen.value = !panelOpen.value
  // 移动端的抽屉开合是一次性的，不持久化——回桌面时边栏保持上次桌面态
  if (!isMobile()) {
    window.localStorage.setItem(PANEL_KEY, panelOpen.value ? '1' : '0')
  }
}

// 移动端：从会话列表点开一个会话后自动收起抽屉，让对话区立刻全屏。
// 用 store 的 viewTick 信号而不是 watch activeSessionKey：点开的就是当前激活会话时
// key 不变，watch 收不到——但抽屉同样应该收起。
watch(sessionViewTick, () => {
  if (isMobile() && panelOpen.value) panelOpen.value = false
})

const creating = ref(false)
const createError = ref('')

const selectedClient = computed(() => selectedEntry.value?.client ?? null)

function onClientChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value) selectClient(value)
}

async function create(): Promise<void> {
  const entry = selectedEntry.value
  if (!entry || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    await startSession(entry.client.clientId)
  } catch (err) {
    createError.value = err instanceof Error ? err.message : '创建会话失败'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="console-root">
    <!-- 全局待批复确认卡栏：含本地会话来源的请求（无会话视图可去，只能在这里批复） -->
    <GlobalConfirmBar />

    <div class="console">
      <section class="chat-main">
        <!-- 顶部条：客户端紧凑下拉 + 边栏开关 -->
        <div class="chat-topbar">
          <label v-if="clientsSorted.length > 0" class="client-picker">
            <span
              class="dot"
              :class="selectedClient?.online ? 'on' : 'off'"
              aria-hidden="true"
            ></span>
            <select
              class="input picker-select"
              :value="state.selectedClientId"
              title="切换客户端"
              @change="onClientChange"
            >
              <option v-for="entry in clientsSorted" :key="entry.client.clientId" :value="entry.client.clientId">
                {{ entry.client.name }} · {{ entry.client.online ? '在线' : '离线' }}
              </option>
            </select>
          </label>
          <span v-else class="text-2 picker-empty">还没有客户端接入——在 Aurora 设置里用 Center 账号登录后，设备会出现在这里</span>

          <button
            class="icon-btn"
            type="button"
            :title="panelOpen ? '收起边栏' : '展开边栏（会话列表 / 远程控制）'"
            @click="togglePanel"
          >
            {{ panelOpen ? '▸' : '◂' }}
          </button>
        </div>

        <SessionView
          v-if="activeSession && selectedEntry"
          :session="activeSession"
          :entry="selectedEntry"
          @new-session="create"
        />
        <div v-else-if="selectedEntry" class="card empty-card">
          <h2 class="empty-title">{{ selectedEntry.client.name }}</h2>
          <p class="text-2 empty-meta">
            {{ platformLabel(selectedEntry.client.platform) }} · v{{
              selectedEntry.client.version
            }}
            · 最近活跃 {{ formatTime(selectedEntry.client.lastSeenAt) }}
          </p>
          <p v-if="!selectedEntry.client.online" class="text-2">客户端当前离线，无法发起会话</p>
          <p
            v-else-if="selectedEntry.status && !selectedEntry.status.center.allowRemoteSession"
            class="text-2"
          >
            该客户端未开启「远程会话」（center.allowRemoteSession），无法在此发起对话
          </p>
          <p v-if="createError" class="form-error">{{ createError }}</p>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="!selectedEntry.client.online || creating"
            @click="create"
          >
            {{ creating ? '创建中…' : '新建会话' }}
          </button>
        </div>
        <div v-else class="card empty-card">
          <p class="text-2">从上方选择一个客户端开始</p>
        </div>
      </section>

      <!-- 右侧边栏：桌面端常驻可折叠，移动端覆盖式抽屉 -->
      <div
        v-if="panelOpen"
        class="drawer-backdrop"
        aria-hidden="true"
        @click="togglePanel"
      ></div>
      <aside v-if="panelOpen" class="card side-panel">
        <div class="side-tabs" role="tablist">
          <button
            type="button"
            class="side-tab"
            :class="{ open: sideTab === 'sessions' }"
            @click="sideTab = 'sessions'"
          >
            会话列表
          </button>
          <button
            type="button"
            class="side-tab"
            :class="{ open: sideTab === 'remote' }"
            @click="sideTab = 'remote'"
          >
            远程控制
          </button>
          <button class="side-close" type="button" title="收起" @click="togglePanel">✕</button>
        </div>
        <div v-show="sideTab === 'sessions'" class="side-body">
          <SessionListPanel :entry="selectedEntry" />
        </div>
        <div v-show="sideTab === 'remote'" class="side-body">
          <RemoteControlPanel :entry="selectedEntry" />
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* 外层纵向：全局确认栏在顶、对话布局在下。
   高度链（docs/12 §10）：根节点拿「100dvh − 顶栏 − 安全区 − page 上下 padding」
   之内的全部高度并内部消化 —— GlobalConfirmBar 在场时由 flex 压缩 .console，
   确认卡再高也只会压缩消息区，页面本身不产生文档流滚动（唯一滚动在 .msg-list）。
   min-height 是极矮视口的兜底（低于它允许页面滚动，保证控制台可用）。 */
.console-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - var(--topbar-h) - var(--safe-top) - var(--safe-bottom) - 40px);
  height: calc(100dvh - var(--topbar-h) - var(--safe-top) - var(--safe-bottom) - 40px);
  min-height: 320px;
}

.console {
  flex: 1;
  min-height: 0; /* 高度链关键：允许被上面的确认栏压缩，滚动收进 .msg-list 内部 */
  display: flex;
  gap: 12px;
  align-items: stretch;
}

/* 对话主区：独占全高，是布局的绝对主角 */
.chat-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.client-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 340px;
  flex: none;
}

.picker-select {
  width: auto;
  max-width: 320px;
  min-height: 34px;
  padding: 5px 30px 5px 12px;
  font-size: 13.5px;
  /* 下拉箭头（原生 appearance 已去掉） */
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236e6e73' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}

.picker-empty {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  margin-left: auto;
  flex: none;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 980px;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-2);
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease;
}

.icon-btn:hover {
  background: rgba(0, 0, 0, 0.09);
  color: var(--text);
}

.empty-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.empty-title {
  margin: 0;
  font-size: 18px;
}

.empty-meta {
  margin: 0 0 10px;
  font-size: 13px;
}

/* ───────────────────────── 右侧边栏 ───────────────────────── */

.side-panel {
  flex: none;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  min-height: 0;
  overflow: hidden;
}

.side-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.side-tab {
  flex: 1;
  min-height: 32px;
  border: 0;
  border-radius: 980px;
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.side-tab.open {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.side-close {
  flex: none;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
}

.side-close:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--text);
}

/* 边栏面板的滚动收在这里；嵌套的 .card 在边栏里退成平面（去白底与阴影），视觉是一块面板 */
.side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.side-body > :deep(.card) {
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  flex: 1 0 auto;
}

.drawer-backdrop {
  display: none;
}

/* ───────────────────────── 窄屏（≤720px）：对话全屏 + 覆盖式抽屉 ─────────────────────────
   边栏变成 fixed 抽屉滑出、盖在对话上（带半透明遮罩），选中会话后自动收起；
   替代旧版「内嵌分段展开限高 38%」——对话区在任何时候都是全屏主角。 */
@media (max-width: 720px) {
  .console-root {
    height: calc(100vh - var(--topbar-h) - var(--safe-top) - var(--safe-bottom) - 32px);
    height: calc(100dvh - var(--topbar-h) - var(--safe-top) - var(--safe-bottom) - 32px);
    min-height: 0;
  }

  .console {
    gap: 0;
    position: relative;
  }

  .client-picker {
    flex: 1;
    max-width: none;
  }

  .picker-select {
    max-width: none;
    width: 100%;
    min-height: 40px;
    font-size: 16px; /* iOS 聚焦缩放规避 */
  }

  .picker-empty {
    font-size: 12.5px;
  }

  .icon-btn {
    width: 40px;
    height: 40px;
  }

  .empty-card {
    padding: 16px;
  }

  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.35);
  }

  .side-panel {
    position: fixed;
    top: calc(var(--topbar-h) + var(--safe-top) + 6px);
    right: 0;
    bottom: 0;
    z-index: 31;
    width: min(86vw, 360px);
    border-radius: var(--radius) 0 0 0;
    padding: 10px 10px calc(10px + var(--safe-bottom));
    animation: drawer-in 0.18s ease;
  }

  .side-body {
    -webkit-overflow-scrolling: touch;
  }
}

@keyframes drawer-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
</style>
