<script setup lang="ts">
/**
 * Aurora 主界面（BetaV2，Design/betav2-spec.md §2/§3）：1120×720 的三栏布局。
 *
 * 左栏（SessionNav）：品牌 / 新对话 / 固定项「快速对话」（切到 quick 会话）/
 * 会话列表 →「已归档 · N」分组（2026-09 新增，归档从这里进出）/ 模式徽章 + 右栏开关 + 设置。
 * 主区：头部（侧栏开关 + 会话标题 + 已归档提示条 + 清空 + Windows 式窗口按钮）→ MessageList →
 * composer（模型 / 思考等级下拉已移入 composer 工具行，对齐主流 Agent Desktop）。
 * 右栏（ContextPanel）：模式感知上下文 + 当前会话的任务清单卡。
 *
 * 旧口径（点击「快速对话」固定项切换主区会话）已废弃：快速对话在侧栏面板内完成，
 * 主区只承载普通会话。标题栏「收起」文字按钮由 WindowCaption 的「关闭」取代（隐藏语义不变）。
 *
 * 保留的既有能力：敏感工具确认卡片与 `proactive.onSensitiveTool` 订阅、TTS 自动朗读
 * （streaming false 边沿）与朗读按钮、附件拖拽 + chips、模型 / 思考等级写 provider
 * （`stripSecretFields` 剔除 apiKeyEnc/apiKeySet 后经 `settingsStore.update` 落盘）、
 * 收起 = 隐藏窗口（不 abort 正在进行的流式回复）。
 *
 * BetaV2 新增：思考过程展示（useChat 聚合 reasoning，MessageList 折叠块，受
 * `general.chat.showThinking` 门控）；麦克风语音输入（stt 门控口径同 TTS——未配置时
 * **连按钮都不渲染**，MediaRecorder webm → base64 → `stt:transcribe`）。
 *
 * 2026-09 动画轮新增：主区可在「对话流 / 子代理页面」之间切换（`view` ref，
 * docs/07 §2.3；子代理页不属于任何会话，切过去不动 chat 的会话状态）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  AskUserRequest,
  ChatAttachmentPreview,
  LlmProviderConfig,
  PermissionMode,
  SensitiveToolRequest,
  SkillSummary,
} from '@aurora/shared'
import {
  DEFAULT_REASONING_EFFORT,
  resolveModelParams,
  resolvePermissionMode,
  type ReasoningEffort,
} from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import AskUserCard from '../shared/components/AskUserCard.vue'
import MessageList from '../shared/components/MessageList.vue'
import ModelPickerSelect from '../shared/components/ModelPickerSelect.vue'
import SensitiveToolCard from '../shared/components/SensitiveToolCard.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import ThinkingLevelSelect from '../shared/components/ThinkingLevelSelect.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import ComposerContextBar from './components/ComposerContextBar.vue'
import ComposerPermissionSelect from './components/ComposerPermissionSelect.vue'
import SlashCommandMenu from './components/SlashCommandMenu.vue'
import ContextPanel from './components/ContextPanel.vue'
import JobPanel from './components/JobPanel.vue'
import FilePreviewPanel from './components/FilePreviewPanel.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import BrowserPanel, { type BrowserTarget } from './components/BrowserPanel.vue'
import CtxTabStrip from './components/CtxTabStrip.vue'
import CtxQuickAccess from './components/CtxQuickAccess.vue'
import SessionNav from './components/SessionNav.vue'
import SubagentPage from './components/SubagentPage.vue'
import AutomationPage from './components/AutomationPage.vue'
import { useChat } from '../shared/composables/useChat.js'
import { useTts } from '../shared/composables/useTts.js'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import {
  buildModelPickerState,
  type ModelPickerChoice,
  type ModelPickerSourceId,
} from '../shared/composables/modelPickerCore.js'
import { useCenterOfficialCatalog } from '../shared/composables/useCenterOfficialCatalog.js'
import { useCtxTabs } from './composables/useCtxTabs.js'
import { CTX_TABS_MAX, type CtxTab, type CtxTabKind } from './composables/ctxTabsCore.js'
import { appendProject, pickProjectEntry } from '../shared/projects.js'
import { useModeStore, useSettingsStore, useWindowStore } from '../shared/stores.js'
import { parseTodoWriteInput, type TodoRow } from '../shared/agentTodo.js'
import { filterSlashItems, slashQueryOf, type SlashItem } from './slashCommands.js'
import { ArrowUp, Mic, PanelLeft, Trash2, X } from '@aurora/shared/browser'

const chat = useChat('chat', 'main')
const { catalog: centerCatalog } = useCenterOfficialCatalog()
const {
  sessionId,
  messages,
  sessions,
  streaming,
  error: chatError,
  statusTone,
  reasoningTargetId,
  lastSettledRequestId,
  lastSettledAt,
  latestTurnGroupable,
  subagentRuns,
  usage,
  jobs,
  pendingNotice,
  send: sendMessage,
  abort,
  compactContext,
  clear,
  hydrate,
  loadSessions,
  refreshJobs,
  resumeJob,
  cancelJob,
  switchSession: rawSwitchSession,
  newSession,
  setArchived,
} = chat
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
// 拖动统一走显式清单：主窗口头部 / 左栏品牌行可拖，按钮区显式 no-drag
const { dragClass, noDragClass } = useWindowDrag('chat')

const input = ref('')
/** 左栏显隐（宽度收 0 过渡，内容固定宽被裁剪） */
const navOpen = ref(true)
/** 右栏显隐（同上；默认展开，1120px 宽下三栏并存） */
const contextOpen = ref(true)
/**
 * 「任务」面板显隐（左栏固定项里的入口按钮切换，2026-09 新增，docs/06 §4.1）。
 *
 * 默认展开：长任务被暂停时用户必须**不用先点任何东西**就能看见「继续」——
 * 面板收起后 `chat.jobs` 整块不渲染（入口按钮自带角标，收起了也看得出有几条任务）。
 */
const jobsOpen = ref(true)

// ── 左栏 / 右栏宽度记忆（2026-10-03，docs/07 §2.3） ──

/** 宽度存 localStorage（视图偏好不进 config schema） */
const NAV_WIDTH_KEY = 'aurora.chat.navWidth'
const NAV_WIDTH_DEFAULT = 240
const NAV_WIDTH_MIN = 200
/** 左栏上限（2026-10-03 提高）：420 → 520，且再受「主区下限」约束（见 roomFor） */
const NAV_WIDTH_MAX = 520

/**
 * 主区最小宽度（2026-10-03 用户实测）：两侧栏再宽也要给它留这么多。
 *
 * 起因：右栏上限提到 720 后，在 1120px 的窗口里拖到上限会把对话区挤成一条
 * （量出来 ~175px，消息一列一个字），窗口看着像坏了。现在两侧栏的**实际宽度**
 * 都是 `min(期望宽度, 窗口宽 − 另一侧宽度 − 本值)`，拖到头也只是把主区压到这条线。
 * 窗口最小尺寸 940（window-manager）下 200 + 280 + 460 仍然富余，这条线踩得到。
 */
const MAIN_MIN_WIDTH = 420

/** 视口宽：窗口缩放后要重算两侧的可用上限（宽度记忆是 px，不跟着窗口走） */
const viewportWidth = ref(window.innerWidth)
function onViewportResize(): void {
  viewportWidth.value = window.innerWidth
}

/** 本侧栏还能占多少：扣掉另一侧（收起的当 0）与主区下限 */
function roomFor(other: number): number {
  return Math.max(0, viewportWidth.value - other - MAIN_MIN_WIDTH)
}

const navEl = ref<HTMLElement | null>(null)

/**
 * 读一个宽度记忆值。键不存在时 `getItem` 返回 null，而 `Number(null) === 0` 是有限数 ——
 * 直接 Number() 会走进 clamp 拿到下限（右栏首版就是这个 bug：默认 384 从未生效）。
 */
function loadWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  } catch {
    return fallback
  }
}

function saveWidth(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    /* 存不进去只是丢掉宽度记忆，不影响功能 */
  }
}

/**
 * 读一个宽度记忆值：按**绝对**上下限夹取。窗口相关的收窄不写回这里 ——
 * 存的是用户的**期望宽度**，窗口缩小只是让它暂时显示得更窄（见下方 effective 计算）。
 */
const navWidth = ref(loadWidth(NAV_WIDTH_KEY, NAV_WIDTH_DEFAULT, NAV_WIDTH_MIN, NAV_WIDTH_MAX))

function saveNavWidth(): void {
  saveWidth(NAV_WIDTH_KEY, navWidth.value)
}

function resetNavWidth(): void {
  navWidth.value = NAV_WIDTH_DEFAULT
  saveNavWidth()
}

/**
 * 侧栏拖拽调宽的公共实现（左栏 / 右栏共用，宽度记忆键与夹取范围由调用方给）。
 *
 * pointerdown 后捕获指针并挂 move / up；move 期间给 `document.body` 挂 `col-resizing`
 * （关掉宽度过渡 + 禁止选中文字），松手恢复并落 localStorage。
 * 双击复位由调用方挂在把手上（`.nav-resizer` / `.ctx-resizer` 的 dblclick）。
 *
 * ⚠️ `move.buttons === 0` 必须跳过：capture 的命中区探针会派发**合成 PointerEvent**
 * （坐标常为 0 或窗口边界），若照单全收就会把宽度算成 0 再被 clamp 到下限并写进
 * localStorage —— 2026-10-03 实跑抓到过（快照里右栏莫名 280px）。真实拖动时 buttons 恒为 1。
 * ⚠️ `setPointerCapture` 在合成事件上会抛（没有活动指针）：捕获失败只影响"指针移出把手
 * 仍能收到 move"这一条，事件监听照常挂，因此 try/catch 吞掉而不是提前 return。
 */
function startColumnResize(
  event: PointerEvent,
  options: {
    min: number
    max: number
    /** 由指针 x 坐标算出该时刻的宽度 */
    widthAt: (clientX: number) => number
    apply: (width: number) => void
    save: () => void
  },
): void {
  if (event.button !== 0) return
  event.preventDefault()
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  try {
    target.setPointerCapture(event.pointerId)
  } catch {
    /* 合成事件无活动指针：照常挂监听 */
  }
  document.body.classList.add('col-resizing')
  const onMove = (move: PointerEvent): void => {
    if (move.buttons === 0) return
    options.apply(Math.min(options.max, Math.max(options.min, options.widthAt(move.clientX))))
  }
  const onUp = (): void => {
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    document.body.classList.remove('col-resizing')
    options.save()
  }
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
}

/**
 * 左栏**实际生效**宽度：期望宽度再受「主区下限 + 另一侧栏」约束。
 *
 * CSS 里写的 `var(--nav-w)` 是内联进去的这个值（不是用户拖出的期望值）—— 栏内的
 * SessionNav / JobPanel 因此天然跟着实际宽度排版，窗口缩小时不会比 aside 还宽。
 */
const navEffWidth = computed(() => {
  const other = contextOpen.value ? ctxWidth.value : 0
  return Math.max(NAV_WIDTH_MIN, Math.min(navWidth.value, roomFor(other)))
})

/** 左栏：左缘贴窗口左缘，宽度 = 指针 x − 左栏左缘 */
function onNavResizeStart(event: PointerEvent): void {
  const left = navEl.value?.getBoundingClientRect().left ?? 0
  startColumnResize(event, {
    min: NAV_WIDTH_MIN,
    max: NAV_WIDTH_MAX,
    widthAt: (clientX) => clientX - left,
    apply: (width) => {
      navWidth.value = width
    },
    save: saveNavWidth,
  })
}

// ── 右栏多标签（浏览器式）与可拖拽调宽（2026-10-03，docs/07 §2.3） ──

/**
 * 标签状态（记账在 `composables/ctxTabsCore.ts`，这里只是接线）：
 * 一个标签 = 一个面板实例，文件 / 终端 / 浏览器可各开多个，「上下文」是单例。
 * 初始四标签「上下文 / 文件 / 终端 / 浏览器」且缺省激活「上下文」—— 旧探针读的 DOM 与
 * `chat.ctx-tab-<kind>` 锚点因此逐字保留（docs/07 §2.3）。
 */
const {
  tabs: ctxTabs,
  activeId: ctxActiveId,
  activate: activateCtxTab,
  openTab: openCtxTab,
  ensureKind: ensureCtxKind,
  closeTab: closeCtxTab,
  setTitle: setCtxTabTitle,
} = useCtxTabs()

/**
 * 已挂载过的标签（**首次激活挂载、之后常驻**，docs/07 §2.3）：文件 / 终端 / 浏览器面板
 * 切走只是 `display:none` —— 网页不重载、xterm 不重建。**上下文面板不走这条**（它维持
 * 原来的 `v-if` 口径：激活才挂载），旧断言 `jobsHiddenOnFiles` 正依赖那条语义。
 * 用不可变 Set 换引用：`Set` 的增删不是响应式的，改引用才触发模板重算。
 */
const ctxMountedTabs = ref<Set<string>>(new Set())
watch(
  ctxActiveId,
  (id) => {
    const tab = ctxTabs.value.find((item) => item.id === id)
    if (tab === undefined || tab.kind === 'context') return
    if (ctxMountedTabs.value.has(id)) return
    ctxMountedTabs.value = new Set(ctxMountedTabs.value).add(id)
  },
  { immediate: true },
)

/**
 * 开新标签（「＋」菜单）：到上限时给一条可见提示，而不是静默什么都不发生。
 * 复用窗口左下角那条提示（`chat.project-notice` 通道）—— 它在子代理 / 自动化页照样可见，
 * 语义是「壳层动作的结果」而不是「项目专用」，这里借它的位置不必新造一条 toast。
 */
function onNewCtxTab(kind: CtxTabKind): CtxTab | null {
  const opened = openCtxTab(kind)
  if (opened === null) flashProjectNotice('error', `标签已达上限（${CTX_TABS_MAX} 个），先关掉一个`)
  return opened
}

/**
 * 右栏空态的工具快捷卡片（2026-10-03，docs/07 §2.3）：右栏标签**全关**时它们是重开入口 ——
 * 先把右栏展开（用户可能把它收起过），再走与「＋」菜单同一条开标签链路
 * （含到上限时的可见提示）。开出一个标签后右栏空态卡片区就自动消失。
 */
function openCtxTabFromEmpty(kind: CtxTabKind): void {
  contextOpen.value = true
  onNewCtxTab(kind)
}

/** 关标签：把「已挂载」记录一并清掉（编号会被复用，留着会让新标签一开就挂载） */
function onCloseCtxTab(id: string): void {
  closeCtxTab(id)
  if (ctxMountedTabs.value.has(id)) {
    const next = new Set(ctxMountedTabs.value)
    next.delete(id)
    ctxMountedTabs.value = next
  }
}

/**
 * 「把某个地址交给某个标签」的唯一通道（2026-10-03，docs/07 §2.3 / docs/06 §14）：
 * 两个来源共用它 ——
 * ① `show_preview` 工具（主进程推 `preview:show`）：**复用**已有的浏览器标签
 *    （激活中的是浏览器标签就用它，否则用最近激活过的那个），没有才新建；
 * ② 网页自己要求另开标签（`target="_blank"` / `window.open`，主进程推 `browser:openTab`）：
 *    **总是新开一个**浏览器标签（那是站点的原意，别把用户当前页顶掉）。
 * `token` 单调递增 —— 同一地址在同一个标签上再次投递也必须重新导航，
 * 仅靠 url 相等判不出「又来了一次」。
 */
const panelTarget = ref<BrowserTarget | null>(null)
/** 这个目标投给哪个标签（非该标签的浏览器面板收到 null → 停在自己的主页） */
const panelTargetTabId = ref('')
let panelTokenSequence = 0
let offPreviewShow: (() => void) | null = null
let offBrowserOpenTab: (() => void) | null = null

/** 右栏宽度（px）：存 localStorage（视图偏好不进 config schema），280–720 夹取 */
const CTX_WIDTH_KEY = 'aurora.chat.ctxWidth'
const CTX_WIDTH_DEFAULT = 384
const CTX_WIDTH_MIN = 280
/**
 * 右栏上限（2026-10-03 提高）：560 → 720。这一条是用户点名要的 —— 预览长文件、
 * 看代码块时 560 上限太窄，内容被挤成一列。实际生效宽度 = `min(期望, 窗口 − 左栏 − 主区下限)`
 * （`ctxEffWidth`）：窗口最大化时能拖到 720，小窗口下自动收窄，**主区不会被挤没**。
 */
const CTX_WIDTH_MAX = 720

const ctxWidth = ref(loadWidth(CTX_WIDTH_KEY, CTX_WIDTH_DEFAULT, CTX_WIDTH_MIN, CTX_WIDTH_MAX))

/** 右栏**实际生效**宽度（读左栏的生效值，避免两侧互相引用成环） */
const ctxEffWidth = computed(() => {
  const other = navOpen.value ? navEffWidth.value : 0
  return Math.max(CTX_WIDTH_MIN, Math.min(ctxWidth.value, roomFor(other)))
})

function saveCtxWidth(): void {
  saveWidth(CTX_WIDTH_KEY, ctxWidth.value)
}

function resetCtxWidth(): void {
  ctxWidth.value = CTX_WIDTH_DEFAULT
  saveCtxWidth()
}

/** 右栏：右缘贴窗口右缘，宽度 = 窗口宽 − 指针 x */
function onCtxResizeStart(event: PointerEvent): void {
  startColumnResize(event, {
    min: CTX_WIDTH_MIN,
    max: CTX_WIDTH_MAX,
    widthAt: (clientX) => window.innerWidth - clientX,
    apply: (width) => {
      ctxWidth.value = width
    },
    save: saveCtxWidth,
  })
}

/**
 * 「任务」入口：确保「上下文」标签在（被关掉时重建）并激活它，再翻转面板显隐 ——
 * 任务面板收在上下文标签里，用户在「终端」标签点任务入口时直接翻 `jobsOpen` 会看不到反馈。
 */
function toggleJobs(): void {
  ensureCtxKind('context')
  jobsOpen.value = !jobsOpen.value
}
/** 是否还有任务在跑（左栏入口角标用 running 色，与「子代理」角标同一口径） */
const jobsRunning = computed(() => jobs.value.some((job) => job.status === 'running'))
/**
 * 主区内容（2026-09 新增，docs/07 §2.3）：对话流 / 子代理页面。
 *
 * 刻意**不做成会话切换** —— 子代理页不属于任何 `sessionId`，切过去不该动 chat 的
 * 会话状态（否则会触发水合、清空正在看的消息）。它只替换 `.thread` 区域，
 * 输入区与右栏保持原样，随时可以切回来继续问。
 */
const view = ref<'chat' | 'subagents' | 'automations'>('chat')
/** 子代理页副标题：当前会话在列表里的标题（列表尚未加载时退化为固定文案） */
const currentSessionTitle = computed(
  () => sessions.value.find((item) => item.id === sessionId.value)?.title ?? '当前会话',
)
/** 是否还有子代理在跑（左栏角标用 running 色 + 子代理页概览） */
const subagentRunning = computed(() => subagentRuns.value.some((run) => run.status === 'running'))

/** 待确认的敏感工具调用（主进程同一时刻最多推一条） */
const sensitiveRequest = ref<SensitiveToolRequest | null>(null)
let offSensitiveTool: (() => void) | null = null
/**
 * Agent 提问卡片（`ask_user`，docs/06 §21）的当前请求列表（本轮改为**按会话并存**）。
 *
 * 此前是单槽位 ref：跨会话并发提问时后到的会**覆盖**先到的那张，用户再也看不到它
 * （内核那侧仍挂着等回执，只能等超时）—— Center 网页端早已用数组解决同一问题，
 * 这里补齐。渲染时全部列出（不按当前会话过滤）：漏掉一张卡就等于让一个问题没人回答。
 */
const askUserRequests = ref<AskUserRequest[]>([])
let offAskUserRequest: (() => void) | null = null

/** 拖拽中的附件绝对路径（发送后清空） */
const attachments = ref<string[]>([])
/** 是否正有文件悬停在窗口上（用于描边提示） */
const dragging = ref(false)

/**
 * 会话列表给左栏用：quick 由侧栏面板承载，不再出现在普通会话列表里。
 *
 * 另按 docs/12 §5 的口径过滤远程可见性：`center-` 前缀会话被 Center 标记
 * `centerVisible === false` 时不进左栏（缺省 / 本地会话不受影响）。**只过滤展示**——
 * 隐藏的远程会话仍可被网页端远程输入与 `chat:remoteActivate` 激活（激活后当前会话
 * 恰是它也不强制切走，只是列表里看不到）。
 *
 * `auto-` 前缀会话（自动化触发，docs/13 §7）同样**只过滤展示**：它们从
 * 「自动化 → 历史」进入（每次触发一个专属会话），混进左栏只会稀释会话列表。
 */
const sessionItems = computed(() =>
  sessions.value.filter(
    (item) =>
      item.id !== 'quick' &&
      !item.id.startsWith('auto-') &&
      item.archived !== true &&
      !(item.id.startsWith('center-') && item.centerVisible === false),
  ),
)

/**
 * 已登记的项目 id 集合：判定「会话的绑定是否还有效」用。
 *
 * 绑定项已被删除的会话（**孤儿绑定**）在解析链上按未绑定回落（docs/06 §5.1），
 * 展示层必须同口径 —— 否则这类会话既进不了任何项目分组（项目没了）、
 * 又被 Agent 分组按 `projectId === undefined` 挡掉，会从左栏**整条消失**，
 * 用户看得见的历史会话「凭空不见了」。
 */
const knownProjectIds = computed(
  () => new Set((settingsStore.settings?.projects.list ?? []).map((project) => project.id)),
)

/**
 * 会话三分的三个分区（docs/06 §4 会话空间 / docs/07 §2.3，2026-09-30）：
 * 判定优先级是 **projectId > space**（绑定了**有效**项目的会话是项目对话，space 不参与）；
 * 未标记 space 的会话一律归 Agent对话（主进程 `spaceOf` 同一条归一口径）。
 */
const workSessions = computed(() =>
  sessionItems.value.filter(
    (item) =>
      (item.projectId === undefined || !knownProjectIds.value.has(item.projectId)) &&
      item.space === 'work',
  ),
)

const agentSessions = computed(() =>
  sessionItems.value.filter(
    (item) =>
      (item.projectId === undefined || !knownProjectIds.value.has(item.projectId)) &&
      item.space !== 'work',
  ),
)

/**
 * 项目对话：按 `projects.list` 顺序的子分组。**空项目也要渲染** —— 组头 `+` 是
 * 「在这个项目里新建对话」的唯一入口，按「有会话才显示」过滤会让空项目无法创建第一条会话。
 * 项目名取自设置 store（ContextPanel 的当前项目卡同源，没有第二份配置读取）。
 */
const projectGroups = computed(() => {
  const list = settingsStore.settings?.projects.list ?? []
  return list.map((project) => ({
    id: project.id,
    name: project.name,
    sessions: sessionItems.value.filter((item) => item.projectId === project.id),
  }))
})

/**
 * 当前会话绑定的项目名（右栏「文件」tab 的标题用，2026-10-03，docs/07 §2.3）：
 * 未绑定 / 绑定项已被删除（孤儿绑定在解析链上按未绑定回落）都返回 undefined ——
 * 展示口径必须与 `boundaryRoot` 的回落一致，否则标题会写着一个实际不生效的项目名。
 */
const currentProjectName = computed(() => {
  const projectId = sessions.value.find((item) => item.id === sessionId.value)?.projectId
  if (projectId === undefined || !knownProjectIds.value.has(projectId)) return undefined
  return settingsStore.settings?.projects.list.find((project) => project.id === projectId)?.name
})

/**
 * 已归档会话（左栏「已归档 · N」分组的数据源，docs/07 §2.3）。
 *
 * 归档判定严格按 `archived === true`：`false`（显式取消归档过）与 `undefined`（从未归档的
 * v1 老文件）都算「不在归档分组」，语义等价。排序沿用 `chat:sessions` 给的 updatedAt 倒序，
 * 渲染层不重排（主进程是唯一的排序口径）。
 */
const archivedSessionItems = computed(() =>
  sessions.value.filter((item) => item.id !== 'quick' && item.archived === true),
)

/**
 * 当前打开的会话是否处于归档态——主区头部「已归档」提示条的唯一门控。
 *
 * 快速会话（`quick`）不在 `chat:sessions` 里，这里自然为 false，符合 docs/07 §2.3
 * 「quick / settings 两个伪会话不参与归档」的口径。
 */
const currentArchived = computed(
  () => sessions.value.find((item) => item.id === sessionId.value)?.archived === true,
)

/**
 * 当前会话的任务清单（右栏「任务清单」卡的数据源，docs/07 §2.3）。
 *
 * 口径 = 消息流里**最后一次** `todo_write` 的入参（整表替换语义：最后一次提交就是当前状态）；
 * 倒序找第一条能解析出条目的调用。没有清单 / 解析失败时返回空数组（右栏卡不渲染）。
 * 流式期间 todo_write 的 input 随 running 事件先到，清单随之实时更新。
 */
const currentTodos = computed<TodoRow[]>(() => {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const calls = messages.value[index]?.toolCalls ?? []
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex]
      if (call === undefined || call.name !== 'todo_write' || call.state === 'error') continue
      // 空清单（[]）是合法的「清空任务」提交：作为最终状态返回，右栏卡随之消失；
      // 只有畸形入参（null）才继续前溯上一份清单
      const rows = parseTodoWriteInput(call.input)
      if (rows !== null) return rows
    }
  }
  return []
})

/** 标题栏里的当前会话名：快速会话固定名，其余用主进程摘要（空标题 =「新会话」） */
const currentTitle = computed(() => {
  if (sessionId.value === 'quick') return '快速对话'
  const current = sessions.value.find((item) => item.id === sessionId.value)
  return sessionTitle(current?.title ?? '')
})

/**
 * 右栏两张项目卡（会话项目绑定 / 当前项目）已于 2026-09-30 下线（用户判定为无用）：
 * 项目信息在左栏「项目对话」分区已完整可见（按项目名分组），绑定入口收敛为
 * 组头 `+`（新建即绑定）。绑定状态本身仍是 `chat:setSessionProject` 的产物，
 * 只是不再有主界面下拉入口 —— 改绑请删除重绑或经 Center 远程命令。
 */

onMounted(() => {
  offSensitiveTool = window.aurora.proactive.onSensitiveTool((request) => {
    sensitiveRequest.value = request
  })
  offAskUserRequest = window.aurora.askUser.onRequest((request) => {
    if (askUserRequests.value.some((item) => item.requestId === request.requestId)) return
    askUserRequests.value = [...askUserRequests.value, request]
  })
  // Agent 展示（`show_preview` 工具，docs/06 §14）：投给浏览器标签并加载目标
  offPreviewShow = window.aurora.preview.onShow((event) => {
    if (event.sessionId !== sessionId.value) return
    contextOpen.value = true
    // 复用口径（2026-10-03 二次修订）：激活中的是浏览器标签就用它，否则用最近激活过的那个，
    // 都没有才新建 —— 每来一次展示就再开一个标签只会把标签条淹掉。
    const tab = ensureCtxKind('browser')
    if (tab === null) return
    panelTargetTabId.value = tab.id
    panelTarget.value = {
      url: event.url,
      display: event.display,
      title: event.title,
      token: (panelTokenSequence += 1),
    }
  })
  // 站点自开标签（`target="_blank"` / `window.open`，docs/07 §2.3）：**总是新开**一个浏览器标签
  // —— 站点本来要的是「新窗口」，别把用户正在看的页顶掉（旧口径正是同窗导航）。
  offBrowserOpenTab = window.aurora.browser.onOpenTab((event) => {
    contextOpen.value = true
    // 走与「＋」菜单同一条入口（到上限时同样给一条可见提示，而不是静默什么也不发生）
    const tab = onNewCtxTab('browser')
    if (tab === null) return
    panelTargetTabId.value = tab.id
    panelTarget.value = {
      url: event.url,
      display: event.url,
      title: '',
      token: (panelTokenSequence += 1),
    }
  })
  document.addEventListener('pointerdown', onComposerPointerDown)
  document.addEventListener('keydown', onDocumentEscape)
  // 窗口缩放 → 重算两侧栏的生效宽度（宽度记忆是 px，主区下限靠 viewportWidth 兜）
  window.addEventListener('resize', onViewportResize)
  // 水合当前会话（main）→ 会话列表：左栏立刻有内容
  void hydrate().then(() => loadSessions())
  // 任务（Job）列表与消息同样在挂载时水合：重启后暂停的长任务必须立刻可见（docs/06 §4.1）
  void refreshJobs()
  // 斜杠命令的 Skill 候选（`/` 浮层的技能分组）：失败只是没有技能项，不影响输入
  void window.aurora.skills.list().then((result) => {
    if (!result.ok) return
    slashSkills.value = result.value
  })
})

onUnmounted(() => {
  offSensitiveTool?.()
  offSensitiveTool = null
  offAskUserRequest?.()
  offAskUserRequest = null
  offPreviewShow?.()
  offPreviewShow = null
  offBrowserOpenTab?.()
  offBrowserOpenTab = null
  document.removeEventListener('pointerdown', onComposerPointerDown)
  document.removeEventListener('keydown', onDocumentEscape)
  window.removeEventListener('resize', onViewportResize)
  if (pickerHintTimer !== null) window.clearTimeout(pickerHintTimer)
  pickerHintTimer = null
  disposeRecording()
})

function resolveSensitive(): void {
  sensitiveRequest.value = null
}

/** 提问卡片的收尾：回执已由卡片自己发出，这里只把**那一张**收起（超时 / 跳过 / 已结算都走它） */
function resolveAskUser(requestId: string): void {
  askUserRequests.value = askUserRequests.value.filter((item) => item.requestId !== requestId)
}

const guide = computed(() => {
  const mode = modeStore.current
  if (!mode || mode.guideCompleted) return null
  return mode
})

/** 会话标题：空会话显示为「新会话」，与主进程的摘要保持一致 */
function sessionTitle(title: string): string {
  return title.trim() === '' ? '新会话' : title
}

// ───────────────────────── 会话切换（所有入口统一副作用） ─────────────────────────

/**
 * 切换会话：停掉朗读与录音（切走后它们已经不属于当前视口），
 * 并复位自动朗读去重标记。侧栏点选、快速对话都走这里。
 */
async function switchSession(id: string): Promise<void> {
  tts.stop()
  lastReadId = null
  disposeRecording()
  await rawSwitchSession(id)
}

/**
 * 左栏「新对话」：同样是切会话，带上同一组副作用。
 * 固定创建 **Agent 会话**（docs/07 §2.3，2026-09-30）—— 项目 / 工作目录对话
 * 从各分区组头的 `+` 进入（startProjectSession / startWorkSession）。
 */
async function startNewSession(): Promise<void> {
  tts.stop()
  lastReadId = null
  disposeRecording()
  await newSession({ space: 'agent' })
}

/** 项目分组头 `+`：新建会话并绑定到该项目（主进程校验项目存在性） */
async function startProjectSession(projectId: string): Promise<void> {
  tts.stop()
  lastReadId = null
  disposeRecording()
  await newSession({ projectId })
}

/** 工作目录对话分组头 `+`：新建 space:'work' 的会话（Work 模式专属入口） */
async function startWorkSession(): Promise<void> {
  tts.stop()
  lastReadId = null
  disposeRecording()
  await newSession({ space: 'work' })
}

/**
 * 「添加项目」的结果提示（2026-10-01）。
 *
 * **独立于 `chatError` / `pickerHint`**：那两个都渲染在 composer 里，而 composer 只在
 * `view === 'chat'` 时挂载 —— 左栏的「添加项目」在子代理 / 自动化页照样能点，
 * 提示就必须在任何视图下都看得见（否则又回到"点了什么都不发生"）。
 * 成功 2.6 秒自散；失败留 6 秒（够读完，又不会变成常驻噪声；下次再点会先清掉）。
 */
const projectNotice = ref<{ tone: 'ok' | 'error'; text: string } | null>(null)
let projectNoticeTimer: number | null = null

function flashProjectNotice(tone: 'ok' | 'error', text: string): void {
  projectNotice.value = { tone, text }
  if (projectNoticeTimer !== null) window.clearTimeout(projectNoticeTimer)
  projectNoticeTimer = window.setTimeout(
    () => {
      projectNotice.value = null
      projectNoticeTimer = null
    },
    tone === 'ok' ? 2600 : 6000,
  )
}

/**
 * 项目对话区标题行的「添加项目」（2026-09-30，docs/07 §2.3）：
 * 弹目录选择框 → 加入 `projects.list`（`appendProject` 是唯一口径，
 * 与设置页同一条链路、同一份 id / 命名规则）。
 *
 * **v25 起项目只登记、不「生效」**：全局 `projects.current` 已退役，项目改由会话绑定 ——
 * 新项目要用于对话，在左栏该项目的分组头 `+` 新建会话（`chat:setSessionProject`）即可。
 *
 * 失败不再静默（2026-10-01）：选择框出错 / 配置被拒都经 `projectNotice` 报出来 ——
 * 旧实现把「取消」与「出错」压成同一个 `null` 直接返回，用户点完什么都看不到。
 */
async function addProject(): Promise<void> {
  if (projectNoticeTimer !== null) {
    window.clearTimeout(projectNoticeTimer)
    projectNoticeTimer = null
  }
  projectNotice.value = null
  if (!settingsStore.settings) return
  const picked = await pickProjectEntry()
  if (picked.kind === 'canceled') return
  if (picked.kind === 'error') {
    flashProjectNotice('error', `添加项目失败：${picked.message}`)
    return
  }
  // 选择框是模态的、可能停留很久：**重读**最新 projects 再合并 —— 用弹框前的旧快照提交
  // 会把期间在设置页做的重命名 / 删除整棵覆盖掉。
  const latest = settingsStore.settings?.projects
  if (!latest) return
  const ok = await settingsStore.update({ projects: appendProject(latest, picked.entry) })
  if (!ok) {
    flashProjectNotice('error', settingsStore.error ?? '添加项目失败')
    return
  }
  // 项目分组由 settings store 现算（`projectGroups`），update 成功后左栏自动多出一组
  flashProjectNotice('ok', `已添加项目「${picked.entry.name}」`)
}

/** Agent对话分组头 `+`：与顶部「新对话」同效（都显式标 agent 空间） */
async function startAgentSession(): Promise<void> {
  await startNewSession()
}

/**
 * 左栏点选会话（含「快速对话」固定项）：切会话并把主区切回对话流 ——
 * 用户点会话的意图是「看这段对话」，若还停在子代理页会显得点了没反应。
 */
async function selectSession(id: string): Promise<void> {
  view.value = 'chat'
  await switchSession(id)
}

// ───────────────────────── 任务（Job）：续跑 / 取消（docs/06 §4.1） ─────────────────────────

/**
 * 「任务」面板的两个动作：一律转发给 `useChat`（IPC 调用 + 重拉列表都在那里）。
 *
 * 组件层刻意**不做乐观改写**（点了就先把状态改成 running）：任务状态由主进程说了算，
 * 本地先改会让「点了继续但其实没跑起来」看不出来 —— 与归档 / 取消归档同一口径。
 */
function onResumeJob(id: string): void {
  void resumeJob(id)
}

function onCancelJob(id: string): void {
  void cancelJob(id)
}

// ────────────── 头部的两个 provider 控件：模型 / 思考等级（docs/06 §3） ──────────────

/**
 * 这一组控件有两个数据面（docs/06 §3，本轮起）：
 *
 * 1. **会话级模型**（「模型来源 + 模型」双下拉）：写的是**本会话**
 *    `meta.llm = { providerId, model }`（`chat:setSessionModel`）。会话数据不是配置，
 *    不进 `config.json`；旧会话没有覆盖时只展示全局推导值，首次主动选择才固化；
 * 2. **全局默认**（「思考等级」下拉，以及设置页「AI 模型」卡）：写配置
 *    `llm.providers.<生效 provider>.modelParams.<生效模型>.reasoningEffort`（v23 起随模型绑定）。
 *
 * 「生效」由 `buildModelPickerState()` 统一解析：会话覆盖 > Center 官方语言模型 > 本机
 * `llm.active`；覆盖里的 provider 已被删除 / model 为空 → 静默回落全局档。
 * 保存成功后 `settings:changed` 会把新配置推回 store，会话覆盖由 `loadSessions()` 刷新。
 * 每次发送时主进程都会重解析，因此写完**下一次发送**立即生效。
 */
const activeProviderId = computed(() => settingsStore.settings?.llm.active ?? '')

/** 本会话的模型覆盖（`meta.llm`）；会话不在列表里 / 未覆盖 → `undefined`（跟随全局） */
const sessionModelOverride = computed(() => {
  const summary = sessions.value.find((item) => item.id === sessionId.value)
  return summary?.llm
})

/** 模型来源 / 模型双下拉的唯一状态。没有会话覆盖时只展示全局推导值，不写盘。 */
const modelPicker = computed(() => {
  const settings = settingsStore.settings
  if (!settings) return null
  return buildModelPickerState(
    settings,
    sessionModelOverride.value,
    centerCatalog.value?.services.llm !== undefined,
  )
})

/** 会话**生效**模型（会话覆盖 > Center 官方 > 本机全局）—— 各控件与发送链共用这一份 */
const effectiveModel = computed(() => {
  const choice = modelPicker.value?.choice
  return choice === undefined || choice === null
    ? null
    : { ...choice, overridden: modelPicker.value?.overridden === true }
})

/** 生效 provider（覆盖里的那个 / 全局激活的）；没有可用 provider 时为 `null` */
const effectiveProvider = computed<LlmProviderConfig | null>(() => {
  const settings = settingsStore.settings
  const effective = effectiveModel.value
  if (!settings || effective === null) return null
  return settings.llm.providers[effective.providerId] ?? null
})

const effectiveModelLabel = computed(() => {
  const effective = effectiveModel.value
  return effective === null ? '' : `${effective.providerId} · ${effective.model}`
})

/** Center 官方参数由管理员目录维护，本地思考等级下拉只读展示。 */
const centerModelReadOnly = computed(
  () => modelPicker.value?.centerReadOnly === true || modelPicker.value?.sourceId === 'center',
)

/**
 * **生效模型**的生成参数（v23，docs/08 §1）：思考等级 / 上下文窗口都在
 * `llm.providers.<生效 provider>.modelParams.<生效模型>` 下，随模型绑定 —— 换个模型就是另一套值。
 * 取值走 shared 的**唯一**入口 `resolveModelParams`（键未命中 / 字段缺失时按字段回落默认，
 * 消费端绝不拿到 `undefined`）。没有可用 provider / 生效模型为空时为 `null`。
 */
const currentModelParams = computed(() => {
  const provider = effectiveProvider.value
  const effective = effectiveModel.value
  if (provider === null || effective === null || effective.model === '') return null
  return resolveModelParams(provider, effective.model)
})

/** 当前生效模型的思考等级；没有可用 provider 时为 `null`（此时控件禁用而不是隐藏） */
const effort = computed<ReasoningEffort | null>(
  () => currentModelParams.value?.reasoningEffort ?? null,
)

/** 思考下拉显示值：无 provider 时用默认等级占位——禁用态也要让用户看得见这个控件 */
const effortValue = computed<ReasoningEffort>(() => effort.value ?? DEFAULT_REASONING_EFFORT)

/** 无 provider 时两个下拉共用的 tooltip / 提示文案（与设置页口径一致：指向修复路径） */
const missingProviderTitle = '先在「设置 → AI 模型」里配置并选中一个模型'

/** 模型下拉的 tooltip（Chromium 不给禁用态的原生控件弹 title） */
const modelTitle = computed(() =>
  effectiveProvider.value === null
    ? missingProviderTitle
    : '本会话使用的模型；切换来源或模型会写入本会话覆盖，对下一次请求生效',
)

/** 思考下拉的 tooltip：无 provider → 指向修复路径；有 provider → 说明这个参数的含义 */
const effortTitle = computed(() =>
  effectiveProvider.value === null
    ? missingProviderTitle
    : centerModelReadOnly.value
      ? 'Center 官方模型的思考等级由管理员目录配置，本机只读展示'
      : '思考等级（越高越深入，但更慢更贵）；auto 不下发该参数，兼容性最好',
)

/** 输入区瞬时提示：当前只用于流式期间按 Enter 的操作说明，失败仍走 chatError。 */
const pickerHint = ref<string | null>(null)
let pickerHintTimer: number | null = null

function flashPickerHint(text: string): void {
  pickerHint.value = text
  if (pickerHintTimer !== null) window.clearTimeout(pickerHintTimer)
  pickerHintTimer = window.setTimeout(() => {
    pickerHint.value = null
    pickerHintTimer = null
  }, 2000)
}

/**
 * 去掉只在渲染层存在的两个字段，其余字段原样透传（将来给 provider 加业务字段不会被漏掉）。
 *
 * 为什么必须去掉：渲染层拿到的 `apiKeyEnc` 按设计永远是空串（主进程 `redactSettings()` 脱敏），
 * 而主进程 `applyPatch()` 对每个出现在 patch 里的 provider 做 `{ ...已有, ...patch }` 逐字段合并——
 * 把空串带回去就等于"把磁盘上的密文覆盖成空"，现象是「用起来没事、重启后 API Key 没了」。
 */
function stripSecretFields(provider: LlmProviderConfig): LlmProviderConfig {
  const {
    apiKeyEnc: _cipher,
    apiKeySet: _keySet,
    ...rest
  } = provider as LlmProviderConfig & { apiKeySet?: boolean }
  return rest as LlmProviderConfig
}

/**
 * 更新某个 provider 的若干字段——「思考等级」下拉的写入路径（写的是**全局配置**）。
 *
 * patch 必须**原样回传 `llm.active` 与全部 `providers`**（`settings:update` 只有顶层浅合并，
 * 分组级局部更新缺一条就丢配置），但每一个 provider 都要先过 `stripSecretFields()`。
 * deepClone 由 `settingsStore.update()` 统一处理（Proxy 不可结构化克隆）。
 * `providerId` 缺省 = 全局激活的那个；传生效 provider 是为了让会话覆盖了模型时，
 * 等级写进**那个模型**名下的参数表。
 */
async function updateActiveProvider(
  patch: Partial<LlmProviderConfig>,
  providerId?: string,
): Promise<boolean> {
  const settings = settingsStore.settings
  const id = providerId ?? activeProviderId.value
  if (!settings || id === '') return false
  const provider = settings.llm.providers[id]
  if (!provider) return false
  const providers: Record<string, LlmProviderConfig> = {}
  for (const [itemId, item] of Object.entries(settings.llm.providers)) {
    providers[itemId] = stripSecretFields(item)
  }
  providers[id] = { ...stripSecretFields(provider), ...patch }
  const ok = await settingsStore.update({
    llm: { active: settings.llm.active, providers },
  })
  if (!ok) {
    chatError.value = settingsStore.error
    return false
  }
  return true
}

/**
 * 写入**生效模型**的思考等级（`auto` 由主进程装配层映射成「不下发」）；只在值真的变了时写。
 *
 * 等级是**模型级**的（v23）：写的是 `providers.<生效 provider>.modelParams[<生效模型>]`，
 * 而且**整份替换**该键的对象（不是原地改一个字段）—— `modelParams` 的三个子字段里
 * 只写它会让另外两项被静默重置成默认值 —— 三项一起写。
 * 生效模型为空串时不写（没有「生效模型」可归属，与迁移的「model 为空不造条目」同口径）。
 */
async function setEffort(next: ReasoningEffort): Promise<void> {
  if (centerModelReadOnly.value) return
  const provider = effectiveProvider.value
  const effective = effectiveModel.value
  if (provider === null || effective === null) return
  const modelId = effective.model
  if (modelId === '' || resolveModelParams(provider, modelId).reasoningEffort === next) return
  await updateActiveProvider(
    {
      modelParams: {
        ...provider.modelParams,
        [modelId]: { ...resolveModelParams(provider, modelId), reasoningEffort: next },
      },
    },
    effective.providerId,
  )
}

/**
 * 写入**本会话**的模型覆盖（`chat:setSessionModel`，docs/06 §3）。
 *
 * 值没变就直接返回：一次无谓的写盘会让会话文件多刷一次 updatedAt。
 * 落盘成功后重拉会话列表，`sessionModelOverride` 随之更新（覆盖是会话数据，不经 settings 推送）。
 */
async function persistModelChoice(next: ModelPickerChoice): Promise<void> {
  const result = await window.aurora.chat.setSessionModel({
    sessionId: sessionId.value,
    providerId: next.providerId,
    model: next.model,
  })
  if (!result.ok) {
    chatError.value = result.message
    return
  }
  await loadSessions()
}

async function setModel(next: ModelPickerChoice): Promise<void> {
  const effective = effectiveModel.value
  if (effective === null) return
  const unchanged =
    effective.providerId === next.providerId &&
    effective.model === next.model &&
    effective.overridden
  if (unchanged) return
  await persistModelChoice(next)
}

async function setModelSource(next: ModelPickerSourceId): Promise<void> {
  const state = modelPicker.value
  if (state === null || state.sourceId === next) return
  const source = state.sources.find((item) => item.id === next)
  if (source === undefined) return
  await persistModelChoice(source.defaultChoice)
}

// ───────────────────────── 语音朗读（TTS，docs/06 §13） ─────────────────────────

const tts = useTts()

/**
 * 当前是否「可朗读」——朗读按钮出不出现的**唯一**口径（docs/06 §13）。
 * 四个条件缺一不可：总开关打开、`tts.active` 指向一个存在的 provider、
 * 且该 provider 的 `baseUrl` / `model` / `voice` 都填了。没配置时按钮**根本不渲染**。
 */
const ttsReady = computed<boolean>(() => {
  const settings = settingsStore.settings
  if (!settings) return false
  const { enabled, active, providers } = settings.tts
  if (!enabled || active === '') return false
  const provider = providers[active]
  if (provider === undefined) return false
  return (
    provider.baseUrl.trim() !== '' && provider.model.trim() !== '' && provider.voice.trim() !== ''
  )
})

/** 是否展示思考过程（MessageList 思考折叠块的唯一门控；配置缺失时默认开） */
const showThinking = computed<boolean>(
  () => settingsStore.settings?.general.chat.showThinking ?? true,
)

/**
 * 已自动朗读过的消息 id。
 * 自动朗读只在「本轮从 streaming=true 变为 false」的边沿触发；记 id 去重防重复朗读。
 */
let lastReadId: string | null = null

watch(
  () => streaming.value,
  (now, before) => {
    if (!before || now) return
    if (!ttsReady.value || settingsStore.settings?.tts.autoRead !== true) return
    const message = chat.lastAssistant.value
    if (message === null || message.id === lastReadId) return
    const text = message.content.trim()
    if (text === '') return
    lastReadId = message.id
    void tts.speak(text, message.id)
  },
)

/** 朗读失败提示：独立 toast，4 秒后自动收起（与输入区提示刻意分开） */
const ttsErrorToast = ref<string | null>(null)
const centerRuntimeNotice = ref<string | null>(null)
let centerRuntimeNoticeTimer: number | null = null
const offCenterRuntimeNotice = window.aurora.center.onRuntimeNotice((notice) => {
  centerRuntimeNotice.value = notice.message
  if (centerRuntimeNoticeTimer !== null) window.clearTimeout(centerRuntimeNoticeTimer)
  centerRuntimeNoticeTimer = window.setTimeout(() => {
    centerRuntimeNotice.value = null
    centerRuntimeNoticeTimer = null
  }, 6000)
})
onUnmounted(() => {
  offCenterRuntimeNotice()
  if (centerRuntimeNoticeTimer !== null) window.clearTimeout(centerRuntimeNoticeTimer)
})
let ttsErrorTimer: number | null = null

watch(
  () => tts.error.value,
  (message) => {
    if (message === null) return
    ttsErrorToast.value = message
    tts.error.value = null
    if (ttsErrorTimer !== null) window.clearTimeout(ttsErrorTimer)
    ttsErrorTimer = window.setTimeout(() => {
      ttsErrorToast.value = null
      ttsErrorTimer = null
    }, 4000)
  },
)

/** 朗读按钮：合成并播放；同一条再点一次由 MessageList 转成 `stopSpeak`。 */
function speakMessage(text: string, id: string): void {
  void tts.speak(text, id)
}

// ───────────────────── 语音输入（STT，BetaV2；门控口径同 TTS） ─────────────────────

/**
 * 麦克风按钮出不出现的**唯一**口径（docs/07 §2.3）：`stt.enabled` 且 `stt.active` 指向一个
 * **存在**的 provider，且该 provider 的 `baseUrl` / `model` 齐全。门槛与 `ttsReady` 同款
 * ——**不查 API Key**（本地 whisper 类无需密钥的部署同样渲染按钮；转写失败由状态提示兜底）。
 * 未满足时按钮**根本不渲染**（不是 disabled）——点一个必然失败的入口不如不给。
 */
const sttReady = computed<boolean>(() => {
  const settings = settingsStore.settings
  if (!settings) return false
  const { enabled, active, providers } = settings.stt
  if (!enabled || active === '') return false
  const provider = providers[active]
  if (provider === undefined) return false
  return provider.baseUrl.trim() !== '' && provider.model.trim() !== ''
})

const recording = ref(false)
/** 转写请求在途（按钮显示忙碌态，避免重复触发） */
const sttBusy = ref(false)
let mediaStream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let recordChunks: Blob[] = []

/** MediaRecorder 的容器：优先 webm（主进程按 mime 拼 multipart），浏览器不支持再回落 */
function pickRecorderMime(): string | undefined {
  const candidates = ['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4']
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return undefined
}

async function startRecording(): Promise<void> {
  if (sttBusy.value) return
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    chatError.value = '无法开始录音：请检查麦克风连接，并允许 Aurora 使用麦克风'
    return
  }
  const mimeType = pickRecorderMime()
  try {
    recorder = new MediaRecorder(mediaStream, mimeType === undefined ? undefined : { mimeType })
  } catch (cause) {
    releaseStream()
    chatError.value = `无法开始录音：${cause instanceof Error ? cause.message : String(cause)}`
    return
  }
  recordChunks = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordChunks.push(event.data)
  }
  recorder.onstop = () => {
    void finishRecording()
  }
  recorder.start()
  recording.value = true
}

/** 停止录音并进入转写（`recorder.stop()` 会冲刷数据，onstop 里接续） */
function stopRecording(): void {
  if (recorder !== null && recorder.state !== 'inactive') recorder.stop()
  recording.value = false
  releaseStream()
}

/** 录音 Blob → base64 → `stt:transcribe` → 文本追加进输入框；失败走 AppToast 通道 */
async function finishRecording(): Promise<void> {
  const chunks = recordChunks
  recordChunks = []
  const mime = recorder?.mimeType ?? 'audio/webm'
  recorder = null
  if (chunks.length === 0) return
  sttBusy.value = true
  try {
    const blob = new Blob(chunks, { type: mime })
    const audioBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
    const result = await window.aurora.stt.transcribe({ audioBase64, mime })
    if (!result.ok) {
      chatError.value = `语音识别失败：${result.message}`
      return
    }
    const text = result.value.text.trim()
    if (text === '') return
    input.value = input.value.trim() === '' ? text : `${input.value.trimEnd()} ${text}`
  } catch (cause) {
    chatError.value = `语音识别失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    sttBusy.value = false
  }
}

/** 停掉媒体轨道；三条路径（正常停止 / 失败 / 卸载）都收敛到这里 */
function releaseStream(): void {
  for (const track of mediaStream?.getTracks() ?? []) track.stop()
  mediaStream = null
}

/**
 * 彻底丢弃录音（组件卸载 / 切会话）：不再触发转写，只释放资源。
 * 与 `stopRecording()` 的差别是**不**冲刷数据——离开视口后的转写没有意义。
 */
function disposeRecording(): void {
  if (recorder !== null && recorder.state !== 'inactive') {
    recorder.onstop = null
    recorder.stop()
  }
  recorder = null
  recordChunks = []
  recording.value = false
  releaseStream()
}

/** base64（分块编码，避免长录音撑爆函数调用栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function toggleRecording(): void {
  if (recording.value) {
    stopRecording()
    return
  }
  void startRecording()
}

// ───────────────────────── 附件拖拽（docs/07 §2.3） ─────────────────────────

/**
 * 取拖入文件路径。
 * 路径解析必须走 preload（`webUtils.getPathForFile`）：Electron 32 起 `File.path` 已移除。
 * 拿不到路径的条目（如从浏览器拖来的虚拟文件）直接跳过，不假装已附加。
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

/**
 * 附件缩略图（v22 多模态输入，docs/07 §2.3）：图片附件在 chip 上显示一张小图，
 * 非图片 / 超限 / 读失败时只是没有 `dataUrl`，chip 退回纯文字（**不显示裂图**）。
 *
 * 一次性读盘（`chat:readAttachment`，上限 `PREVIEW_MAX_BYTES`）而不是丢个 `file://` 给渲染层：
 * 渲染进程没有 fs 能力，这条通道也是它唯一的读图途径。
 */
const attachmentPreviews = ref<Record<string, ChatAttachmentPreview>>({})

function previewOf(path: string): ChatAttachmentPreview | undefined {
  return attachmentPreviews.value[path]
}

async function loadAttachmentPreview(path: string): Promise<void> {
  if (attachmentPreviews.value[path] !== undefined) return
  const result = await window.aurora.chat.readAttachment({ path })
  if (!result.ok) return
  attachmentPreviews.value = { ...attachmentPreviews.value, [path]: result.value }
}

watch(attachments, (paths) => {
  for (const path of paths) void loadAttachmentPreview(path)
  // 已被移除的附件不再保留预览：那条记录里可能带着几 MB 的 data URL，攒着是纯浪费。
  // 同一个文件再拖进来会重新拉一次（走的是同一条只读通道）。
  const kept: Record<string, ChatAttachmentPreview> = {}
  for (const [path, preview] of Object.entries(attachmentPreviews.value)) {
    if (paths.includes(path)) kept[path] = preview
  }
  attachmentPreviews.value = kept
})

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '' && attachments.value.length === 0) return
  // 流式期间 useChat.send 会直接返回：那样「敲了 Enter 没反应也没提示」。
  // 这里给一句瞬时提示（发送按钮同时是 disabled 的，两处口径一致）。
  if (streaming.value) {
    flashPickerHint('正在回复中，先点「停止」或等它结束')
    return
  }
  const files = attachments.value
  input.value = ''
  attachments.value = []
  await sendMessage(text, files)
  // 新会话此时才有标题，刷新列表让左栏显示出来
  void loadSessions()
}

// ──────────────── 输入区重做（2026-09：对齐主流 Agent Desktop，docs/07 §2.3） ────────────────

/**
 * textarea 自动增高：先在 `auto` 下读 `scrollHeight` 再钉成固定高度。
 *
 * 为什么不用 CSS 的 `field-sizing: content`（Chromium 123+ 支持）：本项目 Electron 的
 * 目标版本尚不稳定支持它，且需要与 `max-height` 配合才能正确出现滚动条 ——
 * 一个 watch + 两行赋值更可控，也让「发送后回落到一行高」有确定的执行点。
 */
const textareaEl = ref<HTMLTextAreaElement | null>(null)
/** 输入框最大高度（px）：超过就内部滚动，避免输入区把消息区挤没 */
const COMPOSER_MAX_HEIGHT = 200

function autoGrow(): void {
  const el = textareaEl.value
  if (el === null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
}

/** `input` 的任何变化（含 v-model 回写、发送后清空、语音转写追加）都要重算高度 */
watch(input, () => {
  void nextTick(autoGrow)
})

// ── 权限档位（三档 v13：`agent.permissionMode` + 老开关 `advanced.confirmSensitiveTools`） ──

/**
 * 当前**生效**档位（含老开关承接的情况）：
 * `readonly` 优先；否则 `advanced.confirmSensitiveTools === false` → `auto`；再否则 `confirm`。
 *
 * 刻意走 `resolvePermissionMode` 而不是直接读 `agent.permissionMode`：老配置里只有
 * `confirmSensitiveTools: false`，直接读会显示成「变更前确认」，而实际生效的是 auto ——
 * 界面显示的档位必须与主进程注册工具 / 弹确认卡时用的那一档一致。
 * 配置还没水合时按 `confirm` 显示：那只是水合前的一帧占位（出厂默认已是 `auto`），
 * 取更保守的一侧 —— 宁可先让用户看到「会确认」，也不先显示成已放权。
 */
const permissionMode = computed<PermissionMode>(() => {
  const settings = settingsStore.settings
  if (settings === null) return 'confirm'
  return resolvePermissionMode(settings)
})

/**
 * 写入权限档位（**镜像规则**：两个字段同时写，避免两处 UI / 两条解析路径各说各话）。
 *
 * - `agent.permissionMode` 是 v13 的档位字段本身；
 * - `advanced.confirmSensitiveTools` 是老开关，保留是因为老配置与其它消费方仍读它：
 *   `auto` ⇒ `false`（它是 auto 的历史表达），`readonly` / `confirm` ⇒ `true`。
 *   只写一个会出现最坏的一类错位：「界面选变更前确认、实际按 auto 生效」。
 *
 * 这是**只有用户界面能走**的路径：两个字段都在 `SETTINGS_READONLY_PREFIXES` 里，
 * AI 的 `set_setting` 一律拒绝改它们（防自我提权）。`settings:update` 只有顶层浅合并语义，
 * 因此 `agent` / `advanced` 两组都要整组展开，别把兄弟键（`tools` / `readonlyPrefixes` 等）写丢。
 */
async function setPermission(mode: PermissionMode): Promise<void> {
  const settings = settingsStore.settings
  if (settings === null) return
  const ok = await settingsStore.update({
    agent: { ...settings.agent, permissionMode: mode },
    advanced: { ...settings.advanced, confirmSensitiveTools: mode !== 'auto' },
  })
  if (!ok) chatError.value = settingsStore.error
}

// ── 斜杠命令（`/`） ──

/** Skill 清单（`skills:list`，只显示 enabled 的；渲染层不缓存第二份） */
const slashSkills = ref<SkillSummary[]>([])

/**
 * 当前输入是否正处于「命令名」区间（`/xxx`）：判定与过滤都是 `slashCommands.ts` 的纯函数，
 * 组件这层只负责把它接到响应式输入上。
 */
const slashQuery = computed<string | null>(() => slashQueryOf(input.value))

/** Esc 关掉这一轮浮层（输入内容一变就重新打开） */
const slashDismissed = ref(false)
watch(
  () => input.value,
  () => {
    slashDismissed.value = false
  },
)

/** 候选：内置命令在前、技能在后（过滤规则见 `filterSlashItems`） */
const slashItems = computed<SlashItem[]>(() => {
  const query = slashQuery.value
  if (query === null || slashDismissed.value) return []
  return filterSlashItems(query, slashSkills.value, streaming.value)
})

const slashOpen = computed(() => slashQuery.value !== null && slashItems.value.length > 0)

/**
 * 输入区浮层的归属（docs/07 §2.3「三个浮层的锚点与层级」）。
 *
 * 三个浮层（斜杠 / 权限 / 上下文详解）锚在**同一张输入卡**上、共用 `--z-flyout`，
 * 因此必须**互斥** —— 同时开着两个只会互相遮挡（曾经斜杠浮层压住权限下拉、
 * 上下文详解卡把整条工具行连同发送键盖死）。斜杠是「输入隐含触发」的，
 * 另外两个是「点击显式打开」的，所以这里只存显式的那一个；
 * 斜杠的可见性由 `showSlash` 把它们一并算进去，避免两处状态各说各话。
 */
const openFlyout = ref<'permission' | 'context' | null>(null)

/** 斜杠浮层是否可见：候选存在，且没有被另外两个显式浮层挤掉 */
const showSlash = computed(() => slashOpen.value && openFlyout.value === null)

/** 一开始输入 `/`（斜杠浮层冒出来）就让另外两个浮层让位 —— 它俩占的是同一块地方 */
watch(slashOpen, (open) => {
  if (open) openFlyout.value = null
})

/** 输入卡根节点：斜杠浮层「点击外部关闭」的判定边界（另两个浮层各自管自己的） */
const composerBoxEl = ref<HTMLElement | null>(null)

/**
 * 点击输入卡外部收起斜杠浮层。
 *
 * 它由输入内容隐含触发、没有「关掉」按钮，所以关闭只能走 `slashDismissed`
 * （与 Esc 同一条通道，输入内容一变即复位重新打开）。
 */
function onComposerPointerDown(event: PointerEvent): void {
  if (!showSlash.value) return
  const target = event.target
  if (target instanceof Node && composerBoxEl.value?.contains(target) === true) return
  slashDismissed.value = true
}

/**
 * Esc 收斜杠浮层 —— 必须挂在 document 上，不能只靠 textarea 的 `onComposerKeydown`。
 *
 * 原因是一个真实可达的状态：输入 `/sys` 让浮层出现 → 点权限钮（`openFlyout` 抢走，浮层隐藏）
 * → 再关掉权限下拉，浮层会**重新出现**，而此刻焦点在权限钮上、不在输入框里，
 * textarea 上的 keydown 收不到 Esc，用户会以为「Esc 坏了」。
 * 判定与 textarea 里那条同源（都写 `slashDismissed`，输入一变即复位），重复触发无副作用。
 */
function onDocumentEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !showSlash.value) return
  slashDismissed.value = true
}

/** 高亮项：`slashItems` 变短时（继续输入）自动收到末项，不会指到数组外 */
const slashIndex = ref(0)
const activeSlashIndex = computed(() =>
  Math.min(slashIndex.value, Math.max(0, slashItems.value.length - 1)),
)
watch(
  () => slashItems.value.length,
  () => {
    slashIndex.value = 0
  },
)

/** 选中一项：命令立即执行，技能补全成 `/技能名 `（焦点留在输入框，光标移到末尾） */
function applySlash(item: SlashItem): void {
  if (item.kind === 'skill') {
    input.value = `/${item.name} `
    void nextTick(() => {
      const el = textareaEl.value
      if (el === null) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      autoGrow()
    })
    return
  }
  input.value = ''
  switch (item.name) {
    case 'new':
      void startNewSession()
      break
    case 'clear':
      clear()
      break
    case 'init':
      // 内置命令：照常走发送链，`/init` 三个字符进历史，主进程把指令正文拼进本轮
      // extraContext（docs/06 §6）——模型读项目结构后用 write_file 生成 / 补全 AGENTS.md
      void sendMessage('/init')
      break
    case 'compact':
      void compactContext()
      break
    case 'stop':
      void abort()
      break
    case 'subagents':
      view.value = 'subagents'
      break
    case 'settings':
      windowStore.show('settings')
      break
    default:
      break
  }
}

/**
 * 输入框的唯一键盘入口。
 *
 * 顺序很重要：**浮层打开时 Enter 属于浮层**（确认高亮项），不能同时把半截命令发出去。
 * 其余情况 `Enter` 发送、`Shift + Enter` 换行（`Ctrl + Enter` 与 `Enter` 等价，历史习惯保留）。
 */
function onComposerKeydown(event: KeyboardEvent): void {
  if (showSlash.value) {
    const total = slashItems.value.length
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      slashIndex.value = (activeSlashIndex.value + 1) % total
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      slashIndex.value = (activeSlashIndex.value - 1 + total) % total
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const item = slashItems.value[activeSlashIndex.value]
      if (item !== undefined) applySlash(item)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      slashDismissed.value = true
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

/**
 * 当前生效**模型**的上下文窗口（token，v23 起随模型绑定）；0 = 未知，
 * 上下文条据此只显示用量、不显示比例。
 */
const currentContextWindow = computed<number>(() => currentModelParams.value?.contextWindow ?? 0)

/**
 * 占位文案（2026-09-29 输入框减负轮）：**只留一句**，不再当说明栏用。
 *
 * 旧版把「Enter 发送 / Shift + Enter 换行 / 输入 / 调用命令与技能 / 可直接拖入文件」
 * 整串塞进占位：文字长度超过一行，而 textarea 由 `autoGrow()` 按**内容**的 scrollHeight
 * 钉住高度（空内容 = 一行 = 行高 20.25px + 上下 padding 8px×2 ≈ 36.25px），占位串换行后的第二行会被直接裁掉 ——
 * 用户看到的就是「可直接拖入文」后面断了半句。
 * 现在：键位说明与其它能力（`/` 命令、拖入文件）**一并**只走 textarea 的 `title`
 * 悬浮提示 —— 工具行右侧那枚常驻的键位提示已移除（2026-10-01 UI 细节轮：
 * 常驻键位提示在窄窗下最先让位、实际多数时候看不见，却一直占着弹性槽）。
 */
const placeholder = computed(() => (streaming.value ? '正在回复中，可继续输入…' : '输入消息…'))

/** 输入框悬浮提示：占位串里放不下的那部分能力说明（键位说明现在只在这里） */
const composerTitle = computed(() =>
  streaming.value
    ? '正在回复中，可继续输入；回复结束后按 Enter 发送'
    : 'Enter 发送，Shift + Enter 换行；输入 / 调用命令与技能；可直接拖入文件',
)

// ───────────────────────── 模式引导（交互语义不变） ─────────────────────────

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
</script>

<template>
  <div class="app-shell anim-window">
    <!-- ── 左栏：品牌 / 新对话 / 快速对话面板 / 会话列表 / 底部工具 ── -->
    <aside
      ref="navEl"
      class="nav glass-shell rail-surface anim-shell-left"
      :class="{ collapsed: !navOpen }"
      :style="{ '--nav-w': `${navEffWidth}px` }"
    >
      <!--
        拖拽调宽把手（右缘 6px 竖条，cursor: col-resize）：与右栏同一套实现
        （`startColumnResize`），宽度存 localStorage、200–520px 夹取、
        实际渲染宽度再受「主区下限」约束（`navEffWidth`，见上文注释）、双击复位。
        收起态不渲染（width 为 0 时把手没有意义）。
      -->
      <div
        v-if="navOpen"
        class="nav-resizer"
        data-field="chat.nav-resizer"
        title="拖动调宽；双击复位"
        @pointerdown="onNavResizeStart"
        @dblclick="resetNavWidth"
      />
      <!--
        左栏固定项已整体收进 SessionNav（2026-09-30 去杂糅：任务入口从本组件迁入，
        不再一处两式）。`chat.jobs-entry` 锚点随按钮迁走，面板容器锚点仍是 `chat.jobs`。
      -->
      <SessionNav
        :project-groups="projectGroups"
        :work-sessions="workSessions"
        :agent-sessions="agentSessions"
        :archived-sessions="archivedSessionItems"
        :active-id="sessionId"
        :right-open="contextOpen"
        :view="view"
        :subagent-count="subagentRuns.length"
        :subagent-running="subagentRunning"
        :jobs-count="jobs.length"
        :jobs-running="jobsRunning"
        :jobs-open="jobsOpen"
        @new-session="startNewSession"
        @new-agent-session="startAgentSession"
        @new-project-session="startProjectSession"
        @add-project="addProject"
        @new-work-session="startWorkSession"
        @select="selectSession"
        @archive-session="(id, archived) => void setArchived(id, archived)"
        @open-subagents="view = 'subagents'"
        @open-automations="view = 'automations'"
        @toggle-right-panel="contextOpen = !contextOpen"
        @toggle-jobs="toggleJobs"
        @open-settings="windowStore.show('settings')"
      />
    </aside>

    <!-- ── 主区 ── -->
    <main class="main anim-pane">
      <!--
        双击头部拖动区 = 切换最大化：frame:false 窗口的 drag region 双击由 Windows 原生接管
        （`maximizable: true` 后 WM_NCLBUTTONDBLCLK 语义），页面侧不再挂 dblclick——
        拖动区收不到页面鼠标事件，重复挂只会造成双重切换。最大化期间几何不落盘（persistGeometry 跳过）。
      -->
      <header class="head glass-bar" :class="[dragClass, { 'head--corner': !contextOpen }]">
        <button
          type="button"
          class="icon-btn press"
          :title="navOpen ? '收起侧栏' : '展开侧栏'"
          :aria-expanded="navOpen"
          @click="navOpen = !navOpen"
        >
          <PanelLeft :size="15" :stroke-width="1.5" aria-hidden="true" />
        </button>
        <StatusDot :tone="statusTone" title="AI 状态" />
        <strong class="head-name">{{ currentTitle }}</strong>
        <!--
          已归档提示条（docs/07 §2.3）：归档只是标记——当前会话被归档时**不切走、不清空**，
          对话内容留在原地继续可读，这里只给一条明确的状态 + 一次性撤销入口。
          当前会话不在归档态时不渲染（含 quick / settings 两个伪会话，它们不参与归档）。
        -->
        <span v-if="currentArchived" class="badge archive-banner" data-field="chat.archived-banner">
          已归档
          <button
            type="button"
            class="archive-banner-action press"
            data-action="chat.unarchive-current"
            title="取消归档（对话内容不受影响）"
            @click="void setArchived(sessionId, false)"
          >
            取消归档
          </button>
        </span>
        <span v-if="settingsStore.needsOnboarding" class="badge warn">未配置模型</span>
        <span class="grow" />
        <div class="head-actions" :class="noDragClass">
          <button
            type="button"
            class="icon-btn press"
            title="清空当前消息区（不影响已保存的会话历史）"
            aria-label="清空当前消息区"
            @click="clear"
          >
            <Trash2 :size="15" :stroke-width="1.5" aria-hidden="true" />
          </button>
        </div>
        <!--
          窗口按钮**不再**排在这里：三枚 caption 按钮固定挂在窗口右上角
          （`.window-caption`，app-shell 直属子节点，`position: fixed`）—— 与设置窗同一套
          做法。此前它们排在主区标题栏末尾：右栏一宽，主区标题栏装不下整组按钮，
          按钮就被推出主区、压在右栏的 tab 上（2026-10-03 用户实测）。
          右栏收起时主区右缘就是窗口右缘，标题栏靠 `--caption-w` 让位（`.head--corner`）。
        -->
      </header>

      <!--
        Agent 提问卡片（`ask_user`，docs/06 §21）：与确认卡片同区域、同款交互语言，
        但语义是**协作**（超时按未回答继续、可跳过）。两者可以同时在场：确认问的是
        「要不要执行这个敏感动作」，提问问的是「这件事你想怎么办」，互不替代。
      -->
      <AskUserCard
        v-for="request in askUserRequests"
        :key="request.requestId"
        :request="request"
        :data-session-id="request.sessionId"
        @resolved="resolveAskUser(request.requestId)"
      />

      <SensitiveToolCard
        v-if="sensitiveRequest"
        :key="sensitiveRequest.confirmId"
        :request="sensitiveRequest"
        class="sensitive-host"
        @resolved="resolveSensitive"
      />

      <div
        v-if="view === 'chat'"
        class="thread"
        :class="{ dragging, streaming }"
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

        <!-- 朗读失败：独立 toast，4 秒后自动收起（不长时间驻留） -->
        <AppToast v-if="ttsErrorToast" tone="error">朗读失败：{{ ttsErrorToast }}</AppToast>
        <AppToast v-if="centerRuntimeNotice" tone="warn">{{ centerRuntimeNotice }}</AppToast>

        <MessageList
          :key="sessionId"
          :session-id="sessionId"
          :messages="messages"
          empty-hint="这是 Aurora 主界面：可以问系统状态、让 Aurora 帮忙整理资料，也可以直接把文件拖进来。"
          :tts-available="ttsReady"
          :speaking-id="tts.speaking.value"
          :tts-loading-id="tts.loading.value"
          :streaming="streaming"
          :show-thinking="showThinking"
          :thinking-target-id="reasoningTargetId"
          :settled-request-id="lastSettledRequestId"
          :settled-at="lastSettledAt"
          :latest-turn-groupable="latestTurnGroupable"
          @speak="speakMessage"
          @stop-speak="tts.stop"
        />
      </div>

      <footer v-if="view === 'chat'" class="composer">
        <div class="composer-inner">
          <div v-if="attachments.length > 0" class="attachments">
            <!--
              附件 chip（v22 起图片带缩略图，docs/07 §2.3）：
              图片 → `data:` URL 渲染 48×48 小图（CSP 的 `img-src 'self' data:` 放行），
              非图片 / 超限 / 读失败 → 只有文件名（`title` 里给出未生成缩略图的原因）。
              `show-thumb` 这个类只影响图片 chip 的内边距，纯文字 chip 的观感与从前一致。
            -->
            <span
              v-for="path in attachments"
              :key="path"
              class="chip tiny"
              :class="{ 'show-thumb': previewOf(path)?.dataUrl !== undefined }"
              :title="previewOf(path)?.note ?? fileNameOf(path)"
            >
              <img
                v-if="previewOf(path)?.dataUrl !== undefined"
                class="chip-thumb"
                :src="previewOf(path)?.dataUrl"
                :alt="fileNameOf(path)"
              />
              {{ fileNameOf(path) }}
              <button
                type="button"
                class="chip-remove"
                aria-label="移除附件"
                @click="removeAttachment(path)"
              >
                <X :size="11" :stroke-width="2.4" aria-hidden="true" />
              </button>
            </span>
          </div>

          <div ref="composerBoxEl" class="composer-box glass-surface-strong" :class="{ streaming }">
            <!--
              斜杠命令浮层（2026-09 输入框重做）：贴在输入卡上方。
              键盘（↑↓ / Enter / Tab / Esc）由下面 textarea 的 onComposerKeydown 统一处理，
              浮层只是键位操作的可视反馈，焦点始终留在输入框里。
              与另外两个浮层**互斥**：`showSlash` 已经把「权限 / 上下文详解 正开着」排除在外。
            -->
            <SlashCommandMenu
              v-if="showSlash"
              :items="slashItems"
              :active-index="activeSlashIndex"
              @select="applySlash"
              @hover="slashIndex = $event"
            />

            <!--
              输入区：`rows=1` + 自动增高（`autoGrow`）——高度由 JS 按 scrollHeight 钉住，
              因此 CSS 里不保留 `resize`（手动拖动会与自动增高互相打架）。
            -->
            <textarea
              ref="textareaEl"
              v-model="input"
              class="composer-input"
              rows="1"
              spellcheck="false"
              :placeholder="placeholder"
              :title="composerTitle"
              @keydown="onComposerKeydown"
            />

            <div class="composer-bar">
              <!-- 权限档位（只读 / 变更前确认 / 完全权限）：两档时代写 advanced.confirmSensitiveTools，v13 起镜像写两个字段 -->
              <ComposerPermissionSelect
                :mode="permissionMode"
                :open="openFlyout === 'permission'"
                :disabled="settingsStore.settings === null"
                @change="setPermission"
                @update:open="openFlyout = $event ? 'permission' : null"
              />
              <!-- 模型 / 思考等级（2026-09 移入 composer 工具行）：data-field 锚点不变 -->
              <ModelPickerSelect
                class="composer-picker"
                :selection="modelPicker?.choice ?? null"
                :sources="modelPicker?.sources ?? []"
                :source-id="modelPicker?.sourceId ?? null"
                :disabled="modelPicker?.choice === null"
                :title="modelTitle"
                @update:source="setModelSource"
                @update:selection="setModel"
              />
              <ThinkingLevelSelect
                class="composer-picker"
                :model-value="effortValue"
                :disabled="effort === null || centerModelReadOnly"
                :title="effortTitle"
                @update:model-value="setEffort"
              />
              <span class="grow" />
              <!--
                保存类操作的瞬时提示（2 秒自灭）。它是工具行右侧**唯一**的提示文案：
                旧常驻「会话：xxx · 可调用 Skill…」meta 与常驻键位提示都已移除
                （键位说明改由 textarea 的 `title` 承担）。宽度不够时它仍第一个让位。
              -->
              <span v-if="pickerHint" class="tiny muted picker-hint">{{ pickerHint }}</span>
              <!--
                麦克风（STT）：门控口径同 TTS——未配置可用的 provider 时**不渲染**（不是 disabled）。
                录音态套 `.pulse-ring` 扩散环（theme.css 动效基线）。与发送键同侧，
                对齐主流 Agent Desktop 的「输入动作在右」动线。
              -->
              <button
                v-if="sttReady"
                type="button"
                class="icon-btn mic press"
                data-field="chat.mic"
                :class="{ recording, busy: sttBusy }"
                :title="recording ? '停止录音并转写' : '语音输入'"
                :aria-label="recording ? '停止录音' : '开始语音输入'"
                @click="toggleRecording"
              >
                <span v-if="recording" class="mic-ring pulse-ring" aria-hidden="true" />
                <Mic :size="15" :stroke-width="1.6" aria-hidden="true" />
              </button>
              <AppButton v-if="streaming" size="sm" @click="abort">停止</AppButton>
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
                  <ArrowUp class="icon" :size="15" :stroke-width="2.2" aria-hidden="true" />
                </AppButton>
              </span>
            </div>

            <!-- 输入框最底部：上下文详解（占用比例 + token 用量，点开看明细） -->
            <ComposerContextBar
              :latest="usage.latest"
              :totals="usage.totals"
              :context-window="currentContextWindow"
              :open="openFlyout === 'context'"
              :model="effectiveModelLabel"
              :streaming="streaming"
              @update:open="openFlyout = $event ? 'context' : null"
            />
          </div>
        </div>

        <!--
          长任务暂停提示（`done` 的 pendingReason，docs/06 §4.1）：挂在 composer 里而不是
          消息滚动区里 —— 滚动区的浮层会被自动滚底推走，而这条恰恰是「要你点继续」。
          下一次发送 / 清空 / 切会话时由 useChat 复位。
        -->
        <AppToast v-if="pendingNotice" tone="warn">{{ pendingNotice }}</AppToast>
        <AppToast v-if="chatError" tone="error">{{ chatError }}</AppToast>
      </footer>
      <template v-else>
        <!--
          子代理页面（docs/07 §2.3）：替换主区内容，输入区与右栏照旧。
          上面那段 thread + composer 用 v-if 收在 view === 'chat' 分支里。
          两个页面用全局 fade 过渡切换（theme.css 预设），主区不再硬切。
        -->
        <Transition name="fade" mode="out-in">
          <SubagentPage
            v-if="view === 'subagents'"
            key="subagents"
            :runs="subagentRuns"
            :session-title="currentSessionTitle"
            @back="view = 'chat'"
          />
          <!--
            自动化页面（docs/13 §11）：与子代理页同构的主区替换内容。
            双 tab（Agent / Normal）+ 编辑器与历史弹窗都在组件内自持。
          -->
          <AutomationPage v-else key="automations" @back="view = 'chat'" />
        </Transition>
      </template>
    </main>

    <!-- ── 右栏：功能 tab（文件 / 上下文）+ 可拖拽调宽（2026-10-03，docs/07 §2.3） ── -->
    <aside
      class="context glass-shell rail-surface rail-surface-end anim-shell-right"
      :class="{ collapsed: !contextOpen }"
      :style="{ '--ctx-w': `${ctxEffWidth}px` }"
    >
      <!--
        拖拽调宽把手（左缘 6px 竖条，cursor: col-resize）：宽度存 localStorage
        （视图偏好不进 config schema，与 docs/07 的既定原则一致），280–720px 夹取；
        **实际渲染宽度**再受「主区下限」约束（`ctxEffWidth`：窗口 − 左栏 − 420），
        窗口最大化时能拖到 720，小窗口下自动收窄。双击复位默认宽。
        收起态不渲染（width 为 0 时把手没有意义）。
      -->
      <div
        v-if="contextOpen"
        class="ctx-resizer"
        data-field="chat.ctx-resizer"
        title="拖动调宽；双击复位"
        @pointerdown="onCtxResizeStart"
        @dblclick="resetCtxWidth"
      />
      <!--
        标签条（`CtxTabStrip`）：浏览器式多标签 —— 「＋」开新标签、「＋N」折叠溢出、
        滑动窗口保证激活标签可见、右端按 `--caption-w` 给窗口三键让位。锚点口径：
        `chat.ctx-tabs` / `chat.ctx-tab-<id>` / `chat.ctx-tab-close-<id>` /
        `chat.ctx-tab-more` / `chat.ctx-new-tab`（菜单：`chat.ctx-more-menu` /
        `chat.ctx-new-menu` / `chat.ctx-new-<kind>`）。
      -->
      <CtxTabStrip
        class="glass-surface-strong"
        :tabs="ctxTabs"
        :active-id="ctxActiveId"
        @activate="activateCtxTab"
        @close="onCloseCtxTab"
        @new-tab="onNewCtxTab"
      />
      <div class="ctx-panes">
        <!--
          右栏空标签态：标签全关后，重开入口直接留在右栏正文区 ——
          `chat.tool-shortcuts` / `chat.tool-open-<kind>` 仍是原探针锚点。
        -->
        <CtxQuickAccess v-if="ctxTabs.length === 0" @open="openCtxTabFromEmpty" />
        <template v-for="tab in ctxTabs" :key="tab.id">
          <!--
            「上下文」标签：任务面板（JobPanel）+ 模式感知上下文栏（ContextPanel），
            两行网格语义与 tab 化之前逐字一致（jobs 在 auto 行、上下文栏在 1fr 行）。
            **维持 v-if 口径**（激活才挂载）：它没有本地状态，而旧断言 `jobsHiddenOnFiles`
            （files 下 `chat.jobs` 必须缺席）正依赖这条语义（docs/07 §2.3）。
          -->
          <div
            v-if="tab.kind === 'context' && tab.id === ctxActiveId"
            class="ctx-pane ctx-pane-context"
            :data-tab-kind="tab.kind"
            :data-tab-id="tab.id"
          >
            <Transition name="fade">
              <div v-if="jobsOpen" class="jobs-host" data-field="chat.jobs">
                <JobPanel :jobs="jobs" @resume="onResumeJob" @cancel="onCancelJob" />
              </div>
            </Transition>
            <ContextPanel :todos="currentTodos" />
          </div>
          <!--
            文件 / 终端 / 浏览器标签：**首次激活挂载、之后常驻**（切走只是 display:none）——
            网页不重载、xterm 不重建。所有窗格叠在同一格 grid 里（`.ctx-pane` 的 grid-area），
            隐藏态不占位，因此面板尺寸在激活时一次到位（xterm 的 ResizeObserver 靠它重排）。
          -->
          <div
            v-else-if="tab.kind !== 'context' && ctxMountedTabs.has(tab.id)"
            v-show="tab.id === ctxActiveId"
            class="ctx-pane"
            :data-tab-kind="tab.kind"
            :data-tab-id="tab.id"
          >
            <FilePreviewPanel
              v-if="tab.kind === 'files'"
              :session-id="sessionId"
              :project-name="currentProjectName"
              @title="(title) => setCtxTabTitle(tab.id, title)"
            />
            <!-- 终端是单列 flex（组件内部自管布局与滚动），不吃两行网格 -->
            <TerminalPanel
              v-else-if="tab.kind === 'terminal'"
              :session-id="sessionId"
              @title="(title) => setCtxTabTitle(tab.id, title)"
            />
            <BrowserPanel
              v-else
              :target="tab.id === panelTargetTabId ? panelTarget : null"
              :active="tab.id === ctxActiveId"
              @title="(title) => setCtxTabTitle(tab.id, title)"
              @new-tab="onNewCtxTab('browser')"
            />
          </div>
        </template>
      </div>
    </aside>

    <!--
      Windows 式窗口按钮（最小化 / 最大化 / 关闭）：**固定挂在窗口右上角**，不参与主区
      标题栏的流式排布 —— 右栏展开时它就落在右栏 tab 条的右端（tab 条已按 `--caption-w`
      让位，两者不会叠）。与设置窗同款（settings/App.vue 也是 fixed 到右上角）。
      组件内部的按钮自带 `.no-drag`，不破坏标题栏拖动区。
    -->
    <WindowCaption window="chat" class="window-caption" />

    <!--
      左栏动作的结果提示（「添加项目」成功 / 失败，2026-10-01）：挂在 app-shell 层而不是
      composer 里 —— composer 只在 `view === 'chat'` 时挂载，而左栏那个按钮在子代理 /
      自动化页照样能点，提示必须跟着它走。`pointer-events: none` 保证不挡住左栏底部的按钮。
    -->
    <div v-if="projectNotice !== null" class="shell-toast" data-field="chat.project-notice">
      <AppToast :tone="projectNotice.tone">{{ projectNotice.text }}</AppToast>
    </div>
  </div>
</template>

<style scoped>
/**
 * 三栏 grid（spec §3）：左栏 240px（可调 200–520）· 主区自适应（**下限 420**）· 右栏 384px
 * （可调 280–720）。两侧栏的实际渲染宽度由 `navEffWidth` / `ctxEffWidth` 算好后内联进
 * `--nav-w` / `--ctx-w`（`min(期望, 窗口 − 另一侧 − 420)`）。
 * 折叠用「宽度收 0 + 内容固定宽被裁剪」而不是 v-show：display:none 没有过渡，
 * 而宽度过渡能让侧栏沿 --ease-spring 滑入滑出（prefers-reduced-motion 全局降级）。
 *
 * ⚠️ `grid-template-columns: minmax(0, 1fr)` 不能省（2026-10-03 实测踩过）：隐含的
 * `auto` 列表格轨的下限是**内容的 min-content**，预览一份带长代码行的文件时整栏内容
 * 会横向撑破 aside —— 表现是「文字被窗口右缘切断、目录条上的按钮整排消失」
 * （它们被推到可视区之外，DOM 里还在，所以只查 DOM 的探针全绿）。minmax(0, 1fr) +
 * 面板内的 min-width:0 把内容锁在栏宽内，超出部分由面板自己滚动。
 *
 * `--head-h` / `--caption-w` 是**顶部横带**的两个常量：主区标题栏与右栏 tab 条同高，
 * 窗口按钮固定在这条带的右端（tab 条按 `--caption-w` 让位，两者不叠）。
 */
.app-shell {
  --head-h: 48px;
  /** caption 三键的整组宽度（3 × 44px，见 WindowCaption）：右栏 tab 条按它让位 */
  --caption-w: 132px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  height: 100vh;
  overflow: hidden;
  background: transparent;
  color: var(--text-primary);
}

/*
 * 左栏动作的结果提示：固定在窗口左下角（浮在左栏之上，不参与三栏 grid 排版）。
 * 不挡点击（`pointer-events: none`）—— 它可能盖住左栏底部的模式徽章 / 设置齿轮。
 */
.shell-toast {
  position: fixed;
  left: var(--space-3);
  bottom: var(--space-3);
  z-index: 60;
  max-width: 320px;
  pointer-events: none;
}

/* ── 左栏 / 右栏的公共折叠语义 ── */
.nav,
.context {
  overflow: hidden;
  transition:
    width var(--dur-base) var(--ease-spring),
    opacity var(--dur-base) var(--ease-standard),
    border-color var(--dur-base) var(--ease-standard);
}

.nav {
  /**
   * 宽度可拖拽（2026-10-03）：内联 `--nav-w` 已经是**实际生效宽度**（`navEffWidth` =
   * `min(期望值, 窗口 − 右栏 − 主区下限)`），所以栏内所有「跟栏等宽」的子元素
   * （SessionNav 的 `.nav-inner`）读同一个变量即可 —— 一是窗口缩小时不会比 aside 还宽，
   * 二是折叠动画期间内容按固定宽排版、不跟着挤压换行。
   */
  width: var(--nav-w, 240px);
  position: relative;
  /* 左栏固定项已整体收进 SessionNav：单行网格，SessionNav 占满整栏（含底部固定项） */
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  /* 同右栏：锁住横向 —— 长会话标题不许把栏撑破（撑破会连底部固定项一起挤出可视区） */
  grid-template-columns: minmax(0, 1fr);
}

.context {
  /** 宽度可拖拽（2026-10-03）：内联 `--ctx-w` 同样是**实际生效宽度**（`ctxEffWidth`）。
   *  JobPanel / ContextPanel 读同一个变量。 */
  width: var(--ctx-w, 384px);
  position: relative;
  /**
   * 两行网格：tab 条（auto）+ 功能窗格（占满剩余高度）。
   * 列轨用 `minmax(0, 1fr)` 而不是隐含 auto：auto 的下限是内容 min-content，
   * 预览带长行的文件时会把整栏撑宽（按钮被挤出可视区，见 .app-shell 的注释）。
   */
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
}

/* 拖拽调宽把手：左右栏各贴自己的内缘（6px 竖条，可命中区比视觉宽），hover / 拖拽中亮起 */
.ctx-resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 5;
  cursor: col-resize;
}

.nav-resizer {
  position: absolute;
  right: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 5;
  cursor: col-resize;
}

.ctx-resizer:hover,
.nav-resizer:hover,
body.col-resizing .ctx-resizer,
body.col-resizing .nav-resizer {
  background: var(--aurora-blue);
  opacity: 0.4;
}

/* 拖拽中关掉宽度过渡（否则每帧都在追 animated width，拖不动也拖不跟手）+ 禁止选中文字 */
body.col-resizing {
  user-select: none;
}

body.col-resizing .context,
body.col-resizing .nav {
  transition: none;
}

/*
 * 功能标签条已整体迁进 `components/CtxTabStrip.vue`（多标签：开 / 关 / ＋N 折叠 /
 * 滑动窗口 / 三键让位都在那里）—— 不要再在本组件里写 `.ctx-tabs` / `.ctx-tab` 样式：
 * scoped 样式对子组件**根元素**同样生效，两处并存会互相覆盖。
 */

/* 窗格容器：所有标签的面板**叠在同一格 grid** 里（`.ctx-pane` 的 grid-area: 1/1） */
.ctx-panes {
  display: grid;
  min-height: 0;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}

/*
 * 每个标签一个窗格，全部占同一格（1/1）：激活的那个在流内，其余 `display:none`
 * （v-show）—— 隐藏态不占位，因此没有「两个面板并排」的中间态。
 */
.ctx-pane {
  grid-area: 1 / 1;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  min-width: 0;
  /* 面板内容再宽也只在自己内部滚动，绝不撑破右栏 */
  overflow: hidden;
}

/* 文件预览 / 终端 / 浏览器面板是单列 flex（组件内部自管滚动），不吃两行网格 */
.ctx-pane > :deep(.fp),
.ctx-pane > :deep(.tp),
.ctx-pane > :deep(.bp) {
  grid-row: 1 / -1;
  min-height: 0;
}

/* 任务面板容器（上下文 tab 第一行）：宽度跟着栏走，高度由面板内容决定 */
.jobs-host {
  grid-row: 1;
  min-width: 0;
}

/* ContextPanel 的根（`.ctx-inner`）恒在第二行：收起任务面板时它独占整列 */
.ctx-pane-context > .ctx-inner {
  grid-row: 2;
}

.nav.collapsed,
.context.collapsed {
  width: 0;
  opacity: 0;
  border-color: transparent;
}

/* ── 主区：头部（拖动）/ 消息滚动区 / composer ── */
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100vh;
  /*
   * 主区是透明 body 上最大的阅读面：保留原生 Acrylic 的桌面层次，但加一层低透明度
   * 内容 tint，避免后方窗口文字直接穿过正文。侧栏 / 标题栏仍用各自更厚的玻璃层。
   */
  background-color: var(--glass-content);
}

.head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  /* 右侧不留内边距：窗口按钮固定贴在窗口右缘（Windows 习惯），由 `.head--corner` 让位 */
  padding: var(--space-2) 0 var(--space-2) var(--space-4);
  min-height: var(--head-h, 48px);
  border-bottom: 1px solid var(--border-subtle);
}

/*
 * 窗口按钮固定挂在窗口右上角：右栏收起时主区右缘就是窗口右缘，标题栏末尾的
 * 「清空」按钮会正好落在 caption 三键底下 —— 这一档补上让位宽度。
 * 右栏展开时按钮落在右栏 tab 条那侧（tab 条自己让位），标题栏不需要留白。
 */
.head--corner {
  padding-right: var(--caption-w, 132px);
}

/*
 * Windows 式窗口按钮整组：`position: fixed` 贴窗口右上角（与设置窗同款），
 * 高度与顶部横带一致（`--head-h`），悬停底色因此与标题栏、tab 条连成一条。
 */
.window-caption {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 30;
  display: flex;
  height: var(--head-h, 48px);
}

.head-name {
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.head .badge.warn {
  flex: 0 0 auto;
}

/**
 * 已归档提示条（docs/07 §2.3）。
 * 底色刻意不用 `.badge` 的默认 `--fill-1`——头部背景本身就是 `--fill-1`，那样整条看不见；
 * 换成 `--fill-2` + 发丝描边，与「未配置模型」徽章并排时层级一致。
 */
.archive-banner {
  flex: 0 0 auto;
  gap: var(--space-2);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
  color: var(--text-secondary);
}

/* 撤销入口：语义强调色（浅色档为深蓝），与左栏归档分组的中性灰刻意区分 */
.archive-banner-action {
  color: var(--accent-text);
  font-weight: var(--weight-medium);
}

.archive-banner-action:hover {
  text-decoration: underline;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* 头部 / composer 共用的圆形图标按钮 */
.icon-btn {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.icon-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sensitive-host {
  flex: 0 0 auto;
  margin: var(--space-2) var(--space-4) 0;
}

/* 消息滚动区：useStickToBottom 从 MessageList 向上找到的第一个 overflow-y 容器 */
.thread {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  /*
   * 关掉浏览器的**滚动锚定**（2026-09-30 跟丢修复轮）：
   * 它会在内容长高时自行调整 `scrollTop` 来"保持可见内容"，与我们自己的逐帧对齐是两套
   * 互不知情的补偿 —— 两者叠加就是"滚动条偶尔停在半路"的来源之一（锚定的调整发生在
   * 我们读完之后、写之前）。跟随逻辑既然自己每帧对齐到底，就不需要浏览器再补偿一次。
   */
  overflow-anchor: none;
  padding: var(--space-3) var(--space-4);
}

/* 内容列居中（2026-09 重构）：消息与提示不铺满整宽，对齐主流 Agent Desktop 的阅读动线。
   .messages 的 min-height: 100% 不受影响——高度仍由 .thread 决定，只是宽度收进列宽。 */
.thread > * {
  width: 100%;
  max-width: 860px;
  margin-left: auto;
  margin-right: auto;
}

/* 拖拽悬停反馈：对话区整体描边，避免用户不确定有没有拖对地方 */
.thread.dragging {
  outline: 1px dashed var(--aurora-blue);
  outline-offset: -6px;
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.drop-hint {
  margin: 0;
  text-align: center;
  /* 提示文案属正文：用语义强调色（浅色档为深蓝），直接写品牌蓝在浅色基座上只有 3.14:1 */
  color: var(--accent-text);
}

/**
 * 流式光标：只挂在**最后一条助手消息**正文的末尾。
 * 用父级 `.streaming` + `::after` 实现，不碰 MessageList 的 props，也不会在每条 delta
 * 上重放整段进场动画（`.rise-*` 只在插入新消息时生效）。
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
  animation: aurora-caret var(--dur-caret) steps(1, end) infinite;
}

/**
 * 流式正文的「湿润边缘」：最后一行微微淡出，像墨还没干。
 *
 * 为什么不做逐字打字机：正文是 `v-html` 渲染的 markdown，每个 delta 都会整体重设
 * `innerHTML`（Vue 对 v-html 不做 DOM diff）——按节点挂进场动画会在每个 chunk 上重放，
 * 快速流式时整块一直停在半透明；按帧做真正的打字机则要每帧重解析 markdown。
 * 用一层跟随内容增长的遮罩，既有"还在写"的观感，又零额外开销、不误伤已读内容。
 * 流式结束（`.streaming` 摘掉）遮罩一并消失，正文回到全清晰。
 */
.thread.streaming :deep(.message.r-assistant:last-of-type .md) {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 1.4em), rgba(0, 0, 0, 0.45));
}

/* ── 输入区 ── */
.composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4) var(--space-4);
  border-top: 1px solid var(--glass-border-soft);
}

/* 输入卡与消息列同轴心：同一根 860px 中轴线上下贯通 */
.composer-inner {
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
}

.chip-remove {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

/* 图片附件 chip（v22 多模态输入，docs/07 §2.3）：左侧 24×24 缩略图（与 `chip tiny` 同高）。
   `cover` 让非正方形图不拉伸；chip 的左侧内边距收窄一档，让图与胶囊边距一致。 */
.chip.show-thumb {
  padding: 2px 8px 2px 2px;
}

.chip-thumb {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm, 4px);
  object-fit: cover;
  flex: none;
}

.chip-remove:hover {
  color: var(--text-primary);
}

/**
 * 输入卡（2026-09-29 输入框减负轮）：内边距与行距都收紧一档，
 * 让「文字 → 工具行 → 上下文条」三段贴得更紧，卡本身不再是页面上最重的一块。
 */
.composer-box {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3) var(--space-1);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border-soft);
  background-color: var(--glass-input);
  transition:
    border-color var(--transition-base),
    box-shadow var(--transition-base);
}

/* 聚焦时以语义令牌提供紧凑的 1px 边界。 */
.composer-box:focus-within {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

/**
 * 输入区（2026-09 输入框重做，2026-09-29 减负轮收紧）。
 *
 * 高度由 `autoGrow()` 按 `scrollHeight` 钉住（1 行起步、最多 200px 后内部滚动），
 * 因此这里**不设 min/max-height 也不留 `resize`** —— 手动拖动会和自动增高互相打架，
 * 结果是「发完消息输入框还是刚才拖出来的高度」。
 * `overflow-y: auto` 是超出上限后的兜底（此时才出现滚动条）。
 *
 * `min-height` 是「空内容 = 一行」的显式声明（一行 = 行高 + 上下 padding）：
 * 占位文案必须能完整放进这一行 —— 放不下就会换行，而换行后的第二行在空内容高度里
 * 会被直接裁掉（2026-09-29 用户实测就是这个：占位串太长，末尾半句消失）。
 */
.composer-input {
  display: block;
  width: 100%;
  height: auto;
  min-height: calc(var(--text-base) * var(--leading-normal) + 2 * var(--space-2));
  max-height: 200px;
  padding: var(--space-2) 0;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  overflow-y: auto;
  resize: none;
  outline: none;
}

.composer-input::placeholder {
  color: var(--text-muted);
}

/* 工具行（2026-09-29 减负轮）：三枚 28px 芯片 + 弹性槽 + 右侧动作钮，间距收到 4px，
   整行不再是一条「带边框的工具栏」——三个控件零边框、悬停才出现分层填充。
   `overflow: hidden` 是最后的兜底：三枚芯片都参与收缩（权限最后让位），但任何极端
   宽度（超窄窗 / 高 DPI）下内容都只会在行内被裁剪，绝不溢出输入卡的圆角边框
   （用户实测「权限文字超出组件边框」的根因就是本行此前既不收缩也不裁剪）。 */
.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

/* 保存类操作的瞬时提示：出现时挤占的是弹性空隙，不把发送按钮挤出行外 */
.picker-hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 发送按钮不允许被压缩：它被挤出圆角输入框是这一行最容易破的版 */
.send-slot {
  flex: 0 0 auto;
}

/* 发送按钮为圆形图标钮，与 mic 同高 */
.send-slot :deep(.aurora-button) {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--radius-pill);
}

.icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ── 麦克风（STT）：录音态红描边 + `.pulse-ring` 扩散环（theme.css 动效基线） ── */
.icon-btn.mic {
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
}

.icon-btn.mic:hover {
  border-color: var(--border-strong);
}

.icon-btn.mic.busy {
  color: var(--text-muted);
}

.icon-btn.mic.recording {
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
}
</style>
