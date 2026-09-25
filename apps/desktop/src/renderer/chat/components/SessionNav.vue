<script setup lang="ts">
/**
 * 主界面左栏（BetaV2，Design/betav2-spec.md §3）：品牌行 → 新对话 → 固定项「快速对话」
 * → 会话列表 → 底部（模式徽章 / 右栏开关 / 设置齿轮）。
 *
 * 旧版「快速 / 会话」双栏 tab 与「继续快速对话」中间态已删除：快速会话就是列表里
 * 的第一个固定项（sessionId = 'quick'），点击直接切换，主区随之水合。
 *
 * 本组件只负责展示与上报意图（emit），会话切换 / 建会话 / 开窗口都由 App.vue 落地；
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §9），不可改名。
 */
import { computed } from 'vue'
import type { ChatSessionSummary } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import { useWindowDrag } from '../../shared/composables/useWindowDrag.js'
import { useModeStore } from '../../shared/stores.js'

const props = defineProps<{
  /** 会话列表（App 已剔除 'quick'，避免与固定项重复） */
  sessions: ChatSessionSummary[]
  /** 当前会话 id（激活态判定） */
  activeId: string
  /** 右栏是否展开（开关图标的方向 / 激活态） */
  rightOpen: boolean
}>()

const emit = defineEmits<{
  (event: 'newSession'): void
  (event: 'select', id: string): void
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
        <svg viewBox="0 0 16 16">
          <path d="M8 2.4v11.2M2.4 8h11.2M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" />
        </svg>
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
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
        新对话
      </AppButton>
    </div>

    <nav class="nav-scroll">
      <!-- 固定顶置项：快速会话（与提示条共用 sessionId='quick'） -->
      <button
        type="button"
        class="nav-item hover-fill press"
        data-field="chat.quick-item"
        :class="{ active: activeId === 'quick' }"
        @click="emit('select', 'quick')"
      >
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8.8 1.8 3.5 9h3.4l-.7 5.2L11.5 7H8.1l.7-5.2Z" />
        </svg>
        <span class="item-title">快速对话</span>
      </button>

      <p class="nav-caption tiny muted">会话</p>
      <p v-if="props.sessions.length === 0" class="tiny muted nav-empty">还没有会话</p>

      <!-- capture 探针锚点（契约）：data-field="chat.session-list" 挂在滚动容器上 -->
      <div class="session-list" data-field="chat.session-list">
        <button
          v-for="item in props.sessions"
          :key="item.id"
          type="button"
          class="nav-item session hover-fill press"
          :class="{ active: item.id === activeId }"
          :title="item.title"
          @click="emit('select', item.id)"
        >
          <span class="item-title">{{ item.title.trim() === '' ? '新会话' : item.title }}</span>
          <span class="item-meta tiny muted">
            {{ formatRelativeTime(item.updatedAt) }} · {{ item.messageCount }} 条
          </span>
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
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="2.8" width="12" height="10.4" rx="2" />
          <path d="M10 2.8v10.4" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn press"
        title="设置"
        aria-label="设置"
        @click="emit('openSettings')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" />
          <path
            d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6"
          />
        </svg>
      </button>
    </footer>
  </div>
</template>

<style scoped>
/* 固定 232px：外层 aside 折叠时宽度收 0，这里保持内容不被压缩换行 */
.nav-inner {
  display: flex;
  flex-direction: column;
  width: 232px;
  height: 100%;
  padding: var(--space-3);
  gap: var(--space-3);
}

/* ── 品牌行 ── */
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
  padding: 0 var(--space-1);
  /* 品牌行高度较薄仍可拖动；拖动条规范高度 ≥32px 由 min-height 保证 */
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
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--on-accent);
  stroke-width: 1.4;
  stroke-linecap: round;
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

/* 按钮里的加号 svg 只有 viewBox、没有固有尺寸（默认 300×150），不钉死会把按钮撑成巨椭圆 */
.new-session :deep(svg.icon) {
  width: 13px;
  height: 13px;
  flex: none;
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

/* ── 列表项：hover-fill 全局类提供底色过渡；激活态加强调色指示条 ── */
.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  padding: 6px var(--space-2) 6px var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
  /* 会话标题可能来自首条用户消息（长 URL 等）：任意位置折行，不撑破 232px 栏 */
  overflow-wrap: anywhere;
}

/* 快速对话是单行项：图标 + 文案横排 */
.nav-item:not(.session) {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
  font-weight: var(--weight-medium);
}

.nav-item .icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-meta {
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
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
