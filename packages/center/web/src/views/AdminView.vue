<script setup lang="ts">
/**
 * 管理端（role=admin）：用户管理 / 全部客户端。
 *
 * **客户端列表的在线状态来自 WebSocket 推送**（2026-09-29 修复）：`api.admin.clients()` 是
 * 一次性 REST 快照，页面停留期间不会再变 —— 管理员盯着这张表时，设备上线 / 下线永远看不到变化
 * （用户反馈「客户端上线与下线时 Center 的更新太慢」的其中一段）。现在：
 * REST 只负责**首次水合**（含本页才有的全部账号维度），在线位 / 模式 / 版本 / 最近活跃
 * 一律以 store 里那条 WS 全量快照（`state.clients`）为准实时覆盖。
 * 用户管理仍是纯 REST（用户增删改没有推送通道，也不需要）。
 */
import { computed, onMounted, ref } from 'vue'
import type { ClientInfo } from '@aurora/shared'
import { Plus } from '@aurora/shared/browser'
import { api, type AdminUser } from '../lib/api'
import { formatTime, modeLabel, platformLabel } from '../lib/format'
import { state as centerState } from '../state'

const users = ref<AdminUser[]>([])
const clients = ref<ClientInfo[]>([])
const loading = ref(true)
const error = ref('')

/**
 * 列表行 = REST 快照 ∪ WS 实时快照（两边的并集）。
 *
 * - 同一条客户端以 **WS 快照为准**（在线位 / 模式 / 版本 / 最近活跃的唯一实时来源）；
 * - REST 结果里多出来的条目照常显示（WS 还没连上时它只有 REST 有数据）；
 * - **WS 快照里多出来的条目也要补进来**：停在本页期间首次上线的设备只有 WS 全量快照里才有，
 *   只按 REST 的行骨架 map，管理员要刷新页面才看得到新设备。
 */
const clientRows = computed<ClientInfo[]>(() => {
  const rows: ClientInfo[] = []
  const seen = new Set<string>()
  for (const info of clients.value) {
    seen.add(info.clientId)
    rows.push(centerState.clients.get(info.clientId)?.client ?? info)
  }
  for (const [clientId, entry] of centerState.clients) {
    if (seen.has(clientId)) continue
    rows.push(entry.client)
  }
  return rows
})

async function loadAll(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [u, c] = await Promise.all([api.admin.users(), api.admin.clients()])
    users.value = u.users
    clients.value = c.clients
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

// ───────────────────────── 用户管理 ─────────────────────────

const newUsername = ref('')
const newPassword = ref('')
const newRole = ref<'user' | 'admin'>('user')
const creatingUser = ref(false)
const userError = ref('')

const resetId = ref('')
const resetPassword = ref('')
const resetting = ref(false)

async function createUser(): Promise<void> {
  if (creatingUser.value) return
  userError.value = ''
  const username = newUsername.value.trim()
  if (!username || newPassword.value.length < 6) {
    userError.value = '请填写用户名与至少 6 位的密码'
    return
  }
  creatingUser.value = true
  try {
    await api.admin.createUser(username, newPassword.value, newRole.value)
    newUsername.value = ''
    newPassword.value = ''
    newRole.value = 'user'
    users.value = (await api.admin.users()).users
  } catch (err) {
    userError.value = err instanceof Error ? err.message : '创建用户失败'
  } finally {
    creatingUser.value = false
  }
}

async function confirmReset(): Promise<void> {
  if (resetting.value || !resetId.value) return
  if (resetPassword.value.length < 6) {
    userError.value = '新密码至少 6 位'
    return
  }
  resetting.value = true
  userError.value = ''
  try {
    await api.admin.resetPassword(resetId.value, resetPassword.value)
    resetId.value = ''
    resetPassword.value = ''
  } catch (err) {
    userError.value = err instanceof Error ? err.message : '重置密码失败'
  } finally {
    resetting.value = false
  }
}

async function removeUser(user: AdminUser): Promise<void> {
  if (!window.confirm(`确定删除用户「${user.username}」？该用户的登录将立即失效。`)) return
  userError.value = ''
  try {
    await api.admin.deleteUser(user.id)
    users.value = (await api.admin.users()).users
  } catch (err) {
    // 409（不能删自己 / 最后一个管理员）等：展示服务器原因
    userError.value = err instanceof Error ? err.message : '删除失败'
  }
}

// ───────────────────────── 全部客户端 ─────────────────────────

const clientError = ref('')
const deletingClientId = ref('')

async function removeClient(client: ClientInfo): Promise<void> {
  if (!window.confirm(`解除登记客户端「${client.name}」？它需要重新用账号登录才能接入。`)) return
  clientError.value = ''
  deletingClientId.value = client.clientId
  try {
    await api.admin.deleteClient(client.clientId)
    clients.value = (await api.admin.clients()).clients
  } catch (err) {
    clientError.value = err instanceof Error ? err.message : '解除登记失败'
  } finally {
    deletingClientId.value = ''
  }
}

onMounted(() => void loadAll())
</script>

<template>
  <section class="page admin" data-panel="admin-page">
    <header class="admin-head">
      <h1 class="page-title">管理</h1>
      <p class="page-sub">
        用户与客户端：普通用户只能看到自己名下的客户端，管理员可见并控制全部设备。
      </p>
    </header>

    <p v-if="error" class="ui-error">{{ error }}</p>
    <div v-if="loading" class="admin-loading" aria-busy="true">
      <span class="ui-spinner spin" aria-hidden="true"></span>
    </div>

    <template v-else>
      <!-- 用户管理 -->
      <section class="ui-card admin-section">
        <header class="admin-section-head">
          <h2 class="admin-section-title">用户管理</h2>
          <p class="admin-section-sub">
            管理员可见并控制所有客户端；普通用户只能看到自己名下的客户端。
          </p>
        </header>

        <div class="admin-form">
          <input
            v-model="newUsername"
            class="ui-input"
            type="text"
            placeholder="用户名"
            aria-label="用户名"
          />
          <input
            v-model="newPassword"
            class="ui-input"
            type="password"
            placeholder="密码（至少 6 位）"
            aria-label="密码"
          />
          <select v-model="newRole" class="ui-input" aria-label="角色">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <button
            class="ui-btn ui-btn--primary"
            type="button"
            :disabled="creatingUser"
            @click="createUser"
          >
            <Plus :size="14" :stroke-width="1.9" aria-hidden="true" />
            {{ creatingUser ? '创建中…' : '新建用户' }}
          </button>
        </div>

        <p v-if="userError" class="ui-error">{{ userError }}</p>

        <div class="admin-scroll">
          <table class="ui-table" data-panel="admin-users">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>创建时间</th>
                <th class="admin-end">操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="user in users" :key="user.id">
                <tr data-field="admin.user-row">
                  <td class="admin-name">{{ user.username }}</td>
                  <td>
                    <span class="ui-chip" :class="user.role === 'admin' ? 'ui-chip--accent' : ''">
                      {{ user.role === 'admin' ? '管理员' : '普通用户' }}
                    </span>
                  </td>
                  <td class="admin-dim admin-num">{{ formatTime(user.createdAt) }}</td>
                  <td class="admin-end">
                    <div class="admin-actions">
                      <button class="ui-btn ui-btn--ghost" type="button" @click="resetId = user.id">
                        重置密码
                      </button>
                      <button class="ui-btn ui-btn--danger" type="button" @click="removeUser(user)">
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="resetId === user.id" class="admin-sub-row">
                  <td colspan="4">
                    <div class="admin-form">
                      <input
                        v-model="resetPassword"
                        class="ui-input"
                        type="password"
                        placeholder="新密码（至少 6 位）"
                        aria-label="新密码"
                      />
                      <button
                        class="ui-btn ui-btn--primary"
                        type="button"
                        :disabled="resetting"
                        @click="confirmReset"
                      >
                        确定
                      </button>
                      <button class="ui-btn ui-btn--ghost" type="button" @click="resetId = ''">
                        取消
                      </button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 全部客户端 -->
      <section class="ui-card admin-section">
        <header class="admin-section-head">
          <h2 class="admin-section-title">全部客户端</h2>
          <p class="admin-section-sub">解除登记后客户端需要重新用账号登录才能接入。</p>
        </header>

        <p v-if="clientError" class="ui-error">{{ clientError }}</p>

        <div class="admin-scroll">
          <table class="ui-table" data-panel="admin-clients">
            <thead>
              <tr>
                <th>名称</th>
                <th>属主</th>
                <th>平台</th>
                <th>版本</th>
                <th>模式</th>
                <th>在线</th>
                <th>最近活跃</th>
                <th class="admin-end">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="client in clientRows" :key="client.clientId" data-field="admin.client-row">
                <td>
                  <span class="admin-client">
                    <span
                      class="admin-dot"
                      :class="{ 'admin-dot--on': client.online }"
                      aria-hidden="true"
                    ></span>
                    <span class="admin-name">{{ client.name }}</span>
                  </span>
                </td>
                <td>{{ client.ownerUsername }}</td>
                <td class="admin-dim">{{ platformLabel(client.platform) }}</td>
                <td class="admin-dim admin-num">v{{ client.version }}</td>
                <td class="admin-dim">{{ modeLabel(client.mode) }}</td>
                <td>
                  <span
                    class="ui-chip"
                    :class="client.online ? 'ui-chip--ok' : 'ui-chip--muted'"
                    data-field="admin.client-online"
                  >
                    {{ client.online ? '在线' : '离线' }}
                  </span>
                </td>
                <td class="admin-dim admin-num">{{ formatTime(client.lastSeenAt) }}</td>
                <td class="admin-end">
                  <button
                    class="ui-btn ui-btn--danger"
                    type="button"
                    :disabled="deletingClientId === client.clientId"
                    @click="removeClient(client)"
                  >
                    {{ deletingClientId === client.clientId ? '解除中…' : '解除登记' }}
                  </button>
                </td>
              </tr>
              <tr v-if="clientRows.length === 0">
                <td colspan="8" class="admin-empty">还没有客户端接入</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
/* 外壳（App.vue 的 main.page）已提供页面留白时不再叠加一层内边距 */
.page .page {
  padding: 0;
}

.admin-head {
  display: grid;
  gap: var(--space-1);
}

.admin-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.admin-section {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
}

.admin-section-head {
  display: grid;
  gap: var(--space-1);
}

.admin-section-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.admin-section-sub {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.admin-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.admin-form .ui-input {
  flex: 1 1 160px;
}

.admin-form .ui-btn {
  flex: none;
}

.admin-scroll {
  overflow-x: auto;
}

.admin-name {
  font-weight: var(--weight-medium);
  word-break: break-all;
}

.admin-dim {
  color: var(--text-secondary);
}

.admin-num {
  font-variant-numeric: var(--num-tabular);
  white-space: nowrap;
}

.admin-client {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.admin-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--status-idle);
}

.admin-dot--on {
  background: var(--status-ok);
}

.admin-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  white-space: nowrap;
}

.admin-end {
  text-align: right;
}

.admin-empty {
  color: var(--text-secondary);
}

.admin-sub-row td {
  background: var(--fill-2);
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

.ui-chip--accent {
  background: var(--fill-1);
  color: var(--accent-text);
}

.ui-chip--muted {
  color: var(--text-muted);
}

.ui-card {
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
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

@media (max-width: 720px) {
  .admin-section {
    padding: var(--space-3);
  }

  .ui-btn,
  .ui-input {
    min-height: var(--hit-target);
  }

  .admin-form .ui-input {
    flex: 1 1 140px;
  }

  .ui-table {
    min-width: 640px;
  }
}
</style>
