<script setup lang="ts">
/**
 * 输入卡（docs/07 §2.3 的「输入框规格」，减负轮后的口径；Center Web 版）。
 *
 * 硬口径（两端逐字对齐，别再改回去）：
 * - 卡内自顶向下：**图片缩略图条 → textarea → 工具行**（缩略图属于这条消息，必须在卡内）；
 * - 三枚控件（权限 / 模型 / 思考）一律 28px（`--control-h-xs`）+ pill 圆角 +
 *   **静止态零边框**（悬停才浮 `--fill-2`）—— 40px + 逐枚边框会把输入卡顶成设置工具栏；
 * - 占位文案只留一句「输入消息…」，键位提示挂工具行右侧；
 * - textarea 高度由**内容**决定（空内容 = 一行），autoGrow 上限 200px；
 * - 发送按钮绝不能被挤出行外；流式期间「停止」与发送同位。
 *
 * 浮层（2026-10-18）：权限 / 模型 / 思考三枚按钮各自弹一层 **自绘菜单**（原生 `<select>`
 * 在浏览器里样式不可控、也做不了"图标 + 标签 + 箭头"的芯片观感）。三层共用
 * `.composer-flyout`（`@aurora/shared/browser/theme.css`，双端唯一来源）与
 * `--composer-flyout-width`：同一宽度、底边都贴整张输入卡上方，
 * 横向贴住各自触发按钮；**同一时刻只开一层**（`openMenu` 单一来源 + 点击外部 / Esc 关闭）。
 *
 * 图片粘贴（2026-10-18，docs/12 §5）：粘贴的图先 `POST /api/uploads` 换成服务器 fileId，
 * 发送时随 `session.input.attachments` 上行。客户端能力位 `status.center.inputAttachments`
 * 不为 true 时只提示升级、不上传（旧客户端会把图静默丢掉）。上传中禁发；失败移除并提示；
 * 切会话 / 卸载一律回收 objectURL 并 best-effort 删除已上传的暂存文件。
 *
 * 语音（docs/12 §6.4）：麦克风按钮按客户端能力位 `voice.stt` 门控 ——
 * 未配置**连按钮都不渲染**（不是 disabled）。录音需安全上下文（HTTPS / localhost）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { PermissionMode, ReasoningEffort } from '@aurora/shared'
import type { ClientEntry, SessionState } from '../../state'
import {
  abortSession,
  fetchRemoteConfig,
  sendInput,
  setSessionModel,
  setSessionPermission,
  showNotice,
  switchLlm,
  transcribeAudio,
} from '../../state'
import { api } from '../../lib/api'
import {
  imageRejectReason,
  readyFileIds,
  revokePreviewUrl,
  type ComposerAttachment,
} from '../../lib/composer-attachments'
import {
  ArrowUp,
  ChevronDown,
  Cpu,
  Mic,
  REASONING_EFFORT_LABELS,
  ShieldCheck,
  Sparkles,
  Square,
  useComposerFlyoutLeft,
} from '@aurora/shared/browser'
import ComposerAttachments from './composer/ComposerAttachments.vue'
import ComposerPermissionMenu from './composer/ComposerPermissionMenu.vue'
import ComposerModelMenu from './composer/ComposerModelMenu.vue'
import ComposerEffortMenu from './composer/ComposerEffortMenu.vue'

const props = defineProps<{
  session: SessionState
  entry: ClientEntry
}>()

type ComposerMenuId = 'permission' | 'model' | 'effort'

const composerRoot = ref<HTMLElement | null>(null)
const draft = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const micState = ref<'idle' | 'recording' | 'transcribing'>('idle')
/** 当前打开的浮层：**单一来源**（互斥由这一个值保证，不要给每个菜单各开一个 ref） */
const openMenu = ref<ComposerMenuId | null>(null)

/* 三枚触发按钮：浮层横向贴住点开它的那一枚（不是固定 left: 0） */
const permissionBtn = ref<HTMLElement | null>(null)
const modelBtn = ref<HTMLElement | null>(null)
const effortBtn = ref<HTMLElement | null>(null)
const activeMenuTrigger = computed<HTMLElement | null>(() => {
  if (openMenu.value === 'permission') return permissionBtn.value
  if (openMenu.value === 'model') return modelBtn.value
  if (openMenu.value === 'effort') return effortBtn.value
  return null
})
const { left: menuLeft, update: updateMenuLeft } = useComposerFlyoutLeft(
  () => activeMenuTrigger.value,
  () => openMenu.value !== null,
)
// 从一层直接切到另一层时 open 仍是 true，watch(open) 不会再跑：按触发器变化补算
watch(activeMenuTrigger, () => {
  if (openMenu.value !== null) void nextTick(updateMenuLeft)
})

/* ── 图片附件（2026-10-18） ── */

const attachments = ref<ComposerAttachment[]>([])
/** 本地自增序号：同一毫秒粘贴多张时 `Date.now()` 会重，必须再叠一个 */
let attachmentSeq = 0
/**
 * 上传代际：切会话 / 卸载时自增。上传回执回来时若代际已经变了，说明那是**上一条会话**
 * 的图 —— 必须丢弃（否则会在新会话里冒出一张已回收 objectURL 的缩略图），
 * 顺手把服务器上那张暂存文件删掉。
 */
let uploadGeneration = 0

const uploadingCount = computed(
  () => attachments.value.filter((item) => item.status === 'uploading').length,
)

/* ── 会话状态派生（权限 / 模型 / 思考三枚芯片的当前值） ── */

/** 该会话在远程会话列表里的摘要（会话级覆盖都记在它上面：permissionMode / llm） */
const sessionSummary = computed(
  () =>
    props.entry.remoteSessions.find((item) => item.sessionId === props.session.sessionId) ?? null,
)
const online = computed(() => props.entry.client.online)
const status = computed(() => props.entry.status)

const PERMISSION_LABELS: Record<string, string> = {
  readonly: '只读',
  confirm: '变更前确认',
  auto: '完全权限',
}

/** 生效权限档：会话覆盖 > 客户端全局快照（没有「清除会话覆盖」的命令，只有覆盖方向） */
const permissionCurrent = computed(
  () => sessionSummary.value?.permissionMode ?? status.value?.agent.permissionMode ?? '',
)
const permissionLabel = computed(() => {
  const raw = permissionCurrent.value
  if (raw === '') return '未上报'
  return PERMISSION_LABELS[raw] ?? raw
})
const remoteSessionAllowed = computed(
  () => status.value !== null && status.value.center.allowRemoteSession === true,
)
const remoteConfigAllowed = computed(
  () => status.value !== null && status.value.center.allowRemoteConfig === true,
)
const permissionDisabled = computed(() => !online.value || !remoteSessionAllowed.value)
const configDisabled = computed(() => !online.value || !remoteConfigAllowed.value)

const llm = computed(() => status.value?.llm ?? null)
const remoteLlm = computed(() => props.entry.remoteLlm)
const modelOverride = computed(() => sessionSummary.value?.llm ?? null)
const globalModel = computed(() => llm.value?.model ?? '')
const modelLabel = computed(() => {
  const override = modelOverride.value
  if (override !== null && override.model !== '') return override.model
  return globalModel.value === '' ? '未配置模型' : globalModel.value
})

/** 模型候选：`remoteLlm.providers` 展平（provider × modelList）；覆盖值不在列表里也补回来 */
const modelOptions = computed(() => {
  const config = remoteLlm.value
  const override = modelOverride.value
  const effectiveProvider =
    override?.providerId ?? llm.value?.activeProviderId ?? config?.active ?? ''
  const effectiveModel = override?.model ?? llm.value?.model ?? ''
  const options: Array<{ providerId: string; model: string; active: boolean }> = []
  for (const [providerId, provider] of Object.entries(config?.providers ?? {})) {
    for (const model of provider.modelList) {
      options.push({
        providerId,
        model,
        active: providerId === effectiveProvider && model === effectiveModel,
      })
    }
  }
  if (
    override !== null &&
    !options.some(
      (option) => option.providerId === override.providerId && option.model === override.model,
    )
  ) {
    options.unshift({ providerId: override.providerId, model: override.model, active: true })
  }
  return options
})

/** 配置切片是否在途（打开模型浮层时若 `remoteLlm === null` 补拉一次） */
const modelLoading = ref(false)

const effortCurrent = computed(() => llm.value?.reasoningEffort ?? '')
const effortLabel = computed(() => {
  const current = effortCurrent.value
  if (current === '') return '未上报'
  return REASONING_EFFORT_LABELS[current as ReasoningEffort]?.short ?? current
})

/* ── 发送能力 ── */

const canSend = computed(
  () => draft.value.trim() !== '' && !props.session.pending && uploadingCount.value === 0,
)

/** 录音上限 10MB：中转是整段 base64 上行，再大就该走别的通道了 */
const MAX_RECORD_BYTES = 10 * 1024 * 1024

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let recordedBytes = 0

const sttReady = computed(() => props.entry.status?.voice?.stt === true)

/** textarea 高度跟随内容（空内容 = 一行；上限 200px 后自身滚动） */
function autoGrow(): void {
  const el = inputEl.value
  if (el === null) return
  el.style.height = 'auto'
  const lines = countLines(el)
  const height = Math.min(el.scrollHeight, 200)
  // 高度过渡只开在**行数变化**的那一帧：逐键增减字符时高度每帧都会变一点点，
  // 常驻过渡会跟输入抢帧（观感是光标附近的字在抖）。加类 → 写高度在同一个 task 里，
  // 过渡拿到的起点仍是上一帧的高度。
  if (lines !== growLines) {
    growLines = lines
    el.classList.add('grow-anim')
    if (growTimer !== undefined) window.clearTimeout(growTimer)
    growTimer = window.setTimeout(() => {
      el.classList.remove('grow-anim')
      growTimer = undefined
    }, 200)
  }
  el.style.height = `${height}px`
}

/** 上一次量到的行数（`autoGrow` 用它判"行数有没有变"） */
let growLines = 0
let growTimer: number | undefined

/**
 * 当前内容占几行：`scrollHeight` 减掉上下内边距再除以行高。
 * 判据是**行数**而不是像素差 —— 同一行里多打几个字也会让宽度变化、`scrollHeight` 偶尔抖动，
 * 按像素判会把"没换行"的那一帧也当成换行。
 */
function countLines(el: HTMLTextAreaElement): number {
  const style = getComputedStyle(el)
  const lineHeight = Number.parseFloat(style.lineHeight)
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 1
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
  const content = el.scrollHeight - (Number.isFinite(padding) ? padding : 0)
  return Math.max(1, Math.round(content / lineHeight))
}

watch(draft, () => void nextTick(autoGrow))

/* ── 图片粘贴与上传（docs/12 §5，2026-10-18） ── */

/**
 * 从粘贴事件里挑出图片文件。
 *
 * 只看 `items` 里 `kind === 'file'` 且 MIME 为 `image/*` 的项：复制文本时不该被拦。
 * 少数浏览器把剪贴板文件只放在 `files` 里，补一遍兜底。
 */
function pastedImages(event: ClipboardEvent): File[] {
  const data = event.clipboardData
  if (data === null) return []
  const files: File[] = []
  for (const item of data.items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file !== null) files.push(file)
  }
  if (files.length === 0) {
    for (const file of data.files) {
      if (file.type.startsWith('image/')) files.push(file)
    }
  }
  return files
}

function noticeError(prefix: string, error: unknown): void {
  showNotice(`${prefix}：${error instanceof Error ? error.message : String(error)}`)
}

/** 把一张图加入草稿并上传：成功换成服务器 fileId，失败移除并提示 */
async function addImage(file: File): Promise<void> {
  const reason = imageRejectReason(file, attachments.value.length)
  if (reason !== '') {
    showNotice(reason)
    return
  }
  const generation = uploadGeneration
  const id = `local-${Date.now()}-${++attachmentSeq}`
  const previewUrl = URL.createObjectURL(file)
  const item: ComposerAttachment = {
    id,
    fileId: '',
    name: file.name === '' ? '粘贴的图片.png' : file.name,
    size: file.size,
    previewUrl,
    status: 'uploading',
  }
  attachments.value = [...attachments.value, item]
  try {
    const uploaded = await api.uploadFile(file, props.entry.client.clientId)
    const target = attachments.value.find((entry) => entry.id === id)
    // 代际变了（切会话 / 卸载）或条目已被移除：这份回执过期，删掉服务器上的暂存文件
    if (generation !== uploadGeneration || target === undefined) {
      void api.deleteFile(uploaded.fileId).catch(() => {})
      return
    }
    target.fileId = uploaded.fileId
    if (uploaded.name !== '') target.name = uploaded.name
    target.status = 'ready'
  } catch (error) {
    if (generation !== uploadGeneration) return
    removeAttachmentById(id)
    noticeError('图片上传失败', error)
  }
}

function removeAttachmentById(id: string): void {
  const index = attachments.value.findIndex((entry) => entry.id === id)
  if (index < 0) return
  const [item] = attachments.value.splice(index, 1)
  if (item === undefined) return
  revokePreviewUrl(item.previewUrl)
  if (item.fileId !== '') void api.deleteFile(item.fileId).catch(() => {})
}

/** 用户点缩略图右上角的移除：本地回收 + best-effort 删除服务器暂存文件 */
function removeAttachment(item: ComposerAttachment): void {
  removeAttachmentById(item.id)
}

/** 清空草稿里的全部图片（切会话 / 卸载）：回收 objectURL + 删掉已上传的暂存文件 */
function clearAttachments(): void {
  uploadGeneration += 1
  const dropped = attachments.value
  attachments.value = []
  for (const item of dropped) {
    revokePreviewUrl(item.previewUrl)
    if (item.fileId !== '') void api.deleteFile(item.fileId).catch(() => {})
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = pastedImages(event)
  if (files.length === 0) return
  if (status.value?.center.inputAttachments !== true) {
    // 旧客户端：不上传、也不拦默认粘贴（剪贴板里若同时有文本，文本照常进输入框）
    showNotice('当前客户端版本不支持随消息发送图片，请升级 Aurora 客户端后再试')
    return
  }
  // 图片粘贴一律由我们接管：否则浏览器可能把文件名当文本塞进 textarea
  event.preventDefault()
  for (const file of files) void addImage(file)
}

/* ── 发送 / 中止 ── */

async function submit(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  const sent = attachments.value.filter((item) => item.status === 'ready')
  const uploaded = readyFileIds(sent)
  const ok = await sendInput(props.session, text, uploaded)
  if (!ok) return
  // 只有**真的发出去**才清空（失败时草稿与图片都退回原处）
  if (draft.value === text) {
    draft.value = ''
    void nextTick(autoGrow)
  }
  for (const item of sent) {
    const index = attachments.value.findIndex((entry) => entry.id === item.id)
    if (index >= 0) {
      attachments.value.splice(index, 1)
      revokePreviewUrl(item.previewUrl)
    }
  }
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

/* ── 三枚浮层（互斥 / 点击外部 / Esc） ── */

function toggleMenu(menu: ComposerMenuId): void {
  openMenu.value = openMenu.value === menu ? null : menu
}

function onDocumentPointerDown(event: PointerEvent): void {
  const root = composerRoot.value
  if (root !== null && event.target instanceof Node && root.contains(event.target)) return
  openMenu.value = null
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') openMenu.value = null
}

function detachMenuListeners(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
}

watch(openMenu, (menu) => {
  if (menu === null) {
    detachMenuListeners()
    return
  }
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown)
  if (menu === 'model') void ensureRemoteLlm()
})

/** 模型候选来自 `config.get`：打开浮层时若还没拉过就补一次（失败不弹错，菜单里给空态） */
async function ensureRemoteLlm(): Promise<void> {
  if (remoteLlm.value !== null || configDisabled.value || modelLoading.value) return
  modelLoading.value = true
  try {
    await fetchRemoteConfig(props.entry.client.clientId)
  } catch (error) {
    noticeError('读取模型配置失败', error)
  } finally {
    modelLoading.value = false
  }
}

async function selectPermission(mode: PermissionMode): Promise<void> {
  openMenu.value = null
  try {
    await setSessionPermission(props.entry.client.clientId, props.session.sessionId, mode)
  } catch (error) {
    noticeError('切换权限失败', error)
  }
}

async function selectModel(choice: { providerId: string; model: string }): Promise<void> {
  openMenu.value = null
  try {
    await setSessionModel(
      props.entry.client.clientId,
      props.session.sessionId,
      choice.providerId,
      choice.model,
    )
  } catch (error) {
    noticeError('切换模型失败', error)
  }
}

async function followGlobalModel(): Promise<void> {
  openMenu.value = null
  try {
    await setSessionModel(props.entry.client.clientId, props.session.sessionId, '', '')
  } catch (error) {
    noticeError('恢复跟随全局失败', error)
  }
}

async function selectEffort(level: ReasoningEffort): Promise<void> {
  openMenu.value = null
  try {
    await switchLlm(props.entry.client.clientId, { reasoningEffort: level })
  } catch (error) {
    noticeError('切换思考等级失败', error)
  }
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

/** 域名判定：含点且不是 IPv4 字面量（localhost / 单标签主机 / IP 都不算域名） */
function isDomainHost(hostname: string): boolean {
  return hostname.includes('.') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
}

async function toggleMic(): Promise<void> {
  if (micState.value === 'transcribing') return
  if (micState.value === 'recording') {
    recorder?.stop() // onstop 里走转写
    return
  }
  if (window.isSecureContext === false) {
    // 浏览器硬限制：非安全上下文拿不到 navigator.mediaDevices，代码层绕不过。
    // 域名入口大概率存在 https（换协议后端口用默认 443），IP / localhost 直连无解只能提示。
    if (isDomainHost(location.hostname)) {
      showNotice('语音输入需要 HTTPS，正在切换…')
      location.replace(`https://${location.hostname}${location.pathname}${location.search}`)
      return
    }
    showNotice('当前是 HTTP 直连，浏览器不允许网页录音；请用 HTTPS 域名访问后使用语音输入')
    return
  }
  if (navigator.mediaDevices === undefined) {
    showNotice('当前环境不支持网页录音（需要 HTTPS 或 localhost）')
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
  detachMenuListeners()
  if (growTimer !== undefined) window.clearTimeout(growTimer)
  if (recorder !== null) {
    recorder.onstop = null
    discardRecording()
  }
  clearAttachments()
})

/** 会话切换时清空草稿、图片与录音（避免把上一会话的内容发到新会话） */
watch(
  () => props.session.sessionId,
  () => {
    draft.value = ''
    openMenu.value = null
    clearAttachments()
    if (recorder !== null) discardRecording()
    void nextTick(autoGrow)
  },
)

const micTitle = computed(() => {
  if (micState.value === 'transcribing') return '正在识别…'
  return micState.value === 'recording' ? '停止录音并转写' : '语音输入（经客户端中转）'
})

/** 三枚触发器的悬浮提示：完整值 + 不可用的修复路径（省得用户对着灰按钮猜） */
const permissionTitle = computed(() => {
  const full = `权限模式（仅本会话）：${permissionLabel.value}`
  if (!online.value) return `${full}｜设备离线`
  if (!remoteSessionAllowed.value) return `${full}｜该设备未允许远程会话`
  return full
})
const modelTitle = computed(() => {
  const override = modelOverride.value
  const full =
    override === null
      ? `会话模型：跟随全局（${globalModel.value || '未配置'}）`
      : `会话模型：${override.model}（${override.providerId}）`
  if (!online.value) return `${full}｜设备离线`
  if (!remoteConfigAllowed.value) return `${full}｜该设备未允许远程配置`
  return full
})
const effortTitle = computed(() => {
  const full = `思考等级：${effortLabel.value}`
  if (!online.value) return `${full}｜设备离线`
  if (!remoteConfigAllowed.value) return `${full}｜该设备未允许远程配置`
  return full
})
</script>

<template>
  <div ref="composerRoot" class="composer">
    <div class="composer-box glass-panel" :class="{ streaming: session.pending }">
      <!-- 缩略图条在卡内、textarea 上方（docs/07 §2.3：图片属于这条消息） -->
      <ComposerAttachments :items="attachments" @remove="removeAttachment" />

      <textarea
        ref="inputEl"
        v-model="draft"
        class="composer-input"
        rows="1"
        :placeholder="session.pending ? '正在回复中，可继续输入…' : '输入消息…'"
        data-field="chat.composer-input"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <div class="composer-bar">
        <div class="bar-inner">
          <div class="bar-pickers">
            <button
              ref="permissionBtn"
              type="button"
              class="chip chip--permission"
              :class="{ open: openMenu === 'permission' }"
              data-field="chat.permission"
              :disabled="permissionDisabled"
              :title="permissionTitle"
              aria-haspopup="menu"
              :aria-expanded="openMenu === 'permission'"
              @click="toggleMenu('permission')"
            >
              <ShieldCheck class="chip-icon" :size="13" :stroke-width="1.7" aria-hidden="true" />
              <span class="chip-label">{{ permissionLabel }}</span>
              <ChevronDown class="chev" :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>

            <button
              ref="modelBtn"
              type="button"
              class="chip"
              :class="{ open: openMenu === 'model' }"
              data-field="chat.model"
              :disabled="configDisabled"
              :title="modelTitle"
              aria-haspopup="menu"
              :aria-expanded="openMenu === 'model'"
              @click="toggleMenu('model')"
            >
              <Cpu class="chip-icon" :size="13" :stroke-width="1.7" aria-hidden="true" />
              <span class="chip-label chip-label--optional">{{ modelLabel }}</span>
              <ChevronDown class="chev" :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>

            <button
              ref="effortBtn"
              type="button"
              class="chip"
              :class="{ open: openMenu === 'effort' }"
              data-field="chat.reasoningEffort"
              :disabled="configDisabled"
              :title="effortTitle"
              aria-haspopup="menu"
              :aria-expanded="openMenu === 'effort'"
              @click="toggleMenu('effort')"
            >
              <Sparkles class="chip-icon" :size="13" :stroke-width="1.7" aria-hidden="true" />
              <span class="chip-label chip-label--optional">{{ effortLabel }}</span>
              <ChevronDown class="chev" :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </div>

          <span class="grow" />
          <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>

          <div class="bar-actions">
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

      <!-- 三枚浮层都是 .composer-box 的直接子节点：`.composer-flyout` 相对整张卡定位 -->
      <ComposerPermissionMenu
        :open="openMenu === 'permission'"
        :left="menuLeft"
        :current="permissionCurrent"
        :disabled="permissionDisabled"
        @select="selectPermission"
        @close="openMenu = null"
      />
      <ComposerModelMenu
        :open="openMenu === 'model'"
        :left="menuLeft"
        :override="modelOverride"
        :global-model="globalModel"
        :options="modelOptions"
        :loading="modelLoading"
        :disabled="configDisabled"
        @select="selectModel"
        @follow-global="followGlobalModel"
        @close="openMenu = null"
      />
      <ComposerEffortMenu
        :open="openMenu === 'effort'"
        :left="menuLeft"
        :current="effortCurrent"
        :disabled="configDisabled"
        @select="selectEffort"
        @close="openMenu = null"
      />
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: 0 0 auto;
  padding: 0 var(--space-4) var(--space-4);
}

.composer-box {
  /* 三枚浮层的定位锚：`.composer-flyout` 的 bottom 百分比基于这张卡（双端同一套规则） */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 860px;
  margin: 0 auto;
  padding: var(--space-2) var(--space-3) var(--space-1);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-panel);
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

/*
 * 高度过渡（行数变化的那一帧由 `autoGrow` 临时挂上）：textarea 的高度跳变发生在
 * 「一行变成两行 / 两行退回一行」时 —— 那时才值得 150ms 的过渡；常驻过渡会与输入抢帧。
 */
.composer-input.grow-anim {
  transition: height var(--dur-fast) var(--ease-standard);
}

.composer-bar {
  /* 容器查询的作用域：窄窗下三枚芯片的标签显隐只由工具行自己的宽度决定，
     不能看视口（桌面端把面板收起来 / 左栏拉宽时主区会窄到 400px 上下） */
  container-type: inline-size;
  min-width: 0;
}

/* 容器本身不能被容器查询命中（CSS 容器查询只作用于后代），真正参与换行的是这一层 */
.bar-inner {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
  min-width: 0;
}

.bar-pickers {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  flex: 0 1 auto;
}

/* 三枚控件：28px + pill + 静止态零边框（悬停才浮底色），两端逐字对齐 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  height: var(--control-h-xs);
  max-width: 180px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.chip:hover:not(:disabled),
.chip.open {
  background: var(--fill-2);
  color: var(--text-primary);
}

.chip:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 权限是档位闸门入口：文案不参与收缩（判据「权限文案不截断」） */
.chip--permission {
  flex: 0 0 auto;
  max-width: none;
}

.chip-icon,
.chev {
  flex: 0 0 auto;
  display: inline-flex;
}

.chev {
  opacity: 0.7;
}

.chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip--permission .chip-label {
  overflow: visible;
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

.bar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 0 auto;
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

/*
 * 窄工具行（≤430px）：模型 / 思考只留图标 + 箭头，权限档位文案**必须保留** ——
 * 闸门开着的这件事比模型名更该看得见。宽度判据来自 `.composer-bar` 的容器查询。
 */
@container (max-width: 430px) {
  .chip-label--optional {
    display: none;
  }

  .chip {
    max-width: none;
  }
}

/*
 * 极窄工具行（≤340px）：允许换行。第一行只放三枚芯片，发送 / 麦克风整体换到第二行并
 * 右对齐 —— 这样"发送按钮绝不收缩"与"不溢出输入卡"可以同时成立。
 */
@container (max-width: 340px) {
  .bar-inner {
    flex-wrap: wrap;
    row-gap: var(--space-1);
  }

  .grow,
  .composer-hint {
    display: none;
  }

  .bar-pickers {
    flex: 1 0 100%;
  }

  .bar-actions {
    margin-left: auto;
  }
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

  /* 权限文案不截断（移动端 30vw 的收紧不适用于它） */
  .chip--permission {
    max-width: none;
  }
}
</style>
