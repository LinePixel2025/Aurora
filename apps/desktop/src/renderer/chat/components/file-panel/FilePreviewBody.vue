<script setup lang="ts">
/**
 * 文件预览正文（docs/07 §2.3，2026-11-12）：预览头 + 四类正文 + Office 双视图 + 信息卡。
 *
 * 安全基线：markdown 一律由父组件经 `renderMarkdown()`（html:false 白名单）渲染后传进来，
 * 这里只负责 `v-html` 那份**已转义**的产物；OfficeCLI 的 html 产物永不进这条路径。
 * 版式图只能是 `<img src="data:image/png;base64,…">` —— 生产 CSP 的 `object-src 'none'`
 * 会挡掉 embed / object / iframe-blob。
 */
import { computed } from 'vue'
import type { FileLayoutManifest, FileLayoutPage, FilePreviewResult } from '@aurora/shared'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FolderOpen,
  LayoutTemplate,
  LoaderCircle,
  ArrowLeft,
} from '@aurora/shared/browser'
import FileKindIcon from './FileKindIcon.vue'
import { fileTypeMetaOf, formatFileBytes, formatFileTime } from './fileTypeMeta'

const props = defineProps<{
  current: FilePreviewResult | null
  /** 已渲染的 markdown html（markdown 与 document 正文共用） */
  markdownHtml: string
  error: string
  loading: boolean
  layoutMode: 'body' | 'layout'
  layout: FileLayoutManifest | null
  layoutPage: FileLayoutPage | null
  layoutLoading: boolean
  layoutError: string
  opening: boolean
  openError: string
}>()

const emit = defineEmits<{
  exit: []
  open: [mode: 'default' | 'reveal']
  mode: [mode: 'body' | 'layout']
  page: [index: number]
  retryLayout: []
}>()

const fileName = computed(() => {
  const path = props.current?.path ?? ''
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
})

const meta = computed(() => fileTypeMetaOf(fileName.value))
const bytesText = computed(() => formatFileBytes(props.current?.bytes ?? 0))
const mtimeText = computed(() => formatFileTime(props.current?.mtimeMs))
const warnings = computed(() => props.current?.document?.warnings ?? [])

const pageIndex = computed(() => props.layoutPage?.index ?? 0)
const pageCount = computed(() => props.layout?.pageCount ?? 0)
const pageLabel = computed(
  () => props.layout?.pages.find((page) => page.index === pageIndex.value)?.label ?? '',
)
const canPrev = computed(() => pageIndex.value > 0)
const canNext = computed(() => pageCount.value > 0 && pageIndex.value < pageCount.value - 1)
/** 版式钮不可用的原因直接写进 title：不要让用户点了才知道为什么不行 */
const layoutHint = computed(() => props.current?.layoutUnavailableReason ?? '')
</script>

<template>
  <div class="fp-body">
    <div class="fp-preview-head">
      <div class="fp-head-row">
        <button type="button" class="fp-exit" data-field="chat.file-exit" @click="emit('exit')">
          <ArrowLeft :size="12" :stroke-width="1.8" aria-hidden="true" />
          返回列表
        </button>
        <span class="fp-title" :title="props.current?.path ?? ''">{{ fileName }}</span>
        <button
          v-if="props.current !== null"
          type="button"
          class="fp-open"
          title="用系统默认程序打开"
          :disabled="props.opening"
          @click="emit('open', 'default')"
        >
          <ExternalLink :size="13" :stroke-width="1.8" aria-hidden="true" />
          打开
        </button>
      </div>

      <div v-if="props.current !== null" class="fp-meta">
        <span class="fp-kind" :data-tone="meta.tone" :data-kind="props.current.kind">
          {{ meta.label }}
        </span>
        <span class="fp-meta-item">{{ bytesText }}</span>
        <span v-if="mtimeText !== ''" class="fp-meta-item fp-meta-time">{{ mtimeText }}</span>
        <span v-if="props.current.truncated === true" class="fp-meta-flag">已截断</span>
      </div>

      <div v-if="props.current?.kind === 'document'" class="fp-viewswitch" role="group">
        <button
          type="button"
          class="fp-view"
          :class="{ active: props.layoutMode === 'body' }"
          :aria-pressed="props.layoutMode === 'body'"
          @click="emit('mode', 'body')"
        >
          正文
        </button>
        <button
          type="button"
          class="fp-view"
          :class="{ active: props.layoutMode === 'layout' }"
          :disabled="props.current.layoutAvailable !== true"
          :title="props.current.layoutAvailable === true ? '看真实排版' : layoutHint"
          :aria-pressed="props.layoutMode === 'layout'"
          @click="emit('mode', 'layout')"
        >
          <LayoutTemplate :size="12" :stroke-width="1.8" aria-hidden="true" />
          版式
        </button>
      </div>
    </div>

    <p v-if="props.error !== ''" class="fp-error" data-field="chat.file-preview-error">
      {{ props.error }}
    </p>

    <p v-if="props.layoutError !== ''" class="fp-warn">
      {{ props.layoutError }}
      <button type="button" class="fp-link" @click="emit('retryLayout')">重试</button>
    </p>

    <div v-if="props.loading && props.current === null" class="fp-loading">
      <LoaderCircle class="fp-spin" :size="18" :stroke-width="1.8" aria-hidden="true" />
      正在读取…
    </div>

    <template v-if="props.current !== null">
      <img
        v-if="props.current.kind === 'image' && props.current.dataUrl !== undefined"
        class="fp-image"
        :src="props.current.dataUrl"
        alt="文件预览"
      />

      <!-- eslint-disable vue/no-v-html -- 渲染器输出已转义 + 白名单（docs/07 §5）；
           用块级开关而不是 next-line：prettier 会把这行拆成多行，next-line 就指不到 v-html 了 -->
      <div
        v-else-if="props.current.kind === 'markdown'"
        class="md fp-markdown"
        v-html="props.markdownHtml"
      />
      <!-- eslint-enable vue/no-v-html -->

      <pre v-else-if="props.current.kind === 'text'" class="fp-text">{{
        props.current.content
      }}</pre>

      <template v-else-if="props.current.kind === 'document'">
        <div v-if="props.layoutMode === 'layout'" class="fp-layout">
          <div v-if="props.layoutPage === null" class="fp-loading">
            <LoaderCircle class="fp-spin" :size="18" :stroke-width="1.8" aria-hidden="true" />
            {{ props.layoutLoading ? '正在渲染版式…' : '版式尚未就绪' }}
          </div>
          <img
            v-else
            class="fp-page"
            :src="props.layoutPage.dataUrl"
            :alt="pageLabel === '' ? `第 ${pageIndex + 1} 页` : pageLabel"
          />
          <div class="fp-pager">
            <button
              type="button"
              class="fp-mini"
              title="上一页"
              :disabled="!canPrev || props.layoutLoading"
              @click="emit('page', pageIndex - 1)"
            >
              <ChevronUp :size="14" :stroke-width="1.8" aria-hidden="true" />
            </button>
            <span class="fp-pager-text">
              第 {{ pageIndex + 1 }} / {{ pageCount }} 页<template v-if="pageLabel !== ''">
                · {{ pageLabel }}</template
              >
            </span>
            <button
              type="button"
              class="fp-mini"
              title="下一页"
              :disabled="!canNext || props.layoutLoading"
              @click="emit('page', pageIndex + 1)"
            >
              <ChevronDown :size="14" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </div>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- 同上：正文经 renderMarkdown 白名单渲染 -->
        <div v-else class="md fp-markdown" v-html="props.markdownHtml" />
        <p v-if="warnings.length > 0" class="fp-warn">{{ warnings.join('；') }}</p>
      </template>

      <div v-else class="fp-infocard">
        <FileKindIcon :name="fileName" :size="20" :box="32" />
        <p class="fp-card-name" :title="props.current.path">{{ fileName }}</p>
        <p class="fp-card-note">{{ props.current.note ?? '该文件类型不支持预览' }}</p>
        <dl class="fp-card-meta">
          <dt>类型</dt>
          <dd>{{ meta.label }}</dd>
          <dt>大小</dt>
          <dd>{{ bytesText }}</dd>
          <dt>修改时间</dt>
          <dd>{{ mtimeText === '' ? '未知' : mtimeText }}</dd>
        </dl>
        <div class="fp-card-actions">
          <button
            type="button"
            class="fp-card-btn primary"
            :disabled="props.opening"
            @click="emit('open', 'default')"
          >
            <ExternalLink :size="13" :stroke-width="1.8" aria-hidden="true" />
            用默认程序打开
          </button>
          <button
            type="button"
            class="fp-card-btn"
            :disabled="props.opening"
            @click="emit('open', 'reveal')"
          >
            <FolderOpen :size="13" :stroke-width="1.8" aria-hidden="true" />
            在资源管理器中显示
          </button>
        </div>
        <p v-if="props.openError !== ''" class="fp-error">{{ props.openError }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fp-body {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow: hidden;
}

.fp-preview-head {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.fp-head-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.fp-exit {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-3);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-exit:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: var(--text-base);
}

.fp-open {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-open:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-open:disabled {
  opacity: 0.55;
  cursor: default;
}

.fp-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.fp-kind {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  color: var(--fp-tone, var(--text-secondary));
  background: color-mix(in srgb, var(--fp-tone, var(--text-muted)) 14%, transparent);
}

.fp-meta-item {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.fp-meta-flag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--status-unread);
}

/* ── 正文 / 版式 分段控件 ── */
.fp-viewswitch {
  flex: 0 0 auto;
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
}

.fp-view {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-view:hover:not(:disabled):not(.active) {
  color: var(--text-secondary);
}

.fp-view.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.fp-view:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ── 正文区 ── */
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
  min-width: 0;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  /**
   * `anywhere` 是**布局护栏**而不只是排版偏好：长 URL / 长标识符会把整栏的
   * min-content 撑大（外层 grid 轨道的下限就是它），表现为「正文被窗口右缘切断、
   * 工具条按钮整排消失」。`anywhere` 让这些串可断行，min-content 随即塌回单字符。
   * 代码块不受影响（`pre` 是 `white-space: pre` + `overflow-x: auto`，自己横滚）。
   */
  overflow-wrap: anywhere;
}

.fp-text {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  margin: 0;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.fp-layout {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow: auto;
}

.fp-page {
  flex: 0 0 auto;
  width: 100%;
  height: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  background: var(--bg-raised);
}

.fp-pager {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-width: 0;
}

.fp-pager-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.fp-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  cursor: pointer;
}

.fp-mini:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-mini:disabled {
  color: var(--text-muted);
  opacity: 0.55;
  cursor: default;
}

/* ── 信息卡（不支持预览时的出路） ── */
.fp-infocard {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
}

.fp-card-name {
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: var(--text-base);
}

.fp-card-note {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.fp-card-meta {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px var(--space-2);
  margin: 0;
  min-width: 0;
  font-size: var(--text-xs);
}

.fp-card-meta dt {
  color: var(--text-muted);
}

.fp-card-meta dd {
  margin: 0;
  min-width: 0;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.fp-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
}

.fp-card-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-card-btn:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-card-btn.primary {
  border-color: transparent;
  background: var(--fill-3);
  color: var(--text-primary);
}

.fp-card-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ── 状态行 ── */
.fp-loading {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.fp-spin {
  animation: fp-rotate 0.9s linear infinite;
}

@keyframes fp-rotate {
  to {
    transform: rotate(360deg);
  }
}

.fp-error {
  flex: 0 0 auto;
  margin: 0;
  color: var(--status-error);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.fp-warn {
  flex: 0 0 auto;
  margin: 0;
  color: var(--status-unread);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.fp-link {
  padding: 0 4px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--accent-text);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-link:hover {
  background: var(--fill-2);
}

@media (prefers-reduced-motion: reduce) {
  .fp-spin {
    animation: none;
  }
}

/* 窄栏：修改时间先让位，类型 / 大小与「打开」钮恒在 */
@container (max-width: 320px) {
  .fp-meta-time {
    display: none;
  }

  .fp-open {
    padding: 0 6px;
  }
}
</style>
