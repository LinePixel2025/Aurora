<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolItem } from '../store'

/**
 * 可折叠工具卡：工具名 + 状态 + 输入摘要（不堆全量 JSON，docs/12 §10）。
 * running 转圈、success 绿点、error 红点。
 */
const props = defineProps<{ tool: ToolItem }>()

const open = ref(false)

const stateLabel = computed(() => {
  switch (props.tool.state) {
    case 'running':
      return '运行中'
    case 'success':
      return '完成'
    default:
      return '失败'
  }
})
</script>

<template>
  <div class="tool-card" :class="`is-${tool.state}`">
    <button class="tool-head" type="button" @click="open = !open">
      <span v-if="tool.state === 'running'" class="spinner spinner-sm"></span>
      <span v-else class="tool-dot"></span>
      <span class="tool-name">{{ tool.name }}</span>
      <span class="tool-state">{{ stateLabel }}</span>
      <span class="tool-summary">{{ tool.inputSummary }}</span>
      <span class="tool-chevron" :class="{ open }">&#9662;</span>
    </button>
    <div v-if="open" class="tool-body">
      <div v-if="tool.inputSummary" class="tool-line">
        <span class="tool-line-label">输入</span>
        <span class="mono">{{ tool.inputSummary }}</span>
      </div>
      <div v-if="tool.outputSummary" class="tool-line">
        <span class="tool-line-label">输出</span>
        <span class="mono">{{ tool.outputSummary }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  margin: 8px 0;
  background: var(--bg);
  border-radius: var(--radius-sm);
  overflow: hidden;
  max-width: 640px;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 8px 12px;
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.tool-head:hover {
  background: rgba(0, 0, 0, 0.03);
}

.tool-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.is-success .tool-dot {
  background: var(--ok);
}

.is-error .tool-dot {
  background: var(--danger);
}

.tool-name {
  font-weight: 600;
  font-size: 13px;
  flex: none;
}

.tool-state {
  font-size: 12px;
  color: var(--text-2);
  flex: none;
}

.tool-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 12px;
}

.tool-chevron {
  flex: none;
  color: var(--muted);
  font-size: 11px;
  transition: transform 0.15s ease;
}

.tool-chevron.open {
  transform: rotate(180deg);
}

.tool-body {
  padding: 0 12px 10px;
  display: grid;
  gap: 6px;
}

.tool-line {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.tool-line-label {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
  padding-top: 1px;
}

.tool-line .mono {
  min-width: 0;
}
</style>
