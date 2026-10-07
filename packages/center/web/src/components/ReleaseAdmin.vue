<script setup lang="ts">
/** 管理端 Release 发布（docs/09 §10）。 */
import { onMounted, ref } from 'vue'
import type { CenterReleaseInfo } from '@aurora/shared'
import { api } from '../lib/api'
import { formatTime } from '../lib/format'

const current = ref<CenterReleaseInfo | null>(null)
const files = ref<File[]>([])
const loading = ref(true)
const uploading = ref(false)
const publishing = ref(false)
const error = ref('')
const message = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    current.value = (await api.admin.release()).current
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function pick(event: Event): void {
  files.value = [...((event.target as HTMLInputElement).files ?? [])]
}

async function uploadAndPublish(): Promise<void> {
  if (files.value.length === 0) return
  uploading.value = true
  error.value = ''
  message.value = ''
  try {
    for (const file of files.value) await api.admin.uploadRelease(file)
    publishing.value = true
    current.value = (await api.admin.publishRelease()).current
    files.value = []
    message.value = `已发布 v${current.value.version}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '发布失败'
  } finally {
    uploading.value = false
    publishing.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section class="ui-card release-admin" data-panel="release-admin">
    <header>
      <div>
        <h2>客户端更新</h2>
        <p>上传安装包、blockmap 与 latest.yml 后校验并原子发布。</p>
      </div>
      <button class="ui-btn" type="button" @click="load">刷新</button>
    </header>

    <p v-if="error" class="ui-error">{{ error }}</p>
    <p v-if="message" class="release-ok">{{ message }}</p>
    <p v-if="loading" class="release-loading">加载中…</p>

    <section v-if="current" class="release-current">
      <strong>当前版本 v{{ current.version }}</strong>
      <span>{{ formatTime(current.publishedAt) }}</span>
      <ul>
        <li v-for="file in current.files" :key="file.name">
          <span class="mono">{{ file.name }}</span>
          <span>{{ (file.size / 1024 / 1024).toFixed(1) }} MB</span>
        </li>
      </ul>
    </section>
    <p v-else-if="!loading" class="release-empty">还没有发布任何更新。</p>

    <div class="release-upload">
      <input type="file" multiple accept=".exe,.blockmap,.yml" @change="pick" />
      <button
        class="ui-btn ui-btn--primary"
        type="button"
        :disabled="files.length === 0 || uploading || publishing"
        @click="uploadAndPublish"
      >
        {{ uploading ? '上传中…' : publishing ? '校验发布中…' : '上传并发布' }}
      </button>
    </div>
    <p class="release-hint">必须是同一版本的安装包、对应 blockmap 和 latest.yml。</p>
  </section>
</template>

<style scoped>
.release-admin {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}

.release-admin header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
}

.release-admin h2 {
  margin: 0 0 var(--space-1);
}

.release-admin p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.release-current {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.release-current ul {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.release-current li,
.release-upload {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  justify-content: space-between;
}

.release-ok {
  color: var(--ok-text) !important;
}

.release-loading,
.release-empty,
.release-hint {
  color: var(--text-muted) !important;
}
</style>
