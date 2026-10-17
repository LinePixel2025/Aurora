<script setup lang="ts">
/**
 * 输入卡顶部的图片缩略图条（2026-10-18，Center Web）。
 *
 * 结构口径（与桌面端 `chat/components/ComposerAttachments.vue` 逐项对齐）：
 * - 挂在 `.composer-box` **内部**、`textarea` 上方（不是卡片外）—— 缩略图也是"这句消息"的一部分；
 * - 56×56 方块 + 单行横向滚动（多图不撑高输入卡）；
 * - 右上角移除按钮命中 ≥ 24px（WCAG 2.2 SC 2.5.8）；上传中叠半透明遮罩与旋转环；
 * - 缩略图 `src` 是本地 objectURL（`blob:`），上传失败时由父级移除条目并回收 URL。
 *
 * `data-field` 锚点（verify:web 探针依赖）：`chat.attachments`（条）/
 * `chat.attachment`（每张）/ `chat.attachment-thumb`（`<img>`）/ `chat.attachment-remove`（按钮）。
 */
import { X } from '@aurora/shared/browser'
import type { ComposerAttachment } from '../../../lib/composer-attachments'

defineProps<{ items: ComposerAttachment[] }>()

const emit = defineEmits<{ remove: [item: ComposerAttachment] }>()
</script>

<template>
  <div v-if="items.length > 0" class="attachments" data-field="chat.attachments">
    <div
      v-for="item in items"
      :key="item.id"
      class="attachment"
      :class="{ uploading: item.status === 'uploading' }"
      :title="item.name"
      data-field="chat.attachment"
      :data-attachment-id="item.id"
    >
      <img
        class="thumb"
        :src="item.previewUrl"
        :alt="item.name"
        data-field="chat.attachment-thumb"
        draggable="false"
      />
      <span v-if="item.status === 'uploading'" class="uploading-mask" aria-hidden="true">
        <span class="spin uploading-ring" />
      </span>
      <button
        type="button"
        class="remove"
        :aria-label="`移除 ${item.name}`"
        title="移除这张图片"
        data-field="chat.attachment-remove"
        @click="emit('remove', item)"
      >
        <X :size="10" :stroke-width="2.2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.attachments {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-1) 0 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}

.attachment {
  position: relative;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  overflow: hidden;
}

.thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment.uploading .thumb {
  opacity: 0.42;
}

.uploading-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.uploading-ring {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--aurora-blue);
  border-radius: 50%;
}

/*
 * 移除按钮：右上角 24×24 命中区，视觉上是一枚 18px 的圆底小胶囊
 * （56px 缩略图上再大就会盖住图片主体）。
 */
.remove {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 0 var(--radius-sm) 0 50%;
  background: color-mix(in srgb, #000 55%, transparent);
  color: #fff;
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast);
}

.attachment:hover .remove,
.remove:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, #000 72%, transparent);
}
</style>
