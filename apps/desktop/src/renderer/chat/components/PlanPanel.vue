<script setup lang="ts">
/**
 * 右栏「计划」面板（docs/06 §29 / docs/07 §2.3）。
 *
 * 数据源是主进程的 `<userData>/plans/<sessionId>/` 索引与 Markdown 文件。
 *
 * 设计（2026-11-21 重做）：**不再渲染垂直列表**。旧版「列表 + 预览」双区在窄右栏 /
 * 紧凑高度下会互相挤压（列表行被裁成半行），且标题 / 时间 / 状态在列表与预览头重复
 * 出现两遍。现在改为：
 * - 顶部 header（计划 / 数量 / 只读）；
 * - 只有 plans.length > 1 时才出现横向 chips 选择条；
 * - 其余空间全部给**单个阅读区**：标题 + meta + 唯一纵向滚动的 Markdown 正文。
 *
 * 只读设计：计划正文的修改走对话里的「继续完善」，不在这里编辑。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { PlanFileContent, PlanFileInfo, PlanFileStatus } from '@aurora/shared'
import { ClipboardList } from '@aurora/shared/browser'
import { renderMarkdown } from '@aurora/shared/browser'

const props = withDefaults(
  defineProps<{
    sessionId: string
    /** 计划状态版本号（useChat 每次计划状态变化递增）：变化时重拉列表 */
    version?: number
    /** 从计划卡「在侧边栏查看」点进来时，定位到这条计划 */
    focusPlanId?: string | null
  }>(),
  { version: 0, focusPlanId: null },
)

const emit = defineEmits<{ (event: 'title', title: string): void }>()

const plans = ref<PlanFileInfo[]>([])
const selectedId = ref('')
const content = ref<PlanFileContent | null>(null)
const loading = ref(false)
const contentLoading = ref(false)
const error = ref<string | null>(null)
const chipsEl = ref<HTMLElement | null>(null)
const previewBodyEl = ref<HTMLElement | null>(null)
let generation = 0
/** 上一次列表的第一条 id：用于「新计划置顶时自动选中新计划」 */
let lastTopId = ''
/** 已经应用过一次的 focusPlanId：避免状态刷新把用户手动选中的旧计划又拽回去 */
let lastAppliedFocusId: string | null = null

/**
 * 正文渲染时去掉开头的一级标题：标题已经在 preview header 显示，
 * 再让 Markdown 的 `# 标题` 出现在正文顶部就是同一句话重复两遍。
 */
const bodyMarkdown = computed(() => {
  const markdown = content.value?.markdown ?? ''
  return markdown.replace(/^\s*#\s+[^\r\n]*(?:\r?\n)+/, '')
})
const html = computed(() => (content.value === null ? '' : renderMarkdown(bodyMarkdown.value)))
const selectedIndex = computed(() => plans.value.findIndex((item) => item.id === selectedId.value))

const STATUS_LABEL: Record<PlanFileStatus, string> = {
  pending: '待批准',
  approved: '已批准',
  exited: '已退出',
  superseded: '已被取代',
  unknown: '历史',
}

function statusLabel(status: PlanFileStatus): string {
  return STATUS_LABEL[status] ?? status
}

/** chip 圆点与预览状态徽章共用三档语义色 */
function statusTone(status: PlanFileStatus): 'pending' | 'approved' | 'muted' {
  if (status === 'pending') return 'pending'
  if (status === 'approved') return 'approved'
  return 'muted'
}

function timeText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 选中 chip 滚进选择条可视区：只动选择条的 scrollLeft，不触发页面级滚动 */
async function scrollChipIntoView(id: string): Promise<void> {
  await nextTick()
  const container = chipsEl.value
  if (container === null) return
  const chip = container.querySelector<HTMLElement>(`[data-plan-id="${id}"]`)
  if (chip === null) return
  const box = container.getBoundingClientRect()
  const rect = chip.getBoundingClientRect()
  if (rect.left < box.left) container.scrollLeft -= box.left - rect.left + 4
  else if (rect.right > box.right) container.scrollLeft += rect.right - box.right + 4
}

async function loadContent(id: string, listToken?: number): Promise<void> {
  const targetSession = props.sessionId
  const token = listToken ?? (generation += 1)
  const changed = id !== selectedId.value
  selectedId.value = id
  if (changed) content.value = null
  contentLoading.value = true
  error.value = null
  try {
    const result = await window.aurora.plans.read({ sessionId: targetSession, planId: id })
    if (token !== generation || targetSession !== props.sessionId) return
    if (!result.ok) {
      error.value = result.message
      content.value = null
      return
    }
    error.value = null
    content.value = result.value
    if (changed) {
      await nextTick(() => {
        if (previewBodyEl.value !== null) previewBodyEl.value.scrollTop = 0
      })
    }
    await scrollChipIntoView(id)
  } catch (cause) {
    if (token !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    content.value = null
  } finally {
    if (token === generation) contentLoading.value = false
  }
}

async function loadList(): Promise<void> {
  const token = (generation += 1)
  const targetSession = props.sessionId
  loading.value = true
  error.value = null
  try {
    const result = await window.aurora.plans.list({ sessionId: targetSession })
    if (token !== generation || targetSession !== props.sessionId) return
    if (!result.ok) {
      error.value = result.message
      plans.value = []
      content.value = null
      selectedId.value = ''
      return
    }
    const previousTop = lastTopId
    plans.value = result.value
    lastTopId = result.value[0]?.id ?? ''
    // 标签条宽度固定 88px：标题只放「计划」，数量在面板头部显示
    emit('title', '计划')

    const ids = new Set(result.value.map((item) => item.id))
    const focusCandidate =
      props.focusPlanId !== null &&
      props.focusPlanId !== '' &&
      props.focusPlanId !== lastAppliedFocusId &&
      ids.has(props.focusPlanId)
        ? props.focusPlanId
        : null
    if (focusCandidate !== null) lastAppliedFocusId = focusCandidate

    // 优先级：计划卡定位 > 新计划置顶 > 当前选择 > 最新
    const preferred =
      focusCandidate ??
      (lastTopId !== '' && lastTopId !== previousTop ? lastTopId : null) ??
      (ids.has(selectedId.value) ? selectedId.value : null) ??
      result.value[0]?.id ??
      ''

    if (preferred === '') {
      selectedId.value = ''
      content.value = null
      return
    }

    const entry = result.value.find((item) => item.id === preferred)
    if (content.value?.id === preferred && entry !== undefined) {
      // 同一计划只是状态变了（批准 / 退出）：只更新徽章，保持正文滚动位置
      content.value = { ...content.value, status: entry.status }
      selectedId.value = preferred
      await scrollChipIntoView(preferred)
      return
    }
    await loadContent(preferred, token)
  } catch (cause) {
    if (token !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    plans.value = []
    content.value = null
    selectedId.value = ''
  } finally {
    if (token === generation) loading.value = false
  }
}

function select(id: string): void {
  if (id === selectedId.value) return
  void loadContent(id)
}

onMounted(() => {
  void loadList()
})

// 会话切换 / 计划状态变化 / 从计划卡定位：重拉列表（版本号由 useChat 维护）
watch(
  () => [props.sessionId, props.version] as const,
  () => {
    void loadList()
  },
)
watch(
  () => props.focusPlanId,
  (id) => {
    if (id === null || id === '' || !plans.value.some((item) => item.id === id)) return
    lastAppliedFocusId = id
    if (id !== selectedId.value) void loadContent(id)
  },
)
</script>

<template>
  <section class="plan-panel" data-field="chat.plan-panel">
    <div class="plan-top">
      <header class="panel-head">
        <ClipboardList :size="14" :stroke-width="1.7" aria-hidden="true" />
        <span class="panel-title">计划</span>
        <span class="panel-count tiny muted">{{ plans.length }}</span>
        <span class="grow" />
        <span class="tiny muted">只读</span>
      </header>

      <!--
        多计划选择条：横向 chips、不换行。只有一个计划时整行不渲染 ——
        这样面板里不会出现“列表标题 + 预览标题”两份重复的标题/时间/状态。
      -->
      <div
        v-if="plans.length > 1"
        ref="chipsEl"
        class="plan-selector"
        role="tablist"
        aria-label="计划文件"
        data-field="chat.plan-selector"
      >
        <button
          v-for="item in plans"
          :key="item.id"
          type="button"
          class="plan-chip"
          :class="{ active: item.id === selectedId }"
          role="tab"
          :aria-selected="item.id === selectedId"
          data-field="chat.plan-chip"
          :data-plan-id="item.id"
          :data-plan-status="item.status"
          :title="`${item.title} · ${statusLabel(item.status)}`"
          @click="select(item.id)"
        >
          <span class="plan-chip-dot" :class="`is-${statusTone(item.status)}`" aria-hidden="true" />
          <span class="plan-chip-title">{{ item.title }}</span>
        </button>
      </div>
    </div>

    <div class="plan-content">
      <p v-if="error !== null" class="panel-empty tiny" data-field="chat.plan-panel-error">
        {{ error }}
      </p>
      <p
        v-else-if="loading && plans.length === 0"
        class="panel-empty tiny muted"
        data-field="chat.plan-panel-loading"
      >
        正在读取计划…
      </p>
      <p
        v-else-if="plans.length === 0"
        class="panel-empty tiny muted"
        data-field="chat.plan-panel-empty"
      >
        还没有计划。在输入框输入 <span class="mono">/plan</span> 开始规划，提交后会在这里留档。
      </p>
      <p
        v-else-if="content === null && contentLoading"
        class="panel-empty tiny muted"
        data-field="chat.plan-panel-loading"
      >
        正在读取计划…
      </p>

      <template v-else-if="content !== null">
        <header class="preview-head" data-field="chat.plan-preview">
          <strong class="preview-title" data-field="chat.plan-preview-title">{{
            content.title
          }}</strong>
          <div class="preview-meta">
            <span class="tiny muted">{{ timeText(content.createdAt) }}</span>
            <span
              class="preview-status tiny"
              :class="`is-${statusTone(content.status)}`"
              data-field="chat.plan-preview-status"
              >{{ statusLabel(content.status) }}</span
            >
            <span class="tiny muted">{{ selectedIndex + 1 }} / {{ plans.length }}</span>
          </div>
        </header>
        <!-- 安全说明：先 renderMarkdown 转义再套白名单标记，禁止裸模型 HTML -->
        <!-- eslint-disable vue/no-v-html -->
        <div
          ref="previewBodyEl"
          class="preview-body md"
          data-field="chat.plan-preview-body"
          v-html="html"
        />
        <!-- eslint-enable vue/no-v-html -->
      </template>

      <p v-else class="panel-empty tiny muted" data-field="chat.plan-panel-empty-preview">
        选一条计划查看正文。
      </p>
    </div>
  </section>
</template>

<style scoped>
/*
 * 根容器：两行 grid（顶部组 + 内容区）。刻意不用 flex ——
 * 旧版「垂直列表 flex 子项 + 预览」会在内容长 / 高度紧时互相压缩，
 * 列表行被裁成半行（用户截图）。grid 的 `minmax(0, 1fr)` 明确由正文承担滚动。
 */
.plan-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.plan-top {
  min-width: 0;
  border-bottom: 1px solid var(--border-subtle);
}

.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 8px var(--space-3);
  color: var(--text-secondary);
}

.panel-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.panel-count {
  min-width: 16px;
  text-align: center;
}

/* ── 多计划选择条：横向滚动，不占多行 ── */
.plan-selector {
  display: flex;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  padding: 0 var(--space-2) 8px;
  scrollbar-width: thin;
}

.plan-chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(240px, 100%);
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.plan-chip:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.plan-chip.active {
  border-color: var(--accent-text);
  background: var(--fill-2);
  color: var(--text-primary);
}

.plan-chip-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--text-muted);
}

.plan-chip-dot.is-pending {
  background: var(--warning-text);
}

.plan-chip-dot.is-approved {
  background: var(--accent-text);
}

.plan-chip-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 内容区：preview header（auto）+ 正文（唯一滚动区） ── */
.plan-content {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.panel-empty {
  margin: 0;
  padding: var(--space-4) var(--space-3);
  line-height: 1.6;
}

.preview-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px var(--space-3) 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.preview-title {
  min-width: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  line-height: 1.35;
  color: var(--text-primary);
  /* 长标题换行而不是截断：窄栏下完整标题比省略号更有用 */
  overflow-wrap: anywhere;
}

.preview-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}

.preview-status {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-muted);
  line-height: 18px;
  white-space: nowrap;
}

.preview-status.is-pending {
  color: var(--warning-text);
  background: var(--warning-fill);
}

.preview-status.is-approved {
  color: var(--accent-text);
}

.preview-body {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: var(--space-2) var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  line-height: 1.65;
}

/* 代码块 / 表格在自己内部横滚，绝不把整个右栏撑出横向滚动条 */
.preview-body :deep(pre),
.preview-body :deep(table) {
  max-width: 100%;
  overflow-x: auto;
}
</style>
