<script setup lang="ts">
/**
 * 输入卡（docs/07 §2.3 的「输入框规格」，减负轮后的口径）。
 *
 * 硬口径（两端逐字对齐，别再改回去）：
 * - 三枚控件（权限 / 模型 / 思考）一律 28px（`--control-h-xs`）+ pill 圆角 +
 *   **静止态零边框**（悬停才浮 `--fill-2`）—— 40px + 逐枚边框会把输入卡顶成设置工具栏；
 * - 占位文案只留一句「输入消息…」，键位提示挂工具行右侧；
 * - textarea 高度由**内容**决定（空内容 = 一行），autoGrow 上限 200px；
 * - 发送按钮绝不能被挤出行外；流式期间「停止」与发送同位。
 *
 * 语音（docs/12 §6.4）：麦克风按钮按客户端能力位 `voice.stt` 门控 ——
 * 未配置**连按钮都不渲染**（不是 disabled）。录音需安全上下文（HTTPS / localhost）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ClientEntry, SessionState } from '../../state'
import { abortSession, sendInput, showNotice, transcribeAudio } from '../../state'
import { ArrowUp, Mic, Square } from '@aurora/shared/browser'

const props = defineProps<{
  session: SessionState
  entry: ClientEntry
}>()

const draft = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const micState = ref<'idle' | 'recording' | 'transcribing'>('idle')

/** 录音上限 10MB：中转是整段 base64 上行，再大就该走别的通道了 */
const MAX_RECORD_BYTES = 10 * 1024 * 1024

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let recordedBytes = 0

const sttReady = computed(() => props.entry.status?.voice?.stt === true)

const canSend = computed(() => draft.value.trim() !== '' && !props.session.pending)

/** textarea 高度跟随内容（空内容 = 一行；上限 200px 后自身滚动） */
function autoGrow(): void {
  const el = inputEl.value
  if (el === null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

watch(draft, () => void nextTick(autoGrow))

async function submit(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  draft.value = ''
  void nextTick(autoGrow)
  await sendInput(props.session, text)
}

async function stop(): Promise<void> {
  try {
    await abortSession(props.session)
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error))
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
}

/* ── 语音输入：录音 → stt.transcribe → 回填输入框 ── */

function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

async function finishTranscribe(blob: Blob): Promise<void> {
  micState.value = 'transcribing'
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const text = await transcribeAudio(props.entry.client.clientId, base64Of(bytes), blob.type)
    if (text.trim() === '') {
      showNotice('没有识别到语音内容')
      return
    }
    draft.value = draft.value.trim() === '' ? text : `${draft.value.trim()} ${text}`
    void nextTick(autoGrow)
  } catch (error) {
    showNotice(`语音识别失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    micState.value = 'idle'
  }
}

function discardRecording(): void {
  recorder?.stream.getTracks().forEach((track) => track.stop())
  recorder = null
  chunks = []
  recordedBytes = 0
  micState.value = 'idle'
}

async function toggleMic(): Promise<void> {
  if (micState.value === 'transcribing') return
  if (micState.value === 'recording') {
    recorder?.stop() // onstop 里走转写
    return
  }
  if (window.isSecureContext === false) {
    showNotice('当前环境不支持录音：语音输入需要 HTTPS 或 localhost 访问')
    return
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    showNotice('无法开始录音：请检查麦克风连接并允许浏览器使用麦克风')
    return
  }
  const mime = pickRecorderMime()
  recorder = new MediaRecorder(stream, mime === '' ? undefined : { mimeType: mime })
  chunks = []
  recordedBytes = 0
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return
    recordedBytes += event.data.size
    if (recordedBytes > MAX_RECORD_BYTES) {
      showNotice('录音过长（超过 10MB），已停止并丢弃')
      discardRecording()
      return
    }
    chunks.push(event.data)
  }
  recorder.onstop = () => {
    const type = recorder?.mimeType ?? 'audio/webm'
    stream.getTracks().forEach((track) => track.stop())
    const blob = new Blob(chunks, { type })
    recorder = null
    chunks = []
    if (blob.size === 0) {
      micState.value = 'idle'
      return
    }
    void finishTranscribe(blob)
  }
  recorder.start()
  micState.value = 'recording'
}

onBeforeUnmount(() => {
  if (recorder !== null) {
    recorder.onstop = null
    discardRecording()
  }
})

/** 会话切换时清空草稿与录音（避免把上一会话的内容发到新会话） */
watch(
  () => props.session.sessionId,
  () => {
    draft.value = ''
    if (recorder !== null) discardRecording()
    void nextTick(autoGrow)
  },
)

const micTitle = computed(() => {
  if (micState.value === 'transcribing') return '正在识别…'
  return micState.value === 'recording' ? '停止录音并转写' : '语音输入（经客户端中转）'
})
</script>

<template>
  <div class="composer">
    <div class="composer-box" :class="{ streaming: session.pending }">
      <textarea
        ref="inputEl"
        v-model="draft"
        class="composer-input"
        rows="1"
        :placeholder="session.pending ? '正在回复中，可继续输入…' : '输入消息…'"
        data-field="chat.composer-input"
        @keydown="onKeydown"
      />

      <div class="composer-bar">
        <span class="chip" :data-field="'chat.permission'">
          {{ entry.status?.agent.permissionMode || '未上报' }}
        </span>
        <span class="chip" data-field="chat.model">
          {{ entry.status?.llm.model || '未配置模型' }}
        </span>
        <span class="chip" data-field="chat.reasoningEffort">
          {{ entry.status?.llm.reasoningEffort ?? 'auto' }}
        </span>

        <span class="grow" />
        <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>

        <button
          v-if="sttReady"
          type="button"
          class="mic"
          :class="{ recording: micState === 'recording', busy: micState === 'transcribing' }"
          :title="micTitle"
          data-field="chat.mic"
          @click="toggleMic()"
        >
          <span v-if="micState === 'recording'" class="mic-ring" aria-hidden="true" />
          <Mic :size="15" :stroke-width="1.6" aria-hidden="true" />
        </button>

        <button
          v-if="session.pending"
          type="button"
          class="stop"
          data-action="chat.abort"
          @click="stop()"
        >
          <Square :size="12" :stroke-width="1.8" aria-hidden="true" />
          停止
        </button>

        <span class="send-slot">
          <button
            type="button"
            class="send"
            :disabled="!canSend"
            aria-label="发送"
            data-action="chat.send"
            @click="submit()"
          >
            <ArrowUp :size="15" :stroke-width="2" aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: 0 0 auto;
  padding: 0 var(--space-4) var(--space-4);
}

.composer-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 860px;
  margin: 0 auto;
  padding: var(--space-2) var(--space-3) var(--space-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--fill-1);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.composer-box:focus-within {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

.composer-input {
  width: 100%;
  min-height: calc(var(--text-base) * var(--leading-normal) + 2 * var(--space-2));
  max-height: 200px;
  padding: var(--space-2) 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  resize: none;
}

.composer-input:focus {
  outline: none;
}

.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

/* 三枚控件：28px + pill + 静止态零边框（悬停才浮底色），两端逐字对齐 */
.chip {
  display: inline-flex;
  align-items: center;
  height: var(--control-h-xs);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-size: var(--text-xs);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background var(--transition-fast);
}

.chip:hover {
  background: var(--fill-2);
}

.grow {
  flex: 1 1 auto;
}

.composer-hint {
  color: var(--text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
}

.mic,
.stop {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  flex: 0 0 auto;
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.mic:hover,
.stop:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.mic.busy {
  color: var(--text-muted);
}

.mic.recording {
  color: var(--status-error);
  border-color: var(--status-error);
  background: var(--error-fill);
}

.mic-ring {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  border: 2px solid var(--status-error);
  pointer-events: none;
  animation: pulse-ring var(--dur-pulse) var(--ease-standard) infinite;
}

/* 发送绝不能被挤出行外 */
.send-slot {
  flex: 0 0 auto;
}

.send {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: var(--aurora-blue);
  color: var(--on-accent);
  cursor: pointer;
  transition:
    filter var(--transition-fast),
    opacity var(--transition-fast);
}

.send:hover:not(:disabled) {
  filter: brightness(1.08);
}

.send:disabled {
  opacity: 0.4;
  cursor: default;
}

@media (max-width: 720px) {
  .composer {
    padding: 0 var(--space-3) var(--space-3);
  }

  /* iOS 聚焦缩放：输入字号 ≥ 16px */
  .composer-input {
    font-size: 16px;
  }

  .composer-hint {
    display: none;
  }

  .chip {
    max-width: 30vw;
  }
}
</style>
