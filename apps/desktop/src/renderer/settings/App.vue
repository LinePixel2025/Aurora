<script setup lang="ts">
/**
 * 设置窗口（docs/07 §2.5、docs/08 §5/§6）：单窗口分栏
 * 常规 / 模式 / AI 模型 / Skill / MCP / 高级。
 */
import { computed, onMounted, ref } from 'vue'
import AppToast from '../shared/components/AppToast.vue'
import GeneralPage from './pages/GeneralPage.vue'
import ModesPage from './pages/ModesPage.vue'
import LlmPage from './pages/LlmPage.vue'
import SkillsPage from './pages/SkillsPage.vue'
import McpPage from './pages/McpPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import { usePerceptionStore, useSettingsStore } from '../shared/stores.js'

type PageId = 'general' | 'modes' | 'llm' | 'skills' | 'mcp' | 'advanced'

const nav: Array<{ id: PageId; label: string; hint: string }> = [
  { id: 'general', label: '常规', hint: '语言、开机自启、提示条' },
  { id: 'modes', label: '模式', hint: '三种模式与引导' },
  { id: 'llm', label: 'AI 模型', hint: 'Provider 与连接测试' },
  { id: 'skills', label: 'Skill', hint: '内置与用户技能' },
  { id: 'mcp', label: 'MCP', hint: '外部工具服务' },
  { id: 'advanced', label: '高级', hint: '代理、日志、勿扰' },
]

const active = ref<PageId>('general')
const settingsStore = useSettingsStore()
const perception = usePerceptionStore()

const needsOnboarding = computed(() => settingsStore.needsOnboarding)

onMounted(() => {
  void perception.refresh()
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
      </div>
      <nav>
        <button
          v-for="item in nav"
          :key="item.id"
          type="button"
          class="nav-item"
          :class="{ active: active === item.id }"
          @click="select(item.id)"
        >
          <span class="label">{{ item.label }}</span>
          <span class="tiny muted">{{ item.hint }}</span>
        </button>
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

.brand-mark {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--aurora-gradient);
}

.brand p {
  margin: 0;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--transition-fast);
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.nav-item.active {
  background: rgba(86, 132, 255, 0.14);
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
