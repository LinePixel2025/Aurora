<script setup lang="ts">
/**
 * 类型图标（docs/07 §2.3，2026-11-12）：按扩展名上色的小方块。
 * `--fp-tone` 由外层 `FilePreviewPanel.vue` 按 `data-tone` 统一派发（色相只定义一处），
 * 因此本组件只用在 `.fp` 作用域内。
 */
import { computed } from 'vue'
import { fileTypeMetaOf } from './fileTypeMeta'

const props = withDefaults(
  defineProps<{
    name: string
    kind?: 'dir' | 'file'
    /** 图标本身的像素尺寸 */
    size?: number
    /** 外层色块尺寸（列表 20 / 信息卡 32） */
    box?: number
  }>(),
  { kind: 'file', size: 16, box: 20 },
)

const meta = computed(() => fileTypeMetaOf(props.name, props.kind))
</script>

<template>
  <span
    class="fp-kind-icon"
    :data-tone="meta.tone"
    :style="{ width: `${box}px`, height: `${box}px` }"
    :title="meta.label"
  >
    <component :is="meta.icon" :size="size" :stroke-width="1.75" aria-hidden="true" />
  </span>
</template>

<style scoped>
.fp-kind-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--fp-tone, var(--text-muted));
  background: color-mix(in srgb, var(--fp-tone, var(--text-muted)) 14%, transparent);
}
</style>
