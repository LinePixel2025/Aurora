<script setup lang="ts">
/**
 * 自动化页（docs/13 §11，docs/07 §2.3）：主区第三种 view（与子代理页同构，不属任何会话）。
 *
 * 结构：顶部「Agent Mode / Normal Mode」双 tab + 新建 / 历史按钮 →
 * 按当前 tab 过滤的自动化卡片列表（名称 + 触发描述 + 启停 + 编辑 / 删除 / 立即运行）→
 * Normal tab 底部「内置」区（ClassRoom 既有自动操作，启停映射既有配置，docs/13 §6）→
 * 编辑器弹窗（仓库首个 Modal：catalog 驱动的动态表单）→ 历史弹窗（Agent 行可展开对话回放）。
 *
 * **2026-09 前端减负轮重做**（docs/07 §5.4）：
 * - **每个操作/条件都带图标**：条件磁贴、操作胶囊、历史状态、模式徽章、卡片摘要各有语义图标
 *   （`triggerIconOf` / `actionIconOf` / `statusIconOf`），不再靠纯文字区分；
 * - **不再出现原生 `<select>`**：条件选择从下拉改成图标磁贴网格（点一下即选、看得见全部选项），
 *   参数里的下拉 / 星期多选分别改成胶囊分段与星期胶囊（`AutomationFieldInput.vue`）；
 * - **说明文案离开版面**：可以压缩的解释一律挪进 `AppTooltip`，版面上只留标签与值。
 *
 * 门控口径：catalog 里 `available: false` 的操作组件**不渲染选项**（不是 disabled）；
 * 内置自动化的开关直接写 `modes.classroom.preClassReminder / preClassOpenFolder`——
 * 它们的启停条件本来就长在既有配置上，不另立状态（docs/13 §6）。
 * 历史弹窗里 Normal 记录**只显示触发时间与状态**（不展开操作明细，产品口径）。
 *
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §5.3），不可改名；
 * `.run-item` / `.run-time` / `.clickable` / `.detail-message` 四个类名同属契约，同样别动。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import type {
  AutomationAction,
  AutomationCatalog,
  AutomationDefinition,
  AutomationDescriptorField,
  AutomationRun,
  ChatMessageDto,
} from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import AutomationFieldInput from './AutomationFieldInput.vue'
import { deepClone } from '@aurora/shared/browser'
import { useSettingsStore } from '../../shared/stores.js'
import {
  ArrowLeft,
  Bell,
  BellRing,
  BookOpen,
  Bot,
  CalendarClock,
  ChevronRight,
  CircleCheck,
  CirclePlay,
  CircleStop,
  CircleX,
  Clock,
  FolderOpen,
  History,
  Hourglass,
  Info,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Repeat,
  School,
  Sparkles,
  Timer,
  Trash2,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from '../../shared/icons.js'

const settingsStore = useSettingsStore()

/**
 * 「返回对话」与子代理页同款口径：主区替换内容不属任何会话，切走/切回都不动会话状态。
 */
const emit = defineEmits<{
  (event: 'back'): void
}>()

// ───────────────────────── 列表状态 ─────────────────────────

const tab = ref<'agent' | 'normal'>('agent')
const userDefs = ref<AutomationDefinition[]>([])
const builtinDefs = ref<AutomationDefinition[]>([])
const catalog = ref<AutomationCatalog | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
/** 两段式删除确认：正在等待二次点击的自动化 id */
const confirmingDelete = ref<string | null>(null)

const shownDefs = computed(() => userDefs.value.filter((item) => item.mode === tab.value))
const builtinShown = computed(() => (tab.value === 'normal' ? builtinDefs.value : []))
const conditions = computed(() => catalog.value?.conditions ?? [])
const actions = computed(() => catalog.value?.actions ?? [])
/** 可用的操作组件（available=false 的**不渲染选项**，不是 disabled —— docs/13 §5 门控口径） */
const availableActions = computed(() => actions.value.filter((item) => item.available))

let offChanged: (() => void) | null = null
let offHistoryChanged: (() => void) | null = null
let noticeTimer: number | null = null
let deleteTimer: number | null = null

onMounted(() => {
  void refresh()
  offChanged = window.aurora.automation.onChanged(() => void refresh())
  offHistoryChanged = window.aurora.automation.onHistoryChanged(() => {
    if (historyOpen.value) void refreshHistory()
  })
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  offChanged?.()
  offHistoryChanged?.()
  window.removeEventListener('keydown', onKeydown)
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  if (deleteTimer !== null) window.clearTimeout(deleteTimer)
})

/**
 * Esc 关闭弹窗（与点遮罩同一套关闭路径）：编辑器优先，然后是历史弹窗 ——
 * 历史里若正展开某条运行的回放，第一下 Esc 只收回放（与「一层一层退」的直觉一致）。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (editorOpen.value) {
    closeEditor()
    return
  }
  if (!historyOpen.value) return
  if (detail.value !== null) {
    detail.value = null
    return
  }
  closeHistory()
}

/** 成功反馈自动退场（避免一条「已保存」长期挂在版面上；错误则留到下一次操作） */
function flash(message: string): void {
  notice.value = message
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = null
    noticeTimer = null
  }, 3200)
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  const [listResult, catalogResult] = await Promise.all([
    window.aurora.automation.list(),
    window.aurora.automation.catalog(),
  ])
  if (listResult.ok) {
    userDefs.value = listResult.value.user
    builtinDefs.value = listResult.value.builtin
  } else {
    error.value = listResult.message
  }
  if (catalogResult.ok) catalog.value = catalogResult.value
  loading.value = false
}

// ───────────────────────── 图标 / 展示文案 ─────────────────────────

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 条件 kind → 图标。**与主进程 catalog 的 7 类一一对应**：新增条件组件时
 * 这里与 `apps/desktop/src/main/automation/catalog.ts` 一起补（漏了会退到兜底图标，
 * 不会渲染失败，但会丢掉「一眼分辨」的价值）。
 */
const TRIGGER_ICONS: Record<string, Component> = {
  daily: CalendarClock,
  interval: Timer,
  'pre-class': BellRing,
  'class-start': CirclePlay,
  'pre-end': Hourglass,
  'class-end': CircleStop,
  'next-lesson': BookOpen,
}

const ACTION_ICONS: Record<string, Component> = {
  'system-notify': Bell,
  'classisland-remind': School,
  'open-folder': FolderOpen,
}

const MODE_ICONS: Record<'agent' | 'normal', Component> = { agent: Bot, normal: Zap }

const STATUS_ICONS: Record<AutomationRun['status'], Component> = {
  running: LoaderCircle,
  success: CircleCheck,
  failed: CircleX,
  interrupted: CircleStop,
}

function triggerIconOf(kind: string): Component {
  return TRIGGER_ICONS[kind] ?? Timer
}

function actionIconOf(kind: string): Component {
  return ACTION_ICONS[kind] ?? Bell
}

function statusIconOf(status: AutomationRun['status']): Component {
  return STATUS_ICONS[status] ?? CircleCheck
}

function describeTrigger(def: AutomationDefinition): string {
  const params = def.trigger.params ?? {}
  switch (def.trigger.kind) {
    case 'daily': {
      const weekdays = Array.isArray(params['weekdays']) ? (params['weekdays'] as number[]) : []
      const days =
        weekdays.length === 0 ? '每天' : weekdays.map((d) => WEEKDAYS[d] ?? String(d)).join('、')
      return `${days} ${String(params['at'] ?? '')}`
    }
    case 'interval':
      return `每 ${String(params['everyMinutes'] ?? '?')} 分钟`
    case 'pre-class':
      return `距上课 ≤ ${String(params['leadMinutes'] ?? '?')} 分钟`
    case 'pre-end':
      return `距下课 ≤ ${String(params['leadMinutes'] ?? '?')} 分钟`
    case 'next-lesson':
      return `下节课是「${String(params['subject'] ?? '')}」时`
    case 'class-start':
      return '上课时'
    case 'class-end':
      return '下课时'
    default:
      return def.trigger.kind
  }
}

/** 卡片上的操作摘要：只给「图标 + 短名」，点开编辑才看参数（版面只留看一眼够用的量） */
function actionChips(def: AutomationDefinition): { icon: Component; text: string }[] {
  return (def.actions ?? []).map((action) => {
    const params = action.params ?? {}
    const kind = action.kind
    if (kind === 'open-folder' && params['target'] !== 'path') {
      const subject = String(params['subject'] ?? '').trim()
      return {
        icon: actionIconOf(kind),
        text: subject === '' ? '打开科目文件夹' : `打开「${subject}」`,
      }
    }
    const labels: Record<string, string> = {
      'system-notify': '系统通知',
      'classisland-remind': 'ClassIsland 提醒',
      'open-folder': '打开文件夹',
    }
    return { icon: actionIconOf(kind), text: labels[kind] ?? kind }
  })
}

const STATUS_LABELS: Record<AutomationRun['status'], string> = {
  running: '进行中',
  success: '成功',
  failed: '失败',
  interrupted: '已中断',
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ───────────────────────── 调用次数（v0.2.8，docs/13 §3.1） ─────────────────────────

/** 调用次数上限（0 = 不限；内置自动化恒为 0） */
function runLimitOf(def: AutomationDefinition): number {
  return def.maxRuns ?? 0
}

/** 已调用次数用尽（判据与主进程 catalog 的 `isRunsExhausted` 同口径） */
function runsExhaustedOf(def: AutomationDefinition): boolean {
  const limit = runLimitOf(def)
  return limit > 0 && (def.runCount ?? 0) >= limit
}

/** 列表卡片上的次数徽章文案（未设上限时返回空串 = 不渲染） */
function runCountLabel(def: AutomationDefinition): string {
  const limit = runLimitOf(def)
  if (limit <= 0) return ''
  return `${def.runCount ?? 0}/${limit}`
}

/** 次数徽章的悬浮说明 */
function runCountHint(def: AutomationDefinition): string {
  if (runsExhaustedOf(def)) return '调用次数已用尽，已自动停用；提高上限或重置计数后可再次启用'
  return `已调用 ${def.runCount ?? 0} / ${runLimitOf(def)} 次；用满后自动停用`
}

/** 输入框 → 上限整数（空 / 非法 / 负数一律 0 = 不限，与主进程校验层的语义一致） */
function parseMaxRuns(raw: string): number {
  const parsed = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

// ───────────────────────── 启停 / 运行 / 删除 ─────────────────────────

async function setEnabled(def: AutomationDefinition, enabled: boolean): Promise<void> {
  const payload = deepClone(def)
  payload.enabled = enabled
  const result = await window.aurora.automation.save(payload)
  if (!result.ok) {
    error.value = result.message
    return
  }
  // 打开一条已用尽的自动化不会立刻报错，但下一次触发会被引擎停回去 ——
  // 如实提示，而不是让用户以为"开了就能用"（docs/13 §3.1）
  if (enabled && runsExhaustedOf(def)) {
    flash('次数已用尽：请提高上限或重置计数')
    await refresh()
    return
  }
  await refresh()
}

/**
 * 内置自动化的启停 = 既有配置开关（docs/13 §6）：`settings:update` 必须回传**完整的**
 * `modes.classroom` 子树（settings:update 只做顶层浅合并，丢子树 = 静默丢字段）。
 */
const BUILTIN_SETTING_KEYS: Record<string, 'preClassReminder' | 'preClassOpenFolder'> = {
  'builtin.pre-class-notify': 'preClassReminder',
  'builtin.pre-class-open-folder': 'preClassOpenFolder',
}

async function setBuiltinEnabled(def: AutomationDefinition, enabled: boolean): Promise<void> {
  const key = BUILTIN_SETTING_KEYS[def.id]
  const modes = settingsStore.settings?.modes
  if (key === undefined || modes === undefined) return
  const ok = await settingsStore.update({
    modes: { ...modes, classroom: { ...modes.classroom, [key]: enabled } },
  })
  if (!ok) {
    error.value = settingsStore.error ?? '保存失败'
    return
  }
  flash('已保存')
  await refresh()
}

async function runOnce(def: AutomationDefinition): Promise<void> {
  const result = await window.aurora.automation.run({ id: def.id })
  if (!result.ok) {
    error.value = result.message
    return
  }
  flash('已触发一次，可在历史里查看结果')
}

async function removeDef(def: AutomationDefinition): Promise<void> {
  if (confirmingDelete.value !== def.id) {
    confirmingDelete.value = def.id
    if (deleteTimer !== null) window.clearTimeout(deleteTimer)
    deleteTimer = window.setTimeout(() => {
      if (confirmingDelete.value === def.id) confirmingDelete.value = null
      deleteTimer = null
    }, 3000)
    return
  }
  confirmingDelete.value = null
  const result = await window.aurora.automation.delete({ id: def.id })
  if (!result.ok) {
    error.value = result.message
    return
  }
  flash('已删除')
  await refresh()
}

// ───────────────────────── 编辑器弹窗（catalog 驱动的动态表单） ─────────────────────────

interface DraftAction {
  kind: string
  params: Record<string, unknown>
}

interface EditorDraft {
  id: string
  name: string
  mode: 'agent' | 'normal'
  triggerKind: string
  triggerParams: Record<string, unknown>
  prompt: string
  actions: DraftAction[]
  /** 启停状态：编辑不改动它（旧版编辑器保存时无条件置 true，会让「编辑」变成「顺带启用」） */
  enabled: boolean
  /**
   * 调用次数上限（输入框态，字符串）：
   * 数字输入框清空时若直接绑 number，`:value` 会把空串顶回数字，用户"删不掉"；
   * 保存时再解析成整数（空 / 非法一律 0 = 不限）。
   */
  maxRuns: string
  /** 已调用次数：由原定义带过来，**保存时必须原样回传**（漏掉等于每次编辑清零计数） */
  runCount: number
}

const editorOpen = ref(false)
const saving = ref(false)
const draft = ref<EditorDraft | null>(null)

const conditionOf = (kind: string) => conditions.value.find((item) => item.kind === kind)
const actionDescriptorOf = (kind: string) => actions.value.find((item) => item.kind === kind)

/** 当前选中的条件描述符（磁贴下方的「说明 + 参数」都取自它） */
const selectedCondition = computed(() =>
  draft.value === null ? undefined : conditionOf(draft.value.triggerKind),
)

function emptyTriggerParams(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'daily':
      return { at: '08:00', weekdays: [] }
    case 'interval':
      return { everyMinutes: 30 }
    case 'pre-class':
    case 'pre-end':
      return { leadMinutes: 5 }
    case 'next-lesson':
      return { subject: '' }
    default:
      return {}
  }
}

function emptyAction(kind: string): DraftAction {
  const params: Record<string, unknown> = {}
  if (kind === 'system-notify') {
    params['title'] = ''
    params['body'] = ''
  } else if (kind === 'classisland-remind') {
    params['title'] = ''
    params['body'] = ''
    params['channel'] = 'custom'
  } else if (kind === 'open-folder') {
    params['target'] = 'subject'
    params['subject'] = ''
    params['path'] = ''
  }
  return { kind, params }
}

function openEditor(def?: AutomationDefinition): void {
  if (def !== undefined) {
    draft.value = {
      id: def.id,
      name: def.name,
      mode: def.mode,
      triggerKind: def.trigger.kind,
      triggerParams: deepClone(def.trigger.params ?? {}),
      prompt: def.prompt ?? '',
      actions: (def.actions ?? []).map((action) => ({
        kind: action.kind,
        params: deepClone(action.params ?? {}),
      })),
      enabled: def.enabled,
      maxRuns: String(def.maxRuns ?? 0),
      runCount: def.runCount ?? 0,
    }
  } else {
    draft.value = {
      id: '',
      name: '',
      mode: tab.value,
      triggerKind: tab.value === 'normal' ? 'pre-class' : 'daily',
      triggerParams: emptyTriggerParams(tab.value === 'normal' ? 'pre-class' : 'daily'),
      prompt: '',
      actions: [emptyAction('system-notify')],
      enabled: true,
      maxRuns: '0',
      runCount: 0,
    }
  }
  // 按 catalog 补齐缺失的参数键（编辑旧定义 / 组件升级后新增字段），控件才有稳定目标
  ensureParamKeys(draft.value.triggerParams, conditionOf(draft.value.triggerKind)?.fields ?? [])
  for (const action of draft.value.actions) {
    ensureParamKeys(action.params, actionDescriptorOf(action.kind)?.fields ?? [])
  }
  editorOpen.value = true
}

function ensureParamKeys(
  params: Record<string, unknown>,
  fields: AutomationDescriptorField[],
): void {
  for (const field of fields) {
    if (params[field.key] !== undefined) continue
    if (field.type === 'weekdays') params[field.key] = []
    else if (field.type === 'number') params[field.key] = field.min ?? 0
    else if (field.type === 'select') params[field.key] = field.options?.[0]?.value ?? ''
    else params[field.key] = ''
  }
}

function closeEditor(): void {
  editorOpen.value = false
  draft.value = null
}

function switchTriggerKind(kind: string): void {
  if (draft.value === null || draft.value.triggerKind === kind) return
  draft.value.triggerKind = kind
  draft.value.triggerParams = emptyTriggerParams(kind)
  // 与 openEditor 同款：新条件的字段先补齐默认值，再交给控件渲染
  ensureParamKeys(draft.value.triggerParams, conditionOf(kind)?.fields ?? [])
}

/** 移除第 index 个操作（组件胶囊直接读 `action.kind`，这里只需裁数组） */
function removeAction(index: number): void {
  const current = draft.value
  if (current === null) return
  current.actions.splice(index, 1)
}

function switchActionKind(index: number, kind: string): void {
  const current = draft.value
  if (current === null || current.actions[index]?.kind === kind) return
  // 换组件 = 换一整套参数：先按新组件补齐默认值，字段控件才有稳定目标
  const next = emptyAction(kind)
  ensureParamKeys(next.params, actionDescriptorOf(kind)?.fields ?? [])
  current.actions[index] = next
}

/** 参数写回（字段控件发上来的 `{ key, value }`）：值类型由字段类型决定，这里直写 */
function setParam(params: Record<string, unknown>, key: string, value: unknown): void {
  params[key] = value
}

async function saveEditor(): Promise<void> {
  const current = draft.value
  if (current === null) return
  if (current.name.trim() === '') {
    error.value = '名称不能为空'
    return
  }
  saving.value = true
  error.value = null
  const triggerKind = current.triggerKind as AutomationDefinition['trigger']['kind']
  const payload: AutomationDefinition = {
    id: current.id,
    name: current.name.trim(),
    enabled: current.enabled,
    mode: current.mode,
    trigger: {
      kind: triggerKind,
      params: deepClone(current.triggerParams),
    },
    // 调用次数：上限按输入解析（空 / 非法 = 0 = 不限），计数原样回传 ——
    // 缺 runCount 会被归一化层判成 0，等于"编辑一次就把计数清零"
    maxRuns: parseMaxRuns(current.maxRuns),
    runCount: current.runCount,
    createdAt: '',
    updatedAt: '',
  }
  if (current.mode === 'agent') payload.prompt = current.prompt
  else {
    payload.actions = current.actions.map((action) => ({
      kind: action.kind as AutomationAction['kind'],
      params: deepClone(action.params),
    }))
  }
  const result = await window.aurora.automation.save(deepClone(payload))
  saving.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  closeEditor()
  flash('已保存')
  await refresh()
}

// ───────────────────────── 历史弹窗 ─────────────────────────

const historyOpen = ref(false)
const runs = ref<AutomationRun[]>([])
const historyLoading = ref(false)
/** Agent 运行的对话回放（点开一条记录后填充） */
const detail = ref<{ run: AutomationRun; messages: ChatMessageDto[] } | null>(null)
const detailLoading = ref(false)

async function openHistory(): Promise<void> {
  historyOpen.value = true
  detail.value = null
  await refreshHistory()
}

async function refreshHistory(): Promise<void> {
  historyLoading.value = true
  const result = await window.aurora.automation.history({
    mode: tab.value,
    limit: 100,
  })
  historyLoading.value = false
  if (result.ok) runs.value = result.value
  else error.value = result.message
}

/** 点开一条 Agent 记录 → 经 chat:history 回放该次对话（docs/13 §7：sessionId = runId）。 */
async function openRunDetail(run: AutomationRun): Promise<void> {
  if (run.mode !== 'agent' || run.sessionId === undefined) return
  detailLoading.value = true
  const result = await window.aurora.chat.history({ sessionId: run.sessionId, limit: 200 })
  detailLoading.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  detail.value = { run, messages: result.value.filter((message) => message.role !== 'system') }
}

function closeHistory(): void {
  historyOpen.value = false
  detail.value = null
}
</script>

<template>
  <section class="auto-page" data-field="automation.page">
    <header class="page-head">
      <Workflow :size="16" :stroke-width="1.7" aria-hidden="true" class="head-icon" />
      <h2 class="page-title">自动化</h2>
      <AppTooltip
        text="定时或满足课堂条件时自动执行：Agent Mode 触发后跑一次完整会话，Normal Mode 按预设操作执行。"
      >
        <button type="button" class="hint-dot" aria-label="自动化说明">
          <Info :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </AppTooltip>

      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab press"
          data-field="automation.tab-agent"
          :class="{ active: tab === 'agent' }"
          role="tab"
          :aria-selected="tab === 'agent'"
          @click="tab = 'agent'"
        >
          <Bot :size="13" :stroke-width="1.7" aria-hidden="true" />
          Agent Mode
        </button>
        <button
          type="button"
          class="tab press"
          data-field="automation.tab-normal"
          :class="{ active: tab === 'normal' }"
          role="tab"
          :aria-selected="tab === 'normal'"
          @click="tab = 'normal'"
        >
          <Zap :size="13" :stroke-width="1.7" aria-hidden="true" />
          Normal Mode
        </button>
      </div>

      <div class="head-actions">
        <AppButton
          variant="secondary"
          size="sm"
          data-action="automation.history"
          @click="openHistory()"
        >
          <History :size="13" :stroke-width="1.7" aria-hidden="true" />
          历史
        </AppButton>
        <AppButton variant="primary" size="sm" data-action="automation.new" @click="openEditor()">
          <Plus :size="14" :stroke-width="1.9" aria-hidden="true" />
          新建
        </AppButton>
        <AppTooltip text="返回对话" placement="bottom">
          <button
            type="button"
            class="icon-btn press"
            data-action="automation-back"
            aria-label="返回对话"
            @click="emit('back')"
          >
            <ArrowLeft :size="15" :stroke-width="1.7" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>
    </header>

    <p v-if="error !== null" class="feedback error" role="alert">
      <TriangleAlert :size="13" :stroke-width="1.8" aria-hidden="true" />
      {{ error }}
    </p>
    <p v-if="notice !== null" class="feedback ok">
      <CircleCheck :size="13" :stroke-width="1.8" aria-hidden="true" />
      {{ notice }}
    </p>

    <div class="list" data-field="automation.list">
      <p v-if="loading && userDefs.length === 0" class="tiny muted empty-hint">加载中…</p>
      <div v-else-if="shownDefs.length === 0" class="empty-state">
        <component
          :is="tab === 'agent' ? Bot : Zap"
          :size="22"
          :stroke-width="1.4"
          aria-hidden="true"
          class="empty-icon"
        />
        <p class="tiny muted">
          {{
            tab === 'agent'
              ? '还没有 Agent Mode 自动化——触发后会由 Agent 执行一次完整任务。'
              : '还没有 Normal Mode 自动化——触发后按预设操作执行，快而确定。'
          }}
        </p>
      </div>

      <article
        v-for="def in shownDefs"
        :key="def.id"
        class="card interactive"
        :class="{ disabled: !def.enabled }"
        :data-field="'automation.item-' + def.id"
      >
        <label class="switch" :title="def.enabled ? '停用' : '启用'">
          <input
            type="checkbox"
            data-field="automation.toggle"
            :checked="def.enabled"
            @change="setEnabled(def, ($event.target as HTMLInputElement).checked)"
          />
          <span class="track" aria-hidden="true"><span class="thumb" /></span>
        </label>
        <div class="card-main">
          <div class="card-title-row">
            <strong class="card-title">{{ def.name }}</strong>
            <span class="mode-chip" :class="def.mode">
              <component
                :is="MODE_ICONS[def.mode]"
                :size="11"
                :stroke-width="1.8"
                aria-hidden="true"
              />
              {{ def.mode === 'agent' ? 'Agent' : 'Normal' }}
            </span>
            <!-- 调用次数（v0.2.8，docs/13 §3.1）：只在上限 > 0 时显示；用尽时整枚转警示色 -->
            <AppTooltip v-if="runCountLabel(def) !== ''" :text="runCountHint(def)">
              <span
                class="runs-chip"
                :class="{ exhausted: runsExhaustedOf(def) }"
                data-field="automation.runs"
              >
                <Repeat :size="11" :stroke-width="1.8" aria-hidden="true" />
                {{ runCountLabel(def) }}
              </span>
            </AppTooltip>
          </div>
          <div class="card-meta">
            <span class="meta-item">
              <component
                :is="triggerIconOf(def.trigger.kind)"
                :size="12"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              {{ describeTrigger(def) }}
            </span>
            <span class="meta-sep" aria-hidden="true" />
            <span v-if="def.mode === 'agent'" class="meta-item clamp">
              <Sparkles :size="12" :stroke-width="1.7" aria-hidden="true" />
              {{ def.prompt }}
            </span>
            <span v-else class="meta-item wrap">
              <span v-for="(chip, index) in actionChips(def)" :key="index" class="act-chip">
                <component :is="chip.icon" :size="11" :stroke-width="1.7" aria-hidden="true" />
                {{ chip.text }}
              </span>
            </span>
          </div>
        </div>
        <div class="card-actions">
          <AppTooltip text="立即运行一次">
            <button
              type="button"
              class="icon-btn press"
              aria-label="立即运行一次"
              @click="runOnce(def)"
            >
              <Play :size="14" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
          <AppTooltip text="编辑">
            <button type="button" class="icon-btn press" aria-label="编辑" @click="openEditor(def)">
              <Pencil :size="14" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
          <AppTooltip :text="confirmingDelete === def.id ? '再点一次确认删除' : '删除'">
            <button
              type="button"
              class="icon-btn press danger"
              :class="{ confirming: confirmingDelete === def.id }"
              data-action="automation.delete"
              :aria-label="confirmingDelete === def.id ? '再点一次确认删除' : '删除'"
              @click="removeDef(def)"
            >
              <Trash2 :size="14" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
      </article>

      <!-- 内置区：仅 Normal tab；启停映射 ClassRoom 既有配置（docs/13 §6） -->
      <section v-if="tab === 'normal'" class="builtin" data-field="automation.builtin">
        <div class="section-head">
          <School :size="13" :stroke-width="1.7" aria-hidden="true" />
          <span>内置</span>
          <AppTooltip
            text="沿用 ClassRoom 的设置（提前分钟数 / 勿扰时段），在「设置 → 模式」里调整。"
          >
            <button type="button" class="hint-dot" aria-label="内置自动化的说明">
              <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
        <article
          v-for="def in builtinShown"
          :key="def.id"
          class="card"
          :class="{ disabled: !def.enabled }"
        >
          <label class="switch" :title="def.enabled ? '停用' : '启用'">
            <input
              type="checkbox"
              data-field="automation.builtin-toggle"
              :checked="def.enabled"
              @change="setBuiltinEnabled(def, ($event.target as HTMLInputElement).checked)"
            />
            <span class="track" aria-hidden="true"><span class="thumb" /></span>
          </label>
          <div class="card-main">
            <div class="card-title-row">
              <strong class="card-title">{{ def.name }}</strong>
              <span class="mode-chip locked">内置</span>
            </div>
            <div class="card-meta">
              <span class="meta-item">
                <component
                  :is="triggerIconOf(def.trigger.kind)"
                  :size="12"
                  :stroke-width="1.7"
                  aria-hidden="true"
                />
                {{ describeTrigger(def) }}
              </span>
              <span class="meta-sep" aria-hidden="true" />
              <span class="meta-item wrap">
                <span v-for="(chip, index) in actionChips(def)" :key="index" class="act-chip">
                  <component :is="chip.icon" :size="11" :stroke-width="1.7" aria-hidden="true" />
                  {{ chip.text }}
                </span>
              </span>
            </div>
          </div>
        </article>
      </section>
    </div>

    <!-- 编辑器弹窗（catalog 驱动的动态表单：条件磁贴 + 参数两列网格） -->
    <!-- 弹窗出入走全局 fade（遮罩）+ anim-pop（面板一次入场），不再硬切 -->
    <Transition name="fade">
      <div v-if="editorOpen && draft !== null" class="modal-scrim" @click.self="closeEditor()">
        <div class="modal editor anim-pop" role="dialog" aria-modal="true" data-field="automation.editor">
        <header class="modal-head">
          <component
            :is="MODE_ICONS[draft.mode]"
            :size="15"
            :stroke-width="1.7"
            aria-hidden="true"
            class="head-icon"
          />
          <h3 class="modal-title">{{ draft.id === '' ? '新建自动化' : '编辑自动化' }}</h3>
          <AppTooltip text="关闭" placement="bottom">
            <button type="button" class="icon-btn press" aria-label="关闭" @click="closeEditor()">
              <X :size="15" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
        </header>

        <div class="modal-body">
          <div class="field-row">
            <span class="field-label">名称</span>
            <input
              v-model="draft.name"
              class="input"
              type="text"
              placeholder="例如：上课前提醒我"
            />
          </div>

          <div class="field-row">
            <span class="field-label">模式</span>
            <div class="mode-picker">
              <button
                type="button"
                class="mode-option press"
                :class="{ active: draft.mode === 'agent' }"
                @click="draft.mode = 'agent'"
              >
                <span class="mode-head">
                  <Bot :size="13" :stroke-width="1.8" aria-hidden="true" />
                  Agent Mode
                </span>
                <span class="tiny muted">触发后由 Agent 执行任务</span>
              </button>
              <button
                type="button"
                class="mode-option press"
                :class="{ active: draft.mode === 'normal' }"
                @click="draft.mode = 'normal'"
              >
                <span class="mode-head">
                  <Zap :size="13" :stroke-width="1.8" aria-hidden="true" />
                  Normal Mode
                </span>
                <span class="tiny muted">按预设操作执行</span>
              </button>
            </div>
          </div>

          <div class="field-row">
            <span class="field-label">调用次数</span>
            <div class="runs-row">
              <input
                v-model="draft.maxRuns"
                class="input"
                data-field="automation.max-runs"
                type="number"
                min="0"
                step="1"
                placeholder="0"
              />
              <span class="tiny muted runs-note">
                上限（0 = 不限）；用满自动停用<template v-if="draft.id !== ''">
                  。已调用 {{ draft.runCount }} 次</template
                >
              </span>
              <AppButton
                v-if="draft.id !== '' && draft.runCount > 0"
                variant="ghost"
                size="sm"
                data-action="automation.reset-runs"
                @click="draft.runCount = 0"
              >
                重置计数
              </AppButton>
            </div>
          </div>

          <section class="section">
            <div class="section-head">
              <component
                :is="triggerIconOf(draft.triggerKind)"
                :size="13"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              <span>触发条件</span>
              <AppTooltip text="课堂类条件依赖课程表数据（来源与节次在「设置 → 模式」里配置）。">
                <button type="button" class="hint-dot" aria-label="触发条件的说明">
                  <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
                </button>
              </AppTooltip>
            </div>

            <!-- 条件选择：图标磁贴网格（点一下即选，7 类全在眼前；描述走悬浮提示） -->
            <div class="tile-grid" role="radiogroup" data-field="automation.trigger-kind">
              <AppTooltip v-for="item in conditions" :key="item.kind" :text="item.description">
                <button
                  type="button"
                  class="tile press"
                  role="radio"
                  :data-kind="item.kind"
                  :aria-checked="draft.triggerKind === item.kind"
                  :class="{ active: draft.triggerKind === item.kind }"
                  @click="switchTriggerKind(item.kind)"
                >
                  <component
                    :is="triggerIconOf(item.kind)"
                    :size="16"
                    :stroke-width="1.7"
                    aria-hidden="true"
                  />
                  <span class="tile-label">{{ item.label }}</span>
                </button>
              </AppTooltip>
            </div>

            <p v-if="selectedCondition !== undefined" class="section-note">
              {{ selectedCondition.description }}
            </p>

            <div v-if="(selectedCondition?.fields ?? []).length > 0" class="param-grid">
              <AutomationFieldInput
                v-for="field in selectedCondition?.fields ?? []"
                :key="field.key"
                :field="field"
                :params="draft.triggerParams"
                @update="setParam(draft.triggerParams, $event.key, $event.value)"
              />
            </div>
          </section>

          <section v-if="draft.mode === 'agent'" class="section">
            <div class="section-head">
              <Sparkles :size="13" :stroke-width="1.7" aria-hidden="true" />
              <span>任务指令</span>
              <AppTooltip text="写清楚目标、步骤与产出；触发时间等上下文会自动附带。">
                <button type="button" class="hint-dot" aria-label="任务指令的说明">
                  <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
                </button>
              </AppTooltip>
            </div>
            <textarea
              v-model="draft.prompt"
              class="input textarea"
              rows="5"
              placeholder="例如：把桌面上今天新增的课件按科目归档到资料文件夹"
            />
          </section>

          <section v-else class="section">
            <div class="section-head">
              <Zap :size="13" :stroke-width="1.7" aria-hidden="true" />
              <span>操作（按顺序执行）</span>
              <AppTooltip
                text="操作是封闭清单（通知 / ClassIsland 提醒 / 打开文件夹）——要更复杂的任务请改用 Agent Mode。"
              >
                <button type="button" class="hint-dot" aria-label="操作清单的说明">
                  <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
                </button>
              </AppTooltip>
              <span class="grow" />
              <span class="tiny muted step-count">{{ draft.actions.length }}/10</span>
            </div>

            <article
              v-for="(action, index) in draft.actions"
              :key="index"
              class="action-row"
              :data-field="'automation.action-' + index"
            >
              <div class="action-head">
                <span class="action-index mono" aria-hidden="true">{{ index + 1 }}</span>
                <div class="chip-group">
                  <button
                    v-for="item in availableActions"
                    :key="item.kind"
                    type="button"
                    class="chip press"
                    :class="{ active: action.kind === item.kind }"
                    :aria-pressed="action.kind === item.kind"
                    @click="switchActionKind(index, item.kind)"
                  >
                    <component
                      :is="actionIconOf(item.kind)"
                      :size="11"
                      :stroke-width="1.8"
                      aria-hidden="true"
                    />
                    {{ item.label }}
                  </button>
                </div>
                <span class="grow" />
                <AppTooltip text="移除该操作">
                  <button
                    type="button"
                    class="icon-btn press danger"
                    aria-label="移除该操作"
                    @click="removeAction(index)"
                  >
                    <Trash2 :size="13" :stroke-width="1.7" aria-hidden="true" />
                  </button>
                </AppTooltip>
              </div>
              <div
                v-if="(actionDescriptorOf(action.kind)?.fields ?? []).length > 0"
                class="param-grid"
              >
                <AutomationFieldInput
                  v-for="field in actionDescriptorOf(action.kind)?.fields ?? []"
                  :key="field.key"
                  :field="field"
                  :params="action.params"
                  @update="setParam(action.params, $event.key, $event.value)"
                />
              </div>
            </article>

            <AppButton
              variant="secondary"
              size="sm"
              data-action="automation.add-action"
              :disabled="draft.actions.length >= 10"
              @click="draft.actions.push(emptyAction(availableActions[0]?.kind ?? 'system-notify'))"
            >
              <Plus :size="13" :stroke-width="1.9" aria-hidden="true" />
              添加操作
            </AppButton>
          </section>
        </div>

        <footer class="modal-foot">
          <AppButton
            variant="secondary"
            size="sm"
            data-action="automation.editor-cancel"
            @click="closeEditor()"
          >
            取消
          </AppButton>
          <AppButton variant="primary" size="sm" :disabled="saving" @click="saveEditor()">
            {{ saving ? '保存中…' : '保存' }}
          </AppButton>
        </footer>
      </div>
    </div>
    </Transition>

    <!-- 历史弹窗：Agent 记录可展开对话回放；Normal 只显示触发时间与状态（docs/13 §11） -->
    <Transition name="fade">
      <div v-if="historyOpen" class="modal-scrim" @click.self="closeHistory()">
        <div
          class="modal history anim-pop"
          role="dialog"
          aria-modal="true"
          data-field="automation.history-panel"
        >
        <header class="modal-head">
          <component
            :is="tab === 'agent' ? Bot : Zap"
            :size="15"
            :stroke-width="1.7"
            aria-hidden="true"
            class="head-icon"
          />
          <h3 class="modal-title">
            运行历史 · {{ tab === 'agent' ? 'Agent Mode' : 'Normal Mode' }}
          </h3>
          <AppTooltip text="关闭" placement="bottom">
            <button
              type="button"
              class="icon-btn press"
              data-action="automation.history-close"
              aria-label="关闭"
              @click="closeHistory()"
            >
              <X :size="15" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
        </header>
        <div class="modal-body">
          <p v-if="historyLoading && runs.length === 0" class="tiny muted">加载中…</p>
          <p v-else-if="runs.length === 0" class="tiny muted">还没有运行记录。</p>
          <ul v-else class="run-list" data-field="automation.history-list">
            <li
              v-for="run in runs"
              :key="run.id"
              class="run-item"
              :class="{ clickable: run.mode === 'agent' && run.sessionId !== undefined }"
              @click="openRunDetail(run)"
            >
              <span class="run-status-icon" :class="run.status" aria-hidden="true">
                <component
                  :is="statusIconOf(run.status)"
                  :size="13"
                  :stroke-width="1.8"
                  :class="{ spin: run.status === 'running' }"
                />
              </span>
              <span class="run-time">
                <Clock :size="12" :stroke-width="1.7" aria-hidden="true" />
                {{ formatTime(run.triggeredAt) }}
              </span>
              <span class="run-name">{{ run.automationName }}</span>
              <span class="run-status tiny" :class="run.status">{{
                STATUS_LABELS[run.status]
              }}</span>
              <span v-if="run.durationMs !== undefined" class="tiny muted run-duration">
                {{ formatDuration(run.durationMs) }}
              </span>
              <!-- Agent 记录的「可展开」提示：不再是整行只有隐式的 hover 光标，
                   右侧常驻一枚低对比度入口，触屏 / 键盘用户也能发现回放能力 -->
              <span
                v-if="run.mode === 'agent' && run.sessionId !== undefined"
                class="run-open tiny"
                aria-hidden="true"
              >
                查看对话
                <ChevronRight :size="11" :stroke-width="1.8" />
              </span>
              <!-- 失败原因就地可见：整行第二行小字（hover 有全文），不用点开任何东西 -->
              <span
                v-if="run.status === 'failed' && run.error !== undefined && run.error !== ''"
                class="run-error tiny"
                :title="run.error"
              >
                {{ run.error }}
              </span>
            </li>
          </ul>

          <section v-if="detail !== null" class="run-detail">
            <h4 class="tiny muted detail-title">
              「{{ detail.run.automationName }}」的对话回放 · {{ formatTime(detail.run.triggeredAt) }}
              · {{ STATUS_LABELS[detail.run.status] }}<template
                v-if="detail.run.durationMs !== undefined"
              >
                · {{ formatDuration(detail.run.durationMs) }}</template
              >
            </h4>
            <p v-if="detailLoading" class="tiny muted">加载对话…</p>
            <div v-else-if="detail.messages.length === 0" class="tiny muted">
              会话已被删除或还没有消息。
            </div>
            <template v-else>
              <div
                v-for="message in detail.messages"
                :key="message.id"
                class="detail-message"
                :class="message.role"
              >
                <span class="role-tag tiny muted">{{
                  message.role === 'user' ? '任务' : 'Agent'
                }}</span>
                <p class="detail-content">{{ message.content }}</p>
              </div>
            </template>
          </section>
        </div>
      </div>
    </div>
    </Transition>
  </section>
</template>

<style scoped>
.auto-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

/* 页头：标题 + tab + 右侧动作**一行**（放不下时整体折行，任何窗口宽度都不溢出/重叠） */
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
}

.head-icon {
  flex: 0 0 auto;
}

.page-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  color: var(--text-primary);
}

/* 「说明」标记：文案离开版面后，靠它把解释留在手边 */
.hint-dot {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--text-muted);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.hint-dot:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* 折行后仍贴右（比放一个 flex 撑开的空元素更稳：空元素自己也会占一行） */
  margin-left: auto;
}

.tabs {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--fill-2);
  gap: 2px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.tab.active {
  background: var(--bg-raised);
  color: var(--text-primary);
  box-shadow: var(--shadow-hairline);
}

.grow {
  flex: 1;
}

.feedback {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  padding: 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.feedback.error {
  background: var(--error-fill);
  color: var(--error-text);
}

.feedback.ok {
  background: var(--ok-fill);
  color: var(--ok-text);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.empty-hint {
  padding: var(--space-4);
  text-align: center;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.empty-state p {
  margin: 0;
  max-width: 380px;
}

.empty-icon {
  color: var(--text-muted);
  opacity: 0.7;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  transition: opacity var(--transition-fast);
}

.card.disabled {
  opacity: 0.62;
}

/* 悬停时把边界提亮一档（`.interactive` 负责上浮与阴影），一眼知道这张卡可操作 */
.card:hover {
  border-color: var(--border-strong);
}

.card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 15px;
  background: var(--fill-3);
  color: var(--text-muted);
}

.mode-chip.agent {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
}

.mode-chip.locked {
  background: var(--fill-2);
}

/* 调用次数徽章（与模式徽章同形，用尽时转警示色） */
.runs-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 15px;
  background: var(--fill-2);
  color: var(--text-muted);
}

.runs-chip.exhausted {
  background: var(--danger-fill);
  color: var(--danger-text);
}

/* 元信息行：条件 + 分隔点 + 摘要（摘要过长时截断，绝不撑破卡片） */
.card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px var(--space-2);
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.meta-item.clamp {
  flex: 1 1 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-item.wrap {
  flex-wrap: wrap;
  gap: 4px;
}

.meta-sep {
  flex: 0 0 auto;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-muted);
  opacity: 0.6;
}

/* 操作摘要胶囊：一屏看清「这条自动化会做什么」，不用读整句 */
.act-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  line-height: 15px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

.icon-btn.danger:hover,
.icon-btn.danger.confirming {
  color: var(--status-error);
}

/* 两段式删除的中间态：边框一圈红，配合悬浮提示说清「再点一次」 */
.icon-btn.confirming {
  box-shadow: inset 0 0 0 1px var(--danger-border);
  background: var(--danger-fill);
}

.builtin {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

/* 区组头（内置 / 弹窗内的「触发条件」「任务指令」共用）：图标 + 标题 + 说明标记 */
.section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

/* ── 开关（与设置页 checkbox 口径一致的迷你 switch） ── */
.switch {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  cursor: pointer;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}

.switch .track {
  display: inline-flex;
  align-items: center;
  width: 30px;
  height: 18px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  transition: background var(--transition-fast);
}

.switch .thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--bg-raised);
  box-shadow: var(--shadow-hairline);
  transition: transform var(--transition-fast);
}

.switch input:checked + .track {
  background: var(--aurora-blue);
}

.switch input:checked + .track .thumb {
  transform: translateX(12px);
}

.switch input:focus-visible + .track {
  outline: 2px solid var(--aurora-blue);
  outline-offset: 2px;
}

/* ── 弹窗（遮罩 + --z-popover；底色必须用弹层专用令牌 --bg-overlay） ── */
.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: grid;
  place-items: center;
  background: var(--overlay-scrim);
}

.modal {
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 48px));
  max-height: min(660px, calc(100vh - 56px));
  border-radius: var(--radius-lg);
  /* 弹层专用底色令牌（`--surface-1` 不存在 —— 用了它弹窗会透明、页面内容透进来） */
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-2);
  animation: aurora-pop-in var(--dur-base) var(--ease-spring) both;
}

.modal.history {
  width: min(660px, calc(100vw - 48px));
}

.modal-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.modal-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-subtle);
}

/* ── 表单：左标签 / 右控件（标签列定宽，两侧都在自己的格子里） ── */
.field-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

/* 调用次数一行：窄输入 + 说明 +（编辑既有定义时）重置按钮。
   宽度写在 `.runs-row .input` 里（两级选择器）：`.input` 的 `width: 100%` 定义在本段之后，
   只写 `.runs-input` 会被它按源码顺序压过去 —— 症状是输入框占满整行、说明被挤成一列竖排字。 */
.runs-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.runs-row .input {
  width: 84px;
  flex: 0 0 auto;
}

.runs-note {
  flex: 1 1 auto;
  min-width: 0;
}

.input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font-size: var(--text-sm);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.input:hover {
  background: var(--fill-2);
}

.input:focus-visible {
  outline: none;
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 2px var(--accent-ring);
}

.textarea {
  height: auto;
  padding: var(--space-2);
  line-height: var(--leading-relaxed);
  resize: vertical;
}

/* 区组：条件 / 执行两大块，块之间用细分隔线（不靠堆文字制造层级） */
.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.section-note {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.param-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.step-count {
  font-variant-numeric: var(--num-tabular);
}

/* 条件磁贴：图标在上、文字在下；选中态用强调色边界 + 淡填充 */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-2);
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  text-align: left;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

/* 磁贴外层的提示锚点：撑满网格格，磁贴本体才能等高 */
.tile-grid > .tip-host {
  display: flex;
}

.tile:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.tile.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 10%, transparent);
  color: var(--text-primary);
}

.tile-label {
  font-size: var(--text-xs);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.mode-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-2);
}

.mode-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  text-align: left;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.mode-option:hover {
  background: var(--fill-2);
}

.mode-option.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.mode-head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

/* 操作行：序号 + 组件胶囊 + 参数网格，一行一块的视觉分组 */
.action-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
}

.action-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.action-index {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--fill-3);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.chip-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1.4;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.chip:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.chip.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--text-primary);
}

/* ── 历史 ── */
.run-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.run-item {
  display: flex;
  /* wrap 是给失败原因行留的：`.run-error` 占满一整行折到状态行下面 */
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.run-item.clickable {
  cursor: pointer;
}

.run-item.clickable:hover {
  background: var(--fill-2);
}

.run-status-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--text-muted);
}

.run-status-icon.success {
  color: var(--status-ok);
}

.run-status-icon.failed,
.run-status-icon.interrupted {
  color: var(--status-error);
}

.run-status-icon.running {
  color: var(--accent-text);
}

.run-time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  font-variant-numeric: var(--num-tabular);
  flex: 0 0 auto;
}

.run-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.run-status {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.run-status.success {
  color: var(--status-ok);
}

.run-status.failed,
.run-status.interrupted {
  color: var(--status-error);
}

.run-status.running {
  color: var(--accent-text);
}

.run-duration {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

/* Agent 记录的「查看对话」入口：muted 常驻、hover 行上才提亮（低噪声但可发现） */
.run-open {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  color: var(--text-muted);
  transition: color var(--transition-fast);
}

.run-item.clickable:hover .run-open {
  color: var(--accent-text);
}

/* 失败原因：占满整行折到第二行，单行省略（全文挂 title） */
.run-error {
  flex-basis: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--status-error);
}

/* 运行中的记录：状态图标自旋（模板里挂 .spin）之外，颜色再缓慢呼吸一档，
   与主界面工具卡的运行态是同一种语言（全局 aurora-breathe，theme.css） */
.run-status-icon.running {
  animation: aurora-breathe var(--dur-pulse) var(--ease-standard) infinite;
}

.run-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.detail-title {
  margin: 0;
}

.detail-message {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.detail-message.user {
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.role-tag {
  letter-spacing: var(--tracking-eyebrow);
}

.detail-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}
</style>
