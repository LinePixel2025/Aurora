<script setup lang="ts">
/**
 * 自动化编辑器的**单个 catalog 字段**（docs/13 §4.3）：触发器参数与操作参数共用同一份渲染。
 *
 * 之前这段模板在 AutomationPage 里为触发器 / 操作各抄了一遍，且都是「标签在上、控件在下」的
 * 竖排 —— 标签长（「点击打开的目录」）加上动态字段多时，弹窗被拉得很长、标签与控件对不齐。
 * 这里改成**左标签 / 右控件**的两列网格：标签列定宽、控件列 `min-width: 0` 自适应，
 * 两者都在自己的格子里，不会互相挤压（前端减负轮的「安全区」口径，docs/07 §5.4）。
 *
 * 控件的形态按 `field.type` 决定，**不再出现原生 `<select>`**：
 * - `select` → 分段胶囊（选项 ≤ 3 个，点一下即改，比下拉少一次点击）；
 * - `weekdays` → 星期胶囊多选（空 = 每天），不再用 checkbox；
 * - `time` → 原生 `type="time"`（带系统时间选择器，且天然产出 `HH:mm`，与校验口径一致）；
 * - `number` / `text` → 原生输入，宽度受控。
 */
import type { AutomationDescriptorField } from '@aurora/shared'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import { CalendarDays, Hash, Info, ListFilter, TextCursorInput } from '@aurora/shared/browser'

const props = defineProps<{
  field: AutomationDescriptorField
  /** 参数袋（**只读**）：组件不就地改它，改动一律经 `update` 交给调用侧写回 */
  params: Record<string, unknown>
}>()

/** 字段值变更：调用侧按 key 写回自己的 draft（子组件不碰父组件的状态） */
const emit = defineEmits<{
  (event: 'update', payload: { key: string; value: string | number | number[] }): void
}>()

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const TYPE_ICONS = {
  text: TextCursorInput,
  time: TextCursorInput,
  number: Hash,
  weekdays: CalendarDays,
  select: ListFilter,
} as const

function value(): string | number {
  const raw = props.params[props.field.key]
  return typeof raw === 'string' || typeof raw === 'number' ? raw : ''
}

function setValue(next: string | number): void {
  emit('update', { key: props.field.key, value: next })
}

function weekdays(): number[] {
  const raw = props.params[props.field.key]
  return Array.isArray(raw) ? (raw as number[]).filter((day) => typeof day === 'number') : []
}

function isDayOn(day: number): boolean {
  return weekdays().includes(day)
}

/** 星期多选：点一下翻转一个，始终保持升序（与主进程的校验口径一致） */
function toggleDay(day: number): void {
  const next = new Set(weekdays())
  if (next.has(day)) next.delete(day)
  else next.add(day)
  emit('update', {
    key: props.field.key,
    value: [...next].sort((a, b) => a - b),
  })
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}
</script>

<template>
  <div class="field-row">
    <span class="field-label">
      <component
        :is="TYPE_ICONS[props.field.type]"
        :size="12"
        :stroke-width="1.7"
        aria-hidden="true"
      />
      <span class="label-text">{{ props.field.label }}</span>
      <AppTooltip v-if="props.field.hint" :text="props.field.hint">
        <button type="button" class="hint-dot" :aria-label="`${props.field.label}的说明`">
          <Info :size="11" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </AppTooltip>
    </span>

    <div class="field-control">
      <!-- 下拉 → 分段胶囊：选项少，少一次点击、且不弹系统菜单 -->
      <div v-if="props.field.type === 'select'" class="chip-group">
        <button
          v-for="option in props.field.options ?? []"
          :key="option.value"
          type="button"
          class="chip press"
          :class="{ active: value() === option.value }"
          :aria-pressed="value() === option.value"
          @click="setValue(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <!-- 星期多选 → 胶囊（全不选 = 每天） -->
      <div v-else-if="props.field.type === 'weekdays'" class="chip-group">
        <button
          v-for="(name, day) in WEEKDAYS"
          :key="day"
          type="button"
          class="chip press"
          :class="{ active: isDayOn(day) }"
          :aria-pressed="isDayOn(day)"
          @click="toggleDay(day)"
        >
          {{ name }}
        </button>
        <span v-if="weekdays().length === 0" class="tiny muted inline-note">每天</span>
      </div>

      <input
        v-else-if="props.field.type === 'number'"
        class="input num"
        type="number"
        :value="value()"
        :min="props.field.min"
        :max="props.field.max"
        :step="props.field.step ?? 1"
        :aria-label="props.field.label"
        @input="setValue(Number(inputValue($event)))"
      />

      <input
        v-else-if="props.field.type === 'time'"
        class="input time"
        type="time"
        :value="value()"
        :aria-label="props.field.label"
        @input="setValue(inputValue($event))"
      />

      <input
        v-else
        class="input"
        type="text"
        :value="value()"
        :placeholder="props.field.placeholder ?? ''"
        :aria-label="props.field.label"
        @input="setValue(inputValue($event))"
      />
    </div>
  </div>
</template>

<style scoped>
.field-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

/* 标签可能很长（「点击打开的目录」）：允许换行，绝不撑破 92px 的格子 */
.label-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.hint-dot {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  color: var(--text-muted);
  transition: color var(--transition-fast);
}

.hint-dot:hover {
  color: var(--text-primary);
}

.field-control {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
}

.input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font-size: var(--text-sm);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.input:hover {
  background: var(--fill-2);
}

.input:focus-visible {
  outline: none;
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 2px var(--accent-ring);
}

/* 数字 / 时间不需要占满整行：定宽更省横向空间，也避免数字框被拉成一条 */
.input.num {
  width: 92px;
}

.input.time {
  width: 116px;
}

.chip-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.chip {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1.4;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.chip:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.chip.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--text-primary);
}

.inline-note {
  margin-left: 2px;
}
</style>
