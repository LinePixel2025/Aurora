<script setup lang="ts">
/**
 * 会话消息流（docs/07 §2.3 的消息区 + docs/12 §10）。
 *
 * 与桌面端的对齐点（逐条落地）：
 * - 用户消息右对齐胶囊气泡、助手消息左对齐纯文本块（代码块自带卡片）；
 * - 助手消息的「思考 + 工具行」收进**轨迹容器**，阅读顺序固定 思考 → 工具行 → 正文；
 * - 流式只在末尾加光标（父级 `::after`，不对每条 delta 重放进场动画）；
 * - 自动折叠状态机与桌面同款：收尾（streaming 边沿）折叠过程、用户点开就保持点开；
 * - Markdown 走共享渲染器（`@aurora/shared/browser`），按消息缓存、代码块复制走容器
 *   事件委托（`v-html` 的节点绑不了事件）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatDisplayImage } from '@aurora/shared'
import type { ChatItem, ClientEntry, SessionState } from '../../state'
import { showNotice, synthesizeSpeech } from '../../state'
import {
  ICON_CHECK,
  ICON_COPY,
  createChartHydrator,
  renderMarkdown,
  type ChartHydrator,
} from '@aurora/shared/browser'
import { Volume2 } from '@aurora/shared/browser'
import AgentTrace from './AgentTrace.vue'
import AgentToolRow from './AgentToolRow.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import JobCard from './JobCard.vue'
import SubagentCard from './SubagentCard.vue'
import AskCard from './AskCard.vue'
import DisplayImageGallery from './DisplayImageGallery.vue'

const props = defineProps<{
  session: SessionState
  entry: ClientEntry
  /** 是否处于吸底跟随态（父级由 useStickToBottom 提供，用于「回到底部」胶囊） */
  following: boolean
}>()

const emit = defineEmits<{ jumpLatest: [] }>()

/**
 * 流内提问卡的秒级心跳（本轮）：倒计时只在**未结算**的卡上显示，但没有心跳就永远是
 * 打开那一刻的读数。一张心跳服务本会话里所有提问卡（与待办栏同款做法）。
 */
const now = ref(Date.now())
let askTimer: number | undefined
onMounted(() => {
  askTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (askTimer !== undefined) window.clearInterval(askTimer)
})

/** 卡片自己结算后无需额外处理：state 已更新（流内条目原地切成只读），这里只做一次滚动跟随 */
function onAskResolved(): void {
  emit('jumpLatest')
}

/**
 * 轨迹展开状态：用户主动点开的**保持点开**；收尾时折叠（历史条目默认折叠）。
 *
 * ⚠️ 两个集合必须放进 `ref` 里 —— 普通 `new Set()` **不是响应式**的，`add` / `delete`
 * 不会触发重渲染：点轨迹头时状态变了、界面不动（用户报的「无法展开 Agent 折叠起来的对话」
 * 就是这个）。`ref` 会把对象值包成 reactive，集合的 `has/add/delete` 都会被追踪；
 * 渲染函数里读的是 `.value.has(...)`，所以依赖建立得起来。
 */
const userOpened = ref(new Set<string>())
const folded = ref(new Set<string>())
const seen = new Set<string>()

function traceOpen(item: ChatItem): boolean {
  return userOpened.value.has(item.id) || !folded.value.has(item.id)
}

function toggleTrace(item: ChatItem): void {
  if (traceOpen(item)) {
    userOpened.value.delete(item.id)
    folded.value.add(item.id)
  } else {
    userOpened.value.add(item.id)
    folded.value.delete(item.id)
  }
}

/** 一条助手消息的图片区：聚合成功工具行里的无路径元数据，按 id 去重。 */
function displayImagesOf(item: ChatItem): ChatDisplayImage[] {
  const images: ChatDisplayImage[] = []
  const seen = new Set<string>()
  for (const tool of item.tools) {
    if (tool.state !== 'success' || tool.displayImages === undefined) continue
    for (const image of tool.displayImages) {
      if (seen.has(image.id)) continue
      seen.add(image.id)
      images.push(image)
    }
  }
  return images
}

/* 收尾折叠：助手消息从流式转为已收尾时收起过程；用户点开过的保持点开。
   历史回放条目（streaming 恒为 false）第一次被看到时就归入折叠。

   ⚠️ 判据必须是 `streaming` 的**边沿**，所以这里 watch 一个由它派生的签名字符串：
   事件聚合是**原地**改 `item.streaming`（不换数组、不换条目对象），watch 数组引用
   在 done 事件上根本不会触发 —— 实测症状是「答完了轨迹还大开着」（harness 的
   trace-collapsed 场景）。用 computed 读 `streaming` 才会建立真正的依赖。 */
const foldSignature = computed(() =>
  props.session.items
    .filter((item) => item.kind === 'assistant')
    .map((item) => `${item.id}:${item.streaming === true ? '1' : '0'}`)
    .join('|'),
)

function applyFoldState(): void {
  for (const item of props.session.items) {
    if (item.kind !== 'assistant') continue
    if (!seen.has(item.id)) {
      seen.add(item.id)
      if (item.streaming !== true) folded.value.add(item.id)
      continue
    }
    if (item.streaming === true) folded.value.delete(item.id)
    else folded.value.add(item.id)
  }
}

watch(foldSignature, applyFoldState, { immediate: true })

/**
 * 第二条折叠入口：**本轮收尾**（`session.pending` 由 true → false）时再折一次。
 *
 * 为什么需要它：上面那条看的是"每条消息 streaming 的边沿"，而事件是分帧到达的 ——
 * 增量极密时 watcher 可能只在"已经是 false"的那一刻被调度到，"流式期间观察到 true"
 * 这个边沿压根没出现过，收尾就不折叠（harness 里用一次性灌四条事件的场景实测到）。
 * `session.pending` 的收尾边沿与本轮消息条数无关，一定发生，用它兜住。
 * 用户手动点开过的消息不受影响（`traceOpen` 里 userOpened 优先）。
 */
watch(
  () => props.session.pending,
  (pending) => {
    if (pending) return
    for (const item of props.session.items) {
      if (item.kind !== 'assistant' || item.streaming === true) continue
      seen.add(item.id)
      folded.value.add(item.id)
    }
  },
)

/* ── Markdown：按消息缓存（内容变了才重新解析）；图表由共享水合器接管 ── */
const contentCache = new WeakMap<ChatItem, { content: string; html: string }>()
const reasoningCache = new WeakMap<ChatItem, { content: string; html: string }>()

function htmlOf(item: ChatItem, field: 'content' | 'reasoning'): string {
  const source = field === 'content' ? item.content : (item.reasoning ?? '')
  if (source === '') return ''
  const cached = field === 'content' ? contentCache.get(item) : reasoningCache.get(item)
  if (cached !== undefined && cached.content === source) return cached.html
  const html = renderMarkdown(source)
  const value = { content: source, html }
  if (field === 'content') contentCache.set(item, value)
  else reasoningCache.set(item, value)
  return html
}

/* ── 代码块复制：容器事件委托（v-html 节点绑不了事件） ── */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 非安全上下文 / 权限被拒：走 execCommand 回落
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function onContentClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const button = target?.closest('.code-copy')
  if (!(button instanceof HTMLElement)) return
  const code = button.parentElement?.querySelector('code')?.textContent ?? ''
  void copyText(code).then((ok) => {
    if (!ok) {
      showNotice('复制失败：当前环境不允许访问剪贴板')
      return
    }
    const label = button.querySelector('.code-copy-label')
    const svg = button.querySelector('svg')
    const original = label?.textContent ?? '复制'
    button.classList.add('copied')
    if (label) label.textContent = '已复制'
    if (svg) svg.outerHTML = ICON_CHECK
    window.setTimeout(() => {
      button.classList.remove('copied')
      if (label) label.textContent = original
      const check = button.querySelector('svg')
      if (check) check.outerHTML = ICON_COPY
    }, 1400)
  })
}

/* ── 图表水合（KaTeX / mermaid / echarts，共享渲染器懒加载） ── */
const streamEl = ref<HTMLElement | null>(null)
let hydrator: ChartHydrator | null = null

function currentTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

watch(
  streamEl,
  (el) => {
    hydrator?.dispose()
    hydrator = el === null ? null : createChartHydrator(el, { theme: currentTheme })
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  hydrator?.dispose()
  releaseAudio()
})

/* ── 朗读（TTS 中转，docs/12 §6.4）：按客户端语音能力位门控 ── */
const ttsReady = computed(() => props.entry.status?.voice?.tts === true)
const speakingId = ref('')
const synthesizingId = ref('')
let audio: HTMLAudioElement | null = null
let audioUrl = ''

function releaseAudio(): void {
  audio?.pause()
  audio = null
  if (audioUrl !== '') {
    URL.revokeObjectURL(audioUrl)
    audioUrl = ''
  }
}

function stopSpeak(): void {
  releaseAudio()
  speakingId.value = ''
  synthesizingId.value = ''
}

async function speak(item: ChatItem): Promise<void> {
  if (speakingId.value === item.id || synthesizingId.value === item.id) {
    stopSpeak()
    return
  }
  stopSpeak()
  synthesizingId.value = item.id
  try {
    const { audioBase64, mimeType } = await synthesizeSpeech(
      props.entry.client.clientId,
      item.content,
    )
    if (audioBase64 === '') throw new Error('客户端没有回传音频数据')
    const binary = atob(audioBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const blob = new Blob([bytes], { type: mimeType })
    audioUrl = URL.createObjectURL(blob)
    audio = new Audio(audioUrl)
    audio.onended = () => stopSpeak()
    audio.onerror = () => {
      stopSpeak()
      showNotice('朗读播放失败（浏览器可能阻止了自动播放）')
    }
    await audio.play()
    speakingId.value = item.id
  } catch (error) {
    stopSpeak()
    showNotice(`朗读失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    synthesizingId.value = ''
  }
}

/* ── 展示辅助 ── */
const failedCount = (item: ChatItem): number =>
  item.tools.filter((tool) => tool.state === 'error').length

const hasTrace = (item: ChatItem): boolean => item.tools.length > 0 || (item.reasoning ?? '') !== ''

const showLoading = computed(() => {
  const hasStreamingAssistant = props.session.items.some(
    (item) => item.kind === 'assistant' && item.streaming === true,
  )
  return props.session.pending && !hasStreamingAssistant
})

/**
 * 「整表替换」窗口（切会话 / 历史回放）：这一段里**关掉**进出场动画。
 *
 * `<TransitionGroup name="rise">` 的 leave 只改 opacity / transform，被换掉的条目在
 * `--dur-base` 内仍然占位，而新条目同时进场 —— 列表高度瞬时接近翻倍、滚动条跟着跳两次。
 * 整表替换本来就是「内容整体换掉」，不该有「一条条浮现」的语义；流式追加**不换**数组引用，
 * 因此逐条进场只在真正新增时发生（与桌面端 `MessageList` 的 `swapping` 同款策略）。
 *
 * 关的是**一段短窗口**（80ms）而不是只关一帧：历史回放是一串事件分几拍落地的
 * （用户消息 / 助手消息 / 工具行各自一个 patch），只关一帧的话从第二拍起又放动画，
 * 于是旧条目还在离开、新条目已经开始浮起。
 */
const swapping = ref(false)
let swapTimer: number | undefined

function markSwapping(): void {
  swapping.value = true
  if (swapTimer !== undefined) window.clearTimeout(swapTimer)
  swapTimer = window.setTimeout(() => {
    swapping.value = false
    swapTimer = undefined
  }, 80)
}

watch(() => props.session.items, markSwapping)
watch(() => props.session.sessionId, markSwapping)

onBeforeUnmount(() => {
  if (swapTimer !== undefined) window.clearTimeout(swapTimer)
})
</script>

<template>
  <div
    ref="streamEl"
    class="stream"
    data-field="chat.messages"
    aria-live="polite"
    @click="onContentClick"
  >
    <p v-if="session.items.length === 0 && !session.pending" class="empty">
      这个远程会话还是空的。在下面输入一句话，Agent 会在客户端上执行并把过程实时回传到这里。
    </p>

    <!--
      条目进场：`rise`（共享预设）+ `:css="!swapping"`（整表替换的那一段关掉动画，见脚本注释）。
      `tag="div"` 的包装元素自己扛下原来的列布局 —— 包装元素是 `TransitionGroup` 必须的，
      不把 `.stream` 的 flex/间距挪一份到这里，所有条目就会挤成无间距的一摞。
    -->
    <TransitionGroup name="rise" tag="div" class="stream-items" :css="!swapping">
      <template v-for="item in session.items" :key="item.id">
        <!-- 用户消息：右对齐胶囊 -->
        <div v-if="item.kind === 'user'" class="row r-user" data-field="chat.user-message">
          <div class="bubble">{{ item.content }}</div>
        </div>

        <!-- 错误条 -->
        <div v-else-if="item.kind === 'error'" class="row r-error" data-field="chat.error">
          <div class="error-box">
            <strong>出错了</strong>
            <span>{{ item.content }}</span>
            <span v-if="item.code" class="code">{{ item.code }}</span>
          </div>
        </div>

        <!-- 提问卡（本轮，docs/12 §5）：跟消息一起排；结算后原地变成只读卡（留痕） -->
        <AskCard
          v-else-if="item.kind === 'ask' && item.ask"
          :ask="item.ask"
          :client-id="session.clientId"
          :session-id="session.sessionId"
          :remaining-ms="item.ask.expiresAt - now"
          @resolved="onAskResolved"
        />

        <!-- 任务清单卡 -->
        <JobCard v-else-if="item.kind === 'job' && item.job" :job="item.job" />

        <!-- 子代理卡（没有配套工具行时的回落渲染） -->
        <SubagentCard
          v-else-if="item.kind === 'subagent' && item.subagent"
          :snapshot="item.subagent"
        />

        <!-- 助手消息：轨迹容器（思考 → 工具行） + 正文 -->
        <div v-else-if="item.kind === 'assistant'" class="row r-assistant">
          <div class="assistant-body">
            <AgentTrace
              v-if="hasTrace(item)"
              :steps="item.tools.length"
              :failed="failedCount(item)"
              :running="item.streaming === true"
              :started-at="item.startedAt"
              :ended-at="item.endedAt"
              :open="traceOpen(item)"
              @toggle="toggleTrace(item)"
            >
              <ThinkingBlock
                v-if="(item.reasoning ?? '') !== ''"
                :reasoning="item.reasoning ?? ''"
                :streaming="item.streaming === true"
                :last-at="item.reasoningAt"
              />
              <!-- 工具行在一轮里逐个出现，走 `tool` 预设分行错峰（见本文件样式末尾） -->
              <TransitionGroup
                v-if="item.tools.length > 0"
                name="tool"
                tag="div"
                class="tools"
                :css="!swapping"
              >
                <AgentToolRow v-for="tool in item.tools" :key="tool.id" :tool="tool" />
              </TransitionGroup>
            </AgentTrace>

            <!-- Markdown 的唯一出口：渲染器 `html:false` 先转义再套白名单标记，链接 scheme
                 走 validateLink（javascript: 拒绝）—— 与桌面端同一条安全基线 -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="md" data-field="chat.markdown" v-html="htmlOf(item, 'content')" />
            <DisplayImageGallery
              v-if="displayImagesOf(item).length > 0"
              :images="displayImagesOf(item)"
              :client-id="session.clientId"
              :session-id="session.sessionId"
            />

            <div class="msg-foot">
              <span v-if="item.streaming" class="streaming-caret" aria-hidden="true" />
              <button
                v-else-if="ttsReady && item.content.trim() !== ''"
                type="button"
                class="speak-btn"
                :class="{ active: speakingId === item.id }"
                :data-action="speakingId === item.id ? 'stop-speak' : 'speak-message'"
                @click="speak(item)"
              >
                <Volume2 :size="13" :stroke-width="1.7" aria-hidden="true" />
                {{
                  synthesizingId === item.id ? '合成中…' : speakingId === item.id ? '停止' : '朗读'
                }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </TransitionGroup>

    <div v-if="showLoading" class="pending-row" data-field="chat.pending">
      <!-- 三点等待用共享的 `aurora-typing-bounce`（与桌面端同一枚关键帧），
           比转圈更贴合「模型正在吐字」的语义；错峰的延迟写成令牌的倍数，
           `prefers-reduced-motion` 压时长时跟着一起缩。 -->
      <span class="typing" aria-hidden="true"><i /><i /><i /></span>
      正在生成…
    </div>

    <!-- 「回到最新」只做淡入淡出：位置由 sticky 决定，位移会溢出到消息之上 -->
    <Transition name="fade">
      <button
        v-if="!following && session.items.length > 0"
        type="button"
        class="jump-latest glass-panel"
        data-action="chat.jump-latest"
        @click="emit('jumpLatest')"
      >
        回到最新
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.stream {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) 0 var(--space-5);
}

/*
 * `TransitionGroup` 的包装元素：条目自己的列布局（原来挂在 `.stream` 上的那份）
 * 必须跟着挪进来 —— 包装元素是块级元素，不留这一份的话所有条目会失去间距。
 */
.stream-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.empty {
  margin: var(--space-6) auto;
  max-width: 420px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  text-align: center;
}

.row {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}

.r-user {
  flex-direction: row-reverse;
}

.r-user .bubble {
  max-width: 78%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--aurora-blue) 20%, transparent);
  color: var(--text-primary);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  word-break: break-word;
}

.r-error .error-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--status-error) 32%, transparent);
  border-radius: var(--radius-md);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-sm);
}

.r-error .code {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.assistant-body {
  min-width: 0;
  flex: 1 1 auto;
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  color: var(--text-primary);
  word-break: break-word;
}

.msg-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 20px;
  margin-top: var(--space-1);
}

.speak-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.speak-btn:hover {
  background: var(--fill-2);
  color: var(--text-secondary);
}

.speak-btn.active {
  border-color: var(--accent-text);
  color: var(--accent-text);
}

.pending-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

/* 三点等待：形状与节奏与桌面端 `.typing` 逐字一致（同一份 `aurora-typing-bounce`） */
.typing {
  display: inline-flex;
  gap: 4px;
}

.typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aurora-blue);
  animation: aurora-typing-bounce var(--dur-bounce) infinite ease-in-out;
}

/* 延迟写成 `--dur-bounce` 的倍数：reduced-motion 把时长压到 1ms 时错峰也一并消失 */
.typing i:nth-child(2) {
  animation-delay: calc(var(--dur-bounce) * 0.15);
}

.typing i:nth-child(3) {
  animation-delay: calc(var(--dur-bounce) * 0.3);
}

.jump-latest {
  position: sticky;
  bottom: var(--space-2);
  align-self: center;
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--glass-panel);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  box-shadow: var(--shadow-2);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.jump-latest:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* ── 工具行进场（TransitionGroup name="tool"）──
   同一轮里工具行是逐个出现的：轻微上浮 + 淡入，比条目自身的 `rise` 更短更轻
   （一轮可能连着长出好几行，动作太重整个消息区会像在跳）。
   theme.css 没有 `tool-*` 预设，按桌面端 `MessageList.vue` 的定义在本地 scoped 里补一份。 */
.tool-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-spring);
}

.tool-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.tool-enter-from {
  opacity: 0;
  transform: translateY(6px) scale(0.985);
}

.tool-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/*
 * 同一批行错开 40ms 出现（第 2 / 3 / 4 行起）。
 * 必须挂在 enter / leave 的 active 类下：`transition-delay` 是**常驻生效**的，
 * 只写 `.tool-card:nth-child(2)` 会让这一行此后任何过渡都晚 40ms 起步（误伤别的动效）。
 * 选择器按子组件根节点（`.tool-card`）匹配：scoped 的 `[data-v]` 与子组件根上的父 scope id
 * 会同时命中，用法与桌面端那份一致。
 */
.tools > .tool-card:nth-child(2).tool-enter-active,
.tools > .tool-card:nth-child(2).tool-leave-active {
  transition-delay: 40ms;
}

.tools > .tool-card:nth-child(3).tool-enter-active,
.tools > .tool-card:nth-child(3).tool-leave-active {
  transition-delay: 80ms;
}

.tools > .tool-card:nth-child(n + 4).tool-enter-active,
.tools > .tool-card:nth-child(n + 4).tool-leave-active {
  transition-delay: 120ms;
}
</style>
