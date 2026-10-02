<script setup lang="ts">
/**
 * 控制台左栏：接入的客户端（设备）列表。
 *
 * 每台设备一行：在线点 + 名称 + 模式 / 平台 + 最近活跃时间，外加三枚**能力位芯片**
 * （语音输入 / 朗读 / 允许远程会话）。这三枚照抄 `client.status` 快照里的原始值 ——
 * 桌面端「麦克风 / 朗读按钮不出现」这类问题在网页端第一眼就能看出是哪一位没到位；
 * 状态快照未到时整行显示「等待状态…」，而不是把能力位当成 false 静默隐藏。
 */
import { computed } from 'vue'
import type { ClientEntry } from '../../state'
import { formatTime, modeLabel, platformLabel } from '../../lib/format'

const props = defineProps<{ entries: ClientEntry[]; selectedId: string }>()

const emit = defineEmits<{
  (event: 'select', clientId: string): void
  (event: 'create', clientId: string): void
}>()

const onlineCount = computed(() => props.entries.filter((entry) => entry.client.online).length)
const countLabel = computed(() => `${props.entries.length} 台 · ${onlineCount.value} 在线`)
</script>

<template>
  <aside class="rail" data-panel="rail" aria-label="客户端设备">
    <header class="rail-head">
      <span class="rail-title">设备</span>
      <span class="rail-count">{{ countLabel }}</span>
    </header>

    <div v-if="entries.length === 0" class="rail-empty">
      <p class="rail-empty-title">还没有客户端接入</p>
      <p class="rail-empty-note">
        在 Aurora 桌面端的设置里登录 Center 账号并开启 Center，设备就会出现在这里。
      </p>
    </div>

    <ul v-else class="rail-list">
      <li v-for="entry in entries" :key="entry.client.clientId" class="rail-item">
        <button
          type="button"
          class="rail-row"
          :class="{ active: entry.client.clientId === selectedId }"
          data-field="rail.client-row"
          :data-client-id="entry.client.clientId"
          @click="emit('select', entry.client.clientId)"
        >
          <span class="rail-line">
            <i
              class="rail-dot"
              :class="{ on: entry.client.online }"
              data-field="rail.online-dot"
              aria-hidden="true"
            />
            <span class="rail-name">{{ entry.client.name }}</span>
            <span class="rail-chip">{{ modeLabel(entry.client.mode) }}</span>
            <span class="rail-chip">{{ platformLabel(entry.client.platform) }}</span>
          </span>
          <span class="rail-meta">最近活跃 {{ formatTime(entry.client.lastSeenAt) }}</span>
          <span class="rail-caps">
            <span v-if="entry.status === null" class="rail-cap" data-field="rail.no-status">
              等待状态…
            </span>
            <template v-else>
              <span
                v-if="entry.status?.voice?.stt === true"
                class="rail-cap"
                data-field="rail.voice-stt"
              >
                语音输入
              </span>
              <span
                v-if="entry.status?.voice?.tts === true"
                class="rail-cap"
                data-field="rail.voice-tts"
              >
                朗读
              </span>
              <span
                v-if="entry.status?.center.allowRemoteSession === true"
                class="rail-cap"
                data-field="rail.remote-session"
              >
                允许远程会话
              </span>
            </template>
          </span>
        </button>

        <!-- 新建会话只对选中的设备出现：它是"选中项的操作"，不占未选中行的版面 -->
        <div v-if="entry.client.clientId === selectedId" class="rail-actions">
          <button
            v-if="entry.status?.center.allowRemoteSession === true"
            type="button"
            class="rail-new"
            data-action="rail.new-session"
            :title="`在 ${entry.client.name} 上新建远程会话`"
            @click="emit('create', entry.client.clientId)"
          >
            新建会话
          </button>
          <span v-else class="rail-blocked">该设备未允许远程会话</span>
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  min-height: 0;
}

.rail-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 0 var(--space-2);
}

.rail-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.rail-count {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}

.rail-empty {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-3);
  text-align: center;
}

.rail-empty-title {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.rail-empty-note {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--text-muted);
}

.rail-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.rail-item {
  display: flex;
  flex-direction: column;
}

/* 行间只用一条极淡的分隔线（末行不画），列表整体靠悬停 / 选中底色分组 */
.rail-item:not(:last-child) {
  border-bottom: 1px solid var(--border-subtle);
}

.rail-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  text-align: left;
  color: var(--text-secondary);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.rail-row:hover {
  background: var(--fill-2);
}

.rail-row.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.rail-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.rail-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--status-idle);
}

.rail-dot.on {
  background: var(--status-ok);
}

.rail-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.rail-chip {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.rail-meta {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}

.rail-caps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.rail-cap {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

/* 操作行只随选中项渲染，底色与选中行连成一片 */
.rail-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--hit-target);
  padding: 0 var(--space-3) var(--space-2);
  background: var(--fill-3);
}

.rail-new {
  min-height: var(--hit-target);
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  font-size: var(--text-sm);
  transition: background-color var(--transition-fast);
}

.rail-new:hover {
  background: color-mix(in srgb, var(--aurora-blue) 24%, transparent);
}

.rail-blocked {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

/* 窄屏：设备栏转成横向条，靠横滚保持可用（不把纵向空间让给列表） */
@media (max-width: 720px) {
  .rail {
    flex: 0 0 auto;
    min-width: 0;
  }

  .rail-list {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .rail-item {
    flex: 0 0 auto;
    width: min(78vw, 260px);
  }

  .rail-item:not(:last-child) {
    border-bottom: none;
    border-right: 1px solid var(--border-subtle);
  }
}
</style>
