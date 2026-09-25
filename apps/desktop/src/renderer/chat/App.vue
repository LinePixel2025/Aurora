<script setup lang="ts">
/**
 * Aurora 主界面（BetaV2，Design/betav2-spec.md §2/§3）：1120×720 的三栏布局。
 *
 * 左栏（SessionNav）：品牌 / 新对话 / 固定项「快速对话」（切到 quick 会话）/
 * 会话列表 / 模式徽章 + 右栏开关 + 设置。
 * 主区：头部（侧栏开关 + 会话标题 + 清空 + Windows 式窗口按钮）→ MessageList → composer
 * （模型 / 思考等级下拉已移入 composer 工具行，对齐主流 Agent Desktop）。
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
 * docs/07 §2.4；子代理页不属于任何会话，切过去不动 chat 的会话状态）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  LlmProviderConfig,
  SensitiveToolRequest,
  SkillSummary,
  SttProviderConfig,
} from '@aurora/shared'
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
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
import SessionNav from './components/SessionNav.vue'
import SubagentPage from './components/SubagentPage.vue'
import { useChat } from '../shared/composables/useChat.js'
import { useTts } from '../shared/composables/useTts.js'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { useModeStore, useSettingsStore, useWindowStore } from '../shared/stores.js'
import { parseTodoWriteInput, type TodoRow } from '../shared/agentTodo.js'
import { filterSlashItems, slashQueryOf, type SlashItem } from './slashCommands.js'
import { ArrowUp, Mic, PanelLeft, Trash2, X } from '../shared/icons.js'

const chat = useChat('chat', 'main')
const {
  sessionId,
  messages,
  sessions,
  streaming,
  error: chatError,
  statusTone,
  reasoningTargetId,
  subagentRuns,
  usage,
  send: sendMessage,
  abort,
  clear,
  hydrate,
  loadSessions,
  switchSession: rawSwitchSession,
  newSession,
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
 * 主区内容（2026-09 新增，docs/07 §2.4）：对话流 / 子代理页面。
 *
 * 刻意**不做成会话切换** —— 子代理页不属于任何 `sessionId`，切过去不该动 chat 的
 * 会话状态（否则会触发水合、清空正在看的消息）。它只替换 `.thread` 区域，
 * 输入区与右栏保持原样，随时可以切回来继续问。
 */
const view = ref<'chat' | 'subagents'>('chat')
/** 子代理页副标题：当前会话在列表里的标题（列表尚未加载时退化为固定文案） */
const currentSessionTitle = computed(
  () => sessions.value.find((item) => item.id === sessionId.value)?.title ?? '当前会话',
)
/** 是否还有子代理在跑（左栏角标用 running 色 + 子代理页概览） */
const subagentRunning = computed(() => subagentRuns.value.some((run) => run.status === 'running'))

/** 待确认的敏感工具调用（主进程同一时刻最多推一条） */
const sensitiveRequest = ref<SensitiveToolRequest | null>(null)
let offSensitiveTool: (() => void) | null = null

/** 拖拽中的附件绝对路径（发送后清空） */
const attachments = ref<string[]>([])
/** 是否正有文件悬停在窗口上（用于描边提示） */
const dragging = ref(false)

/** 会话列表给左栏用：quick 由侧栏面板承载，不再出现在普通会话列表里 */
const sessionItems = computed(() => sessions.value.filter((item) => item.id !== 'quick'))

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

onMounted(() => {
  offSensitiveTool = window.aurora.proactive.onSensitiveTool((request) => {
    sensitiveRequest.value = request
  })
  // 水合当前会话（main）→ 会话列表：左栏立刻有内容
  void hydrate().then(() => loadSessions())
  // 斜杠命令的 Skill 候选（`/` 浮层的技能分组）：失败只是没有技能项，不影响输入
  void window.aurora.skills.list().then((result) => {
    if (!result.ok) return
    slashSkills.value = result.value
  })
})

onUnmounted(() => {
  offSensitiveTool?.()
  offSensitiveTool = null
  if (pickerHintTimer !== null) window.clearTimeout(pickerHintTimer)
  pickerHintTimer = null
  disposeRecording()
})

function resolveSensitive(): void {
  sensitiveRequest.value = null
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

/** 左栏「新对话」：同样是切会话，带上同一组副作用 */
async function startNewSession(): Promise<void> {
  tts.stop()
  lastReadId = null
  disposeRecording()
  await newSession()
}

/**
 * 左栏点选会话（含「快速对话」固定项）：切会话并把主区切回对话流 ——
 * 用户点会话的意图是「看这段对话」，若还停在子代理页会显得点了没反应。
 */
async function selectSession(id: string): Promise<void> {
  view.value = 'chat'
  await switchSession(id)
}

// ────────────── 头部的两个 provider 控件：模型 / 思考等级（docs/06 §3） ──────────────

/**
 * 「模型」与「思考等级」两个下拉读写的是**同一个 provider 子树**，只是字段不同：
 * `llm.providers.<active>.model`（唯一生效值）与 `.reasoningEffort`。
 *
 * 与设置页「AI 模型」卡写的是同一份数据（单一事实来源），**没有按会话覆盖**；
 * 保存成功后 `settings:changed` 会把新配置推回 store，两个控件随之更新。
 * 每次发送时主进程都会重读配置，因此写完**下一次发送**立即生效。
 */
const activeProviderId = computed(() => settingsStore.settings?.llm.active ?? '')

/** 当前生效 provider；没有可用 provider（未配置 / active 指向不存在的 id）时为 `null` */
const activeProvider = computed<LlmProviderConfig | null>(() => {
  const settings = settingsStore.settings
  if (!settings) return null
  return settings.llm.providers[activeProviderId.value] ?? null
})

/** 模型下拉的当前值（`model` 是唯一生效值；空串 = 还没填） */
const currentModel = computed<string>(() => activeProvider.value?.model ?? '')

/** 模型下拉的候选列表（去重与空串过滤是 `ModelPickerSelect` 的事） */
const modelOptions = computed<string[]>(() => activeProvider.value?.modelList ?? [])

/** 当前生效 provider 的思考等级；没有可用 provider 时为 `null`（此时控件禁用而不是隐藏） */
const effort = computed<ReasoningEffort | null>(() => activeProvider.value?.reasoningEffort ?? null)

/** 思考下拉显示值：无 provider 时用默认等级占位——禁用态也要让用户看得见这个控件 */
const effortValue = computed<ReasoningEffort>(() => effort.value ?? DEFAULT_REASONING_EFFORT)

/** 无 provider 时两个下拉共用的 tooltip / 提示文案（与设置页口径一致：指向修复路径） */
const missingProviderTitle = '先在「设置 → AI 模型」里配置并选中一个模型'

/** 模型下拉的 tooltip（Chromium 不给禁用态的原生控件弹 title） */
const modelTitle = computed(() =>
  activeProvider.value === null
    ? missingProviderTitle
    : '当前使用的模型（候选来自「设置 → AI 模型」的模型列表）；改完对下一次请求生效',
)

/** 思考下拉的 tooltip：无 provider → 指向修复路径；有 provider → 说明这个参数的含义 */
const effortTitle = computed(() =>
  activeProvider.value === null
    ? missingProviderTitle
    : '思考等级（越高越深入，但更慢更贵）；auto 不下发该参数，兼容性最好',
)

/** 两个下拉共用的保存结果轻提示（成功 2 秒后消失；失败走 chatError） */
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
 * 更新当前 provider 的若干字段——「模型」与「思考等级」两个下拉共用的写入路径。
 *
 * patch 必须**原样回传 `llm.active` 与全部 `providers`**（`settings:update` 只有顶层浅合并，
 * 分组级局部更新缺一条就丢配置），但每一个 provider 都要先过 `stripSecretFields()`。
 * deepClone 由 `settingsStore.update()` 统一处理（Proxy 不可结构化克隆）。
 */
async function updateActiveProvider(patch: Partial<LlmProviderConfig>): Promise<boolean> {
  const settings = settingsStore.settings
  const id = activeProviderId.value
  if (!settings || id === '') return false
  const provider = settings.llm.providers[id]
  if (!provider) return false
  const providers: Record<string, LlmProviderConfig> = {}
  for (const [providerId, item] of Object.entries(settings.llm.providers)) {
    providers[providerId] = stripSecretFields(item)
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

/** 写入思考等级（`auto` 由主进程装配层映射成「不下发」）；只在值真的变了时写 */
async function setEffort(next: ReasoningEffort): Promise<void> {
  const provider = activeProvider.value
  if (provider === null || provider.reasoningEffort === next) return
  if (await updateActiveProvider({ reasoningEffort: next })) {
    flashPickerHint(`思考等级已改为 ${next}`)
  }
}

/** 写入当前 provider 的模型（`modelList` 只是候选，不跟着改）；下一次发送即生效 */
async function setModel(next: string): Promise<void> {
  const provider = activeProvider.value
  if (provider === null || provider.model === next) return
  if (await updateActiveProvider({ model: next })) {
    flashPickerHint(`模型已切换为 ${next}`)
  }
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
 * 麦克风按钮出不出现的**唯一**口径：`stt.enabled` 且 `stt.active` 指向一个存在的
 * provider、`baseUrl` / `model` 齐全、且已存有 API Key（`apiKeySet` 由主进程脱敏时给出）。
 * 未满足时按钮**根本不渲染**（不是 disabled）——点一个必然失败的入口不如不给。
 */
const sttReady = computed<boolean>(() => {
  const settings = settingsStore.settings
  if (!settings) return false
  const { enabled, active, providers } = settings.stt
  if (!enabled || active === '') return false
  const provider = providers[active] as (SttProviderConfig & { apiKeySet?: boolean }) | undefined
  if (provider === undefined) return false
  return (
    provider.baseUrl.trim() !== '' && provider.model.trim() !== '' && provider.apiKeySet === true
  )
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

// ── 权限模式（`advanced.confirmSensitiveTools`，与设置页「智能与工具」同一份配置） ──

/**
 * 是否「变更前确认」。配置还没水合时按 `true` 显示 —— 这是 Schema 的默认值，
 * 也是更安全的一侧（宁可先让用户看到「会确认」，也不默认显示成已放权）。
 */
const permissionConfirm = computed<boolean>(
  () => settingsStore.settings?.advanced.confirmSensitiveTools ?? true,
)

/**
 * 写入权限模式。这是**只有用户界面能走**的路径：`advanced.confirmSensitiveTools`
 * 在 `SETTINGS_READONLY_PREFIXES` 里，AI 的 `set_setting` 一律拒绝改它。
 * `advanced` 是顶层浅合并，patch 只需带这一个字段，`readonlyPrefixes` 等不会被清掉。
 */
async function setPermission(confirm: boolean): Promise<void> {
  const ok = await settingsStore.update({ advanced: { confirmSensitiveTools: confirm } })
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
  if (slashOpen.value) {
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

/** 上下文详解的「本会话内容」：正文字符数（把思考链也算进去，它同样进上下文） */
const contentChars = computed(() =>
  messages.value.reduce(
    (total, message) => total + message.content.length + (message.reasoning?.length ?? 0),
    0,
  ),
)

/** 当前 provider 的上下文窗口（token）；0 = 未知，上下文条据此只显示用量不显示比例 */
const currentContextWindow = computed<number>(() => activeProvider.value?.contextWindow ?? 0)

const placeholder = computed(() =>
  streaming.value
    ? '正在回复中，可先继续输入；回复结束后按 Enter 发送'
    : '输入消息，Enter 发送，Shift + Enter 换行；输入 / 调用命令与技能，可直接拖入文件',
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
  <div class="app-shell">
    <!-- ── 左栏：品牌 / 新对话 / 快速对话面板 / 会话列表 / 底部工具 ── -->
    <aside class="nav" :class="{ collapsed: !navOpen }">
      <SessionNav
        :sessions="sessionItems"
        :active-id="sessionId"
        :right-open="contextOpen"
        :view="view"
        :subagent-count="subagentRuns.length"
        :subagent-running="subagentRunning"
        @new-session="startNewSession"
        @select="selectSession"
        @open-subagents="view = 'subagents'"
        @toggle-right-panel="contextOpen = !contextOpen"
        @open-settings="windowStore.show('settings')"
      />
    </aside>

    <!-- ── 主区 ── -->
    <main class="main">
      <!--
        双击头部拖动区 = 切换最大化：frame:false 窗口的 drag region 双击由 Windows 原生接管
        （`maximizable: true` 后 WM_NCLBUTTONDBLCLK 语义），页面侧不再挂 dblclick——
        拖动区收不到页面鼠标事件，重复挂只会造成双重切换。最大化期间几何不落盘（persistGeometry 跳过）。
      -->
      <header class="head" :class="dragClass">
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
          Windows 式窗口按钮：「最小化」真最小化进任务栏；「关闭」= 隐藏窗口
          （正在进行的流式回复不会中止，`hide()` 不触碰 `chat:abort`，docs/02 §2.2）。
        -->
        <WindowCaption window="chat" />
      </header>

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

        <MessageList
          :messages="messages"
          empty-hint="这是 Aurora 主界面：可以问系统状态、让 Aurora 帮忙整理资料，也可以直接把文件拖进来。"
          :tts-available="ttsReady"
          :speaking-id="tts.speaking.value"
          :tts-loading-id="tts.loading.value"
          :streaming="streaming"
          :show-thinking="showThinking"
          :thinking-target-id="reasoningTargetId"
          @speak="speakMessage"
          @stop-speak="tts.stop"
        />
      </div>

      <footer v-if="view === 'chat'" class="composer">
        <div class="composer-inner">
          <div v-if="attachments.length > 0" class="attachments">
            <span v-for="path in attachments" :key="path" class="chip tiny">
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

          <div class="composer-box" :class="{ streaming }">
            <!--
              斜杠命令浮层（2026-09 输入框重做）：贴在输入卡上方。
              键盘（↑↓ / Enter / Tab / Esc）由下面 textarea 的 onComposerKeydown 统一处理，
              浮层只是键位操作的可视反馈，焦点始终留在输入框里。
            -->
            <SlashCommandMenu
              v-if="slashOpen"
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
              @keydown="onComposerKeydown"
            />

            <div class="composer-bar">
              <!-- 权限模式（变更前确认 / 完全权限）：写 advanced.confirmSensitiveTools -->
              <ComposerPermissionSelect
                :confirm="permissionConfirm"
                :disabled="settingsStore.settings === null"
                @change="setPermission"
              />
              <!-- 模型 / 思考等级（2026-09 移入 composer 工具行）：data-field 锚点不变 -->
              <ModelPickerSelect
                class="composer-picker"
                :model-value="currentModel"
                :models="modelOptions"
                :disabled="activeProvider === null"
                :title="modelTitle"
                @update:model-value="setModel"
              />
              <ThinkingLevelSelect
                class="composer-picker"
                :model-value="effortValue"
                :disabled="effort === null"
                :title="effortTitle"
                @update:model-value="setEffort"
              />
              <span class="grow" />
              <!-- 保存类操作的瞬时提示（2 秒自灭）；旧常驻「会话：xxx · 可调用 Skill…」meta 已移除 -->
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
              :model="currentModel"
              :message-count="messages.length"
              :char-count="contentChars"
              :streaming="streaming"
            />
          </div>
        </div>

        <AppToast v-if="chatError" tone="error">{{ chatError }}</AppToast>
      </footer>
      <template v-else>
        <!--
          子代理页面（docs/07 §2.4）：替换主区内容，输入区与右栏照旧。
          上面那段 thread + composer 用 v-if 收在 view === 'chat' 分支里。
        -->
        <SubagentPage
          :runs="subagentRuns"
          :session-title="currentSessionTitle"
          @back="view = 'chat'"
        />
      </template>
    </main>

    <!-- ── 右栏：模式感知上下文 + 任务清单 ── -->
    <aside class="context" :class="{ collapsed: !contextOpen }">
      <ContextPanel :todos="currentTodos" />
    </aside>
  </div>
</template>

<style scoped>
/**
 * 三栏 grid（spec §3）：左栏 232px 可折叠 · 主区自适应 · 右栏 264px 可折叠。
 * 折叠用「宽度收 0 + 内容固定宽被裁剪」而不是 v-show：display:none 没有过渡，
 * 而宽度过渡能让侧栏沿 --ease-spring 滑入滑出（prefers-reduced-motion 全局降级）。
 */
.app-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
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
  width: 240px;
  background: var(--fill-1);
  border-right: 1px solid var(--border-subtle);
}

.context {
  width: 264px;
  background: var(--fill-1);
  border-left: 1px solid var(--border-subtle);
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
}

.head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  /* 右侧不留内边距：WindowCaption 的悬停命中区要贴到窗口右缘（Windows 习惯） */
  padding: var(--space-2) 0 var(--space-2) var(--space-4);
  min-height: 48px;
  background: var(--fill-1);
  border-bottom: 1px solid var(--border-subtle);
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
  background: var(--bg-base);
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

.chip-remove:hover {
  color: var(--text-primary);
}

.composer-box {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4) var(--space-2);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
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
 * 输入区（2026-09 输入框重做）。
 *
 * 高度由 `autoGrow()` 按 `scrollHeight` 钉住（1 行起步、最多 200px 后内部滚动），
 * 因此这里**不设 min/max-height 也不留 `resize`** —— 手动拖动会和自动增高互相打架，
 * 结果是「发完消息输入框还是刚才拖出来的高度」。
 * `overflow-y: auto` 是超出上限后的兜底（此时才出现滚动条）。
 */
.composer-input {
  display: block;
  width: 100%;
  height: auto;
  min-height: calc(var(--text-base) * var(--leading-normal) + 2 * var(--space-1));
  max-height: 200px;
  padding: var(--space-1) 0;
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

.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
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
