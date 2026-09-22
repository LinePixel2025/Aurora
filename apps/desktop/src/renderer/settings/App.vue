<script setup lang="ts">
/**
 * 设置窗口（docs/07 §2.5、docs/08 §5/§6）：单窗口分栏
 * 常规 / 模式 / AI 模型 / Skill / MCP / 高级。
 *
 * 本窗无系统标题栏（`frame: false`），拖动能力由 `useWindowDrag('settings')` 统一提供
 * （docs/07 §1），共三处：侧栏顶部透明条（16px）、侧栏品牌行（min-height 36px，实测 ≈39px）、
 * 内容区顶部拖动带（10px）。
 * 品牌行同时提供「✕ 隐藏」按钮（`Esc` 等效）。按 docs/02 §2.2 约定，
 * 此处「关闭」= 隐藏窗口（不退出应用，退出只走托盘菜单）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppToast from '../shared/components/AppToast.vue'
import GeneralPage from './pages/GeneralPage.vue'
import ModesPage from './pages/ModesPage.vue'
import LlmPage from './pages/LlmPage.vue'
import SkillsPage from './pages/SkillsPage.vue'
import McpPage from './pages/McpPage.vue'
import AgentPage from './pages/AgentPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { usePerceptionStore, useSettingsStore, useWindowStore } from '../shared/stores.js'

type PageId = 'general' | 'modes' | 'llm' | 'skills' | 'mcp' | 'agent' | 'advanced'

interface NavItem {
  id: PageId
  label: string
  hint: string
}

/** 扁平清单同时是「页面 id → 标签 / 说明」的查表数据（深链校验也用它） */
const nav: NavItem[] = [
  { id: 'general', label: '常规', hint: '开机自启、快捷键、提示条' },
  { id: 'modes', label: '模式', hint: '三种模式与引导' },
  { id: 'llm', label: 'AI 模型', hint: 'Provider 与连接测试' },
  { id: 'skills', label: 'Skill', hint: '内置与用户技能' },
  { id: 'mcp', label: 'MCP', hint: '外部工具服务' },
  { id: 'agent', label: '电脑操控', hint: '终端与文件操控' },
  { id: 'advanced', label: '高级', hint: '代理、日志、勿扰' },
]

/**
 * 侧栏分组（docs/07 §2.5）：页面本身不变，只是把 7 项按「基础 / AI 能力 / 系统」
 * 分层，避免同级项平铺时看不出主次。
 */
const navGroups: Array<{ title: string; ids: PageId[] }> = [
  { title: '基础', ids: ['general', 'modes'] },
  { title: 'AI 能力', ids: ['llm', 'skills', 'mcp', 'agent'] },
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

/**
 * 初始页面：支持 `?page=<id>` 深链（截图核对工具按页出图，docs/07 §5）。
 * 正常启动不带 query，回落到「常规」；未知值同样回落，避免白屏。
 */
function initialPage(): PageId {
  const requested = new URLSearchParams(window.location.search).get('page')
  const match = nav.find((item) => item.id === requested)
  return match?.id ?? 'general'
}

const active = ref<PageId>(initialPage())
const settingsStore = useSettingsStore()
const windowStore = useWindowStore()
const perception = usePerceptionStore()
/** 本窗可拖（docs/07 §1 / §2.5）：拖动区见模板里的 `.sidebar-drag` / `.brand` / `.content-drag` */
const { dragClass, noDragClass } = useWindowDrag('settings')

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
        <span class="brand-mark" />
        <div>
          <strong>Aurora</strong>
          <p class="tiny muted">设置</p>
        </div>
        <button
          class="close"
          :class="noDragClass"
          type="button"
          title="隐藏设置窗口（Esc）"
          aria-label="隐藏设置窗口"
          @click="closeSettings"
        >
          ✕
        </button>
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
            @click="select(item.id)"
          >
            <span class="label">{{ item.label }}</span>
            <span class="tiny muted">{{ item.hint }}</span>
          </button>
        </template>
      </nav>
      <div class="foot">
        <p class="tiny muted">v{{ settingsStore.appInfo?.appVersion ?? '0.1.0' }}</p>
        <p class="tiny muted">Electron {{ settingsStore.appInfo?.electronVersion ?? '-' }}</p>
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

      <GeneralPage v-if="active === 'general'" />
      <ModesPage v-else-if="active === 'modes'" />
      <LlmPage v-else-if="active === 'llm'" />
      <SkillsPage v-else-if="active === 'skills'" />
      <McpPage v-else-if="active === 'mcp'" />
      <AgentPage v-else-if="active === 'agent'" />
      <AdvancedPage v-else />
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
 * `margin-bottom` 抵消 `.sidebar` 的 `gap`，让它与下面的品牌行首尾相接
 * （16px + 品牌行 ≈ 39px ≈ 55px 连续拖动区，中间不留 12px 抓不住的缝），且品牌行及以下的
 * 位置与改动前完全一致（`--space-4` 的顶部内边距被同高的拖动条顶替）。
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
  padding: 0 var(--space-2);
}

.brand > div {
  /* 让品牌文案占满剩余宽度，把关闭按钮推到最右 */
  flex: 1;
  min-width: 0;
}

.brand-mark {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--aurora-gradient);
}

.brand p {
  margin: 0;
}

.close {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  color: var(--text-secondary);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.close:hover {
  background: rgba(242, 85, 90, 0.18);
  color: #ff9ca0;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 分组标题：小字号 + 弱色 + 字间距，只承担分层，不与可点条目抢注意力 */
.nav-group {
  margin: var(--space-3) 0 var(--space-1);
  padding: 0 10px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

nav > .nav-group:first-child {
  margin-top: 0;
}

.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.nav-item:hover {
  background: var(--fill-1);
}

/* 当前项：分层填充 + 左侧品牌色指示条（不靠纯色块区分，色觉障碍下也可辨） */
.nav-item.active {
  background: var(--fill-2);
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
  font-size: 13px;
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
