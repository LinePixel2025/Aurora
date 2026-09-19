<script setup lang="ts">
/**
 * AI 交互窗口（docs/07 §2.3）：完整对话窗，约 420×640，贴右缘滑出。
 *
 * P3 范围：真实模型流式对话、工具执行卡片、会话历史水合（`chat:history`）、模式引导面板。
 * P5 追加：敏感工具确认卡片（docs/06 §5）与分类流水面板（docs/05 §3.3）——
 * 交互窗是主动引导的**主载体**，两者都挂在这里。
 * P6 追加：多会话列表 / 切换（docs/06 §4）与附件拖拽发送（docs/07 §2.3）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { SensitiveToolRequest } from '@aurora/shared'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import ClassificationLedger from '../shared/components/ClassificationLedger.vue'
import MessageList from '../shared/components/MessageList.vue'
import SensitiveToolCard from '../shared/components/SensitiveToolCard.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import { useModeStore, useSettingsStore, useWindowStore } from '../shared/stores.js'

const chat = useChat('chat')
const {
  sessionId,
  messages,
  sessions,
  streaming,
  error: chatError,
  statusTone,
  send: sendMessage,
  abort,
  clear,
  hydrate,
  loadSessions,
  switchSession,
  newSession,
} = chat
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()

const input = ref('')
const showHistory = ref(false)

/** 待确认的敏感工具调用（主进程同一时刻最多推一条） */
const sensitiveRequest = ref<SensitiveToolRequest | null>(null)
let offSensitiveTool: (() => void) | null = null

/** 拖拽中的附件绝对路径（发送后清空） */
const attachments = ref<string[]>([])
/** 是否正有文件悬停在窗口上（用于描边提示） */
const dragging = ref(false)

onMounted(() => {
  offSensitiveTool = window.aurora.proactive.onSensitiveTool((request) => {
    sensitiveRequest.value = request
  })
  void hydrate().then(() => loadSessions())
})

onUnmounted(() => {
  offSensitiveTool?.()
  offSensitiveTool = null
})

function resolveSensitive(): void {
  sensitiveRequest.value = null
}

const guide = computed(() => {
  const mode = modeStore.current
  if (!mode || mode.guideCompleted) return null
  return mode
})

// ───────────────────────── 附件拖拽（docs/07 §2.3） ─────────────────────────

/**
 * 取拖入文件路径。
 *
 * 路径解析必须走 preload（`webUtils.getPathForFile`）：Electron 32 起
 * `File.path` 已移除，渲染层自己拿不到本地路径。拿不到路径的条目（如从
 * 浏览器拖来的虚拟文件）直接跳过，不假装已附加。
 */
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
  const next = new Set([...attachments.value, ...paths])
  attachments.value = [...next]
}

function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((item) => item !== path)
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '' && attachments.value.length === 0) return
  const files = attachments.value
  input.value = ''
  attachments.value = []
  await sendMessage(text, files)
  // 新会话此时才有标题，刷新列表让侧栏显示出来
  void loadSessions()
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

/** 会话标题：空会话显示为「新会话」，与主进程的摘要保持一致 */
function sessionTitle(title: string): string {
  return title.trim() === '' ? '新会话' : title
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
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

    <SensitiveToolCard
      v-if="sensitiveRequest"
      :key="sensitiveRequest.confirmId"
      :request="sensitiveRequest"
      class="sensitive-host"
      @resolved="resolveSensitive"
    />

    <div class="body">
      <aside v-if="showHistory" class="history">
        <div class="row">
          <strong class="tiny grow">会话</strong>
          <AppButton size="sm" variant="ghost" @click="newSession">新建</AppButton>
        </div>
        <p v-if="sessions.length === 0" class="tiny muted">还没有会话</p>
        <button
          v-for="item in sessions"
          :key="item.id"
          type="button"
          class="history-item"
          :class="{ active: item.id === sessionId }"
          @click="switchSession(item.id)"
        >
          <strong class="tiny">{{ sessionTitle(item.title) }}</strong>
          <span class="tiny muted">
            {{ formatTime(item.updatedAt) }} · {{ item.messageCount }} 条
          </span>
        </button>
      </aside>

      <main
        class="thread"
        :class="{ dragging }"
        @dragenter.prevent="dragging = true"
        @dragover.prevent
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
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

        <p v-if="dragging" class="drop-hint tiny">松开即可把文件内容附带发送</p>

        <MessageList
          :messages="messages"
          empty-hint="这是完整对话窗口：可以问系统状态、让 Aurora 帮忙整理资料，也可以直接把文件拖进来。"
        />
      </main>
    </div>

    <ClassificationLedger class="ledger-host" :limit="20" />

    <footer class="composer">
      <div v-if="attachments.length > 0" class="row wrap attachments">
        <span v-for="path in attachments" :key="path" class="chip tiny">
          {{ fileNameOf(path) }}
          <button type="button" class="chip-remove" @click="removeAttachment(path)">×</button>
        </span>
      </div>
      <textarea
        v-model="input"
        spellcheck="false"
        placeholder="输入消息，Ctrl + Enter 发送；可直接把文件拖进来"
        @keydown.enter.exact.prevent="send"
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="row">
        <span class="tiny muted grow"> 会话：{{ sessionId }} · 可调用 Skill 与 MCP 工具 </span>
        <AppButton v-if="streaming" size="sm" @click="abort">停止</AppButton>
        <AppButton
          size="sm"
          variant="primary"
          :disabled="streaming || (input.trim() === '' && attachments.length === 0)"
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

.sensitive-host {
  flex: 0 0 auto;
}

.ledger-host {
  flex: 0 0 auto;
}

.history {
  width: 150px;
  padding: var(--space-3) var(--space-2);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
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

.history-item:hover {
  background: rgba(255, 255, 255, 0.05);
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

/* 拖拽悬停反馈：对话区整体描边，避免用户不确定有没有拖对地方 */
.thread.dragging {
  outline: 1px dashed var(--aurora-blue);
  outline-offset: -6px;
  background: rgba(86, 132, 255, 0.06);
}

.drop-hint {
  margin: 0;
  text-align: center;
  color: var(--aurora-blue);
}

.composer {
  border-top: 1px solid var(--border-subtle);
  padding: var(--space-2) var(--space-3) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--bg-raised);
}

.attachments {
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(86, 132, 255, 0.16);
}

.chip-remove {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
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
