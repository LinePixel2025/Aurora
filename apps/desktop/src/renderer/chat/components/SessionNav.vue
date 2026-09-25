<script setup lang="ts">
/**
 * 主界面左栏（2026-09 重构，docs/07 §2.3）：品牌行 → 新对话 → 固定项（快速对话 / 子代理）
 * → 会话列表 → 底部（模式徽章 / 右栏开关 / 设置齿轮）。
 *
 * 面板内的快速对话入口在**桌面提示条**（悬停展开的面板，docs/07 §2.2）；
 * 主界面左栏的固定项沿用「点击切换主区内容」口径：快速对话切到 `quick` 会话，
 * 子代理切到主区的「子代理」页面（`view` 由 App.vue 持有）。
 *
 * 会话列表项是单行设计（标题 + 相对时间），去掉旧的「· N 条」统计——
 * 列表要扫读的是「哪段对话、什么时候」，条数是噪音。
 *
 * 本组件只负责展示与上报意图（emit），会话切换 / 建会话 / 开窗口都由 App.vue 落地；
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §5.3），不可改名。
 */
import { computed } from 'vue'
import type { ChatSessionSummary } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import { useWindowDrag } from '../../shared/composables/useWindowDrag.js'
import { useModeStore } from '../../shared/stores.js'
import { Bot, PanelRight, Settings, Sparkles, SquarePen, Zap } from '../../shared/icons.js'

const props = defineProps<{
  /** 会话列表（普通会话；quick 由上方固定项的面板承载） */
  sessions: ChatSessionSummary[]
  /** 当前会话 id（激活态判定） */
  activeId: string
  /** 右栏是否展开（开关图标的方向 / 激活态） */
  rightOpen: boolean
  /** 主区正在展示的内容：对话流 / 子代理页面（2026-09 新增，docs/07 §2.4） */
  view: 'chat' | 'subagents'
  /** 本会话已记录的子代理运行数（固定项上的角标） */
  subagentCount: number
  /** 其中是否还有在跑的（角标用 running 色） */
  subagentRunning: boolean
}>()

const emit = defineEmits<{
  (event: 'newSession'): void
  (event: 'select', id: string): void
  (event: 'openSubagents'): void
  (event: 'toggleRightPanel'): void
  (event: 'openSettings'): void
}>()

const modeStore = useModeStore()
const { dragClass } = useWindowDrag('chat')

const modeName = computed(() => modeStore.current?.displayName ?? '未激活')

/** 相对时间：刚刚 / N 分钟前 / 当天时刻 / 昨天 / 月-日（会话摘要来自 ISO 时间戳） */
function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now.getTime() - 24 * 60 * minute)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
</script>

<template>
  <div class="nav-inner">
    <!-- 品牌行：拖动区（窗口 frame:false）；区内按钮由全局规则自动 no-drag -->
    <div class="brand" :class="dragClass">
      <span class="brand-mark" aria-hidden="true">
        <Sparkles :size="13" :stroke-width="1.6" />
      </span>
      <strong class="brand-name">Aurora</strong>
    </div>

    <div class="new-session">
      <!-- capture 探针锚点（契约）：data-action="chat.new-session" -->
      <AppButton
        variant="primary"
        size="sm"
        block
        data-action="chat.new-session"
        @click="emit('newSession')"
      >
        <SquarePen class="icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        新对话
      </AppButton>
    </div>

    <!-- 固定顶置项：快速会话（sessionId = 'quick'；桌面提示条面板里可直接对话） -->
    <button
      type="button"
      class="quick-item hover-fill press"
      data-field="chat.quick-item"
      :class="{ active: props.view === 'chat' && activeId === 'quick' }"
      @click="emit('select', 'quick')"
    >
      <Zap class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
      <span class="item-title">快速对话</span>
    </button>

    <!--
      固定顶置项：子代理（2026-09 新增，docs/07 §2.4）。
      主区切到子代理页面 —— 它不是会话（不能切换 sessionId），因此走独立的 view 状态。
      角标显示本会话记录到的运行数；有在跑的用 running 色 + 呼吸，一眼看出后台在干活。
    -->
    <button
      type="button"
      class="quick-item hover-fill press"
      data-field="chat.subagent-item"
      :class="{ active: props.view === 'subagents' }"
      @click="emit('openSubagents')"
    >
      <Bot class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
      <span class="item-title">子代理</span>
      <span
        v-if="props.subagentCount > 0"
        class="count-badge tiny"
        :class="{ running: props.subagentRunning }"
        data-field="chat.subagent-count"
        >{{ props.subagentCount }}</span
      >
    </button>

    <nav class="nav-scroll">
      <p class="nav-caption tiny muted">会话</p>
      <p v-if="props.sessions.length === 0" class="tiny muted nav-empty">还没有会话</p>

      <!-- capture 探针锚点（契约）：data-field="chat.session-list" 挂在滚动容器上 -->
      <div class="session-list" data-field="chat.session-list">
        <button
          v-for="item in props.sessions"
          :key="item.id"
          type="button"
          class="nav-item hover-fill press"
          :class="{ active: item.id === activeId }"
          :title="item.title"
          @click="emit('select', item.id)"
        >
          <span class="item-title">{{ item.title.trim() === '' ? '新会话' : item.title }}</span>
          <span class="item-time tiny muted">{{ formatRelativeTime(item.updatedAt) }}</span>
        </button>
      </div>
    </nav>

    <footer class="nav-foot">
      <span class="badge" :title="`当前模式：${modeName}`">{{ modeName }}</span>
      <span class="grow" />
      <!-- 右栏开关：capture 探针锚点（契约）data-field="chat.right-panel-toggle" -->
      <button
        type="button"
        class="icon-btn press"
        data-field="chat.right-panel-toggle"
        :class="{ active: rightOpen }"
        :title="rightOpen ? '收起右栏' : '展开右栏'"
        @click="emit('toggleRightPanel')"
      >
        <PanelRight :size="15" :stroke-width="1.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="icon-btn press"
        title="设置"
        aria-label="设置"
        @click="emit('openSettings')"
      >
        <Settings :size="15" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </footer>
  </div>
</template>

<style scoped>
/* 固定 240px：外层 aside 折叠时宽度收 0，这里保持内容不被压缩换行 */
.nav-inner {
  display: flex;
  flex-direction: column;
  width: 240px;
  height: 100%;
  padding: var(--space-3);
  gap: var(--space-2);
}

/* ── 品牌行 ── */
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-1);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  background: var(--aurora-gradient);
  box-shadow: var(--shadow-hairline);
}

/* 单色 mark：强调色底 + 白色光芒线，BetaV2 禁用双色品牌渐变 */
.brand-mark svg {
  flex: 0 0 auto;
  stroke: var(--on-accent);
}

.brand-name {
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.new-session {
  flex: 0 0 auto;
}

/* 按钮里的图标：lucide 自带 width/height 属性，这里只保证不被 flex 压缩 */
.new-session :deep(svg.icon) {
  flex: none;
}

/* ── 固定项（快速对话 / 子代理）：单行图标 + 文案 ── */
.quick-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2) 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  text-align: left;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.quick-item .icon {
  flex: 0 0 auto;
  stroke: currentColor;
}

.quick-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 子代理运行数角标：有在跑的用 running 色并呼吸，否则中性灰 */
.count-badge {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  color: var(--text-muted);
  text-align: center;
  font-variant-numeric: var(--num-tabular);
}

.count-badge.running {
  background: color-mix(in srgb, var(--aurora-blue) 22%, transparent);
  color: var(--accent-text);
  animation: aurora-confirm var(--dur-base) var(--ease-spring) both;
}

/* ── 会话滚动区 ── */
.nav-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding-right: 2px;
}

.nav-caption {
  margin: var(--space-2) 0 2px;
  padding: 0 var(--space-2);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

.nav-empty {
  margin: var(--space-1) 0 0;
  padding: 0 var(--space-2);
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── 列表项：单行（标题省略 + 时间右对齐）；激活态保留强调色指示条 ── */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2) 6px var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
}

.nav-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 当前项：左侧 3px 强调色指示条 */
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 55%;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
}

.item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-time {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

/* ── 底部：模式徽章 + 右栏开关 + 设置齿轮 ── */
.nav-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.icon-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.icon-btn.active {
  color: var(--aurora-blue);
  background: var(--fill-2);
}

.icon-btn svg {
  flex: 0 0 auto;
  stroke: currentColor;
}
</style>
