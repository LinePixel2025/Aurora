<script setup lang="ts">
/**
 * SPA 外壳：启动态 / 登录守卫 / 顶栏 / 路由出口（docs/12 §10）。
 *
 * - 未登录只允许 `#/login` 与 `#/device`（设备授权确认页未登录可访问，docs/12 §4.3）；
 * - 非管理员访问 `#/admin` 一律回控制台（服务器侧同样会拒绝）；
 * - 顶栏右侧的 WS 指示是**唯一**的"网页端 ↔ 服务器通路"信号（设备在线状态由推送驱动，
 *   没有轮询兜底，所以这里必须如实显示链路状态）。
 */
import { computed, onMounted, watch } from 'vue'
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
import {
  Blocks,
  BookOpenText,
  FolderOpen,
  LogOut,
  MonitorSmartphone,
  Sparkles,
} from '@aurora/shared/browser'
import LoginView from './views/LoginView.vue'
import ConsoleView from './views/ConsoleView.vue'
import AutomationsView from './views/AutomationsView.vue'
import FilesView from './views/FilesView.vue'
import AdminView from './views/AdminView.vue'
import DeviceView from './views/DeviceView.vue'

onMounted(() => {
  void boot()
})

/** 未登录时仍可访问的路由（登录页自身与设备授权页） */
const publicRoutes = new Set(['login', 'device'])
const needsLogin = computed(() => booted.value && currentUser.value === null)

watch(
  [booted, needsLogin, route],
  () => {
    if (!booted.value) return
    const current = route.value.name
    if (needsLogin.value) {
      if (!publicRoutes.has(current)) navigate('login')
      return
    }
    if (current === 'login') {
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

const navItems = [
  { name: 'console' as const, label: '控制台', icon: Sparkles, admin: false },
  { name: 'automations' as const, label: '自动化', icon: Blocks, admin: false },
  { name: 'files' as const, label: '文件', icon: FolderOpen, admin: false },
  { name: 'admin' as const, label: '管理', icon: MonitorSmartphone, admin: true },
]

const visibleNav = computed(() =>
  navItems.filter((item) => !item.admin || currentUser.value?.role === 'admin'),
)

const wsLabel = computed(() => {
  if (wsStatus.value === 'open') return '已连接'
  if (wsStatus.value === 'connecting') return '连接中…'
  if (wsStatus.value === 'closed') return '已断开，重连中…'
  return '未连接'
})

const onlineCount = computed(
  () => [...state.clients.values()].filter((entry) => entry.client.online).length,
)
</script>

<template>
  <!--
    启动态 → 壳的切换：`page` 预设（共享）+ `mode="out-in"`。
    两者高度完全不同（boot 是整屏居中、壳是顶栏 + 全高主区），同屏交叉会让页面上下弹一下，
    out-in 先把 spinner 淡出再让壳进来，交接是干净的。
  -->
  <Transition name="page" mode="out-in">
    <div v-if="!booted" key="boot" class="boot" data-panel="boot">
      <span class="spinner" aria-label="正在加载" />
    </div>

    <div v-else key="shell" class="shell">
      <header v-if="!needsLogin" class="topbar glass-bar anim-pane">
        <div class="topbar-inner">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <BookOpenText :size="17" :stroke-width="1.8" />
            </span>
            <span class="brand-name">Aurora</span>
            <span class="brand-sub">Center</span>
          </div>

          <nav class="nav" aria-label="主导航">
            <button
              v-for="item in visibleNav"
              :key="item.name"
              type="button"
              class="nav-item"
              :class="{ active: route.name === item.name }"
              :data-action="`nav.${item.name}`"
              @click="navigate(item.name)"
            >
              <component :is="item.icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
              <span>{{ item.label }}</span>
            </button>
          </nav>

          <span class="grow" />

          <span
            v-if="state.clients.size > 0"
            class="client-count"
            data-field="shell.client-count"
            :title="`${onlineCount} 台在线 / 共 ${state.clients.size} 台`"
          >
            <MonitorSmartphone :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ onlineCount }} / {{ state.clients.size }}
          </span>

          <span class="ws-chip" :class="`ws-${wsStatus}`" data-field="shell.ws" :title="wsLabel">
            <i class="ws-dot" aria-hidden="true" />
            {{ wsLabel }}
          </span>

          <span class="user">
            {{ currentUser?.username ?? '' }}
            <span v-if="currentUser?.role === 'admin'" class="badge">管理员</span>
          </span>

          <button type="button" class="logout" data-action="auth.logout" @click="logout()">
            <LogOut :size="14" :stroke-width="1.8" aria-hidden="true" />
            退出
          </button>
        </div>
      </header>

      <!--
        主区视图切换同样走 `page`（out-in）：两个视图的滚动位置 / 高度互不相干，
        交叉淡入会让新旧两屏内容叠在同一个滚动容器上（旧页还在滚、新页已经进场）。
        每个分支给显式 key：路由名不同但组件复用的场合也能被 out-in 正确区分。
      -->
      <main class="app-main">
        <Transition name="page" mode="out-in">
          <ConsoleView v-if="!needsLogin && route.name === 'console'" key="console" />
          <AutomationsView
            v-else-if="!needsLogin && route.name === 'automations'"
            key="automations"
          />
          <FilesView v-else-if="!needsLogin && route.name === 'files'" key="files" />
          <AdminView v-else-if="!needsLogin && route.name === 'admin'" key="admin" />
          <DeviceView v-else-if="route.name === 'device'" key="device" />
          <LoginView v-else key="login" />
        </Transition>
      </main>

      <footer v-if="!needsLogin" class="font-notice">
        HarmonyOS Sans Fonts © 2021 Huawei Device Co., Ltd.
        <a href="/licenses/HarmonyOS-Sans-LICENSE.txt" target="_blank" rel="noopener noreferrer">
          许可
        </a>
      </footer>

      <!-- 非阻断提示（待办栏的批复 / 过期、代码复制失败、语音失败…）：6s 自消隐，
           不打断操作 —— 与桌面端的瞬时提示同款语义，只是网页端挂在壳上全局一份 -->
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
  </Transition>
</template>

<style scoped>
/*
 * 壳（顶栏 + 主区 + 提示）：原来是 `v-if/v-else` 的 `<template>` 片段、直接挂在 #app 的
 * 列布局下；包进 `<Transition>` 后需要一层真实元素，于是这里把那份「撑满 + 纵向排列」
 * 接下来 —— 不接的话顶栏与主区会从 flex 子项变成普通块，主区拿不到剩余高度。
 */
.shell {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background: transparent;
}

.font-notice {
  flex: 0 0 auto;
  padding: 6px var(--space-4);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-align: center;
}

.boot {
  display: grid;
  place-items: center;
  height: 100vh;
}

.topbar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border-subtle);
  padding-top: var(--safe-top, env(safe-area-inset-top, 0px));
}

.topbar-inner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  min-height: 52px;
  width: 100%;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--aurora-gradient);
  color: var(--on-accent);
}

.brand-sub {
  color: var(--text-muted);
  font-weight: var(--weight-regular);
  font-size: var(--text-sm);
}

.nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: var(--space-3);
}

.nav-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.nav-item:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.grow {
  flex: 1 1 auto;
}

.client-count {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.ws-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  min-height: 24px;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.ws-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-idle);
}

/*
 * 通路状态点用共享的 `aurora-breathe` 呼吸：这是**唯一**的"网页端 ↔ 服务器通路"信号，
 * 静止的点在一屏都是静物的顶栏里很容易被看漏。只让「已连接 / 连接中」呼吸 ——
 * 断开是静态红点：它要的是"出事了"而不是"还活着"。
 */
.ws-open .ws-dot {
  background: var(--status-ok);
  animation: aurora-breathe var(--dur-breathe) var(--ease-standard) infinite;
}

.ws-connecting .ws-dot {
  background: var(--status-unread);
  animation: aurora-breathe var(--dur-breathe) var(--ease-standard) infinite;
}

.ws-closed .ws-dot {
  background: var(--status-error);
}

.user {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.logout {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.logout:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 非阻断提示：贴在视口底部居中，压在内容之上但不挡输入卡（--z-toast 是唯一的提示层） */
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
  border-radius: var(--radius-pill);
  background: var(--glass-panel);
  color: var(--text-primary);
  font-size: var(--text-sm);
  text-align: center;
  box-shadow: var(--shadow-3);
}

@media (max-width: 720px) {
  .topbar-inner {
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
  }

  .nav {
    order: 3;
    width: 100%;
    margin-left: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .nav::-webkit-scrollbar {
    display: none;
  }

  .nav-item {
    flex: 0 0 auto;
    min-height: var(--hit-target);
  }

  .client-count,
  .ws-chip {
    display: none;
  }

  .user .badge {
    display: none;
  }
}
</style>
