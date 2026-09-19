<script setup lang="ts">
/**
 * 小 AI 交互窗口（docs/07 §2.4）：320×480，锚定提示条左侧（提示条未创建时回落工作区右下角），
 * 与交互窗共享同一套会话能力，但固定使用"快速会话"（`quick`）。
 * 精简形态：气泡 + 流式文本 + 工具状态点；提供「展开到完整窗口」（会话归属切换由主进程状态机保证互斥）。
 * 同样支持把文件拖进来发送（docs/07 §2.3）——小窗常驻，拖拽是最顺手的入口。
 *
 * 视觉（docs/07 §5）：整窗圆角 + 玻璃材质、头部可拖动、消息区细滚动条；
 * 与交互窗同一套令牌，尺寸更紧凑。交互语义（发送 / 中断 / 展开 / 拖拽）保持不变。
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
  <div class="mini glass">
    <header class="head drag-region">
      <div class="row">
        <StatusDot :tone="statusTone" title="AI 状态" />
        <strong class="tiny">快速对话</strong>
        <span v-if="settingsStore.needsOnboarding" class="badge warn">未配置模型</span>
      </div>
      <div class="head-actions no-drag">
        <AppButton
          size="sm"
          variant="ghost"
          aria-label="展开到完整窗口"
          title="展开到完整窗口"
          @click="expand"
        >
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.4 3.2H3.2v3.2M9.6 12.8h3.2V9.6M3.2 3.2l3.6 3.6M12.8 12.8 9.2 9.2" />
          </svg>
        </AppButton>
        <AppButton
          size="sm"
          variant="ghost"
          aria-label="隐藏小窗"
          title="隐藏小窗"
          @click="windowStore.hide('mini-chat')"
        >
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
          </svg>
        </AppButton>
      </div>
    </header>

    <main
      class="thread"
      :class="{ dragging, streaming }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <p v-if="dragging" class="drop-hint tiny">松开即可把文件内容附带发送</p>
      <MessageList :messages="messages" compact empty-hint="直接提问，或把文件拖进来发送。" />
    </main>

    <footer class="composer">
      <div v-if="attachments.length > 0" class="attachments">
        <span v-for="path in attachments" :key="path" class="chip tiny">
          {{ fileNameOf(path) }}
          <button
            type="button"
            class="chip-remove"
            aria-label="移除附件"
            @click="removeAttachment(path)"
          >
            ×
          </button>
        </span>
      </div>

      <div class="composer-box">
        <input
          v-model="input"
          type="text"
          spellcheck="false"
          placeholder="继续提问…"
          @keydown.enter.prevent="send"
        />
        <AppButton v-if="streaming" size="sm" variant="ghost" @click="abort">停止</AppButton>
        <span class="send-slot">
          <AppButton
            class="send"
            size="sm"
            variant="primary"
            aria-label="发送"
            title="发送（Enter）"
            :disabled="streaming || (input.trim() === '' && attachments.length === 0)"
            @click="send"
          >
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3.6M8 3.6 4.2 7.4M8 3.6l3.8 3.8" />
            </svg>
          </AppButton>
        </span>
      </div>
    </footer>

    <AppToast v-if="chatError" tone="error">{{ chatError }}</AppToast>
  </div>
</template>

<style scoped>
.mini {
  display: flex;
  flex-direction: column;
  height: 100vh;
  border-radius: var(--radius-lg);
  overflow: hidden;
}

/* ── 头部：可拖动，靠分层填充与内容区区分 ── */
.head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--fill-1);
  border-bottom: 1px solid var(--border-subtle);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* 两个头部按钮是图标按钮：沿用 AppButton 的交互反馈，只收紧内边距 */
.head-actions :deep(.aurora-button) {
  padding: 4px 6px;
}

.icon {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 小窗滚动条更细（全局是 8px） */
.thread::-webkit-scrollbar {
  width: 6px;
}

.thread::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: var(--fill-3);
}

.thread.dragging {
  outline: 1px dashed var(--aurora-blue);
  outline-offset: -4px;
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.drop-hint {
  margin: var(--space-2);
  text-align: center;
  color: var(--aurora-blue);
}

/**
 * 流式光标：只挂在最后一条助手消息正文末尾（同交互窗）。
 * 不碰 MessageList 的 props，也不会在每条 delta 上重放整段进场动画。
 */
.thread.streaming :deep(.message.r-assistant:last-of-type .md > :last-child)::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 1px;
  background: var(--aurora-blue);
  animation: caret 1.1s steps(1, end) infinite;
}

@keyframes caret {
  0%,
  45% {
    opacity: 1;
  }
  46%,
  100% {
    opacity: 0.15;
  }
}

/* ── 输入区 ── */
.composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  background: var(--bg-raised);
  border-top: 1px solid var(--border-subtle);
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 18%, transparent);
}

.chip-remove {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.composer-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  transition:
    border-color var(--transition-base),
    box-shadow var(--transition-base);
}

.composer-box:focus-within {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px rgba(86, 132, 255, 0.18);
}

.composer input {
  flex: 1;
  min-width: 0;
  padding: var(--space-2) 0;
  border: 0;
  background: transparent;
  outline: none;
}

.composer input::placeholder {
  color: var(--text-muted);
}

/* 发送按钮：渐变圆形 */
.send-slot :deep(.aurora-button) {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--radius-pill);
}
</style>
