<script setup lang="ts">
/**
 * 消息列表（对话窗的消息流）。
 *
 * 视觉（docs/07 §5）：用户消息右对齐胶囊气泡，助手消息左对齐纯文本块（Apple 风格：不套气泡），
 * 代码块单独成卡并带 hover 显隐的「复制」；工具执行卡片默认折叠，展开走 `.collapse-*`。
 * props / 插槽契约：`messages`（消息数组）+ `emptyHint`（空状态提示语）。
 *
 * BetaV2 追加：
 * - 「思考过程」折叠块（`message.reasoning`，受 `showThinking` 门控）：流式中有新思考时
 *   自动展开（`thinkingTargetId`），请求结束后收起为「已深度思考」摘要行，手动可开合；
 * - `generate_image` 工具卡成功态渲染图片预览（`imagegen:read` 换 dataUrl，
 *   提取 / 读取失败维持纯文本，绝不阻塞消息流）。
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
 */
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import type { AgentToolCall } from '@aurora/shared'
import type { ChatMessage } from '../composables/useChat.js'
import { useStickToBottom } from '../composables/useStickToBottom.js'
import { useCollapseTransition } from '../composables/useCollapseTransition.js'
import { renderMarkdown } from '../markdown.js'
import { parseTaskInput, parseTodoWriteInput, type TodoRow } from '../agentTodo.js'
import { toolIconOf } from '../toolIcons.js'
import { ArrowDown, ChevronRight, FilePenLine, LoaderCircle, Square, Volume2 } from '../icons.js'
import AgentTodoList from './AgentTodoList.vue'
import AppTooltip from './AppTooltip.vue'
import StatusDot from './StatusDot.vue'
import SubagentConversation from './SubagentConversation.vue'

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
  }>(),
  {
    emptyHint: '开始一段对话吧',
    ttsAvailable: false,
    speakingId: null,
    ttsLoadingId: null,
    streaming: false,
    showThinking: true,
    thinkingTargetId: null,
  },
)

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
 * 已展开「思考过程」的消息 id（默认收起；流式期间由 `thinkingTargetId` 自动展开）。
 * 历史水合出的 reasoning 默认折叠为「已深度思考」摘要行，点开可看全文。
 */
const thinkingOpen = ref<string[]>([])

function isThinkingOpen(id: string): boolean {
  return thinkingOpen.value.includes(id)
}

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
 * 1. 目标清成 null（正文开始写 = 这一轮思考结束）→ 停表；**块保持展开**，
 *    只换文案与动效类，收起留给请求结束时的 `streaming` 边沿（状态切换不闪）；
 * 2. 目标被指到 → 展开该块，并滚到块内最新一行（DOM 下一帧才存在）；
 * 3. 目标被指到 → 开始（或重启）本轮思考的读秒。
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
 * 请求结束（streaming true → false 边沿）把已展开的思考块收起为摘要行：
 * 完整内容仍可手动点开，但默认视图回到「回答优先」。
 * 同一条路径上兜底停表：正常收尾 `useChat` 会先清 `thinkingTargetId`（上面已停过），
 * 但出错 / 目标未被清时也不许留下定时器。
 */
watch(
  () => props.streaming,
  (now, before) => {
    if (before !== true || now !== false) return
    thinkingOpen.value = []
    stopThinkingTimer()
  },
)

/** 摘要行文案：正在接收思考 → 「思考中…」；已完成 → 「已深度思考」 */
function thinkingLabel(message: ChatMessage): string {
  return props.thinkingTargetId === message.id ? '思考中…' : '已深度思考'
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
 */
const { following, stick } = useStickToBottom(() => rootEl.value)

/**
 * 展开 / 收起一律走实测高度（终点写进 `--collapse-h`，见 docs/07 §2.3 / §5.2）。
 * 进入方向挂 `@enter`（**不是** `@before-enter`）：Vue 的 `beforeEnter` 在元素插入文档之前调用，
 * 游离元素的 `scrollHeight` 恒为 0，会把终点钉成 0（展开变成「冻结再瞬跳」）。
 */
const { enter: collapseEnter, beforeLeave: collapseLeave } = useCollapseTransition()

/**
 * 整表被替换（历史水合 / 切会话 / 清空）的那一帧关掉进出场动画。
 *
 * `<TransitionGroup name="rise">` 的 leave 只改 opacity / transform，被换掉的消息在
 * 250ms 内**仍然占位**，而新消息同时进场 —— 列表高度瞬时接近翻倍，滚动条跟着跳两次。
 * 整表替换本来就是「内容整体换掉」，不需要「一条条浮现」的语义；流式追加不换数组引用，
 * 因此仍然保留逐条进场动画。
 */
const swapping = ref(false)

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
 */
watch(
  () => props.messages,
  () => {
    swapping.value = true
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
 * 代码块「复制」按钮。
 *
 * `markdown.ts` 的输出形状固定（先转义再套白名单标记），这里只在渲染结果上补一层结构：
 * `<pre class="md-code">` 外包一层定位容器并塞入按钮。转义保证了代码正文里不可能出现
 * 字面量 `</pre>`，因此按标记切分是安全的；不引入依赖、也不改 `markdown.ts` 的输出契约。
 *
 * 图标是 lucide 的 `Copy` / `Check` 路径原样内联：这枚按钮由**字符串**注入到 markdown
 * 输出里（不是模板节点），用不了组件；形状与其余图标一致，改图标时两处一起改。
 */
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
const COPY_BUTTON = `<button type="button" class="code-copy" aria-label="复制代码">${ICON_COPY}<span class="code-copy-label">复制</span></button>`

function withCodeCopy(html: string): string {
  return html
    .replace(
      /<pre class="md-code">/g,
      `<div class="code-block">${COPY_BUTTON}<pre class="md-code">`,
    )
    .replace(/<\/pre>/g, '</pre></div>')
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
  const html = withCodeCopy(renderMarkdown(message.content))
  htmlCache.set(message, { content: message.content, html })
  return html
}

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

/**
 * `todo_write` 的结构化视图（docs/07 §2.3）：能解析出条目时工具卡升级为任务清单卡，
 * 返回 null（参数畸形 / 非 todo_write）则回落通用工具卡——绝不因模型输出畸形而丢卡片。
 */
function todosOf(call: AgentToolCall): TodoRow[] | null {
  if (call.name !== 'todo_write') return null
  return parseTodoWriteInput(call.input)
}

/** `task` 的结构化视图：卡头显示任务简述，展开体显示完整指令 */
function taskOf(call: AgentToolCall) {
  if (call.name !== 'task') return null
  return parseTaskInput(call.input)
}

/** 工具卡的探针锚点：todo / task 卡各有一个，其余卡不带（`undefined` 时 Vue 省略属性） */
function cardField(call: AgentToolCall): string | undefined {
  if (todosOf(call) !== null) return 'chat.todo-card'
  if (taskOf(call) !== null) return 'chat.task-card'
  return undefined
}

/** 工具语义图标（docs/07 §5）：读文件 / 跑命令 / 派子代理一眼可分，未知工具走兜底 */
function toolIcon(call: AgentToolCall) {
  return toolIconOf(call.name)
}

/** 子代理卡头显示步骤数（`task` 以外的卡返回 null，不渲染该段） */
function subagentStepCount(call: AgentToolCall): number | null {
  if (call.subagent === undefined) return null
  return call.subagent.steps.length
}

/**
 * 卡片里那枚子代理快照：仅 `task` 卡有。用来渲染实时轨迹与报告。
 */
function subagentOf(call: AgentToolCall) {
  return call.subagent ?? null
}

/**
 * 子代理被授予的写权限（2026-09，docs/06 §19）：只有 `write` 才在卡头上显示徽章
 * —— 只读是缺省，逐个卡都挂个「只读」只是噪音。徽章的悬浮提示列出**实际**拿到的工具名。
 */
function subagentWriteGranted(call: AgentToolCall): boolean {
  return call.subagent?.permission === 'write'
}

function subagentToolsHint(call: AgentToolCall): string {
  const tools = call.subagent?.tools ?? []
  return tools.length === 0 ? '' : `可用工具：${tools.join('、')}`
}

// ───────────────────────── 工具卡片：折叠态 + 耗时 ─────────────────────────

/** 已展开的卡片 id（默认全部折叠，保持消息区干净） */
const openedIds = ref<string[]>([])

/**
 * 已经「翻到终态」并播放过确认动画的卡片 id。
 *
 * 一次性动画靠「类只加一次」实现：状态从 running 翻到 success/error 时把 id 记下来，
 * 之后即使组件重渲染也不会重放（`aurora-confirm` 在类存在期间只跑一次）。
 */
const settledIds = reactive(new Set<string>())

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
        // 状态刚翻到终态：记下来给状态点挂一次性确认动画（见 `settledIds`）
        settledIds.add(call.id)
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

// ───────────────────── 生图工具卡：图片预览（BetaV2） ─────────────────────

/**
 * `generate_image` 成功后从 `outputSummary`（形如「已保存到 <路径>」）提取落盘路径。
 * 正则刻意宽容（冒号可有可无、允许句号收尾），提取失败就维持纯文本，不阻塞消息流。
 */
function extractGeneratedImagePath(outputSummary: string | undefined): string | null {
  if (outputSummary === undefined) return null
  const match = outputSummary.match(/已保存到[:：]?\s*(.+?)\s*[。.]?\s*$/)
  const path = match?.[1]?.trim() ?? ''
  return path === '' ? null : path
}

function isGeneratedImage(call: AgentToolCall): boolean {
  return call.name === 'generate_image' && call.state === 'success'
}

/** call.id → dataUrl；空串表示已尝试但失败（不再重试），缺项表示尚未尝试 */
const imagePreviews = reactive(new Map<string, string>())

async function loadImagePreview(callId: string, filePath: string): Promise<void> {
  try {
    const result = await window.aurora.imagegen.read({ filePath })
    imagePreviews.set(callId, result.ok ? result.value.dataUrl : '')
  } catch {
    imagePreviews.set(callId, '')
  }
}

/** 该工具卡的预览 dataUrl；未加载 / 加载失败都返回 undefined（卡片维持纯文本） */
function imagePreviewFor(call: AgentToolCall): string | undefined {
  const dataUrl = imagePreviews.get(call.id)
  return dataUrl === undefined || dataUrl === '' ? undefined : dataUrl
}

/** 与耗时统计共用同一签名（call id + state）：卡片翻到 success 时触发一次加载 */
watch(toolSignature, () => {
  for (const message of props.messages) {
    for (const call of message.toolCalls ?? []) {
      if (!isGeneratedImage(call) || imagePreviews.has(call.id)) continue
      const filePath = extractGeneratedImagePath(call.outputSummary)
      if (filePath === null) {
        imagePreviews.set(call.id, '')
        continue
      }
      void loadImagePreview(call.id, filePath)
    }
  }
})

onUnmounted(() => {
  if (ticker !== null) window.clearInterval(ticker)
  ticker = null
  // 思考侧的两笔在途资源：合并滚动用的 rAF 与读秒 interval，卸载时都必须收掉
  if (thinkingFrame !== null) window.cancelAnimationFrame(thinkingFrame)
  thinkingFrame = null
  stopThinkingTimer()
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
  <div ref="rootEl" class="messages" @click="onContentClick">
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
            思考过程折叠块（BetaV2）：受 `showThinking`（general.chat.showThinking）门控，
            关闭时整块不渲染。流式接收中自动展开、请求结束后收起为「已深度思考」摘要行，
            手动可开合；位置在正文上方（docs/07 §2.3）。
          -->
          <div
            v-if="showThinking && message.role === 'assistant' && (message.reasoning ?? '') !== ''"
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
              @click="toggleThinking(message.id)"
            >
              <ChevronRight class="chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
              <!--
                流式期间的一枚**公转指示点**（旋转，不是工具卡那种横向平移扫光）：
                旋转由全局 `.spin`（`aurora-spin` + `--dur-spin`）提供 —— scoped 里的
                @keyframes 会被 Vue 改名，跨组件复用的关键帧必须走全局样式。
                `prefers-reduced-motion` 由 theme.css 文末的全局兜底压掉（转 1 次即停）。
              -->
              <span
                v-if="thinkingTargetId === message.id"
                class="think-orbit spin"
                aria-hidden="true"
              />
              <span class="tiny thinking-label">{{ thinkingLabel(message) }}</span>
              <!-- 已思考的秒数：只在流式接收思考期间出现，结束后回到纯「已深度思考」文案 -->
              <span v-if="thinkingTargetId === message.id" class="tiny thinking-elapsed">
                {{ thinkingSeconds }}s
              </span>
            </button>
            <!--
              正在接收这一轮思考时用**纯淡入**（`fade`），不做高度动画。
              原因：这时内容正以 token 速率持续长高，而高度动画的终点是「点开那一刻量到的高度」，
              过渡期间 `.collapse-*-active` 的 `overflow: hidden` 会把后长出来的部分裁掉 ——
              过渡类一摘就是一次可见的补跳。**思考块的自动展开恰好落在这个场景**
              （流式一开始就展开），所以这里必须走淡入。
              内容已经稳定（历史块手动点开）时才用实测高度动画，那时终点是准的。
            -->
            <Transition
              :name="thinkingTargetId === message.id ? 'fade' : 'collapse'"
              @enter="collapseEnter"
              @before-leave="collapseLeave"
            >
              <div v-if="isThinkingOpen(message.id)" class="thinking-body">
                <!-- 流式期间尾部带光标，读起来是"还在写"而不是"卡住了" -->
                <p class="thinking-text" @scroll.passive="onThinkScroll">{{ message.reasoning }}</p>
                <span
                  v-if="thinkingTargetId === message.id"
                  class="streaming-caret thinking-caret"
                  aria-hidden="true"
                />
              </div>
            </Transition>
          </div>
          <span v-if="message.pending && message.content === ''" class="typing">
            <i /><i /><i />
          </span>
          <!-- 安全说明：内容先经 renderMarkdown 转义，再套用白名单标记（见 shared/markdown.ts） -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else-if="message.content !== ''" class="md" v-html="htmlOf(message)" />

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

          <!-- 工具执行卡片：todo_write / task 有结构化卡头，其余为通用卡（docs/06 §5） -->
          <TransitionGroup
            v-if="(message.toolCalls?.length ?? 0) > 0"
            name="tool"
            tag="div"
            class="tools"
          >
            <article
              v-for="call in message.toolCalls"
              :key="call.id"
              class="tool-card"
              :class="[
                `t-${call.state}`,
                { open: isOpen(call.id), running: call.state === 'running' },
              ]"
              :data-field="cardField(call)"
            >
              <button
                type="button"
                class="tool-head"
                :aria-expanded="isOpen(call.id)"
                @click="toggle(call.id)"
              >
                <span class="tool-dot" :class="{ confirm: isSettled(call.id) }">
                  <StatusDot
                    :tone="toolTone(call.state)"
                    :size="6"
                    :title="toolStateLabel(call.state)"
                  />
                </span>
                <!-- 工具语义图标：读文件 / 跑命令 / 派子代理一眼可分 -->
                <component
                  :is="toolIcon(call)"
                  class="tool-icon"
                  :size="13"
                  :stroke-width="1.7"
                  aria-hidden="true"
                />
                <!-- 任务清单卡头：固定标题 + 条目数（结构化清单常驻卡身） -->
                <template v-if="todosOf(call)">
                  <span class="tool-title">任务清单</span>
                  <span class="tiny muted">{{ todosOf(call)!.length }} 项</span>
                </template>
                <!-- 子代理卡头：任务简述（入参 description）+ 已跑步骤数 -->
                <template v-else-if="taskOf(call)">
                  <span class="tool-title">
                    {{
                      taskOf(call)!.description.trim() !== '' ? taskOf(call)!.description : '子代理'
                    }}
                  </span>
                  <!-- 授予了写权限才显示（只读是缺省）：一眼知道这个子代理能改文件 -->
                  <AppTooltip v-if="subagentWriteGranted(call)" :text="subagentToolsHint(call)">
                    <span class="tiny perm-badge">
                      <FilePenLine :size="11" :stroke-width="1.8" aria-hidden="true" />
                      可读写
                    </span>
                  </AppTooltip>
                  <span class="tiny tool-state-label">{{ toolStateLabel(call.state) }}</span>
                  <span v-if="subagentStepCount(call) !== null" class="tiny muted tool-time">
                    {{ subagentStepCount(call) }} 步
                  </span>
                </template>
                <!-- 通用卡头：工具名 + 状态 -->
                <template v-else>
                  <span class="mono tiny tool-name">{{ call.name }}</span>
                  <span class="tiny tool-state-label">{{ toolStateLabel(call.state) }}</span>
                </template>
                <span v-if="toolDuration(call) !== ''" class="tiny muted tool-time">
                  {{ toolDuration(call) }}
                </span>
                <span class="grow" />
                <ChevronRight class="chevron" :size="14" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <!--
                结构化任务清单（todo_write）：常驻卡身（不折叠就能看到清单状态），
                点击卡头展开的仍是原始参数 / 结果。解析失败时这里不渲染，回落纯卡头。
              -->
              <AgentTodoList
                v-if="todosOf(call)"
                :todos="todosOf(call)!"
                dense
                class="tool-todos"
              />
              <!--
                生图预览（BetaV2）：成功卡片直接展示图片（懒加载、固定宽高比 + object-fit
                cover 防加载抖动）。路径提取失败 / imagegen:read 失败时不渲染，
                卡片维持「已保存到 …」纯文本。
              -->
              <img
                v-if="isGeneratedImage(call) && imagePreviewFor(call) !== undefined"
                class="tool-image"
                :src="imagePreviewFor(call)"
                alt="生成的图片"
                loading="lazy"
              />
              <Transition name="collapse" @enter="collapseEnter" @before-leave="collapseLeave">
                <div v-if="isOpen(call.id)" class="tool-body">
                  <!--
                    子代理卡：**独立对话视图**（2026-09，docs/06 §19 / docs/07 §2.3）。
                    展开体里直接给完整对话（任务指令 → 正文 → 工具调用与结果 → 最终报告），
                    与「子代理」页面用的是同一个组件；此前的紧凑轨迹（`SubagentTrace`）
                    在卡里与它信息重复，改为只在页面上出现（那里还有进度条与总体信息）。
                  -->
                  <template v-if="subagentOf(call)">
                    <span class="tiny muted tool-label">对话</span>
                    <SubagentConversation :snapshot="subagentOf(call)!" />
                  </template>
                  <span class="tiny muted tool-label">参数</span>
                  <pre class="mono tool-args">{{ prettyInput(call.input) }}</pre>
                  <span class="tiny muted tool-label">结果</span>
                  <p class="tool-output">{{ call.outputSummary ?? toolStateLabel(call.state) }}</p>
                </div>
              </Transition>
            </article>
          </TransitionGroup>
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

/* ── 思考过程折叠块（BetaV2）：正文上方的次要信息，视觉上刻意退后一档 ── */
.thinking {
  position: relative;
  margin-bottom: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  overflow: hidden;
}

/* 流式接收中：一条低对比度亮带在卡头扫过，明确「还在思考」 */
.thinking.streaming::after {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: var(--aurora-gradient);
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
  pointer-events: none;
}

.thinking-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: 4px 10px;
  text-align: left;
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.thinking-head:hover {
  background: var(--fill-2);
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
  padding: 0 var(--space-3) var(--space-2);
}

/* 长思考滚动查看，不把回答顶出可视区 */
.thinking-text {
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  padding: var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--fill-2);
  color: var(--text-secondary);
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
  position: relative;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  overflow: hidden;
}

/*
 * 运行中的卡片：一层低对比度扫光自左向右反复划过（`.shimmer` 在 theme.css）。
 * 不用旋转指示器：卡片已经有状态点，扫光只负责表达「这里在动」。
 */
.tool-card.running::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--aurora-blue) 10%, transparent),
    transparent
  );
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
  pointer-events: none;
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

/* 状态点外面套一层：翻到终态时整枚弹一下（一次性，见 settledIds） */
.tool-dot {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 10px;
}

.tool-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.t-running .tool-icon {
  color: var(--aurora-blue);
}

.t-success .tool-icon {
  color: color-mix(in srgb, var(--status-ok) 75%, var(--text-muted));
}

.t-error .tool-icon {
  color: var(--status-error);
}

.tool-name {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

/* 结构化卡头标题（任务清单 / 子代理）：比 mono 工具名更像「一条内容」 */
.tool-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

/* 常驻卡身的结构化清单（todo_write）：与卡头留出层次 */
.tool-todos {
  padding: 0 var(--space-3) var(--space-2);
}

.tool-state-label {
  color: var(--text-muted);
}

/* 子代理卡头的写权限徽章（只在 `permission: 'write'` 时出现） */
.perm-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  line-height: 16px;
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
  transition: transform var(--transition-base);
}

.tool-card.open .chevron {
  transform: rotate(90deg);
}

/*
 * 工具卡进场（TransitionGroup name="tool"）：轻微上浮 + 淡入。
 * 比消息气泡的 `rise` 更短更轻 —— 一轮里可能连续长出好几张卡，
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
 * 同一批卡片错开 40ms 出现（`.tools` 里的第 2、3… 张）。
 * 必须挂在 enter / leave 的 active 类下：`transition-delay` 是**常驻生效**的，
 * 只写 `.tool-card:nth-child(2)` 会让这张卡上此后任何过渡都晚 40ms 起步（误伤别的动效）。
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
  /*
   * 不许被 flex 压扁（`.tool-body` 是 flex 列容器）。
   * 展开动画期间容器身上挂着 `max-height: 0`，flex 会把**可收缩的子项**压到最小：
   * 滚动容器（本元素 `overflow: auto`）的自动最小尺寸解析为 0，于是它从 79px 被压到 13px
   * —— 内容在动画期间被压成一细条、过渡结束才弹回，同时让「实测高度」量少 66px
   * （2026-09-26 实测 401 vs 467）。折叠动画要的是**裁剪**，不是让内容重新排版。
   */
  flex: 0 0 auto;
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

/* 生图预览（BetaV2）：固定宽高比 + cover，加载前后占位一致不抖动 */
.tool-image {
  display: block;
  width: 100%;
  max-width: 320px;
  margin: 0 var(--space-2) var(--space-2);
  aspect-ratio: 1 / 1;
  max-height: 320px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  object-fit: cover;
  background: var(--fill-2);
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
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

.md :deep(.code-copy svg) {
  width: 11px;
  height: 11px;
  flex: 0 0 auto;
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
  /* 链接是正文文本：用可读的语义强调色，浅色档 --accent-text 是深蓝（#3157bb，6.0:1），
     直接写 --aurora-blue 在浅色基座上只有 3.14:1 */
  color: var(--accent-text);
  word-break: break-all;
}
</style>
