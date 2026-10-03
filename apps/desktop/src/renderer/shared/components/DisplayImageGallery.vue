<script setup lang="ts">
/** 助手消息图片区：只拿无路径元数据，按 imageId 向主进程按需读取 data URL。 */
import { onBeforeUnmount, reactive, watch } from 'vue'
import type { ChatDisplayImage } from '@aurora/shared'

const props = defineProps<{ images: ChatDisplayImage[]; sessionId: string }>()

interface ImageState {
  dataUrl?: string
  error?: string
  loading: boolean
}

const state = reactive(new Map<string, ImageState>())
let requestId = 0

async function loadImage(image: ChatDisplayImage): Promise<void> {
  const existing = state.get(image.id)
  if (existing !== undefined && (existing.loading || existing.dataUrl !== undefined)) return
  state.set(image.id, { loading: true })
  const current = requestId
  if (props.sessionId === '') {
    state.set(image.id, { loading: false, error: '当前会话不可用' })
    return
  }
  try {
    const result = await window.aurora.chat.readDisplayImage({
      sessionId: props.sessionId,
      imageId: image.id,
    })
    if (current !== requestId) return
    if (result.ok) state.set(image.id, { loading: false, dataUrl: result.value.dataUrl })
    else state.set(image.id, { loading: false, error: result.message || '图片不可用' })
  } catch (error) {
    if (current !== requestId) return
    state.set(image.id, {
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function reload(): void {
  requestId += 1
  for (const image of props.images) void loadImage(image)
}

watch(
  () => `${props.sessionId}\u0000${props.images.map((image) => image.id).join('\u0000')}`,
  () => reload(),
  { immediate: true },
)

onBeforeUnmount(() => {
  requestId += 1
})
</script>

<template>
  <div v-if="images.length > 0" class="display-images" data-field="chat.display-images">
    <figure v-for="image in images" :key="image.id" class="display-image" :data-image-id="image.id">
      <img
        v-if="state.get(image.id)?.dataUrl"
        :src="state.get(image.id)!.dataUrl"
        :alt="image.caption || image.name"
        loading="lazy"
      />
      <div
        v-else
        class="display-image-fallback"
        :title="state.get(image.id)?.error || ''"
        :data-error="state.get(image.id)?.error || ''"
      >
        <span>{{ state.get(image.id)?.loading ? '正在加载图片…' : '图片不可用' }}</span>
        <small>{{ image.name }}</small>
      </div>
      <figcaption v-if="image.caption">{{ image.caption }}</figcaption>
    </figure>
  </div>
</template>

<style scoped>
.display-images {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
  min-width: 0;
}

.display-image {
  margin: 0;
  min-width: 0;
  max-width: 560px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--fill-1);
}

.display-image img {
  display: block;
  width: 100%;
  max-height: 420px;
  object-fit: contain;
  background: var(--bg-base);
}

.display-image-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 120px;
  padding: var(--space-4);
  color: var(--text-muted);
  text-align: center;
}

.display-image-fallback small {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.display-image figcaption {
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
</style>
