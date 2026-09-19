<script setup lang="ts">
/**
 * 小 AI 交互窗口（docs/07 §2.4）：320×480，锚定服务窗，与服务窗共享"快速会话"。
 * 精简形态：气泡 + 流式文本 + 状态点；提供「展开到完整窗口」（会话归属切换由主进程状态机保证互斥）。
 * 同样支持把文件拖进来发送（docs/07 §2.3）——小窗常驻，拖拽是最顺手的入口。
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
/** 拖拽中的附件绝对路径（路径解析必须走 preload，见 shared/useChat 说明） */
const attachments = ref<string[]>([])
const dragging = ref(false)

onMounted(() => {
  void hydrate()
})

function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = event.dataTransfer?.files
  if (files === undefined || files.length === 0) return
  const paths: string[] = []
  for (const file of Array.from(files)) {
    const path = window.aurora.chat.filePath(file)
    if (path !== '') paths.push(path)
  }
  if (paths.length === 0) {
    chatError.value = '无法读取拖入文件的本地路径（仅支持从资源管理器拖入的文件）'
    return
  }
  attachments.value = [...new Set([...attachments.value, ...paths])]
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((item) => item !== path)
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '' && attachments.value.length === 0) return
  const files = attachments.value
  input.value = ''
  attachments.value = []
  await sendMessage(text, files)
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

    <main
      class="thread"
      :class="{ dragging }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <p v-if="dragging" class="drop-hint tiny">松开即可把文件内容附带发送</p>
      <MessageList
        :messages="messages"
        compact
        empty-hint="在服务窗输入问题，回复会显示在这里；也可以把文件拖进来。"
      />
    </main>

    <footer class="composer">
      <div v-if="attachments.length > 0" class="row wrap attached">
        <span v-for="path in attachments" :key="path" class="chip tiny">
          {{ fileNameOf(path) }}
          <button type="button" class="chip-remove" @click="removeAttachment(path)">×</button>
        </span>
      </div>
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
        :disabled="streaming || (input.trim() === '' && attachments.length === 0)"
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

.thread.dragging {
  outline: 1px dashed var(--aurora-blue);
  outline-offset: -4px;
  background: rgba(86, 132, 255, 0.06);
}

.drop-hint {
  margin: var(--space-2);
  text-align: center;
  color: var(--aurora-blue);
}

.attached {
  flex: 1 0 100%;
  gap: 4px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(86, 132, 255, 0.16);
}

.chip-remove {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.composer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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
