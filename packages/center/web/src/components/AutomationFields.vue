<script setup lang="ts">
/**
 * 自动化动态表单字段（docs/13 §4.3）：按 catalog 描述符渲染 text / number / time /
 * select / weekdays 五类字段，weekdays 用 7 个 checkbox（0 = 周日）。
 * 触发器与操作组件共用；参数对象整体上抛（每次变更生成新对象，不改 props）。
 */
import type { AutomationDescriptorField } from '@aurora/shared'

const props = defineProps<{
  fields: AutomationDescriptorField[]
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

/** 星期 checkbox 的展示名（索引即 weekday 数字，0 = 周日） */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

function set(key: string, value: unknown): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function onTextInput(key: string, event: Event): void {
  set(key, (event.target as HTMLInputElement).value)
}

function onNumberInput(key: string, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  const value = raw === '' ? undefined : Number(raw)
  set(key, value !== undefined && Number.isFinite(value) ? value : undefined)
}

function onSelect(key: string, event: Event): void {
  set(key, (event.target as HTMLSelectElement).value)
}

function weekdayList(key: string): number[] {
  const value = props.modelValue[key]
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : []
}

function onWeekdayToggle(key: string, day: number, event: Event): void {
  const on = (event.target as HTMLInputElement).checked
  const current = weekdayList(key)
  const next = on
    ? [...new Set([...current, day])].sort((a, b) => a - b)
    : current.filter((item) => item !== day)
  set(key, next)
}
</script>

<template>
  <div class="af">
    <template v-for="field in fields" :key="field.key">
      <label class="af-field">
        <span class="af-label">{{ field.label }}</span>

        <input
          v-if="field.type === 'text'"
          class="ui-input"
          type="text"
          :data-field="`automation.${field.key}`"
          :placeholder="field.placeholder ?? ''"
          :value="
            typeof modelValue[field.key] === 'string' ? (modelValue[field.key] as string) : ''
          "
          @input="onTextInput(field.key, $event)"
        />

        <input
          v-else-if="field.type === 'number'"
          class="ui-input"
          type="number"
          :data-field="`automation.${field.key}`"
          :min="field.min"
          :max="field.max"
          :step="field.step"
          :value="
            typeof modelValue[field.key] === 'number' ? (modelValue[field.key] as number) : ''
          "
          @input="onNumberInput(field.key, $event)"
        />

        <input
          v-else-if="field.type === 'time'"
          class="ui-input"
          type="time"
          :data-field="`automation.${field.key}`"
          :placeholder="field.placeholder ?? ''"
          :value="
            typeof modelValue[field.key] === 'string' ? (modelValue[field.key] as string) : ''
          "
          @input="onTextInput(field.key, $event)"
        />

        <select
          v-else-if="field.type === 'select'"
          class="ui-input"
          :data-field="`automation.${field.key}`"
          :value="
            typeof modelValue[field.key] === 'string' ? (modelValue[field.key] as string) : ''
          "
          @change="onSelect(field.key, $event)"
        >
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <span
          v-else-if="field.type === 'weekdays'"
          class="af-weekdays"
          :data-field="`automation.${field.key}`"
        >
          <label v-for="(name, day) in WEEKDAY_NAMES" :key="day" class="af-weekday">
            <input
              type="checkbox"
              :checked="weekdayList(field.key).includes(day)"
              @change="onWeekdayToggle(field.key, day, $event)"
            />
            <span>{{ name }}</span>
          </label>
        </span>

        <small v-if="field.hint" class="af-hint">{{ field.hint }}</small>
      </label>
    </template>
  </div>
</template>

<style scoped>
.af {
  display: grid;
  gap: var(--space-3);
}

.af-field {
  display: grid;
  gap: var(--space-1);
}

.af-label {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.af-hint {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.af-weekdays {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
}

.af-weekday {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  cursor: pointer;
}

.af-weekday input {
  flex: none;
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--aurora-blue);
}

/* ───────── 基础件（本页自持，样式单源在 @aurora/shared/browser/theme.css 的令牌） ───────── */

.ui-input {
  width: 100%;
  height: var(--control-h-sm);
  min-width: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  outline: none;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.ui-input::placeholder {
  color: var(--text-muted);
}

.ui-input:focus {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

select.ui-input {
  cursor: pointer;
}

@media (max-width: 720px) {
  .ui-input {
    min-height: var(--hit-target);
  }

  .af-weekday {
    min-height: var(--hit-target);
  }
}
</style>
