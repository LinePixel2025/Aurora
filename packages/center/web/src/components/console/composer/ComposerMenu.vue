<script setup lang="ts">
/**
 * 输入卡浮层的**通用壳**（2026-10-18，Center Web）。
 *
 * 三枚工具行浮层（权限 / 模型 / 思考）共用同一份定位与外观：类名 `.composer-flyout`
 * 来自 `@aurora/shared/browser/theme.css`（桌面与 Center Web 唯一来源）——
 * 相对 `.composer-box`（`position: relative`）的 `left` 由 `left` prop 传入（贴触发按钮），
 * 底边贴在整张输入卡上方 6px、走 `--z-flyout`、宽度 `--composer-flyout-width`、
 * `max-width: 100%` 不会移出输入卡。
 *
 * 组件只负责「壳」：Transition + 类名 + `role="menu"` + `data-field`；条目内容由三枚菜单
 * 通过默认插槽给出。条目样式（`.menu-item` 等）用 `:deep()` 写在壳里 —— 插槽内容是父组件
 * 渲染的，作用域属性不在子组件上，`:slotted()` 对带伪类的行状态不可靠，`:deep()` 更直接。
 *
 * **不要在这里另写 z-index / bottom / width 数字**：那套令牌与规则是双端契约，
 * 各端各写一份就会重新出现「浮层遮住工具行」的事故（docs/07 §2.3）。
 */
defineProps<{
  open: boolean
  /** 探针锚点（`chat.permission-menu` / `chat.model-menu` / `chat.effort-menu`） */
  menuField: string
  label: string
  /** 相对 `.composer-box` 的 left（由调用方按触发按钮实测；缺省 0 兼容旧调用） */
  left?: number
}>()

defineEmits<{ close: [] }>()
</script>

<template>
  <!-- 复用它共享的 `rise` 过渡预设（theme.css，两端同名） -->
  <Transition name="rise">
    <div
      v-if="open"
      class="composer-flyout composer-menu"
      :style="{ left: `${left ?? 0}px` }"
      role="menu"
      :aria-label="label"
      :data-field="menuField"
      @keydown.esc="$emit('close')"
    >
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
.composer-menu {
  padding: var(--space-1);
}

/*
 * 关闭**不做**动画（只保留入场）：三层是互斥的，离场动画期间旧菜单仍会画在输入卡上方
 * 250ms，与刚打开的新菜单叠成两层 —— 用户口径的「同一时刻只开一层」会被破坏
 * （verify 的 composer-pickers 探针也会读到两层同时在 DOM 里）。
 */
.composer-menu.rise-leave-active {
  transition: none;
}

/* 浮层内的一行菜单项（权限档 / 模型 / 思考等级共用同一套观感） */
.composer-menu :deep(.menu-item) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.composer-menu :deep(.menu-item:hover:not(:disabled)),
.composer-menu :deep(.menu-item:focus-visible) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.composer-menu :deep(.menu-item[aria-checked='true']) {
  color: var(--accent-text);
}

.composer-menu :deep(.menu-item:disabled) {
  color: var(--text-muted);
  cursor: default;
}

.composer-menu :deep(.menu-item .menu-item-icon) {
  flex: 0 0 auto;
  display: inline-flex;
}

.composer-menu :deep(.menu-item-main) {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.composer-menu :deep(.menu-item-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-menu :deep(.menu-item-sub) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.composer-menu :deep(.menu-check) {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--accent-text);
}

.composer-menu :deep(.menu-section-title) {
  margin: var(--space-1) var(--space-2) 2px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.composer-menu :deep(.menu-note) {
  margin: 2px var(--space-2) 0;
  padding: var(--space-1) 0 var(--space-1);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.composer-menu :deep(.menu-empty) {
  margin: 0;
  padding: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
</style>
