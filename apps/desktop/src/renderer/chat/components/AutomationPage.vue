<script setup lang="ts">
/**
 * 自动化页（docs/13 §11，docs/07 §2.3）：主区第三种 view（与子代理页同构，不属任何会话）。
 *
 * 结构：顶部「Agent Mode / Normal Mode」双 tab + 新建 / 历史按钮 →
 * 按当前 tab 过滤的自动化卡片列表（名称 + 触发描述 + 启停 + 编辑 / 删除 / 立即运行）→
 * Normal tab 底部「内置」区（ClassRoom 既有自动操作，启停映射既有配置，docs/13 §6）→
 * 编辑器弹窗（仓库首个 Modal：catalog 驱动的动态表单）→ 历史弹窗（Agent 行可展开对话回放）。
 *
 * 门控口径：catalog 里 `available: false` 的操作组件**不渲染选项**（不是 disabled）；
 * 内置自动化的开关直接写 `modes.classroom.preClassReminder / preClassOpenFolder`——
 * 它们的启停条件本来就长在既有配置上，不另立状态（docs/13 §6）。
 * 历史弹窗里 Normal 记录**只显示触发时间与状态**（不展开操作明细，产品口径）。
 *
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §5.3），不可改名。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  AutomationAction,
  AutomationCatalog,
  AutomationDefinition,
  AutomationDescriptorField,
  AutomationRun,
  ChatMessageDto,
} from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import { deepClone } from '@aurora/shared/browser'
import { useSettingsStore } from '../../shared/stores.js'
import {
  Bot,
  Clock,
  History,
  Pencil,
  Play,
  Plus,
  Timer,
  Trash2,
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

// ───────────────────────── 触发器 / 状态的展示文案 ─────────────────────────

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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

function actionLabel(action: AutomationAction): string {
  const params = action.params ?? {}
  switch (action.kind) {
    case 'system-notify':
      return `系统通知「${String(params['title'] ?? '')}」`
    case 'classisland-remind':
      return `ClassIsland 提醒「${String(params['title'] ?? '')}」`
    case 'open-folder':
      if (params['target'] === 'path') return `打开 ${String(params['path'] ?? '')}`
      // 内置自动化不带科目名（科目来自触发的那节课）：空值时说「当前科目」而不是「打开「」」
      return String(params['subject'] ?? '').trim() === ''
        ? '打开该科目的资料文件夹'
        : `打开「${String(params['subject'])}」的科目文件夹`
    default:
      return action.kind
  }
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

// ───────────────────────── 启停 / 运行 / 删除 ─────────────────────────

async function setEnabled(def: AutomationDefinition, enabled: boolean): Promise<void> {
  const payload = deepClone(def)
  payload.enabled = enabled
  const result = await window.aurora.automation.save(payload)
  if (!result.ok) {
    error.value = result.message
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
  notice.value = '已保存'
  await refresh()
}

async function runOnce(def: AutomationDefinition): Promise<void> {
  const result = await window.aurora.automation.run({ id: def.id })
  if (!result.ok) {
    error.value = result.message
    return
  }
  notice.value = '已触发一次，可在历史里查看结果'
}

async function removeDef(def: AutomationDefinition): Promise<void> {
  if (confirmingDelete.value !== def.id) {
    confirmingDelete.value = def.id
    window.setTimeout(() => {
      if (confirmingDelete.value === def.id) confirmingDelete.value = null
    }, 3000)
    return
  }
  confirmingDelete.value = null
  const result = await window.aurora.automation.delete({ id: def.id })
  if (!result.ok) {
    error.value = result.message
    return
  }
  notice.value = '已删除'
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
}

const editorOpen = ref(false)
const saving = ref(false)
const draft = ref<EditorDraft | null>(null)
/** 当前编辑器选中的操作组件 kind（下拉值，与 draft.actions 同步） */
const draftActionKinds = ref<string[]>([])

const conditionOf = (kind: string) => conditions.value.find((item) => item.kind === kind)
const actionDescriptorOf = (kind: string) => actions.value.find((item) => item.kind === kind)

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
    }
  }
  // 按 catalog 补齐缺失的参数键（编辑旧定义 / 组件升级后新增字段），v-model 才有稳定目标
  ensureParamKeys(draft.value.triggerParams, conditionOf(draft.value.triggerKind)?.fields ?? [])
  for (const action of draft.value.actions) {
    ensureParamKeys(action.params, actionDescriptorOf(action.kind)?.fields ?? [])
  }
  draftActionKinds.value = draft.value.actions.map((action) => action.kind)
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
  if (draft.value === null) return
  draft.value.triggerKind = kind
  draft.value.triggerParams = emptyTriggerParams(kind)
}

/** 移除第 index 个操作（与 draftActionKinds 同步裁剪，见 openEditor 的镜像说明） */
function removeAction(index: number): void {
  const current = draft.value
  if (current === null) return
  current.actions.splice(index, 1)
  draftActionKinds.value = current.actions.map((action) => action.kind)
}

function switchActionKind(index: number, kind: string): void {
  const current = draft.value
  if (current === null) return
  current.actions[index] = emptyAction(kind)
  draftActionKinds.value = current.actions.map((action) => action.kind)
}

/** weekdays 字段：checkbox 组 → number[]（空数组 = 每天） */
function weekdayChecked(params: Record<string, unknown>, day: number): boolean {
  const weekdays = Array.isArray(params['weekdays']) ? (params['weekdays'] as number[]) : []
  return weekdays.includes(day)
}

function toggleWeekday(params: Record<string, unknown>, day: number, checked: boolean): void {
  const weekdays = new Set(
    Array.isArray(params['weekdays']) ? (params['weekdays'] as number[]) : [],
  )
  if (checked) weekdays.add(day)
  else weekdays.delete(day)
  params['weekdays'] = [...weekdays].sort((a, b) => a - b)
}

/** 参数读值（openEditor 已按 catalog 补齐键；这里兜底非原始值） */
function paramValue(params: Record<string, unknown>, key: string): string | number {
  const value = params[key]
  return typeof value === 'string' || typeof value === 'number' ? value : ''
}

function setParam(params: Record<string, unknown>, key: string, value: string | number): void {
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
    enabled: true,
    mode: current.mode,
    trigger: {
      kind: triggerKind,
      params: deepClone(current.triggerParams),
    },
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
  notice.value = '已保存'
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
      <div class="title-row">
        <Workflow :size="18" :stroke-width="1.6" aria-hidden="true" />
        <h2 class="page-title">自动化</h2>
        <span class="grow" />
        <button
          type="button"
          class="icon-btn press"
          data-action="automation-back"
          title="返回对话"
          aria-label="返回对话"
          @click="emit('back')"
        >
          <X :size="15" :stroke-width="1.6" aria-hidden="true" />
        </button>
      </div>
      <p class="page-sub muted">
        定时或满足课堂条件时自动执行——Agent Mode 跑一次会话，Normal Mode 执行预设操作。
      </p>
      <div class="toolbar">
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
            <Bot :size="14" :stroke-width="1.6" aria-hidden="true" />
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
            <Zap :size="14" :stroke-width="1.6" aria-hidden="true" />
            Normal Mode
          </button>
        </div>
        <span class="grow" />
        <AppButton
          variant="secondary"
          size="sm"
          data-action="automation.history"
          @click="openHistory()"
        >
          <History :size="14" :stroke-width="1.6" aria-hidden="true" />
          历史
        </AppButton>
        <AppButton variant="primary" size="sm" data-action="automation.new" @click="openEditor()">
          <Plus :size="14" :stroke-width="1.8" aria-hidden="true" />
          新建自动化
        </AppButton>
      </div>
    </header>

    <p v-if="error !== null" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="notice !== null" class="feedback ok">{{ notice }}</p>

    <div class="list" data-field="automation.list">
      <p v-if="loading && userDefs.length === 0" class="tiny muted empty-hint">加载中…</p>
      <p v-else-if="shownDefs.length === 0" class="tiny muted empty-hint">
        {{
          tab === 'agent'
            ? '还没有 Agent Mode 自动化——触发后会由 Agent 执行一次完整任务。'
            : '还没有 Normal Mode 自动化——触发后按预设操作执行，快而确定。'
        }}
      </p>

      <article
        v-for="def in shownDefs"
        :key="def.id"
        class="card"
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
            <span class="mode-tag tiny" :class="def.mode">{{
              def.mode === 'agent' ? 'Agent' : 'Normal'
            }}</span>
          </div>
          <p class="card-meta tiny muted">
            <Timer :size="12" :stroke-width="1.6" aria-hidden="true" />
            {{ describeTrigger(def) }}
          </p>
          <p v-if="def.mode === 'agent'" class="card-prompt tiny muted">{{ def.prompt }}</p>
          <p v-else class="card-prompt tiny muted">
            {{ (def.actions ?? []).map(actionLabel).join('；') }}
          </p>
        </div>
        <div class="card-actions">
          <button
            type="button"
            class="icon-btn press"
            title="立即运行一次"
            aria-label="立即运行一次"
            @click="runOnce(def)"
          >
            <Play :size="14" :stroke-width="1.6" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="icon-btn press"
            title="编辑"
            aria-label="编辑"
            @click="openEditor(def)"
          >
            <Pencil :size="14" :stroke-width="1.6" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="icon-btn press danger"
            data-action="automation.delete"
            :title="confirmingDelete === def.id ? '再点一次确认删除' : '删除'"
            :aria-label="confirmingDelete === def.id ? '再点一次确认删除' : '删除'"
            @click="removeDef(def)"
          >
            <Trash2 :size="14" :stroke-width="1.6" aria-hidden="true" />
          </button>
        </div>
      </article>

      <!-- 内置区：仅 Normal tab；启停映射 ClassRoom 既有配置（docs/13 §6） -->
      <section v-if="tab === 'normal'" class="builtin" data-field="automation.builtin">
        <p class="nav-caption tiny muted">内置（ClassRoom）</p>
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
              <span class="mode-tag normal tiny">内置</span>
            </div>
            <p class="card-meta tiny muted">
              <Timer :size="12" :stroke-width="1.6" aria-hidden="true" />
              {{ describeTrigger(def) }}
            </p>
            <p class="card-prompt tiny muted">
              {{ (def.actions ?? []).map(actionLabel).join('；') }}
            </p>
          </div>
        </article>
        <p class="tiny muted builtin-hint">
          内置自动化沿用 ClassRoom 的设置（提前分钟数 / 勿扰时段），在「设置 → 模式」里调整。
        </p>
      </section>
    </div>

    <!-- 编辑器弹窗（仓库首个 Modal：遮罩 + --z-popover；Esc / 点遮罩关闭） -->
    <div v-if="editorOpen && draft !== null" class="modal-scrim" @click.self="closeEditor()">
      <div class="modal editor" role="dialog" aria-modal="true" data-field="automation.editor">
        <header class="modal-head">
          <h3 class="modal-title">{{ draft.id === '' ? '新建自动化' : '编辑自动化' }}</h3>
          <button type="button" class="icon-btn press" aria-label="关闭" @click="closeEditor()">
            <X :size="15" :stroke-width="1.6" aria-hidden="true" />
          </button>
        </header>

        <div class="modal-body">
          <label class="field">
            <span class="field-label">名称</span>
            <input v-model="draft.name" type="text" placeholder="例如：上课前提醒我" />
          </label>

          <div class="field">
            <span class="field-label">模式</span>
            <div class="mode-picker">
              <button
                type="button"
                class="mode-option press"
                :class="{ active: draft.mode === 'agent' }"
                @click="draft.mode = 'agent'"
              >
                <strong>Agent Mode</strong>
                <span class="tiny muted">触发后由 Agent 执行任务</span>
              </button>
              <button
                type="button"
                class="mode-option press"
                :class="{ active: draft.mode === 'normal' }"
                @click="draft.mode = 'normal'"
              >
                <strong>Normal Mode</strong>
                <span class="tiny muted">按预设操作执行</span>
              </button>
            </div>
          </div>

          <div class="field">
            <span class="field-label">触发器</span>
            <select
              :value="draft.triggerKind"
              data-field="automation.trigger-kind"
              @change="switchTriggerKind(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="item in conditions" :key="item.kind" :value="item.kind">
                {{ item.label }}
              </option>
            </select>
            <p v-if="conditionOf(draft.triggerKind)?.description" class="tiny muted field-hint">
              {{ conditionOf(draft.triggerKind)?.description }}
            </p>
            <div
              v-for="field in conditionOf(draft.triggerKind)?.fields ?? []"
              :key="field.key"
              class="sub-field"
            >
              <span class="field-label tiny">{{ field.label }}</span>
              <input
                v-if="field.type === 'text' || field.type === 'time'"
                :value="paramValue(draft.triggerParams, field.key)"
                type="text"
                :placeholder="field.placeholder ?? ''"
                @input="
                  setParam(
                    draft.triggerParams,
                    field.key,
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
              <input
                v-else-if="field.type === 'number'"
                :value="paramValue(draft.triggerParams, field.key)"
                type="number"
                :min="field.min"
                :max="field.max"
                :step="field.step ?? 1"
                @input="
                  setParam(
                    draft.triggerParams,
                    field.key,
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
              />
              <select
                v-else-if="field.type === 'select'"
                :value="paramValue(draft.triggerParams, field.key)"
                @change="
                  setParam(
                    draft.triggerParams,
                    field.key,
                    ($event.target as HTMLSelectElement).value,
                  )
                "
              >
                <option
                  v-for="option in field.options ?? []"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <div v-else-if="field.type === 'weekdays'" class="weekday-row">
                <label v-for="(name, day) in WEEKDAYS" :key="day" class="weekday tiny">
                  <input
                    type="checkbox"
                    :checked="weekdayChecked(draft.triggerParams, day)"
                    @change="
                      toggleWeekday(
                        draft.triggerParams,
                        day,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />
                  {{ name }}
                </label>
              </div>
              <p v-if="field.hint" class="tiny muted field-hint">{{ field.hint }}</p>
            </div>
          </div>

          <label v-if="draft.mode === 'agent'" class="field">
            <span class="field-label">任务指令（触发后交给 Agent 执行）</span>
            <textarea
              v-model="draft.prompt"
              rows="5"
              placeholder="写清楚目标、步骤与产出；触发时间等上下文会自动附带"
            />
          </label>

          <div v-else class="field">
            <span class="field-label">操作（按顺序执行）</span>
            <div
              v-for="(action, index) in draft.actions"
              :key="index"
              class="action-row"
              :data-field="'automation.action-' + index"
            >
              <select
                :value="action.kind"
                @change="switchActionKind(index, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="item in availableActions" :key="item.kind" :value="item.kind">
                  {{ item.label }}
                </option>
              </select>
              <div
                v-for="field in actionDescriptorOf(action.kind)?.fields ?? []"
                :key="field.key"
                class="sub-field"
              >
                <span class="field-label tiny">{{ field.label }}</span>
                <input
                  v-if="field.type === 'text' || field.type === 'time'"
                  :value="paramValue(action.params, field.key)"
                  type="text"
                  :placeholder="field.placeholder ?? ''"
                  @input="
                    setParam(action.params, field.key, ($event.target as HTMLInputElement).value)
                  "
                />
                <select
                  v-else-if="field.type === 'select'"
                  :value="paramValue(action.params, field.key)"
                  @change="
                    setParam(action.params, field.key, ($event.target as HTMLSelectElement).value)
                  "
                >
                  <option
                    v-for="option in field.options ?? []"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
              </div>
              <button
                type="button"
                class="icon-btn press danger"
                title="移除该操作"
                aria-label="移除该操作"
                @click="removeAction(index)"
              >
                <Trash2 :size="13" :stroke-width="1.6" aria-hidden="true" />
              </button>
            </div>
            <AppButton
              variant="secondary"
              size="sm"
              data-action="automation.add-action"
              :disabled="draft.actions.length >= 10"
              @click="draft.actions.push(emptyAction(availableActions[0]?.kind ?? 'system-notify'))"
            >
              <Plus :size="13" :stroke-width="1.8" aria-hidden="true" />
              添加操作
            </AppButton>
            <p class="tiny muted field-hint">
              Normal Mode 的操作是封闭清单（通知 / ClassIsland 提醒 /
              打开文件夹）——要更复杂的任务请用 Agent Mode。
            </p>
          </div>
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

    <!-- 历史弹窗：Agent 记录可展开对话回放；Normal 只显示触发时间与状态（docs/13 §11） -->
    <div v-if="historyOpen" class="modal-scrim" @click.self="closeHistory()">
      <div
        class="modal history"
        role="dialog"
        aria-modal="true"
        data-field="automation.history-panel"
      >
        <header class="modal-head">
          <h3 class="modal-title">
            运行历史 · {{ tab === 'agent' ? 'Agent Mode' : 'Normal Mode' }}
          </h3>
          <button
            type="button"
            class="icon-btn press"
            data-action="automation.history-close"
            aria-label="关闭"
            @click="closeHistory()"
          >
            <X :size="15" :stroke-width="1.6" aria-hidden="true" />
          </button>
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
              <span class="run-time">
                <Clock :size="12" :stroke-width="1.6" aria-hidden="true" />
                {{ formatTime(run.triggeredAt) }}
              </span>
              <span class="run-name">{{ run.automationName }}</span>
              <span class="run-status tiny" :class="run.status">{{
                STATUS_LABELS[run.status]
              }}</span>
              <span v-if="run.durationMs !== undefined" class="tiny muted run-duration">
                {{ formatDuration(run.durationMs) }}
              </span>
            </li>
          </ul>

          <section v-if="detail !== null" class="run-detail">
            <h4 class="tiny muted detail-title">
              「{{ detail.run.automationName }}」的对话回放（{{
                formatTime(detail.run.triggeredAt)
              }}）
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

.page-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
}

.page-title {
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
}

.page-sub {
  margin: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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
  font-weight: var(--weight-medium);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.tab.active {
  background: var(--surface-1);
  color: var(--text-primary);
  box-shadow: var(--shadow-hairline);
}

.grow {
  flex: 1;
}

.feedback {
  margin: 0;
  padding: 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.feedback.error {
  background: color-mix(in srgb, var(--status-error) 12%, transparent);
  color: var(--status-error);
}

.feedback.ok {
  background: color-mix(in srgb, var(--status-ok) 12%, transparent);
  color: var(--status-ok);
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

.card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card-title {
  font-size: var(--text-base);
}

.mode-tag {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  line-height: 16px;
}

.mode-tag.agent {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
}

.mode-tag.normal {
  background: var(--fill-3);
  color: var(--text-muted);
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
}

.card-prompt {
  margin: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
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

.icon-btn.danger:hover {
  color: var(--status-error);
}

.builtin {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.builtin-hint {
  margin: 0;
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

/* ── 弹窗（仓库首个 Modal：--z-popover + 遮罩令牌） ── */
.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: grid;
  place-items: center;
  background: var(--overlay-scrim);
  animation: aurora-fade var(--dur-fast) var(--ease-out) both;
}

.modal {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 64px));
  border-radius: var(--radius-lg);
  /* 弹层专用底色令牌（`--surface-1` 不存在 —— 用了它弹窗会透明、页面内容透进来） */
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-2);
  animation: aurora-rise var(--dur-base) var(--ease-spring) both;
}

.modal.history {
  width: min(640px, calc(100vw - 48px));
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.modal-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
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

/* ── 表单 ── */
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}

.field-hint {
  margin: 0;
}

.mode-picker {
  display: grid;
  grid-template-columns: 1fr 1fr;
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
  text-align: left;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.mode-option.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.sub-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: var(--space-3);
  border-left: 2px solid var(--fill-3);
}

.weekday-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.weekday {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.action-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  background: var(--fill-1);
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
  text-transform: uppercase;
  letter-spacing: var(--tracking-eyebrow);
}

.detail-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--text-sm);
  line-height: 1.55;
}
</style>
