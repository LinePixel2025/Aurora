<script setup lang="ts">
/**
 * 插件配置表单（docs/14 §5）：字段完全来自清单 `config.fields`，只允许
 * text / number / boolean / select / textarea（**没有密文字段**），保存走 `plugins:setConfig`
 * ——主进程按清单再过滤一次，未知键 / 类型不符直接丢弃。
 */
import { onMounted, ref } from 'vue'
import type { PluginConfigField } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'

const props = defineProps<{
  pluginId: string
  fields: PluginConfigField[]
}>()

const values = ref<Record<string, unknown>>({})
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

function initialValue(field: PluginConfigField): unknown {
  if (field.default !== undefined) return field.default
  if (field.type === 'boolean') return false
  if (field.type === 'number') return field.min ?? 0
  if (field.type === 'select') return field.options?.[0]?.value ?? ''
  return ''
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  const result = await window.aurora.plugins.getConfig({ pluginId: props.pluginId })
  if (!result.ok) {
    error.value = result.message
    loading.value = false
    return
  }
  const merged: Record<string, unknown> = {}
  for (const field of props.fields) {
    merged[field.key] = result.value[field.key] ?? initialValue(field)
  }
  values.value = merged
  loading.value = false
}

async function save(): Promise<void> {
  saving.value = true
  error.value = null
  notice.value = null
  const result = await window.aurora.plugins.setConfig({
    pluginId: props.pluginId,
    values: { ...values.value },
  })
  saving.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  values.value = { ...result.value }
  notice.value = '已保存，插件会收到 config.changed'
}

function textValue(field: PluginConfigField): string {
  const value = values.value[field.key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

function numberValue(field: PluginConfigField): number {
  const value = values.value[field.key]
  return typeof value === 'number' && Number.isFinite(value) ? value : (field.min ?? 0)
}

function setText(field: PluginConfigField, event: Event): void {
  values.value = {
    ...values.value,
    [field.key]: (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value,
  }
}

function setNumber(field: PluginConfigField, event: Event): void {
  const parsed = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(parsed)) return
  values.value = { ...values.value, [field.key]: parsed }
}

function setBoolean(field: PluginConfigField, event: Event): void {
  values.value = {
    ...values.value,
    [field.key]: (event.target as HTMLInputElement).checked,
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="plugin-config">
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-else-if="notice" tone="ok">{{ notice }}</AppToast>

    <p v-if="loading" class="muted tiny">正在读取配置…</p>
    <template v-else>
      <label v-for="field in fields" :key="field.key" class="cfg-field">
        <span class="cfg-label">
          {{ field.label }}
          <span v-if="field.description" class="cfg-desc">{{ field.description }}</span>
        </span>

        <span v-if="field.type === 'boolean'" class="cfg-check">
          <input
            type="checkbox"
            :checked="values[field.key] === true"
            @change="setBoolean(field, $event)"
          />
          <span>{{ field.placeholder ?? '开启' }}</span>
        </span>

        <textarea
          v-else-if="field.type === 'textarea'"
          rows="4"
          :value="textValue(field)"
          :placeholder="field.placeholder ?? ''"
          @input="setText(field, $event)"
        ></textarea>

        <select
          v-else-if="field.type === 'select'"
          :value="textValue(field)"
          @change="setText(field, $event)"
        >
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <input
          v-else-if="field.type === 'number'"
          type="number"
          :value="numberValue(field)"
          :min="field.min"
          :max="field.max"
          :step="field.step"
          :placeholder="field.placeholder ?? ''"
          @input="setNumber(field, $event)"
        />

        <input
          v-else
          type="text"
          :value="textValue(field)"
          :placeholder="field.placeholder ?? ''"
          @input="setText(field, $event)"
        />
      </label>

      <div class="cfg-actions">
        <AppButton size="sm" variant="primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存配置' }}
        </AppButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plugin-config {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cfg-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cfg-label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.cfg-desc {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.cfg-check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.cfg-check input {
  accent-color: var(--aurora-blue);
}

input[type='text'],
input[type='number'],
textarea,
select {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.cfg-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
