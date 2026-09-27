<script setup lang="ts">
import { platformLabel } from '../format'
import type { ClientEntry } from '../store'

defineProps<{
  clients: ClientEntry[]
  selectedId: string
}>()

defineEmits<{ select: [clientId: string] }>()
</script>

<template>
  <aside class="card client-list">
    <div class="client-list-head">
      <span class="panel-title">客户端</span>
    </div>
    <ul class="client-items">
      <li v-for="entry in clients" :key="entry.client.clientId">
        <button
          class="client-item"
          type="button"
          :class="{ selected: entry.client.clientId === selectedId }"
          @click="$emit('select', entry.client.clientId)"
        >
          <span class="dot" :class="entry.client.online ? 'on' : 'off'"></span>
          <span class="client-meta">
            <span class="client-name">{{ entry.client.name }}</span>
            <span class="client-sub">
              {{ platformLabel(entry.client.platform) }} · v{{ entry.client.version }}
            </span>
          </span>
        </button>
      </li>
    </ul>
    <p v-if="clients.length === 0" class="client-empty text-2">
      还没有客户端接入——在 Aurora 设置里用 Center 账号登录连接后，设备会出现在这里。
    </p>
  </aside>
</template>

<style scoped>
.client-list {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 14px 10px 12px;
  overflow: hidden;
}

.client-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 10px;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
}

.client-items {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}

.client-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--text);
  text-align: left;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.client-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.client-item.selected {
  background: var(--accent-soft);
}

.client-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.client-name {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-item.selected .client-name {
  color: var(--accent);
}

.client-sub {
  font-size: 12px;
  color: var(--text-2);
}

.client-empty {
  font-size: 12.5px;
  padding: 10px 8px;
  margin: 0;
}

/* 窄屏：列表变横向滚动 chips（选中后会话区仍在下方全宽，随时可换设备） */
@media (max-width: 720px) {
  .client-list {
    width: 100%;
    padding: 10px 8px 8px;
  }

  .client-list-head {
    padding: 0 6px 6px;
  }

  .client-items {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 4px;
  }

  .client-items li {
    flex: none;
  }

  .client-item {
    flex-direction: column;
    align-items: center;
    gap: 5px;
    min-width: 104px;
    padding: 10px 12px;
    text-align: center;
    background: var(--bg);
    border-radius: var(--radius-sm);
  }

  .client-meta {
    align-items: center;
    max-width: 120px;
  }
}
</style>
