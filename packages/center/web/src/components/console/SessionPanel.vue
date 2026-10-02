<script setup lang="ts">
/**
 * 控制台右栏：选中设备的会话管理 / 模型 / 远程配置（docs/12 §6.2 / §6.3 / §10）。
 *
 * 三段用页签切换，三段主体都留在 DOM 里（`v-show`）—— 视觉验收的锚点
 * `data-panel="panel.sessions | panel.llm | panel.config"` 不随切换消失。
 * 首次拿到设备就拉会话列表与项目选项；模型段的配置切片（`config.get` 脱敏回执）
 * 在 `remoteLlm` 为空时补拉一次，其它两条命令互不阻塞，失败只落到面板内的
 * `panel.error` 行（不弹窗、不打断对话）。
 *
 * 「跟随全局」边界：客户端没有「清除会话级权限覆盖」的命令
 * （`session.setPermission` 的 permissionMode 必填），选它只提示回客户端操作。
 */
import { computed, ref, watch } from 'vue'
import type { CenterProjectOption, ModeId, PermissionMode, ReasoningEffort } from '@aurora/shared'
import type { Ref } from 'vue'
import type { ClientEntry, SessionState } from '../../state'
import {
  activateSession,
  fetchRemoteConfig,
  listProjects,
  listSessions,
  openRemoteSession,
  setSessionPermission,
  setSessionProject,
  setSessionVisibility,
  switchLlm,
  switchMode,
  updateConfig,
} from '../../state'
import { formatTime, modeLabel } from '../../lib/format'

const props = defineProps<{ entry: ClientEntry | null; session: SessionState | null }>()

type PanelTab = 'sessions' | 'llm' | 'config'

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'sessions', label: '会话管理' },
  { id: 'llm', label: '模型' },
  { id: 'config', label: '远程配置' },
]

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'readonly', label: '只读（readonly）' },
  { value: 'confirm', label: '逐次确认（confirm）' },
  { value: 'auto', label: '自动（auto，根内免确认）' },
]

const REASONING_LEVELS: ReasoningEffort[] = ['auto', 'low', 'medium', 'high']

const MODES: Array<{ id: ModeId; label: string }> = [
  { id: 'classroom', label: '课堂' },
  { id: 'work', label: '工作' },
  { id: 'code', label: '代码' },
]

/** 远程白名单内的路径（与客户端 `CENTER_REMOTE_CONFIG_PREFIXES` 对齐） */
const TOOL_SWITCHES = [
  { path: 'agent.tools.enabled', label: '电脑操控工具（总开关）' },
  { path: 'agent.tools.files.enabled', label: '文件读写' },
  { path: 'agent.tools.search.enabled', label: '文件检索' },
  { path: 'agent.tools.open.enabled', label: '打开路径' },
  { path: 'agent.tools.terminal.enabled', label: '终端命令' },
] as const

const tab = ref<PanelTab>('sessions')
/**
 * 在途标志**按组分开**（会话列表 / 模型 / 远程配置）。
 *
 * 一个面板一个 `busy` 曾经把三组操作绑在一起：面板挂载时会自动拉一次会话列表，
 * 那一两百毫秒里配置开关点下去会被 `if (busy.value) return` 静默吞掉（用户视角是
 * "点了没反应"，harness 的 panel-config 场景实测如此）。分组之后只有**同一组**的
 * 重复点击才被忽略，跨组互不阻塞。
 */
const sessionBusy = ref(false)
const llmBusy = ref(false)
const configBusy = ref(false)
const error = ref('')
const projects = ref<CenterProjectOption[]>([])
/** 行内提示（如「跟随全局需在客户端操作」），键 = sessionId */
const rowHints = ref(new Map<string, string>())

const clientId = computed(() => props.entry?.client.clientId ?? '')
const online = computed(() => props.entry?.client.online ?? false)
const status = computed(() => props.entry?.status ?? null)
const sessions = computed(() => props.entry?.remoteSessions ?? [])
const currentMode = computed(() => status.value?.mode ?? props.entry?.client.mode ?? '')

const llm = computed(() => props.entry?.status?.llm ?? null)
const remoteLlm = computed(() => props.entry?.remoteLlm ?? null)
const providerIds = computed(() => Object.keys(remoteLlm.value?.providers ?? {}))
const activeProvider = computed(() =>
  llm.value ? (remoteLlm.value?.providers[llm.value.activeProviderId] ?? null) : null,
)
/** 模型选项：provider 的候选列表 ∪ 当前生效值（列表里没有时也要显示） */
const modelOptions = computed<string[]>(() => {
  const list = activeProvider.value?.modelList ?? []
  const current = llm.value?.model
  return current && !list.includes(current) ? [current, ...list] : list
})

function translateError(raw: string): string {
  if (raw.startsWith('E_REMOTE_DISABLED')) return '该设备未允许远程会话/远程配置'
  if (raw.startsWith('E_FORBIDDEN_PATH')) return '该配置项不在远程白名单内'
  if (raw === 'E_CLIENT_OFFLINE') return '设备已离线'
  return raw
}

function failureText(reason: unknown): string {
  return translateError(reason instanceof Error ? reason.message : String(reason))
}

/** 会话列表 + 项目选项（切换设备 / 设备上线 / 手动刷新共用） */
async function refresh(): Promise<void> {
  const id = clientId.value
  if (id === '' || !online.value) return
  sessionBusy.value = true
  error.value = ''
  const [sessionsResult, projectsResult] = await Promise.allSettled([
    listSessions(id),
    listProjects(id),
  ])
  sessionBusy.value = false
  if (clientId.value !== id) return // 期间已切走设备
  const failure = [sessionsResult, projectsResult].find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failure) error.value = failureText(failure.reason)
  if (projectsResult.status === 'fulfilled') projects.value = projectsResult.value
}

/** 操作统一入口：失败后重拉列表，把本地视图对齐回客户端的真实状态 */
async function run(flag: Ref<boolean>, action: () => Promise<void>): Promise<void> {
  if (flag.value) return
  flag.value = true
  error.value = ''
  try {
    await action()
  } catch (err) {
    error.value = failureText(err)
    if (clientId.value !== '') void listSessions(clientId.value).catch(() => {})
  } finally {
    flag.value = false
  }
}

watch(
  () => clientId.value,
  (id) => {
    error.value = ''
    projects.value = []
    rowHints.value = new Map()
    tab.value = 'sessions'
    if (id !== '') void refresh()
  },
  { immediate: true },
)

// 设备上线后补一次（离线时列表拉不回来，命令会直接拒绝）
watch(online, (isOnline) => {
  if (isOnline) void refresh()
})

// 配置切片只在缺失时补拉一次；拉回后 remoteLlm 变化会再次进入本 watcher 并立即返回
watch(
  [clientId, online, remoteLlm],
  ([id, isOnline, config]) => {
    if (id === '' || !isOnline || config !== null) return
    void fetchRemoteConfig(id).catch((err: unknown) => {
      error.value = failureText(err)
    })
  },
  { immediate: true },
)

function rowHint(sessionId: string): string {
  return rowHints.value.get(sessionId) ?? ''
}

function setRowHint(sessionId: string, hint: string): void {
  const next = new Map(rowHints.value)
  if (hint === '') next.delete(sessionId)
  else next.set(sessionId, hint)
  rowHints.value = next
}

/** 点行主体：切换网页端当前查看的会话（历史会话先建空壳再拉历史） */
function viewSession(sessionId: string): void {
  if (clientId.value === '') return
  openRemoteSession(clientId.value, sessionId)
}

function onActivate(sessionId: string): void {
  const id = clientId.value
  if (id === '') return
  void run(sessionBusy, () => activateSession(id, sessionId))
}

function onVisibility(sessionId: string, event: Event): void {
  const id = clientId.value
  if (id === '') return
  const visible = (event.target as HTMLInputElement).checked
  void run(sessionBusy, () => setSessionVisibility(id, sessionId, visible))
}

function onPermission(sessionId: string, event: Event): void {
  const id = clientId.value
  if (id === '') return
  const value = (event.target as HTMLSelectElement).value as PermissionMode | ''
  if (value === '') {
    setRowHint(sessionId, '如需恢复跟随全局请在客户端操作')
    return
  }
  setRowHint(sessionId, '')
  void run(sessionBusy, () => setSessionPermission(id, sessionId, value))
}

function onProject(sessionId: string, event: Event): void {
  const id = clientId.value
  if (id === '') return
  const projectId = (event.target as HTMLSelectElement).value
  void run(sessionBusy, () => setSessionProject(id, sessionId, projectId))
}

function onProvider(event: Event): void {
  const id = clientId.value
  if (id === '') return
  const providerId = (event.target as HTMLSelectElement).value
  if (providerId === '' || providerId === llm.value?.activeProviderId) return
  void run(llmBusy, () => switchLlm(id, { providerId }))
}

function onModel(event: Event): void {
  const id = clientId.value
  if (id === '') return
  const model = (event.target as HTMLSelectElement).value
  if (model === '' || model === llm.value?.model) return
  void run(llmBusy, () => switchLlm(id, { model }))
}

function onEffort(event: Event): void {
  const id = clientId.value
  if (id === '') return
  const reasoningEffort = (event.target as HTMLSelectElement).value as ReasoningEffort
  if (reasoningEffort === llm.value?.reasoningEffort) return
  void run(llmBusy, () => switchLlm(id, { reasoningEffort }))
}

function onMode(mode: ModeId): void {
  const id = clientId.value
  if (id === '' || mode === currentMode.value) return
  void run(configBusy, () => switchMode(id, mode))
}

function onToggle(path: string, event: Event): void {
  const id = clientId.value
  if (id === '') return
  const checked = (event.target as HTMLInputElement).checked
  void run(configBusy, () => updateConfig(id, { [path]: checked }))
}

/** 开关的当前值来自 `client.status.agent.tools`（路径与白名单一一对应） */
function toolValue(path: string): boolean | undefined {
  const agent = status.value?.agent
  if (!agent) return undefined
  if (path === 'agent.tools.enabled') return agent.tools.enabled
  if (path === 'agent.tools.files.enabled') return agent.tools.files
  if (path === 'agent.tools.search.enabled') return agent.tools.search
  if (path === 'agent.tools.open.enabled') return agent.tools.open
  if (path === 'agent.tools.terminal.enabled') return agent.tools.terminal
  return undefined
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <span class="panel-title">{{ entry ? entry.client.name : '会话与配置' }}</span>
      <span v-if="entry" class="panel-sub">
        {{ modeLabel(currentMode) }} · {{ online ? '在线' : '离线' }}
      </span>
      <button
        v-if="entry && tab === 'sessions'"
        type="button"
        class="ghost"
        data-action="panel.refresh"
        :disabled="sessionBusy || !online"
        @click="refresh"
      >
        {{ sessionBusy ? '同步中…' : '刷新' }}
      </button>
    </header>

    <div class="tabs" role="tablist">
      <button
        v-for="item in TABS"
        :key="item.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ open: tab === item.id }"
        :aria-selected="tab === item.id"
        :data-action="`panel.tab-${item.id}`"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </div>

    <p v-if="error !== ''" class="panel-error" data-field="panel.error">{{ error }}</p>

    <!-- 会话管理：客户端 center- 会话列表 + 单行操作 -->
    <div v-show="tab === 'sessions'" class="panel-body" data-panel="panel.sessions">
      <p v-if="!entry" class="note">先选择一个设备。</p>
      <template v-else>
        <p v-if="!online" class="note">设备离线，无法读取远程会话。</p>
        <ul v-if="sessions.length > 0" class="rows">
          <li
            v-for="item in sessions"
            :key="item.sessionId"
            class="row"
            :class="{ active: item.sessionId === session?.sessionId }"
            data-field="panel.session-row"
          >
            <button
              type="button"
              class="row-main"
              data-action="panel.view"
              @click="viewSession(item.sessionId)"
            >
              <span class="row-name">{{ item.title || item.sessionId }}</span>
              <span class="row-meta">
                {{ item.sessionId }} · {{ formatTime(item.updatedAt) }}
              </span>
            </button>
            <div class="row-controls">
              <button
                type="button"
                class="mini"
                data-action="panel.activate"
                :disabled="sessionBusy || !online"
                title="让客户端主界面切到该会话"
                @click="onActivate(item.sessionId)"
              >
                在客户端打开
              </button>
              <label class="switch" title="客户端左栏可见性">
                <input
                  type="checkbox"
                  data-action="panel.visibility"
                  :checked="item.centerVisible !== false"
                  :disabled="sessionBusy || !online"
                  @change="onVisibility(item.sessionId, $event)"
                />
                <span>可见</span>
              </label>
              <select
                class="select"
                data-field="panel.permission"
                :value="item.permissionMode ?? ''"
                :disabled="sessionBusy || !online"
                title="会话级权限档（选「跟随全局」不发起命令）"
                @change="onPermission(item.sessionId, $event)"
              >
                <option value="">跟随全局</option>
                <option
                  v-for="option in PERMISSION_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <select
                class="select"
                data-field="panel.project"
                :value="item.projectId ?? ''"
                :disabled="sessionBusy || !online"
                title="会话绑定的项目"
                @change="onProject(item.sessionId, $event)"
              >
                <option value="">不绑定项目</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">
                  {{ project.name }}
                </option>
              </select>
            </div>
            <p v-if="rowHint(item.sessionId) !== ''" class="row-hint">
              {{ rowHint(item.sessionId) }}
            </p>
          </li>
        </ul>
        <p v-else-if="!sessionBusy" class="note">
          暂无远程会话——新建会话或发一条消息后会出现在这里。
        </p>
      </template>
    </div>

    <!-- 模型：当前值来自 client.status.llm，选项来自 config.get（脱敏） -->
    <div v-show="tab === 'llm'" class="panel-body" data-panel="panel.llm">
      <p v-if="!entry" class="note">先选择一个设备。</p>
      <template v-else>
        <p v-if="remoteLlm === null" class="note">拉取配置中…</p>
        <div class="llm-row">
          <label class="field">
            <span class="field-label">模型</span>
            <select
              class="select"
              data-field="panel.provider"
              :value="llm?.activeProviderId ?? ''"
              :disabled="llmBusy || providerIds.length === 0"
              @change="onProvider"
            >
              <option v-if="providerIds.length === 0" value="">未读取到模型配置</option>
              <option v-for="id in providerIds" :key="id" :value="id">{{ id }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">对话模型</span>
            <select
              class="select"
              data-field="panel.model"
              :value="llm?.model ?? ''"
              :disabled="llmBusy || modelOptions.length === 0"
              @change="onModel"
            >
              <option v-if="modelOptions.length === 0" value="">—</option>
              <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">思考等级</span>
            <select
              class="select"
              data-field="panel.effort"
              :value="llm?.reasoningEffort ?? 'auto'"
              :disabled="llmBusy || !llm"
              @change="onEffort"
            >
              <option v-for="level in REASONING_LEVELS" :key="level" :value="level">
                {{ level }}
              </option>
            </select>
          </label>
        </div>
      </template>
    </div>

    <!-- 远程配置：模式切换 + agent.tools 白名单开关（客户端侧最终裁决） -->
    <div v-show="tab === 'config'" class="panel-body" data-panel="panel.config">
      <p v-if="!entry" class="note">先选择一个设备。</p>
      <p v-else-if="!online" class="note">设备离线，命令需等其上线后重新发送。</p>
      <p v-else-if="!status" class="note">尚未收到设备状态（可能是旧版本），无法远程配置。</p>
      <template v-else>
        <div class="block">
          <span class="block-label">模式</span>
          <div class="mode-row">
            <button
              v-for="mode in MODES"
              :key="mode.id"
              type="button"
              class="mode-btn"
              :class="{ on: currentMode === mode.id }"
              :disabled="configBusy || currentMode === mode.id"
              :data-action="`panel.mode-${mode.id}`"
              @click="onMode(mode.id)"
            >
              {{ mode.label }}
            </button>
          </div>
        </div>
        <div class="block">
          <span class="block-label">Agent 工具开关</span>
          <label v-for="item in TOOL_SWITCHES" :key="item.path" class="switch">
            <input
              type="checkbox"
              :checked="toolValue(item.path)"
              :disabled="configBusy"
              :data-switch="item.path"
              @change="onToggle(item.path, $event)"
            />
            <span>{{ item.label }}</span>
          </label>
          <p class="note">只允许白名单内的开关（客户端侧强制）</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  min-height: 0;
}

.panel-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  padding: 0 var(--space-2);
}

.panel-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}

.panel-sub {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.ghost {
  flex: 0 0 auto;
  margin-left: auto;
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition: background-color var(--transition-fast);
}

.ghost:hover {
  background: var(--fill-2);
}

.ghost:disabled {
  color: var(--text-muted);
  cursor: default;
}

.tabs {
  display: flex;
  gap: var(--space-1);
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
}

.tab {
  flex: 1;
  min-height: var(--control-h-xs);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.tab:hover {
  background: var(--fill-2);
}

.tab.open {
  background: var(--fill-3);
  color: var(--text-primary);
  font-weight: var(--weight-medium);
}

.panel-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-xs);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.note {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--text-muted);
}

/* 会话行 */
.rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.row.active {
  border-color: color-mix(in srgb, var(--aurora-blue) 40%, transparent);
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 32px;
  text-align: left;
  color: var(--text-primary);
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.row-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}

.row-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.row-hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.mini {
  min-height: var(--hit-target);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  transition: background-color var(--transition-fast);
}

.mini:hover {
  background: var(--fill-2);
}

.mini:disabled {
  color: var(--text-muted);
  cursor: default;
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--hit-target);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
}

.switch input {
  accent-color: var(--aurora-blue);
  width: 16px;
  height: 16px;
}

.switch:has(input:disabled) {
  color: var(--text-muted);
  cursor: default;
}

.select {
  min-height: var(--control-h-sm);
  max-width: 200px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  background: var(--fill-1);
  color: var(--text-primary);
  font-size: var(--text-xs);
}

.select option {
  background: var(--bg-raised);
  color: var(--text-primary);
}

/* 模型行 */
.llm-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.field-label {
  flex: 0 0 auto;
  width: 64px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.field .select {
  flex: 1;
  min-width: 0;
  max-width: none;
}

/* 远程配置 */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.block-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.mode-btn {
  min-height: var(--hit-target);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.mode-btn:hover {
  background: var(--fill-2);
}

.mode-btn.on {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  border-color: transparent;
}

.mode-btn:disabled {
  cursor: default;
}

/* 窄屏：三段主体与控件保持单列可点，选择器占满整行 */
@media (max-width: 720px) {
  .panel {
    flex: 0 0 auto;
  }

  .select {
    max-width: none;
    flex: 1 1 140px;
  }

  .field-label {
    width: 56px;
  }
}
</style>
