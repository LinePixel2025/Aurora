<script setup lang="ts">
/**
 * 小 AI 交互窗口（docs/07 §2.4）：320×480，锚定服务窗，与服务窗共享"快速会话"。
 * 精简形态：气泡 + 流式文本 + 状态点；提供「展开到完整窗口」（会话归属切换由主进程状态机保证互斥）。
 */
import { onMounted, ref } from 'vue'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import MessageList from '../shared/components/MessageList.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import { useSettingsStore, useWindowStore } from '../shared/stores.js'

const chat = useChat('mini-chat')
const {
  messages,
  streaming,
  error: chatError,
  statusTone,
  send: sendMessage,
  abort,
  hydrate,
} = chat
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()

const input = ref('')

onMounted(() => {
  void hydrate()
})

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '') return
  input.value = ''
  await sendMessage(text)
}

async function expand(): Promise<void> {
  await windowStore.showChat()
}
</script>

<template>
  <div class="mini">
    <header class="head drag-region">
      <div class="row">
        <StatusDot :tone="statusTone" title="AI 状态" />
        <strong class="tiny">快速对话</strong>
        <span v-if="settingsStore.needsOnboarding" class="badge warn">未配置模型</span>
      </div>
      <div class="row no-drag">
        <AppButton size="sm" variant="ghost" @click="expand">展开</AppButton>
        <AppButton size="sm" variant="ghost" @click="windowStore.hide('mini-chat')">隐藏</AppButton>
      </div>
    </header>

    <main class="thread">
      <MessageList :messages="messages" compact empty-hint="在服务窗输入问题，回复会显示在这里。" />
    </main>

    <footer class="composer">
      <input
        v-model="input"
        type="text"
        spellcheck="false"
        placeholder="继续提问…"
        @keydown.enter.prevent="send"
      />
      <AppButton v-if="streaming" size="sm" @click="abort">停止</AppButton>
      <AppButton
        size="sm"
        variant="primary"
        :disabled="streaming || input.trim() === ''"
        @click="send"
      >
        发送
      </AppButton>
    </footer>

    <AppToast v-if="chatError" tone="error">{{ chatError }}</AppToast>
  </div>
</template>

<style scoped>
.mini {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 8px var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-raised);
}

.thread {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.composer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-raised);
}

.composer input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.28);
  outline: none;
}

.composer input:focus {
  border-color: var(--aurora-blue);
}
</style>
