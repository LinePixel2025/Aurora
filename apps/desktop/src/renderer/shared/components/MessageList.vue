<script setup lang="ts">
/**
 * 消息列表（对话窗的消息流）。
 *
 * 视觉（docs/07 §5）：用户消息右对齐胶囊气泡，助手消息左对齐纯文本块（Apple 风格：不套气泡），
 * 代码块单独成卡并带 hover 显隐的「复制」；一条助手消息的「思考 + 工具调用」收进执行轨迹
 * （`AgentTrace`，折叠态一行摘要 / 展开态左缘竖脊；工具行默认折叠，展开走 `.collapse-*`）。
 * props / 插槽契约：`messages`（消息数组）+ `emptyHint`（空状态提示语）。
 *
 * BetaV2 追加：
 * - 「思考过程」折叠块（`message.reasoning`，受 `showThinking` 门控）：流式中有新思考时
 *   自动展开（`thinkingTargetId`），请求结束后收起为「已深度思考」摘要行，手动可开合；
 * - `generate_image` / `show_image` 的成果进入助手消息图片区（按 id 向主进程读取
 *   dataUrl，读取失败显示可读回退，绝不阻塞消息流）。
 *
 * 2026-09 重构追加（docs/07 §2.3「任务清单与子代理卡」）：
 * - `todo_write` 工具卡渲染为**结构化任务清单卡**（`data-field="chat.todo-card"`），
 *   解析见 `shared/agentTodo.ts`；解析失败 / 非 todo_write 回落通用工具卡；
 * - `task` 工具卡渲染为**子代理卡**（`data-field="chat.task-card"`，卡头是任务简述 +
 *   授权了写权限时的「可读写」徽章，展开体是**独立对话视图** `SubagentConversation`：
 *   任务指令 → 正文 → 工具调用与结果 → 最终报告；2026-09 起卡内不再叠一份紧凑轨迹）。
 *
 * 2026-09 动画轮追加（docs/07 §5.2）：
 * - 工具卡进场上浮 + 卡片逐个错开；运行中的卡叠扫光；状态翻到终态时状态点弹一下；
 * - 思考块流式期间显示尾部光标与「思考中」扫光，正文跟随滚动到最新一行；
 * - 图标统一走 lucide（`shared/icons.ts`），工具卡按工具名给语义图标（`shared/toolIcons.ts`）。
 *
 * 2026-09-30 轨迹视觉重构追加（docs/07 §2.3 / §5.2，本文件与 `AgentTrace.vue` /
 * `AgentToolRow.vue` 三件套）：
 * - 一条助手消息的「思考 + 工具调用」收进 **AgentTrace**：折叠态是一行摘要
 *   （1px 上下描边、无盒子），展开态是左缘竖脊 + 节点圆点，展开 / 收起走 `name="fade"`
 *   （内容在流式期间还在长，实测高度的终点会被 `overflow: hidden` 裁掉并补跳）；
 * - 每张工具卡变成 **AgentToolRow**：去掉行内状态文字（语义交给状态点色 + `aria-label`），
 *   结果摘要上提到行首一行，终态一次性确认 + 行底色淡出（`aurora-tint-out` / `--dur-tint`）；
 * - **自动折叠状态机**（本条是本轮的行为核心）：`props.streaming` 的两个边沿各管一头 ——
 *   false → true（新一轮开始）把**此刻在屏的消息**登记为历史（默认折叠），
 *   true → false（这一轮结束）把**本轮追加的消息**（= 到此刻还没登记的）一并收起为一行摘要；
 *   历史水合出来的消息默认折叠；用户点开某条（`traceOpenedIds`）就保持点开（跨轮不清）；
 *   流式期间的目标消息自动展开（`thinkingTargetId`，写在 `traceOpen` 的判据里）。
 *   落到渲染上就是
 *   `traceOpen(message) = traceOpenedIds.has(id) || thinkingTargetId === id || !historyFoldedIds.has(id)`；
 *   ⚠️ 收尾只能按「本轮追加了哪些」收，按「哪些被打开过」收会漏掉**没有思考增量**的工具轮
 *   （2026-10-01 用户实测：「模型答完了，工作过程还摊着不折叠」）；
 *   ⚠️ 收尾有**两个触发入口**（同一个 `settleRound`）：`streaming` 边沿，以及 useChat 的
 *   `settledRequestId` 收尾信号 —— 跨窗口观看 / 中途切走再切回时本窗口 `streaming` 全程
 *   为 false、边沿从不触发，只挂边沿会让本轮轨迹永远摊开（P2-20）；
 * - 三处扩展 / 收起（轨迹头、思考块头、工具行头）在**跟随态**下重新贴底
 *   （`stick(reduceMotion ? 'auto' : 'smooth')`，判定照抄 `jumpToLatest`）。
 *
 * ⚠️ 探针依赖的结构一条都不能动（capture 直接按选择器断言）：
 * `.message.r-assistant .thinking` / `.thinking-head`（折叠态文案含「已深度思考」）/
 * `.thinking-body` / `.thinking-text` / `.thinking.streaming .thinking-text` /
 * `.tool-card` / `.tool-head` / `.tool-icon`（每卡恰好一枚）/ `.tool-body`（带内联 `--collapse-h`）/
 * `.tool-args`；`.thinking` 与同气泡 `.md` 的 DOM 先后（思考在前）不变；
 * `data-field` 的 `chat.messages` / `chat.todo-card` / `chat.task-card` / `chat.thinking-live` 保留。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { AgentToolCall, ChatDisplayImage } from '@aurora/shared'
import type { ChatMessage } from '../composables/useChat.js'
import { useStickToBottom } from '@aurora/shared/browser'
import '@aurora/shared/browser/markdown/md.css'
import {
  ICON_CHECK,
  ICON_COPY,
  createChartHydrator,
  renderMarkdown,
  type ChartHydrator,
} from '@aurora/shared/browser'
import { parseTaskInput, parseTodoWriteInput } from '../agentTodo.js'
import { ArrowDown, ChevronRight, LoaderCircle, Square, Volume2 } from '@aurora/shared/browser'
import AgentTrace from './AgentTrace.vue'
import AgentToolRow from './AgentToolRow.vue'
import DisplayImageGallery from './DisplayImageGallery.vue'

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
    /** 该窗口是否处于流式接收中（结束边沿用于把思考块收起为摘要） */
    streaming?: boolean
    /** 是否展示「思考过程」块（`general.chat.showThinking`；关闭时整块不渲染） */
    showThinking?: boolean
    /** 正在接收思考过程的助手消息 id（useChat 的 reasoningTargetId；自动展开依据） */
    thinkingTargetId?: string | null
    /**
     * 最近一次「本轮收尾」的 requestId（useChat 的 `lastSettledRequestId`，done / error 置位）。
     *
     * 折叠收尾的**第二个触发入口**（docs/07 §2.3，P2-20）：跨窗口观看 / 中途切走再切回时，
     * 本窗口的 `streaming` 全程为 false，「streaming 边沿」根本不触发 —— 只挂边沿的话，
     * 本轮轨迹与思考块会永远停在展开态。本窗口自己发起时它也会置位：与边沿走同一条
     * 收拢路径，重复调用幂等。
     */
    settledRequestId?: string | null
    /**
     * 当前会话 id（2026-10-03 会话状态增强）：显示状态（折叠 / 展开 / 已结算动画 / 图片预览）
     * 按会话分桶存在**模块级**缓存里，调用方须以 `:key="sessionId"` 让组件随会话重挂载 ——
     * 重挂载后从桶里恢复，切走再切回「过程显示」不再消失（docs/07 §2.3）。
     * 缺省落 `_default` 桶（不切会话的窗口行为与从前一致）。
     */
    sessionId?: string
  }>(),
  {
    emptyHint: '开始一段对话吧',
    ttsAvailable: false,
    speakingId: null,
    ttsLoadingId: null,
    streaming: false,
    showThinking: true,
    thinkingTargetId: null,
    settledRequestId: null,
    sessionId: '',
  },
)

/**
 * 显示状态的**会话分桶**（模块级，2026-10-03 会话状态增强）。
 *
 * 消息正文 / 思考 / 工具卡在切回会话后能由 `chat:history` 恢复，丢的从来是**渲染层
 * 显示状态**：轨迹折叠 / 展开、思考块开合、工具行开合、终态确认动画（防重放）、
 * 终态确认动画等。把它们按会话存进模块级桶，组件随会话重挂载（`:key="sessionId"`）
 * 后从桶里取回，切走再切回就不再「过程显示全部消失」。
 *
 * 只存内存、有界（最多 64 个会话，超出丢最旧的）：重启后重建是可接受的 ——
 * 落盘持久化的是计时（`AgentToolCall.startedAt/endedAt`）与用量（`meta.usage`）。
 */
interface SessionDisplayState {
  thinkingOpen: Ref<string[]>
  traceOpenedIds: Set<string>
  historyFoldedIds: Set<string>
  openedIds: Ref<string[]>
  settledIds: Set<string>
}

const displayBuckets = new Map<string, SessionDisplayState>()
const DISPLAY_BUCKET_LIMIT = 64

function displayBucketOf(id: string): SessionDisplayState {
  const existing = displayBuckets.get(id)
  if (existing !== undefined) return existing
  const created: SessionDisplayState = {
    thinkingOpen: ref<string[]>([]),
    traceOpenedIds: reactive(new Set<string>()),
    historyFoldedIds: reactive(new Set<string>()),
    openedIds: ref<string[]>([]),
    settledIds: reactive(new Set<string>()),
  }
  // 有界：超出上限丢最旧的桶（Map 迭代序即插入序）
  while (displayBuckets.size >= DISPLAY_BUCKET_LIMIT) {
    const oldest = displayBuckets.keys().next().value
    if (oldest === undefined) break
    displayBuckets.delete(oldest)
  }
  displayBuckets.set(id, created)
  return created
}

const displayState = displayBucketOf(props.sessionId ?? '_default')
const thinkingOpen = displayState.thinkingOpen
const traceOpenedIds = displayState.traceOpenedIds
const historyFoldedIds = displayState.historyFoldedIds
const openedIds = displayState.openedIds
const settledIds = displayState.settledIds

const emit = defineEmits<{
  (event: 'speak', text: string, id: string): void
  (event: 'stopSpeak'): void
}>()

/**
 * 消息流根节点。两处消费：`useStickToBottom` 从它**向上**找滚动容器（窗口的 `.thread`）；
 * 思考块内的滚动跟随从它**向下**查 `.thinking.streaming .thinking-text`。
 * 声明放在这里（而不是「跟随最新」那段里），是为了让下面的思考块机制在自己的
 * setup 期 watcher（`immediate`）里引用它时，一定在初始化之后。
 */
const rootEl = ref<HTMLElement | null>(null)

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

/** 助手消息图片区：聚合所有成功工具卡里的展示图片，按 id 去重并保持调用顺序。 */
function displayImagesOf(message: ChatMessage): ChatDisplayImage[] {
  const images: ChatDisplayImage[] = []
  const seen = new Set<string>()
  for (const call of message.toolCalls ?? []) {
    if (call.state !== 'success' || call.displayImages === undefined) continue
    for (const image of call.displayImages) {
      if (seen.has(image.id)) continue
      seen.add(image.id)
      images.push(image)
    }
  }
  return images
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

// ───────────────────────── 思考过程折叠块（BetaV2） ─────────────────────────

/**
 * 已展开「思考过程」的消息 id。
 *
 * 语义在轨迹重构后**刻意保持原样**：思考块自己的开合（点 `.thinking-head`）与
 * 轨迹容器的开合（点 `.trace-head`）是两个独立状态，「用户点开就保持点开」这条
 * 靠这两个集合各自成立。流式结束后这里会被清空（回到「已深度思考」摘要行）。
 * （2026-10-03 起按会话分桶：声明见 `displayBucketOf`。）
 */

/**
 * 折叠时的思考块文案。
 *
 * ⚠️ 折叠态**必须**回到「已深度思考」：capture 的 `CHAT_THINKING_BLOCK_ACT` 先读折叠态文案
 * （断言 `labelOk` 含该串）再点开，文案随流式状态漂移会让那条探针 FAIL。
 * 「思考中…」只出现在轨迹摘要行（`traceSummary`）里。
 */
const THINKING_LABEL = '已深度思考'

/** 思考块是否展开（消息 id） */
function isThinkingOpen(id: string): boolean {
  return thinkingOpen.value.includes(id)
}

/**
 * 轨迹被**用户显式展开**的消息 id（点开就留在这儿，跨轮不清）。
 *
 * 它只装"用户意图"一件事 —— 流式期间正在思考的那条由 `traceOpen` 直接判定，
 * 不混进来（见下方「轨迹自动折叠」一节）。与 `historyFoldedIds` 一起构成
 * `traceOpen(message)`：折叠判定本身没有额外的开关变量。
 * （2026-10-03 起按会话分桶：声明见 `displayBucketOf`。）
 */

// ────────── 思考块内的自动翻滚（块内部的小滚动区，独立于消息区） ──────────

/**
 * 块内「跟随最新」的判定阈值（px）：与 `useStickToBottom` 同口径（默认 24），
 * 覆盖亚像素误差与最后一行折行。**作用域只有块内的 `.thinking-text`**——
 * 这里绝不碰消息区（`.thread`），消息区的跟随由 useStickToBottom 单独管。
 */
const THINKING_STICK_THRESHOLD = 24

/**
 * 块内是否仍在跟随最新。
 *
 * 用户在块内主动上滚（离底超过阈值）即置 false（**用户接管**），自己滚回底部再恢复 true ——
 * 与 `useStickToBottom` 的「用户意图优先」语义一致，只是范围缩到这个块的小滚动区：
 * 用户正在回看前面的思考时，下一次增量不许把它硬拽回底部。
 */
const thinkingFollowing = ref(true)

/** 在途的 rAF 句柄：同一帧内的多次滚动请求合并成一次（卸载时必须取消） */
let thinkingFrame: number | null = null

/**
 * 当前**正在流式**的思考正文元素。
 *
 * 搜索范围刻意收在 `.thinking.streaming` 内：既只认"正在思考"的那一块，
 * 又天然避开已结束的历史块（用户点开历史块时应从顶部读起，不该被跳到底部）。
 * 块未展开（`v-if` 为假）/ 不在流式时都返回 null，调用方据此跳过。
 */
function thinkingTextEl(): HTMLElement | null {
  return rootEl.value?.querySelector<HTMLElement>('.thinking.streaming .thinking-text') ?? null
}

function thinkingDistanceToBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * 块内滚动 → 重新判定是否跟随（用户接管 / 交还）。
 * 程序触发的滚动也会走到这里，但那时距离为 0，判定结果仍是「跟随」，不会自己把自己关掉。
 */
function onThinkScroll(event: Event): void {
  const el = event.target
  if (!(el instanceof HTMLElement)) return
  thinkingFollowing.value = thinkingDistanceToBottom(el) <= THINKING_STICK_THRESHOLD
}

/**
 * 把「滚到思考正文最新一行」合并到**下一帧**执行。
 *
 * 走 rAF 而不是在 watcher 里同步滚，有三个原因：
 * 1. 一条流式 delta 会触发多次请求（reasoning 变化 + 目标变化），逐次同步读写布局是白做功；
 * 2. DOM 变更发生在布局之前，等一帧拿到的 `scrollHeight` / `clientHeight` 才是最终值；
 * 3. 块**首次展开**那一帧 DOM 还不存在（`v-if` 刚翻真），延迟一帧才查得到元素 ——
 *    这正是此前「长思考从展开起就停在顶部」的原因。
 */
function scheduleThinkingFollow(): void {
  if (thinkingFrame !== null) return
  thinkingFrame = window.requestAnimationFrame(() => {
    thinkingFrame = null
    const el = thinkingTextEl()
    if (el === null) return
    if (thinkingFollowing.value) {
      el.scrollTop = el.scrollHeight
      return
    }
    // 用户接管期间内容缩到不足一屏（切会话 / 收起块）时没有可滚动的距离，
    // 「暂停跟随」就没有意义了 —— 恢复跟随，免得下一轮思考开始时仍停在旧状态。
    // 注意：用户真的在翻前面的思考时距离远大于阈值，不会被这条误清。
    if (thinkingDistanceToBottom(el) <= THINKING_STICK_THRESHOLD) thinkingFollowing.value = true
  })
}

/**
 * 新一轮思考开始 / 块刚展开：复位为「跟随」并滚一次。
 * 与 `useStickToBottom` 的 `stick()` 同义 —— 新内容从底部开始看，
 * 用户上一轮的上滚状态不带到这一轮。
 */
function beginThinkingFollow(): void {
  thinkingFollowing.value = true
  scheduleThinkingFollow()
}

// ────────── 思考耗时计数（块头「思考中… 3s」，仅流式期间显示） ──────────

/** 本轮思考已进行的整秒数；只在 `thinkingTargetId` 指向某条消息（思考阶段）时递增 */
const thinkingSeconds = ref(0)

/** 本轮思考的起点（`Date.now()`）；`thinkingTimer === null` 时无意义 */
let thinkingStartedAt = 0
let thinkingTimer: number | null = null

/** 停表并清零（三条清理路径共用：目标清空 / 请求结束 / 组件卸载） */
function stopThinkingTimer(): void {
  if (thinkingTimer !== null) window.clearInterval(thinkingTimer)
  thinkingTimer = null
  thinkingSeconds.value = 0
}

/**
 * 开始（或重启）读秒。
 *
 * 每轮思考各自计时：`thinkingTargetId` 由 null 变为某条消息（新一轮思考开始）时清零重来，
 * **不做跨轮累加**——跨工具调用的多轮里，「已经想了多久」指的是当前这一轮。
 * 节奏与工具耗时 ticker（200ms）同量级，秒数变化看得出来、又不至于每帧刷。
 */
function startThinkingTimer(): void {
  stopThinkingTimer()
  thinkingStartedAt = Date.now()
  thinkingTimer = window.setInterval(() => {
    thinkingSeconds.value = Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000))
  }, 200)
}

function toggleThinking(id: string): void {
  if (isThinkingOpen(id)) {
    thinkingOpen.value = thinkingOpen.value.filter((item) => item !== id)
    return
  }
  thinkingOpen.value = [...thinkingOpen.value, id]
  // 展开这一帧 DOM 还不存在（`v-if` 刚翻真），要等下一帧才滚得到；
  // `thinkingTextEl()` 只认 `.thinking.streaming` 那块，历史块点开仍从顶部开始读。
  scheduleThinkingFollow()
}

/**
 * 流式中有新思考时自动展开：`thinkingTargetId` 变化（useChat 在首个 reasoning /
 * 或消息被认领时设置）即展开对应消息的思考块。
 *
 * 这条 watcher 同时收口三件事，避免同一状态散落多处：
 * 1. 目标清成 null（正文开始写 = 这一轮思考结束）→ 停表；块保持展开，
 *    只换文案与动效类，收起留给请求结束时的 `streaming` 边沿（状态切换不闪）；
 * 2. 目标被指到 → 展开该块，并滚到块内最新一行（DOM 下一帧才存在）；
 * 3. 目标被指到 → 开始（或重启）本轮思考的读秒。
 *
 * 轨迹重构追加第 4 件：目标出现时把**外层轨迹**也打开 —— 这一条现在写在 `traceOpen` 的
 * 第 2 条判据里（`props.thinkingTargetId === message.id` → 展开），**不再**往
 * `traceOpenedIds` 里塞：那个集合表达的是"用户**显式**点开过"，把自动展开混进去会让收尾边沿
 * 分不清"该收起来的自动展开"与"该保留的用户意图"（2026-10-01 的折叠 bug 就出在这里）。
 * 这一条只对"当前正在思考的那条"生效，翻历史时不会被别的消息的增量强行展开。
 */
watch(
  () => props.thinkingTargetId,
  (id) => {
    if (id === null || id === '') {
      stopThinkingTimer()
      return
    }
    if (!thinkingOpen.value.includes(id)) thinkingOpen.value = [...thinkingOpen.value, id]
    beginThinkingFollow()
    startThinkingTimer()
  },
  { immediate: true },
)

/**
 * 请求结束（streaming true → false 边沿）：把这一轮的思考块与轨迹一起收起为摘要行。
 *
 * 这是**轨迹自动折叠状态机**的触发点（docs/07 §2.3）：边沿一到就
 * ① 收起思考块（`thinkingOpen`）、② 把**本轮追加的消息**全部收成折叠态
 * （`markPresentAsHistory`）——于是 `traceOpen(message)` 对它们一律为 false（除非用户点开过），
 * 已结束的轨迹回到一行摘要。
 *
 * ⚠️ 收的是"此刻在屏但还没登记过的"（= 本轮追加的），不是"这一轮被打开过的"：
 * 后者漏掉**没有思考增量**的那一轮（它从没进过 `traceOpenedIds`），轨迹会永远摊开着
 * —— 用户报的「模型工作过程没有折叠」（2026-10-01 实测，回归防线见 `chat-trace-fold` 探针）。
 *
 * 同一条路径上兜底停表：正常收尾 `useChat` 会先清 `thinkingTargetId`（上面已停过），
 * 但出错 / 目标未被清时也不许留下定时器。
 */
watch(
  () => props.streaming,
  (now, before) => {
    if (now === before) return
    if (now === true) {
      // 新一轮开始：此刻在屏的一切都是历史（默认折叠），本轮新追加的默认展开。
      markPresentAsHistory()
      return
    }
    settleRound()
  },
)

/**
 * 「本轮收尾」显式信号（useChat 的 `lastSettledRequestId`，done / error 置位）。
 *
 * 折叠收尾的**第二个触发入口**（P2-20）：跨窗口观看 / 中途切走再切回时，本窗口的
 * `streaming` 全程为 false，上面那条边沿 watch 因 `now === before` 直接 return ——
 * 本轮轨迹与思考块会永远停在展开态。这里改挂收尾信号：只要本窗口看到了收尾事件
 * （requestId 变化）就收拢一次。本窗口自己发起时边沿与它都会触发，`settleRound`
 * 幂等，重复无害（`thinkingOpen` 清空、`markPresentAsHistory` 重复 `add` 无副作用）。
 */
watch(
  () => props.settledRequestId,
  (id) => {
    if (id === null || id === '') return
    settleRound()
  },
)

/**
 * 本轮收尾的收拢动作（`streaming` 边沿与 `settledRequestId` 两个入口共用的**唯一一份**）。
 *
 * 三段：收起思考块、停表、把此刻在屏的消息全部登记为"已结束"（默认折叠）。
 * 抽成一个函数是刻意的 —— 两个触发入口各写一份迟早会漂移（2026-09-30 的
 * 「pass 与 conditions 表漂移」同类教训）。
 */
function settleRound(): void {
  thinkingOpen.value = []
  stopThinkingTimer()
  markPresentAsHistory()
}

/**
 * 折叠态思考块的文案。
 *
 * ⚠️ 刻意**不随** `thinkingTargetId` 漂移（改前是「思考中…」/「已深度思考」二选一）：
 * capture 的 `CHAT_THINKING_BLOCK_ACT` 先读折叠态文案并断言含「已深度思考」，
 * 高密度爆发探针（`capture-reasoning-probe` 那组）也在流式开始的那一刻读同一行文字。
 * 「思考中…」现在只出现在**轨迹摘要行**（见 `traceSummary`），思考块自己的行永远是完成态文案。
 */
function thinkingLabel(): string {
  return THINKING_LABEL
}

/**
 * 思考块流式期间把**块内**滚动条跟到最新一行。
 *
 * 整块正文是 `white-space: pre-wrap` 的一整段，若不跟随，长了以后新内容在视口外，
 * 看起来像「卡住不动」。只滚 `.thinking-text`，不动消息区（消息区由 useStickToBottom 管）。
 * 依赖写成「所有消息 reasoning 长度之和」：思考增量一定让它变化，且没有增量时不触发；
 * 真正的读 / 写布局合并到一帧一次（见 `scheduleThinkingFollow`），不在这里碰 DOM。
 */
watch(
  () => props.messages.reduce((total, message) => total + (message.reasoning?.length ?? 0), 0),
  () => scheduleThinkingFollow(),
)

// ───────────────────────── 跟随最新（自动滚底） ─────────────────────────

/**
 * 滚动容器是窗口自己的 `.thread`（由 `useStickToBottom` 从本组件根节点向上查找），
 * 因此这里只负责"什么算新内容、什么时候强制回底"，容器结构不动。
 *
 * 四个成员：`following`（是否跟随）、`scrollToBottom`（只滚不动状态）、`stick`（恢复跟随并滚底）、
 * `refresh`（重读读数并对齐一次 —— 窗口从隐藏恢复可见 / 容器尺寸变化时用）。
 */
const { following, stick, refresh: refreshStick } = useStickToBottom(() => rootEl.value)

/**
 * 展开 / 收起后**重新贴底**（docs/07 §2.3）。
 *
 * 只在**跟随态**下动手：用户正在翻历史时展开一条轨迹，视口不该被拽走
 * （与 `useStickToBottom` 的「用户意图优先」同一条语义）。
 *
 * 刻意用**瞬时**滚动（不用 smooth）：2026-10-01 起展开体走 grid 高度动画，
 * 底部是逐帧移动的 —— `stickToBottomCore` 的结算帧每帧按**当下**高度对齐，
 * 视口跟着动画一起滑，比「smooth 滚向旧高度 + 结算帧瞬跳新高度」两种动效打架顺畅得多
 * （那正是用户报「展开时滚动不顺畅」的另一半来源）。
 * 点击与 `stick()` 同一次同步执行、DOM 还没更新，所以这次滚动用的是**旧高度**；
 * 真正贴到新底靠 `stickToBottomCore` 在 DOM 变更后的补帧（见那边的「② 内容变高后必须自愈」）。
 */
function restick(): void {
  if (!following.value) return
  stick()
}

/**
 * 整表被替换（历史水合 / 切会话 / 清空）的那一帧关掉进出场动画。
 *
 * `<TransitionGroup name="rise">` 的 leave 只改 opacity / transform，被换掉的消息在
 * 250ms 内**仍然占位**，而新消息同时进场 —— 列表高度瞬时接近翻倍，滚动条跟着跳两次。
 * 整表替换本来就是「内容整体换掉」，不需要「一条条浮现」的语义；流式追加不换数组引用，
 * 因此仍然保留逐条进场动画。
 */
const swapping = ref(false)

// ───────────────────── 轨迹自动折叠状态机（2026-09-30） ─────────────────────

/**
 * 判定「这条消息的轨迹默认折叠」的 id 集合。
 *
 * 三个来源，合起来覆盖"什么算历史 / 什么算已结束"：
 * 1. **整表替换进来的消息**（窗口刚挂载时的水合结果 / 切会话 / 清空后重新水合）——
 *    `props.messages` 换引用且此刻 `streaming` 为 false 时整表入册（`markIncomingAsHistory`）；
 * 2. **新一轮开始**（streaming false → true 边沿）——此刻在屏的一切都成了历史（`markPresentAsHistory`）；
 * 3. **这一轮结束**（streaming true → false 边沿）——把这轮追加的消息全部入册，收起为一行摘要。
 *
 * 流式期间**新追加**的消息不在这个集合里，所以 `traceOpen` 对它们默认为真 ——
 * 正在跑的那条轨迹默认展开，跑完被边沿收掉。历史消息默认折叠，用户点开后进
 * `traceOpenedIds`，`traceOpen` 恒为真（"用户点开就保持点开"，跨轮也不清）。
 *
 * ⚠️ **不要在收尾边沿只收「打开过的」（2026-10-01 用户实测的 bug）**：轨迹的"打开"原先
 * 混在 `traceOpenedIds` 里，而**只有思考增量到达**（`thinkingTargetId`）才会把消息放进去。
 * 于是「有工具调用但没有思考增量」的那一轮（纯工具模型 / 关掉思考 / 工具轮才是最后一轮）
 * 从没进过集合 → 收尾边沿收不掉它 → 轨迹**永远停在展开态**，用户看到的就是
 * 「模型答完了，工作过程还铺在那里不折叠」。收尾必须按"这一轮追加了哪些消息"来收，
 * 而不是按"哪些被打开过"。
 *
 * （2026-10-03 起按会话分桶：声明见 `displayBucketOf`。）
 */

/**
 * 这条消息的轨迹是否展开。
 *
 * 三条判据按优先级：
 * 1. 用户显式点开过 → 恒为真（跨轮保留）；
 * 2. 正在思考的那条（`thinkingTargetId`）→ 自动展开（否则推理藏在折叠的轨迹里看不见）；
 * 3. 其余按「有没有被登记为历史 / 已结束」：登记过 = 折叠，没登记过 = 展开。
 */
function traceOpen(message: ChatMessage): boolean {
  if (traceOpenedIds.has(message.id)) return true
  if (props.thinkingTargetId === message.id) return true
  return !historyFoldedIds.has(message.id)
}

/** 点击轨迹摘要行：翻转状态并在跟随态下重新贴底（展开体会长高一段）。 */
function toggleTrace(message: ChatMessage): void {
  if (traceOpen(message)) {
    // 收起：必须**同时登记为"已折叠"**。只把 id 从 `traceOpenedIds` 里删掉的话，
    // 第 3 条判据（没登记过 = 展开）会立刻又把它打开 —— 点了没反应。
    traceOpenedIds.delete(message.id)
    historyFoldedIds.add(message.id)
  } else {
    traceOpenedIds.add(message.id)
  }
  restick()
}

/**
 * 点思考块头：只翻转思考块自己的开合（轨迹容器不受影响），跟随态下重新贴底。
 */
function toggleThinkingAndStick(id: string): void {
  toggleThinking(id)
  restick()
}

/**
 * 点工具行头：只翻转这一行的展开体，跟随态下重新贴底。
 */
function toggleToolRow(id: string): void {
  toggle(id)
  restick()
}
/**
 * 把"当前这一批消息"里还没登记过的 id 按当前是否流式决定是否入 `historyFoldedIds`。
 *
 * 只在数组被整体替换时调用（首次挂载 / 切会话 / 清空后水合）：`streaming` 为 false 说明
 * 读到的是**历史**（默认折叠），为 true 说明替换发生在流式过程中（保持展开，边沿再收）。
 */
function markIncomingAsHistory(): void {
  if (props.streaming) return
  for (const message of props.messages) historyFoldedIds.add(message.id)
}

/**
 * 把**此刻在屏的消息**全部登记为"已折叠"。
 *
 * 两处调用，语义都是"这一批已经不是'正在跑的那条'了"：
 * - 新一轮开始时（`streaming` false → true）：这一刻之前出现的都是历史，
 *   之后追加的才是本轮（本轮不登记 → 默认展开）；
 * - 这一轮结束时（true → false）：把本轮追加的（= 到此刻还没登记过的）一并收起来。
 *
 * 幂等：已登记的重复 `add` 无副作用；用户显式点开的那些在 `traceOpen` 里优先级更高，
 * 因此不会被这条收掉（"用户点开就保持点开"）。
 */
function markPresentAsHistory(): void {
  for (const message of props.messages) historyFoldedIds.add(message.id)
}

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
 *
 * 同一条路径上关掉这一帧的进出场动画：替换过程中新旧两套消息会同时占位
 * （leave 只改透明度、不移出文档流），列表高度接近翻倍、滚动跟着跳两次（见 `swapping`）。
 * 复位放在 `nextTick`：要保证「这一帧的 patch」用的是关掉动画的配置，
 * 之后恢复，流式追加的逐条进场不受影响。
 *
 * 轨迹折叠状态机也挂在这条路径上（`markIncomingAsHistory`）：整表换进来的消息算**历史**，
 * 默认折叠；流式期间的新增消息不换数组引用，因此不会被登记成历史、默认展开。
 */
watch(
  () => props.messages,
  () => {
    swapping.value = true
    markIncomingAsHistory()
    void nextTick(() => {
      swapping.value = false
    })
    stick()
  },
)

/** 「回到最新」用平滑滚动，但尊重系统「减少动态效果」 */
function jumpToLatest(): void {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  stick(reduceMotion ? 'auto' : 'smooth')
}

/**
 * markdown 渲染结果按消息缓存。
 *
 * 键是消息对象本身（WeakMap：消息被丢弃后自动回收），只有 `content` 变了才重跑解析。
 *
 * ⚠️ 不要改回早先那种 `computed(() => messages.map((m) => ({ ...m, html: ... })))`：
 * `{ ...message }` 会把 `reasoning` 一起读成依赖，于是**每条思考增量都会让整份对话的
 * markdown 全量重解析**（增量 × transcript 长度）。本函数只读 `id` 与 `content`。
 */
const htmlCache = new WeakMap<ChatMessage, { content: string; html: string }>()

function htmlOf(message: ChatMessage): string {
  const cached = htmlCache.get(message)
  if (cached !== undefined && cached.content === message.content) return cached.html
  // 复制按钮的壳由渲染器直接产出（CODE_COPY_BUTTON 在 code-block 里），这里只做解析缓存
  const html = renderMarkdown(message.content)
  htmlCache.set(message, { content: message.content, html })
  return html
}

// ───────────────────────── 轨迹摘要 + 工具行：状态与耗时 ─────────────────────────

/**
 * 折叠态轨迹的摘要文案（如「已深度思考 · 3 步」）。
 *
 * 组成是有则显示、全无则退回「执行轨迹」：
 * - 有 `reasoning` 就给思考文案（运行中是「思考中…」，否则「已深度思考」）；
 * - 有工具调用就给「N 步」，其中失败的补一句「N 个失败」；
 * - 都不给（理论上不会发生：没有可折叠内容就不渲染轨迹）时给一个中性词。
 */
function traceSummary(message: ChatMessage): string {
  const parts: string[] = []
  if (props.showThinking && (message.reasoning ?? '') !== '') {
    parts.push(props.thinkingTargetId === message.id ? '思考中…' : THINKING_LABEL)
  }
  const calls = message.toolCalls ?? []
  if (calls.length > 0) {
    parts.push(`${calls.length} 步`)
    const failed = calls.filter((call) => call.state === 'error').length
    if (failed > 0) parts.push(`${failed} 个失败`)
  }
  return parts.length === 0 ? '执行轨迹' : parts.join(' · ')
}

/**
 * 这条消息有没有可折叠的轨迹内容：思考（受 `showThinking` 门控）或工具调用。
 * 两者都无则整块不渲染 —— 空轨迹行只是噪声。
 */
function hasTrace(message: ChatMessage): boolean {
  if ((message.toolCalls?.length ?? 0) > 0) return true
  return props.showThinking && (message.reasoning ?? '') !== ''
}

/** 整条轨迹是否仍在运行：还在思考，或还有工具没跑到终态 */
function traceRunning(message: ChatMessage): boolean {
  if (props.thinkingTargetId === message.id) return true
  return (message.toolCalls ?? []).some((call) => call.state === 'running')
}

/** 这条轨迹里有没有失败的工具调用（折叠胶囊的状态图标据此给红叉） */
function traceFailed(message: ChatMessage): boolean {
  return (message.toolCalls ?? []).some((call) => call.state === 'error')
}

/**
 * 一次工具调用的计时区间（毫秒）。**优先读持久时间戳**（`call.startedAt` / `call.endedAt`，
 * 内核随工具卡落盘）——切走再切回、重启后耗时仍是真实值；旧历史没有时间戳时才落到
 * 渲染层观察值（`timings`），两者都没有 → `undefined`（不伪造数据）。
 */
function callSpanOf(call: AgentToolCall): { start: number; end: number | null } | undefined {
  if (call.startedAt !== undefined) {
    const start = Date.parse(call.startedAt)
    if (Number.isFinite(start)) {
      if (call.endedAt === undefined) return { start, end: null }
      const endedAt = Date.parse(call.endedAt)
      return { start, end: Number.isFinite(endedAt) ? endedAt : null }
    }
  }
  return timings.get(call.id)
}

/**
 * 整条轨迹的耗时（折叠胶囊右侧，2026-10-01 重塑新增）：
 * 首个工具开始到末个工具结束（正在跑的按当前 tick 算）。
 * 计时来源见 `callSpanOf`（持久时间戳优先，本地观察兜底）；两者皆无 → 空串。
 */
function traceDuration(message: ChatMessage): string {
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const call of message.toolCalls ?? []) {
    const record = callSpanOf(call)
    if (record === undefined) continue
    start = Math.min(start, record.start)
    end = Math.max(end, record.end ?? nowTick.value)
  }
  if (start === Number.POSITIVE_INFINITY) return ''
  const seconds = Math.max(0, end - start) / 1000
  return seconds < 0.1 ? '<0.1s' : `${seconds.toFixed(1)}s`
}

/**
 * 工具行的探针锚点：todo / task 行各有一个，其余行不带（`undefined` 时 Vue 省略属性）。
 * 判定逻辑与 `AgentToolRow` 里的一致（解析失败即回落通用行）。
 */
function cardField(call: AgentToolCall): string | undefined {
  if (call.name === 'todo_write' && parseTodoWriteInput(call.input) !== null) {
    return 'chat.todo-card'
  }
  if (call.name === 'task' && parseTaskInput(call.input) !== null) return 'chat.task-card'
  return undefined
}

/**
 * 已展开的工具行 id（默认全部折叠，保持轨迹干净）。
 * （2026-10-03 起按会话分桶：声明见 `displayBucketOf`。）
 */

/**
 * 已经「翻到终态」并播放过确认动画的卡片 id。
 *
 * 一次性动画靠「类只加一次」实现：状态从 running 翻到 success/error 时把 id 记下来，
 * 之后即使组件重渲染也不会重放（`aurora-confirm` 在类存在期间只跑一次）。
 * （2026-10-03 起按会话分桶：声明见 `displayBucketOf`。）
 */

function isSettled(id: string): boolean {
  return settledIds.has(id)
}

function isOpen(id: string): boolean {
  return openedIds.value.includes(id)
}

function toggle(id: string): void {
  openedIds.value = isOpen(id)
    ? openedIds.value.filter((item) => item !== id)
    : [...openedIds.value, id]
}

/**
 * 本地兜底计时：**优先级低于**工具卡自带的持久时间戳（`call.startedAt` / `call.endedAt`，
 * 内核随工具卡落盘）——只有旧历史（没有时间戳的行）才落到这份观察值上，不伪造数据。
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
        // 状态刚翻到终态：记下来给状态点挂一次性确认动画（见 `settledIds`）
        settledIds.add(call.id)
        // 完成即自动折叠（用户口径 2026-09-29）：运行中展开看进度的卡片，
        // 翻到终态就没必要继续占着消息区——收起后只留一行结果摘要，点开仍可回看。
        // 历史水合的卡片不经过这条边沿（`record.end` 早已落定），不受影响。
        openedIds.value = openedIds.value.filter((id) => id !== call.id)
      } else if (record === undefined) {
        // 历史水合出来的卡片本就没有计时记录：不伪造耗时，也不放确认动画
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

/**
 * 图表水合器（P2）：挂在本组件的消息根容器上，负责把 ```mermaid / ```echarts 的占位
 * 渲染成真图（懒加载 + 按源码缓存 + 进入视口才渲染，见 hydrate.ts 的失效分析）。
 *
 * 主题与 CSS 同源：桌面端主题由 `nativeTheme.themeSource` 落到 `prefers-color-scheme`，
 * 没有 data-theme 属性 —— 这里读 media query（已渲染的图不重绘；切换主题后新出现的图
 * 用新主题，与截图探针的双主题场景一致）。
 */
let chartHydrator: ChartHydrator | null = null

function currentTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

onMounted(() => {
  // 挂载后补一次对齐：视口是窗口的 `.thread`，首帧拿到容器尺寸前那次滚动可能不生效
  refreshStick()
  if (rootEl.value !== null) {
    chartHydrator = createChartHydrator(rootEl.value, { theme: currentTheme })
  }
})

onUnmounted(() => {
  if (ticker !== null) window.clearInterval(ticker)
  ticker = null
  // 思考侧的两笔在途资源：合并滚动用的 rAF 与读秒 interval，卸载时都必须收掉
  if (thinkingFrame !== null) window.cancelAnimationFrame(thinkingFrame)
  thinkingFrame = null
  stopThinkingTimer()
  chartHydrator?.dispose()
  chartHydrator = null
})

/**
 * 本次调用的耗时文案。计时来源见 `callSpanOf`：持久时间戳优先（历史水合的行
 * 现在也能显示真实耗时），本地观察兜底；两者皆无 → 空串（不伪造数据）。
 */
function toolDuration(call: AgentToolCall): string {
  const record = callSpanOf(call)
  if (record === undefined) return ''
  const end = record.end ?? nowTick.value
  const seconds = Math.max(0, end - record.start) / 1000
  return seconds < 0.1 ? '<0.1s' : `${seconds.toFixed(1)}s`
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
  // 只换标签与图标，不动按钮结构（图标是字符串内联的 SVG）
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
</script>

<template>
  <!--
    消息区的**可访问性**（2026-09-29 调研后补，docs/07 §5.4）：
    `aria-live="polite"` + `aria-atomic="false"` 让读屏器在不打断用户的前提下播报新增内容；
    流式期间另加 `aria-busy="true"`、收尾翻回 false —— 这是**逐 token 播报**之外唯一正确的做法
    （逐 token 会把读屏器刷爆，`assertive` 更会打断用户正在听的一切）。
    live 区挂在**常驻的消息区根容器**上而不是每条气泡上：live 区必须先存在于 DOM、内容后注入，
    否则读屏器看不到"新增"这件事本身。
  -->
  <div
    ref="rootEl"
    class="messages"
    aria-live="polite"
    aria-atomic="false"
    :aria-busy="streaming"
    :data-field="'chat.messages'"
    @click="onContentClick"
  >
    <div v-if="messages.length === 0" class="empty anim-rise">
      <span class="empty-orb" aria-hidden="true" />
      <p class="empty-title">开始对话</p>
      <p class="empty-hint tiny muted">{{ emptyHint }}</p>
    </div>

    <!--
      整表替换（切会话 / 水合 / 清空）时 `swapping` 为真 → `:css="false"` 临时关掉进出场：
      否则被换掉的消息会以「只改透明度、不脱离文档流」的方式占位 250ms，与新消息同时存在。
    -->
    <TransitionGroup name="rise" :css="!swapping">
      <article
        v-for="message in messages"
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
          <!--
            **执行轨迹**（2026-09-30 轨迹视觉重构，docs/07 §2.3）：一条助手消息的
            「思考 + 工具调用」收进一个容器 —— 折叠态是一行摘要（`AgentTrace` 的一行），
            展开态是左缘竖脊 + 节点圆点。

            折叠态下思考块与工具行**仍然在 DOM 里**（只被 CSS 藏起来），这不是疏漏：
            思考块自己的开合（`.thinking-head` → `.thinking-body`）与轨迹的开合是两个
            独立状态，`capture` 与「高密度爆发」两组探针都要能读到折叠态的 `.thinking-head`
            文案（含「已深度思考」）与 `.thinking.streaming .thinking-text` —— 整块 `v-if`
            会让那两条断言在折叠态直接失效。位置仍在正文`.md`**之前**（探针按 DOM 先后断言）。
          -->
          <AgentTrace
            v-if="message.role === 'assistant' && hasTrace(message)"
            :open="traceOpen(message)"
            :summary="traceSummary(message)"
            :running="traceRunning(message)"
            :failed="traceFailed(message)"
            :duration="traceDuration(message)"
            @toggle="toggleTrace(message)"
          >
            <!--
              思考过程折叠块（BetaV2）：受 `showThinking`（general.chat.showThinking）门控，
              关闭时整块不渲染。文案恒为「已深度思考」（`thinkingLabel` 的注释说明了原因），
              「思考中…」只在轨迹摘要行里出现。
            -->
            <div
              v-if="showThinking && (message.reasoning ?? '') !== ''"
              class="thinking"
              :class="[
                { open: isThinkingOpen(message.id), streaming: thinkingTargetId === message.id },
              ]"
              :data-field="thinkingTargetId === message.id ? 'chat.thinking-live' : undefined"
            >
              <button
                type="button"
                class="thinking-head"
                :aria-expanded="isThinkingOpen(message.id)"
                @click="toggleThinkingAndStick(message.id)"
              >
                <!--
                  流式期间的一枚**公转指示点**（旋转，不是轨迹那条横向平移扫光）：
                  旋转由全局 `.spin`（`aurora-spin` + `--dur-spin`）提供 —— scoped 里的
                  @keyframes 会被 Vue 改名，跨组件复用的关键帧必须走全局样式。
                  `prefers-reduced-motion` 由 theme.css 文末的全局兜底压掉（转 1 次即停）。
                  chevron 统一挂行尾 —— 与工具行 / 轨迹胶囊同一套行语言（2026-10-01 重塑）。
                -->
                <span
                  v-if="thinkingTargetId === message.id"
                  class="think-orbit spin"
                  aria-hidden="true"
                />
                <span class="tiny thinking-label">{{ thinkingLabel() }}</span>
                <!-- 已思考的秒数：只在流式接收思考期间出现，结束后回到纯「已深度思考」文案 -->
                <span v-if="thinkingTargetId === message.id" class="tiny thinking-elapsed">
                  {{ thinkingSeconds }}s
                </span>
                <span class="grow" />
                <ChevronRight class="chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <!--
                思考正文一律走**纯淡入**（`fade`），不做高度动画。
                原因：这块内容在流式期间会以 token 速率持续长高，而高度动画的终点是
                「点开那一刻量到的高度」，过渡期间 `.collapse-*-active` 的 `overflow: hidden`
                会把后长出来的部分裁掉 —— 过渡类一摘就是一次可见的补跳
                （docs/07 §5.2 硬约定②）。轨迹容器同理。
              -->
              <Transition name="fade">
                <div v-if="isThinkingOpen(message.id)" class="thinking-body">
                  <!-- 流式期间尾部带光标，读起来是"还在写"而不是"卡住了" -->
                  <p class="thinking-text" @scroll.passive="onThinkScroll">
                    {{ message.reasoning }}
                  </p>
                  <span
                    v-if="thinkingTargetId === message.id"
                    class="streaming-caret thinking-caret"
                    aria-hidden="true"
                  />
                </div>
              </Transition>
            </div>

            <!-- 工具执行行：todo_write / task 有结构化行首，其余为通用行（docs/06 §5） -->
            <TransitionGroup
              v-if="(message.toolCalls?.length ?? 0) > 0"
              name="tool"
              tag="div"
              class="tools"
            >
              <AgentToolRow
                v-for="call in message.toolCalls"
                :key="call.id"
                :call="call"
                :open="isOpen(call.id)"
                :settled="isSettled(call.id)"
                :duration="toolDuration(call)"
                :data-field="cardField(call)"
                @toggle="toggleToolRow(call.id)"
              />
            </TransitionGroup>
          </AgentTrace>
          <span v-if="message.pending && message.content === ''" class="typing">
            <i /><i /><i />
          </span>
          <!-- 安全说明：内容先经 renderMarkdown 转义，再套用白名单标记（见 shared/markdown.ts） -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else-if="message.content !== ''" class="md" v-html="htmlOf(message)" />
          <DisplayImageGallery
            v-if="displayImagesOf(message).length > 0"
            :images="displayImagesOf(message)"
            :session-id="props.sessionId"
          />

          <!--
            朗读按钮（docs/06 §13）：正文之后。
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
            <!-- 合成中给个旋转指示：按钮是 disabled 的，不动的话看不出还在等 -->
            <LoaderCircle
              v-if="isTtsLoading(message.id)"
              class="spin"
              :size="12"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            <Square
              v-else-if="isSpeaking(message.id)"
              :size="11"
              :stroke-width="2"
              aria-hidden="true"
            />
            <Volume2 v-else :size="12" :stroke-width="1.8" aria-hidden="true" />
            {{ speakLabel(message) }}
          </button>
        </div>
      </article>
    </TransitionGroup>
    <slot />

    <!--
      用户上滚后（`following === false`）才出现的回底入口：跟随中不显示，
      既不遮挡最后一条消息，也不改变"自动到底"的默认体验。
    -->
    <button v-if="!following" type="button" class="jump-latest anim-pop" @click="jumpToLatest">
      <ArrowDown :size="13" :stroke-width="2" aria-hidden="true" />
      回到最新
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  color: var(--on-accent);
  font-weight: var(--weight-semibold);
}

.bubble {
  min-width: 0;
  max-width: 78%;
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  word-break: break-word;
}

/* 用户气泡：强调色浅填充（iMessage 语义：这是「我」说的话），无重描边 */
.r-user .bubble {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--aurora-blue) 20%, transparent);
  color: var(--text-primary);
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  border-color: var(--accent-text);
  color: var(--accent-text);
}

.speak-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

/*
 * 轨迹展开体的开合动画（`.trace-body` 在 `AgentTrace` 的子组件里，属 deep）。
 *
 * 2026-10-01 起动画本体是 **grid `0fr ↔ 1fr` 高度过渡**，实现在 `AgentTrace.vue` 自己的
 * scoped 样式里（`.trace-clip`）；这里曾经挂过 `opacity` 过渡补"淡入观感"—— `display`
 * 翻转（旧 `v-show`）不会触发过渡、grid 折叠也不再摘 `display`，这条规则已经没有作用对象，
 * 删掉防止后人照着它再挂一层（动画口径见 docs/07 §5.2 硬约定②与 §2.3「执行轨迹」）。
 */

/* ── 思考过程折叠块（BetaV2）：轨迹里的第一个节点 ── */
/*
 * 思考块（2026-09-30 轨迹重构）：层级由**外层轨迹容器**承担（折叠时一行摘要、
 * 展开时左缘竖脊 + 节点圆点）。因此这里不再自画左侧竖轨与缩进
 * （`padding-left: var(--space-3)` + `border-left`），只作为竖脊上的第一个节点：
 * 左侧让出与工具行一致的一档，让圆点/竖脊与整条轨迹对齐。
 *
 * 折叠态下由外层 `.trace.is-collapsed` 的规则整块 `display: none`（**不是** `v-if`）——
 * 思考块自己的开合状态与轨迹的开合是两个独立状态，探针要在折叠态读到
 * 「已深度思考」文案与 `.thinking.streaming .thinking-text`（见模板里的说明）。
 */
.thinking {
  position: relative;
  padding-left: 20px;
  background: transparent;
}

.thinking-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  /* 28px：与工具行同一档（2026-10-01 重塑统一行语言），命中区同步达标 */
  min-height: 28px;
  padding: 4px 0 4px 2px;
  border-radius: var(--radius-xs);
  text-align: left;
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

/*
 * 思考块在轨迹里的节点圆点：骑在轨迹竖脊上（与 `AgentToolRow` 的 `.tool-card::before`
 * 同一套几何：left 4px + 7px 直径 = 中心 7.5px，竖脊在 7px）。
 */
.thinking::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 10.5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  box-shadow: 0 0 0 3px var(--bg-base);
  transition: background var(--transition-fast);
}

/* 流式接收中：节点与块头文案都转强调色（块头动效只有那一枚公转点） */
.thinking.streaming {
  color: var(--accent-text);
}

.thinking.streaming::before {
  background: var(--accent-text);
}

/*
 * 轨迹**折叠态**下思考块与工具行的隐藏，2026-10-01 起由 `AgentTrace` 的 grid `0fr` 轨道
 * 统一承担（展开体收成零高度、内层 `overflow: hidden`），这里不再需要 `visibility: hidden`
 * 与 `position: absolute` 的两条覆盖 —— 它们反而会在展开动画期间打架
 * （轨道还在 1fr 的过渡里，子项已经被拽出文档流）。锚点契约不变：折叠态
 * `.thinking-head` 文案与 `.tool-card` 计数仍可读（元素只是被裁剪，没有离开 DOM）。
 */

/* 悬停铺 `--fill-1`（与工具行同一套行语言；它是可点的展开行，affordance 该有） */
.thinking-head:hover {
  background: var(--fill-1);
  color: var(--text-secondary);
}

/* 流式接收中：用强调色点明「思考还没结束」 */
.thinking.streaming > .thinking-head {
  color: var(--accent-text);
}

.thinking.open > .thinking-head {
  color: var(--text-secondary);
}

.thinking.streaming.open > .thinking-head {
  color: var(--accent-text);
}

.thinking.open > .thinking-head .chevron {
  transform: rotate(90deg);
}

/*
 * 流式期间的公转指示点：一枚低对比度的环 + 环上一枚绕心旋转的点。
 * 旋转走全局 `.spin`（`aurora-spin` + `--dur-spin`），与工具卡运行中的**横向扫光**
 * 是两种不同机制（旋转 vs 平移），同屏出现不会看成同一个东西。
 */
.think-orbit {
  position: relative;
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent-text) 32%, transparent);
}

.think-orbit::after {
  content: '';
  position: absolute;
  top: -1px;
  left: 50%;
  width: 3px;
  height: 3px;
  margin-left: -1.5px;
  border-radius: 50%;
  background: var(--accent-text);
}

/*
 * 秒数：颜色继承块头（流式时块头是强调色，见 `.thinking.streaming > .thinking-head`），
 * 只固定数字宽度 —— 每秒跳动时宽度不变，块头文字不会跟着左右抖。
 */
.thinking-elapsed {
  font-variant-numeric: var(--num-tabular);
}

.thinking-body {
  position: relative;
  padding: 2px 0 var(--space-1);
}

/* 长思考滚动查看，不把回答顶出可视区 */
.thinking-text {
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  /* 无底色无内框：旁注靠竖轨与缩进区分层级，不再叠一层灰（盒中盒是"挤"的主因） */
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 光标贴在滚动区右下角：正文在滚，光标始终可见 */
.thinking-caret {
  position: absolute;
  right: var(--space-4);
  bottom: var(--space-3);
  color: var(--accent-text);
}

/* ── 轨迹里的工具行（docs/06 §5）：行本身的样式在 `AgentToolRow.vue` ── */
.tools {
  display: flex;
  flex-direction: column;
  /* 2px：一屏要能连着读 3-5 行（"做过一串事"），行距按行高走，不再按卡片间距走 */
  gap: 2px;
  margin-top: var(--space-1);
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

/*
 * 工具行进场（TransitionGroup name="tool"）：轻微上浮 + 淡入。
 * 比消息气泡的 `rise` 更短更轻 —— 一轮里可能连续长出好几行，
 * 动作太重会让消息区像在"跳"。
 */
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
 * 同一批行错开 40ms 出现（`.tools` 里的第 2、3… 行）。
 * 必须挂在 enter / leave 的 active 类下：`transition-delay` 是**常驻生效**的，
 * 只写 `.tool-card:nth-child(2)` 会让这行上此后任何过渡都晚 40ms 起步（误伤别的动效）。
 * 选择器按**子组件根节点**（`.tool-card`）匹配：scoped 的 `[data-v]` 与子组件根上的
 * 父 scope id 同时命中，与这些类在其他组件上的用法一致。
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

.typing i:nth-child(2) {
  animation-delay: 0.15s;
}

.typing i:nth-child(3) {
  animation-delay: 0.3s;
}

/* ── Markdown ──
   .md-* 全部样式已抽到共享的 md.css（@aurora/shared/browser/markdown/md.css，
   脚本里 import 引入）：桌面与 Center Web 单源，选择器挂在 .md 容器下，
   配色经 --md-* 局部变量映射到主题令牌。这里不再重复声明。 */
</style>
