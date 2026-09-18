<script setup lang="ts">
/**
 * 右侧提示条（docs/07 §2.2）：贴屏幕右缘的 8px 竖条，悬停 / 点击展开为 200×全高面板。
 * 面板含：AI 状态灯、当前模式、最近消息预览、打开对话 / 设置 / 隐藏 快捷入口。
 */
import { computed, ref } from 'vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import {
  useModeStore,
  usePerceptionStore,
  useSettingsStore,
  useWindowStore,
} from '../shared/stores.js'

const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const perception = usePerceptionStore()
const chat = useChat('mini-chat')
const { statusTone } = chat

const expanded = ref(false)

const recent = computed(() => {
  const last = chat.lastAssistant.value
  if (!last) return '还没有消息：在服务窗输入即可开始'
  return last.content.slice(0, 120) || '思考中…'
})

const statusLabel = computed(() =>
  statusTone.value === 'error'
    ? '异常'
    : statusTone.value === 'running'
      ? '思考中'
      : statusTone.value === 'unread'
        ? '有未读'
        : '闲置',
)

async function openChat(): Promise<void> {
  expanded.value = false
  await windowStore.showChat()
}

async function openSettings(): Promise<void> {
  expanded.value = false
  await windowStore.show('settings')
}

async function hideSelf(): Promise<void> {
  expanded.value = false
  await windowStore.hide('edge-bar')
}
</script>

<template>
  <div
    class="edge"
    :class="{ expanded }"
    @mouseenter="expanded = true"
    @mouseleave="expanded = false"
  >
    <button class="strip" type="button" title="Aurora" @click="openChat">
      <StatusDot :tone="statusTone" :size="10" :title="statusLabel" />
      <span class="strip-label">AURORA</span>
    </button>

    <transition name="panel">
      <aside v-if="expanded" class="panel glass">
        <section class="block">
          <div class="row">
            <StatusDot :tone="statusTone" :title="statusLabel" />
            <strong class="tiny">{{ statusLabel }}</strong>
            <span class="grow" />
            <span class="tiny muted">{{ settingsStore.appInfo?.appVersion ?? '' }}</span>
          </div>
        </section>

        <section class="block">
          <p class="tiny muted">当前模式</p>
          <strong>{{ modeStore.current?.displayName ?? '未激活' }}</strong>
          <p v-if="modeStore.current && !modeStore.current.guideCompleted" class="tiny warn-text">
            引导未完成：点击「打开对话」继续
          </p>
        </section>

        <section class="block">
          <p class="tiny muted">最近消息</p>
          <p class="tiny preview">{{ recent }}</p>
        </section>

        <section v-if="perception.summary" class="block">
          <p class="tiny muted">系统状态</p>
          <p class="tiny">
            {{ perception.summary.localTime }} {{ perception.summary.weekday }}
            <template v-if="perception.summary.battery">
              · {{ perception.summary.battery.percent }}%
            </template>
            <template v-if="perception.summary.network">
              · {{ perception.summary.network.online ? '在线' : '离线' }}
            </template>
          </p>
        </section>

        <section class="actions">
          <button type="button" @click="openChat">打开对话窗口</button>
          <button type="button" @click="openSettings">设置</button>
          <button type="button" @click="windowStore.showMiniChat()">小窗对话</button>
          <button type="button" @click="hideSelf">隐藏提示条</button>
        </section>
      </aside>
    </transition>
  </div>
</template>

<style scoped>
.edge {
  position: relative;
  height: 100vh;
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
  overflow: hidden;
}

.strip {
  width: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  background: linear-gradient(180deg, rgba(56, 209, 150, 0.5), rgba(86, 132, 255, 0.5));
  border-radius: 4px 0 0 4px;
  transition: width var(--transition-base);
}

.edge.expanded .strip {
  width: 0;
}

.strip-label {
  writing-mode: vertical-rl;
  font-size: 10px;
  letter-spacing: 2px;
  color: rgba(8, 19, 26, 0.85);
  font-weight: 600;
}

.panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  overflow-y: auto;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.block p {
  margin: 0;
}

.preview {
  line-height: 1.55;
  color: var(--text-secondary);
}

.warn-text {
  color: #f7c568;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: auto;
}

.actions button {
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.06);
  font-size: 12px;
  text-align: left;
  transition: background var(--transition-fast);
}

.actions button:hover {
  background: rgba(86, 132, 255, 0.18);
}

.panel-enter-active,
.panel-leave-active {
  transition:
    opacity var(--transition-base),
    transform var(--transition-base);
}

.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>
