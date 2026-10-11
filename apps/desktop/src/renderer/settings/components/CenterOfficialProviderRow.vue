<script setup lang="ts">
import { computed } from 'vue'
import type { CenterOfficialCapability, CenterOfficialServiceCatalog } from '@aurora/shared/browser'

const props = defineProps<{
  capability: Exclude<CenterOfficialCapability, 'llm'>
  providerId: string
  model: string
  active: boolean
  available: boolean
  details: string[]
  /** Center 官方目录里该能力的开放模型；目录缺席时下拉禁用 */
  service?: CenterOfficialServiceCatalog
  /** 当前已选的官方模型（`center.officialModels.<cap>.model`，与 Center 页同一字段） */
  selectionModel: string
}>()

const emit = defineEmits<{ (event: 'select-model', model: string): void }>()

const options = computed(() => {
  const list = (props.service?.models ?? []).map((model) => ({
    value: model.id,
    label: model.label ? `${model.label} · ${model.id}` : model.id,
  }))
  // 所选模型不在目录里（被下线 / 目录未加载）也要看得见
  if (props.selectionModel && !list.some((item) => item.value === props.selectionModel)) {
    list.unshift({ value: props.selectionModel, label: props.selectionModel })
  }
  return list
})

function onModelChange(event: Event): void {
  emit('select-model', (event.target as HTMLSelectElement).value)
}

const label = {
  tts: 'Center 官方语音合成',
  stt: 'Center 官方语音识别',
  imagegen: 'Center 官方生图',
} satisfies Record<Exclude<CenterOfficialCapability, 'llm'>, string>
</script>

<template>
  <article
    class="provider-row center-official-row"
    :class="{ accent: active }"
    :data-field="`${capability}.providers.${providerId}`"
  >
    <header class="provider-head">
      <strong class="mono">{{ providerId }}</strong>
      <span class="badge">{{ label[capability] }}</span>
      <span v-if="!available" class="badge warn">Center 暂不可用</span>
    </header>
    <p class="official-meta tiny muted">
      <span>凭据由 Center 托管</span>
      <span v-for="detail in details" :key="detail"> · {{ detail }}</span>
    </p>
    <label class="official-model tiny">
      <span>官方模型</span>
      <select
        class="input"
        :data-field="`center.officialModels.${capability}.row`"
        :value="selectionModel"
        :disabled="service === undefined"
        @change="onModelChange"
      >
        <option value="">（未选择）</option>
        <option v-for="item in options" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
    </label>
  </article>
</template>

<style scoped>
.center-official-row {
  border-color: color-mix(in srgb, var(--aurora-blue) 28%, var(--border-subtle));
  background: color-mix(in srgb, var(--aurora-blue) 4%, var(--bg-raised));
}

.provider-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.official-meta {
  margin: var(--space-2) 0 0;
  overflow-wrap: anywhere;
}

.official-model {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.official-model select {
  min-width: min(100%, 320px);
}
</style>
