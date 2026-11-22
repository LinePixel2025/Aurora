<script setup lang="ts">
/**
 * 子代理的**独立对话视图**（2026-09，docs/06 §19 / docs/07 §2.3）。
 *
 * 子代理的会话不落盘，`SubagentSnapshot.messages` 是它唯一的过程留存（`tools/task.ts` 的投影）。
 * 这里把那份投影渲染成一段**只读对话**：主代理的任务指令 → 子代理的正文 → 它的工具调用
 * （含结果正文，展开可看）→ 最终报告。
 *
 * 2026-11（v0.8.1）**与普通对话统一视觉语言**：此前这里是「带边框的工具小卡片 + 每段正文都套
 * 填充气泡」，和主对话（用户右对齐胶囊 / 助手纯文本 Markdown / 轨迹式工具行）明显两种观感。
 * 现在逐条对齐 `MessageList`：
 * - 每轮 = 头像列 + 内容列；主代理任务指令**右对齐强调色胶囊**，子代理正文**左对齐、不套气泡**，
 *   走共享 Markdown 渲染器（同一份安全基线：先转义再白名单标记，绝无裸 `v-html` 模型原文）；
 * - 工具调用是**轨迹行**（左缘竖脊 + 节点圆点 + 状态点色 + 语义图标 + 可读标题 + 结果摘要），
 *   点开看参数与结果全文，与主对话 `AgentToolRow` 同一套语言；
 * - 探针锚点保持不变：`.conv-turn` / `.conv-tool` / `.conv-bubble.user` / `.conv-bubble.report`
 *   / `.conv-report-tag`（capture 直接按选择器断言）。
 *
 * 为什么不是直接复用 `MessageList`：那个组件绑着会话状态（流式游标、朗读、快照、附件、markdown
 * 白名单上下文），拿快照数据硬塞进去要伪造一大堆字段；这里只渲染 4 种东西，独立组件更清楚，
 * 但**排版语言必须与它一致**（docs/07 §2.3）。
 */
import { computed, ref } from 'vue'
import type {
  SubagentSnapshot,
  SubagentTranscriptMessage,
  SubagentTranscriptToolCall,
} from '@aurora/shared'
import '@aurora/shared/browser/markdown/md.css'
import {
  ChevronRight,
  FilePenLine,
  LoaderCircle,
  ShieldCheck,
  toolIconOf,
  toolLabelOf,
} from '@aurora/shared/browser'
import { renderMarkdown } from '@aurora/shared/browser'
import AppTooltip from './AppTooltip.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{
  snapshot: SubagentSnapshot
  /**
   * 是否渲染顶部元信息行（权限 / 模型 / 可用工具）。
   * 侧栏面板的头部已经给了同样的徽章，再渲染一遍就是同一段信息说两遍 —— 那里传 false。
   */
  showMeta?: boolean
}>()

/** 展开了结果正文的工具调用 id（默认收起：一眼看到"做了什么"，要看细节再点开） */
const openedTools = ref<string[]>([])

const messages = computed<SubagentTranscriptMessage[]>(() => props.snapshot.messages ?? [])

/**
 * 最终报告落在**最后一条有正文的助手消息**上：`report` 就是所有正文增量的拼接，
 * 因此不必再单列一块（那会让同一段文字出现两遍）。这里把它标出来，让"回传给主代理的
 * 就是这一段"在版面上可见。
 */
const reportMessageId = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const message = messages.value[index]
    if (message !== undefined && message.role === 'assistant' && (message.text ?? '') !== '') {
      return message.id
    }
  }
  return ''
})

const grantedTools = computed(() => props.snapshot.tools ?? [])

/** 具名子代理的名字（v46；通用子代理 / 老快照为空串 = 不渲染名字徽章） */
const agentName = computed(() => props.snapshot.agentName?.trim() ?? '')

/** 实际模型（v46；老快照没有该字段 = 不渲染） */
const modelLabel = computed(() => {
  const model = props.snapshot.model
  return model === undefined ? '' : `${model.providerId} · ${model.model}`
})

/** 权限档：`access` 优先（v46 三档），老快照按 `permission` 推断 */
const accessLevel = computed(() => props.snapshot.access ?? props.snapshot.permission ?? 'read')

const accessLabel = computed(() => {
  const level = accessLevel.value
  return level === 'execute' ? '可执行命令' : level === 'write' ? '可读写文件' : '只读'
})

/** 可用工具清单：窄栏里铺开会撑爆一行，改挂悬停提示（与工具行的摘要同一取舍） */
const toolsHint = computed(() =>
  grantedTools.value.length === 0 ? '' : `可用工具：${grantedTools.value.join('、')}`,
)

/** Markdown 解析缓存：快照实时增长时只重解析真正变化了的那条 */
const htmlCache = new Map<string, { text: string; html: string }>()

function htmlOf(message: SubagentTranscriptMessage): string {
  const text = message.text ?? ''
  const cached = htmlCache.get(message.id)
  if (cached !== undefined && cached.text === text) return cached.html
  const html = renderMarkdown(text)
  htmlCache.set(message.id, { text, html })
  return html
}

function isToolOpen(id: string): boolean {
  return openedTools.value.includes(id)
}

function toggleTool(id: string): void {
  openedTools.value = isToolOpen(id)
    ? openedTools.value.filter((item) => item !== id)
    : [...openedTools.value, id]
}

function stateLabel(state: SubagentTranscriptToolCall['state']): string {
  if (state === 'running') return '执行中'
  return state === 'error' ? '失败' : '完成'
}

/** 状态点语义色：成功走绿色（`StatusDot` 只有 idle / running / unread / error 四档，样式里补绿） */
function dotTone(state: SubagentTranscriptToolCall['state']): 'idle' | 'running' | 'error' {
  if (state === 'running') return 'running'
  return state === 'error' ? 'error' : 'idle'
}

/** 入参字符串 → 可读标题需要的对象（解析失败按字符串透传，绝不因模型输出畸形把行弄丢） */
function parsedArgs(call: SubagentTranscriptToolCall): unknown {
  const raw = call.args?.trim() ?? ''
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 行首标题：优先「动词 + 关键参数」，摘不出短语时回落 mono 工具名（与主对话工具行同口径） */
function toolTitle(call: SubagentTranscriptToolCall): string {
  const label = toolLabelOf(call.name, parsedArgs(call))
  if (label === null) return call.name
  return label.object === undefined ? label.verb : `${label.verb} ${label.object}`
}

function toolSummary(call: SubagentTranscriptToolCall): string {
  const summary = (call.summary ?? '').trim()
  if (summary !== '') return summary
  return call.state === 'running' ? '进行中…' : '—'
}

function toolParams(call: SubagentTranscriptToolCall): string {
  const raw = call.args?.trim() ?? ''
  return raw === '' ? '（无参数）' : raw
}
</script>

<template>
  <div class="conv" data-field="chat.subagent-conversation">
    <div v-if="props.showMeta !== false" class="conv-meta">
      <span v-if="agentName !== ''" class="conv-name" data-field="chat.subagent-name">
        {{ agentName }}
      </span>
      <span
        class="conv-chip"
        :class="accessLevel === 'read' ? 'read' : 'write'"
        data-field="chat.subagent-perm"
      >
        <component
          :is="accessLevel === 'read' ? ShieldCheck : FilePenLine"
          :size="11"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ accessLabel }}
      </span>
      <span v-if="modelLabel !== ''" class="tiny muted conv-model" data-field="chat.subagent-model">
        {{ modelLabel }}
      </span>
      <AppTooltip v-if="toolsHint !== ''" :text="toolsHint">
        <span class="conv-chip">{{ grantedTools.length }} 个工具</span>
      </AppTooltip>
    </div>

    <p v-if="messages.length === 0" class="tiny muted conv-empty">等待子代理产出…</p>

    <template v-else>
      <div
        v-for="message in messages"
        :key="message.id"
        class="conv-turn"
        :class="message.role"
        :data-role="message.role"
      >
        <template v-if="message.role === 'user'">
          <span class="conv-avatar" aria-hidden="true">主</span>
          <div class="conv-body">
            <p class="conv-bubble user">{{ message.text }}</p>
          </div>
        </template>

        <template v-else-if="message.role === 'assistant'">
          <span class="conv-avatar" aria-hidden="true">A</span>
          <div class="conv-body">
            <div v-if="message.id === reportMessageId" class="conv-report-line">
              <span class="conv-report-tag">最终报告</span>
            </div>
            <!--
              安全说明：内容先经 renderMarkdown 转义，再套用白名单标记
              （与 MessageList 同一份 `@aurora/shared/browser` 渲染器）。
            -->
            <!-- eslint-disable vue/no-v-html -->
            <div
              v-if="(message.text ?? '') !== ''"
              class="md conv-bubble"
              :class="{ report: message.id === reportMessageId }"
              v-html="htmlOf(message)"
            />
            <!-- eslint-enable vue/no-v-html -->
            <div v-if="(message.toolCalls ?? []).length > 0" class="conv-tools">
              <article
                v-for="call in message.toolCalls ?? []"
                :key="call.id"
                class="conv-tool"
                :class="`t-${call.state}`"
              >
                <button
                  type="button"
                  class="conv-tool-head"
                  :aria-expanded="isToolOpen(call.id)"
                  :aria-label="`${call.name} · ${stateLabel(call.state)}`"
                  @click="toggleTool(call.id)"
                >
                  <span class="conv-tool-dot">
                    <StatusDot :tone="dotTone(call.state)" :size="6" />
                    <span class="sr-state">{{ stateLabel(call.state) }}</span>
                  </span>
                  <component
                    :is="toolIconOf(call.name)"
                    class="conv-tool-icon"
                    :size="13"
                    :stroke-width="1.7"
                    aria-hidden="true"
                  />
                  <span class="conv-tool-title">{{ toolTitle(call) }}</span>
                  <span class="tiny muted conv-tool-summary">{{ toolSummary(call) }}</span>
                  <span class="grow" />
                  <LoaderCircle
                    v-if="call.state === 'running'"
                    class="spin conv-tool-state"
                    :size="12"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                  <ChevronRight
                    class="conv-tool-chevron"
                    :class="{ open: isToolOpen(call.id) }"
                    :size="13"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                </button>
                <Transition name="conv-tool-body">
                  <div v-if="isToolOpen(call.id)" class="conv-tool-body">
                    <span class="tiny muted">参数</span>
                    <pre class="mono conv-pre">{{ toolParams(call) }}</pre>
                    <span class="tiny muted">结果</span>
                    <pre class="mono conv-pre">{{ call.output ?? stateLabel(call.state) }}</pre>
                  </div>
                </Transition>
              </article>
            </div>
          </div>
        </template>

        <!-- 工具结果在投影里已回填到对应调用上；真出现游离的 tool 消息时如实说明 -->
        <template v-else>
          <span class="conv-avatar" aria-hidden="true">工</span>
          <div class="conv-body">
            <span class="tiny muted">工具结果</span>
            <pre class="mono conv-pre">{{ message.text }}</pre>
          </div>
        </template>
      </div>
    </template>

    <p v-if="snapshot.transcriptTruncated === true" class="tiny muted conv-note">
      对话过长，中间部分已省略（完整结论见最终报告）。
    </p>
    <p class="tiny muted conv-note">
      只读视图：子代理独立于当前对话运行，界面不提供干预入口（要中止请中止父请求）。
    </p>
  </div>
</template>

<style scoped>
/* 与 MessageList 的 `.messages` 同一套节奏：轮与轮之间 `--space-3`，不再每块都套盒子 */
.conv {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
}

.conv-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.conv-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 16px;
  background: var(--fill-2);
  color: var(--text-secondary);
}

.conv-chip.write {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
}

/* 具名子代理（v46）：名字徽章比权限 chip 更靠前，一眼知道是谁在干 */
.conv-name {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.conv-model {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-empty {
  margin: 0;
}

/* ── 一轮消息：与主对话 `.message` 同款（头像列 + 内容列，user 行反向） ── */
.conv-turn {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  min-width: 0;
}

.conv-turn.user {
  flex-direction: row-reverse;
}

.conv-avatar {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: var(--text-xs);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.conv-turn.assistant .conv-avatar {
  background: var(--aurora-gradient);
  color: var(--on-accent);
  font-weight: var(--weight-semibold);
}

.conv-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
}

/* 任务指令右对齐、限宽（与主对话的用户气泡同一档） */
.conv-turn.user .conv-body {
  flex: 0 1 auto;
  align-items: flex-end;
  max-width: 78%;
  margin-left: auto;
}

/* 用户气泡：强调色浅填充（iMessage 语义：这是「主代理」说的话），无重描边 */
.conv-bubble.user {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--aurora-blue) 20%, transparent);
  color: var(--text-primary);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 子代理正文：不套气泡（Apple 风格），Markdown 样式由共享 md.css 提供 */
.conv-bubble.report {
  margin: 0;
  padding: 0;
  background: none;
  color: var(--text-primary);
}

.conv-report-line {
  display: flex;
  align-items: center;
}

.conv-report-tag {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--ok-fill);
  color: var(--ok-text);
  font-size: var(--text-xs);
  line-height: 18px;
}

/* ── 工具调用：轨迹行（左缘竖脊 + 节点圆点），与 AgentToolRow 同一套语言 ── */
.conv-tools {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 20px;
}

.conv-tools::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 4px;
  bottom: 4px;
  width: 1px;
  background: var(--border-subtle);
}

.conv-tool {
  position: relative;
  border-radius: var(--radius-xs);
}

/* 节点圆点：骑在竖脊上（竖脊 x = 7px） */
.conv-tool::before {
  content: '';
  position: absolute;
  left: -16px;
  top: 10px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  box-shadow: 0 0 0 3px var(--bg-base);
  transition: background var(--transition-fast);
}

.conv-tool.t-running::before {
  background: var(--status-running);
}

.conv-tool.t-success::before {
  background: var(--status-ok);
}

.conv-tool.t-error::before {
  background: var(--status-error);
}

.conv-tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 28px;
  padding: 4px var(--space-2) 4px 2px;
  border-radius: var(--radius-xs);
  text-align: left;
  color: var(--text-secondary);
  transition: background var(--transition-fast);
}

.conv-tool-head:hover {
  background: var(--fill-1);
}

.conv-tool-dot {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 10px;
}

.t-success .conv-tool-dot :deep(.status-dot) {
  background: var(--status-ok);
}

/* 状态文案只给读屏器（与 AgentToolRow 的 `.sr-state` 同款） */
.sr-state {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.conv-tool-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.conv-tool.t-running .conv-tool-icon {
  color: var(--aurora-blue);
}

.conv-tool.t-success .conv-tool-icon {
  color: color-mix(in srgb, var(--status-ok) 75%, var(--text-muted));
}

.conv-tool.t-error .conv-tool-icon {
  color: var(--status-error);
}

.conv-tool-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.conv-tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-tool.t-error .conv-tool-summary {
  color: var(--status-error);
}

.conv-tool-state {
  flex: 0 0 auto;
  color: var(--aurora-blue);
}

.conv-tool-chevron {
  flex: 0 0 auto;
  color: var(--text-muted);
  transition: transform var(--transition-base);
}

.conv-tool-chevron.open {
  transform: rotate(90deg);
}

.conv-tool-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

/*
 * 令牌级对齐（2026-09-30 轨迹重构）：展开体的淡入走 `--dur-tint`(800ms)。
 * 它是一段**已经结束**的工具调用的细节（子代理的步骤都跑完了才会进这份投影），
 * 用比 `--dur-base` 慢一档的这个新令牌，展开读起来是"细节慢慢显出来"而不是"啪一下"。
 */
.conv-tool-body-enter-active,
.conv-tool-body-leave-active {
  transition: opacity var(--dur-tint) var(--ease-standard);
}

.conv-tool-body-enter-from,
.conv-tool-body-leave-to {
  opacity: 0;
}

.conv-pre {
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

.conv-note {
  margin: 0;
}

.grow {
  flex: 1;
}
</style>
