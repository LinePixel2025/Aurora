<script setup lang="ts">
/**
 * 主界面左栏（2026-09 重构，docs/07 §2.3）：品牌行 → 新对话 → 固定项（快速对话 / 子代理）
 * → 会话列表 →「已归档 · N」分组 → 底部（模式徽章 / 右栏开关 / 设置齿轮）。
 *
 * 面板内的快速对话入口在**桌面提示条**（悬停展开的面板，docs/07 §2.2）；
 * 主界面左栏的固定项沿用「点击切换主区内容」口径：快速对话切到 `quick` 会话，
 * 子代理切到主区的「子代理」页面（`view` 由 App.vue 持有）。
 *
 * 会话列表项是单行设计（标题 + 相对时间），去掉旧的「· N 条」统计——
 * 列表要扫读的是「哪段对话、什么时候」，条数是噪音。
 *
 * 会话归档（2026-09 新增，docs/07 §2.3）：会话项 hover 时右侧浮出「归档」图标钮
 * （可逆、不弹确认），归档后的会话从主列表移入下方「已归档 · N」分组（默认收起、仍可点开继续对话）。
 * 分组**由 App.vue 按 `archived` 判定后分两份传入**，本组件不做过滤，只负责展开态。
 *
 * 本组件只负责展示与上报意图（emit），会话切换 / 建会话 / 开窗口 / 归档都由 App.vue 落地；
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §5.3），不可改名。
 */
import { computed, ref } from 'vue'
import type { ChatSessionSummary } from '@aurora/shared'
import { CENTER_SESSION_PREFIX } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import { useWindowDrag } from '../../shared/composables/useWindowDrag.js'
import { useModeStore } from '../../shared/stores.js'
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronRight,
  PanelRight,
  Settings,
  Sparkles,
  SquarePen,
  Workflow,
  Zap,
} from '../../shared/icons.js'

const props = defineProps<{
  /** 会话列表（未归档的普通会话；quick 由上方固定项的面板承载） */
  sessions: ChatSessionSummary[]
  /** 已归档会话（同一 updatedAt 倒序；空数组时整个归档分组不渲染） */
  archivedSessions: ChatSessionSummary[]
  /** 当前会话 id（激活态判定） */
  activeId: string
  /** 右栏是否展开（开关图标的方向 / 激活态） */
  rightOpen: boolean
  /** 主区正在展示的内容：对话流 / 子代理页面 / 自动化页面（docs/13 §11） */
  view: 'chat' | 'subagents' | 'automations'
  /** 本会话已记录的子代理运行数（固定项上的角标） */
  subagentCount: number
  /** 其中是否还有在跑的（角标用 running 色） */
  subagentRunning: boolean
}>()

const emit = defineEmits<{
  (event: 'newSession'): void
  (event: 'select', id: string): void
  /** 归档 / 取消归档（`archived` 即目标状态；由 App.vue 调 useChat.setArchived 落地） */
  (event: 'archiveSession', id: string, archived: boolean): void
  (event: 'openSubagents'): void
  /** 切到自动化页面（docs/13 §11） */
  (event: 'openAutomations'): void
  (event: 'toggleRightPanel'): void
  (event: 'openSettings'): void
}>()

const modeStore = useModeStore()
const { dragClass } = useWindowDrag('chat')

/** 归档分组展开态（组件内状态，默认收起；docs/07 §2.3 口径） */
const archiveOpen = ref(false)

const modeName = computed(() => modeStore.current?.displayName ?? '未激活')

/** 远程会话（center-*，docs/12 §5）：列表项上加一枚「Center」小标签区分来源 */
function isCenterSession(id: string): boolean {
  return id.startsWith(CENTER_SESSION_PREFIX)
}

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
      固定顶置项：子代理（2026-09 新增，docs/07 §2.3）。
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

    <!--
      固定顶置项：自动化（docs/13 §11）。主区切到自动化页面（Agent / Normal 双 tab +
      编辑器与历史弹窗都在组件内）。触发器/操作组件的语义见 docs/13 §4/§5。
    -->
    <button
      type="button"
      class="quick-item hover-fill press"
      data-field="chat.auto-item"
      :class="{ active: props.view === 'automations' }"
      @click="emit('openAutomations')"
    >
      <Workflow class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
      <span class="item-title">自动化</span>
    </button>

    <nav class="nav-scroll">
      <p class="nav-caption tiny muted">会话</p>
      <!--
        空态只在**两份列表都空**时出现：全部会话都被归档时主列表是空的、但归档分组还在，
        此时再说「还没有会话」会与下面看得见的归档项自相矛盾。
      -->
      <p
        v-if="props.sessions.length === 0 && props.archivedSessions.length === 0"
        class="tiny muted nav-empty"
      >
        还没有会话
      </p>

      <!-- capture 探针锚点（契约）：data-field="chat.session-list" 挂在滚动容器上 -->
      <div class="session-list" data-field="chat.session-list">
        <!--
          会话项 + hover 归档钮是**同一行里的两个兄弟 button**（不嵌套）：
          `.nav-item` 仍是会话选择按钮本身（类名与既有语义不动），右侧 `.row-action` 只负责归档。
          行的 hover 底色挂在外层 `.nav-row`（`.hover-fill`）上——按钮是兄弟而不是子元素，
          挂在 `.nav-item` 上的话鼠标移到归档钮上时行底色会闪掉。
        -->
        <div
          v-for="item in props.sessions"
          :key="item.id"
          class="nav-row hover-fill"
          :class="{ active: item.id === activeId }"
        >
          <button
            type="button"
            class="nav-item press"
            :class="{ active: item.id === activeId }"
            :title="item.title"
            @click="emit('select', item.id)"
          >
            <span class="item-title">{{ item.title.trim() === '' ? '新会话' : item.title }}</span>
            <span
              v-if="isCenterSession(item.id)"
              class="item-tag tiny"
              title="来自 Aurora Center 网页端"
              >Center</span
            >
            <span class="item-time tiny muted">{{ formatRelativeTime(item.updatedAt) }}</span>
          </button>
          <!--
            归档（可逆、不弹确认，docs/07 §2.3）：单击即归档。
            `@click.stop` 是防御性的——两者已是兄弟按钮，但将来若有人把行包进可点容器，
            少了它就会「顺手把会话也切了」。
          -->
          <button
            type="button"
            class="row-action press"
            data-action="chat.archive-session"
            title="归档"
            aria-label="归档"
            @click.stop="emit('archiveSession', item.id, true)"
          >
            <Archive :size="13" :stroke-width="1.6" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!--
        归档分组（docs/07 §2.3）：会话列表之后、默认收起；`archivedSessions` 为空时整组不渲染（不占位）。
        归档项的视觉与普通会话项**完全一致**（同一套 .nav-row / .nav-item），
        只是列表容器换成 chat.archive-list、按钮换成「取消归档」；点会话项照常打开继续对话。
      -->
      <section
        v-if="props.archivedSessions.length > 0"
        class="archive"
        data-field="chat.archive-group"
      >
        <button
          type="button"
          class="archive-toggle hover-fill press"
          data-field="chat.archive-toggle"
          :aria-expanded="archiveOpen"
          :title="archiveOpen ? '收起已归档会话' : '展开已归档会话'"
          @click="archiveOpen = !archiveOpen"
        >
          <ChevronRight
            class="caret"
            :class="{ open: archiveOpen }"
            :size="13"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span class="item-title">已归档 · {{ props.archivedSessions.length }}</span>
        </button>

        <div v-if="archiveOpen" class="session-list" data-field="chat.archive-list">
          <div
            v-for="item in props.archivedSessions"
            :key="item.id"
            class="nav-row hover-fill"
            :class="{ active: item.id === activeId }"
          >
            <button
              type="button"
              class="nav-item press"
              :class="{ active: item.id === activeId }"
              :title="item.title"
              @click="emit('select', item.id)"
            >
              <span class="item-title">{{ item.title.trim() === '' ? '新会话' : item.title }}</span>
              <span
                v-if="isCenterSession(item.id)"
                class="item-tag tiny"
                title="来自 Aurora Center 网页端"
                >Center</span
              >
              <span class="item-time tiny muted">{{ formatRelativeTime(item.updatedAt) }}</span>
            </button>
            <button
              type="button"
              class="row-action press"
              data-action="chat.unarchive-session"
              title="取消归档"
              aria-label="取消归档"
              @click.stop="emit('archiveSession', item.id, false)"
            >
              <ArchiveRestore :size="13" :stroke-width="1.6" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
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
  /* 32px 下限：左栏固定项（快速对话 / 子代理 / 自动化）是高频点击，量出来原来只有 30px
     （`chat-hit-targets` 探针；类名是历史命名，别被 `.quick-item` 误导成"只给快速对话用"） */
  min-height: 32px;
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

/**
 * 行容器：会话选择按钮 + hover 归档钮的同一行外壳（两个兄弟 button）。
 * hover 底色挂在这一层（`.hover-fill`），鼠标移到归档钮上时行底色不会闪掉。
 */
.nav-row {
  display: flex;
  align-items: center;
  border-radius: var(--radius-sm);
}

.nav-row.active {
  background: var(--fill-2);
}

.nav-item {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  /* 32px：固定项（快速对话 / 子代理 / 自动化）与会话行都是高频点击，
     量出来原来只有 30px（`chat-hit-targets` 探针），补到 32 的手感线 */
  min-height: 32px;
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

/**
 * 行内动作钮（归档 / 取消归档）：hover 行时淡入。
 *
 * 展开态用**固定占位**（width/opacity 过渡）而不是收起时压成 0 宽：宽度变化会让
 * 「标题省略号 + 相对时间」在每次移入移出时抖一下。占位恒定则布局不动，只有透明度变化。
 * 不挂 `pointer-events: none`——保持可命中，探针与键盘都能稳定点到它
 * （鼠标压到它上面时必然已触发行的 :hover，按钮此刻是可见的；键盘 Tab 到它时用
 * `:focus-visible` 同样显形）。
 */
.row-action {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  /* 24×24：WCAG 2.2 SC 2.5.8（AA）的指针目标下限 —— 22px 在鼠标/触控板上就是"点了没反应"
     （2026-09-29 用 `chat-hit-targets` 探针量出来的真实违例，别再压回去） */
  width: 24px;
  height: 24px;
  margin-right: var(--space-1);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  opacity: 0;
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

.row-action svg {
  flex: 0 0 auto;
  stroke: currentColor;
}

.nav-row:hover .row-action,
.nav-row:focus-within .row-action,
.row-action:focus-visible {
  opacity: 1;
}

.row-action:hover {
  background: var(--fill-3);
  color: var(--text-primary);
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

/* 远程会话来源标签（center-*，docs/12 §5）：轻量药丸，弱于激活指示条 */
.item-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  line-height: 16px;
  letter-spacing: 0;
}

/* ── 归档分组：可点击的切换行（默认收起）+ 展开后的列表 ── */
.archive {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 与上方会话列表拉开一点：它是「另一类会话」，不是同一条流里的项 */
  margin-top: var(--space-2);
}

.archive-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  text-align: left;
}

.archive-toggle:hover {
  color: var(--text-secondary);
}

/* 折叠箭头：展开时转 90°（时长走令牌，不写死 ms） */
.archive-toggle .caret {
  flex: 0 0 auto;
  stroke: currentColor;
  transition: transform var(--transition-fast);
}

.archive-toggle .caret.open {
  transform: rotate(90deg);
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
  /* 32px：底部工具行（右栏开关 / 设置）与固定项同级，量出来原来 28px */
  width: 32px;
  height: 32px;
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
