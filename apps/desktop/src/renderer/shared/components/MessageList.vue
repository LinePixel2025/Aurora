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

/** 工具卡片的展示文案（docs/06 §5：运行中 / 成功 / 失败 + 输出摘要） */
function toolStateLabel(state: 'running' | 'success' | 'error'): string {
  if (state === 'running') return '执行中'
  if (state === 'success') return '完成'
  return '失败'
}
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
        <!-- 附件 chip（docs/07 §2.3）：只显示文件名，正文已在主进程提取并入上下文 -->
        <div v-if="(message.attachments?.length ?? 0) > 0" class="attached">
          <span v-for="name in message.attachments" :key="name" class="attached-chip tiny">
            {{ name }}
          </span>
        </div>
        <span v-if="message.pending && message.content === ''" class="typing">
          <i /><i /><i />
        </span>
        <!-- 安全说明：内容先经 renderMarkdown 转义，再套用白名单标记（见 shared/markdown.ts） -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else-if="message.content !== ''" class="md" v-html="message.html" />

        <!-- 工具执行卡片：小窗（compact）不展示，保持精简 -->
        <div v-if="!compact && (message.toolCalls?.length ?? 0) > 0" class="tools">
          <article
            v-for="call in message.toolCalls"
            :key="call.id"
            class="tool-card"
            :class="`t-${call.state}`"
          >
            <span class="tool-state" aria-hidden="true" />
            <span class="mono tiny tool-name">{{ call.name }}</span>
            <span class="badge">{{ toolStateLabel(call.state) }}</span>
            <span v-if="call.outputSummary" class="tiny muted tool-summary">
              {{ call.outputSummary }}
            </span>
          </article>
        </div>
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
  font-size: var(--text-xs);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.r-assistant .avatar {
  background: var(--aurora-gradient);
  color: #08131a;
  font-weight: var(--weight-semibold);
}

.bubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-1);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
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
  font-size: var(--text-sm);
  padding: 6px 10px;
}

/* ── 工具执行卡片（docs/06 §5） ── */
.tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.attached {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.attached-chip {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: rgba(86, 132, 255, 0.18);
  color: var(--text-muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
}

.tool-state {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--status-idle);
}

.t-running .tool-state {
  background: var(--aurora-blue);
  animation: tool-pulse 1s infinite ease-in-out;
}

.t-success .tool-state {
  background: var(--status-ok);
}

.t-error .tool-state {
  background: var(--status-error);
}

.tool-name {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.tool-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

@keyframes tool-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
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
  font-size: var(--text-base);
}

.md :deep(.md-list) {
  margin: 4px 0;
  padding-left: 18px;
}

.md :deep(.md-code) {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.4);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.md :deep(.md-inline) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--fill-2);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.md :deep(.md-link) {
  color: var(--aurora-blue);
  word-break: break-all;
}
</style>
