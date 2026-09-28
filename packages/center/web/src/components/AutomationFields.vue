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
  <div class="auto-fields">
    <template v-for="field in fields" :key="field.key">
      <label class="auto-field">
        <span class="auto-field-label">{{ field.label }}</span>

        <input
          v-if="field.type === 'text'"
          class="input"
          type="text"
          :placeholder="field.placeholder ?? ''"
          :value="
            typeof modelValue[field.key] === 'string' ? (modelValue[field.key] as string) : ''
          "
          @input="onTextInput(field.key, $event)"
        />

        <input
          v-else-if="field.type === 'number'"
          class="input"
          type="number"
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
          class="input"
          type="time"
          :placeholder="field.placeholder ?? ''"
          :value="
            typeof modelValue[field.key] === 'string' ? (modelValue[field.key] as string) : ''
          "
          @input="onTextInput(field.key, $event)"
        />

        <select
          v-else-if="field.type === 'select'"
          class="input"
          :value="
            typeof modelValue[field.key] === 'string' ? (modelValue[field.key] as string) : ''
          "
          @change="onSelect(field.key, $event)"
        >
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <span v-else-if="field.type === 'weekdays'" class="weekday-row">
          <label v-for="(name, day) in WEEKDAY_NAMES" :key="day" class="weekday-item">
            <input
              type="checkbox"
              :checked="weekdayList(field.key).includes(day)"
              @change="onWeekdayToggle(field.key, day, $event)"
            />
            <span>{{ name }}</span>
          </label>
        </span>

        <small v-if="field.hint" class="auto-field-hint">{{ field.hint }}</small>
      </label>
    </template>
  </div>
</template>

<style scoped>
.auto-fields {
  display: grid;
  gap: 10px;
}

.auto-field {
  display: grid;
  gap: 4px;
  font-size: 13px;
}

.auto-field-label {
  color: var(--text-2);
  font-size: 12.5px;
}

.auto-field-hint {
  color: var(--muted);
  font-size: 12px;
}

.weekday-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.weekday-item {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12.5px;
  cursor: pointer;
}
</style>
