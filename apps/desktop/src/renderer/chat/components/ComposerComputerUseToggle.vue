<script setup lang="ts">
/**
 * 输入框「操作电脑」授权开关（v39，docs/06 §28）。
 *
 * Agent 不能主动开启 Computer Use：只有用户在这里确认后，主进程才为当前会话建立授权。
 * 功能总开关在设置页，且当前模型必须支持图片输入；两个前提不满足时本组件根本不渲染
 * （由 chat/App.vue 的 `computerUseEligible` 决定）。
 */
import { computed } from 'vue'
import { ChevronDown, MousePointer2 } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'

const props = defineProps<{
  /** 功能全局已启用且当前模型支持图片输入、非只读档 */
  eligible: boolean
  /** 当前会话是否持有授权 */
  active: boolean
  /** 另一个会话正在使用 */
  busy: boolean
  open: boolean
  disabled?: boolean
  /** 主进程拒绝原因（启动失败时显示） */
  error?: string | null
}>()

const emit = defineEmits<{
  start: []
  stop: []
  'update:open': [open: boolean]
}>()

const label = computed(() => (props.active ? '操作中' : '操作电脑'))

function toggle(): void {
  if (props.disabled === true) return
  emit('update:open', !props.open)
}

function start(): void {
  emit('update:open', false)
  emit('start')
}

function stop(): void {
  emit('update:open', false)
  emit('stop')
}
</script>

<template>
  <div v-if="eligible" class="cu-toggle">
    <button
      type="button"
      class="cu-trigger"
      :class="{ active, busy }"
      data-field="chat.computer-use"
      :title="
        active ? 'Computer Use 正在操作；点击停止或查看' : '让 Agent 操作电脑（需先在此授权）'
      "
      :aria-expanded="open"
      @click="toggle"
    >
      <MousePointer2 :size="13" :stroke-width="1.8" aria-hidden="true" />
      <span class="cu-label">{{ label }}</span>
      <ChevronDown class="cu-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>

    <Transition name="pop">
      <div
        v-if="open"
        class="cu-menu glass-panel composer-flyout"
        data-field="chat.computer-use-menu"
      >
        <p class="cu-menu-title">Computer Use</p>
        <p class="cu-menu-desc">
          截取屏幕并操控鼠标键盘。仅当前会话有效；用户手动操作不会中断任务。
        </p>
        <p v-if="busy && !active" class="cu-menu-note warn">另一会话正在操作，请先停止。</p>
        <p v-if="error" class="cu-menu-note error">{{ error }}</p>
        <div class="cu-menu-actions">
          <AppButton v-if="active" size="sm" data-field="chat.computer-use-stop" @click="stop">
            停止操作
          </AppButton>
          <AppButton
            v-else
            size="sm"
            variant="primary"
            data-field="chat.computer-use-start"
            :disabled="busy || disabled"
            @click="start"
          >
            开始操作
          </AppButton>
        </div>
        <p class="cu-menu-foot tiny muted">按 Ctrl+Alt+Shift+Esc 也可停止</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.cu-toggle {
  position: static;
}

.cu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.cu-trigger:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.cu-trigger.active {
  color: var(--aurora-blue);
  border-color: color-mix(in srgb, var(--aurora-blue) 44%, transparent);
  background: color-mix(in srgb, var(--aurora-blue) 12%, transparent);
}

.cu-trigger.busy {
  color: var(--text-muted);
}

.cu-label {
  white-space: nowrap;
}

.cu-chevron {
  opacity: 0.7;
}

.cu-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 288px;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  z-index: var(--z-flyout);
}

.cu-menu-title {
  margin: 0;
  font-weight: var(--weight-semibold);
  font-size: var(--text-sm);
}

.cu-menu-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
}

.cu-menu-note {
  margin: 0;
  font-size: var(--text-xs);
}

.cu-menu-note.warn {
  color: var(--status-unread);
}

.cu-menu-note.error {
  color: var(--status-error);
}

.cu-menu-actions {
  display: flex;
  justify-content: flex-end;
}

.cu-menu-foot {
  margin: 0;
}
</style>
