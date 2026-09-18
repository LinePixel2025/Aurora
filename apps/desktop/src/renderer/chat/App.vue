<script setup lang="ts">
/**
 * AI 交互窗口（docs/07 §2.3）：完整对话窗，约 420×640，贴右缘滑出。
 *
 * P1 范围：Markdown 渲染、流式输出、工具执行卡片占位、会话历史占位、模式引导面板。
 * 真实模型的对话与工具调用在 P3 接入（IPC 契约已就绪）。
 */
import { computed, ref } from 'vue'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import MessageList from '../shared/components/MessageList.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import { useModeStore, useSettingsStore, useWindowStore } from '../shared/stores.js'

const chat = useChat('chat')
const { messages, streaming, error: chatError, statusTone, send: sendMessage, abort, clear } = chat
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()

const input = ref('')
const showHistory = ref(false)

const history = computed(() => [
  { id: 'main', title: '完整会话', subtitle: 'AI 交互窗口', active: true },
  { id: 'quick', title: '快速会话', subtitle: '服务窗 / 小窗共享', active: false },
])

/** 工具执行卡片占位：P3 会由 `chat:event` 的 tool 事件填充 */
const toolCards = ref<Array<{ id: string; name: string; state: string }>>([])

const guide = computed(() => {
  const mode = modeStore.current
  if (!mode || mode.guideCompleted) return null
  return mode
})

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '') return
  input.value = ''
  await sendMessage(text)
}

async function close(): Promise<void> {
  await windowStore.hide('chat')
  await windowStore.showMiniChat()
}

async function startGuide(): Promise<void> {
  if (!guide.value) return
  const session = await window.aurora.mode.guideStart(guide.value.id)
  if (session.ok) {
    const step = session.value.step
    if (step) {
      const text = `【${guide.value.displayName} 引导 ${step.index + 1}/${step.total}】${step.question}`
      await chat.send(text)
    }
  }
}

async function markGuideDone(): Promise<void> {
  if (!guide.value) return
  await modeStore.completeGuide(guide.value.id)
}
</script>

<template>
  <div class="chat">
    <header class="head drag-region">
      <div class="row">
        <StatusDot :tone="statusTone" title="AI 状态" />
        <strong>对话</strong>
        <span class="badge">{{ modeStore.current?.displayName ?? '未激活' }}</span>
        <span v-if="settingsStore.needsOnboarding" class="badge warn">未配置模型</span>
      </div>
      <div class="row no-drag">
        <AppButton size="sm" variant="ghost" @click="showHistory = !showHistory">历史</AppButton>
        <AppButton size="sm" variant="ghost" @click="clear">清空</AppButton>
        <AppButton size="sm" variant="ghost" @click="windowStore.show('settings')">设置</AppButton>
        <AppButton size="sm" variant="ghost" @click="close">收起</AppButton>
      </div>
    </header>

    <div class="body">
      <aside v-if="showHistory" class="history">
        <p class="tiny muted">会话（多会话列表在 P3 接入）</p>
        <button
          v-for="item in history"
          :key="item.id"
          type="button"
          class="history-item"
          :class="{ active: item.active }"
        >
          <strong class="tiny">{{ item.title }}</strong>
          <span class="tiny muted">{{ item.subtitle }}</span>
        </button>
      </aside>

      <main class="thread">
        <AppToast v-if="settingsStore.needsOnboarding" tone="warn">
          还没有可用的 AI 模型配置：当前只能返回占位回复。
          <AppButton size="sm" variant="ghost" @click="windowStore.show('settings')"
            >去配置</AppButton
          >
        </AppToast>

        <AppToast v-if="guide" tone="info">
          {{ guide.displayName }} 引导未完成（{{ guide.readinessHint ?? '按步骤完成设置' }}）。
          <AppButton size="sm" variant="ghost" @click="startGuide">开始引导</AppButton>
          <AppButton size="sm" variant="ghost" @click="markGuideDone">标记完成</AppButton>
        </AppToast>

        <MessageList
          :messages="messages"
          empty-hint="这是完整对话窗口：可以问系统状态、让 Aurora 帮忙整理资料。"
        >
          <div v-if="toolCards.length > 0" class="tools">
            <p class="tiny muted">工具执行（P3 接入后展示真实调用）</p>
            <article v-for="card in toolCards" :key="card.id" class="tool-card">
              <span class="mono tiny">{{ card.name }}</span>
              <span class="badge">{{ card.state }}</span>
            </article>
          </div>
        </MessageList>
      </main>
    </div>

    <footer class="composer">
      <textarea
        v-model="input"
        spellcheck="false"
        placeholder="输入消息，Ctrl + Enter 发送"
        @keydown.enter.exact.prevent="send"
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="row">
        <span class="tiny muted grow">
          会话：{{ chat.sessionId }} · 工具与 Skill 将在 P3 接入
        </span>
        <AppButton v-if="streaming" size="sm" @click="abort">停止</AppButton>
        <AppButton
          size="sm"
          variant="primary"
          :disabled="streaming || input.trim() === ''"
          @click="send"
        >
          发送
        </AppButton>
      </div>
      <AppToast v-if="chatError" tone="error">{{ chatError }}</AppToast>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-base);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 10px var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-raised);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.history {
  width: 140px;
  padding: var(--space-3) var(--space-2);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  text-align: left;
}

.history-item.active {
  background: rgba(86, 132, 255, 0.16);
}

.thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  padding: var(--space-3);
}

.tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-card {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.03);
}

.composer {
  border-top: 1px solid var(--border-subtle);
  padding: var(--space-2) var(--space-3) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--bg-raised);
}

.composer textarea {
  width: 100%;
  min-height: 56px;
  max-height: 160px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.28);
  resize: vertical;
  outline: none;
}

.composer textarea:focus {
  border-color: var(--aurora-blue);
}
</style>
