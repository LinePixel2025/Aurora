<script setup lang="ts">
/**
 * 消息列表（交互窗的消息流）。
 *
 * 视觉（docs/07 §5）：用户消息右对齐胶囊气泡，助手消息左对齐纯文本块（Apple 风格：不套气泡），
 * 代码块单独成卡并带 hover 显隐的「复制」；工具执行卡片默认折叠，展开走 `.collapse-*`。
 * props / 插槽契约：`messages`（消息数组）+ `emptyHint`（空状态提示语）。
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type { AgentToolCall } from '@aurora/shared'
import type { ChatMessage } from '../composables/useChat.js'
import { useStickToBottom } from '../composables/useStickToBottom.js'
import { renderMarkdown } from '../markdown.js'
import StatusDot from './StatusDot.vue'

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[]
    emptyHint?: string
    /**
     * 该窗口当前是否「可朗读」（docs/06 §13）：没有 TTS 配置时为 false，
     * 此时**根本不渲染**朗读按钮（不是 disabled）——与文档门控口径一致。
     */
    ttsAvailable?: boolean
    /** 正在播放的消息 id；与按钮的 key 比对决定显示「朗读」还是「停止」 */
    speakingId?: string | null
    /** 正在合成（等待主进程回包）的消息 id */
    ttsLoadingId?: string | null
  }>(),
  { emptyHint: '开始一段对话吧', ttsAvailable: false, speakingId: null, ttsLoadingId: null },
)

const emit = defineEmits<{
  (event: 'speak', text: string, id: string): void
  (event: 'stopSpeak'): void
}>()

/**
 * 朗读按钮是否该出现在这条消息上。
 *
 * 四个条件缺一不可：已配置 TTS、是助手消息、不是仍在占位的流式消息、正文非空。
 * 空白正文没有可合成的文本，渲染一个点了没反应的按钮不如不渲染。
 */
function canSpeak(message: ChatMessage): boolean {
  return (
    props.ttsAvailable &&
    message.role === 'assistant' &&
    message.pending !== true &&
    message.content.trim() !== ''
  )
}

/** 这条消息正在合成 / 正在播放；两者互斥，由 `useTts` 的状态决定。 */
function isSpeaking(id: string): boolean {
  return props.speakingId === id
}

function isTtsLoading(id: string): boolean {
  return props.ttsLoadingId === id
}

/** 按钮文案：合成中 → 停止 → 朗读（同一时刻只有一个音频，所以「停止」是全局动作）。 */
function speakLabel(message: ChatMessage): string {
  if (isTtsLoading(message.id)) return '合成中…'
  if (isSpeaking(message.id)) return '停止'
  return '朗读'
}

/** 点一次按钮：正在播这条就停，否则让父级去合成并播放。 */
function onSpeakClick(message: ChatMessage): void {
  if (isSpeaking(message.id)) {
    emit('stopSpeak')
    return
  }
  emit('speak', message.content, message.id)
}

// ───────────────────────── 跟随最新（自动滚底） ─────────────────────────

/**
 * 滚动容器是窗口自己的 `.thread`（由 `useStickToBottom` 从本组件根节点向上查找），
 * 因此这里只负责"什么算新内容、什么时候强制回底"，容器结构不动。
 */
const rootEl = ref<HTMLElement | null>(null)
const { following, stick } = useStickToBottom(() => rootEl.value)

/**
 * 自己发的消息必须能看到回复：即使此前正在翻历史，也强制恢复跟随。
 * 助手消息追加**不**强制 —— 多轮工具调用会把正在回看历史的用户一次次拽回底部。
 */
watch(
  () => props.messages.length,
  (next, previous) => {
    const last = props.messages[next - 1]
    if (next > previous && last?.role === 'user') stick()
  },
)

/**
 * 消息数组**被整体替换**（历史水合 / 切换会话 / 清空）时强制恢复跟随：
 * 上一个会话里"翻历史"的状态不能带到新会话，否则打开会话会停在顶部。
 * 流式增量与追加都不换引用，所以不会走到这里。
 */
watch(
  () => props.messages,
  () => stick(),
)

/** 「回到最新」用平滑滚动，但尊重系统「减少动态效果」 */
function jumpToLatest(): void {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  stick(reduceMotion ? 'auto' : 'smooth')
}

/**
 * 代码块「复制」按钮。
 *
 * `markdown.ts` 的输出形状固定（先转义再套白名单标记），这里只在渲染结果上补一层结构：
 * `<pre class="md-code">` 外包一层定位容器并塞入按钮。转义保证了代码正文里不可能出现
 * 字面量 `</pre>`，因此按标记切分是安全的；不引入依赖、也不改 `markdown.ts` 的输出契约。
 */
const COPY_BUTTON = '<button type="button" class="code-copy" aria-label="复制代码">复制</button>'

function withCodeCopy(html: string): string {
  return html
    .replace(
      /<pre class="md-code">/g,
      `<div class="code-block">${COPY_BUTTON}<pre class="md-code">`,
    )
    .replace(/<\/pre>/g, '</pre></div>')
}

const rendered = computed(() =>
  props.messages.map((message) => ({
    ...message,
    html: withCodeCopy(renderMarkdown(message.content)),
  })),
)

/** 工具卡片的展示文案（docs/06 §5：运行中 / 成功 / 失败 + 输出摘要） */
function toolStateLabel(state: AgentToolCall['state']): string {
  if (state === 'running') return '执行中'
  if (state === 'success') return '完成'
  return '失败'
}

/** `StatusDot` 只有 idle / running / unread / error 四个语义色，成功的绿色在样式里补 */
function toolTone(state: AgentToolCall['state']): 'idle' | 'running' | 'error' {
  if (state === 'running') return 'running'
  if (state === 'error') return 'error'
  return 'idle'
}

// ───────────────────────── 工具卡片：折叠态 + 耗时 ─────────────────────────

/** 已展开的卡片 id（默认全部折叠，保持消息区干净） */
const openedIds = ref<string[]>([])

function isOpen(id: string): boolean {
  return openedIds.value.includes(id)
}

function toggle(id: string): void {
  openedIds.value = isOpen(id)
    ? openedIds.value.filter((item) => item !== id)
    : [...openedIds.value, id]
}

/**
 * 耗时是**渲染层计时**：`AgentToolCall` 没有时间字段（packages/shared/src/ipc/types.ts），
 * 因此只对本次渲染期间观察到的调用计时（历史水合出来的卡片不显示耗时），不伪造数据。
 */
const timings = reactive(new Map<string, { start: number; end: number | null }>())
const nowTick = ref(Date.now())
let ticker: number | null = null

const toolSignature = computed(() =>
  props.messages
    .flatMap((message) => (message.toolCalls ?? []).map((call) => `${call.id}:${call.state}`))
    .join(','),
)

function syncTimings(): void {
  let running = false
  for (const message of props.messages) {
    for (const call of message.toolCalls ?? []) {
      const record = timings.get(call.id)
      if (call.state === 'running') {
        running = true
        if (record === undefined) timings.set(call.id, { start: Date.now(), end: null })
        else if (record.end !== null) record.end = null
      } else if (record !== undefined && record.end === null) {
        record.end = Date.now()
      }
    }
  }
  // 只在有工具在跑时走 ticker，避免空闲时白刷
  if (running && ticker === null) {
    ticker = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 200)
  } else if (!running && ticker !== null) {
    window.clearInterval(ticker)
    ticker = null
  }
}

watch(toolSignature, syncTimings, { immediate: true })

onUnmounted(() => {
  if (ticker !== null) window.clearInterval(ticker)
})

function toolDuration(call: AgentToolCall): string {
  const record = timings.get(call.id)
  if (record === undefined) return ''
  const end = record.end ?? nowTick.value
  const seconds = Math.max(0, end - record.start) / 1000
  return seconds < 0.1 ? '<0.1s' : `${seconds.toFixed(1)}s`
}

function prettyInput(input: unknown): string {
  if (input === undefined || input === null) return '（无参数）'
  if (typeof input === 'string') return input
  try {
    const text = JSON.stringify(input, null, 2)
    if (text === undefined) return String(input)
    return text.length > 800 ? `${text.slice(0, 800)}\n…（已截断）` : text
  } catch {
    return String(input)
  }
}

// ───────────────────────── 代码块复制 ─────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 剪贴板权限被拒 / 文档未聚焦：走下面的兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
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

/**
 * 复制按钮走事件委托：`v-html` 出来的 DOM 由 Vue 之外的字符串生成，
 * 逐节点挂监听既麻烦又会随每次流式重渲染失效，而在容器上挂一次即可。
 */
async function onContentClick(event: MouseEvent): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const button = target.closest('.code-copy')
  if (!(button instanceof HTMLButtonElement)) return
  const code = button.parentElement?.querySelector('code')
  const text = code?.textContent ?? ''
  if (text === '' || !(await copyText(text))) return
  button.textContent = '已复制'
  button.classList.add('copied')
  window.setTimeout(() => {
    button.textContent = '复制'
    button.classList.remove('copied')
  }, 1200)
}
</script>

<template>
  <div ref="rootEl" class="messages" @click="onContentClick">
    <div v-if="messages.length === 0" class="empty anim-rise">
      <span class="empty-orb" aria-hidden="true" />
      <p class="empty-title">开始对话</p>
      <p class="empty-hint tiny muted">{{ emptyHint }}</p>
    </div>

    <TransitionGroup name="rise">
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

          <!--
            朗读按钮（docs/06 §13）：正文之后、工具卡片之前。
            只在 `canSpeak` 成立时渲染 —— 未配置 TTS 时按钮**不存在**（不是 disabled）。
            播放实现只有 `useTts` 一份，这里只发事件，不碰 Audio。
          -->
          <button
            v-if="canSpeak(message)"
            type="button"
            class="speak-btn tiny"
            :class="{ active: isSpeaking(message.id) }"
            :disabled="isTtsLoading(message.id)"
            :data-action="isSpeaking(message.id) ? 'stop-speak' : 'speak-message'"
            @click="onSpeakClick(message)"
          >
            {{ speakLabel(message) }}
          </button>

          <!-- 工具执行卡片：折叠头行 + 展开细节（docs/06 §5） -->
          <div v-if="(message.toolCalls?.length ?? 0) > 0" class="tools">
            <article
              v-for="call in message.toolCalls"
              :key="call.id"
              class="tool-card"
              :class="[`t-${call.state}`, { open: isOpen(call.id) }]"
            >
              <button
                type="button"
                class="tool-head"
                :aria-expanded="isOpen(call.id)"
                @click="toggle(call.id)"
              >
                <StatusDot
                  :tone="toolTone(call.state)"
                  :size="6"
                  :title="toolStateLabel(call.state)"
                />
                <span class="mono tiny tool-name">{{ call.name }}</span>
                <span class="tiny tool-state-label">{{ toolStateLabel(call.state) }}</span>
                <span v-if="toolDuration(call) !== ''" class="tiny muted tool-time">
                  {{ toolDuration(call) }}
                </span>
                <span class="grow" />
                <span class="chevron" aria-hidden="true">›</span>
              </button>
              <Transition name="collapse">
                <div v-if="isOpen(call.id)" class="tool-body">
                  <span class="tiny muted tool-label">参数</span>
                  <pre class="mono tool-args">{{ prettyInput(call.input) }}</pre>
                  <span class="tiny muted tool-label">结果</span>
                  <p class="tool-output">{{ call.outputSummary ?? toolStateLabel(call.state) }}</p>
                </div>
              </Transition>
            </article>
          </div>
        </div>
      </article>
    </TransitionGroup>
    <slot />

    <!--
      用户上滚后（`following === false`）才出现的回底入口：跟随中不显示，
      既不遮挡最后一条消息，也不改变"自动到底"的默认体验。
    -->
    <button v-if="!following" type="button" class="jump-latest anim-pop" @click="jumpToLatest">
      ↓ 回到最新
    </button>
  </div>
</template>

<style scoped>
.messages {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  /* 让 `.empty` 的 `margin: auto` 能真正在窗口里垂直居中（`* { box-sizing: border-box }`，
     100% 已含本容器的内边距，不会凭空多出滚动条）；有消息时 min-height 不约束内容。 */
  min-height: 100%;
}

/* ── 空状态：品牌渐变圆点 + 一句引导，进场一次 ── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin: auto;
  padding: var(--space-4) var(--space-3);
  text-align: center;
}

.empty-orb {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  box-shadow: var(--shadow-2);
}

.empty-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: -0.01em;
  line-height: var(--leading-tight);
}

.empty-hint {
  margin: 0;
  max-width: 30ch;
  line-height: var(--leading-normal);
}

/* ── 「回到最新」：用户上滚后暂停跟随时出现，吸附在滚动容器底部 ── */
/* `position: sticky` 让它在滚动容器（`.thread`）里始终可见，且不脱离文档流；
   不透明底色 + 描边保证压在消息正文上仍然可读。 */
.jump-latest {
  position: sticky;
  bottom: var(--space-1);
  align-self: center;
  margin-top: var(--space-2);
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  box-shadow: var(--shadow-2);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.jump-latest:hover {
  color: var(--text-primary);
  background: var(--fill-2);
}

/* ── 消息：用户右对齐胶囊气泡，助手左对齐纯文本块 ── */
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
  color: var(--bg-base);
  font-weight: var(--weight-semibold);
}

.bubble {
  min-width: 0;
  max-width: 78%;
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  word-break: break-word;
}

.r-user .bubble {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--fill-2);
}

/* Apple 风格：助手内容铺开、不套气泡，代码块自带卡片 */
.r-assistant .bubble {
  flex: 1 1 auto;
  max-width: calc(100% - 32px);
  padding: 2px 0;
  color: var(--text-primary);
}

.message.error .bubble {
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--status-error) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-error) 32%, transparent);
  color: var(--status-error);
}

/* ── 朗读按钮（docs/06 §13） ── */
/* 助手消息正文之后的次要动作：低调的胶囊，hover 才浮出来，不跟正文抢注意力 */
.speak-btn {
  align-self: flex-start;
  margin-top: var(--space-1);
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.speak-btn:hover:not(:disabled) {
  background: var(--fill-3);
  color: var(--text-primary);
}

/* 播放中：用品牌色描边表达「这是当前唯一在响的那条」 */
.speak-btn.active {
  border-color: var(--aurora-blue);
  color: var(--aurora-blue);
}

.speak-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

/* ── 工具执行卡片（docs/06 §5） ── */
.tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.attached {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}

.attached-chip {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 18%, transparent);
  color: var(--text-muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-card {
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  overflow: hidden;
}

.tool-card.open {
  background: var(--fill-2);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 5px 8px;
  text-align: left;
  transition: background var(--transition-fast);
}

.tool-head:hover {
  background: var(--fill-2);
}

.tool-name {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.tool-state-label {
  color: var(--text-muted);
}

/* 成功态用 `--status-ok`：StatusDot 没有 ok 语义，这里按状态语义补色 */
.t-success .tool-head :deep(.status-dot) {
  background: var(--status-ok);
}

.tool-time {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

.chevron {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-base);
  line-height: 1;
  transition: transform var(--transition-base);
}

.tool-card.open .chevron {
  transform: rotate(90deg);
}

.tool-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: 0 8px 8px;
}

.tool-label {
  color: var(--text-muted);
}

.tool-args {
  margin: 0;
  max-height: 140px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-output {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
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

/* ── Markdown ── */
.md :deep(.md-p) {
  margin: 0 0 var(--space-3);
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

/* 代码块：单独成卡 + hover 显隐「复制」 */
.md :deep(.code-block) {
  position: relative;
  margin: 6px 0;
}

.md :deep(.md-code) {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.md :deep(.code-copy) {
  position: absolute;
  top: 6px;
  right: 8px;
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  background: var(--fill-3);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  opacity: 0;
  transition:
    opacity var(--transition-fast),
    color var(--transition-fast),
    background var(--transition-fast);
}

.md :deep(.code-block:hover .code-copy),
.md :deep(.code-copy:focus-visible) {
  opacity: 1;
}

.md :deep(.code-copy:hover) {
  color: var(--text-primary);
  background: var(--fill-3);
}

.md :deep(.code-copy.copied) {
  opacity: 1;
  color: var(--status-ok);
}

.md :deep(.md-inline) {
  padding: 1px 4px;
  border-radius: var(--radius-xs);
  background: var(--fill-2);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.md :deep(.md-link) {
  color: var(--aurora-blue);
  word-break: break-all;
}
</style>
