<script setup lang="ts">
/** 文件自感知运行记录列表：设置页摘要与“查看更多”弹窗共用同一份渲染。 */
import type { FileAwarenessRecord } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'

defineProps<{
  records: FileAwarenessRecord[]
}>()

const emit = defineEmits<{
  (event: 'analyze', record: FileAwarenessRecord): void
}>()

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<template>
  <div v-if="records.length === 0" class="empty">暂无文件记录</div>
  <div v-for="record in records" :key="record.id" class="record">
    <div class="record-main">
      <strong>{{ record.fileName }}</strong>
      <span class="tiny muted"
        >{{ record.kind }} · {{ record.status }} · {{ formatTime(record.occurredAt) }}</span
      >
      <p v-if="record.summary" class="tiny">{{ record.summary }}</p>
      <p v-if="record.error" class="warn tiny">{{ record.error }}</p>
    </div>
    <AppButton
      v-if="record.ext === 'docx' || record.ext === 'pptx'"
      size="sm"
      variant="ghost"
      @click="emit('analyze', record)"
    >
      分析
    </AppButton>
  </div>
</template>

<style scoped>
.record {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--fill-1);
}

.record-main {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.record-main strong {
  overflow-wrap: anywhere;
}

.record-main p {
  margin: 0;
}

.warn {
  color: var(--status-unread);
}

.empty {
  color: var(--text-muted);
  font-size: var(--text-sm);
}
</style>
