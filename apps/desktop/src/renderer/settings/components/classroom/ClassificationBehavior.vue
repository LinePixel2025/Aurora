<script setup lang="ts">
/**
 * 分类行为 + 分类流水（docs/05 §3.2/§3.3）。
 * 拆分自 `ClassroomSection.vue`；门控（step-06 B）：
 * - `classification.confidenceThreshold` 只在 `subjects.length > 0` 时存在（没有科目可判定，阈值无意义）；
 * - `classification.fallbackFolder` 只在 `classification.autoMove === true` 时存在（不移动文件就没有兜底去处）。
 */
import { computed, ref } from 'vue'
import type { ClassroomModeConfig } from '@aurora/shared'
import ClassificationLedger from '../../../shared/components/ClassificationLedger.vue'
import SettingField from '../../../shared/components/SettingField.vue'
import type { ClassroomNotify, ClassroomPatch } from './types.js'

const props = defineProps<{
  classroom: ClassroomModeConfig
  patch: ClassroomPatch
  notify: ClassroomNotify
}>()

/** 滑条拖动中的草稿值：松手才落盘，避免每拖一格都写配置。 */
const thresholdDraft = ref<number | null>(null)
const threshold = computed(
  () => thresholdDraft.value ?? props.classroom.classification.confidenceThreshold,
)

async function patchClassification(
  change: Partial<ClassroomModeConfig['classification']>,
): Promise<void> {
  await props.patch({ classification: { ...props.classroom.classification, ...change } })
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}

function onThresholdInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) thresholdDraft.value = value
}

async function commitThreshold(): Promise<void> {
  const value = thresholdDraft.value
  if (value === null) return
  await patchClassification({ confidenceThreshold: clamp01(value) })
  thresholdDraft.value = null
}

async function setFallbackFolder(value: string): Promise<void> {
  const folder = value.trim()
  if (folder === '' || folder === props.classroom.classification.fallbackFolder) return
  await patchClassification({ fallbackFolder: folder })
}
</script>

<template>
  <SettingField
    data-field="modes.classroom.classification.autoMove"
    label="自动移动文件"
    hint="关闭后只记录流水、不移动文件"
  >
    <label class="row tiny">
      <input
        type="checkbox"
        :checked="classroom.classification.autoMove"
        @change="patchClassification({ autoMove: ($event.target as HTMLInputElement).checked })"
      />
      <span>判定成功后自动归类</span>
    </label>
  </SettingField>

  <template v-if="classroom.subjects.length > 0">
    <SettingField
      data-field="modes.classroom.classification.confidenceThreshold"
      label="置信阈值"
      hint="低于该置信度的判定不猜，直接进兜底文件夹（0 ～ 1）"
    >
      <input
        class="input slider"
        type="range"
        min="0"
        max="1"
        step="0.05"
        :value="threshold"
        @input="onThresholdInput"
        @change="commitThreshold"
      />
      <span class="badge">{{ threshold.toFixed(2) }}</span>
    </SettingField>
  </template>
  <p v-else class="section-desc" data-empty="modes.classroom.classification.confidenceThreshold">
    先添加科目：没有科目可判定时，置信阈值不产生作用。
  </p>

  <template v-if="classroom.classification.autoMove">
    <SettingField
      data-field="modes.classroom.classification.fallbackFolder"
      label="兜底文件夹"
      hint="未判定出科目时的去处，相对感知文件夹或绝对路径"
    >
      <input
        class="input"
        type="text"
        spellcheck="false"
        placeholder="待分类"
        :value="classroom.classification.fallbackFolder"
        @change="setFallbackFolder(($event.target as HTMLInputElement).value)"
      />
    </SettingField>
  </template>
  <p v-else class="section-desc" data-empty="modes.classroom.classification.fallbackFolder">
    已关闭自动移动：文件原地保留，不需要兜底文件夹。
  </p>

  <div class="divider" />
  <p class="section-desc">最近 50 条记录；可直接改到其他科目，修正会沉淀为分类规则。</p>
  <ClassificationLedger :limit="50" start-open />
</template>

<style scoped>
.slider {
  flex: 1;
  min-width: 0;
}

.badge {
  min-width: var(--control-h-md);
  justify-content: center;
  font-family: var(--font-mono);
  font-variant-numeric: var(--num-tabular);
}
</style>
