<script setup lang="ts">
/** 登录后的固定导航：状态、页面入口与账号动作集中在同一条控制轨上。 */
import { LogOut, pluginPanelIcon } from '@aurora/shared/browser'
import { WORKBENCH_NAV, type PluginNavItem } from '../lib/nav'
import type { RouteName } from '../router'
import type { Me } from '../lib/api'

const props = defineProps<{
  routeName: RouteName
  user: Me | null
  onlineCount: number
  totalCount: number
  /** 本人设备的插件面板入口（App 用 `buildPluginNav` 生成） */
  pluginItems: PluginNavItem[]
  /** 当前打开的面板键（`routeName === 'plugin'` 时有效） */
  activePluginKey: string
}>()

const emit = defineEmits<{
  (event: 'navigate', name: RouteName): void
  (event: 'openPlugin', item: PluginNavItem): void
  (event: 'logout'): void
}>()

const navItems = WORKBENCH_NAV

/** `data-action` 里避免出现 `::`（截图 / 验收选择器直接按属性值匹配） */
function actionOf(key: string): string {
  return `nav.plugin.${key.replace(/[^a-zA-Z0-9._-]+/g, '-')}`
}
</script>

<template>
  <aside class="workbench-sidebar" aria-label="Aurora Center 主导航">
    <button type="button" class="sidebar-brand" @click="emit('navigate', 'console')">
      <span class="sidebar-mark aurora-mark" aria-hidden="true" />
      <span class="sidebar-brand-copy">
        <strong>Aurora</strong>
        <small>Center</small>
      </span>
    </button>

    <div class="sidebar-status" data-field="shell.client-count">
      <span class="status-pulse" :class="{ online: props.onlineCount > 0 }" aria-hidden="true" />
      <span>{{ props.onlineCount }} / {{ props.totalCount }} 台在线</span>
    </div>

    <div class="sidebar-scroll">
      <nav class="sidebar-nav">
        <button
          v-for="item in navItems.filter((entry) => !entry.admin || props.user?.role === 'admin')"
          :key="item.name"
          type="button"
          class="sidebar-nav-item"
          :class="{ active: props.routeName === item.name }"
          :data-action="`nav.${item.name}`"
          @click="emit('navigate', item.name)"
        >
          <component :is="item.icon" :size="17" :stroke-width="1.75" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <nav
        v-if="props.pluginItems.length > 0"
        class="sidebar-nav sidebar-plugins"
        aria-label="插件面板"
      >
        <div class="sidebar-section-label">插件</div>
        <button
          v-for="item in props.pluginItems"
          :key="item.key"
          type="button"
          class="sidebar-nav-item"
          :class="{ active: props.routeName === 'plugin' && props.activePluginKey === item.key }"
          :data-action="actionOf(item.key)"
          @click="emit('openPlugin', item)"
        >
          <component
            :is="pluginPanelIcon(item.icon)"
            :size="17"
            :stroke-width="1.75"
            aria-hidden="true"
          />
          <span class="sidebar-plugin-label">{{ item.label }}</span>
        </button>
      </nav>
    </div>

    <div class="sidebar-account">
      <div class="account-avatar" aria-hidden="true">
        {{ (props.user?.username ?? '?').slice(0, 1).toUpperCase() }}
      </div>
      <div class="account-copy">
        <strong>{{ props.user?.username ?? '' }}</strong>
        <span>{{ props.user?.role === 'admin' ? '管理员' : '用户' }}</span>
      </div>
      <button
        type="button"
        class="account-logout"
        title="退出登录"
        aria-label="退出登录"
        data-action="auth.logout"
        @click="emit('logout')"
      >
        <LogOut :size="16" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.workbench-sidebar {
  display: flex;
  flex-direction: column;
  width: 220px;
  min-height: 0;
  padding: 18px 14px 14px;
  border-right: 1px solid var(--border-subtle);
  /* 桌面玻璃：磨砂磨的是壳层氛围光斑（App.vue 的 ::before）；只换底色与 blur，
     不动 border（材质层不得改变布局占位）。不支持 backdrop-filter 时回落实底。 */
  background: var(--center-wb-glass);
  -webkit-backdrop-filter: var(--center-glass-blur);
  backdrop-filter: var(--center-glass-blur);
}

@supports not (backdrop-filter: blur(1px)) {
  .workbench-sidebar {
    background: var(--center-sidebar);
  }
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.sidebar-mark {
  width: 30px;
  height: 30px;
  border-radius: 7px;
}

.sidebar-brand-copy {
  display: grid;
  gap: 1px;
}

.sidebar-brand-copy strong {
  font-family: var(--font-display);
  font-size: 16px;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.sidebar-brand-copy small {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
}

.sidebar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  margin: 16px 8px 18px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.status-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-idle);
}

.status-pulse.online {
  background: var(--status-ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-ok) 16%, transparent);
}

.sidebar-scroll {
  display: grid;
  gap: 16px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
}

.sidebar-nav {
  display: grid;
  gap: 4px;
}

.sidebar-section-label {
  padding: 0 11px 4px;
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.sidebar-plugin-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 40px;
  padding: 0 11px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.sidebar-nav-item:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.sidebar-nav-item.active {
  background: var(--center-active);
  color: var(--text-primary);
}

.sidebar-nav-item.active svg {
  color: var(--center-signal);
}

.sidebar-account {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 48px;
  margin-top: auto;
  padding: 7px 8px;
  border-top: 1px solid var(--border-subtle);
}

.account-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: var(--center-active);
  color: var(--center-signal);
  font-size: var(--text-sm);
  font-weight: 600;
}

.account-copy {
  display: grid;
  min-width: 0;
}

.account-copy strong {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-copy span {
  color: var(--text-muted);
  font-size: 11px;
}

.account-logout {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  margin-left: auto;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.account-logout:hover {
  background: var(--fill-2);
  color: var(--danger-text);
}

@media (max-width: 820px) {
  .workbench-sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: var(--z-flyout);
    box-shadow: var(--shadow-3);
    transform: translateX(-100%);
    transition: transform var(--dur-base) var(--ease-spring);
    /* 浮在内容上的抽屉必须不透明（同控制台移动抽屉口径），玻璃只留桌面文档流内的一版 */
    background: var(--center-sidebar);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .workbench-sidebar.mobile-open {
    transform: translateX(0);
  }
}
</style>
