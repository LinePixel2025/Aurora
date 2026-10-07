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

const LandingView = defineAsyncComponent(() => import('./views/LandingView.vue'))
const LoginView = defineAsyncComponent(() => import('./views/LoginView.vue'))
const DeviceView = defineAsyncComponent(() => import('./views/DeviceView.vue'))
const ConsoleView = defineAsyncComponent(() => import('./views/ConsoleView.vue'))
const UsageView = defineAsyncComponent(() => import('./views/UsageView.vue'))
const AutomationsView = defineAsyncComponent(() => import('./views/AutomationsView.vue'))
const FilesView = defineAsyncComponent(() => import('./views/FilesView.vue'))
const AdminView = defineAsyncComponent(() => import('./views/AdminView.vue'))

onMounted(() => {
  void boot()
})

/** 未登录时仍可访问的路由（官网、登录页与设备授权页） */
const publicRoutes = new Set(['home', 'login', 'device'])
const needsLogin = computed(() => booted.value && currentUser.value === null)
const isDeviceRoute = computed(() => route.value.name === 'device')
const isPublicShell = computed(() => needsLogin.value || isDeviceRoute.value)
const compactPublicHeader = computed(
  () => route.value.name === 'device' || route.value.name === 'login',
)
const mobileNavOpen = ref(false)

const activeView = computed(() => {
  if (route.value.name === 'device') return DeviceView
  if (needsLogin.value) {
    if (route.value.name === 'login') return LoginView
    return LandingView
  }
  if (route.value.name === 'usage') return UsageView
  if (route.value.name === 'automations') return AutomationsView
  if (route.value.name === 'files') return FilesView
  if (route.value.name === 'admin') return AdminView
  return ConsoleView
})

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
    if (current === 'admin' && currentUser.value?.role !== 'admin') {
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

const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    console: '控制台',
    usage: '用量',
    automations: '自动化',
    files: '文件',
    admin: '管理',
  }
  return titles[route.value.name] ?? 'Aurora Center'
})

function onNavigate(name: Parameters<typeof navigate>[0]): void {
  mobileNavOpen.value = false
  navigate(name)
}

function onLogout(): void {
  logout()
  navigate('home')
}
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
        @navigate="onNavigate"
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
            <component :is="activeView" :key="route.name" />
            <template #fallback>
              <div class="route-loading"><span class="spinner" /></div>
            </template>
          </Suspense>
        </main>
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
  background: var(--center-topbar);
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
  background: var(--center-workspace);
}

.workbench-main[data-route='console'] {
  overflow: hidden;
}

.mobile-nav-toggle,
.sidebar-scrim {
  display: none;
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

  .head-status--devices {
    display: none;
  }
}
</style>
