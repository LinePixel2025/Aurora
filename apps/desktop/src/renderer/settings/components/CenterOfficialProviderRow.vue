<script setup lang="ts">
import type { CenterOfficialCapability } from '@aurora/shared/browser'

defineProps<{
  capability: Exclude<CenterOfficialCapability, 'llm'>
  providerId: string
  model: string
  active: boolean
  available: boolean
  details: string[]
}>()

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
</style>
