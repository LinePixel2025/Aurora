<script setup lang="ts">
/**
 * 设置窗口（docs/07 §2.5、docs/08 §5/§6）：单窗口分栏多页
 * 通用 / 会话管理 / 模式 / 提醒 / AI 模型 / 语音 / Agent 设置 / 文件自感知 / Aurora Center / 插件 / 系统。
 * （BetaV2 由 8 页合并而来，spec §9；v37 新增「提醒」页 —— 默认提醒方式，docs/07 §4。）
 *
 * 合并去向：TtsPage → voice（与 STT 同页）；SkillsPage / McpPage → agent；
 * AdvancedPage 的勿扰时段 → general。旧深链（`?page=tts|skills|mcp`）经
 * `LEGACY_PAGE_ALIASES` 映射到新页，截图核对工具与新老调用方都不受影响。
 *
 * 本窗无系统标题栏（`frame: false`），拖动能力由 `useWindowDrag('settings')` 统一提供
 * （docs/07 §1）：窗口顶部一条完整的 32px 标题带，滚动内容始终不会盖住它。
 * Windows 式窗口按钮（WindowCaption）挂在**窗口右上角**（`position: fixed`，2026-10 起
 * 从品牌行右移出——Windows 通用布局是三键贴窗口右上缘，不在侧栏里）；
 * 「关闭」= 隐藏窗口，`Esc` 等效；不退出应用，退出只走托盘菜单。
 * 侧栏导航条目为图标 + 单行文字（旧两行说明文案已删，docs/07 §2.5）。
 */
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue'
import AppToast from '../shared/components/AppToast.vue'
import GeneralPage from './pages/GeneralPage.vue'
import SessionsPage from './pages/SessionsPage.vue'
import ModesPage from './pages/ModesPage.vue'
import NotificationsPage from './pages/NotificationsPage.vue'
import LlmPage from './pages/LlmPage.vue'
import VoicePage from './pages/VoicePage.vue'
import AgentPage from './pages/AgentPage.vue'
import CenterPage from './pages/CenterPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import FileAwarenessPage from './pages/FileAwarenessPage.vue'
import PluginsPage from './pages/PluginsPage.vue'
import ComputerUsePage from './pages/ComputerUsePage.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { usePerceptionStore, useSettingsStore, useWindowStore } from '../shared/stores.js'
import {
  Archive,
  AudioLines,
  Bell,
  Blocks,
  Cpu,
  House,
  LayoutGrid,
  FolderSearch,
  MousePointer2,
  MonitorSmartphone,
  Puzzle,
  SettingsGear,
} from '@aurora/shared/browser'

type PageId =
  | 'general'
  | 'sessions'
  | 'modes'
  | 'notifications'
  | 'llm'
  | 'voice'
  | 'agent'
  | 'computer-use'
  | 'awareness'
  | 'center'
  | 'plugins'
  | 'advanced'

interface NavItem {
  id: PageId
  label: string
  /** 侧栏图标（lucide 组件；尺寸与描边由模板统一给，docs/07 §5） */
  icon: Component
}

/** 扁平清单同时是「页面 id → 标签 / 图标」的查表数据（深链校验也用它） */
const nav: NavItem[] = [
  { id: 'general', label: '通用', icon: House },
  { id: 'sessions', label: '会话管理', icon: Archive },
  { id: 'modes', label: '模式', icon: LayoutGrid },
  { id: 'notifications', label: '提醒', icon: Bell },
  { id: 'llm', label: 'AI 模型', icon: Cpu },
  { id: 'voice', label: '语音', icon: AudioLines },
  { id: 'agent', label: 'Agent 设置', icon: Puzzle },
  { id: 'computer-use', label: 'Computer Use', icon: MousePointer2 },
  { id: 'awareness', label: '文件自感知', icon: FolderSearch },
  { id: 'center', label: 'Aurora Center', icon: MonitorSmartphone },
  { id: 'plugins', label: '插件', icon: Blocks },
  { id: 'advanced', label: '系统', icon: SettingsGear },
]

/**
 * 侧栏分组（2026-10-31 收敛为三组）：本机（行为与界面）/ 智能（AI 能力）/ 系统（连接、扩展与运维）。
 *
 * 旧版是「基础 / 智能 / 连接 / 扩展 / 系统」五组 12 项：单个条目也占一行分组标题，
 * 侧栏被切得很碎。连接与扩展各只有一项，合并进「系统」后分组标题从 5 个降到 3 个，
 * 条目顺序不变（截图 / 探针按 DOM 顺序读，标签与原来一致）。
 */
const navGroups: Array<{ title: string; ids: PageId[] }> = [
  { title: '本机', ids: ['general', 'sessions', 'modes', 'notifications'] },
  { title: '智能', ids: ['llm', 'voice', 'agent', 'computer-use', 'awareness'] },
  { title: '系统', ids: ['center', 'plugins', 'advanced'] },
]

/** 分组渲染用：分组标题 + 该组条目（条目与 `nav` 是同一批对象，避免两处维护文案） */
const grouped = computed(() =>
  navGroups.map((group) => ({
    title: group.title,
    items: group.ids
      .map((id) => nav.find((item) => item.id === id))
      .filter((item): item is NavItem => item !== undefined),
  })),
)

/** 页面 id → 组件：`<component :is>` 渲染当前页，配合 `<Transition name="page">` 做切换动画 */
const pages: Record<PageId, Component> = {
  general: GeneralPage,
  sessions: SessionsPage,
  modes: ModesPage,
  notifications: NotificationsPage,
  llm: LlmPage,
  voice: VoicePage,
  agent: AgentPage,
  'computer-use': ComputerUsePage,
  awareness: FileAwarenessPage,
  center: CenterPage,
  plugins: PluginsPage,
  advanced: AdvancedPage,
}

/**
 * 旧版 8 页的深链兼容映射（spec §9）：`?page=tts` 等老链接落到合并后的新页。
 * 只做单向映射；6 个新 id 直接生效，不在表里的值回落「通用」。
 */
const LEGACY_PAGE_ALIASES: Record<string, PageId> = {
  tts: 'voice',
  skills: 'agent',
  mcp: 'agent',
}

/**
 * 初始页面：支持 `?page=<id>` 深链（截图核对工具按页出图，docs/07 §5）。
 * 正常启动不带 query，回落到「通用」；未知值同样回落，避免白屏。
 */
function initialPage(): PageId {
  const requested = new URLSearchParams(window.location.search).get('page')
  if (requested !== null) {
    const aliased = LEGACY_PAGE_ALIASES[requested]
    if (aliased !== undefined) return aliased
    if (nav.some((item) => item.id === requested)) return requested as PageId
  }
  return 'general'
}

const active = ref<PageId>(initialPage())
const settingsStore = useSettingsStore()
const windowStore = useWindowStore()
const perception = usePerceptionStore()
/** 本窗可拖（docs/07 §1 / §2.5）：拖动区见模板里的 `.titlebar-drag` / `.brand`；
 *  WindowCaption 的按钮自带 no-drag（组件内部显式挂类），这里不再需要 noDragClass */
const { dragClass } = useWindowDrag('settings')

const needsOnboarding = computed(() => settingsStore.needsOnboarding)

async function closeSettings(): Promise<void> {
  await windowStore.hide('settings')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') void closeSettings()
}

onMounted(() => {
  void perception.refresh()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

function select(id: PageId): void {
  active.value = id
}
</script>

<template>
  <div class="settings anim-window">
    <div class="titlebar-drag" :class="dragClass">
      <!-- Windows 式窗口按钮：位于窗口标题带右端，按钮自身 no-drag。 -->
      <WindowCaption window="settings" class="window-caption" />
    </div>
    <aside class="sidebar glass-shell rail-surface anim-shell-left">
      <div class="brand" :class="dragClass">
        <div class="brand-text">
          <strong>Aurora</strong>
          <p class="tiny muted">设置</p>
        </div>
      </div>
      <nav>
        <template v-for="group in grouped" :key="group.title">
          <p class="nav-group">{{ group.title }}</p>
          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="nav-item"
            :class="{ active: active === item.id }"
            :aria-current="active === item.id ? 'page' : undefined"
            @click="select(item.id)"
          >
            <component
              :is="item.icon"
              class="nav-icon"
              :size="15"
              :stroke-width="1.6"
              aria-hidden="true"
            />
            <span class="label">{{ item.label }}</span>
          </button>
        </template>
      </nav>
      <div class="foot">
        <p class="tiny muted">
          v{{ settingsStore.appInfo?.appVersion ?? '0.1.0' }} · Electron
          {{ settingsStore.appInfo?.electronVersion ?? '-' }}
        </p>
      </div>
    </aside>

    <main class="content anim-pane">
      <AppToast v-if="needsOnboarding" tone="warn" class="banner">
        尚未完成 AI 模型配置：主功能不可用，请前往「AI 模型」页配置。
      </AppToast>
      <AppToast v-if="!settingsStore.cryptoAvailable" tone="warn" class="banner">
        当前系统未提供安全存储：API Key 只在本次运行的内存中有效。
      </AppToast>

      <!-- 页切换动画（theme.css `page` 预设）：out-in 保证同一时刻只有一页参与布局，不产生双页跳动 -->
      <!--
        这里刻意不用 `name="page" mode="out-in"`：设置页切换必须等旧页 transitionend 才挂新页，
        透明原生窗口一旦漏事件，Aurora Center 等页面会整块不挂载。新页直接挂载，只用一次性
        `.anim-pane` 做入场；页面可用性不依赖旧页动画收尾。
      -->
      <component :is="pages[active]" :key="active" class="anim-pane" />
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 208px 1fr;
  grid-template-rows: 32px minmax(0, 1fr);
  height: 100vh;
  background: transparent;
}

/**
 * 顶部标题带：这是设置窗唯一的窗口拖动入口，始终贴在窗口最上缘且不随内容滚动。
 * `WindowCaption` 自带 no-drag，右侧三枚按钮仍可点击。
 */
.titlebar-drag {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  z-index: 30;
  min-width: 0;
  background: var(--glass-bar);
  border-bottom: 1px solid var(--border-subtle);
}

.window-caption {
  display: flex;
  height: 100%;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-3);
  grid-column: 1;
  grid-row: 2;
}

.brand {
  display: flex;
  align-items: center;
  /* 拖动条高度的下限（探针要求 ≥ 32px）：两行文案本身会把品牌行撑到约 40px */
  min-height: 40px;
  padding: 0 var(--space-2);
}

.brand-text {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: baseline;
  gap: var(--space-2);
}

.brand-text strong {
  display: block;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.brand p {
  margin: 0;
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 分组标题：小字号 + 弱色 + 中文不做大写字距，只承担分层，不与可点条目抢注意力 */
.nav-group {
  margin: var(--space-4) 0 var(--space-1);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

nav > .nav-group:first-child {
  margin-top: 0;
}

/**
 * 侧栏条目：图标 + 单行文字；行高 34px、圆角收一档，条目之间不再各带一段空白。
 * 按下微缩用 `.press` 的 0.97 + `--dur-press`（这里手动展开，为了与背景过渡合并）。
 */
.nav-item {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  padding: 0 var(--space-2) 0 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-align: left;
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform var(--dur-press) var(--ease-standard);
}

/* 16px 描边图标：与主界面头部图标同一套笔触 */
.nav-icon {
  flex: 0 0 auto;
  stroke: currentColor;
  color: var(--text-muted);
  transition: color var(--transition-fast);
}

.nav-item:hover .nav-icon,
.nav-item.active .nav-icon {
  color: var(--aurora-blue);
}

.nav-item:hover {
  background: var(--fill-1);
}

.nav-item:active {
  transform: scale(0.98);
}

/* 当前项：分层填充 + 左侧强调色指示条（不靠纯色块区分，色觉障碍下也可辨） */
.nav-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

.nav-item:focus-visible {
  outline: 1px solid var(--focus-ring);
  outline-offset: 2px;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 9px;
  bottom: 9px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
}

.nav-item .label {
  font-size: var(--text-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.foot {
  margin-top: auto;
  padding: var(--space-2) var(--space-2) 0;
  border-top: 1px solid var(--border-subtle);
}

.foot p {
  margin: 0;
  font-size: var(--text-xs);
  letter-spacing: 0.01em;
}

/**
 * 滚动容器：页面自己不再加内边距（见 settings.css）。
 * 内部的 `.content-drag` 依赖这里的 `display: flex; flex-direction: column` —— 改这两条前先看它。
 */
.content {
  grid-column: 2;
  grid-row: 2;
  overflow-y: auto;
  padding: var(--space-6) var(--space-6) var(--space-7);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background-color: var(--glass-content);
}

.banner {
  margin-bottom: 0;
}
</style>
