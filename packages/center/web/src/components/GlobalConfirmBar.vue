<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { expireConfirm, resolveConfirm, state, summarizeInput } from '../store'
import { formatRemaining, remainingMs } from '../format'

/**
 * 全局待批复确认卡栏（docs/12 §10，常驻 ConsoleView 顶部）：
 * 列出所有未过期的 confirm.request —— 含**本地会话来源**的（其 sessionId 不带
 * center- 前缀、没有对应会话视图，只能在这里批复）。与 SessionView 里的卡
 * 共用同一份 state.confirms（按 confirmId 去重），先到先得：一边批复另一边即消失。
 * 过期条目每秒心跳自动摘除（同 SessionView 的套路）。
 */

const now = ref(Date.now())
const heartbeat = window.setInterval(() => {
  now.value = Date.now()
  for (const entry of [...state.confirms]) {
    if (remainingMs(entry.request.expiresAt, now.value) <= 0) expireConfirm(entry)
  }
}, 1000)
onBeforeUnmount(() => window.clearInterval(heartbeat))

function clientName(clientId: string): string {
  return state.clients.get(clientId)?.client.name ?? clientId
}

function countdown(expiresAt: string): string {
  return formatRemaining(remainingMs(expiresAt, now.value))
}

function isExpired(expiresAt: string): boolean {
  return remainingMs(expiresAt, now.value) <= 0
}
</script>

<template>
  <section
    v-if="state.confirms.length > 0"
    class="card global-confirm-bar"
    data-panel="global-confirm-bar"
  >
    <header class="bar-head">
      <span class="bar-title">待批复确认（{{ state.confirms.length }}）</span>
      <span class="bar-sub text-2">敏感工具请求 · 与会话内的卡先到先得 · 超时按拒绝</span>
    </header>
    <div v-for="c in state.confirms" :key="c.request.confirmId" class="bar-item">
      <div class="item-main">
        <div class="item-head">
          <span class="item-tool">{{ c.request.toolName }}</span>
          <span class="text-2 item-meta">
            {{ clientName(c.clientId) }} · {{ c.request.sessionId }}
          </span>
          <span class="item-countdown" :class="{ expired: isExpired(c.request.expiresAt) }">
            {{ countdown(c.request.expiresAt) }}
          </span>
        </div>
        <p v-if="summarizeInput(c.request.input)" class="item-input mono">
          {{ summarizeInput(c.request.input) }}
        </p>
      </div>
      <div class="item-actions">
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="isExpired(c.request.expiresAt)"
          @click="resolveConfirm(c, false)"
        >
          拒绝
        </button>
        <button
          class="btn btn-primary btn-sm"
          type="button"
          :disabled="isExpired(c.request.expiresAt)"
          @click="resolveConfirm(c, true)"
        >
          批准
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.global-confirm-bar {
  display: grid;
  gap: 10px;
  padding: 12px 16px;
  border: 1px solid rgba(255, 204, 0, 0.45);
  background: #fffbe8;
  flex: none;
}

.bar-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.bar-title {
  font-size: 14px;
  font-weight: 600;
  color: #8a6d00;
}

.bar-sub {
  font-size: 12px;
}

.bar-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: rgba(255, 255, 255, 0.75);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
}

.item-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 4px;
}

.item-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.item-tool {
  font-weight: 600;
  font-size: 13.5px;
}

.item-meta {
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-countdown {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}

.item-countdown.expired {
  color: var(--danger, #d70015);
}

.item-input {
  margin: 0;
  font-size: 12px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.item-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

@media (max-width: 720px) {
  .global-confirm-bar {
    padding: 10px 12px;
  }

  .bar-item {
    flex-direction: column;
    gap: 8px;
  }

  .item-actions {
    width: 100%;
  }

  .item-actions .btn {
    flex: 1;
  }
}
</style>
