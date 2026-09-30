<script setup lang="ts">
/**
 * 子代理的**独立对话视图**（2026-09，docs/06 §19 / docs/07 §2.3）。
 *
 * 子代理的会话不落盘，`SubagentSnapshot.messages` 是它唯一的过程留存（`tools/task.ts` 的投影）。
 * 这里把那份投影渲染成一段**只读对话**：主代理的任务指令 → 子代理的正文 → 它的工具调用
 * （含结果正文，展开可看）→ 最终报告。与主对话的排版语言一致，但**没有任何输入或干预入口**：
 * 子代理的生死跟着父请求，要中止就中止父请求（这条口径写在了列表底部的提示里）。
 *
 * 为什么不是复用 `MessageList`：那个组件绑着会话状态（流式游标、朗读、快照、附件、markdown
 * 白名单上下文），拿快照数据硬塞进去要伪造一大堆字段；这里只渲染 4 种东西，独立组件更清楚。
 */
import { computed, ref } from 'vue'
import type {
  SubagentSnapshot,
  SubagentTranscriptMessage,
  SubagentTranscriptToolCall,
} from '@aurora/shared'
import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleX,
  FilePenLine,
  LoaderCircle,
  ShieldCheck,
} from '../icons.js'
import { toolIconOf } from '../toolIcons.js'

const props = defineProps<{ snapshot: SubagentSnapshot }>()

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
</script>

<template>
  <div class="conv" data-field="chat.subagent-conversation">
    <div class="conv-meta">
      <span class="conv-chip" :class="snapshot.permission === 'write' ? 'write' : 'read'">
        <component
          :is="snapshot.permission === 'write' ? FilePenLine : ShieldCheck"
          :size="11"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ snapshot.permission === 'write' ? '可读写文件' : '只读' }}
      </span>
      <span v-if="grantedTools.length > 0" class="tiny muted conv-tools">
        可用工具：{{ grantedTools.join('、') }}
      </span>
    </div>

    <p v-if="messages.length === 0" class="tiny muted conv-empty">等待子代理产出…</p>

    <template v-else>
      <div v-for="message in messages" :key="message.id" class="conv-turn" :class="message.role">
        <template v-if="message.role === 'user'">
          <span class="conv-role tiny muted">主代理</span>
          <p class="conv-bubble user">{{ message.text }}</p>
        </template>

        <template v-else-if="message.role === 'assistant'">
          <span class="conv-role tiny muted">
            <Bot :size="11" :stroke-width="1.8" aria-hidden="true" />
            子代理
            <span v-if="message.id === reportMessageId" class="conv-report-tag">最终报告</span>
          </span>
          <p
            v-if="(message.text ?? '') !== ''"
            class="conv-bubble"
            :class="{ report: message.id === reportMessageId }"
          >
            {{ message.text }}
          </p>
          <!-- 工具调用：一行一枚（图标 + 名字 + 结果摘要），点开看参数与结果正文 -->
          <article
            v-for="call in message.toolCalls ?? []"
            :key="call.id"
            class="conv-tool"
            :class="`t-${call.state}`"
          >
            <button type="button" class="conv-tool-head" @click="toggleTool(call.id)">
              <component
                :is="toolIconOf(call.name)"
                class="conv-tool-icon"
                :size="12"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              <span class="mono tiny conv-tool-name">{{ call.name }}</span>
              <span class="tiny muted conv-tool-summary">{{
                call.summary ?? stateLabel(call.state)
              }}</span>
              <span class="grow" />
              <LoaderCircle
                v-if="call.state === 'running'"
                class="spin"
                :size="12"
                :stroke-width="1.8"
                aria-hidden="true"
              />
              <CircleX
                v-else-if="call.state === 'error'"
                class="conv-tool-err"
                :size="12"
                :stroke-width="1.8"
                aria-hidden="true"
              />
              <CircleCheck
                v-else
                class="conv-tool-ok"
                :size="12"
                :stroke-width="1.8"
                aria-hidden="true"
              />
              <ChevronRight
                class="conv-tool-chevron"
                :class="{ open: isToolOpen(call.id) }"
                :size="12"
                :stroke-width="1.8"
                aria-hidden="true"
              />
            </button>
            <Transition name="conv-tool-body">
              <div v-if="isToolOpen(call.id)" class="conv-tool-body">
                <span v-if="call.args !== undefined" class="tiny muted">参数</span>
                <pre v-if="call.args !== undefined" class="mono conv-pre">{{ call.args }}</pre>
                <span class="tiny muted">结果</span>
                <pre class="mono conv-pre">{{ call.output ?? stateLabel(call.state) }}</pre>
              </div>
            </Transition>
          </article>
        </template>

        <!-- 工具结果在投影里已回填到对应调用上；真出现游离的 tool 消息时如实说明 -->
        <template v-else>
          <span class="conv-role tiny muted">工具</span>
          <pre class="mono conv-pre">{{ message.text }}</pre>
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
.conv {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
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

.conv-tools {
  min-width: 0;
  overflow-wrap: anywhere;
}

.conv-empty {
  margin: 0;
}

.conv-turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.conv-role {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.conv-report-tag {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--ok-fill);
  color: var(--ok-text);
  font-size: var(--text-xs);
}

.conv-bubble {
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

.conv-bubble.user {
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
  color: var(--text-secondary);
}

/* 最终报告：它是回传给主代理的那段，视觉上压一档实底 */
.conv-bubble.report {
  background: var(--fill-2);
}

.conv-tool {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
}

.conv-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px var(--space-2);
  min-width: 0;
  text-align: left;
  color: var(--text-secondary);
  transition: background var(--transition-fast);
}

.conv-tool-head:hover {
  background: var(--fill-2);
}

.conv-tool-icon {
  flex: 0 0 auto;
  color: var(--accent-text);
}

.conv-tool-name {
  flex: 0 0 auto;
  color: var(--text-primary);
}

.conv-tool-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-tool-ok {
  flex: 0 0 auto;
  color: var(--status-ok);
}

.conv-tool-err {
  flex: 0 0 auto;
  color: var(--status-error);
}

.conv-tool-chevron {
  flex: 0 0 auto;
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
 * 结构不动（本文件只做令牌级对齐，见 task-1 的写范围）。
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
</style>
