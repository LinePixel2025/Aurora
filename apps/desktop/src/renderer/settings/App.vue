<script setup lang="ts">
/**
 * 设置窗口（docs/07 §2.5、docs/08 §5/§6）：单窗口分栏多页。
 *
 * 2026-11 信息架构（Agent 独立栏目）：左栏四组 —— 本机（通用 / 会话管理 / 模式 / 提醒）/
 * 智能（AI 模型 / 语音 / Computer Use / 文件自感知）/ **Agent**（电脑操控 / 内置浏览器 /
 * 子代理 / 技能 / MCP 服务器）/ 系统（Aurora Center / 插件 / 系统）。共 16 页。
 * 原「Agent 设置」单页的五个可折叠区组各拆成一页，字段锚点与保存语义不变。
 *
 * 合并去向：TtsPage → voice（与 STT 同页）；AdvancedPage 的勿扰时段 → general。
 * 旧深链经 `LEGACY_PAGE_ALIASES` 单向映射：`?page=tts → voice`、
 * `?page=agent → agent-tools`、`?page=skills → agent-skills`、`?page=mcp → agent-mcp`。
 *
 * 侧栏 16 项在默认窗口高度下放不下，因此 `nav` 是独立滚动区；切页时内容区回到顶部，
 * 深链或导航定位后把当前条目滚入可视范围（不改变窗口几何）。
 *
 * 本窗无系统标题栏（`frame: false`），拖动能力由 `useWindowDrag('settings')` 统一提供
 * （docs/07 §1）：窗口顶部一条完整的 32px 标题带，滚动内容始终不会盖住它。
 * Windows 式窗口按钮（WindowCaption）挂在**窗口右上角**（`position: fixed`，2026-10 起
 * 从品牌行右移出——Windows 通用布局是三键贴窗口右上缘，不在侧栏里）；
 * 「关闭」= 隐藏窗口，`Esc` 等效；不退出应用，退出只走托盘菜单。
 * 侧栏导航条目为图标 + 单行文字（旧两行说明文案已删，docs/07 §2.5）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, type Component } from 'vue'
import AppToast from '../shared/components/AppToast.vue'
import GeneralPage from './pages/GeneralPage.vue'
import SessionsPage from './pages/SessionsPage.vue'
import ModesPage from './pages/ModesPage.vue'
import NotificationsPage from './pages/NotificationsPage.vue'
import LlmPage from './pages/LlmPage.vue'
import VoicePage from './pages/VoicePage.vue'
import AgentToolsPage from './pages/AgentToolsPage.vue'
import AgentBrowserPage from './pages/AgentBrowserPage.vue'
import AgentSubagentsPage from './pages/AgentSubagentsPage.vue'
import AgentSkillsPage from './pages/AgentSkillsPage.vue'
import AgentMcpPage from './pages/AgentMcpPage.vue'
import CenterPage from './pages/CenterPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import FileAwarenessPage from './pages/FileAwarenessPage.vue'
import PluginsPage from './pages/PluginsPage.vue'
import ComputerUsePage from './pages/ComputerUsePage.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import ZoomBadge from '../shared/components/ZoomBadge.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { usePerceptionStore, useSettingsStore, useWindowStore } from '../shared/stores.js'
import {
  Archive,
  AudioLines,
  Bell,
  Blocks,
  Bot,
  Cpu,
  Globe,
  House,
  LayoutGrid,
  FolderSearch,
  MousePointer2,
  MonitorSmartphone,
  Puzzle,
  SettingsGear,
  Terminal,
  Wrench,
} from '@aurora/shared/browser'

type PageId =
  | 'general'
  | 'sessions'
  | 'modes'
  | 'notifications'
  | 'llm'
  | 'voice'
  | 'agent-tools'
  | 'agent-browser'
  | 'agent-subagents'
  | 'agent-skills'
  | 'agent-mcp'
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
  // Agent 独立栏目（2026-11）：原「Agent 设置」单页的五个区组各拆成一页
  { id: 'agent-tools', label: '电脑操控', icon: Terminal },
  { id: 'agent-browser', label: '内置浏览器', icon: Globe },
  { id: 'agent-subagents', label: '子代理', icon: Bot },
  { id: 'agent-skills', label: '技能', icon: Puzzle },
  { id: 'agent-mcp', label: 'MCP 服务器', icon: Wrench },
  { id: 'computer-use', label: 'Computer Use', icon: MousePointer2 },
  { id: 'awareness', label: '文件自感知', icon: FolderSearch },
  { id: 'center', label: 'Aurora Center', icon: MonitorSmartphone },
  { id: 'plugins', label: '插件', icon: Blocks },
  { id: 'advanced', label: '系统', icon: SettingsGear },
]

/**
 * 侧栏分组（2026-11 四组）：本机（行为与界面）/ 智能（AI 能力）/ Agent（Agent 能力面）/
 * 系统（连接、扩展与运维）。
 *
 * 2026-10-31 曾收敛为三组 12 项；2026-11 把「Agent 设置」从「智能」里提出来独立成组，
 * 五个设置项各占一条。条目顺序即截图 / 探针读取的 DOM 顺序，改顺序要同步 docs/07。
 */
const navGroups: Array<{ title: string; ids: PageId[] }> = [
  { title: '本机', ids: ['general', 'sessions', 'modes', 'notifications'] },
  { title: '智能', ids: ['llm', 'voice', 'computer-use', 'awareness'] },
  {
    title: 'Agent',
    ids: ['agent-tools', 'agent-browser', 'agent-subagents', 'agent-skills', 'agent-mcp'],
  },
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
  'agent-tools': AgentToolsPage,
  'agent-browser': AgentBrowserPage,
  'agent-subagents': AgentSubagentsPage,
  'agent-skills': AgentSkillsPage,
  'agent-mcp': AgentMcpPage,
  'computer-use': ComputerUsePage,
  awareness: FileAwarenessPage,
  center: CenterPage,
  plugins: PluginsPage,
  advanced: AdvancedPage,
}

/**
 * 旧深链兼容映射：老链接落到拆分 / 合并后的新页。
 * 只做单向映射；新 id 直接生效，不在表里的值回落「通用」。
 * `agent` / `skills` / `mcp` 是 2026-11 Agent 栏目拆分前的页面 id。
 */
const LEGACY_PAGE_ALIASES: Record<string, PageId> = {
  tts: 'voice',
  agent: 'agent-tools',
  skills: 'agent-skills',
  mcp: 'agent-mcp',
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
/** 侧栏导航滚动区 / 内容滚动区：切页复位与当前项滚入视口都要用（见 `select()`） */
const navRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
/** 本窗可拖（docs/07 §1 / §2.5）：拖动区见模板里的 `.titlebar-drag`（含品牌锁up）；
 *  WindowCaption 的按钮自带 no-drag（组件内部显式挂类），这里不再需要 noDragClass */
const { dragClass } = useWindowDrag('settings')

const needsOnboarding = computed(() => settingsStore.needsOnboarding)

/**
 * 把当前 nav 条目滚入侧栏可视区（`block: 'nearest'` 只动最近的滚动祖先 `nav`）。
 * 16 项在默认窗口中放不下，深链直开靠后的页面（如 `?page=agent-mcp`）时不处理就会
 * 看不见当前项。
 */
function revealActive(): void {
  const current = navRef.value?.querySelector<HTMLElement>('.nav-item.active')
  current?.scrollIntoView({ block: 'nearest' })
}

async function closeSettings(): Promise<void> {
  await windowStore.hide('settings')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') void closeSettings()
}

onMounted(() => {
  void perception.refresh()
  window.addEventListener('keydown', onKeydown)
  // 首帧后再滚：深链页面在挂载时才知道哪个条目是 active
  void nextTick(revealActive)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

/**
 * 切页：先换当前页，再在下一帧把内容区滚回顶部（否则从长页切到短页会停在上一页的
 * 滚动位置），并让当前导航条目保持可见。页面本身仍由 `<component :key>` 重新挂载。
 */
function select(id: PageId): void {
  active.value = id
  void nextTick(() => {
    contentRef.value?.scrollTo({ top: 0 })
    revealActive()
  })
}
</script>

<template>
  <div class="settings anim-window">
    <ZoomBadge />
    <!-- 标题栏（2026-11-14 重设计，docs/07 §2.5）：品牌从侧栏上移，左品牌锁up + 右 caption；
         整行是唯一全宽拖动区（40px ≥ 32px 探针下限），品牌锁up 不挂 no-drag（可抓着拖）。 -->
    <div class="titlebar-drag" :class="dragClass">
      <div class="titlebar-brand" data-field="settings.titlebar-brand">
        <span class="brand-mark aurora-mark" aria-hidden="true" />
        <strong>Aurora</strong>
        <!-- 发行线路小徽标：纯标识、不可交互 -->
        <span class="brand-badge">Line Production</span>
        <span class="titlebar-divider" aria-hidden="true" />
        <span class="titlebar-context">设置</span>
      </div>
      <!-- Windows 式窗口按钮：位于窗口标题带右端，按钮自身 no-drag。 -->
      <WindowCaption window="settings" class="window-caption" />
    </div>
    <aside class="sidebar glass-shell rail-surface anim-shell-left">
      <nav ref="navRef">
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

    <main ref="contentRef" class="content anim-pane">
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
  grid-template-rows: 40px minmax(0, 1fr);
  height: 100vh;
  background: transparent;
}

/**
 * 顶部标题栏（2026-11-14 重设计，docs/07 §2.5）：设置窗唯一的窗口拖动入口，
 * 始终贴在窗口最上缘且不随内容滚动。左侧品牌锁up（可抓着拖），右侧 caption
 * 自带 no-drag 仍可点击。表面与主界面头部同语言（--glass-bar + 发丝线）。
 */
.titlebar-drag {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-left: var(--space-3);
  z-index: 30;
  min-width: 0;
  background: var(--glass-bar);
  border-bottom: 1px solid var(--border-subtle);
}

/* 品牌锁up：mark + Aurora + 线路徽标 + 分隔 + 「设置」；flex:1 把 caption 推到右缘 */
.titlebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.titlebar-brand .brand-mark {
  width: 16px;
  height: 16px;
  flex: none;
}

.titlebar-brand strong {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  white-space: nowrap;
}

.titlebar-divider {
  width: 1px;
  height: 14px;
  flex: none;
  background: var(--border-subtle);
}

.titlebar-context {
  font-size: var(--text-xs);
  color: var(--text-muted);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.window-caption {
  display: flex;
  align-self: stretch;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3) var(--space-3);
  grid-column: 1;
  grid-row: 2;
  /* 2026-11：16 项导航默认高度放不下，nav 自己滚；侧栏本身不滚，底部版本行固定 */
  min-height: 0;
}

/* 发行线路徽标：9.5px 小字 + 胶囊描边，只做标识，不与品牌名抢层级 */
.brand-badge {
  flex: none;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--aurora-blue) 26%, transparent);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 10%, transparent);
  color: var(--aurora-blue);
  font-size: 9.5px;
  font-weight: var(--weight-medium);
  line-height: 15px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* 侧栏导航（2026-11 Agent 独立栏目后共 16 项）：默认窗口高度放不下，nav 独立滚动，
 * 底部版本号行固定；分组标题与条目都不可被 flex 收缩，否则条目会被压扁。
 * 滚动条走 thin 档：208px 宽的侧栏里常规滚动条太抢眼。 */
nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding-bottom: var(--space-1);
}

/* 分组标题：小字号 + 弱色 + 中文不做大写字距，只承担分层，不与可点条目抢注意力。
 * 四组时上边距收一档（--space-4 → --space-3），让 Agent 组在 640px 高窗口里尽量完整。 */
.nav-group {
  flex: none;
  margin: var(--space-3) 0 var(--space-1);
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
  flex: none;
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
  flex: none;
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
