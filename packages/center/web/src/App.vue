<script setup lang="ts">
/**
 * Center Web 外壳：未登录官网 / 登录注册 / 设备授权 / 登录后工作台。
 *
 * 所有非首屏视图走动态 import，避免官网首包带上 ECharts、管理端和 Markdown 渲染器。
 */
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import {
  actionNotice,
  boot,
  booted,
  currentUser,
  logout,
  showNotice,
  state,
  wsStatus,
} from './state'
import { navigate, route } from './router'
import PublicHeader from './components/PublicHeader.vue'
import WorkbenchSidebar from './components/WorkbenchSidebar.vue'
import { PanelLeft } from '@aurora/shared/browser'
import { WORKBENCH_NAV, buildPluginNav, type PluginNavItem } from './lib/nav'

const LandingView = defineAsyncComponent(() => import('./views/LandingView.vue'))
const LoginView = defineAsyncComponent(() => import('./views/LoginView.vue'))
const DeviceView = defineAsyncComponent(() => import('./views/DeviceView.vue'))
const ConsoleView = defineAsyncComponent(() => import('./views/ConsoleView.vue'))
const UsageView = defineAsyncComponent(() => import('./views/UsageView.vue'))
const AutomationsView = defineAsyncComponent(() => import('./views/AutomationsView.vue'))
const FilesView = defineAsyncComponent(() => import('./views/FilesView.vue'))
const AdminView = defineAsyncComponent(() => import('./views/AdminView.vue'))
const MarketplaceView = defineAsyncComponent(() => import('./views/MarketplaceView.vue'))
const PluginsAdminView = defineAsyncComponent(() => import('./views/PluginsAdminView.vue'))
const PluginPanelView = defineAsyncComponent(() => import('./views/PluginPanelView.vue'))

onMounted(() => {
  void boot()
})

/** 未登录时仍可访问的路由（官网、登录页与设备授权页） */
const publicRoutes = new Set(['home', 'login', 'device', 'marketplace'])
const needsLogin = computed(() => booted.value && currentUser.value === null)
const isDeviceRoute = computed(() => route.value.name === 'device')
const isPublicShell = computed(() => needsLogin.value || isDeviceRoute.value)
const compactPublicHeader = computed(
  () => route.value.name === 'device' || route.value.name === 'login',
)
const mobileNavOpen = ref(false)

const activeView = computed(() => {
  if (route.value.name === 'device') return DeviceView
  if (route.value.name === 'marketplace') return MarketplaceView
  if (route.value.name === 'pluginsAdmin') return PluginsAdminView
  if (needsLogin.value) {
    if (route.value.name === 'login') return LoginView
    return LandingView
  }
  if (route.value.name === 'plugin') return PluginPanelView
  if (route.value.name === 'usage') return UsageView
  if (route.value.name === 'automations') return AutomationsView
  if (route.value.name === 'files') return FilesView
  if (route.value.name === 'admin') return AdminView
  return ConsoleView
})

/**
 * 视图重挂载键：插件面板靠 query 区分（同一路由名切换面板时必须重挂，
 * 否则内层 `pluginId/panelId` 变了而组件实例复用，旧 schema 会留在屏上）。
 */
const viewKey = computed(() =>
  route.value.name === 'plugin'
    ? `plugin:${route.value.query.get('plugin') ?? ''}/${route.value.query.get('panel') ?? ''}`
    : route.value.name,
)

watch(
  [booted, needsLogin, route],
  () => {
    if (!booted.value) return
    const current = route.value.name
    mobileNavOpen.value = false
    if (needsLogin.value) {
      if (!publicRoutes.has(current)) navigate('home')
      return
    }
    if (current === 'login' || current === 'home') {
      navigate('console')
      return
    }
    if (
      (current === 'admin' || current === 'pluginsAdmin') &&
      currentUser.value?.role !== 'admin'
    ) {
      showNotice('需要管理员权限')
      navigate('console')
    }
  },
  { immediate: true },
)

const wsLabel = computed(() => {
  if (wsStatus.value === 'open') return '已连接'
  if (wsStatus.value === 'connecting') return '连接中…'
  if (wsStatus.value === 'closed') return '重连中…'
  return '未连接'
})

const onlineCount = computed(
  () => [...state.clients.values()].filter((entry) => entry.client.online).length,
)

/**
 * 侧栏「插件」分区（docs/12 §6.5）：只取本人名下在线设备的 `ClientStatus.plugins`。
 * 请求实时镜像桌面右栏面板 —— 旧客户端不报目录 / `allowRemoteSession` 关闭时自然为空。
 */
const pluginItems = computed(() =>
  buildPluginNav(
    [...state.clients.values()].map((entry) => ({
      clientId: entry.client.clientId,
      online: entry.client.online,
      ownerUserId: entry.client.ownerUserId,
      ...(entry.status?.plugins === undefined ? {} : { plugins: entry.status.plugins }),
    })),
    currentUser.value?.id ?? '',
  ),
)

const activePluginKey = computed(() =>
  route.value.name === 'plugin'
    ? `${route.value.query.get('plugin') ?? ''}::${route.value.query.get('panel') ?? ''}`
    : '',
)

const pageTitle = computed(() => {
  if (route.value.name === 'plugin') {
    return pluginItems.value.find((item) => item.key === activePluginKey.value)?.label ?? '插件面板'
  }
  const titles: Record<string, string> = {
    console: '控制台',
    usage: '用量',
    automations: '自动化',
    marketplace: '插件市场',
    pluginsAdmin: '插件管理',
    files: '文件',
    admin: '管理',
  }
  return titles[route.value.name] ?? 'Aurora Center'
})

/** 打开插件面板：多设备时默认第一台在线设备，页内可再切换 */
function onOpenPlugin(item: PluginNavItem): void {
  mobileNavOpen.value = false
  navigate('plugin', {
    client: item.clientIds[0] ?? '',
    plugin: item.pluginId,
    panel: item.panelId,
  })
}

function onNavigate(name: Parameters<typeof navigate>[0]): void {
  mobileNavOpen.value = false
  navigate(name)
}

function onLogout(): void {
  logout()
  navigate('home')
}

/**
 * 底部导航（≤720px、非控制台页显示）：控制台页有自己的底部「设备 / 控制面板」
 * 标签，两套一起会出现双层底栏。管理员项仍按角色过滤。
 */
const isConsoleRoute = computed(() => route.value.name === 'console')
const bottomNavItems = computed(() =>
  WORKBENCH_NAV.filter((item) => !(item.admin && currentUser.value?.role !== 'admin')),
)
</script>

<template>
  <div v-if="!booted" class="boot" data-panel="boot">
    <span class="spinner" aria-label="正在加载" />
  </div>

  <div v-else class="app-shell" :class="{ 'app-shell--public': isPublicShell }">
    <template v-if="isPublicShell">
      <PublicHeader :compact="compactPublicHeader" />
      <main
        class="public-main"
        :class="{ 'public-main--device': isDeviceRoute }"
        data-panel="public-shell"
      >
        <Suspense>
          <component :is="activeView" :key="route.name" />
          <template #fallback>
            <div class="route-loading"><span class="spinner" /></div>
          </template>
        </Suspense>
      </main>
    </template>

    <template v-else>
      <WorkbenchSidebar
        :class="{ 'mobile-open': mobileNavOpen }"
        :route-name="route.name"
        :user="currentUser"
        :online-count="onlineCount"
        :total-count="state.clients.size"
        :plugin-items="pluginItems"
        :active-plugin-key="activePluginKey"
        @navigate="onNavigate"
        @open-plugin="onOpenPlugin"
        @logout="onLogout"
      />
      <Transition name="fade">
        <button
          v-if="mobileNavOpen"
          type="button"
          class="sidebar-scrim"
          aria-label="关闭导航"
          @click="mobileNavOpen = false"
        />
      </Transition>

      <div class="workbench">
        <header class="workbench-head">
          <button
            type="button"
            class="mobile-nav-toggle"
            aria-label="打开导航"
            data-action="shell.open-nav"
            @click="mobileNavOpen = true"
          >
            <PanelLeft :size="18" :stroke-width="1.8" aria-hidden="true" />
          </button>
          <div class="workbench-heading">
            <span>AURORA /</span>
            <strong>{{ pageTitle }}</strong>
          </div>
          <span class="grow" />
          <span class="head-status" data-field="shell.ws">
            <i :class="`ws-${wsStatus}`" aria-hidden="true" />
            {{ wsLabel }}
          </span>
          <span class="head-status head-status--devices">
            {{ onlineCount }} / {{ state.clients.size }} 台在线
          </span>
        </header>

        <main class="workbench-main" :data-route="route.name">
          <Suspense>
            <component :is="activeView" :key="viewKey" />
            <template #fallback>
              <div class="route-loading"><span class="spinner" /></div>
            </template>
          </Suspense>
        </main>

        <nav v-if="!isConsoleRoute" class="wb-bottom-nav" aria-label="快捷导航">
          <button
            v-for="item in bottomNavItems"
            :key="item.name"
            type="button"
            class="wb-bottom-item"
            :class="{ active: route.name === item.name }"
            @click="onNavigate(item.name)"
          >
            <component :is="item.icon" :size="19" :stroke-width="1.75" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </button>
        </nav>
      </div>
    </template>

    <Transition name="rise">
      <p
        v-if="actionNotice !== ''"
        class="notice glass-panel"
        data-field="shell.notice"
        role="status"
      >
        {{ actionNotice }}
      </p>
    </Transition>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex: 1 1 auto;
  min-height: 100vh;
  min-width: 0;
}

.app-shell--public {
  flex-direction: column;
}

/*
 * 工作台氛围层（官网分支没有）：光斑铺在壳层最底（z-index:-1 + isolation 收在壳内，
 * 不参与内容层级），侧栏 / 顶栏的毛玻璃磨的就是它 —— 没有这层，半透明底磨到的只是
 * 纯色画布，玻璃感出不来。isolate 同时保证 -1 不会被 body 背景盖住。
 */
.app-shell:not(.app-shell--public) {
  position: relative;
  isolation: isolate;
}

.app-shell:not(.app-shell--public)::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(
      52rem 30rem at 8% -6%,
      color-mix(in srgb, var(--center-signal) 9%, transparent),
      transparent 62%
    ),
    radial-gradient(
      46rem 28rem at 98% 10%,
      color-mix(in srgb, var(--aurora-blue) 8%, transparent),
      transparent 64%
    ),
    radial-gradient(
      40rem 26rem at 50% 110%,
      color-mix(in srgb, var(--center-signal) 6%, transparent),
      transparent 60%
    ),
    var(--center-workspace);
}

.public-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.public-main--device {
  display: grid;
}

.workbench {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.workbench-head {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 12px;
  min-height: 58px;
  padding: 0 22px;
  border-bottom: 1px solid var(--border-subtle);
  /* 玻璃顶栏：与官网顶栏同款配方（半透明 + blur + saturate），不支持时回落实底 */
  background: var(--center-wb-glass);
  -webkit-backdrop-filter: var(--center-glass-blur);
  backdrop-filter: var(--center-glass-blur);
}

@supports not (backdrop-filter: blur(1px)) {
  .workbench-head {
    background: var(--center-topbar);
  }
}

.workbench-heading {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.workbench-heading span {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
}

.workbench-heading strong {
  color: var(--text-primary);
  font-size: var(--text-base);
  font-weight: 500;
}

.grow {
  flex: 1 1 auto;
}

.head-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.head-status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-idle);
}

.head-status i.ws-open {
  background: var(--status-ok);
}

.head-status i.ws-connecting {
  background: var(--status-unread);
}

.head-status i.ws-closed {
  background: var(--status-error);
}

.workbench-main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  /* 背景交给壳层氛围层：这里不透明会把毛玻璃要磨的光斑全盖住 */
  background: transparent;
}

.workbench-main[data-route='console'] {
  overflow: hidden;
}

.mobile-nav-toggle,
.sidebar-scrim,
.wb-bottom-nav {
  display: none;
}

/*
 * 移动端底部导航（≤720px、非控制台页）：实底浮条 —— 浮在页面内容上，半透明会把
 * 正文透出来（同抽屉口径）。z-index 取 auto（定位层）：低于壳层抽屉(--z-flyout)
 * 与壳层 scrim(--z-sticky)，开抽屉时被 scrim 正常盖住。
 */
.wb-bottom-nav {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  align-items: stretch;
  gap: 2px;
  padding: 6px 10px calc(6px + env(safe-area-inset-bottom, 0));
  border-top: 1px solid var(--border-subtle);
  background: var(--center-sidebar);
}

.wb-bottom-item {
  display: grid;
  justify-items: center;
  gap: 2px;
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 2px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.wb-bottom-item.active {
  background: var(--center-active);
  color: var(--center-signal);
}

.boot,
.route-loading {
  display: grid;
  place-items: center;
  min-height: 100vh;
}

.route-loading {
  min-height: 220px;
}

.notice {
  position: fixed;
  left: 50%;
  bottom: var(--space-5);
  transform: translateX(-50%);
  z-index: var(--z-toast);
  max-width: min(560px, calc(100vw - 2 * var(--space-4)));
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  background: var(--glass-panel);
  color: var(--text-primary);
  font-size: var(--text-sm);
  text-align: center;
  box-shadow: var(--shadow-3);
}

@media (max-width: 820px) {
  .mobile-nav-toggle {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text-secondary);
  }

  .sidebar-scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: var(--z-sticky);
    border: none;
    background: var(--overlay-scrim);
  }

  .workbench-head {
    min-height: 54px;
    padding: 0 14px;
  }

  /* 窄屏顶栏只留页面名：AURORA 前缀与设备数状态都是装饰 */
  .workbench-heading span {
    display: none;
  }

  .head-status--devices {
    display: none;
  }
}

@media (max-width: 720px) {
  .wb-bottom-nav {
    display: flex;
  }

  /* 底部导航占位：控制台页有自己的底部标签，不垫（高度锁定一屏不能少） */
  .workbench-main:not([data-route='console']) {
    padding-bottom: calc(64px + env(safe-area-inset-bottom, 0));
  }
}
</style>
