<script setup lang="ts">
/**
 * 计划卡（docs/06 §29 / docs/07 §2.3）。
 *
 * 挂在**请求最后一条助手消息**的正文 / 图片 / 改动文件卡之后，承载 `submit_plan`
 * 提交的 Markdown 计划：
 * - 标题 + 状态徽章（待批准 / 已批准 / 已退出 / 历史计划）；
 * - 头部「在侧边栏查看」→ 右栏「计划」标签并定位这条文件；
 * - 底部三态动作：开始执行 / 继续完善 / 退出计划；
 * - 只在 `interactive && latest && 待批准` 时显示动作；流式中 / 批准中禁用。
 *
 * 正文渲染复用 `renderMarkdown`（先转义再套白名单标记，`html:false`），不存在裸模型 HTML。
 */
import { computed } from 'vue'
import type { SessionPlan } from '@aurora/shared'
import { ClipboardList, PanelRight } from '@aurora/shared/browser'
import { renderMarkdown } from '@aurora/shared/browser'
import AppButton from './AppButton.vue'

const props = withDefaults(
  defineProps<{
    /** `submit_plan` 的 toolCallId：计划卡 / 文件索引 / 批准请求三处对齐的键 */
    callId: string
    markdown: string
    /** 当前会话计划状态（可能还没水合；undefined = 按未进入处理） */
    state?: SessionPlan
    /** 是否为当前会话最后一条计划（只有它显示动作） */
    latest?: boolean
    /** 流式中 / 批准中：动作禁用 */
    busy?: boolean
    /** 历史回放 / 自动化页面传 false：只读展示，无动作 */
    interactive?: boolean
  }>(),
  { state: undefined, latest: false, busy: false, interactive: false },
)

const emit = defineEmits<{
  (event: 'approve', callId: string): void
  (event: 'revise', callId: string): void
  (event: 'exit'): void
  (event: 'open', callId: string): void
}>()

/** 安全渲染：输出已转义 + 白名单标记，绝不能换成裸 `v-html 模型原文` */
const html = computed(() => renderMarkdown(props.markdown))

const record = computed(() => props.state?.record)
const isCurrent = computed(() => record.value?.id === props.callId)
const active = computed(() => props.state?.active === true)
/**
 * 待批准判定不只看 record.id：刚提交后渲染层还没刷新计划状态，
 * 最新一条卡也必须能出现动作；真正批准时主进程会按 record.id 再校验一次。
 */
const pending = computed(
  () =>
    props.latest === true &&
    active.value &&
    (record.value === undefined ||
      record.value.id !== props.callId ||
      record.value.status === 'pending'),
)

const showActions = computed(() => props.interactive && pending.value && props.busy !== true)
const busyHint = computed(() => (props.busy ? '模型仍在整理本轮回复…' : ''))

const badge = computed<{ text: string; tone: 'pending' | 'ok' | 'muted' }>(() => {
  if (isCurrent.value) {
    if (record.value?.status === 'approved') return { text: '已批准', tone: 'ok' }
    if (record.value?.status === 'exited') return { text: '已退出', tone: 'muted' }
    return { text: '待批准', tone: 'pending' }
  }
  if (props.latest === true && active.value) return { text: '待批准', tone: 'pending' }
  return { text: '历史计划', tone: 'muted' }
})
</script>

<template>
  <section
    class="plan-card"
    data-field="chat.plan-card"
    :data-plan-id="callId"
    :data-plan-status="badge.tone"
  >
    <header class="plan-head">
      <ClipboardList class="plan-icon" :size="15" :stroke-width="1.7" aria-hidden="true" />
      <span class="plan-title">实施计划</span>
      <span class="plan-badge" :class="`is-${badge.tone}`">{{ badge.text }}</span>
      <span class="grow" />
      <button
        type="button"
        class="plan-open press"
        data-action="chat.plan-open"
        title="在右栏「计划」面板中查看 Markdown 文件"
        aria-label="在侧边栏查看计划"
        @click="emit('open', callId)"
      >
        <PanelRight :size="14" :stroke-width="1.7" aria-hidden="true" />
      </button>
    </header>

    <!-- 安全说明：正文先经 renderMarkdown 转义再套白名单标记（docs/07 安全基线） -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="plan-body md" v-html="html" />

    <footer v-if="props.interactive" class="plan-actions">
      <template v-if="showActions">
        <AppButton
          size="sm"
          variant="primary"
          data-action="chat.plan-approve"
          @click="emit('approve', callId)"
          >开始执行</AppButton
        >
        <AppButton
          size="sm"
          variant="secondary"
          data-action="chat.plan-revise"
          @click="emit('revise', callId)"
          >继续完善</AppButton
        >
        <AppButton size="sm" variant="ghost" data-action="chat.plan-exit" @click="emit('exit')"
          >退出计划</AppButton
        >
      </template>
      <p v-else-if="busyHint !== ''" class="plan-hint tiny muted">{{ busyHint }}</p>
      <p v-else-if="badge.tone === 'ok'" class="plan-hint tiny muted">
        计划已批准，执行轮已开始；可继续在对话里跟进。
      </p>
      <p v-else-if="badge.tone === 'muted'" class="plan-hint tiny muted">
        这条计划已不再可执行，正文仍保留在历史与「计划」面板中。
      </p>
    </footer>
  </section>
</template>

<style scoped>
.plan-card {
  margin-top: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  overflow: hidden;
}

.plan-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 8px var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.plan-icon {
  flex: 0 0 auto;
  color: var(--accent-text);
}

.plan-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
}

.plan-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 18px;
}

.plan-badge.is-pending {
  color: var(--warning-text);
  background: var(--warning-fill);
}

.plan-badge.is-ok {
  color: var(--accent-text);
  background: var(--fill-2);
}

.plan-badge.is-muted {
  color: var(--text-muted);
  background: var(--fill-2);
}

.plan-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.plan-open:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 长计划不把整条消息流撑成一面墙：内部滚动，标题与动作始终可见 */
.plan-body {
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-2) var(--space-3) var(--space-3);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.plan-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 8px var(--space-3);
  border-top: 1px solid var(--border-subtle);
  background: var(--fill-1);
}

.plan-hint {
  margin: 0;
}
</style>
