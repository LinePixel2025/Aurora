<script setup lang="ts">
/**
 * `task` 子代理卡（只读镜像，与桌面端子代理视图同一份信息组织）。
 *
 * 子代理的过程不落会话存储，`SubagentSnapshot` 是它唯一的对外可见形态：卡头给
 * 状态 / 权限 / 步骤数 / 耗时，展开体按「紧凑轨迹（步骤时间线 + 报告）→ 只读对话」
 * 两层给出全过程。**没有任何输入或干预入口**：子代理的生死跟着父请求，
 * 要中止就中止父请求（卡片底部把这条口径如实写出来）。
 */
import { computed, ref } from 'vue'
import type { SubagentSnapshot, SubagentStep } from '@aurora/shared'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  FilePenLine,
  LoaderCircle,
  ShieldCheck,
} from '@aurora/shared/browser'
import { toolIconOf } from '@aurora/shared/browser'
import { subagentStatusLabel } from '../../lib/format'

const props = defineProps<{ snapshot: SubagentSnapshot }>()

const expanded = ref(false)
/** 展开了参数 / 结果正文的工具调用 id（默认收起：先看清「做了什么」，细节再点开） */
const openedTools = ref<string[]>([])

const statusLabel = computed(() => subagentStatusLabel(props.snapshot.status))
/** 权限档可缺省（老快照），一律按只读显示 —— 与桌面端同口径 */
const writeGranted = computed(() => props.snapshot.permission === 'write')
const description = computed(() => {
  const text = props.snapshot.description.trim()
  return text === '' ? '子代理' : text
})
const elapsedText = computed(() => elapsedLabel(props.snapshot))
const messages = computed(() => props.snapshot.messages ?? [])
const reportText = computed(() => props.snapshot.report ?? '')

/**
 * 最终报告落在**最后一条有正文的助手消息**上：`report` 就是所有正文增量的拼接，
 * 标出它让「回传给主代理的就是这一段」在版面上可见（不在正文之外另起一段）。
 */
const reportMessageId = computed(() => {
  const list = messages.value
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message !== undefined && message.role === 'assistant' && (message.text ?? '') !== '') {
      return message.id
    }
  }
  return ''
})

function elapsedLabel(snapshot: SubagentSnapshot): string {
  const ms = Math.max(0, (snapshot.endedAt ?? Date.now()) - snapshot.startedAt)
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

/** 文本步骤只留首行摘录（轨迹是一眼扫过的，不堆整段正文） */
function stepLabel(step: SubagentStep): string {
  if (step.kind === 'tool') return step.name ?? '工具'
  return (step.text ?? '').replace(/\s+/g, ' ').trim()
}

function stateLabel(state: 'running' | 'success' | 'error'): string {
  if (state === 'running') return '执行中'
  return state === 'error' ? '失败' : '完成'
}

function isToolOpen(id: string): boolean {
  return openedTools.value.includes(id)
}

function toggleTool(id: string): void {
  openedTools.value = isToolOpen(id)
    ? openedTools.value.filter((item) => item !== id)
    : [...openedTools.value, id]
}
</script>

<template>
  <article class="subagent" :class="`s-${snapshot.status}`" data-field="chat.task-card">
    <header class="head">
      <button
        type="button"
        class="head-main"
        data-action="chat.subagent-toggle"
        :aria-expanded="expanded"
        :title="expanded ? '收起子代理详情' : '展开子代理详情'"
        @click="expanded = !expanded"
      >
        <ChevronDown class="chevron" :class="{ open: expanded }" :size="14" aria-hidden="true" />
        <Bot class="head-icon" :size="14" aria-hidden="true" />
        <span class="status">{{ statusLabel }}</span>
        <span class="desc">{{ description }}</span>
        <span class="perm" :class="writeGranted ? 'write' : 'read'" data-field="chat.subagent-perm">
          <component
            :is="writeGranted ? FilePenLine : ShieldCheck"
            :size="11"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          {{ writeGranted ? '可读写' : '只读' }}
        </span>
        <span class="grow" />
        <span class="steps-count">{{ snapshot.toolCalls }} 步</span>
        <Clock class="head-clock" :size="12" :stroke-width="1.6" aria-hidden="true" />
        <span class="elapsed">{{ elapsedText }}</span>
      </button>
    </header>

    <!-- 运行中的不定长进度：滑动块只表达"还在动"，不冒充精确进度（步骤总数不可预知） -->
    <div
      v-if="snapshot.status === 'running'"
      class="track"
      data-field="chat.subagent-progress"
      role="progressbar"
      aria-label="子代理运行中"
    >
      <i class="track-bar" />
    </div>

    <!-- 展开体随内容增长（运行中还在长），因此只做淡入，不做高度动画 -->
    <Transition name="fade">
      <div v-if="expanded" class="body">
        <ol v-if="snapshot.steps.length > 0" class="steps">
          <li
            v-for="step in snapshot.steps"
            :key="step.id"
            class="step"
            :class="[step.kind, step.state ?? 'done']"
          >
            <span class="step-mark" aria-hidden="true">
              <component
                :is="step.kind === 'tool' ? toolIconOf(step.name ?? '') : Bot"
                :size="12"
                :stroke-width="1.7"
              />
            </span>
            <span v-if="step.kind === 'tool'" class="step-name mono">{{
              step.name ?? '工具'
            }}</span>
            <span v-else class="step-text">{{ stepLabel(step) }}</span>
            <span v-if="step.summary !== undefined" class="step-summary">{{ step.summary }}</span>
            <LoaderCircle
              v-if="step.kind === 'tool' && step.state === 'running'"
              class="spin icon-running"
              :size="12"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            <CircleCheck
              v-else-if="step.kind === 'tool' && step.state === 'success'"
              class="icon-ok"
              :size="12"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            <CircleX
              v-else-if="step.kind === 'tool' && step.state === 'error'"
              class="icon-err"
              :size="12"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            <Check v-else-if="step.kind === 'tool'" class="icon-ok" :size="11" aria-hidden="true" />
          </li>
        </ol>
        <p v-else class="note">等待子代理产出…</p>

        <template v-if="reportText !== ''">
          <span class="label">报告</span>
          <pre class="report" data-field="chat.subagent-report">{{ reportText }}</pre>
        </template>

        <div v-if="messages.length > 0" class="conv" data-field="chat.subagent-conversation">
          <div v-for="message in messages" :key="message.id" class="turn" :class="message.role">
            <template v-if="message.role === 'user'">
              <span class="role">主代理</span>
              <p class="bubble user">{{ message.text }}</p>
            </template>

            <template v-else-if="message.role === 'assistant'">
              <span class="role">
                <Bot :size="11" :stroke-width="1.8" aria-hidden="true" />
                子代理
                <span v-if="message.id === reportMessageId" class="report-tag">最终报告</span>
              </span>
              <p v-if="(message.text ?? '') !== ''" class="assistant-text">{{ message.text }}</p>
              <article
                v-for="call in message.toolCalls ?? []"
                :key="call.id"
                class="tool-row"
                :class="`t-${call.state}`"
              >
                <button
                  type="button"
                  class="tool-head"
                  data-action="chat.subagent-tool"
                  :aria-expanded="isToolOpen(call.id)"
                  @click="toggleTool(call.id)"
                >
                  <component
                    :is="toolIconOf(call.name)"
                    class="tool-icon"
                    :size="12"
                    :stroke-width="1.7"
                    aria-hidden="true"
                  />
                  <span class="mono tool-name">{{ call.name }}</span>
                  <span class="tool-summary">{{ call.summary ?? stateLabel(call.state) }}</span>
                  <span class="grow" />
                  <LoaderCircle
                    v-if="call.state === 'running'"
                    class="spin icon-running"
                    :size="12"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                  <CircleX
                    v-else-if="call.state === 'error'"
                    class="icon-err"
                    :size="12"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                  <CircleCheck
                    v-else
                    class="icon-ok"
                    :size="12"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                  <ChevronRight
                    class="tool-chevron"
                    :class="{ open: isToolOpen(call.id) }"
                    :size="12"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                </button>
                <Transition name="collapse">
                  <div v-if="isToolOpen(call.id)" class="tool-body">
                    <template v-if="call.args !== undefined">
                      <span class="label">参数</span>
                      <pre class="mono pre">{{ call.args }}</pre>
                    </template>
                    <span class="label">结果</span>
                    <pre class="mono pre">{{ call.output ?? stateLabel(call.state) }}</pre>
                  </div>
                </Transition>
              </article>
            </template>

            <!-- 工具结果在投影里已回填到对应调用上；真出现游离的 tool 消息时如实展示 -->
            <template v-else>
              <span class="role">工具</span>
              <pre class="mono pre">{{ message.text }}</pre>
            </template>
          </div>
          <p v-if="snapshot.transcriptTruncated === true" class="note">对话过长，中间部分已省略</p>
        </div>

        <p class="note footer">只读视图：与父对话生命周期一致，界面不提供干预入口</p>
      </div>
    </Transition>
  </article>
</template>

<style scoped>
.subagent {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.head {
  display: flex;
  min-width: 0;
}

.head-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--hit-target);
  text-align: left;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.head-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.s-running .head-icon {
  color: var(--aurora-blue);
}

.s-success .head-icon {
  color: var(--status-ok);
}

.s-error .head-icon {
  color: var(--status-error);
}

.chevron {
  flex: 0 0 auto;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

.chevron.open {
  transform: rotate(180deg);
}

.status {
  flex: 0 0 auto;
  color: var(--text-primary);
  font-weight: var(--weight-medium);
}

.desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.perm {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 16px;
}

.perm.write {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
}

.steps-count,
.elapsed {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.head-clock {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.track {
  position: relative;
  height: 3px;
  border-radius: 2px;
  background: var(--fill-3);
  overflow: hidden;
}

.track-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 45%;
  border-radius: 2px;
  background: var(--aurora-gradient);
  opacity: 0.55;
  animation: aurora-track var(--dur-pulse) var(--ease-smooth) infinite;
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-xs);
}

.step-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.step.tool .step-mark {
  background: color-mix(in srgb, var(--aurora-blue) 14%, transparent);
  color: var(--accent-text);
}

.step-name {
  flex: 0 0 auto;
  color: var(--text-primary);
}

.step-text,
.step-summary {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
}

.step-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.icon-running {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--aurora-blue);
}

.icon-ok {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--status-ok);
}

.icon-err {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--status-error);
}

.label {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.report {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
}

.note {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--text-muted);
}

.footer {
  padding-top: var(--space-1);
  border-top: 1px solid var(--border-subtle);
}

/* ───────── 只读对话 ───────── */

.conv {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.role {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.report-tag {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--ok-fill);
  color: var(--ok-text);
  font-size: var(--text-xs);
}

.bubble {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  color: var(--text-primary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 主代理的任务指令：靠右的"我说的话"，与子代理正文区分开 */
.bubble.user {
  align-self: flex-end;
  max-width: 88%;
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
  color: var(--text-secondary);
}

.assistant-text {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-row {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  min-height: var(--control-h-xs);
  padding: 4px var(--space-2);
  min-width: 0;
  text-align: left;
  color: var(--text-secondary);
  transition: background var(--transition-fast);
}

.tool-head:hover {
  background: var(--fill-2);
}

.tool-icon {
  flex: 0 0 auto;
  color: var(--accent-text);
}

.tool-name {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  color: var(--text-primary);
}

.tool-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.tool-chevron {
  flex: 0 0 auto;
  transition: transform var(--transition-base);
}

.tool-chevron.open {
  transform: rotate(90deg);
}

.tool-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.pre {
  margin: 0;
  padding: var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow-y: auto;
}

/* 窄屏：卡头允许换行，长描述让位给状态与耗时 */
@media (max-width: 720px) {
  .head-main {
    flex-wrap: wrap;
    row-gap: var(--space-1);
  }

  .desc {
    flex: 1 1 100%;
    order: 10;
    white-space: normal;
  }

  .bubble.user {
    max-width: 100%;
  }
}
</style>
