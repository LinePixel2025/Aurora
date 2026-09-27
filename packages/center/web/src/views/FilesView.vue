<script setup lang="ts">
/**
 * 文件管理页（#/files）：客户端经 center_send_file 上传的暂存文件（24h 自动过期）。
 * 纯 REST：列表 / 删除（属主过滤后端已做）；下载走 `?token=` 直链（<a> 无法带鉴权头）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FileEntryInfo } from '@aurora/shared'
import { ApiError, api, fileUrl } from '../api'
import { formatBytes, formatRemaining, formatTime, remainingMs } from '../format'
import { state } from '../store'

const files = ref<FileEntryInfo[]>([])
const loading = ref(true)
const error = ref('')
const removingId = ref('')

/** 客户端 id → 展示名（快照里没有的回落 id 本身） */
function clientName(clientId: string): string {
  return state.clients.get(clientId)?.client.name ?? clientId
}

/** 剩余有效期 < 24h 才显示倒计时文案；秒级心跳驱动 */
const now = ref(Date.now())
const heartbeat = window.setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => window.clearInterval(heartbeat))

function expiresIn(file: FileEntryInfo): string {
  const remaining = remainingMs(file.expiresAt, now.value)
  return `剩 ${formatRemaining(remaining)}`
}

const anyExpiringSoon = computed(() =>
  files.value.some((file) => {
    const remaining = remainingMs(file.expiresAt, now.value)
    return remaining > 0 && remaining < 24 * 3600 * 1000
  }),
)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    files.value = (await api.files()).files
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载文件列表失败'
  } finally {
    loading.value = false
  }
}

async function remove(file: FileEntryInfo): Promise<void> {
  if (!window.confirm(`删除文件「${file.name}」？删除后不可恢复。`)) return
  removingId.value = file.fileId
  error.value = ''
  try {
    await api.deleteFile(file.fileId)
    files.value = files.value.filter((item) => item.fileId !== file.fileId)
  } catch (err) {
    // 已被过期清理 / 已删除：从列表摘掉即可，其余错误如实展示
    if (err instanceof ApiError && err.status === 404) {
      files.value = files.value.filter((item) => item.fileId !== file.fileId)
    } else {
      error.value = err instanceof Error ? err.message : '删除失败'
    }
  } finally {
    removingId.value = ''
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="files-view">
    <div class="files-head">
      <div>
        <h2 class="files-title">文件管理</h2>
        <p class="text-2 files-sub">
          客户端通过 Agent 发送的文件暂存在 Center，24 小时后自动删除。<span
            v-if="anyExpiringSoon"
            class="expiring-hint"
          >
            剩余不足 24 小时的文件会显示倒计时。</span
          >
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="load">刷新</button>
    </div>

    <p v-if="error" class="form-error">{{ error }}</p>
    <div v-if="loading" class="boot-center files-loading"><span class="spinner"></span></div>

    <div v-else-if="files.length === 0" class="card empty-card">
      <p class="text-2">
        暂无文件——在远程会话里让 Agent 调用 center_send_file 发送文件后，会出现在这里。
      </p>
    </div>

    <div v-else class="card table-card">
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>来源客户端</th>
              <th>大小</th>
              <th>备注</th>
              <th>上传时间</th>
              <th>过期</th>
              <th class="ta-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in files" :key="file.fileId">
              <td class="file-name">{{ file.name }}</td>
              <td class="text-2">{{ clientName(file.clientId) }}</td>
              <td class="text-2">{{ formatBytes(file.size) }}</td>
              <td class="text-2 file-note">{{ file.note || '—' }}</td>
              <td class="text-2">{{ formatTime(file.uploadedAt) }}</td>
              <td>
                <span class="text-2">{{ formatTime(file.expiresAt) }}</span>
                <span v-if="remainingMs(file.expiresAt, now) < 24 * 3600 * 1000" class="countdown">
                  {{ expiresIn(file) }}
                </span>
              </td>
              <td class="ta-right actions">
                <a
                  class="btn btn-secondary btn-sm"
                  :href="fileUrl(file.fileId)"
                  :download="file.name"
                >
                  下载
                </a>
                <button
                  class="btn btn-danger-ghost btn-sm"
                  type="button"
                  :disabled="removingId === file.fileId"
                  @click="remove(file)"
                >
                  {{ removingId === file.fileId ? '删除中…' : '删除' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.files-view {
  display: grid;
  gap: 14px;
}

.files-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.files-title {
  margin: 0 0 2px;
  font-size: 18px;
}

.files-sub {
  margin: 0;
  font-size: 13px;
}

.expiring-hint {
  color: var(--accent);
}

.files-loading {
  min-height: 200px;
}

.empty-card {
  padding: 40px 24px;
  text-align: center;
}

.table-card {
  padding: 8px 12px;
}

.file-name {
  font-weight: 500;
  word-break: break-all;
  min-width: 160px;
}

.file-note {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.countdown {
  display: block;
  font-size: 12px;
  color: var(--accent);
}

.actions {
  white-space: nowrap;
}

.actions .btn + .btn {
  margin-left: 6px;
}
</style>
