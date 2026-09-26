<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type PairingToken } from '../api'
import { formatTime } from '../format'

/**
 * 配对令牌面板（普通用户管理自己的令牌）。
 * 新令牌明文只在创建响应里出现一次：高亮展示 + 复制按钮，关闭后无法再查看。
 */
const emit = defineEmits<{ close: [] }>()

const tokens = ref<PairingToken[]>([])
const loading = ref(true)
const error = ref('')
const label = ref('')
const creating = ref(false)
const freshToken = ref<{ id: string; token: string } | null>(null)
const copied = ref(false)
const revokingId = ref('')

async function refresh(): Promise<void> {
  error.value = ''
  try {
    tokens.value = (await api.listPairingTokens()).tokens
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载配对令牌失败'
  } finally {
    loading.value = false
  }
}

async function create(): Promise<void> {
  if (creating.value) return
  creating.value = true
  error.value = ''
  try {
    const created = await api.createPairingToken(label.value.trim() || undefined)
    freshToken.value = created
    copied.value = false
    label.value = ''
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建失败'
  } finally {
    creating.value = false
  }
}

async function revoke(token: PairingToken): Promise<void> {
  if (!window.confirm(`吊销令牌「${token.label || token.id}」？已连接的客户端会掉线且无法重连。`)) {
    return
  }
  revokingId.value = token.id
  error.value = ''
  try {
    await api.revokePairingToken(token.id)
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '吊销失败'
  } finally {
    revokingId.value = ''
  }
}

async function copyFresh(): Promise<void> {
  if (!freshToken.value) return
  try {
    await window.navigator.clipboard.writeText(freshToken.value.token)
    copied.value = true
  } catch {
    copied.value = false // 剪贴板不可用时手动选中复制
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="card panel">
      <header class="panel-head">
        <h3>配对令牌</h3>
        <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">关闭</button>
      </header>
      <p class="panel-hint text-2">
        配对令牌用于在 Aurora 客户端设置里连接本 Center，令牌明文只显示一次，请立即复制保存。
      </p>

      <div class="token-create">
        <input
          v-model="label"
          class="input"
          type="text"
          placeholder="备注（可选，如「客厅电脑」）"
        />
        <button class="btn btn-primary" type="button" :disabled="creating" @click="create">
          {{ creating ? '创建中…' : '创建令牌' }}
        </button>
      </div>

      <div v-if="freshToken" class="token-fresh">
        <p class="token-fresh-label">新令牌明文（关闭后无法再查看）：</p>
        <div class="token-fresh-row">
          <code class="token-plain mono">{{ freshToken.token }}</code>
          <button class="btn btn-secondary btn-sm" type="button" @click="copyFresh">
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
      </div>

      <p v-if="error" class="form-error">{{ error }}</p>

      <table v-if="tokens.length > 0" class="table">
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
                {{ token.revokedAt ? '已吊销' : '有效' }}
              </span>
            </td>
            <td class="ta-right">
              <button
                v-if="!token.revokedAt"
                class="btn btn-danger-ghost btn-sm"
                type="button"
                :disabled="revokingId === token.id"
                @click="revoke(token)"
              >
                {{ revokingId === token.id ? '吊销中…' : '吊销' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!loading" class="text-2 panel-empty">
        暂无令牌——创建一个，填到客户端设置里完成配对。
      </p>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.panel {
  width: 640px;
  max-width: 100%;
  max-height: 82vh;
  overflow-y: auto;
  padding: 20px 22px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-head h3 {
  margin: 0;
  font-size: 16px;
}

.panel-hint {
  font-size: 13px;
  margin: 4px 0 14px;
}

.token-create {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.token-create .input {
  flex: 1;
}

.token-fresh {
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin-bottom: 12px;
}

.token-fresh-label {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--accent);
  font-weight: 500;
}

.token-fresh-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.token-plain {
  flex: 1;
  background: var(--card);
  border-radius: 8px;
  padding: 8px 10px;
}

.panel-empty {
  font-size: 13px;
  margin: 8px 0;
}
</style>
