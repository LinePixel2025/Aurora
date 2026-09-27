<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CenterProjectOption, PermissionMode, ReasoningEffort } from '@aurora/shared'
import type { ClientEntry } from '../store'
import {
  activateSession,
  fetchRemoteConfig,
  listProjects,
  listSessions,
  openRemoteSession,
  setSessionPermission,
  setSessionProject,
  setSessionVisibility,
  state,
  switchLlm,
} from '../store'
import { formatTime } from '../format'

/**
 * 会话管理面板（docs/12 §6.3 / §10）：客户端的 center- 会话列表 +
 * 模型 / 思考等级切换。会话项支持：切换查看（网页本地）、「在客户端打开」、
 * 可见性开关、会话级权限档、绑定项目。
 *
 * 「跟随全局」边界：客户端暂无「清除会话级权限覆盖」的命令（协议里
 * `session.setPermission` 的 permissionMode 必填），因此选「跟随全局」不发起
 * 命令，仅提示到客户端里操作。
 */
const props = defineProps<{ entry: ClientEntry | null }>()

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'readonly', label: '只读（readonly）' },
  { value: 'confirm', label: '逐次确认（confirm）' },
  { value: 'auto', label: '自动（auto，根内免确认）' },
]

const REASONING_LEVELS: ReasoningEffort[] = ['auto', 'low', 'medium', 'high']

const expanded = ref(false)
const loading = ref(false)
const error = ref('')
const projects = ref<CenterProjectOption[]>([])
/** 行内提示（如「跟随全局需在客户端操作」），键 = sessionId */
const rowHints = ref(new Map<string, string>())

const clientId = computed(() => props.entry?.client.clientId ?? '')
const online = computed(() => props.entry?.client.online ?? false)
const sessions = computed(() => props.entry?.remoteSessions ?? [])
const activeKey = computed(() => state.activeSessionKey)

const llm = computed(() => props.entry?.status?.llm ?? null)
const remoteLlm = computed(() => props.entry?.remoteLlm)
const providerIds = computed(() => Object.keys(remoteLlm.value?.providers ?? {}))
const activeProvider = computed(() =>
  llm.value ? (remoteLlm.value?.providers[llm.value.activeProviderId] ?? null) : null,
)
/** 模型选项：provider 的候选列表 ∪ 当前生效值（列表里没有时也要能显示） */
const modelOptions = computed<string[]>(() => {
  const list = activeProvider.value?.modelList ?? []
  const current = llm.value?.model
  return current && !list.includes(current) ? [current, ...list] : list
})

watch(
  () => props.entry?.client.clientId,
  () => {
    error.value = ''
    projects.value = []
    rowHints.value = new Map()
    expanded.value = false
  },
)

/** 展开 / 手动刷新：拉会话列表、项目选项与 LLM 配置（三项互不阻塞，失败只报提示） */
async function refresh(): Promise<void> {
  const id = clientId.value
  if (!id || !online.value) return
  loading.value = true
  error.value = ''
  const [sessionsResult, projectsResult, configResult] = await Promise.allSettled([
    listSessions(id),
    listProjects(id),
    fetchRemoteConfig(id),
  ])
  loading.value = false
  if (clientId.value !== id) return // 期间已切走客户端
  const failure = [sessionsResult, projectsResult, configResult].find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )
  if (failure) {
    const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
    error.value = translateError(reason)
  }
  if (projectsResult.status === 'fulfilled') projects.value = projectsResult.value
}

function toggleExpanded(): void {
  expanded.value = !expanded.value
  if (expanded.value && sessions.value.length === 0) void refresh()
}

function translateError(raw: string): string {
  if (raw.startsWith('E_REMOTE_DISABLED')) return '客户端已关闭远程控制许可'
  if (raw.startsWith('E_FORBIDDEN')) return '没有控制这台客户端的权限'
  if (raw === 'E_CLIENT_OFFLINE') return '客户端当前离线，命令未送达'
  return raw
}

/** 单行操作统一入口：失败后重新拉会话列表，把本地视图对齐回真实状态 */
async function run(action: () => Promise<void>): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    await action()
  } catch (err) {
    error.value = translateError(err instanceof Error ? err.message : String(err))
    if (clientId.value) listSessions(clientId.value).catch(() => {})
  } finally {
    loading.value = false
  }
}

function rowHint(sessionId: string): string {
  return rowHints.value.get(sessionId) ?? ''
}

function setRowHint(sessionId: string, hint: string): void {
  const next = new Map(rowHints.value)
  if (hint) next.set(sessionId, hint)
  else next.delete(sessionId)
  rowHints.value = next
}

/** 点击行：切换「网页端当前查看的会话」（等价现有会话切换，历史会话建空壳） */
function viewSession(sessionId: string): void {
  if (!clientId.value) return
  openRemoteSession(clientId.value, sessionId)
}

function onActivate(sessionId: string): void {
  if (!clientId.value) return
  void run(() => activateSession(clientId.value, sessionId))
}

function onVisibility(sessionId: string, event: Event): void {
  if (!clientId.value) return
  const visible = (event.target as HTMLInputElement).checked
  void run(() => setSessionVisibility(clientId.value, sessionId, visible))
}

function onPermission(sessionId: string, event: Event): void {
  if (!clientId.value) return
  const value = (event.target as HTMLSelectElement).value as PermissionMode | ''
  if (!value) {
    // 「跟随全局」= 客户端 meta.permissionMode 删除（undefined）；协议必填、无清除命令，
    // 只能提示用户回客户端操作（已知边界，docs/12 §6.3）
    setRowHint(sessionId, '如需恢复跟随全局请在客户端操作')
    return
  }
  setRowHint(sessionId, '')
  void run(() => setSessionPermission(clientId.value, sessionId, value))
}

function onProject(sessionId: string, event: Event): void {
  if (!clientId.value) return
  const projectId = (event.target as HTMLSelectElement).value
  void run(() => setSessionProject(clientId.value, sessionId, projectId))
}

function onProvider(event: Event): void {
  if (!clientId.value) return
  const providerId = (event.target as HTMLSelectElement).value
  if (!providerId || providerId === llm.value?.activeProviderId) return
  void run(() => switchLlm(clientId.value, { providerId }))
}

function onModel(event: Event): void {
  if (!clientId.value) return
  const model = (event.target as HTMLSelectElement).value
  if (!model || model === llm.value?.model) return
  void run(() => switchLlm(clientId.value, { model }))
}

function onEffort(event: Event): void {
  if (!clientId.value) return
  const reasoningEffort = (event.target as HTMLSelectElement).value as ReasoningEffort
  if (!reasoningEffort || reasoningEffort === llm.value?.reasoningEffort) return
  void run(() => switchLlm(clientId.value, { reasoningEffort }))
}
</script>

<template>
  <section class="card session-list-panel" data-panel="session-list">
    <header class="panel-head" @click="toggleExpanded">
      <span class="panel-title">远程会话</span>
      <span class="panel-sub text-2">
        {{ sessions.length > 0 ? `${sessions.length} 个会话` : 'center- 会话管理' }}
      </span>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="loading || !online"
        @click.stop="refresh"
      >
        {{ loading ? '同步中…' : '刷新' }}
      </button>
    </header>

    <p v-if="error" class="panel-error">{{ error }}</p>
    <p v-if="expanded && !online" class="text-2 panel-note">客户端离线，无法读取远程会话。</p>

    <template v-if="expanded">
      <!-- 模型 / 思考等级：当前值来自 client.status.llm，选项来自 config.get（脱敏） -->
      <div class="llm-row" data-panel="llm-switch">
        <label class="llm-field">
          <span class="llm-label">模型</span>
          <select
            class="input input-inline"
            :value="llm?.activeProviderId ?? ''"
            :disabled="loading || providerIds.length === 0"
            data-field="llm.provider"
            @change="onProvider"
          >
            <option v-if="providerIds.length === 0" value="">未读取到模型配置</option>
            <option v-for="id in providerIds" :key="id" :value="id">{{ id }}</option>
          </select>
        </label>
        <label class="llm-field">
          <span class="llm-label">对话模型</span>
          <select
            class="input input-inline"
            :value="llm?.model ?? ''"
            :disabled="loading || modelOptions.length === 0"
            data-field="llm.model"
            @change="onModel"
          >
            <option v-if="modelOptions.length === 0" value="">—</option>
            <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
          </select>
        </label>
        <label class="llm-field">
          <span class="llm-label">思考等级</span>
          <select
            class="input input-inline"
            :value="llm?.reasoningEffort ?? 'auto'"
            :disabled="loading || !llm"
            data-field="llm.reasoning-effort"
            @change="onEffort"
          >
            <option v-for="level in REASONING_LEVELS" :key="level" :value="level">
              {{ level }}
            </option>
          </select>
        </label>
      </div>

      <ul class="session-items">
        <li
          v-for="session in sessions"
          :key="session.sessionId"
          class="session-row"
          :class="{ active: activeKey === `${clientId}:${session.sessionId}` }"
        >
          <button class="session-main" type="button" @click="viewSession(session.sessionId)">
            <span class="session-name">{{ session.title || session.sessionId }}</span>
            <span class="session-meta text-2">
              {{ session.sessionId }} · {{ formatTime(session.updatedAt) }}
            </span>
          </button>
          <div class="session-controls">
            <span
              v-if="session.permissionMode"
              class="chip chip-accent"
              :title="`会话级权限覆盖：${session.permissionMode}`"
            >
              {{ session.permissionMode }}
            </span>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="loading || !online"
              title="让客户端主界面切到该会话"
              @click="onActivate(session.sessionId)"
            >
              在客户端打开
            </button>
            <label class="row-switch" :title="'客户端左栏可见性'">
              <input
                type="checkbox"
                :checked="session.centerVisible !== false"
                :disabled="loading || !online"
                @change="onVisibility(session.sessionId, $event)"
              />
              <span>可见</span>
            </label>
            <select
              class="input input-inline row-select"
              :value="session.permissionMode ?? ''"
              :disabled="loading || !online"
              title="会话级权限档（选「跟随全局」不发起命令）"
              @change="onPermission(session.sessionId, $event)"
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
              class="input input-inline row-select"
              :value="session.projectId ?? ''"
              :disabled="loading || !online"
              title="会话绑定的项目"
              @change="onProject(session.sessionId, $event)"
            >
              <option value="">未绑定项目</option>
              <option v-for="project in projects" :key="project.id" :value="project.id">
                {{ project.name }}
              </option>
            </select>
          </div>
          <p v-if="rowHint(session.sessionId)" class="row-hint">{{ rowHint(session.sessionId) }}</p>
        </li>
      </ul>
      <p v-if="expanded && sessions.length === 0 && !loading" class="text-2 panel-note">
        暂无远程会话——新建会话或发一条消息后会出现在这里。
      </p>
    </template>
  </section>
</template>

<style scoped>
.session-list-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  flex: none;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
}

.panel-sub {
  flex: 1;
  font-size: 12.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--danger, #d70015);
}

.panel-note {
  margin: 0;
  font-size: 12.5px;
}

/* 模型 / 思考等级行 */
.llm-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}

.llm-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.llm-label {
  color: var(--text-2);
  flex: none;
}

/* 会话列表 */
.session-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow-y: auto;
}

.session-row {
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  display: grid;
  gap: 6px;
}

.session-row.active {
  background: var(--accent-soft);
}

.session-main {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  padding: 0;
  cursor: pointer;
  color: var(--text);
  min-height: 40px;
}

.session-name {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row.active .session-name {
  color: var(--accent);
}

.session-meta {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.row-switch {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  cursor: pointer;
  min-height: 40px;
}

.row-select {
  font-size: 12.5px;
  padding: 6px 10px;
  width: auto;
  max-width: 200px;
}

.row-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}

@media (max-width: 720px) {
  .session-list-panel {
    padding: 10px 12px;
  }

  .session-controls {
    align-items: stretch;
  }

  .row-select {
    max-width: none;
    flex: 1 1 160px;
  }
}
</style>
