<script setup lang="ts">
/**
 * 助手消息图片区：只拿无路径元数据，按 imageId 向主进程**按需**读取 data URL。
 *
 * 性能口径（2026-10-04）：进入视口附近（IntersectionObserver，rootMargin 300px）才读盘，
 * 且请求带 `maxDimension`（长边 720）由主进程缩略 —— 原图最大 10MB，多图会话直接 base64
 * 会让渲染进程常驻几百 MB。缺省不读；已读的缩略图保留。
 */
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ChatDisplayImage } from '@aurora/shared'

const props = defineProps<{ images: ChatDisplayImage[]; sessionId: string }>()

interface ImageState {
  dataUrl?: string
  error?: string
  loading: boolean
}

const state = reactive(new Map<string, ImageState>())
let requestId = 0
const rootEl = ref<HTMLElement | null>(null)
const visible = ref(false)
let observer: IntersectionObserver | null = null
const THUMBNAIL_MAX_DIMENSION = 720

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
      maxDimension: THUMBNAIL_MAX_DIMENSION,
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
  state.clear()
  loadAllVisible()
}

function loadAllVisible(): void {
  if (!visible.value) return
  for (const image of props.images) void loadImage(image)
}

watch(
  () => `${props.sessionId}\u0000${props.images.map((image) => image.id).join('\u0000')}`,
  () => reload(),
  { immediate: true },
)

onMounted(() => {
  const el = rootEl.value
  if (el === null || typeof IntersectionObserver !== 'function') {
    visible.value = true
    loadAllVisible()
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      visible.value = true
      observer?.disconnect()
      observer = null
      loadAllVisible()
    },
    { rootMargin: '300px 0px' },
  )
  observer.observe(el)
})

onBeforeUnmount(() => {
  requestId += 1
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div
    v-if="images.length > 0"
    ref="rootEl"
    class="display-images"
    data-field="chat.display-images"
  >
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
