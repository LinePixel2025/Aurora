<script setup lang="ts">
import ClientList from '../components/ClientList.vue'
import RemoteControlPanel from '../components/RemoteControlPanel.vue'
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
  <div class="console">
    <ClientList
      :clients="clientsSorted"
      :selected-id="state.selectedClientId"
      @select="selectClient"
    />

    <section class="session-pane">
      <RemoteControlPanel :entry="selectedEntry" />
      <SessionView
        v-if="activeSession && selectedEntry"
        :session="activeSession"
        :entry="selectedEntry"
        @new-session="create"
      />
      <div v-else-if="selectedEntry" class="card empty-card">
        <h2 class="empty-title">{{ selectedEntry.client.name }}</h2>
        <p class="text-2 empty-meta">
          {{ platformLabel(selectedEntry.client.platform) }} · v{{ selectedEntry.client.version }} ·
          最近活跃 {{ formatTime(selectedEntry.client.lastSeenAt) }}
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
</template>

<style scoped>
.console {
  display: flex;
  gap: 16px;
  align-items: stretch;
  height: calc(100vh - var(--topbar-h) - 40px);
  min-height: 420px;
}

.session-pane {
  flex: 1;
  min-width: 0;
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

/* 窄屏：上下堆叠，客户端列表横向滚动（chips），会话区始终全宽可返回列表 */
@media (max-width: 720px) {
  .console {
    flex-direction: column;
    height: auto;
    min-height: 0;
    gap: 12px;
  }

  .session-pane {
    height: calc(100vh - var(--topbar-h) - 220px);
    min-height: 380px;
  }
}
</style>
