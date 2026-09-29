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
import AutomationFields from '../components/AutomationFields.vue'
import { formatTime } from '../format'
import {
  clientsSorted,
  deleteAutomation,
  fetchAutomationCatalog,
  fetchAutomationHistory,
  listAutomations,
  runAutomation,
  saveAutomation,
  selectClient,
  state,
} from '../store'

// ───────────────────────── 设备选择与加载 ─────────────────────────

const loading = ref(false)
const error = ref('')
const notice = ref('')
/** 历史筛选（'' = 全部；点行「历史」按钮切换）；watch 回调会重置它，须先声明 */
const historyFilter = ref('')

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
    fetchAutomationHistory(id),
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
      return 'chip-ok'
    case 'failed':
      return 'chip-failed'
    case 'running':
      return 'chip-accent'
    default:
      return 'chip-muted'
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
    await fetchAutomationHistory(clientId.value).catch(() => {})
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

const historyRuns = computed<AutomationRun[]>(() => {
  const list = state.automationHistoryByClient.get(clientId.value) ?? []
  const filtered =
    historyFilter.value === ''
      ? list
      : list.filter((item) => item.automationId === historyFilter.value)
  return filtered.slice(0, 50)
})

async function refreshHistory(): Promise<void> {
  if (!clientId.value) return
  loading.value = true
  error.value = ''
  try {
    await fetchAutomationHistory(clientId.value)
  } catch (err) {
    error.value = translateError(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

function filterHistory(automationId: string): void {
  historyFilter.value = historyFilter.value === automationId ? '' : automationId
}
</script>

<template>
  <div class="auto-view">
    <div class="auto-head">
      <div>
        <h2 class="auto-title">自动化</h2>
        <p class="text-2 auto-sub">远程管理客户端的自动化任务：定时与课堂条件触发（docs/13）。</p>
      </div>
      <div class="auto-head-actions">
        <select
          class="input device-select"
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
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="loading || !online"
          @click="load"
        >
          刷新
        </button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="!online" @click="openNew">
          新建自动化
        </button>
      </div>
    </div>

    <p v-if="!clientId" class="card empty-card text-2">暂无客户端——先在控制台添加设备。</p>
    <template v-else>
      <p v-if="error" class="form-error">{{ error }}</p>
      <p v-else-if="notice" class="auto-notice">{{ notice }}</p>
      <p v-if="!online" class="text-2 auto-offline">客户端当前离线，无法读取或修改自动化。</p>

      <div v-if="loading" class="boot-center auto-loading"><span class="spinner"></span></div>

      <template v-else>
        <!-- Agent Mode -->
        <section class="card auto-group">
          <header class="group-head">
            <span class="group-title">Agent Mode</span>
            <span class="text-2 group-sub">触发后跑一次完整 Agent 会话</span>
          </header>
          <p v-if="agentDefs.length === 0" class="text-2 group-empty">暂无 Agent 模式自动化。</p>
          <ul v-else class="auto-list">
            <li v-for="def in agentDefs" :key="def.id" class="auto-card">
              <div class="auto-main">
                <div class="auto-name-row">
                  <span class="auto-name">{{ def.name }}</span>
                  <span v-if="!def.enabled" class="chip chip-muted">已停用</span>
                  <span
                    v-if="hasRunLimit(def)"
                    class="chip"
                    :class="runsExhausted(def) ? 'chip-failed' : 'chip-muted'"
                    title="调用次数上限（用满后引擎自动停用）"
                  >
                    {{ runCountLabel(def) }}
                  </span>
                  <span
                    v-if="runsExhausted(def)"
                    class="chip chip-failed"
                    title="调用次数已用尽，引擎已自动停用；提高上限或重置计数后可继续使用"
                  >
                    已用尽
                  </span>
                </div>
                <span class="auto-trigger text-2">
                  {{ conditionLabel(def.trigger.kind) }} · {{ describeTrigger(def) }}
                </span>
              </div>
              <div class="auto-actions">
                <label class="row-switch" title="启停该自动化">
                  <input
                    type="checkbox"
                    :checked="def.enabled"
                    :disabled="loading || !online"
                    @change="onToggle(def, $event)"
                  />
                  <span>启用</span>
                </label>
                <button
                  class="btn btn-secondary btn-sm"
                  type="button"
                  :disabled="!online"
                  @click="onRun(def)"
                >
                  立即运行
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :class="{ active: historyFilter === def.id }"
                  @click="filterHistory(def.id)"
                >
                  历史
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="!online"
                  @click="openEdit(def)"
                >
                  编辑
                </button>
                <button
                  class="btn btn-danger-ghost btn-sm"
                  type="button"
                  :disabled="!online"
                  @click="onDelete(def)"
                >
                  删除
                </button>
              </div>
            </li>
          </ul>
        </section>

        <!-- Normal Mode -->
        <section class="card auto-group">
          <header class="group-head">
            <span class="group-title">Normal Mode</span>
            <span class="text-2 group-sub">触发后顺序执行预设操作组件</span>
          </header>
          <p v-if="normalDefs.length === 0" class="text-2 group-empty">暂无普通模式自动化。</p>
          <ul v-else class="auto-list">
            <li v-for="def in normalDefs" :key="def.id" class="auto-card">
              <div class="auto-main">
                <div class="auto-name-row">
                  <span class="auto-name">{{ def.name }}</span>
                  <span v-if="!def.enabled" class="chip chip-muted">已停用</span>
                  <span
                    v-if="hasRunLimit(def)"
                    class="chip"
                    :class="runsExhausted(def) ? 'chip-failed' : 'chip-muted'"
                    title="调用次数上限（用满后引擎自动停用）"
                  >
                    {{ runCountLabel(def) }}
                  </span>
                  <span
                    v-if="runsExhausted(def)"
                    class="chip chip-failed"
                    title="调用次数已用尽，引擎已自动停用；提高上限或重置计数后可继续使用"
                  >
                    已用尽
                  </span>
                </div>
                <span class="auto-trigger text-2">
                  {{ conditionLabel(def.trigger.kind) }} · {{ describeTrigger(def) }}
                </span>
              </div>
              <div class="auto-actions">
                <label class="row-switch" title="启停该自动化">
                  <input
                    type="checkbox"
                    :checked="def.enabled"
                    :disabled="loading || !online"
                    @change="onToggle(def, $event)"
                  />
                  <span>启用</span>
                </label>
                <button
                  class="btn btn-secondary btn-sm"
                  type="button"
                  :disabled="!online"
                  @click="onRun(def)"
                >
                  立即运行
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :class="{ active: historyFilter === def.id }"
                  @click="filterHistory(def.id)"
                >
                  历史
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="!online"
                  @click="openEdit(def)"
                >
                  编辑
                </button>
                <button
                  class="btn btn-danger-ghost btn-sm"
                  type="button"
                  :disabled="!online"
                  @click="onDelete(def)"
                >
                  删除
                </button>
              </div>
            </li>
          </ul>

          <!-- 内置自动化：引擎承接的既有自动操作，不可增删 -->
          <template v-if="automations.builtin.length > 0">
            <header class="group-head builtin-head">
              <span class="group-title">内置</span>
              <span class="text-2 group-sub">启停请在客户端设置页操作</span>
            </header>
            <ul class="auto-list">
              <li v-for="def in automations.builtin" :key="def.id" class="auto-card builtin">
                <div class="auto-main">
                  <div class="auto-name-row">
                    <span class="auto-name">{{ def.name }}</span>
                    <span class="chip chip-accent">内置</span>
                    <span class="chip" :class="def.enabled ? 'chip-ok' : 'chip-muted'">
                      {{ def.enabled ? '启用中' : '已停用' }}
                    </span>
                  </div>
                  <span class="auto-trigger text-2">
                    {{ conditionLabel(def.trigger.kind) }} · {{ describeTrigger(def) }}
                  </span>
                </div>
                <div class="auto-actions">
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    :disabled="!online"
                    @click="onRun(def)"
                  >
                    立即运行
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :class="{ active: historyFilter === def.id }"
                    @click="filterHistory(def.id)"
                  >
                    历史
                  </button>
                </div>
              </li>
            </ul>
          </template>
        </section>

        <!-- 运行历史 -->
        <section class="card auto-group">
          <header class="group-head">
            <span class="group-title">运行历史</span>
            <span class="text-2 group-sub">
              {{ historyFilter === '' ? '最近 50 条' : '已按自动化筛选' }}
            </span>
            <button
              v-if="historyFilter !== ''"
              class="btn btn-ghost btn-sm"
              type="button"
              @click="historyFilter = ''"
            >
              取消筛选
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="!online"
              @click="refreshHistory"
            >
              刷新
            </button>
          </header>
          <p v-if="historyRuns.length === 0" class="text-2 group-empty">暂无运行记录。</p>
          <ul v-else class="history-list">
            <li v-for="record in historyRuns" :key="record.id" class="history-row">
              <span class="history-time text-2">{{ formatTime(record.triggeredAt) }}</span>
              <button
                class="history-name"
                type="button"
                @click="filterHistory(record.automationId)"
              >
                {{ record.automationName }}
              </button>
              <span class="chip" :class="record.mode === 'agent' ? 'chip-accent' : 'chip-muted'">
                {{ record.mode === 'agent' ? 'Agent' : 'Normal' }}
              </span>
              <span class="chip" :class="statusClass(record.status)">
                {{ statusLabel(record.status) }}
              </span>
              <span class="text-2 history-duration">{{ formatDuration(record.durationMs) }}</span>
              <span v-if="record.sessionId" class="text-2 history-session" title="Agent 会话 id">
                会话 {{ record.sessionId }}
              </span>
              <span v-else-if="record.error" class="history-error" :title="record.error">
                {{ record.error }}
              </span>
            </li>
          </ul>
        </section>
      </template>
    </template>

    <!-- 新建 / 编辑弹层 -->
    <div v-if="editorOpen" class="editor-mask" @click.self="editorOpen = false">
      <div class="editor-card" role="dialog" aria-label="编辑自动化">
        <header class="editor-head">
          <span class="editor-title">{{ editingOriginal ? '编辑自动化' : '新建自动化' }}</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="editorOpen = false">
            关闭
          </button>
        </header>

        <div class="editor-body">
          <label class="editor-field">
            <span class="auto-field-label">名称</span>
            <input v-model="editor.name" class="input" type="text" placeholder="自动化名称" />
          </label>

          <div class="editor-field">
            <span class="auto-field-label">模式</span>
            <div class="mode-row">
              <label class="mode-item">
                <input v-model="editor.mode" type="radio" value="agent" />
                <span>Agent Mode（跑一次 Agent 会话）</span>
              </label>
              <label class="mode-item">
                <input v-model="editor.mode" type="radio" value="normal" />
                <span>Normal Mode（执行操作组件）</span>
              </label>
            </div>
          </div>

          <div class="editor-field">
            <span class="auto-field-label">调用次数上限</span>
            <div class="runs-row">
              <input
                v-model="editor.maxRuns"
                class="input runs-input"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                placeholder="0"
                aria-label="调用次数上限"
              />
              <template v-if="editingOriginal">
                <span class="text-2 runs-current">当前已调用 {{ editor.runCount }} 次</span>
                <button
                  class="btn btn-ghost btn-sm"
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

          <div class="editor-field">
            <span class="auto-field-label">触发器</span>
            <select class="input" :value="editor.triggerKind" @change="onTriggerKindChange($event)">
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

          <label v-if="editor.mode === 'agent'" class="editor-field">
            <span class="auto-field-label">任务指令</span>
            <textarea
              v-model="editor.prompt"
              class="input prompt-input"
              rows="4"
              placeholder="触发后 Agent 要做什么"
            ></textarea>
          </label>

          <div v-else class="editor-field">
            <span class="auto-field-label">操作组件（顺序执行）</span>
            <div v-for="(action, index) in editor.actions" :key="index" class="action-row">
              <select
                class="input action-kind"
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
                class="action-fields"
                :fields="catalog.actions.find((item) => item.kind === action.kind)?.fields ?? []"
                :model-value="action.params"
                @update:model-value="onActionParams(index, $event)"
              />
              <button
                class="btn btn-danger-ghost btn-sm"
                type="button"
                @click="removeAction(index)"
              >
                移除
              </button>
            </div>
            <button
              class="btn btn-secondary btn-sm"
              type="button"
              :disabled="availableActions.length === 0 || editor.actions.length >= 10"
              @click="addAction"
            >
              添加操作
            </button>
          </div>
        </div>

        <footer class="editor-foot">
          <p v-if="editorError" class="form-error editor-error">{{ editorError }}</p>
          <button class="btn btn-ghost btn-sm" type="button" @click="editorOpen = false">
            取消
          </button>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="!canSubmit || editorSaving"
            @click="submitEditor"
          >
            {{ editorSaving ? '保存中…' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auto-view {
  display: grid;
  gap: 14px;
}

.auto-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.auto-title {
  margin: 0 0 2px;
  font-size: 18px;
}

.auto-sub {
  margin: 0;
  font-size: 13px;
}

.auto-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.device-select {
  width: auto;
  max-width: 220px;
  min-width: 160px;
}

.auto-notice {
  margin: 0;
  font-size: 13px;
  color: var(--ok);
}

.auto-offline {
  margin: 0;
  font-size: 13px;
}

.auto-loading {
  min-height: 160px;
}

.auto-group {
  padding: 12px 16px;
  display: grid;
  gap: 10px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.group-title {
  font-size: 15px;
  font-weight: 600;
}

.group-sub {
  flex: 1;
  font-size: 12.5px;
  min-width: 0;
}

.group-empty {
  margin: 0;
  font-size: 13px;
}

.builtin-head {
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.auto-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.auto-card {
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.auto-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.auto-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.auto-name {
  font-size: 13.5px;
  font-weight: 500;
}

.auto-trigger {
  font-size: 12.5px;
}

.auto-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.row-switch {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  cursor: pointer;
}

.chip-failed {
  background: var(--danger-soft);
  color: var(--danger);
}

/* 历史列表 */
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
}

.history-row:nth-child(odd) {
  background: var(--bg);
}

.history-time {
  flex: none;
  min-width: 140px;
}

.history-name {
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
}

.history-duration {
  flex: none;
}

.history-session {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.history-error {
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

/* 编辑弹层 */
.editor-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 50;
}

.editor-card {
  background: var(--card);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 560px;
  max-width: 100%;
  display: grid;
  gap: 12px;
  padding: 16px 20px;
}

.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.editor-title {
  font-size: 15px;
  font-weight: 600;
}

.editor-body {
  display: grid;
  gap: 14px;
}

.editor-field {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

.mode-row {
  display: grid;
  gap: 6px;
}

/* 字段小字说明（与 AutomationFields.vue 同款；本文件里触发器提示也用它） */
.auto-field-hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

/* 调用次数上限：数字输入 + 当前计数 + 重置按钮 */
.runs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.runs-input {
  width: 120px;
  flex: none;
}

.runs-current {
  font-size: 12.5px;
}

.mode-item {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.prompt-input {
  resize: vertical;
}

.action-row {
  display: grid;
  grid-template-columns: minmax(140px, 180px) 1fr auto;
  gap: 8px;
  align-items: start;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

.action-fields {
  grid-column: 2;
}

.editor-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.editor-error {
  margin: 0;
  flex: 1;
}

@media (max-width: 720px) {
  .auto-card {
    flex-direction: column;
    align-items: stretch;
  }

  .action-row {
    grid-template-columns: 1fr;
  }

  .action-fields {
    grid-column: 1;
  }

  .history-time {
    min-width: 0;
  }

  .auto-group {
    padding: 10px 12px;
  }
}
</style>
