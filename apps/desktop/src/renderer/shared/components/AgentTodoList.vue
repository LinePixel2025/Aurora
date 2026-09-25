<script setup lang="ts">
/**
 * 结构化任务清单（`todo_write` 的可视化，2026-09 新增，docs/07 §2.3）。
 *
 * 两个消费方共用一个组件，保证「流里的清单卡」与「右栏的任务清单卡」长一个样子：
 * - MessageList：`todo_write` 工具卡的结构化头（`dense`，行高更紧）；
 * - ContextPanel：右栏「任务清单」卡（默认尺寸）。
 *
 * 状态圈语义与全局状态灯一致：进行中 = 强调蓝（呼吸），完成 = ok 绿，待办 = 中性灰。
 * 组件只读（勾选由 Agent 在会话里 `todo_write` 驱动），没有任何交互。
 */
import type { TodoRow } from '../agentTodo.js'

/** 进度摘要由调用方的卡头承担（消息流卡「N 项」/ 右栏卡「n/m」），列表本身只渲染条目 */
withDefaults(
  defineProps<{
    todos: TodoRow[]
    /** 紧凑版（消息流工具卡内）：行高与字号收一档 */
    dense?: boolean
  }>(),
  { dense: false },
)
</script>

<template>
  <!-- data-field 锚点由调用方挂（消息流卡 chat.todo-card / 右栏卡 context.todo-card） -->
  <div class="todo-list" :class="{ dense }">
    <p v-if="todos.length === 0" class="tiny muted todo-empty">清单为空</p>
    <template v-else>
      <div v-for="(todo, index) in todos" :key="index" class="todo-row">
        <span class="todo-mark" :class="todo.status" aria-hidden="true">
          <!-- 待办：空心圈；进行中：强调色半环；完成：ok 实心对勾 -->
          <svg v-if="todo.status === 'pending'" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="5.2" />
          </svg>
          <svg v-else-if="todo.status === 'in_progress'" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="5.2" class="ring" />
            <path d="M7 3.4A3.6 3.6 0 0 1 10.6 7" class="arc" />
          </svg>
          <svg v-else viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="6.2" class="done-bg" />
            <path d="M4.4 7.2 6.3 9l3.3-3.8" class="done-check" />
          </svg>
        </span>
        <span class="todo-content" :class="{ done: todo.status === 'completed' }">{{
          todo.content
        }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.todo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.todo-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}

/* 状态圈：14px 与正文基线对齐 */
.todo-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}

.todo-mark svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 待办：中性空心圈 */
.todo-mark.pending svg {
  stroke: var(--text-muted);
  stroke-width: 1.4;
}

/* 进行中：强调色环 + 运动弧（呼吸），语义同全局 running 状态灯 */
.todo-mark.in_progress svg {
  stroke: var(--aurora-blue);
  stroke-width: 1.6;
}

.todo-mark.in_progress .ring {
  opacity: 0.35;
}

.todo-mark.in_progress .arc {
  animation: todo-arc-spin 1.4s linear infinite;
  transform-origin: 7px 7px;
}

@keyframes todo-arc-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 完成：ok 实心圈 + 白色对勾 */
.todo-mark.completed .done-bg {
  fill: var(--status-ok);
  stroke: none;
}

.todo-mark.completed .done-check {
  stroke: var(--on-accent);
  stroke-width: 1.6;
}

.todo-content {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 已完成条目弱化（ Apple 风格：完成项不再抢注意力） */
.todo-content.done {
  color: var(--text-muted);
}

.todo-empty {
  margin: 0;
}

/* 紧凑版（消息流卡内）：字号行高收一档 */
.dense .todo-content {
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}

.dense .todo-mark {
  width: 12px;
  height: 12px;
  margin-top: 1px;
}

.dense .todo-mark svg {
  width: 12px;
  height: 12px;
}
</style>
