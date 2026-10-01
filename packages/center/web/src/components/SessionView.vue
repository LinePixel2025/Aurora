<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useStickToBottom } from '../composables/useStickToBottom.js'
import '@aurora/shared/browser/markdown/md.css'
import { CODE_COPY_BUTTON, ICON_CHECK, ICON_COPY, renderMarkdown } from '@aurora/shared/browser'
import ToolCard from './ToolCard.vue'
import { fileUrl } from '../api'
import {
  formatBytes,
  formatRemaining,
  jobStatusLabel,
  modeLabel,
  pendingReasonLabel,
  remainingMs,
  subagentStatusLabel,
} from '../format'
import {
  abortSession,
  confirmNotice,
  expireConfirm,
  resolveConfirm,
  sendInput,
  state,
  summarizeInput,
  synthesizeSpeech,
  transcribeAudio,
  type ChatItem,
  type ClientEntry,
  type ConfirmEntry,
  type SessionState,
  type SessionUsage,
} from '../store'

/**
 * 会话主区（v0.3.2 重构：对话主导 + 信息密度收紧）：
 * - 消息流（按 messageId 聚合）+ 底部输入框 + 发送 / 停止；
 * - 自动跟随滚动用与桌面端同一套「吸底」语义（stickToBottomCore 搬运版）：
 *   跟随只由真实用户输入关闭，流式增量绝不拽走或误关；非跟随态显示「回到底部」胶囊；
 * - 助手正文与思考块走 Markdown 渲染（自写渲染器，输出已 HTML 转义防 XSS）；
 * - 语音（docs/12 §6.4）：麦克风录音经客户端中转识别进输入框；助手消息可经
 *   客户端中转合成朗读——按 ClientStatus.voice 能力位门控，未配置连按钮都不渲染。
 */
const props = defineProps<{ session: SessionState; entry: ClientEntry }>()

const emit = defineEmits<{ newSession: [] }>()

const draft = ref('')
const threadEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const abortError = ref('')

// ───────────────────────── 自动跟随滚动（stickToBottomCore，docs/12 §10） ─────────────────────────

const { following, stick } = useStickToBottom(() => threadEl.value)

// 切换会话：强制恢复跟随并滚底一次（composable 挂载时也会 stick 一次）
watch(
  () => props.session,
  () => {
    stick()
  },
)

// ───────────────────────── 确认卡 ─────────────────────────

/** 秒级心跳：驱动倒计时文案与过期自动摘除 */
const now = ref(Date.now())
const heartbeat = window.setInterval(() => {
  now.value = Date.now()
  for (const entry of [...sessionConfirms.value]) {
    if (remainingMs(entry.request.expiresAt, now.value) <= 0) expireConfirm(entry)
  }
}, 1000)
onBeforeUnmount(() => {
  window.clearInterval(heartbeat)
  cleanupMic()
  stopSpeak()
})

const sessionConfirms = computed<ConfirmEntry[]>(() =>
  state.confirms.filter(
    (c) => c.clientId === props.session.clientId && c.sessionId === props.session.sessionId,
  ),
)

function countdown(expiresAt: string): string {
  return formatRemaining(remainingMs(expiresAt, now.value))
}

// ───────────────────────── Token 用量（docs/12 §10） ─────────────────────────

/** 该会话的 usage 聚合（usage 事件驱动，store 层防重累加） */
const usage = computed<SessionUsage | null>(
  () => props.entry.usageBySession.get(props.session.sessionId) ?? null,
)

/** 激活 provider 的上下文窗口（config.get 脱敏配置；0 = 未知，不显示占比） */
const ctxWindow = computed<number>(() => {
  const activeId = props.entry.status?.llm?.activeProviderId
  if (!activeId) return 0
  return props.entry.remoteLlm?.providers[activeId]?.contextWindow ?? 0
})

/** 最新轮上下文占用比例（promptTokens / contextWindow） */
const usagePercent = computed<number>(() => {
  const prompt = usage.value?.latest?.promptTokens ?? 0
  if (!ctxWindow.value || !prompt) return 0
  return Math.min(100, Math.round((prompt / ctxWindow.value) * 100))
})

/** 没有任何助手输出时才显示整行「生成中」；有了增量就交给消息内光标 */
const showLoading = computed(
  () => props.session.pending && !props.session.items.some((item) => item.kind === 'assistant'),
)

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || props.session.pending) return
  draft.value = ''
  resetInputHeight()
  abortError.value = ''
  // 自己发消息 = 必须跟随（真实用户输入之外唯一恢复跟随的入口，与桌面端同口径）
  stick()
  await sendInput(props.session, text)
}

/** 中止本轮：需要 session.input 回执带出的 agentRequestId */
async function abort(): Promise<void> {
  abortError.value = ''
  try {
    await abortSession(props.session)
  } catch (err) {
    abortError.value = err instanceof Error ? err.message : '中止失败'
  }
}

function onKeydown(event: KeyboardEvent): void {
  // 中文输入法组词中的回车不发送
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

/** composer 自增高：空内容 = 一行，随内容长高、封顶后内部滚动（与桌面端同口径） */
function autogrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}

function resetInputHeight(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = ''
}

// ───────────────────────── 语音输入（stt.transcribe 中转，docs/12 §6.4） ─────────────────────────

/** 能力位门控：客户端未配置 STT 时连按钮都不渲染（字段缺失同款，向后兼容旧客户端） */
const micReady = computed(() => props.entry.status?.voice?.stt === true)

const micState = ref<'idle' | 'recording' | 'transcribing'>('idle')
const micError = ref('')
/** 录音体积上限（10MB）：base64 后 ≈13.7MB，贴近 ws 16MiB 帧上限；超限不发命令（超了会 1009 断整条连接） */
const MAX_RECORD_BYTES = 10 * 1024 * 1024
let mediaStream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let recordedChunks: Blob[] = []
let recordMime = ''

/** 容器优先 webm/opus（Chrome / Edge / Firefox），回落 mp4（Safari），再退浏览器默认 */
function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

async function toggleMic(): Promise<void> {
  if (micState.value === 'recording') {
    stopRecording()
    return
  }
  if (micState.value !== 'idle') return
  micError.value = ''
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    micError.value = '当前环境不支持录音——语音输入需要 HTTPS 或 localhost 访问'
    return
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recordMime = pickRecorderMime()
    recorder = recordMime
      ? new MediaRecorder(mediaStream, { mimeType: recordMime })
      : new MediaRecorder(mediaStream)
    recordedChunks = []
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) recordedChunks.push(event.data)
    }
    recorder.onstop = () => {
      void finishTranscribe()
    }
    recorder.start()
    micState.value = 'recording'
  } catch (error) {
    cleanupMic()
    micError.value =
      error instanceof Error && error.name === 'NotAllowedError'
        ? '麦克风权限被拒绝——请在浏览器地址栏允许麦克风后重试'
        : '打开麦克风失败，请重试'
  }
}

function stopRecording(): void {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
    return
  }
  cleanupMic()
}

async function finishTranscribe(): Promise<void> {
  micState.value = 'transcribing'
  const mime = recordMime || recorder?.mimeType || 'audio/webm'
  const blob = new Blob(recordedChunks, { type: mime })
  // 只清资源（停轨 / 置空引用），**不复位状态**：「识别中」要亮到转写收尾，
  // 期间 toggleMic 的重入保护（micState !== 'idle'）才有效——否则两路转写竞写 draft
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  recorder = null
  recordedChunks = []
  recordMime = ''
  try {
    if (blob.size > MAX_RECORD_BYTES) {
      throw new Error('录音过长（超过 10MB），请缩短录音后重试')
    }
    const audioBase64 = await blobToBase64(blob)
    const text = await transcribeAudio(props.session.clientId, audioBase64, blob.type || mime)
    if (text) {
      draft.value = draft.value ? `${draft.value} ${text.trim()}` : text.trim()
      autogrow()
      inputEl.value?.focus()
    }
  } catch (error) {
    micError.value = error instanceof Error ? error.message : '识别失败，请重试'
  } finally {
    micState.value = 'idle'
  }
}

function cleanupMic(): void {
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  recorder = null
  recordedChunks = []
  recordMime = ''
  micState.value = 'idle'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取录音数据失败'))
    reader.readAsDataURL(blob)
  })
}

// ───────────────────────── 朗读（tts.synthesize 中转，docs/12 §6.4） ─────────────────────────

const ttsReady = computed(() => props.entry.status?.voice?.tts === true)
const ttsBusy = ref(false)
// ── Markdown 渲染缓存 + 代码块复制按钮 ─────────────────────────────
// 键是消息对象（WeakMap：对象被丢弃后缓存自动回收），content 不变就复用上次解析 ——
// 流式期间只有正在生长的那条消息逐帧重解析，历史消息不重跑 markdown。
const contentCache = new WeakMap<object, { source: string; html: string }>()
const reasoningCache = new WeakMap<object, { source: string; html: string }>()

function cachedHtmlOf(
  cache: WeakMap<object, { source: string; html: string }>,
  item: { content?: string; reasoning?: string },
  field: 'content' | 'reasoning',
): string {
  const source = item[field] ?? ''
  const cached = cache.get(item)
  if (cached !== undefined && cached.source === source) return cached.html
  const html = renderMarkdown(source)
  cache.set(item, { source, html })
  return html
}

function contentHtmlOf(item: { content?: string }): string {
  return cachedHtmlOf(contentCache, item, 'content')
}

function reasoningHtmlOf(item: { reasoning?: string }): string {
  return cachedHtmlOf(reasoningCache, item, 'reasoning')
}

/** 写剪贴板：优先 async Clipboard API，非安全上下文（http 部署）回落 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 代码块「复制」按钮走事件委托：v-html 出来的 DOM 由字符串生成，
 * 在消息线程容器上挂一次监听即可（随流式重渲染失效的是节点，不是容器）。
 */
async function onThreadClick(event: MouseEvent): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const button = target.closest('.code-copy')
  if (!(button instanceof HTMLButtonElement)) return
  const code = button.parentElement?.querySelector('code')
  const text = code?.textContent ?? ''
  if (text === '' || !(await copyText(text))) return
  const label = button.querySelector('.code-copy-label')
  if (label !== null) label.textContent = '已复制'
  button.querySelector('svg')?.remove()
  button.insertAdjacentHTML('afterbegin', ICON_CHECK)
  button.classList.add('copied')
  window.setTimeout(() => {
    if (label !== null) label.textContent = '复制'
    button.querySelector('svg')?.remove()
    button.insertAdjacentHTML('afterbegin', ICON_COPY)
    button.classList.remove('copied')
  }, 1400)
}

const speakingId = ref('')
const speakError = ref('')
let currentAudio: HTMLAudioElement | null = null
let currentUrl = ''

async function toggleSpeak(item: ChatItem): Promise<void> {
  if (speakingId.value === item.id) {
    stopSpeak()
    return
  }
  if (ttsBusy.value) return
  speakError.value = ''
  ttsBusy.value = true
  try {
    const { audioBase64, mimeType } = await synthesizeSpeech(
      props.session.clientId,
      item.content,
    )
    if (!audioBase64) throw new Error('客户端未返回音频')
    const bytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    const audio = new Audio(url)
    stopSpeak()
    currentAudio = audio
    currentUrl = url
    speakingId.value = item.id
    audio.onended = () => {
      if (speakingId.value === item.id) speakingId.value = ''
      releaseAudio()
    }
    await audio.play()
  } catch (error) {
    speakingId.value = ''
    releaseAudio()
    speakError.value = error instanceof Error ? error.message : '朗读失败，请重试'
  } finally {
    ttsBusy.value = false
  }
}

function stopSpeak(): void {
  currentAudio?.pause()
  releaseAudio()
}

function releaseAudio(): void {
  currentAudio = null
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = ''
  }
}
</script>

<template>
  <div class="card session">
    <header class="session-head">
      <div class="session-title">
        <span class="dot" :class="entry.client.online ? 'on' : 'off'"></span>
        <h2>{{ entry.client.name }}</h2>
        <span class="chip">{{ modeLabel(entry.client.mode) }}模式</span>
        <span v-if="entry.status" class="chip">{{ entry.status.agent.permissionMode }}</span>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="emit('newSession')">新会话</button>
    </header>

    <!-- Token 用量条：贴在头部下方的一行小字 -->
    <div
      v-if="usage && usage.totals.totalTokens > 0"
      class="usage-strip"
      data-field="session-usage"
    >
      <span class="usage-item">
        本轮 <strong>{{ usage.latest?.promptTokens ?? 0 }}</strong> +
        <strong>{{ usage.latest?.completionTokens ?? 0 }}</strong> tok
      </span>
      <span class="usage-item"
        >会话累计 <strong>{{ usage.totals.totalTokens }}</strong> tok</span
      >
      <span v-if="usagePercent > 0" class="usage-item">
        上下文 <strong>{{ usagePercent }}%</strong>
        <span class="text-2">（{{ usage.latest?.promptTokens }} / {{ ctxWindow }}）</span>
      </span>
    </div>

    <!-- 敏感工具确认卡（本会话）：批准 / 拒绝经 confirm.resolve 送回客户端 -->
    <div v-if="sessionConfirms.length > 0 || confirmNotice" class="confirm-strip">
      <p v-if="confirmNotice" class="confirm-notice">{{ confirmNotice }}</p>
      <div v-for="c in sessionConfirms" :key="c.request.confirmId" class="confirm-card">
        <div class="confirm-head">
          <span class="confirm-badge">等待确认</span>
          <span class="confirm-tool">{{ c.request.toolName }}</span>
          <span class="confirm-countdown">{{ countdown(c.request.expiresAt) }}后超时</span>
        </div>
        <pre v-if="summarizeInput(c.request.input)" class="mono confirm-input">{{
          summarizeInput(c.request.input)
        }}</pre>
        <div class="confirm-actions">
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="remainingMs(c.request.expiresAt, now) <= 0"
            @click="resolveConfirm(c, false)"
          >
            拒绝
          </button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="remainingMs(c.request.expiresAt, now) <= 0"
            @click="resolveConfirm(c, true)"
          >
            批准
          </button>
        </div>
      </div>
    </div>

    <div class="msg-list">
      <div ref="threadEl" class="msg-thread" @click="onThreadClick">
        <template v-for="item in session.items" :key="item.id">
          <div v-if="item.kind === 'user'" class="msg-user">
            <div class="bubble-user">{{ item.content }}</div>
          </div>
          <div v-else-if="item.kind === 'error'" class="msg-error">
            {{ item.content }}
            <span v-if="item.code" class="msg-error-code">（{{ item.code }}）</span>
          </div>
          <!-- 任务清单卡：最新一条 job 摘要（后续事件原地覆盖） -->
          <div v-else-if="item.kind === 'job' && item.job" class="job-card">
            <div class="job-head">
              <span class="job-title">任务清单</span>
              <span class="chip" :class="item.job.status === 'done' ? 'chip-ok' : 'chip-accent'">
                {{ jobStatusLabel(item.job.status) }}
              </span>
              <span v-if="item.job.pendingReason" class="chip chip-muted">
                {{ pendingReasonLabel(item.job.pendingReason) }}
              </span>
            </div>
            <div class="job-meta text-2">
              第 {{ item.job.round }}/{{ item.job.maxRounds }} 轮 · 已执行 {{ item.job.stepCount }} 步
              · Token {{ item.job.usedTokens }}/{{ item.job.maxTotalTokens }}
              <template v-if="item.job.autoContinued > 0">
                · 自动续轮 {{ item.job.autoContinued }} 次
              </template>
            </div>
            <div v-if="item.job.lastStep" class="job-line text-2">
              最近步骤：{{ item.job.lastStep }}
            </div>
            <p v-if="item.job.error" class="job-error">{{ item.job.error }}</p>
          </div>
          <!-- 子代理卡：同一 task 调用的最新快照 -->
          <div v-else-if="item.kind === 'subagent' && item.subagent" class="job-card">
            <div class="job-head">
              <span class="job-title">子代理</span>
              <span
                class="chip"
                :class="item.subagent.status === 'success' ? 'chip-ok' : 'chip-accent'"
              >
                {{ subagentStatusLabel(item.subagent.status) }}
              </span>
              <span class="text-2 job-inline">工具调用 {{ item.subagent.toolCalls }} 次</span>
            </div>
            <div class="job-line">{{ item.subagent.description }}</div>
            <div v-if="item.subagent.report" class="job-line text-2 subagent-report">
              {{ item.subagent.report }}
            </div>
          </div>
          <div v-else-if="item.kind === 'assistant'" class="msg-assistant">
            <div v-if="item.reasoning" class="think">
              <details>
                <summary>{{ item.streaming && !item.content ? '思考中…' : '思考过程' }}</summary>
                <!-- 渲染器先转义再套白名单标记，v-html 安全 -->
                <div class="think-body md" v-html="reasoningHtmlOf(item)"></div>
              </details>
            </div>
            <!-- 渲染器先转义再套白名单标记，v-html 安全 -->
            <div v-if="item.content" class="msg-text md" v-html="contentHtmlOf(item)"></div>
            <div v-if="item.tools.length > 0" class="msg-tools">
              <ToolCard v-for="tool in item.tools" :key="tool.id" :tool="tool" />
            </div>
            <div class="msg-foot">
              <span v-if="item.streaming" class="caret"></span>
              <button
                v-else-if="ttsReady && item.content"
                class="speak-btn"
                type="button"
                :class="{ speaking: speakingId === item.id }"
                :disabled="ttsBusy && speakingId !== item.id"
                :title="speakingId === item.id ? '停止朗读' : '朗读这段回复'"
                @click="toggleSpeak(item)"
              >
                {{ speakingId === item.id ? '停止' : '朗读' }}
              </button>
            </div>
          </div>
        </template>

        <div v-if="showLoading" class="msg-loading">
          <span class="spinner spinner-sm"></span>
          <span>生成中…</span>
        </div>

        <!-- 该客户端发来的文件（Agent 调 center_send_file 上传后出现） -->
        <div v-if="entry.files.length > 0" class="file-strip">
          <span class="file-strip-title">收到文件</span>
          <a
            v-for="file in entry.files"
            :key="file.fileId"
            class="file-chip"
            :href="fileUrl(file.fileId)"
            :download="file.name"
            :title="file.note || file.name"
          >
            {{ file.name }} · {{ formatBytes(file.size) }}
          </a>
        </div>

        <div v-if="session.items.length === 0 && !session.pending" class="msg-placeholder text-2">
          会话已建立。发一条消息试试——它会由客户端本机的 Aurora 处理。
        </div>
      </div>

      <!-- 非跟随态（用户在翻历史）的「回到底部」胶囊 -->
      <button
        v-if="!following"
        class="jump-bottom"
        type="button"
        title="回到底部并恢复跟随"
        @click="stick('smooth')"
      >
        ↓ 回到底部
      </button>
    </div>

    <footer class="composer">
      <p v-if="abortError" class="form-error">{{ abortError }}</p>
      <p v-if="micError" class="form-error">{{ micError }}</p>
      <p v-if="speakError" class="form-error">{{ speakError }}</p>
      <div class="composer-row">
        <textarea
          ref="inputEl"
          v-model="draft"
          class="input composer-input"
          rows="1"
          placeholder="输入消息…"
          title="Enter 发送，Shift + Enter 换行"
          @keydown="onKeydown"
          @input="autogrow"
        ></textarea>
        <button
          v-if="micReady"
          class="mic-btn"
          type="button"
          :class="{ recording: micState === 'recording' }"
          :disabled="micState === 'transcribing' || session.pending"
          :title="
            micState === 'recording'
              ? '停止录音并识别'
              : micState === 'transcribing'
                ? '识别中…'
                : '按住语义说话：点击开始 / 再点结束'
          "
          @click="toggleMic"
        >
          <span v-if="micState === 'transcribing'" class="spinner spinner-sm"></span>
          <span v-else-if="micState === 'recording'" class="mic-stop"></span>
          <span v-else class="mic-icon"></span>
        </button>
        <button v-if="session.pending" class="btn btn-danger" type="button" @click="abort">
          停止
        </button>
        <button
          v-else
          class="btn btn-primary"
          type="button"
          :disabled="!draft.trim()"
          @click="send"
        >
          发送
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.session {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.session-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
}

.session-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.session-title h2 {
  margin: 0;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-list {
  position: relative;
  flex: 1;
  overflow-y: auto;
  padding: 2px 20px 12px;
  min-height: 0;
}

/* 消息流内容根：吸底引擎的观察对象（MutationObserver 盯它，滚动容器向上解析） */
.msg-thread {
  display: flex;
  flex-direction: column;
}

/* 「回到底部」胶囊：悬浮在消息区底部 */
.jump-bottom {
  position: sticky;
  bottom: 10px;
  width: fit-content;
  margin: 10px auto 0;
  display: block;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--card);
  box-shadow: var(--shadow);
  border-radius: 980px;
  padding: 6px 14px;
  pointer-events: auto;
}

.jump-bottom:hover {
  color: var(--accent);
}

/* Token 用量条：贴在头部下方的一行小字 */
.usage-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 0 16px 8px;
  font-size: 12px;
  color: var(--text-2);
}

.usage-strip strong {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.usage-item {
  white-space: nowrap;
}

/* 用户气泡：右侧、主色 */
.msg-user {
  display: flex;
  justify-content: flex-end;
  margin: 8px 0;
}

.bubble-user {
  background: var(--accent);
  color: #fff;
  border-radius: 16px 16px 4px 16px;
  padding: 8px 13px;
  max-width: 76%;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 助手消息：无气泡直排 */
.msg-assistant {
  margin: 12px 0;
  max-width: 860px;
}

.caret {
  display: inline-block;
  width: 2px;
  height: 15px;
  background: var(--accent);
  vertical-align: -3px;
  animation: caret-blink 1s steps(2) infinite;
}

@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}

/* 消息底部一行：流式光标 / 朗读按钮 */
.msg-foot {
  min-height: 18px;
  margin-top: 4px;
}

.speak-btn {
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  color: var(--text-2);
  background: transparent;
  border-radius: 980px;
  padding: 2px 8px;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.speak-btn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-soft);
}

.speak-btn.speaking {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 思考过程折叠块 */
.think {
  margin-bottom: 6px;
}

.think summary {
  cursor: pointer;
  color: var(--text-2);
  font-size: 12.5px;
  user-select: none;
}

.think-body {
  color: var(--text-2);
  font-size: 12.5px;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-top: 6px;
  max-height: 260px;
  overflow-y: auto;
}

/* 错误红条 */
.msg-error {
  background: var(--danger-soft);
  color: var(--danger);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  margin: 8px 0;
  font-size: 13px;
}

.msg-error-code {
  opacity: 0.75;
  font-size: 12px;
}

/* 整行生成中 */
.msg-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 13px;
  margin: 10px 0;
}

/* 收到的文件 */
.file-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 14px 0 6px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.file-strip-title {
  font-size: 12px;
  color: var(--text-2);
}

.file-chip {
  display: inline-block;
  font-size: 12.5px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 980px;
  padding: 4px 12px;
  text-decoration: none;
  transition: background-color 0.15s ease;
}

.file-chip:hover {
  background: rgba(0, 113, 227, 0.18);
}

.msg-placeholder {
  margin: 32px 0;
  text-align: center;
  font-size: 13px;
}

/* 输入区 */
.composer {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--line);
}

.composer .form-error {
  margin: 0 0 6px;
}

.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.composer-input {
  flex: 1;
  max-height: 160px;
  line-height: 1.5;
}

/* 麦克风按钮：圆形 ghost，与 composer 同高 */
.mic-btn {
  flex: none;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.mic-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.09);
}

.mic-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.mic-btn.recording {
  background: var(--danger-soft);
  color: var(--danger);
}

/* 纯 CSS 麦克风图标：胶囊头 + 底座（不引图标库） */
.mic-icon {
  position: relative;
  width: 10px;
  height: 15px;
  background: currentColor;
  border-radius: 5px;
}

.mic-icon::after {
  content: '';
  position: absolute;
  left: -4px;
  bottom: -6px;
  width: 18px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top: 0;
  border-radius: 0 0 10px 10px;
}

/* 录音中：方形停止符 */
.mic-stop {
  width: 9px;
  height: 9px;
  background: currentColor;
  border-radius: 2px;
  animation: mic-pulse 1.2s ease-in-out infinite;
}

@keyframes mic-pulse {
  50% {
    opacity: 0.35;
  }
}

/* ───────────────────────── 确认卡 ───────────────────────── */

.confirm-strip {
  padding: 0 16px 10px;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 8px;
}

.confirm-notice {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.confirm-card {
  background: #fffbe8;
  border: 1px solid rgba(255, 204, 0, 0.45);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
}

.confirm-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.confirm-badge {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: #8a6d00;
}

.confirm-tool {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm-countdown {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}

.confirm-input {
  margin: 8px 0;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.75);
  border-radius: 8px;
  max-height: 120px;
  overflow-y: auto;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ───────────────────────── 任务清单 / 子代理卡 ───────────────────────── */

.job-card {
  margin: 10px 0;
  max-width: 860px;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  display: grid;
  gap: 5px;
}

.job-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.job-title {
  font-weight: 600;
  font-size: 13px;
}

.job-inline {
  font-size: 12px;
}

.job-meta {
  font-size: 12px;
}

.job-line {
  font-size: 13px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

.subagent-report {
  white-space: pre-wrap;
  max-height: 140px;
  overflow-y: auto;
}

.job-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--danger);
}

/* 窄屏：气泡放宽、留白收紧，确认卡贴边。
   composer 输入框 16px：iOS Safari 对 font-size < 16px 的输入框聚焦时会缩放页面，
   看起来像「键盘把布局顶飞」——提到 16px 从根上规避。 */
@media (max-width: 720px) {
  .session-head {
    padding: 10px 12px;
  }

  .usage-strip {
    padding: 0 12px 6px;
    gap: 4px 10px;
  }

  .msg-list {
    padding: 2px 12px 10px;
  }

  .bubble-user {
    max-width: 88%;
  }

  .confirm-strip {
    padding: 0 12px 8px;
  }

  .composer {
    padding: 8px 10px 10px;
  }

  .composer-input {
    font-size: 16px;
  }
}
</style>
