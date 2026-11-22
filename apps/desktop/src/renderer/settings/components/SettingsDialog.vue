<script setup lang="ts">
/**
 * 设置页通用模态弹窗壳（2026-11 前端重构）。
 *
 * 添加模型 / 添加 MCP 服务器等「填写一条新配置」的流程统一走弹窗：页内不再展开表单，
 * 弹窗只负责外壳（遮罩、标题、滚动正文、底部动作），表单内容由调用方通过插槽提供。
 *
 * 交互口径与 `SubagentCreateDialog.vue` 一致：Esc / 点遮罩 / 关闭按钮都会关闭且不保存；
 * `busy`（提交中）不允许关闭，避免「看着没反应又重复点」。打开后聚焦第一个可输入控件。
 */
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { X } from '@aurora/shared/browser'

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** 弹窗根锚点（截图探针按它定位） */
    anchor: string
    /** 父级正在保存（禁用关闭 / 提交，防重复） */
    busy?: boolean
    /** 卡片宽度（px） */
    width?: number
  }>(),
  { subtitle: '', busy: false, width: 720 },
)

const emit = defineEmits<{ (event: 'close'): void }>()

const card = ref<HTMLElement | null>(null)
const titleId = `settings-dialog-${Math.random().toString(36).slice(2, 10)}`

function close(): void {
  if (props.busy) return
  emit('close')
}

/** Esc 关闭：挂 window 而不是容器 keydown —— 焦点可能在任意字段里 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => {
    const first = card.value?.querySelector<HTMLElement>('input, select, textarea')
    first?.focus()
  })
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="dialog-overlay" @click.self="close">
      <section
        ref="card"
        class="dialog-card"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :data-field="props.anchor"
        :style="{ width: `min(${props.width}px, 100%)` }"
      >
        <header class="dialog-head">
          <span v-if="$slots.icon" class="dialog-mark" aria-hidden="true">
            <slot name="icon" />
          </span>
          <div class="dialog-titles">
            <h2 :id="titleId" class="dialog-title">{{ props.title }}</h2>
            <p v-if="props.subtitle" class="dialog-sub">{{ props.subtitle }}</p>
          </div>
          <button
            type="button"
            class="icon-btn"
            aria-label="关闭"
            :disabled="props.busy"
            @click="close"
          >
            <X :size="15" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </header>

        <div class="dialog-body">
          <slot />
        </div>

        <footer class="dialog-foot">
          <slot name="footer" />
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩与卡片：设置窗内的模态层（z-popover，低于 --z-toast：页级 Toast 仍在最上面） */
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, #000 46%, transparent);
  backdrop-filter: blur(2px);
}

.dialog-card {
  display: flex;
  flex-direction: column;
  max-height: min(86vh, 760px);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border-strong);
  background: var(--bg-raised);
  box-shadow: var(--shadow-2);
  overflow: hidden;
  animation: dialog-rise var(--dur-base) var(--ease-spring) both;
}

@keyframes dialog-rise {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dialog-card {
    animation: none;
  }
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.dialog-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  color: var(--on-accent);
  box-shadow: var(--shadow-hairline);
}

.dialog-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.dialog-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}

.dialog-sub {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.icon-btn {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover:not(:disabled) {
  background: var(--fill-1);
  color: var(--text-primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  overflow-y: auto;
  min-height: 0;
}

.dialog-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  background: var(--fill-1);
}
</style>
