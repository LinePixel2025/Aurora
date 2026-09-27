<script setup lang="ts">
/**
 * Aurora Center Web 根组件：自实现 hash 路由（不引路由库）。
 * `#/login` 登录、`#/` 控制台、`#/files` 文件、`#/admin` 管理端、
 * `#/device?code=<userCode>` 设备授权确认（未登录也可进入，页内先登录）；
 * 未登录一律回登录页，非管理员访问 #/admin 会被守卫改回控制台。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import LoginView from './views/LoginView.vue'
import ConsoleView from './views/ConsoleView.vue'
import AdminView from './views/AdminView.vue'
import DeviceView from './views/DeviceView.vue'
import FilesView from './views/FilesView.vue'
import { boot, booted, currentUser, logout, wsStatus } from './store'

type RouteName = 'login' | 'console' | 'admin' | 'files' | 'device'

const route = ref<RouteName>(parseRoute())

function parseRoute(): RouteName {
  const hash = window.location.hash.replace(/^#/, '').split('?')[0]
  if (hash.startsWith('/admin')) return 'admin'
  if (hash.startsWith('/files')) return 'files'
  if (hash.startsWith('/device')) return 'device'
  if (hash.startsWith('/login')) return 'login'
  return 'console'
}

function onHashChange(): void {
  route.value = parseRoute()
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  void boot()
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
})

// 路由守卫：启动完成前不判定，避免登录态未恢复就跳转。
// #/device 例外：未登录也可进入（页内先登录再确认）。
watch(
  [booted, currentUser, route],
  ([isBooted, user, current]) => {
    if (!isBooted) return
    if (!user) {
      if (current !== 'login' && current !== 'device') window.location.hash = '#/login'
      return
    }
    if (current === 'login') window.location.hash = '#/'
    else if (current === 'admin' && user.role !== 'admin') window.location.hash = '#/'
  },
  { immediate: true },
)

const wsLabel = computed(() => {
  switch (wsStatus.value) {
    case 'open':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'closed':
      return '重连中'
    default:
      return '未连接'
  }
})
</script>

<template>
  <div v-if="!booted" class="boot-center">
    <span class="spinner"></span>
  </div>
  <template v-else>
    <!-- 设备确认页：独立布局，登录态由页内自行处理 -->
    <DeviceView v-if="route === 'device'" />
    <template v-else-if="currentUser && route !== 'login'">
      <header class="topbar">
        <div class="topbar-inner">
          <a class="brand" href="#/">Aurora Center</a>
          <nav class="topbar-right">
            <a class="topbar-link" :class="{ active: route === 'console' }" href="#/">控制台</a>
            <a class="topbar-link" :class="{ active: route === 'files' }" href="#/files">文件</a>
            <a
              v-if="currentUser.role === 'admin'"
              class="topbar-link"
              :class="{ active: route === 'admin' }"
              href="#/admin"
            >
              管理
            </a>
            <span class="ws-chip" :class="wsStatus"><i></i>{{ wsLabel }}</span>
            <span class="topbar-user">{{ currentUser.username }}</span>
            <button class="btn btn-ghost btn-sm" type="button" @click="logout">退出</button>
          </nav>
        </div>
      </header>
      <main class="page">
        <ConsoleView v-if="route === 'console'" />
        <FilesView v-else-if="route === 'files'" />
        <AdminView v-else-if="route === 'admin' && currentUser.role === 'admin'" />
      </main>
    </template>
    <LoginView v-else />
  </template>
</template>

<style scoped>
.page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px 20px 24px;
}

@media (max-width: 720px) {
  .page {
    padding: 12px 12px 20px;
  }
}
</style>
