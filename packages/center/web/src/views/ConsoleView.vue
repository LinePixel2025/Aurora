<script setup lang="ts">
import ClientList from '../components/ClientList.vue'
import GlobalConfirmBar from '../components/GlobalConfirmBar.vue'
import RemoteControlPanel from '../components/RemoteControlPanel.vue'
import SessionListPanel from '../components/SessionListPanel.vue'
import SessionView from '../components/SessionView.vue'
import {
  activeSession,
  clientsSorted,
  selectClient,
  selectedEntry,
  state,
  startSession,
} from '../store'
import { formatTime, platformLabel } from '../format'
import { ref } from 'vue'

const creating = ref(false)
const createError = ref('')

// 移动端（≤720px）分段切换：远程控制 / 会话列表默认收起、互斥展开，
// 让对话区成为主角。桌面端切换条被 CSS 隐藏，两块面板恒常显示。
type MobilePanel = 'none' | 'remote' | 'sessions'
const mobilePanel = ref<MobilePanel>('none')

function toggleMobilePanel(panel: Exclude<MobilePanel, 'none'>): void {
  mobilePanel.value = mobilePanel.value === panel ? 'none' : panel
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
      <ClientList
        :clients="clientsSorted"
        :selected-id="state.selectedClientId"
        @select="selectClient"
      />

      <section
        class="session-pane"
        :class="{
          'show-remote': mobilePanel === 'remote',
          'show-sessions': mobilePanel === 'sessions',
        }"
      >
        <!-- 移动端专用分段切换条（桌面端 display:none）：互斥展开下面两块面板 -->
        <div class="mobile-panel-tabs" role="tablist">
          <button
            type="button"
            class="mobile-tab"
            :class="{ open: mobilePanel === 'remote' }"
            @click="toggleMobilePanel('remote')"
          >
            远程控制
          </button>
          <button
            type="button"
            class="mobile-tab"
            :class="{ open: mobilePanel === 'sessions' }"
            @click="toggleMobilePanel('sessions')"
          >
            会话列表
          </button>
        </div>
        <RemoteControlPanel :entry="selectedEntry" />
        <SessionListPanel :entry="selectedEntry" />
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
          <p class="text-2">从列表中选择一个客户端开始</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 外层纵向：全局确认栏在顶、客户端 + 会话布局在下。
   高度链（v0.2.4，docs/12 §10）：根节点拿「100dvh − 顶栏 − 安全区 − page 上下 padding」
   之内的全部高度并内部消化 —— GlobalConfirmBar 在场时由 flex 压缩 .console，
   确认卡再高也只会压缩消息区，**页面本身不再产生文档流滚动**（唯一滚动在 .msg-list）。
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
  gap: 16px;
  align-items: stretch;
}

.session-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
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

/* 移动端分段切换条：桌面端直接隐藏（模板里保留不影响 >720px 布局） */
.mobile-panel-tabs {
  display: none;
}

/* 窄屏（≤720px）：上下堆叠，客户端列表横向滚动（chips）。
   布局主角是对话区：远程控制 / 会话列表收进「分段切换条」背后，默认收起、
   点开互斥展开（show-remote / show-sessions），展开时内部滚动且限高
   （max-height 38%），对话区用 min-height max(200px, 60%) 保底——
   任何状态下会话区都占会话栏可用高度的六成以上，composer 贴底恒常可见。
   根节点仍是固定视口高度（100dvh 随软键盘收缩），唯一长滚动区仍是 .msg-list。 */
@media (max-width: 720px) {
  .console-root {
    height: calc(100vh - var(--topbar-h) - var(--safe-top) - var(--safe-bottom) - 32px);
    height: calc(100dvh - var(--topbar-h) - var(--safe-top) - var(--safe-bottom) - 32px);
    min-height: 0;
  }

  .console {
    flex-direction: column;
    gap: 12px;
  }

  .console > :deep(.client-list) {
    flex: none;
  }

  .session-pane {
    flex: 1;
    min-height: 0;
    gap: 10px;
  }

  .mobile-panel-tabs {
    display: flex;
    gap: 8px;
    flex: none;
  }

  .mobile-tab {
    flex: 1;
    min-height: 40px;
    border: 0;
    border-radius: 980px;
    background: rgba(0, 0, 0, 0.05);
    color: var(--text-2);
    font: inherit;
    font-size: 13.5px;
    cursor: pointer;
  }

  .mobile-tab.open {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  /* 两块面板默认收起；展开时限高 + 内部滚动（flex-shrink 1 兜底极矮视口） */
  .session-pane > :deep(.remote-panel),
  .session-pane > :deep(.session-list-panel) {
    display: none;
    flex: 0 1 auto;
    max-height: 38%;
    overflow-y: auto;
  }

  .session-pane.show-remote > :deep(.remote-panel),
  .session-pane.show-sessions > :deep(.session-list-panel) {
    display: flex;
  }

  /* 对话区高度下限：max() 不支持时回落到 200px（旧浏览器仅损失比例保底） */
  .session-pane > :deep(.session) {
    flex: 1 1 0;
    min-height: 200px;
    min-height: max(200px, 60%);
  }
}
</style>
