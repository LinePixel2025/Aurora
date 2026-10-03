<script setup lang="ts">
/**
 * 右栏空标签态的工具快捷入口（docs/07 §2.3）。
 *
 * 右栏标签全部关闭后，标签条仍保留「＋」，但正文区是空的；这里把四种面板的
 * 重开入口直接放在右栏正文区，避免用户再走「＋ → 菜单 → 选种类」两步。
 * `chat.tool-shortcuts` / `chat.tool-open-<kind>` 是 capture 探针契约，不可改名。
 */
import type { Component } from 'vue'
import { FileText, Globe, LayoutGrid, Terminal } from '@aurora/shared/browser'
import type { CtxTabKind } from '../composables/ctxTabsCore'

const emit = defineEmits<{
  (event: 'open', kind: CtxTabKind): void
}>()

const TOOL_SHORTCUTS = [
  { kind: 'context', label: '上下文', icon: LayoutGrid },
  { kind: 'files', label: '文件', icon: FileText },
  { kind: 'terminal', label: '终端', icon: Terminal },
  { kind: 'browser', label: '浏览器', icon: Globe },
] as const satisfies readonly { kind: CtxTabKind; label: string; icon: Component }[]
</script>

<template>
  <section class="tool-shortcuts" data-field="chat.tool-shortcuts">
    <h3 class="group-caption">工具</h3>
    <div class="tool-grid">
      <button
        v-for="item in TOOL_SHORTCUTS"
        :key="item.kind"
        type="button"
        class="tool-card press"
        :data-action="`chat.tool-open-${item.kind}`"
        @click="emit('open', item.kind)"
      >
        <component :is="item.icon" class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
        <span class="item-title">{{ item.label }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/*
 * 右栏正文区的空态：占据右栏正文窗格并允许窄高窗口纵向滚动。
 * 卡片保持两列，宽度上限收窄后居中，避免 384px 缺省宽下卡片被拉得过散。
 */
.tool-shortcuts {
  grid-area: 1 / 1;
  align-self: start;
  justify-self: center;
  width: 100%;
  max-width: 320px;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-3);
}

.group-caption {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  padding: 0 var(--space-2) 0 calc(var(--space-2) + 7px);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  letter-spacing: 0.01em;
  text-transform: none;
}

/* 与左栏分区标题同一套 3px 强调条，明确这里是右栏正文的入口组。 */
.group-caption::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 13px;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
  opacity: 0.85;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1);
}

.tool-card {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.tool-card:hover {
  background: var(--fill-2);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.tool-card .icon {
  flex: 0 0 auto;
  stroke: currentColor;
}

.tool-card .item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
