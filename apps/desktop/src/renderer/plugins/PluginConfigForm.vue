<script setup lang="ts">
/**
 * 插件配置表单（docs/07 §2.2.2）：字段来自清单 `config.fields`，只允许
 * text / number / boolean / select / textarea（**没有密文字段**），保存走
 * `plugins:setConfig`。主进程按清单再过滤一次，未知键 / 类型不符直接丢弃。
 *
 * 与旧内联版本的区别：字段用 `SettingField` 统一成「标签 + 说明 + 控件」三行，
 * 保存前展示脏态，支持恢复清单默认值，并给出保存结果。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { PluginConfigField } from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import SettingField from '../shared/components/SettingField.vue'

const props = defineProps<{
  pluginId: string
  fields: PluginConfigField[]
}>()

const emit = defineEmits<{ saved: [values: Record<string, unknown>] }>()

const values = ref<Record<string, unknown>>({})
const baseline = ref('')
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

function defaults(): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const field of props.fields) next[field.key] = initialValue(field)
  return next
}

function snapshot(input: Record<string, unknown>): string {
  return JSON.stringify(input)
}

const dirty = computed(() => snapshot(values.value) !== baseline.value)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  notice.value = null
  try {
    const result = await window.aurora.plugins.getConfig({ pluginId: props.pluginId })
    if (!result.ok) {
      error.value = result.message
      return
    }
    const merged = defaults()
    for (const field of props.fields) {
      const current = result.value[field.key]
      if (current !== undefined) merged[field.key] = current
    }
    values.value = merged
    baseline.value = snapshot(merged)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!dirty.value) return
  saving.value = true
  error.value = null
  notice.value = null
  try {
    const result = await window.aurora.plugins.setConfig({
      pluginId: props.pluginId,
      values: { ...values.value },
    })
    if (!result.ok) {
      error.value = result.message
      return
    }
    values.value = { ...result.value }
    baseline.value = snapshot(values.value)
    notice.value = '已保存，插件会收到 config.changed'
    emit('saved', values.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

function reset(): void {
  values.value = defaults()
  error.value = null
  notice.value = '已恢复清单默认值，点击「保存配置」后生效'
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

// 只在切换插件时重新读取；plugins:changed 会让 fields 数组换引用，跟着 reload 会
// 静默覆盖用户正在编辑的草稿（父组件用 requestId 作为 key 处理「重新打开」）。
watch(
  () => props.pluginId,
  () => void load(),
)

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="plugin-config-form" data-field="plugin-config.config">
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-else-if="notice" tone="ok">{{ notice }}</AppToast>

    <p v-if="loading" class="muted tiny">正在读取配置…</p>
    <p v-else-if="fields.length === 0" class="muted tiny">该插件没有可配置项。</p>
    <template v-else>
      <div class="fields">
        <SettingField
          v-for="field in fields"
          :key="field.key"
          :label="field.label"
          :hint="field.description ?? ''"
          :data-field="`plugin-config.config.${field.key}`"
        >
          <label v-if="field.type === 'boolean'" class="check">
            <input
              type="checkbox"
              :checked="values[field.key] === true"
              @change="setBoolean(field, $event)"
            />
            <span>{{ field.placeholder ?? '开启' }}</span>
          </label>

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
        </SettingField>
      </div>

      <div class="actions">
        <AppButton
          variant="ghost"
          size="sm"
          data-field="plugin-config.reset"
          :disabled="saving"
          @click="reset"
        >
          恢复默认
        </AppButton>
        <AppButton
          variant="primary"
          size="sm"
          data-field="plugin-config.save"
          :disabled="saving || !dirty"
          @click="save"
        >
          {{ saving ? '保存中…' : dirty ? '保存配置' : '已保存' }}
        </AppButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plugin-config-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.fields {
  display: flex;
  flex-direction: column;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.muted {
  color: var(--text-muted);
}
</style>
