<script setup lang="ts">
/**
 * 右栏「子代理」查看器（v46，docs/07 §2.3）。
 *
 * 与「子代理」页面 / 工具卡展开体共用同一个 `SubagentConversation`（同一份快照投影），
 * 区别只在容器：这里挂在右栏标签里，**跟着对话看**，不打断主区。
 *
 * 三条口径：
 * - **单例查看器**：标签只有一个，`focus` 指向当前要看的运行（callId / taskId）；
 *   焦点运行消失（切会话、会话被删）时回落到最近一次运行，没有则空态；
 * - **只读**：与页面一致，没有输入框 / 发送键 / 干预入口（要中止就中止父请求）；
 * - **实时**：数据源是 `useChat` 的 `subagentRuns`（live 优先、历史快照补齐），
 *   运行中每次事件都会刷新这份 prop，因此面板不需要自己轮询。
 */
import { computed, watch } from 'vue'
import { Bot, Clock, Cpu, ShieldCheck, FilePenLine } from '@aurora/shared/browser'
import type { SubagentRun } from '../../shared/composables/chatRuntime.js'
import SubagentConversation from '../../shared/components/SubagentConversation.vue'

const props = defineProps<{
  runs: SubagentRun[]
  /** 要看的运行；null = 最近一次运行 */
  focus: { callId: string; taskId: string } | null
}>()

const emit = defineEmits<{ (event: 'title', title: string): void }>()

/**
 * 选中哪次运行：先按焦点精确命中（callId 优先，空 callId 的老快照按 taskId），
 * 再回落列表首个（`subagentRuns` 已按"实时在前、历史在后"排好）。
 */
const selected = computed<SubagentRun | undefined>(() => {
  const focus = props.focus
  if (focus !== null) {
    const hit = props.runs.find(
      (run) =>
        (focus.callId !== '' && run.callId === focus.callId) ||
        (focus.taskId !== '' && run.taskId === focus.taskId),
    )
    if (hit !== undefined) return hit
  }
  return props.runs[0]
})

const title = computed(() => selected.value?.agentName?.trim() || '子代理')

/** 权限档徽章：`access` 优先（v46），老快照按 `permission` 推断 */
const accessLabel = computed(() => {
  const access = selected.value?.access ?? selected.value?.permission ?? 'read'
  return access === 'execute' ? '可执行' : access === 'write' ? '可读写' : '只读'
})

const accessWritable = computed(
  () => (selected.value?.access ?? selected.value?.permission) !== 'read',
)

const modelLabel = computed(() => {
  const model = selected.value?.model
  return model === undefined ? '' : `${model.providerId} · ${model.model}`
})

const statusLabel = computed(() => {
  const status = selected.value?.status
  if (status === undefined) return ''
  return status === 'running' ? '进行中' : status === 'success' ? '已完成' : '失败'
})

const elapsedLabel = computed(() => {
  const run = selected.value
  if (run === undefined) return ''
  const end = run.endedAt ?? Date.now()
  return `${(Math.max(0, end - run.startedAt) / 1000).toFixed(1)}s`
})

// 标签标题跟随选中运行（没有运行时回落种类默认名「子代理」由 `setTitle` 的空串回落处理）。
watch(selected, (run) => emit('title', run?.agentName?.trim() ?? ''), { immediate: true })
</script>

<template>
  <div class="subagent-panel" data-field="chat.subagent-panel">
    <template v-if="selected">
      <header class="panel-head">
        <Bot :size="14" :stroke-width="1.7" aria-hidden="true" />
        <strong class="panel-title" data-field="chat.subagent-panel-title">{{ title }}</strong>
        <span
          class="panel-state"
          :class="`s-${selected.status}`"
          data-field="chat.subagent-panel-status"
        >
          {{ statusLabel }}
        </span>
        <span class="grow" />
        <span
          class="panel-chip"
          :class="accessWritable ? 'write' : 'read'"
          data-field="chat.subagent-panel-access"
        >
          <component
            :is="accessWritable ? FilePenLine : ShieldCheck"
            :size="11"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          {{ accessLabel }}
        </span>
        <span
          v-if="modelLabel !== ''"
          class="tiny muted panel-model"
          data-field="chat.subagent-panel-model"
        >
          <Cpu :size="11" :stroke-width="1.8" aria-hidden="true" />
          {{ modelLabel }}
        </span>
        <span class="tiny muted panel-time">
          <Clock :size="11" :stroke-width="1.8" aria-hidden="true" />
          {{ elapsedLabel }}
        </span>
      </header>

      <p class="tiny muted panel-prompt">{{ selected.prompt }}</p>

      <div class="panel-body">
        <!-- 头部已经给了名称 / 权限 / 模型，对话本体不再重复一行元信息 -->
        <SubagentConversation :snapshot="selected" :show-meta="false" />
      </div>
    </template>

    <!-- 空态：没有可看的运行（切到没派过子代理的会话 / 历史被清掉） -->
    <div v-else class="panel-empty" data-field="chat.subagent-panel-empty">
      <p class="tiny muted">当前会话还没有子代理运行。</p>
      <p class="tiny muted">对话里出现子代理时，点它的名称徽章就能在这里看它干活。</p>
    </div>
  </div>
</template>

<style scoped>
.subagent-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-3);
}

.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex-wrap: wrap;
}

.panel-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}

.panel-state {
  font-size: var(--text-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

.panel-state.s-running {
  color: var(--status-running);
}

.panel-state.s-success {
  color: var(--status-ok);
}

.panel-state.s-error {
  color: var(--status-error);
}

.panel-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  line-height: 18px;
  white-space: nowrap;
}

.panel-chip.write {
  color: var(--text-primary);
}

.panel-chip.read {
  color: var(--text-muted);
}

.panel-model,
.panel-time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.panel-model {
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 任务指令：两行截断（完整指令在对话首条气泡里，不在这里重复整段） */
.panel-prompt {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.panel-empty {
  margin: auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.grow {
  flex: 1;
}
</style>
