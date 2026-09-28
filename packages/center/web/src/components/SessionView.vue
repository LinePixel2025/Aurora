<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
  type ClientEntry,
  type ConfirmEntry,
  type SessionState,
  type SessionUsage,
} from '../store'

/**
 * 会话主区：消息流（按 messageId 聚合的结果）+ 底部输入框 + 发送 / 停止。
 * 停止依赖最近一次 session.input 回执携带的 agentRequestId。
 * 确认卡：本会话待批复的敏感工具请求（倒计时归零即摘除并提示）。
 */
const props = defineProps<{ session: SessionState; entry: ClientEntry }>()

const emit = defineEmits<{ newSession: [] }>()

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)
const abortError = ref('')

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
  if (bottomRaf !== 0) window.cancelAnimationFrame(bottomRaf)
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
  abortError.value = ''
  await sendInput(props.session, text)
}

function onKeydown(event: KeyboardEvent): void {
  // 中文输入法组词中的回车不发送
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

async function abort(): Promise<void> {
  abortError.value = ''
  try {
    await abortSession(props.session)
  } catch (err) {
    abortError.value = err instanceof Error ? err.message : '中止失败'
  }
}

/**
 * 自动吸底（v0.2.4 重做）：
 * - 「用户是否在底部」判断——距底 < ~48px 才自动吸底；用户上翻看历史时不再强拽回底部；
 * - 深度 watch 会话 items（正文 / 思考增量、工具卡 outputSummary、job / subagent 卡、
 *   loading 行、确认卡与文件条出现消失——一切会改高度的变化都触发吸底判断）；
 * - nextTick 之后再用 rAF 二次校正一次（图片 / 展开内容等晚稳定的高度变化）；
 * - 切换会话时强制滚底一次（并把「在底部」状态复位）。
 */
const NEAR_BOTTOM_PX = 48
const nearBottom = ref(true)

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
}

function onListScroll(): void {
  const el = listEl.value
  if (el) nearBottom.value = isNearBottom(el)
}

let bottomRaf = 0

async function scrollToBottom(force = false): Promise<void> {
  await nextTick()
  const el = listEl.value
  if (!el) return
  if (!force && !nearBottom.value) return
  el.scrollTop = el.scrollHeight
  if (bottomRaf !== 0) window.cancelAnimationFrame(bottomRaf)
  bottomRaf = window.requestAnimationFrame(() => {
    bottomRaf = 0
    const target = listEl.value
    if (!target) return
    if (force || isNearBottom(target)) target.scrollTop = target.scrollHeight
  })
}

// 消息条数 / 内容 / 状态行 / 确认卡与文件条的任何高度变化都走吸底判断。
// 深度 watch 在长会话流式时每个 delta 都会触发，吸底判断做 100ms 尾沿节流：
// 高频增量合并成一次滚动，静默 100ms 后补一次，收尾高度不会被漏掉。
const SCROLL_THROTTLE_MS = 100
let scrollTimer = 0
let scrollTimerPending = false
watch(
  () =>
    [
      props.session.items,
      props.session.pending,
      props.entry.files.length,
      sessionConfirms.value.length,
    ] as const,
  () => {
    if (scrollTimerPending) return
    scrollTimerPending = true
    const fire = (): void => {
      scrollTimerPending = false
      void scrollToBottom()
    }
    scrollTimer = window.setTimeout(fire, SCROLL_THROTTLE_MS)
  },
  { deep: true },
)
onBeforeUnmount(() => {
  if (scrollTimer !== 0) window.clearTimeout(scrollTimer)
})
// 切换会话：强制滚底一次
watch(
  () => props.session,
  () => {
    nearBottom.value = true
    void scrollToBottom(true)
  },
)
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

    <!-- Token 用量条：最新轮 prompt/completion、会话累计、占 contextWindow 比例（未知分母不显示占比） -->
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

    <div ref="listEl" class="msg-list" @scroll.passive="onListScroll">
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
        <div v-else class="msg-assistant">
          <div v-if="item.reasoning" class="think">
            <details>
              <summary>{{ item.streaming && !item.content ? '思考中…' : '思考过程' }}</summary>
              <div class="think-body">{{ item.reasoning }}</div>
            </details>
          </div>
          <div v-if="item.content" class="msg-text">{{ item.content }}</div>
          <ToolCard v-for="tool in item.tools" :key="tool.id" :tool="tool" />
          <span v-if="item.streaming" class="caret"></span>
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

    <footer class="composer">
      <p v-if="abortError" class="form-error">{{ abortError }}</p>
      <div class="composer-row">
        <textarea
          v-model="draft"
          class="input composer-input"
          rows="1"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          @keydown="onKeydown"
        ></textarea>
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
  padding: 14px 20px;
}

.session-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.session-title h2 {
  margin: 0;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 24px 16px;
  min-height: 0;
}

/* Token 用量条：贴在头部下方的一行小字 */
.usage-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 18px;
  padding: 0 20px 10px;
  font-size: 12.5px;
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
  margin: 10px 0;
}

.bubble-user {
  background: var(--accent);
  color: #fff;
  border-radius: 18px 18px 4px 18px;
  padding: 9px 14px;
  max-width: 72%;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 助手消息：无气泡直排 */
.msg-assistant {
  margin: 14px 0;
  max-width: 760px;
}

.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.caret {
  display: inline-block;
  width: 2px;
  height: 16px;
  background: var(--accent);
  vertical-align: -3px;
  animation: caret-blink 1s steps(2) infinite;
}

@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}

/* 思考过程折叠块 */
.think {
  margin-bottom: 6px;
}

.think summary {
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
  user-select: none;
}

.think-body {
  color: var(--text-2);
  font-size: 13px;
  white-space: pre-wrap;
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
  padding: 10px 14px;
  margin: 10px 0;
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
  margin: 12px 0;
}

/* 收到的文件 */
.file-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 16px 0 8px;
  padding-top: 12px;
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
  padding: 12px 16px 16px;
  border-top: 1px solid var(--line);
}

.composer .form-error {
  margin: 0 0 8px;
}

.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.composer-input {
  flex: 1;
  max-height: 140px;
}

/* ───────────────────────── 确认卡 ───────────────────────── */

.confirm-strip {
  padding: 0 20px 12px;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 10px;
}

.confirm-notice {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.confirm-card {
  background: #fffbe8;
  border: 1px solid rgba(255, 204, 0, 0.45);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
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
  margin: 12px 0;
  max-width: 760px;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  display: grid;
  gap: 6px;
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
  font-size: 12.5px;
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

/* 窄屏：气泡放宽、留白收紧，确认卡贴边 */
@media (max-width: 720px) {
  .session-head {
    padding: 12px 14px;
  }

  .usage-strip {
    padding: 0 14px 8px;
    gap: 4px 12px;
  }

  .msg-list {
    padding: 4px 14px 12px;
  }

  .bubble-user {
    max-width: 88%;
  }

  .confirm-strip {
    padding: 0 14px 10px;
  }

  .composer {
    padding: 10px 12px 14px;
  }

  .composer-row {
    flex-wrap: wrap;
  }

  .composer-row .btn {
    flex: 1 1 100%;
  }
}
</style>
