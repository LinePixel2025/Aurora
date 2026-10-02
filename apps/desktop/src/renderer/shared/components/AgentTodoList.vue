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
import { Check, Circle, LoaderCircle } from '@aurora/shared/browser'
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
          <!-- 待办：中性空心圈；进行中：强调色旋转弧；完成：ok 实心圈 + 对勾 -->
          <Circle v-if="todo.status === 'pending'" :size="13" :stroke-width="1.5" />
          <LoaderCircle
            v-else-if="todo.status === 'in_progress'"
            class="spin"
            :size="13"
            :stroke-width="1.7"
          />
          <span v-else class="todo-done"><Check :size="9" :stroke-width="3.2" /></span>
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

/* 状态圈：14px 与正文基线对齐；图标走 lucide，尺寸由组件 size 决定 */
.todo-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}

/* 待办：中性空心圈 */
.todo-mark.pending {
  color: var(--text-muted);
}

/* 进行中：强调色旋转弧（语义同全局 running 状态灯；旋转关键帧在 theme.css 的 `.spin`） */
.todo-mark.in_progress {
  color: var(--aurora-blue);
}

/* 完成：ok 实心圈 + 对勾 */
.todo-done {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--status-ok);
  color: var(--on-accent);
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

.dense .todo-done {
  width: 12px;
  height: 12px;
}

/* 紧凑版把图标一并缩小一档（lucide 的宽高是 SVG 属性，这里用 CSS 覆写对齐） */
.dense .todo-mark svg {
  width: 11px;
  height: 11px;
}
</style>
