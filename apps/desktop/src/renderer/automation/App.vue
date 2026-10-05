<script setup lang="ts">
/** 自动化详情窗口壳（docs/07 §2.2.1）：历史 / 编辑器二选一。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AutomationWindowRequest } from '@aurora/shared'
import WindowCaption from '../shared/components/WindowCaption.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { useWindowStore } from '../shared/stores.js'
import AutomationEditorView from './components/AutomationEditorView.vue'
import AutomationHistoryView from './components/AutomationHistoryView.vue'

const windowStore = useWindowStore()
const { dragClass } = useWindowDrag('automation')
const request = ref<AutomationWindowRequest | null>(null)
let offRequest: (() => void) | null = null

const title = computed(() => {
  if (request.value === null) return '自动化'
  return request.value.view === 'history' ? '运行历史' : '编辑自动化'
})

function close(): void {
  request.value = null
  void windowStore.hide('automation')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && request.value?.view === 'editor') close()
}

onMounted(() => {
  offRequest = window.aurora.automation.onWindowRequest((next) => {
    request.value = next
  })
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  offRequest?.()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="automation-window anim-window">
    <header class="titlebar-drag" :class="dragClass">
      <strong class="window-title">{{ title }}</strong>
      <WindowCaption window="automation" class="window-caption" />
    </header>
    <main class="window-body anim-pane">
      <p v-if="request === null" class="empty">请从主界面的自动化页面打开编辑器或历史。</p>
      <AutomationEditorView
        v-else-if="request.view === 'editor'"
        :key="request.requestId"
        :mode="request.mode"
        :automation-id="request.automationId"
        @close="close"
      />
      <AutomationHistoryView v-else :key="request.requestId" :mode="request.mode" @close="close" />
    </main>
  </div>
</template>

<style scoped>
.automation-window {
  display: grid;
  grid-template-rows: 42px minmax(0, 1fr);
  height: 100vh;
  min-width: 0;
  color: var(--text-primary);
  background: var(--glass-content);
}

.titlebar-drag {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 42px;
  padding-left: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--glass-bar);
}

.window-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}

.window-caption {
  position: absolute;
  top: 0;
  right: 0;
  height: 42px;
}

.window-body {
  min-width: 0;
  min-height: 0;
}

.empty {
  padding: var(--space-6);
  color: var(--text-muted);
  text-align: center;
}
</style>
