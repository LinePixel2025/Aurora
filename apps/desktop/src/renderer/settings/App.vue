<script setup lang="ts">
/**
 * 设置窗口（docs/07 §2.5、docs/08 §5/§6）：单窗口分栏六页
 * 通用 / 模式 / AI 模型 / 语音 / 智能与工具 / 高级（BetaV2 由 8 页合并而来，spec §9）。
 *
 * 合并去向：TtsPage → voice（与 STT 同页）；SkillsPage / McpPage → agent；
 * AdvancedPage 的勿扰时段 → general。旧深链（`?page=tts|skills|mcp`）经
 * `LEGACY_PAGE_ALIASES` 映射到新页，截图核对工具与新老调用方都不受影响。
 *
 * 本窗无系统标题栏（`frame: false`），拖动能力由 `useWindowDrag('settings')` 统一提供
 * （docs/07 §1），共三处：侧栏顶部透明条（16px）、侧栏品牌行（min-height 36px，实测 ≈39px）、
 * 内容区顶部拖动带（10px）。
 * 品牌行右侧是 Windows 式「最小化 / 关闭」按钮（WindowCaption，2026-09 起；
 * 「关闭」= 隐藏窗口，`Esc` 等效；不退出应用，退出只走托盘菜单）。
 * 侧栏导航条目为图标 + 单行文字（旧两行说明文案已删，docs/07 §2.5）。
 */
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue'
import AppToast from '../shared/components/AppToast.vue'
import GeneralPage from './pages/GeneralPage.vue'
import ModesPage from './pages/ModesPage.vue'
import LlmPage from './pages/LlmPage.vue'
import VoicePage from './pages/VoicePage.vue'
import AgentPage from './pages/AgentPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { usePerceptionStore, useSettingsStore, useWindowStore } from '../shared/stores.js'

type PageId = 'general' | 'modes' | 'llm' | 'voice' | 'agent' | 'advanced'

interface NavItem {
  id: PageId
  label: string
  /** 16px 描边图标的 path 数据（stroke 风格与其余窗口图标一致） */
  icon: string
}

/** 扁平清单同时是「页面 id → 标签 / 图标」的查表数据（深链校验也用它） */
const nav: NavItem[] = [
  { id: 'general', label: '通用', icon: 'M2.5 7.6 8 2.8l5.5 4.8M4 6.9V13h8V6.9' },
  {
    id: 'modes',
    label: '模式',
    icon: 'M2.5 2.5h4.6v4.6H2.5zM8.9 2.5h4.6v4.6H8.9zM2.5 8.9h4.6v4.6H2.5zM8.9 8.9h4.6v4.6H8.9z',
  },
  {
    id: 'llm',
    label: 'AI 模型',
    icon: 'M4.6 4.6h6.8v6.8H4.6zM6.5 4.6V2.4M9.5 4.6V2.4M6.5 13.6v-2.2M9.5 13.6v-2.2M4.6 6.5H2.4M4.6 9.5H2.4M13.6 6.5h-2.2M13.6 9.5h-2.2',
  },
  {
    id: 'voice',
    label: '语音',
    icon: 'M2.5 6.4v3.2M5.5 4.4v7.2M8 2.6v10.8M10.5 4.4v7.2M13.5 6.4v3.2',
  },
  {
    id: 'agent',
    label: '智能与工具',
    icon: 'M8 2.2 9.4 6.6 13.8 8 9.4 9.4 8 13.8 6.6 9.4 2.2 8 6.6 6.6Z',
  },
  {
    id: 'advanced',
    label: '系统',
    icon: 'M2.5 5h5.6M11.6 5h1.9M2.5 11h1.9M7.9 11h5.6M9.6 5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0M4.4 11a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0',
  },
]

/**
 * 侧栏分组（BetaV2 六页两级）：基础（本机行为）/ 智能（AI 能力）/ 系统（运维）。
 */
const navGroups: Array<{ title: string; ids: PageId[] }> = [
  { title: '基础', ids: ['general', 'modes'] },
  { title: '智能', ids: ['llm', 'voice', 'agent'] },
  { title: '系统', ids: ['advanced'] },
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
  modes: ModesPage,
  llm: LlmPage,
  voice: VoicePage,
  agent: AgentPage,
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
/** 本窗可拖（docs/07 §1 / §2.5）：拖动区见模板里的 `.sidebar-drag` / `.brand` / `.content-drag`；
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
  <div class="settings">
    <aside class="sidebar">
      <!-- 侧栏顶部拖动条：透明、无内容，作用是把「能拖的区域」从品牌行往上顶到窗口最上缘 -->
      <div class="sidebar-drag" :class="dragClass" aria-hidden="true" />
      <div class="brand" :class="dragClass">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M8 2.4v11.2M2.4 8h11.2M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" />
          </svg>
        </span>
        <div class="brand-text">
          <strong>Aurora</strong>
          <p class="tiny muted">设置</p>
        </div>
        <!-- Windows 式窗口按钮：最小化 + 关闭（= 隐藏，Esc 等效）；见 docs/07 §2.5 -->
        <WindowCaption window="settings" />
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
            <svg class="nav-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path :d="item.icon" />
            </svg>
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

    <main class="content">
      <!-- 内容区顶部拖动带：见下方 `.content-drag` 注释里「为什么不用 sticky」 -->
      <div class="content-drag" :class="dragClass" aria-hidden="true" />
      <AppToast v-if="needsOnboarding" tone="warn" class="banner">
        尚未完成 AI 模型配置：主功能不可用，请前往「AI 模型」页完成配置（或运行首次引导向导）。
      </AppToast>
      <AppToast v-if="!settingsStore.cryptoAvailable" tone="warn" class="banner">
        当前系统未提供安全存储：API Key 只在本次运行的内存中有效。
      </AppToast>

      <!-- 页切换动画（theme.css `page` 预设）：out-in 保证同一时刻只有一页参与布局，不产生双页跳动 -->
      <Transition name="page" mode="out-in">
        <component :is="pages[active]" :key="active" />
      </Transition>
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 200px 1fr;
  height: 100vh;
  background: var(--bg-base);
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  /* 顶部不留内边距：拖动条要顶到窗口最上缘，否则最上面 16px 仍是抓不到的空白 */
  padding: 0 var(--space-3) var(--space-4);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-raised);
}

/**
 * 侧栏顶部拖动条：透明无内容，16px。
 * `margin-bottom` 抵消 `.sidebar` 的 `gap`（12px），让品牌行的**位置**与改动前一致
 * （16px 拖动条顶替了同高的顶部内边距），但它并**不与品牌行首尾相接**——负 margin 只抵掉了 gap，
 * 两者之间仍隔 12px，实测拖动区高度分别为 16px 与 ≈39px（探针取最大高度那条判定，够 32px）。
 */
.sidebar-drag {
  flex: 0 0 auto;
  height: var(--space-4);
  margin-bottom: calc(-1 * var(--space-3));
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* 拖动条高度的下限（探针要求 ≥ 32px）：品牌标记 22px，两行文案本身还会把它撑到 ≈39px */
  min-height: 36px;
  padding: 0 0 0 var(--space-2);
}

.brand-text {
  flex: 1;
  min-width: 0;
}

.brand-text strong {
  display: block;
  font-family: var(--font-display);
  font-size: var(--text-base);
  letter-spacing: var(--tracking-display);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  box-shadow: var(--shadow-hairline);
}

.brand-mark svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--on-accent);
  stroke-width: 1.4;
  stroke-linecap: round;
}

.brand p {
  margin: 0;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 分组标题：小字号 + 弱色 + 字间距，只承担分层，不与可点条目抢注意力 */
.nav-group {
  margin: var(--space-3) 0 var(--space-1);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-muted);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

nav > .nav-group:first-child {
  margin-top: 0;
}

/**
 * 侧栏条目（BetaV2）：背景 / 文字快速过渡 + 按下微缩（`.press` 的手动展开 ——
 * 这里不直接挂全局 `.press` 类，因为 transition 声明要与本条的 background / color 合并）。
 */
.nav-item {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform var(--dur-press) var(--ease-standard);
}

/* 16px 描边图标：与主界面头部图标同一套笔触 */
.nav-icon {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-muted);
  transition: color var(--transition-fast);
}

.nav-item:hover .nav-icon,
.nav-item.active .nav-icon {
  color: var(--aurora-blue);
}

.nav-item:hover {
  background: var(--fill-2);
}

.nav-item:active {
  transform: scale(0.98);
}

/* 当前项：分层填充 + 左侧强调色指示条（不靠纯色块区分，色觉障碍下也可辨） */
.nav-item.active {
  background: var(--fill-3);
}

.nav-item:focus-visible {
  outline: 1px solid var(--focus-ring);
  outline-offset: 2px;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--aurora-gradient);
}

.nav-item .label {
  font-size: var(--text-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.foot {
  margin-top: auto;
  padding: 0 var(--space-2);
}

.foot p {
  margin: 0;
}

/**
 * 滚动容器：页面自己不再加内边距（见 settings.css）。
 * 内部的 `.content-drag` 依赖这里的 `display: flex; flex-direction: column` —— 改这两条前先看它。
 */
.content {
  overflow-y: auto;
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/**
 * 内容区顶部拖动带：10px 透明条，解决「内容区右上角完全没有可抓手」的问题。
 *
 * **方案选择（step-06 第 3 节给的两个方案里选前者）**：普通 flex 子项，不用 `position: sticky`。
 * - `.content` 本来就是 `display:flex; flex-direction:column` 的滚动容器，因此这个方案
 *   不需要动 `.content` 的结构声明，改动面最小；
 * - 关键是**不遮挡**：sticky 会把带子钉在滚动视口顶部，长页面滚到底部时它永久盖住视口
 *   最上面 10px 的内容 —— 带子透明，截图看不出来，而那 10px 里的按钮却点不到，
 *   属于最难排查的遮挡；普通流内的带子会随内容一起滚出视口，任何滚动位置都不会与内容重叠。
 * - 滚下去之后拖动仍然可用：侧栏那 ≈55px 不随内容滚动（窗口任何滚动位置都抓得到）。
 *
 * 已知量：带子在 `.content` 的 24px 顶部内边距之下，所以内容区最上面 24px 仍是死区
 * （拖动请用带子下方 10px 或侧栏）；`margin-bottom` 抵消 `.content` 的 `gap`，
 * 页面内容因此只比改动前低 10px（不抵消的话会低 22px）。
 */
.content-drag {
  flex: 0 0 auto;
  height: 10px;
  margin-bottom: calc(-1 * var(--space-3));
}

.banner {
  margin-bottom: 0;
}
</style>
