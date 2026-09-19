<script setup lang="ts">
/**
 * 设置窗口（docs/07 §2.5、docs/08 §5/§6）：单窗口分栏
 * 常规 / 模式 / AI 模型 / Skill / MCP / 高级。
 *
 * 本窗无系统标题栏（`frame: false`），因此侧栏品牌区自担标题栏职责：
 * 整行可拖动，并提供「✕ 隐藏」按钮（`Esc` 等效）。按 docs/02 §2.2 约定，
 * 此处「关闭」= 隐藏窗口（不退出应用，退出只走托盘菜单）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppToast from '../shared/components/AppToast.vue'
import GeneralPage from './pages/GeneralPage.vue'
import ModesPage from './pages/ModesPage.vue'
import LlmPage from './pages/LlmPage.vue'
import SkillsPage from './pages/SkillsPage.vue'
import McpPage from './pages/McpPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import { usePerceptionStore, useSettingsStore, useWindowStore } from '../shared/stores.js'

type PageId = 'general' | 'modes' | 'llm' | 'skills' | 'mcp' | 'advanced'

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
  { id: 'advanced', label: '高级', hint: '代理、日志、勿扰' },
]

/**
 * 侧栏分组（docs/07 §2.5）：页面本身不变，只是把 6 项按「基础 / AI 能力 / 系统」
 * 分层，避免六个同级项平铺时看不出主次。
 */
const navGroups: Array<{ title: string; ids: PageId[] }> = [
  { title: '基础', ids: ['general', 'modes'] },
  { title: 'AI 能力', ids: ['llm', 'skills', 'mcp'] },
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
      <div class="brand drag-region">
        <span class="brand-mark" />
        <div>
          <strong>Aurora</strong>
          <p class="tiny muted">设置</p>
        </div>
        <button
          class="close no-drag"
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
  padding: var(--space-4) var(--space-3);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-raised);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.content {
  overflow-y: auto;
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.banner {
  margin-bottom: 0;
}
</style>
