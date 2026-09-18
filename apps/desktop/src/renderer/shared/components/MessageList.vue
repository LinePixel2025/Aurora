<script setup lang="ts">
/**
 * 消息列表（交互窗与小窗共用）。
 * `compact` 模式用于小 AI 交互窗口：气泡 + 流式文本，不展示执行卡片。
 */
import { computed } from 'vue'
import type { ChatMessage } from '../composables/useChat.js'
import { renderMarkdown } from '../markdown.js'

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[]
    compact?: boolean
    emptyHint?: string
  }>(),
  { compact: false, emptyHint: '开始一段对话吧' },
)

const rendered = computed(() =>
  props.messages.map((message) => ({
    ...message,
    html: renderMarkdown(message.content),
  })),
)
</script>

<template>
  <div class="messages" :class="{ compact }">
    <p v-if="messages.length === 0" class="empty tiny muted">{{ emptyHint }}</p>
    <article
      v-for="message in rendered"
      :key="message.id"
      class="message"
      :class="[`r-${message.role}`, { error: message.error, pending: message.pending }]"
    >
      <span class="avatar" aria-hidden="true">
        {{ message.role === 'user' ? '我' : message.role === 'assistant' ? 'A' : 'S' }}
      </span>
      <div class="bubble">
        <span v-if="message.pending && message.content === ''" class="typing">
          <i /><i /><i />
        </span>
        <!-- 安全说明：内容先经 renderMarkdown 转义，再套用白名单标记（见 shared/markdown.ts） -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else class="md" v-html="message.html" />
      </div>
    </article>
    <slot />
  </div>
</template>

<style scoped>
.messages {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
}

.empty {
  margin: auto;
  text-align: center;
}

.message {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}

.r-user {
  flex-direction: row-reverse;
}

.avatar {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
}

.r-assistant .avatar {
  background: var(--aurora-gradient);
  color: #08131a;
  font-weight: 700;
}

.bubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
}

.r-user .bubble {
  background: rgba(86, 132, 255, 0.16);
  border-color: rgba(86, 132, 255, 0.28);
}

.message.error .bubble {
  background: rgba(242, 85, 90, 0.12);
  border-color: rgba(242, 85, 90, 0.32);
  color: #ff9ca0;
}

.compact .bubble {
  font-size: 12px;
  padding: 6px 10px;
}

.typing {
  display: inline-flex;
  gap: 4px;
}

.typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aurora-blue);
  animation: bounce 1s infinite ease-in-out;
}

.typing i:nth-child(2) {
  animation-delay: 0.15s;
}

.typing i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes bounce {
  0%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

.md :deep(.md-p) {
  margin: 0 0 6px;
}

.md :deep(.md-p:last-child) {
  margin-bottom: 0;
}

.md :deep(.md-h) {
  margin: 6px 0 4px;
  font-size: 13px;
}

.md :deep(.md-list) {
  margin: 4px 0;
  padding-left: 18px;
}

.md :deep(.md-code) {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.4);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
}

.md :deep(.md-inline) {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-family: var(--font-mono);
  font-size: 12px;
}

.md :deep(.md-link) {
  color: var(--aurora-blue);
  word-break: break-all;
}
</style>
