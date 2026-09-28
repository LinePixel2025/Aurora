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

      <section class="session-pane">
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

/* 窄屏：上下堆叠，客户端列表横向滚动（chips）。
   不再用「220px 魔法数」手算会话区高度：根节点仍是固定视口高度，
   chips 区自然占高，远程控制 / 会话管理两块面板限高 + 内部滚动，
   剩余高度全部归会话区（.session flex:1 → .msg-list 内部滚动）。 */
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
  }

  .session-pane > :deep(.remote-panel),
  .session-pane > :deep(.session-list-panel) {
    flex: none;
    max-height: 40vh;
    max-height: 40dvh;
    overflow-y: auto;
  }
}
</style>
