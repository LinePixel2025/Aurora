<script setup lang="ts">
/**
 * 管理端（role=admin）：用户管理 / 配对令牌（全量）/ 全部客户端。
 * 纯 REST 交互；409（不能删自己 / 最后一个管理员）等错误原样展示服务器 message。
 */
import { onMounted, ref } from 'vue'
import type { ClientInfo } from '@aurora/shared'
import { api, type AdminUser, type PairingToken } from '../api'
import { formatTime, modeLabel, platformLabel } from '../format'

const users = ref<AdminUser[]>([])
const tokens = ref<PairingToken[]>([])
const clients = ref<ClientInfo[]>([])
const loading = ref(true)
const error = ref('')

async function loadAll(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [u, t, c] = await Promise.all([
      api.admin.users(),
      api.admin.tokens(),
      api.admin.clients(),
    ])
    users.value = u.users
    tokens.value = t.tokens
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
    userError.value = '请填写用户名与至少 6 位的口令'
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
    userError.value = '新口令至少 6 位'
    return
  }
  resetting.value = true
  userError.value = ''
  try {
    await api.admin.resetPassword(resetId.value, resetPassword.value)
    resetId.value = ''
    resetPassword.value = ''
  } catch (err) {
    userError.value = err instanceof Error ? err.message : '重置口令失败'
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

// ───────────────────────── 配对令牌 ─────────────────────────

const tokenError = ref('')
const revokingTokenId = ref('')

async function revokeToken(token: PairingToken): Promise<void> {
  if (!window.confirm(`吊销令牌「${token.label || token.id}」？已连接的客户端会掉线且无法重连。`)) {
    return
  }
  tokenError.value = ''
  revokingTokenId.value = token.id
  try {
    await api.revokePairingToken(token.id)
    tokens.value = (await api.admin.tokens()).tokens
  } catch (err) {
    tokenError.value = err instanceof Error ? err.message : '吊销失败'
  } finally {
    revokingTokenId.value = ''
  }
}

// ───────────────────────── 全部客户端 ─────────────────────────

const clientError = ref('')
const deletingClientId = ref('')

async function removeClient(client: ClientInfo): Promise<void> {
  if (!window.confirm(`解除登记客户端「${client.name}」？它需要用新的配对令牌重新接入。`)) return
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
  <div class="admin">
    <p v-if="error" class="form-error">{{ error }}</p>
    <div v-if="loading" class="boot-center admin-loading"><span class="spinner"></span></div>

    <template v-else>
      <!-- 用户管理 -->
      <section class="card section-card">
        <h3>用户管理</h3>
        <p class="section-sub">管理员可见并控制所有客户端；普通用户只能看到自己名下的客户端。</p>
        <div class="inline-form">
          <input
            v-model="newUsername"
            class="input input-inline"
            type="text"
            placeholder="用户名"
          />
          <input
            v-model="newPassword"
            class="input input-inline"
            type="password"
            placeholder="口令（至少 6 位）"
          />
          <select v-model="newRole" class="input input-inline">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="creatingUser"
            @click="createUser"
          >
            {{ creatingUser ? '创建中…' : '新建用户' }}
          </button>
        </div>
        <p v-if="userError" class="form-error">{{ userError }}</p>
        <table class="table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>创建时间</th>
              <th class="ta-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="user in users" :key="user.id">
              <tr>
                <td>{{ user.username }}</td>
                <td>
                  <span class="chip" :class="user.role === 'admin' ? 'chip-accent' : ''">
                    {{ user.role === 'admin' ? '管理员' : '普通用户' }}
                  </span>
                </td>
                <td class="text-2">{{ formatTime(user.createdAt) }}</td>
                <td class="ta-right actions">
                  <button class="btn btn-ghost btn-sm" type="button" @click="resetId = user.id">
                    重置口令
                  </button>
                  <button
                    class="btn btn-danger-ghost btn-sm"
                    type="button"
                    @click="removeUser(user)"
                  >
                    删除
                  </button>
                </td>
              </tr>
              <tr v-if="resetId === user.id">
                <td colspan="4" class="sub-row">
                  <div class="inline-form">
                    <input
                      v-model="resetPassword"
                      class="input input-inline"
                      type="password"
                      placeholder="新口令（至少 6 位）"
                    />
                    <button
                      class="btn btn-primary btn-sm"
                      type="button"
                      :disabled="resetting"
                      @click="confirmReset"
                    >
                      确定
                    </button>
                    <button class="btn btn-ghost btn-sm" type="button" @click="resetId = ''">
                      取消
                    </button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>

      <!-- 配对令牌 -->
      <section class="card section-card">
        <h3>配对令牌</h3>
        <p class="section-sub">
          全部用户的配对令牌。令牌明文只在创建时展示一次；吊销后对应客户端无法重连。
        </p>
        <p v-if="tokenError" class="form-error">{{ tokenError }}</p>
        <table class="table">
          <thead>
            <tr>
              <th>备注</th>
              <th>创建时间</th>
              <th>绑定客户端</th>
              <th>状态</th>
              <th class="ta-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.id">
              <td>{{ token.label || '—' }}</td>
              <td class="text-2">{{ formatTime(token.createdAt) }}</td>
              <td class="text-2">{{ token.clientId || '未绑定' }}</td>
              <td>
                <span class="chip" :class="token.revokedAt ? 'chip-muted' : 'chip-ok'">
                  {{ token.revokedAt ? `已吊销 ${formatTime(token.revokedAt)}` : '有效' }}
                </span>
              </td>
              <td class="ta-right">
                <button
                  v-if="!token.revokedAt"
                  class="btn btn-danger-ghost btn-sm"
                  type="button"
                  :disabled="revokingTokenId === token.id"
                  @click="revokeToken(token)"
                >
                  {{ revokingTokenId === token.id ? '吊销中…' : '吊销' }}
                </button>
              </td>
            </tr>
            <tr v-if="tokens.length === 0">
              <td colspan="5" class="text-2">暂无令牌</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 全部客户端 -->
      <section class="card section-card">
        <h3>全部客户端</h3>
        <p class="section-sub">解除登记后客户端需要重新配对才能接入。</p>
        <p v-if="clientError" class="form-error">{{ clientError }}</p>
        <table class="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>属主</th>
              <th>平台</th>
              <th>版本</th>
              <th>模式</th>
              <th>在线</th>
              <th>最近活跃</th>
              <th class="ta-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="client in clients" :key="client.clientId">
              <td>
                <span class="dot" :class="client.online ? 'on' : 'off'"></span>
                {{ client.name }}
              </td>
              <td>{{ client.ownerUsername }}</td>
              <td class="text-2">{{ platformLabel(client.platform) }}</td>
              <td class="text-2">v{{ client.version }}</td>
              <td class="text-2">{{ modeLabel(client.mode) }}</td>
              <td>
                <span class="chip" :class="client.online ? 'chip-ok' : 'chip-muted'">
                  {{ client.online ? '在线' : '离线' }}
                </span>
              </td>
              <td class="text-2">{{ formatTime(client.lastSeenAt) }}</td>
              <td class="ta-right">
                <button
                  class="btn btn-danger-ghost btn-sm"
                  type="button"
                  :disabled="deletingClientId === client.clientId"
                  @click="removeClient(client)"
                >
                  {{ deletingClientId === client.clientId ? '解除中…' : '解除登记' }}
                </button>
              </td>
            </tr>
            <tr v-if="clients.length === 0">
              <td colspan="8" class="text-2">还没有客户端接入</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.admin {
  display: grid;
  gap: 16px;
}

.admin-loading {
  min-height: 200px;
}

.section-card {
  padding: 20px 22px;
}

.section-card h3 {
  margin: 0 0 2px;
  font-size: 16px;
}

.section-sub {
  color: var(--text-2);
  font-size: 13px;
  margin: 0 0 14px;
}

.inline-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  align-items: center;
}

.actions {
  white-space: nowrap;
}

.actions .btn + .btn {
  margin-left: 6px;
}

.sub-row td {
  background: rgba(0, 0, 0, 0.02);
}

.sub-row .inline-form {
  margin-bottom: 0;
}
</style>
