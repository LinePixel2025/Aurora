<script setup lang="ts">
/**
 * 右侧提示条（docs/07 §2.2）：贴屏幕右缘的 8px 竖条。
 *
 * 行为契约：
 * - 悬停 → 主进程把窗口加宽到 228px（`window:setEdgeBarExpanded`），面板滑入；
 *   移开鼠标 → 面板淡出后再把窗口收回 8px（否则屏幕右侧会留一块看不见却挡鼠标的区域）；
 * - 点击竖条 → 呼出完整交互窗（`window:showChat`）；展开态下竖条仍是有效点击目标；
 * - 面板含：AI 状态灯、当前模式、最近消息预览、系统状态、打开对话 / 设置 / 小窗对话 / 隐藏。
 *
 * 视觉重构（Apple 风格令牌与动效）在 step-05，这里只保证行为正确。
 */
import { computed, onUnmounted, ref } from 'vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import {
  useModeStore,
  usePerceptionStore,
  useSettingsStore,
  useWindowStore,
} from '../shared/stores.js'

/** 悬停多久才展开：太短会被鼠标划过边缘误触发，太长显得迟钝 */
const EXPAND_DELAY_MS = 120
/** 移开多久才收起：给用户从竖条移到面板的容错时间 */
const COLLAPSE_DELAY_MS = 220
/** 面板退出动画时长，与 theme.css 的 --transition-base 对齐；收窗口必须晚于它，否则面板被裁掉 */
const PANEL_EXIT_MS = 220

const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const perception = usePerceptionStore()
const chat = useChat('mini-chat')
const { statusTone } = chat

const expanded = ref(false)
let expandTimer: ReturnType<typeof setTimeout> | undefined
let collapseTimer: ReturnType<typeof setTimeout> | undefined
let shrinkTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers(): void {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  clearTimeout(shrinkTimer)
  expandTimer = undefined
  collapseTimer = undefined
  shrinkTimer = undefined
}

/** 悬停进入：窗口先加宽，面板后出现 —— 反过来的话面板会先被 8px 窗口裁掉再跳出来 */
function onPointerEnter(): void {
  clearTimeout(collapseTimer)
  clearTimeout(shrinkTimer)
  collapseTimer = undefined
  shrinkTimer = undefined
  if (expanded.value) return
  expandTimer = setTimeout(() => {
    expandTimer = undefined
    void (async () => {
      await windowStore.setEdgeBarExpanded(true)
      expanded.value = true
    })()
  }, EXPAND_DELAY_MS)
}

/** 移开鼠标：面板先淡出，动画结束后再把窗口收回竖条 */
function onPointerLeave(): void {
  clearTimeout(expandTimer)
  expandTimer = undefined
  clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    collapseTimer = undefined
    expanded.value = false
    clearTimeout(shrinkTimer)
    shrinkTimer = setTimeout(() => {
      shrinkTimer = undefined
      void windowStore.setEdgeBarExpanded(false)
    }, PANEL_EXIT_MS)
  }, COLLAPSE_DELAY_MS)
}

/** 面板内的操作：立即收起（用户已经明确做了选择，不需要动画缓冲） */
function collapseNow(): void {
  clearTimers()
  expanded.value = false
  void windowStore.setEdgeBarExpanded(false)
}

const recent = computed(() => {
  const last = chat.lastAssistant.value
  if (!last) return '还没有消息：点「小窗对话」开始'
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
  collapseNow()
  await windowStore.showChat()
}

async function openMiniChat(): Promise<void> {
  collapseNow()
  await windowStore.showMiniChat()
}

async function openSettings(): Promise<void> {
  collapseNow()
  await windowStore.show('settings')
}

async function hideSelf(): Promise<void> {
  collapseNow()
  await windowStore.hide('edge-bar')
}

onUnmounted(clearTimers)
</script>

<template>
  <div class="edge" :class="{ expanded }" @mouseenter="onPointerEnter" @mouseleave="onPointerLeave">
    <button class="strip" type="button" title="打开 Aurora 对话" @click="openChat">
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
          <button type="button" @click="openMiniChat">小窗对话</button>
          <button type="button" @click="openSettings">设置</button>
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
  /* 窗口宽度就是内容宽度（收起 8 / 展开 228），不需要裁剪；保留 hidden 只为兜住圆角溢出 */
  overflow: hidden;
}

.strip {
  flex: 0 0 8px;
  width: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  background: linear-gradient(180deg, rgba(56, 209, 150, 0.5), rgba(86, 132, 255, 0.5));
  border-radius: 4px 0 0 4px;
  transition: background var(--transition-fast);
}

.strip:hover {
  background: linear-gradient(180deg, rgba(56, 209, 150, 0.75), rgba(86, 132, 255, 0.75));
}

.strip-label {
  writing-mode: vertical-rl;
  font-size: 10px;
  letter-spacing: 2px;
  color: rgba(8, 19, 26, 0.85);
  font-weight: 600;
}

/**
 * 面板宽度预算 220px = 窗口展开宽度 228px（EDGE_BAR_WIDTHS.expanded）- 8px 竖条。
 * 超过这个宽度会被窗口裁掉，所以不要再加宽。
 */
.panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 220px;
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
