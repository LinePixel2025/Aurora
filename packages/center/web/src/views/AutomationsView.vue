<script setup lang="ts">
/**
 * 自动化管理页（#/automations，docs/13 §10）：经 WS 命令直达客户端，服务器不缓存。
 * 列表分 Agent / Normal / 内置三组；启停与修改走整份定义回传（automation.save）；
 * 新建 / 编辑按客户端回传的 catalog 动态渲染表单；底部是运行历史。
 */
import { computed, ref, watch } from 'vue'
import type {
  AutomationActionKind,
  AutomationDefinition,
  AutomationDescriptorField,
  AutomationMode,
  AutomationRun,
  AutomationRunStatus,
  AutomationTriggerKind,
} from '@aurora/shared'
import type { SessionState } from '../state'
import { History, Pencil, Play, Plus, Trash2, Workflow, X } from '@aurora/shared/browser'
import AutomationFields from '../components/AutomationFields.vue'
import MessageStream from '../components/console/MessageStream.vue'
import { formatTime } from '../lib/format'
import {
  clientsSorted,
  deleteAutomation,
  fetchAutomationCatalog,
  fetchAutomationHistory,
  listAutomations,
  loadRunTranscript,
  runAutomation,
  saveAutomation,
  selectClient,
  state,
} from '../state'

// ───────────────────────── 设备选择与加载 ─────────────────────────

const loading = ref(false)
const error = ref('')
const notice = ref('')
/** 历史筛选（'' = 全部；点行「历史」按钮切换）；watch 回调会重置它，须先声明 */
const historyFilter = ref('')
/** 每页条数（历史上限 500 在客户端，翻页就是把「取到第几条」推给客户端）。
 *  与下面的分页态都必须在 `watch(clientId, …, { immediate: true })` 之前声明 ——
 *  immediate 回调会在 setup 期就调 `load()` → `requestHistory()` 读到它们。 */
const HISTORY_PAGE_SIZE = 20
const historyLimit = ref(HISTORY_PAGE_SIZE)
/** 已取到末尾（客户端没有回传比请求更多的记录）—— 没有总数字段，只能这样判 */
const historyExhausted = ref(false)

const clientId = computed(() => state.selectedClientId)
const online = computed(() => state.clients.get(clientId.value)?.client.online ?? false)
const automations = computed(
  () => state.automationsByClient.get(clientId.value) ?? { user: [], builtin: [] },
)
const catalog = computed(
  () => state.automationCatalogByClient.get(clientId.value) ?? { conditions: [], actions: [] },
)

const agentDefs = computed(() => automations.value.user.filter((item) => item.mode === 'agent'))
const normalDefs = computed(() => automations.value.user.filter((item) => item.mode === 'normal'))

watch(
  clientId,
  () => {
    error.value = ''
    notice.value = ''
    historyFilter.value = ''
    if (clientId.value && online.value) void load()
  },
  { immediate: true },
)

/** 三路并发拉取（列表 / catalog / 历史），失败只报提示不互相阻塞 */
async function load(): Promise<void> {
  const id = clientId.value
  if (!id) return
  loading.value = true
  error.value = ''
  const [listResult, catalogResult, historyResult] = await Promise.allSettled([
    listAutomations(id),
    fetchAutomationCatalog(id),
    requestHistory(),
  ])
  loading.value = false
  if (clientId.value !== id) return // 期间已切走客户端
  const failure = [listResult, catalogResult, historyResult].find(
    (item): item is PromiseRejectedResult => item.status === 'rejected',
  )
  if (failure) {
    error.value = translateError(
      failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
    )
  }
}

function translateError(raw: string): string {
  if (raw.startsWith('E_REMOTE_DISABLED')) return '客户端已关闭远程控制许可'
  if (raw.startsWith('E_FORBIDDEN')) return '没有控制这台客户端的权限'
  if (raw === 'E_CLIENT_OFFLINE') return '客户端当前离线，命令未送达'
  return raw
}

// ───────────────────────── 触发描述与状态展示 ─────────────────────────

/** 星期展示名（索引即 weekday 数字，0 = 周日） */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

function numParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function weekdayPart(params: Record<string, unknown>): string {
  const value = params['weekdays']
  const days = Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : []
  if (days.length === 0 || days.length >= 7) return '每天'
  return `每周${days.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join('、')}`
}

/** 触发器的本地文案（docs/13 §10：与桌面端自动化页同一口径） */
function describeTrigger(def: AutomationDefinition): string {
  const params = def.trigger.params ?? {}
  switch (def.trigger.kind) {
    case 'daily': {
      const at = typeof params['at'] === 'string' ? params['at'] : ''
      return `${weekdayPart(params)} ${at}`.trim()
    }
    case 'interval': {
      const minutes = numParam(params, 'everyMinutes')
      if (minutes === null || minutes <= 0) return '固定间隔'
      return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`
    }
    case 'pre-class': {
      const lead = numParam(params, 'leadMinutes')
      return `距上课 ≤ ${lead ?? '?'} 分钟`
    }
    case 'class-start':
      return '上课时'
    case 'pre-end': {
      const lead = numParam(params, 'leadMinutes')
      return `距下课 ≤ ${lead ?? '?'} 分钟`
    }
    case 'class-end':
      return '下课时'
    case 'next-lesson':
      return `下节课是 ${typeof params['subject'] === 'string' ? params['subject'] : '?'}`
    default:
      return def.trigger.kind
  }
}

function conditionLabel(kind: AutomationTriggerKind): string {
  return catalog.value.conditions.find((item) => item.kind === kind)?.label ?? kind
}

function statusLabel(status: AutomationRunStatus): string {
  switch (status) {
    case 'running':
      return '进行中'
    case 'success':
      return '成功'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '已中断'
    default:
      return status
  }
}

function statusClass(status: AutomationRunStatus): string {
  switch (status) {
    case 'success':
      return 'ui-chip--ok'
    case 'failed':
      return 'ui-chip--danger'
    case 'running':
      return 'ui-chip--accent'
    default:
      return 'ui-chip--muted'
  }
}

// ───────────────────────── 调用次数（v0.2.8，docs/13 §3.1） ─────────────────────────

/** 是否设了调用次数上限（0 / 缺省 = 不限，此时不显示次数徽章） */
function hasRunLimit(def: AutomationDefinition): boolean {
  return (def.maxRuns ?? 0) > 0
}

/** 次数徽章文案（只在上限 > 0 时用） */
function runCountLabel(def: AutomationDefinition): string {
  return `已调用 ${def.runCount ?? 0}/${def.maxRuns ?? 0}`
}

/**
 * 次数是否已用尽（与主进程 `isRunsExhausted` 同口径：上限 > 0 且已调用 ≥ 上限）。
 * 用尽时引擎会自动停用，所以卡片上常与「已停用」徽章同时出现。
 */
function runsExhausted(def: AutomationDefinition): boolean {
  const maxRuns = def.maxRuns ?? 0
  return maxRuns > 0 && (def.runCount ?? 0) >= maxRuns
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${Math.round(seconds % 60)} 秒`
}

// ───────────────────────── 列表操作 ─────────────────────────

/** 单行操作统一入口：失败后重拉列表对齐真实状态 */
async function run(action: () => Promise<void>): Promise<void> {
  if (!clientId.value) return
  loading.value = true
  error.value = ''
  try {
    await action()
  } catch (err) {
    error.value = translateError(err instanceof Error ? err.message : String(err))
    listAutomations(clientId.value).catch(() => {})
  } finally {
    loading.value = false
  }
}

function onToggle(def: AutomationDefinition, event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked
  void run(async () => {
    await saveAutomation(clientId.value, { ...def, enabled })
    notice.value = ''
  })
}

function onRun(def: AutomationDefinition): void {
  void run(async () => {
    await runAutomation(clientId.value, def.id)
    notice.value = `已触发「${def.name}」`
    await requestHistory().catch(() => {})
  })
}

function onDelete(def: AutomationDefinition): void {
  if (!window.confirm(`删除自动化「${def.name}」？其运行历史会保留。`)) return
  void run(() => deleteAutomation(clientId.value, def.id))
}

// ───────────────────────── 新建 / 编辑（弹层表单） ─────────────────────────

interface EditorAction {
  kind: AutomationActionKind
  params: Record<string, unknown>
}

const editorOpen = ref(false)
const editorSaving = ref(false)
const editorError = ref('')
/** 正在编辑的原定义（新建为 null）；enabled / createdAt / updatedAt 从它继承 */
const editingOriginal = ref<AutomationDefinition | null>(null)
const editor = ref({
  id: '',
  name: '',
  mode: 'agent' as AutomationMode,
  triggerKind: 'daily' as AutomationTriggerKind,
  params: {} as Record<string, unknown>,
  prompt: '',
  actions: [] as EditorAction[],
  /** 调用次数上限输入（字符串态，空 = 0 = 不限；保存时经 normalizeMaxRuns 归一化为整数） */
  maxRuns: '',
  /** 已调用次数：表单不直接暴露编辑，只从原定义继承 / 由「重置计数」置 0 */
  runCount: 0,
})

const editingCondition = computed(() =>
  catalog.value.conditions.find((item) => item.kind === editor.value.triggerKind),
)
const availableActions = computed(() => catalog.value.actions.filter((item) => item.available))
const canSubmit = computed(() => clientId.value !== '' && online.value)

/** 按字段类型给一组初始值（time 取占位提示，number 取下限） */
function seedParams(fields: AutomationDescriptorField[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.type === 'number') params[field.key] = field.min ?? 0
    else if (field.type === 'time') params[field.key] = field.placeholder ?? '08:00'
    else if (field.type === 'weekdays') params[field.key] = []
    else if (field.type === 'select') params[field.key] = field.options?.[0]?.value ?? ''
    else params[field.key] = ''
  }
  return params
}

function openNew(): void {
  editingOriginal.value = null
  const condition = catalog.value.conditions[0]
  editor.value = {
    id: '',
    name: '',
    mode: 'agent',
    triggerKind: condition?.kind ?? 'daily',
    params: seedParams(condition?.fields ?? []),
    prompt: '',
    actions: [],
    maxRuns: '',
    runCount: 0,
  }
  editorError.value = ''
  editorOpen.value = true
}

function openEdit(def: AutomationDefinition): void {
  editingOriginal.value = def
  const condition = catalog.value.conditions.find((item) => item.kind === def.trigger.kind)
  editor.value = {
    id: def.id,
    name: def.name,
    mode: def.mode,
    triggerKind: def.trigger.kind,
    params: { ...seedParams(condition?.fields ?? []), ...def.trigger.params },
    prompt: def.prompt ?? '',
    actions: (def.actions ?? []).map((action) => {
      const descriptor = catalog.value.actions.find((item) => item.kind === action.kind)
      return {
        kind: action.kind,
        params: { ...seedParams(descriptor?.fields ?? []), ...action.params },
      }
    }),
    // 次数：上限空 = 不限；计数从原定义继承（改完回传时必须带上，否则会被清零）
    maxRuns: (def.maxRuns ?? 0) > 0 ? String(def.maxRuns) : '',
    runCount: def.runCount ?? 0,
  }
  editorError.value = ''
  editorOpen.value = true
}

/** 切换触发器类型：按新类型的字段重置参数（不跨类型保留旧值） */
function onTriggerKindChange(event: Event): void {
  const kind = (event.target as HTMLSelectElement).value as AutomationTriggerKind
  editor.value.triggerKind = kind
  editor.value.params = seedParams(
    catalog.value.conditions.find((item) => item.kind === kind)?.fields ?? [],
  )
}

function addAction(): void {
  const descriptor = availableActions.value[0]
  if (descriptor === undefined) return
  editor.value.actions.push({ kind: descriptor.kind, params: seedParams(descriptor.fields) })
}

function removeAction(index: number): void {
  editor.value.actions.splice(index, 1)
}

function onActionKindChange(index: number, event: Event): void {
  const kind = (event.target as HTMLSelectElement).value as AutomationActionKind
  const action = editor.value.actions[index]
  if (action === undefined) return
  action.kind = kind
  action.params = seedParams(catalog.value.actions.find((item) => item.kind === kind)?.fields ?? [])
}

function onActionParams(index: number, value: Record<string, unknown>): void {
  const action = editor.value.actions[index]
  if (action !== undefined) action.params = value
}

/**
 * 表单里的上限输入 → 整数（空 / 非数字 / 负数一律按 0 = 不限）。
 * 上限的合法区间（0–100000）由客户端校验层裁决，非法值在保存回执里给中文报错。
 */
function normalizeMaxRuns(raw: string): number {
  const value = Math.floor(Number(raw.trim()))
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 组装定义回传（enabled / createdAt / updatedAt 继承原定义；新建走默认值） */
function buildDefinition(): AutomationDefinition {
  const original = editingOriginal.value
  const mode = editor.value.mode
  return {
    id: editor.value.id,
    name: editor.value.name.trim(),
    enabled: original?.enabled ?? true,
    mode,
    trigger: { kind: editor.value.triggerKind, params: { ...editor.value.params } },
    ...(mode === 'agent'
      ? { prompt: editor.value.prompt }
      : {
          actions: editor.value.actions.map((action) => ({
            kind: action.kind,
            params: { ...action.params },
          })),
        }),
    // 调用次数（v0.2.8）：上限来自表单；runCount 由原定义继承（新建 = 0）——
    // 主进程 normalizeDefinition 对缺省值补 0，**漏带 runCount 会把已调用次数清零**。
    maxRuns: normalizeMaxRuns(editor.value.maxRuns),
    runCount: editor.value.runCount,
    createdAt: original?.createdAt ?? '',
    updatedAt: original?.updatedAt ?? '',
  }
}

async function submitEditor(): Promise<void> {
  if (editor.value.name.trim() === '') {
    editorError.value = '请填写名称'
    return
  }
  if (editor.value.mode === 'agent' && editor.value.prompt.trim() === '') {
    editorError.value = '请填写任务指令'
    return
  }
  if (editor.value.mode === 'normal' && editor.value.actions.length === 0) {
    editorError.value = '至少添加一个操作组件'
    return
  }
  editorSaving.value = true
  editorError.value = ''
  try {
    await saveAutomation(clientId.value, buildDefinition())
    editorOpen.value = false
    notice.value = '已保存'
  } catch (err) {
    editorError.value = translateError(err instanceof Error ? err.message : String(err))
  } finally {
    editorSaving.value = false
  }
}

// ───────────────────────── 运行历史 ─────────────────────────

const historyDetail = ref<AutomationRun | null>(null)
const historyDetailSession = ref<SessionState | null>(null)
const historyDetailLoading = ref(false)
const historyDetailError = ref('')

const historyRuns = computed<AutomationRun[]>(
  () => state.automationHistoryByClient.get(clientId.value) ?? [],
)
const historyDetailEntry = computed(() => state.clients.get(clientId.value) ?? null)

async function requestHistory(): Promise<void> {
  await fetchAutomationHistory(clientId.value, {
    ...(historyFilter.value === '' ? {} : { automationId: historyFilter.value }),
    limit: historyLimit.value,
  })
  const list = state.automationHistoryByClient.get(clientId.value) ?? []
  historyExhausted.value = list.length < historyLimit.value
}

async function refreshHistory(): Promise<void> {
  if (!clientId.value) return
  loading.value = true
  error.value = ''
  historyLimit.value = HISTORY_PAGE_SIZE
  try {
    await requestHistory()
  } catch (err) {
    error.value = translateError(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function loadMoreHistory(): Promise<void> {
  if (!clientId.value) return
  historyLimit.value += HISTORY_PAGE_SIZE
  try {
    await requestHistory()
  } catch (err) {
    historyLimit.value -= HISTORY_PAGE_SIZE
    error.value = translateError(err instanceof Error ? err.message : String(err))
  }
}

/** 明细行（略读层）：Agent 看结论摘要，Normal 看步数；失败时补一句失败原因。 */
function historyResultLine(record: AutomationRun): string {
  if (record.mode === 'agent') {
    const steps = record.toolCallCount === undefined ? '' : `${record.toolCallCount} 步`
    return [steps, record.summary ?? ''].filter((part) => part !== '').join(' · ')
  }
  const steps = record.steps ?? []
  const failed = steps.filter((step) => !step.ok).length
  if (steps.length === 0) return ''
  return failed === 0 ? `${steps.length} 步全部完成` : `${steps.length} 步 · ${failed} 步失败`
}

function canOpenRunDetail(record: AutomationRun): boolean {
  if (record.mode === 'agent') return record.sessionId !== undefined
  return (record.steps?.length ?? 0) > 0 || record.error !== undefined
}

async function openRunDetail(record: AutomationRun): Promise<void> {
  if (!canOpenRunDetail(record)) return
  historyDetail.value = record
  historyDetailSession.value = null
  historyDetailError.value = ''
  if (record.mode !== 'agent' || record.sessionId === undefined) return
  historyDetailLoading.value = true
  try {
    historyDetailSession.value = await loadRunTranscript(clientId.value, record.sessionId)
  } catch (err) {
    historyDetailError.value = translateError(err instanceof Error ? err.message : String(err))
  } finally {
    historyDetailLoading.value = false
  }
}

function closeRunDetail(): void {
  historyDetail.value = null
  historyDetailSession.value = null
  historyDetailError.value = ''
}

function filterHistory(automationId: string): void {
  historyFilter.value = historyFilter.value === automationId ? '' : automationId
  historyLimit.value = HISTORY_PAGE_SIZE
  if (clientId.value) void refreshHistory()
}
</script>

<template>
  <section class="page auto-page" data-panel="automations-page">
    <header class="auto-head">
      <div class="auto-head-text">
        <h1 class="page-title auto-title">
          <Workflow :size="18" :stroke-width="1.8" aria-hidden="true" />
          自动化
        </h1>
        <p class="page-sub">远程管理客户端的自动化任务：定时与课堂条件触发（docs/13）。</p>
      </div>
      <div class="auto-head-actions">
        <select
          class="ui-input auto-device"
          data-field="automations.client-select"
          :value="clientId"
          aria-label="选择客户端"
          @change="selectClient(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="entry in clientsSorted"
            :key="entry.client.clientId"
            :value="entry.client.clientId"
          >
            {{ entry.client.name }}{{ entry.client.online ? '' : '（离线）' }}
          </option>
        </select>
        <button
          class="ui-btn ui-btn--ghost"
          type="button"
          :disabled="loading || !online"
          @click="load"
        >
          刷新
        </button>
        <button class="ui-btn ui-btn--primary" type="button" :disabled="!online" @click="openNew">
          <Plus :size="14" :stroke-width="1.9" aria-hidden="true" />
          新建自动化
        </button>
      </div>
    </header>

    <p v-if="!clientId" class="ui-card auto-empty">暂无客户端——先在控制台添加设备。</p>
    <template v-else>
      <p v-if="error" class="ui-error">{{ error }}</p>
      <p v-else-if="notice" class="auto-notice">{{ notice }}</p>
      <p v-if="!online" class="auto-offline">客户端当前离线，无法读取或修改自动化。</p>

      <div v-if="loading" class="auto-loading" aria-busy="true">
        <span class="ui-spinner spin" aria-hidden="true"></span>
      </div>

      <template v-else>
        <div class="auto-groups" data-panel="automations-list">
          <!-- Agent Mode -->
          <section class="ui-card auto-group">
            <header class="auto-group-head">
              <span class="auto-group-title">Agent Mode</span>
              <span class="auto-group-sub">触发后跑一次完整 Agent 会话</span>
            </header>
            <p v-if="agentDefs.length === 0" class="auto-group-empty">暂无 Agent 模式自动化。</p>
            <ul v-else class="auto-list">
              <li
                v-for="def in agentDefs"
                :key="def.id"
                class="auto-card"
                data-field="automations.card"
              >
                <div class="auto-main">
                  <div class="auto-name-row">
                    <span class="auto-name">{{ def.name }}</span>
                    <span v-if="!def.enabled" class="ui-chip ui-chip--muted">已停用</span>
                    <span
                      v-if="hasRunLimit(def)"
                      class="ui-chip"
                      :class="runsExhausted(def) ? 'ui-chip--danger' : 'ui-chip--muted'"
                      title="调用次数上限（用满后引擎自动停用）"
                    >
                      {{ runCountLabel(def) }}
                    </span>
                    <span
                      v-if="runsExhausted(def)"
                      class="ui-chip ui-chip--danger"
                      title="调用次数已用尽，引擎已自动停用；提高上限或重置计数后可继续使用"
                    >
                      已用尽
                    </span>
                  </div>
                  <span class="auto-trigger">
                    {{ conditionLabel(def.trigger.kind) }} · {{ describeTrigger(def) }}
                  </span>
                </div>
                <div class="auto-actions">
                  <label class="auto-switch" title="启停该自动化">
                    <input
                      type="checkbox"
                      data-action="automations.toggle"
                      :checked="def.enabled"
                      :disabled="loading || !online"
                      @change="onToggle(def, $event)"
                    />
                    <span>启用</span>
                  </label>
                  <button
                    class="ui-btn ui-btn--ghost"
                    type="button"
                    data-action="automations.run"
                    :disabled="!online"
                    @click="onRun(def)"
                  >
                    <Play :size="13" :stroke-width="1.8" aria-hidden="true" />
                    立即运行
                  </button>
                  <button
                    class="ui-btn ui-btn--ghost"
                    type="button"
                    data-action="automations.edit"
                    :disabled="!online"
                    @click="openEdit(def)"
                  >
                    <Pencil :size="13" :stroke-width="1.8" aria-hidden="true" />
                    编辑
                  </button>
                  <button
                    class="ui-btn ui-btn--ghost auto-filter"
                    :class="{ 'auto-filter--active': historyFilter === def.id }"
                    type="button"
                    data-action="automations.history"
                    @click="filterHistory(def.id)"
                  >
                    <History :size="13" :stroke-width="1.8" aria-hidden="true" />
                    历史
                  </button>
                  <button
                    class="ui-btn ui-btn--danger"
                    type="button"
                    data-action="automations.delete"
                    :disabled="!online"
                    @click="onDelete(def)"
                  >
                    <Trash2 :size="13" :stroke-width="1.8" aria-hidden="true" />
                    删除
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <!-- Normal Mode -->
          <section class="ui-card auto-group">
            <header class="auto-group-head">
              <span class="auto-group-title">Normal Mode</span>
              <span class="auto-group-sub">触发后顺序执行预设操作组件</span>
            </header>
            <p v-if="normalDefs.length === 0" class="auto-group-empty">暂无普通模式自动化。</p>
            <ul v-else class="auto-list">
              <li
                v-for="def in normalDefs"
                :key="def.id"
                class="auto-card"
                data-field="automations.card"
              >
                <div class="auto-main">
                  <div class="auto-name-row">
                    <span class="auto-name">{{ def.name }}</span>
                    <span v-if="!def.enabled" class="ui-chip ui-chip--muted">已停用</span>
                    <span
                      v-if="hasRunLimit(def)"
                      class="ui-chip"
                      :class="runsExhausted(def) ? 'ui-chip--danger' : 'ui-chip--muted'"
                      title="调用次数上限（用满后引擎自动停用）"
                    >
                      {{ runCountLabel(def) }}
                    </span>
                    <span
                      v-if="runsExhausted(def)"
                      class="ui-chip ui-chip--danger"
                      title="调用次数已用尽，引擎已自动停用；提高上限或重置计数后可继续使用"
                    >
                      已用尽
                    </span>
                  </div>
                  <span class="auto-trigger">
                    {{ conditionLabel(def.trigger.kind) }} · {{ describeTrigger(def) }}
                  </span>
                </div>
                <div class="auto-actions">
                  <label class="auto-switch" title="启停该自动化">
                    <input
                      type="checkbox"
                      data-action="automations.toggle"
                      :checked="def.enabled"
                      :disabled="loading || !online"
                      @change="onToggle(def, $event)"
                    />
                    <span>启用</span>
                  </label>
                  <button
                    class="ui-btn ui-btn--ghost"
                    type="button"
                    data-action="automations.run"
                    :disabled="!online"
                    @click="onRun(def)"
                  >
                    <Play :size="13" :stroke-width="1.8" aria-hidden="true" />
                    立即运行
                  </button>
                  <button
                    class="ui-btn ui-btn--ghost"
                    type="button"
                    data-action="automations.edit"
                    :disabled="!online"
                    @click="openEdit(def)"
                  >
                    <Pencil :size="13" :stroke-width="1.8" aria-hidden="true" />
                    编辑
                  </button>
                  <button
                    class="ui-btn ui-btn--ghost auto-filter"
                    :class="{ 'auto-filter--active': historyFilter === def.id }"
                    type="button"
                    data-action="automations.history"
                    @click="filterHistory(def.id)"
                  >
                    <History :size="13" :stroke-width="1.8" aria-hidden="true" />
                    历史
                  </button>
                  <button
                    class="ui-btn ui-btn--danger"
                    type="button"
                    data-action="automations.delete"
                    :disabled="!online"
                    @click="onDelete(def)"
                  >
                    <Trash2 :size="13" :stroke-width="1.8" aria-hidden="true" />
                    删除
                  </button>
                </div>
              </li>
            </ul>

            <!-- 内置自动化：引擎承接的既有自动操作，不可增删 -->
            <template v-if="automations.builtin.length > 0">
              <header class="auto-group-head auto-builtin-head">
                <span class="auto-group-title">内置</span>
                <span class="auto-group-sub">启停请在客户端设置页操作</span>
              </header>
              <ul class="auto-list">
                <li
                  v-for="def in automations.builtin"
                  :key="def.id"
                  class="auto-card"
                  data-field="automations.builtin-card"
                >
                  <div class="auto-main">
                    <div class="auto-name-row">
                      <span class="auto-name">{{ def.name }}</span>
                      <span class="ui-chip ui-chip--accent">内置</span>
                      <span class="ui-chip" :class="def.enabled ? 'ui-chip--ok' : 'ui-chip--muted'">
                        {{ def.enabled ? '启用中' : '已停用' }}
                      </span>
                    </div>
                    <span class="auto-trigger">
                      {{ conditionLabel(def.trigger.kind) }} · {{ describeTrigger(def) }}
                    </span>
                  </div>
                  <div class="auto-actions">
                    <button
                      class="ui-btn ui-btn--ghost"
                      type="button"
                      data-action="automations.run"
                      :disabled="!online"
                      @click="onRun(def)"
                    >
                      <Play :size="13" :stroke-width="1.8" aria-hidden="true" />
                      立即运行
                    </button>
                    <button
                      class="ui-btn ui-btn--ghost auto-filter"
                      :class="{ 'auto-filter--active': historyFilter === def.id }"
                      type="button"
                      data-action="automations.history"
                      @click="filterHistory(def.id)"
                    >
                      <History :size="13" :stroke-width="1.8" aria-hidden="true" />
                      历史
                    </button>
                  </div>
                </li>
              </ul>
            </template>
          </section>
        </div>

        <!-- 运行历史 -->
        <section class="ui-card auto-group">
          <header class="auto-group-head">
            <span class="auto-group-title">运行历史</span>
            <span class="auto-group-sub">
              {{ historyFilter === '' ? `最近 ${historyRuns.length} 条` : '已按自动化筛选' }}
            </span>
            <button
              v-if="historyFilter !== ''"
              class="ui-btn ui-btn--ghost"
              type="button"
              @click="filterHistory(historyFilter)"
            >
              取消筛选
            </button>
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              :disabled="!online"
              @click="refreshHistory"
            >
              刷新
            </button>
          </header>

          <p v-if="loading" class="auto-group-empty">加载中…</p>
          <p v-else-if="historyRuns.length === 0" class="auto-group-empty">暂无运行记录。</p>
          <template v-else>
            <div class="auto-scroll">
              <table class="ui-table ui-table--cards" data-panel="automation-history">
                <thead>
                  <tr>
                    <th>触发时间</th>
                    <th>自动化</th>
                    <th>模式</th>
                    <th>状态</th>
                    <th>耗时</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="record in historyRuns" :key="record.id">
                    <td data-label="触发时间" class="auto-dim auto-num">
                      {{ formatTime(record.triggeredAt) }}
                    </td>
                    <td data-label="自动化">
                      <button
                        class="auto-link"
                        type="button"
                        @click="filterHistory(record.automationId)"
                      >
                        {{ record.automationName }}
                      </button>
                      <span v-if="record.triggerDetail" class="auto-dim auto-trigger">
                        {{ record.triggerDetail }}
                      </span>
                    </td>
                    <td data-label="模式">
                      <span
                        class="ui-chip"
                        :class="record.mode === 'agent' ? 'ui-chip--accent' : 'ui-chip--muted'"
                      >
                        {{ record.mode === 'agent' ? 'Agent' : 'Normal' }}
                      </span>
                    </td>
                    <td data-label="状态">
                      <span class="ui-chip" :class="statusClass(record.status)">
                        {{ statusLabel(record.status) }}
                      </span>
                    </td>
                    <td data-label="耗时" class="auto-dim auto-num">
                      {{ formatDuration(record.durationMs) }}
                    </td>
                    <td data-label="结果">
                      <p v-if="record.error" class="auto-error" :title="record.error">
                        {{ record.error }}
                      </p>
                      <p v-if="historyResultLine(record) !== ''" class="auto-dim auto-result">
                        {{ historyResultLine(record) }}
                      </p>
                      <button
                        v-if="canOpenRunDetail(record)"
                        class="ui-btn ui-btn--ghost auto-open-detail"
                        type="button"
                        data-action="automation.history-detail"
                        @click="openRunDetail(record)"
                      >
                        {{ record.mode === 'agent' ? '看对话' : '看明细' }}
                      </button>
                      <span v-else class="auto-dim auto-result">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button
              v-if="!historyExhausted"
              class="ui-btn ui-btn--ghost auto-more"
              type="button"
              data-action="automation.history-more"
              :disabled="!online"
              @click="loadMoreHistory"
            >
              加载更多
            </button>
          </template>
        </section>
      </template>
    </template>

    <!-- 新建 / 编辑弹层（遮罩淡入淡出，本轮：弹层是「挡住了别处」的强信号，硬切太跳） -->
    <Transition name="fade">
      <div v-if="editorOpen" class="auto-mask" @click.self="editorOpen = false">
        <div
          class="auto-editor glass-panel"
          role="dialog"
          aria-modal="true"
          aria-label="编辑自动化"
          data-panel="automation-editor"
        >
          <header class="auto-editor-head">
            <span class="auto-editor-title">{{
              editingOriginal ? '编辑自动化' : '新建自动化'
            }}</span>
            <button
              class="auto-icon-btn"
              type="button"
              aria-label="关闭"
              data-action="automation.close"
              @click="editorOpen = false"
            >
              <X :size="16" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </header>

          <div class="auto-editor-body">
            <label class="auto-field">
              <span class="auto-field-label">名称</span>
              <input v-model="editor.name" class="ui-input" type="text" placeholder="自动化名称" />
            </label>

            <div class="auto-field">
              <span class="auto-field-label">模式</span>
              <div class="auto-modes">
                <label class="auto-mode">
                  <input v-model="editor.mode" type="radio" value="agent" />
                  <span>Agent Mode（跑一次 Agent 会话）</span>
                </label>
                <label class="auto-mode">
                  <input v-model="editor.mode" type="radio" value="normal" />
                  <span>Normal Mode（执行操作组件）</span>
                </label>
              </div>
            </div>

            <div class="auto-field">
              <span class="auto-field-label">调用次数上限</span>
              <div class="auto-runs">
                <input
                  v-model="editor.maxRuns"
                  class="ui-input auto-runs-input"
                  type="number"
                  min="0"
                  step="1"
                  inputmode="numeric"
                  placeholder="0"
                  aria-label="调用次数上限"
                />
                <template v-if="editingOriginal">
                  <span class="auto-dim auto-runs-current"
                    >当前已调用 {{ editor.runCount }} 次</span
                  >
                  <button
                    class="ui-btn ui-btn--ghost"
                    type="button"
                    :disabled="editor.runCount === 0"
                    title="把已调用次数清零后随本次保存一起回传"
                    @click="editor.runCount = 0"
                  >
                    重置计数
                  </button>
                </template>
              </div>
              <p class="auto-field-hint">0 = 不限；用满后自动停用。</p>
              <p v-if="editingOriginal && runsExhausted(editingOriginal)" class="auto-field-hint">
                该自动化已用尽次数并被引擎自动停用：提高上限或重置计数后，还需重新启用。
              </p>
            </div>

            <div class="auto-field">
              <span class="auto-field-label">触发器</span>
              <select
                class="ui-input"
                :value="editor.triggerKind"
                @change="onTriggerKindChange($event)"
              >
                <option
                  v-for="condition in catalog.conditions"
                  :key="condition.kind"
                  :value="condition.kind"
                >
                  {{ condition.label }}{{ condition.requiresSchedule ? '（依赖课程表）' : '' }}
                </option>
              </select>
              <p v-if="editingCondition" class="auto-field-hint">
                {{ editingCondition.description }}
              </p>
              <AutomationFields
                :fields="editingCondition?.fields ?? []"
                :model-value="editor.params"
                @update:model-value="editor.params = $event"
              />
            </div>

            <label v-if="editor.mode === 'agent'" class="auto-field">
              <span class="auto-field-label">任务指令</span>
              <textarea
                v-model="editor.prompt"
                class="ui-input auto-prompt"
                rows="4"
                placeholder="触发后 Agent 要做什么"
              ></textarea>
            </label>

            <div v-else class="auto-field">
              <span class="auto-field-label">操作组件（顺序执行）</span>
              <div v-for="(action, index) in editor.actions" :key="index" class="auto-action-row">
                <select
                  class="ui-input"
                  :value="action.kind"
                  @change="onActionKindChange(index, $event)"
                >
                  <option
                    v-for="descriptor in catalog.actions"
                    :key="descriptor.kind"
                    :value="descriptor.kind"
                    :disabled="!descriptor.available"
                  >
                    {{ descriptor.label }}{{ descriptor.available ? '' : '（不可用）' }}
                  </option>
                </select>
                <AutomationFields
                  class="auto-action-fields"
                  :fields="catalog.actions.find((item) => item.kind === action.kind)?.fields ?? []"
                  :model-value="action.params"
                  @update:model-value="onActionParams(index, $event)"
                />
                <button class="ui-btn ui-btn--danger" type="button" @click="removeAction(index)">
                  移除
                </button>
              </div>
              <button
                class="ui-btn ui-btn--ghost auto-action-add"
                type="button"
                :disabled="availableActions.length === 0 || editor.actions.length >= 10"
                @click="addAction"
              >
                <Plus :size="13" :stroke-width="1.9" aria-hidden="true" />
                添加操作
              </button>
            </div>
          </div>

          <footer class="auto-editor-foot">
            <p v-if="editorError" class="ui-error auto-editor-error">{{ editorError }}</p>
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              data-action="automation.cancel"
              @click="editorOpen = false"
            >
              取消
            </button>
            <button
              class="ui-btn ui-btn--primary"
              type="button"
              data-action="automation.save"
              :disabled="!canSubmit || editorSaving"
              @click="submitEditor"
            >
              {{ editorSaving ? '保存中…' : '保存' }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>

    <!-- 运行明细弹层：Agent 复用会话消息流回放对话，Normal 列逐个操作组件的结果 -->
    <Transition name="fade">
      <div v-if="historyDetail !== null" class="auto-mask" @click.self="closeRunDetail">
        <div
          class="auto-editor auto-detail glass-panel"
          role="dialog"
          aria-modal="true"
          aria-label="运行明细"
          data-panel="automation-run-detail"
        >
          <header class="auto-editor-head">
            <span class="auto-editor-title">{{ historyDetail.automationName }}</span>
            <button
              class="auto-icon-btn"
              type="button"
              aria-label="关闭"
              data-action="automation.detail-close"
              @click="closeRunDetail"
            >
              <X :size="16" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </header>

          <div class="auto-editor-body">
            <p class="auto-detail-meta auto-dim">
              {{ formatTime(historyDetail.triggeredAt) }} ·
              {{ statusLabel(historyDetail.status) }}
              <template v-if="historyDetail.durationMs !== undefined">
                · {{ formatDuration(historyDetail.durationMs) }}</template
              >
              <template v-if="historyDetail.triggerDetail">
                · {{ historyDetail.triggerDetail }}</template
              >
            </p>
            <p v-if="historyDetail.error !== undefined" class="auto-error auto-detail-error">
              {{ historyDetail.error }}
            </p>

            <template v-if="historyDetail.mode === 'agent'">
              <p v-if="historyDetailLoading" class="auto-group-empty">加载对话…</p>
              <p v-else-if="historyDetailError !== ''" class="auto-error">
                {{ historyDetailError }}
              </p>
              <div
                v-else-if="historyDetailSession !== null && historyDetailEntry !== null"
                class="auto-transcript"
                data-field="automation.replay"
              >
                <MessageStream
                  :session="historyDetailSession"
                  :entry="historyDetailEntry"
                  :following="false"
                />
              </div>
              <p v-else class="auto-group-empty">这次运行没有可回放的对话（会话可能已删除）。</p>
            </template>

            <ol
              v-else-if="historyDetail.steps !== undefined && historyDetail.steps.length > 0"
              class="auto-steps"
            >
              <li v-for="(step, index) in historyDetail.steps" :key="index" class="auto-step">
                <span class="ui-chip" :class="step.ok ? 'ui-chip--ok' : 'ui-chip--danger'">
                  {{ step.ok ? '成功' : '失败' }}
                </span>
                <span class="auto-step-label">{{ index + 1 }}. {{ step.label }}</span>
                <span class="auto-dim auto-step-result">{{
                  step.summary ?? step.error ?? ''
                }}</span>
              </li>
            </ol>
            <p v-else class="auto-group-empty">这次运行没有记录到操作明细。</p>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
/* 外壳（App.vue 的 main.page）已提供页面留白时不再叠加一层内边距 */
.page .page {
  padding: 0;
}

/* ───────── 基础件（本页自持，样式单源在 @aurora/shared/browser/theme.css 的令牌） ───────── */

.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast),
    transform var(--dur-press) var(--ease-standard);
}

.ui-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.ui-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.ui-btn--primary {
  background: var(--aurora-blue);
  color: var(--on-accent);
}

.ui-btn--primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.ui-btn--ghost {
  border-color: var(--border-subtle);
}

.ui-btn--ghost:hover:not(:disabled) {
  background: var(--fill-2);
}

.ui-btn--danger {
  color: var(--text-secondary);
}

.ui-btn--danger:hover:not(:disabled) {
  background: var(--danger-fill);
  color: var(--danger-text);
}

.ui-input {
  width: 100%;
  height: var(--control-h-sm);
  min-width: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  outline: none;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.ui-input::placeholder {
  color: var(--text-muted);
}

.ui-input:focus {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

select.ui-input {
  cursor: pointer;
}

.ui-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: nowrap;
}

.ui-chip--ok {
  background: var(--ok-fill);
  color: var(--ok-text);
}

.ui-chip--danger {
  background: var(--danger-fill);
  color: var(--danger-text);
}

.ui-chip--accent {
  background: var(--fill-1);
  color: var(--accent-text);
}

.ui-chip--muted {
  color: var(--text-muted);
}

.ui-card {
  background: var(--glass-surface);
  border: 1px solid var(--glass-border-soft);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}

.ui-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-sm);
}

.ui-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--fill-3);
  border-top-color: var(--aurora-blue);
  border-radius: var(--radius-pill);
}

.ui-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.ui-table th {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-align: left;
  white-space: nowrap;
}

.ui-table td {
  padding: var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}

.ui-table tbody tr {
  transition: background var(--transition-fast);
}

.ui-table tbody tr:hover {
  background: var(--fill-2);
}

.ui-table tbody tr:last-child td {
  border-bottom: 0;
}

/* ───────── 本页布局（在基础件之后声明，便于就地覆盖宽度 / 高度等） ───────── */

.auto-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.auto-head-text {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.auto-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.auto-head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.auto-device {
  width: auto;
  min-width: 160px;
  max-width: 220px;
}

.auto-notice {
  margin: 0;
  color: var(--ok-text);
  font-size: var(--text-sm);
}

.auto-offline {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.auto-empty {
  margin: 0;
  padding: var(--space-7) var(--space-4);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  text-align: center;
}

.auto-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.auto-groups {
  display: grid;
  gap: var(--space-4);
}

.auto-group {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  align-content: start;
}

.auto-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.auto-group-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.auto-group-sub {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.auto-group-empty {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.auto-builtin-head {
  margin-top: var(--space-1);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.auto-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.auto-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.auto-card:hover {
  background: var(--fill-2);
}

.auto-main {
  display: grid;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}

.auto-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.auto-name {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.auto-trigger {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.auto-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* 启停开关：原生 checkbox 改外观，仍是可点 / 可键盘操作的同一个元素 */
.auto-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
}

.auto-switch input {
  appearance: none;
  flex: none;
  width: 34px;
  height: 20px;
  margin: 0;
  padding: 0;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.auto-switch input::after {
  content: '';
  display: block;
  width: 16px;
  height: 16px;
  margin: 2px;
  border-radius: var(--radius-pill);
  background: var(--text-secondary);
  transition:
    transform var(--transition-fast),
    background var(--transition-fast);
}

.auto-switch input:checked {
  background: var(--aurora-blue);
}

.auto-switch input:checked::after {
  background: var(--on-accent);
  transform: translateX(14px);
}

.auto-switch input:disabled {
  opacity: 0.4;
  cursor: default;
}

.auto-filter--active {
  background: var(--fill-3);
  color: var(--text-primary);
}

/* 运行历史 */
.auto-scroll {
  overflow-x: auto;
}

.auto-dim {
  color: var(--text-secondary);
}

.auto-num {
  font-variant-numeric: var(--num-tabular);
  white-space: nowrap;
}

.auto-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-text);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.auto-link:hover {
  text-decoration: underline;
}

.auto-error {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

/* 运行历史：触发上下文与结果摘要都是「略读层」的小字 */
.auto-trigger {
  display: block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

.auto-open-detail {
  margin-top: var(--space-1);
}

.auto-result {
  display: block;
  margin: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

.auto-detail {
  width: 720px;
  max-height: 86vh;
  overflow-y: auto;
}

.auto-detail-meta {
  margin: 0;
  font-size: var(--text-xs);
}

/* 弹层里的失败原因不参与表格单元格的单行截断 */
.auto-detail-error {
  display: block;
  max-width: none;
  white-space: normal;
}

.auto-transcript {
  min-height: 0;
  max-height: 56vh;
  overflow-y: auto;
  padding-right: var(--space-2);
}

/* 回放是只读的：没有「跟随最新」状态机，那枚胶囊点了也没东西可回 */
.auto-transcript :deep(.jump-latest) {
  display: none;
}

.auto-steps {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.auto-step {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.auto-step-label {
  flex: 0 0 auto;
}

.auto-step-result {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

.auto-more {
  margin-top: var(--space-3);
}

.auto-error {
  color: var(--danger-text);
}

/* 编辑弹层 */
.auto-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-6) var(--space-4);
  overflow-y: auto;
  background: var(--overlay-scrim);
}

.auto-editor {
  width: 560px;
  max-width: 100%;
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  background: var(--glass-panel);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  animation: aurora-pop-in var(--dur-base) var(--ease-spring) both;
}

.auto-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.auto-editor-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.auto-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.auto-icon-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.auto-editor-body {
  display: grid;
  gap: var(--space-4);
}

.auto-editor-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.auto-editor-error {
  flex: 1;
  min-width: 160px;
}

.auto-field {
  display: grid;
  gap: var(--space-2);
}

.auto-field-label {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.auto-field-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.auto-modes {
  display: grid;
  gap: var(--space-2);
}

.auto-mode {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
}

.auto-runs {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.auto-runs-input {
  width: 120px;
  flex: none;
}

.auto-runs-current {
  font-size: var(--text-xs);
}

.auto-prompt {
  height: auto;
  min-height: 96px;
  padding: var(--space-2) var(--space-3);
  line-height: var(--leading-normal);
  resize: vertical;
}

.auto-action-row {
  display: grid;
  grid-template-columns: minmax(140px, 180px) 1fr auto;
  gap: var(--space-2);
  align-items: start;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.auto-action-fields {
  grid-column: 2;
  min-width: 0;
}

.auto-action-add {
  justify-self: start;
}

@media (max-width: 720px) {
  .auto-head {
    align-items: stretch;
  }

  .auto-head-actions {
    align-items: stretch;
  }

  .auto-device {
    max-width: none;
    flex: 1 1 160px;
  }

  .auto-group {
    padding: var(--space-3);
  }

  .auto-card {
    flex-direction: column;
    align-items: stretch;
  }

  .auto-actions {
    justify-content: flex-start;
  }

  .auto-action-row {
    grid-template-columns: 1fr;
  }

  .auto-action-fields {
    grid-column: 1;
  }

  .ui-btn,
  .ui-input {
    min-height: var(--hit-target);
  }

  .auto-switch {
    min-height: var(--hit-target);
  }
}
</style>
