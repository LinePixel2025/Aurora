<script setup lang="ts">
/**
 * 插件市场（#/marketplace，docs/14 §4）：公开浏览与下载，不要求登录。
 *
 * 安装动作在桌面客户端里完成（设置 → 插件 → 市场）；网页端只负责发现与下载。
 */
import { computed, onMounted, ref } from 'vue'
import { FileDown, Puzzle, Search } from '@aurora/shared/browser'
import { api, type CenterPluginEntry } from '../lib/api'
import { formatTime } from '../lib/format'

const entries = ref<CenterPluginEntry[]>([])
const total = ref(0)
const query = ref('')
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await api.marketplace({ q: query.value.trim(), limit: 50 })
    entries.value = result.entries
    total.value = result.total
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

const heading = computed(() =>
  total.value === 0 ? '插件市场' : `插件市场 · ${total.value} 个插件`,
)

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="market" data-route="marketplace">
    <header class="market-head">
      <div>
        <h1>{{ heading }}</h1>
        <p class="muted">
          插件为 Aurora 增加 Agent 工具、面板与主题。安装前请确认来源可信：插件以你的用户权限运行。
        </p>
      </div>
      <label class="search">
        <Search :size="14" :stroke-width="1.8" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          placeholder="搜索名称 / 作者 / 描述"
          @keydown.enter="load"
        />
        <button type="button" @click="load">搜索</button>
      </label>
    </header>

    <p v-if="error" class="market-error">{{ error }}</p>
    <p v-else-if="loading" class="muted">正在读取市场…</p>
    <p v-else-if="entries.length === 0" class="market-empty">
      <Puzzle :size="22" :stroke-width="1.5" aria-hidden="true" />
      市场暂无插件。
    </p>

    <div v-else class="market-grid">
      <article
        v-for="entry in entries"
        :key="entry.id"
        class="market-card"
        :data-plugin-id="entry.id"
      >
        <div class="card-head">
          <img
            v-if="entry.iconUrl"
            class="card-icon"
            :src="entry.iconUrl"
            :alt="`${entry.name} 图标`"
          />
          <span v-else class="card-icon card-icon-fallback">
            <Puzzle :size="18" :stroke-width="1.6" aria-hidden="true" />
          </span>
          <div class="card-title">
            <h2>{{ entry.name }}</h2>
            <span class="muted mono">{{ entry.id }}</span>
          </div>
          <span class="card-version mono">v{{ entry.latestVersion }}</span>
        </div>

        <p class="card-summary">{{ entry.summary }}</p>

        <dl class="card-meta">
          <div>
            <dt>作者</dt>
            <dd>{{ entry.author }}</dd>
          </div>
          <div v-if="entry.license">
            <dt>许可</dt>
            <dd>{{ entry.license }}</dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd>{{ formatTime(entry.updatedAt) }}</dd>
          </div>
          <div>
            <dt>下载</dt>
            <dd>{{ entry.downloads }}</dd>
          </div>
        </dl>

        <div class="card-foot">
          <span class="version-list mono">
            {{ entry.versions.map((item) => item.version).join(' · ') }}
          </span>
          <a
            class="download"
            :href="api.pluginDownloadUrl(entry.id)"
            :download="`${entry.id}-${entry.latestVersion}.aurora-plugin`"
          >
            <FileDown :size="14" :stroke-width="1.8" aria-hidden="true" />
            下载安装包
          </a>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.market {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  max-width: 1100px;
  margin: 0 auto;
}

.market-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.market-head h1 {
  margin: 0 0 4px;
  font-size: var(--text-xl);
}

.muted {
  color: var(--text-muted);
  font-size: var(--text-sm);
  margin: 0;
}

.search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--bg-raised);
}

.search input {
  width: 220px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.search button {
  padding: 3px 12px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.market-error {
  color: var(--error-text);
  font-size: var(--text-sm);
}

.market-empty {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5);
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-muted);
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-3);
}

.market-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.card-icon {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  object-fit: cover;
}

.card-icon-fallback {
  display: grid;
  place-items: center;
  background: var(--fill-2);
  color: var(--text-secondary);
}

.card-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.card-title h2 {
  margin: 0;
  font-size: var(--text-md);
}

.card-title .mono {
  font-size: var(--text-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-version {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.card-summary {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.card-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px var(--space-3);
  margin: 0;
  font-size: var(--text-xs);
}

.card-meta div {
  display: flex;
  gap: 6px;
}

.card-meta dt {
  color: var(--text-muted);
}

.card-meta dd {
  margin: 0;
  color: var(--text-secondary);
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.version-list {
  color: var(--text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
  color: #fff;
  font-size: var(--text-xs);
  text-decoration: none;
  white-space: nowrap;
}
</style>
