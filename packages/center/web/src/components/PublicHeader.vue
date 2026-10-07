<script setup lang="ts">
/**
 * 官网公开壳的顶栏。
 *
 * 服务端是 hash 路由，页面内锚点不能再占用 `#/` 命名空间，导航统一走滚动函数。
 */
import { computed } from 'vue'
import { FileDown, House } from '@aurora/shared/browser'
import { navigate } from '../router'

const props = withDefaults(
  defineProps<{
    /** 登录 / 设备确认页收掉站内导航，只留品牌和返回入口 */
    compact?: boolean
    /** 已经拿到安装包信息时由父级提供直接下载地址 */
    downloadHref?: string
  }>(),
  {
    compact: false,
    downloadHref: '',
  },
)

const hasDownload = computed(() => props.downloadHref !== '')

function scrollTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <header class="public-header">
    <button
      type="button"
      class="public-brand"
      aria-label="返回 Aurora 首页"
      @click="navigate('home')"
    >
      <span class="public-brand-mark aurora-mark" aria-hidden="true" />
      <span class="public-brand-name">Aurora</span>
      <span class="public-brand-sub">Center</span>
    </button>

    <nav v-if="!props.compact" class="public-nav" aria-label="官网导航">
      <button type="button" @click="scrollTo('capabilities')">能力</button>
      <button type="button" @click="scrollTo('security')">安全</button>
      <button type="button" @click="scrollTo('download')">下载</button>
    </nav>

    <span class="public-header-spacer" />

    <a
      v-if="hasDownload"
      class="public-header-download"
      :href="props.downloadHref"
      data-action="landing.header-download"
    >
      <FileDown :size="15" :stroke-width="1.8" aria-hidden="true" />
      下载 Windows 版
    </a>
    <button
      v-else-if="!props.compact"
      type="button"
      class="public-header-download"
      data-action="landing.header-download"
      @click="scrollTo('download')"
    >
      <FileDown :size="15" :stroke-width="1.8" aria-hidden="true" />
      下载
    </button>

    <button
      v-if="!props.compact"
      type="button"
      class="public-header-login"
      data-action="landing.login"
      @click="navigate('login')"
    >
      <House :size="15" :stroke-width="1.8" aria-hidden="true" />
      登录控制台
    </button>
  </header>
</template>

<style scoped>
.public-header {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 64px;
  padding: 0 clamp(20px, 4vw, 64px);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--center-hero-bg);
}

.public-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.public-brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}

.public-brand-name {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.public-brand-sub {
  color: var(--text-muted);
  font-size: 12px;
}

.public-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 18px;
}

.public-nav button {
  min-height: 36px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.public-nav button:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.public-header-spacer {
  flex: 1 1 auto;
}

.public-header-download,
.public-header-login {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 7px;
  font-size: var(--text-sm);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.public-header-download {
  border: none;
  background: var(--center-signal);
  color: var(--center-signal-ink);
  font-weight: 600;
}

.public-header-download:hover {
  background: var(--center-signal-hover);
}

.public-header-login {
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
}

.public-header-login:hover {
  background: var(--fill-2);
}

@media (max-width: 720px) {
  .public-header {
    min-height: 58px;
    padding: 0 16px;
  }

  .public-nav,
  .public-header-download {
    display: none;
  }

  .public-header-login {
    margin-left: auto;
  }

  .public-brand-sub {
    display: none;
  }
}
</style>
