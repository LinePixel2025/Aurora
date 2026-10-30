<script setup lang="ts">
/**
 * Computer Use 实时状态条（v39，docs/06 §28）。
 *
 * 挂在输入卡上方：显示当前动作、步数、已运行时长与停止按钮。
 * 另一会话持有授权时显示「另一会话正在操作」并允许停止（同一时间只有一个会话）。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { CircleStop, MousePointer2 } from '@aurora/shared/browser'
import type { ComputerUseStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'

const props = defineProps<{
  status: ComputerUseStatus | null
  sessionId: string
}>()

const emit = defineEmits<{ stop: [] }>()

const elapsed = ref('0:00')
let timer: ReturnType<typeof setInterval> | undefined

const activeHere = computed(
  () => props.status?.active === true && props.status.sessionId === props.sessionId,
)
const activeOther = computed(
  () => props.status?.active === true && props.status.sessionId !== props.sessionId,
)
const visible = computed(() => activeHere.value || activeOther.value)

const actionText = computed(() => {
  if (props.status?.lastAction === undefined) return '等待下一步…'
  return props.status.lastAction
})

const stepText = computed(() =>
  props.status === null ? '' : `${props.status.actions} / ${props.status.maxActions}`,
)

function tick(): void {
  const started = props.status?.startedAt
  if (started === undefined) {
    elapsed.value = '0:00'
    return
  }
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(started)) / 1000))
  elapsed.value = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

watch(
  () => props.status?.startedAt,
  () => {
    tick()
    if (timer !== undefined) clearInterval(timer)
    timer = visible.value ? setInterval(tick, 1000) : undefined
  },
  { immediate: true },
)

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})
</script>

<template>
  <div v-if="visible" class="cu-status" data-field="chat.computer-use-status">
    <MousePointer2 class="cu-status-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
    <span class="cu-status-title" :class="{ other: activeOther }">
      {{ activeOther ? '另一会话正在操作' : 'Computer Use' }}
    </span>
    <span class="cu-status-action">{{ activeOther ? '切换到该会话可查看进度' : actionText }}</span>
    <span v-if="activeHere" class="cu-status-step">{{ stepText }} 步</span>
    <span class="cu-status-time">{{ elapsed }}</span>
    <AppButton size="sm" data-field="chat.computer-use-stop" @click="emit('stop')">
      <CircleStop :size="13" :stroke-width="1.8" aria-hidden="true" /> 停止
    </AppButton>
  </div>
</template>

<style scoped>
.cu-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 auto var(--space-2);
  max-width: 100%;
  padding: 6px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid color-mix(in srgb, var(--aurora-blue) 34%, var(--border-subtle));
  background: color-mix(in srgb, var(--aurora-blue) 8%, var(--glass-surface-strong, transparent));
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.cu-status-icon {
  flex: 0 0 auto;
  color: var(--aurora-blue);
}

.cu-status-title {
  flex: 0 0 auto;
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}

.cu-status-title.other {
  color: var(--status-unread);
}

.cu-status-action {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cu-status-step,
.cu-status-time {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-variant-numeric: var(--num-tabular);
}
</style>
