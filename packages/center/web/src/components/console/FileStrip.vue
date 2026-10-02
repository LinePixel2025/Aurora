<script setup lang="ts">
/**
 * 文件接收条（docs/12 §5 第 5 步）：本轮页面停留期间该客户端发来的文件。
 *
 * 服务器侧 24h 后自动删除，所以卡上如实标出「24 小时内可下载」。
 * 下载走 `?token=` 的 URL（`<a href>` 带不了鉴权头，docs/12 §4.2）。
 */
import type { ClientEntry } from '../../state'
import { fileUrl } from '../../lib/api'
import { formatBytes, formatTime } from '../../lib/format'
import { Paperclip } from '@aurora/shared/browser'

defineProps<{ entry: ClientEntry }>()
</script>

<template>
  <div v-if="entry.files.length > 0" class="files" data-field="chat.files">
    <span class="files-label">
      <Paperclip :size="13" :stroke-width="1.8" aria-hidden="true" />
      对方发来的文件
    </span>
    <a
      v-for="file in entry.files.slice(0, 5)"
      :key="file.fileId"
      class="file-chip"
      :href="fileUrl(file.fileId)"
      :title="`${formatBytes(file.size)} · ${formatTime(file.at)} · 24 小时内可下载`"
      data-field="chat.file-chip"
      download
    >
      <span class="file-name">{{ file.name }}</span>
      <span class="file-size">{{ formatBytes(file.size) }}</span>
    </a>
  </div>
</template>

<style scoped>
.files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.files-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.file-chip {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  max-width: 240px;
  min-height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 14%, transparent);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  text-decoration: none;
  transition: background var(--transition-fast);
}

.file-chip:hover {
  background: color-mix(in srgb, var(--aurora-blue) 22%, transparent);
  color: var(--text-primary);
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}
</style>
