<script setup lang="ts">
/**
 * 文件管理页（#/files）：客户端经 center_send_file 上传的暂存文件（24h 自动过期）。
 * 纯 REST：列表 / 删除（属主过滤后端已做）；下载走 `?token=` 直链（<a> 无法带鉴权头）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FileEntryInfo } from '@aurora/shared'
import { ApiError, api, fileUrl } from '../lib/api'
import { formatBytes, formatRemaining, formatTime, remainingMs } from '../lib/format'
import { sendFile, showNotice, state } from '../state'

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

/* ── 把暂存文件推给客户端（docs/12 §5，本轮）────────────────────────
 * 目标设备选一个就行（不逐行选）：文件页的用途是「把某份暂存文件发回某台设备」，
 * 逐行挂一个设备下拉会让表格挤成一片。离线 / 未允许文件传输的设备不在候选里。 */
const targetClientId = ref('')
const sendingFileId = ref('')

const sendTargets = computed(() =>
  [...state.clients.values()].filter(
    (entry) =>
      entry.client.online && entry.status?.center.allowFileTransfer !== false,
  ),
)

/** 来源标注（本轮）：客户端上传 vs 网页上传（网页上传是「发给某个客户端」的中间态） */
function sourceLabel(file: FileEntryInfo): string {
  return file.source === 'web' ? '来自网页' : '客户端'
}

async function sendTo(file: FileEntryInfo): Promise<void> {
  const target = targetClientId.value
  if (target === '' || sendingFileId.value !== '') return
  sendingFileId.value = file.fileId
  error.value = ''
  try {
    await sendFile(target, file.fileId)
  } catch (err) {
    const message = err instanceof Error ? err.message : '发送失败'
    error.value = message
    showNotice(`发送文件失败：${message}`)
  } finally {
    sendingFileId.value = ''
  }
}
</script>

<template>
  <section class="page files-page" data-panel="files-page">
    <header class="files-head">
      <div class="files-head-text">
        <h1 class="page-title">文件</h1>
        <p class="page-sub">
          客户端通过 Agent 发送的文件暂存在 Center，24 小时后自动删除。<span
            v-if="anyExpiringSoon"
            class="files-hint"
          >
            剩余不足 24 小时的文件会显示倒计时。</span
          >
        </p>
      </div>
      <button class="ui-btn ui-btn--ghost" type="button" @click="load">刷新</button>
    </header>

    <!-- 目标设备（本轮）：行内「发送到客户端」用它；没有可发设备时整条提示隐藏 -->
    <div v-if="sendTargets.length > 0" class="files-target">
      <label class="files-target-label" for="files-target-select">发送到设备</label>
      <select
        id="files-target-select"
        v-model="targetClientId"
        class="files-target-select"
        data-field="files.target-client"
      >
        <option value="">选择一个在线设备…</option>
        <option v-for="item in sendTargets" :key="item.client.clientId" :value="item.client.clientId">
          {{ item.client.name }}
        </option>
      </select>
    </div>

    <p v-if="error" class="ui-error">{{ error }}</p>

    <div v-if="loading" class="files-loading" aria-busy="true">
      <span class="ui-spinner spin" aria-hidden="true"></span>
    </div>

    <div v-else-if="files.length === 0" class="ui-card files-empty">
      <p class="files-empty-text">
        暂无文件——在远程会话里让 Agent 调用 center_send_file 发送文件后，会出现在这里。
      </p>
    </div>

    <div v-else class="ui-card files-card">
      <div class="files-scroll">
        <table class="ui-table" data-panel="files-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>来源</th>
              <th>来源客户端</th>
              <th>大小</th>
              <th>备注</th>
              <th>上传时间</th>
              <th>过期</th>
              <th class="files-end">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in files" :key="file.fileId" data-field="files.row">
              <td class="files-name">{{ file.name }}</td>
              <td class="files-dim" data-field="files.source">{{ sourceLabel(file) }}</td>
              <td class="files-dim">{{ clientName(file.clientId) }}</td>
              <td class="files-dim files-num">{{ formatBytes(file.size) }}</td>
              <td class="files-dim files-note">{{ file.note || '—' }}</td>
              <td class="files-dim files-num">{{ formatTime(file.uploadedAt) }}</td>
              <td>
                <span class="files-dim files-num">{{ formatTime(file.expiresAt) }}</span>
                <span v-if="remainingMs(file.expiresAt, now) < 24 * 3600 * 1000" class="countdown">
                  {{ expiresIn(file) }}
                </span>
              </td>
              <td>
                <div class="files-actions">
                  <a
                    class="ui-btn ui-btn--ghost"
                    :href="fileUrl(file.fileId)"
                    :download="file.name"
                  >
                    下载
                  </a>
                  <button
                    v-if="sendTargets.length > 0"
                    class="ui-btn ui-btn--ghost"
                    type="button"
                    data-action="files.send-to-client"
                    :disabled="targetClientId === '' || sendingFileId !== ''"
                    :title="
                      targetClientId === ''
                        ? '先在上方选择目标设备'
                        : '把这份暂存文件发到该设备的下载目录'
                    "
                    @click="sendTo(file)"
                  >
                    {{ sendingFileId === file.fileId ? '发送中…' : '发送到客户端' }}
                  </button>
                  <button
                    class="ui-btn ui-btn--danger"
                    type="button"
                    data-action="files.delete"
                    :disabled="removingId === file.fileId"
                    @click="remove(file)"
                  >
                    {{ removingId === file.fileId ? '删除中…' : '删除' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 外壳（App.vue 的 main.page）已提供页面留白时不再叠加一层内边距 */
.page .page {
  padding: 0;
}

.files-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.files-head-text {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.files-hint {
  color: var(--accent-text);
}

/* 目标设备选择条（本轮「发送到客户端」）：与页头保持同一条呼吸间距 */
.files-target {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.files-target-label {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.files-target-select {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.files-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.files-empty {
  padding: var(--space-7) var(--space-4);
  text-align: center;
}

.files-empty-text {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.files-card {
  padding: var(--space-3);
}

.files-scroll {
  overflow-x: auto;
}

.files-name {
  font-weight: var(--weight-medium);
  word-break: break-all;
  min-width: 160px;
}

.files-dim {
  color: var(--text-secondary);
}

.files-num {
  font-variant-numeric: var(--num-tabular);
  white-space: nowrap;
}

.files-note {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.countdown {
  display: block;
  font-size: var(--text-xs);
  color: var(--accent-text);
  font-variant-numeric: var(--num-tabular);
}

.files-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  white-space: nowrap;
}

.files-end {
  text-align: right;
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
  .files-head {
    align-items: stretch;
  }

  .ui-btn {
    min-height: var(--hit-target);
  }

  .files-card {
    padding: var(--space-2);
  }

  .ui-table {
    min-width: 640px;
  }
}
</style>
