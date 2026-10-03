<script setup lang="ts">
/*
 * 右栏「文件」预览面板（2026-10-03，docs/07 §2.3）。
 *
 * 能力边界（与主进程 `file-preview.ts` 的口径一一对应）：
 * - 只能预览**发起会话边界根之内**的文件（越界主进程拒绝，文案原样展示）；
 * - 文本 2 MB / 图片 10 MB；文本超限截断显示并标记，图片超限拒绝；
 * - 二进制文件返回 `unsupported`（只给原因，不渲染乱码）。
 *
 * 刻意**不做**目录树 / 文件列表：渲染层没有 fs 能力，列目录要再开一条 IPC，
 * 而预览的主入口是「从消息 / 工具卡里看到路径 → 拿来预览」，路径输入 + 最近记录已够用。
 */
import { computed, ref } from 'vue'
import type { FilePreviewResult } from '@aurora/shared'
import { FileText, formatExactCount, renderMarkdown } from '@aurora/shared/browser'
import '@aurora/shared/browser/markdown/md.css'

const props = defineProps<{ sessionId: string }>()

const pathInput = ref('')
const loading = ref(false)
const error = ref('')
const current = ref<FilePreviewResult | null>(null)
/** 渲染后的 markdown html（`kind === 'markdown'` 时才有值） */
const markdownHtml = ref('')

const RECENT_KEY = 'aurora.chat.previewRecent'
const RECENT_LIMIT = 8
const recent = ref<string[]>(loadRecent())

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function saveRecent(path: string): void {
  recent.value = [path, ...recent.value.filter((item) => item !== path)].slice(0, RECENT_LIMIT)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
  } catch {
    /* localStorage 不可用（隐私模式等）只是丢掉最近记录，不影响预览 */
  }
}

const bytesText = computed(() =>
  current.value === null ? '' : formatExactCount(current.value.bytes),
)

async function open(path: string): Promise<void> {
  const trimmed = path.trim()
  if (trimmed === '' || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await window.aurora.preview.read({ sessionId: props.sessionId, path: trimmed })
    if (!result.ok) {
      error.value = result.message
      return
    }
    current.value = result.value
    markdownHtml.value =
      result.value.kind === 'markdown' && result.value.content !== undefined
        ? renderMarkdown(result.value.content)
        : ''
    saveRecent(result.value.path)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') void open(pathInput.value)
}
</script>

<template>
  <div class="fp" data-field="chat.file-preview">
    <div class="fp-input-row">
      <input
        v-model="pathInput"
        class="fp-input"
        type="text"
        placeholder="输入工作目录内的文件路径…"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="fp-go"
        :disabled="loading || pathInput.trim() === ''"
        @click="open(pathInput)"
      >
        {{ loading ? '…' : '预览' }}
      </button>
    </div>

    <p v-if="error !== ''" class="fp-error tiny" data-field="chat.file-preview-error">
      {{ error }}
    </p>

    <div v-if="current !== null" class="fp-body">
      <p class="fp-meta tiny muted">
        <span class="fp-kind" :data-kind="current.kind">{{ current.kind }}</span>
        {{ bytesText }} 字节<template v-if="current.truncated === true">（已截断）</template>
      </p>
      <img
        v-if="current.kind === 'image' && current.dataUrl !== undefined"
        class="fp-image"
        :src="current.dataUrl"
        alt="文件预览"
      />
      <!-- markdown 走 shared 渲染器（html:false 白名单，与消息正文同一条安全基线） -->
      <!-- eslint-disable-next-line vue/no-v-html -- 渲染器输出已转义 + 白名单（docs/07 §5） -->
      <div v-else-if="current.kind === 'markdown'" class="md fp-markdown" v-html="markdownHtml" />
      <pre v-else-if="current.kind === 'text'" class="fp-text">{{ current.content }}</pre>
      <p v-else class="tiny muted">{{ current.note ?? '该文件类型不支持预览' }}</p>
    </div>

    <div v-if="recent.length > 0" class="fp-recent">
      <p class="tiny muted fp-recent-title">最近预览</p>
      <button
        v-for="item in recent"
        :key="item"
        type="button"
        class="fp-recent-item tiny"
        :title="item"
        @click="open(item)"
      >
        <FileText :size="12" :stroke-width="1.7" aria-hidden="true" />
        <span class="fp-recent-name">{{ item.split(/[\\/]/).pop() }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.fp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  padding: var(--space-2);
}

.fp-input-row {
  display: flex;
  gap: var(--space-1);
  flex: 0 0 auto;
}

.fp-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-xs);
}

.fp-input:focus {
  outline: none;
  border-color: var(--border-strong);
}

.fp-go {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-3);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-go:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-go:disabled {
  opacity: 0.5;
  cursor: default;
}

.fp-error {
  margin: 0;
  color: var(--status-error);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.fp-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow: hidden;
}

.fp-meta {
  margin: 0;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.fp-kind {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.fp-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
  align-self: center;
}

.fp-markdown {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
}

.fp-text {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  overflow: auto;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.fp-recent {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fp-recent-title {
  margin: 0;
}

.fp-recent-item {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}

.fp-recent-item:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-recent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
