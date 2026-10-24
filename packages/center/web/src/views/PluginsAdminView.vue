<script setup lang="ts">
/**
 * 插件管理（#/pluginsAdmin，docs/14 §4）：只对管理员开放。
 *
 * 上传 = 先 staging（校验清单 / 包内路径 / sha256）→ 再显式发布；
 * 同版本不可覆盖，删除某个版本后 latestVersion 自动回落到剩余最高版本。
 */
import { onMounted, ref } from 'vue'
import { ArrowUp, Puzzle, Trash2 } from '@aurora/shared/browser'
import { api, type CenterPluginEntry } from '../lib/api'
import { formatTime } from '../lib/format'

const entries = ref<CenterPluginEntry[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')

const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const changelog = ref('')
const uploading = ref(false)
const staged = ref<{ token: string; plugin: { id: string; name: string; version: string } } | null>(
  null,
)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await api.admin.plugins()
    entries.value = result.entries
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function pickFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  selectedFile.value = file
  staged.value = null
  notice.value = ''
  error.value = ''
}

async function upload(): Promise<void> {
  if (selectedFile.value === null || uploading.value) return
  uploading.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.admin.uploadPlugin(selectedFile.value)
    staged.value = { token: result.token, plugin: result.plugin }
    notice.value = `已上传 ${result.plugin.name} ${result.plugin.version}，确认后发布`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '上传失败'
  } finally {
    uploading.value = false
  }
}

async function publish(): Promise<void> {
  if (staged.value === null || uploading.value) return
  uploading.value = true
  error.value = ''
  try {
    const result = await api.admin.publishPlugin(staged.value.token, changelog.value)
    notice.value = `已发布 ${result.entry.name} v${result.entry.latestVersion}`
    staged.value = null
    selectedFile.value = null
    changelog.value = ''
    if (fileInput.value !== null) fileInput.value.value = ''
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '发布失败'
  } finally {
    uploading.value = false
  }
}

async function removeVersion(entry: CenterPluginEntry, version: string): Promise<void> {
  if (!window.confirm(`撤回 ${entry.name} v${version}？已安装的客户端不受影响。`)) return
  error.value = ''
  try {
    await api.admin.deletePlugin(entry.id, version)
    notice.value = `已撤回 ${entry.id} v${version}`
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '撤回失败'
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="plugins-admin" data-route="pluginsAdmin">
    <header class="page-head">
      <div>
        <h1>插件管理</h1>
        <p class="muted">
          上传 .aurora-plugin / .zip 后需确认发布。市场不签名，安装前请确认来源可信。
        </p>
      </div>
      <a class="to-market" href="#/marketplace">查看市场</a>
    </header>

    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-else-if="notice" class="banner ok">{{ notice }}</p>

    <section class="upload-card">
      <h2>发布新版本</h2>
      <div class="upload-row">
        <input ref="fileInput" type="file" accept=".zip,.aurora-plugin" @change="pickFile" />
        <button type="button" :disabled="selectedFile === null || uploading" @click="upload">
          <ArrowUp :size="14" :stroke-width="1.8" aria-hidden="true" />
          {{ uploading ? '处理中…' : '上传校验' }}
        </button>
      </div>

      <div v-if="staged !== null" class="staged">
        <p>
          待发布：<strong>{{ staged.plugin.name }}</strong>
          <span class="mono">v{{ staged.plugin.version }}</span>
        </p>
        <textarea
          v-model="changelog"
          rows="3"
          placeholder="更新说明（可选，最多 4000 字）"
        ></textarea>
        <button type="button" class="primary" :disabled="uploading" @click="publish">
          确认发布
        </button>
      </div>
    </section>

    <section class="list-card">
      <h2>已发布插件</h2>
      <p v-if="loading" class="muted">正在读取…</p>
      <p v-else-if="entries.length === 0" class="empty">
        <Puzzle :size="20" :stroke-width="1.5" aria-hidden="true" />
        市场暂无插件。
      </p>
      <article
        v-for="entry in entries"
        :key="entry.id"
        class="plugin-row"
        :data-plugin-id="entry.id"
      >
        <div class="row-head">
          <div>
            <strong>{{ entry.name }}</strong>
            <span class="mono muted"> {{ entry.id }}</span>
          </div>
          <span class="muted">
            最新 v{{ entry.latestVersion }} · 下载 {{ entry.downloads }} · 更新
            {{ formatTime(entry.updatedAt) }}
          </span>
        </div>
        <ul class="version-list">
          <li v-for="version in entry.versions" :key="version.version">
            <span class="mono">v{{ version.version }}</span>
            <span class="muted"> {{ Math.ceil(version.size / 1024) }} KB </span>
            <span class="checksum mono" :title="version.sha256">
              {{ version.sha256.slice(0, 12) }}…
            </span>
            <button type="button" class="danger" @click="removeVersion(entry, version.version)">
              <Trash2 :size="12" :stroke-width="1.8" aria-hidden="true" />
              撤回
            </button>
          </li>
        </ul>
      </article>
    </section>
  </section>
</template>

<style scoped>
.plugins-admin {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  max-width: 960px;
  margin: 0 auto;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
}

.page-head h1 {
  margin: 0 0 4px;
  font-size: var(--text-xl);
}

.muted {
  color: var(--text-muted);
  font-size: var(--text-sm);
  margin: 0;
}

.to-market {
  color: var(--aurora-blue);
  font-size: var(--text-sm);
  text-decoration: none;
}

.banner {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.banner.error {
  background: var(--error-fill);
  color: var(--error-text);
}

.banner.ok {
  background: var(--ok-fill);
  color: var(--ok-text);
}

.upload-card,
.list-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
}

.upload-card h2,
.list-card h2 {
  margin: 0;
  font-size: var(--text-md);
}

.upload-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

button:disabled {
  opacity: 0.5;
}

button.primary {
  background: var(--aurora-blue);
  border-color: var(--aurora-blue);
  color: #fff;
  align-self: flex-start;
}

button.danger {
  margin-left: auto;
  color: var(--error-text);
}

.staged {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
}

.staged p {
  margin: 0;
  font-size: var(--text-sm);
}

.staged textarea {
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-sm);
  resize: vertical;
}

.empty {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.plugin-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.row-head .muted {
  font-size: var(--text-xs);
}

.version-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.version-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}

.checksum {
  color: var(--text-muted);
}
</style>
