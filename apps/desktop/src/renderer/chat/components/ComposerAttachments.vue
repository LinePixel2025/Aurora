<script setup lang="ts">
/**
 * 输入卡内的附件条（2026-10-18，docs/07 §2.3 输入框规格）。
 *
 * 位置：挂在 `.composer-box` **内部**、`<textarea>` **上方**（此前 attachments 挂在整张输入卡
 * 外面，拖进一张图之后消息列会被顶下一行，缩略图与输入框看起来是两个控件）。
 * 单行横向滚动而不是换行：附件是「这一句要带出去的东西」，多张图换行会把输入卡顶高，
 * 与 textarea 自动增高抢垂直空间。
 *
 * 两种形态：
 * - **图片**：56×56 缩略图卡片（`object-fit: cover`，非正方形不拉伸）；
 *   缩略图来自主进程 `chat:readAttachment` / `chat:stageImage` 回传的 `data:` URL
 *   （渲染进程没有 fs 能力，也是 CSP `img-src 'self' data:` 放行的唯一来源）。
 *   没拿到 `dataUrl`（超限 / 读失败 / 非图片）时**只画占位图标，绝不渲染 src 空的 `<img>`**
 *   —— 裂图比没有图更糟，原因放在 `title` 里。
 * - **非图片**：胶囊 chip（文件图标 + 文件名），与从前观感一致。
 *
 * 移除按钮在缩略图**右上角**（命中区 24×24，够 WCAG 2.2 SC 2.5.8 下限）；
 * 非图片 chip 的移除按钮内联在行尾，同样是 24×24。
 *
 * 探针锚点（一个元素一个锚点，代码不参与渲染）：
 * - `chat.attachments`：整条容器；`chat.attachment`：每一项；
 * - `chat.attachment-thumb`：**只有真的画出缩略图时**才挂；
 * - `chat.attachment-remove`：移除按钮。
 *
 * 纯展示组件：数据与移除结果都由调用方（`chat/App.vue`）持有，组件不缓存第二份。
 */
import type { ChatAttachmentPreview } from '@aurora/shared'
import { FileText, ImageIcon, X } from '@aurora/shared/browser'

const props = defineProps<{
  /** 附件绝对路径（与 `chat:send` 的 `attachments` 同一个值，也是 v-for 的 key） */
  attachments: string[]
  /** 路径 → 预览（主进程回传；缺项 = 还没读到 / 不是图片 / 读取失败） */
  previews: Record<string, ChatAttachmentPreview>
}>()

const emit = defineEmits<{ remove: [path: string] }>()

/** 与主进程附件解析同口径的图片扩展名（`preview.image` 缺省时的兜底判定） */
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|bmp)$/i

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

function previewOf(path: string): ChatAttachmentPreview | undefined {
  return props.previews[path]
}

function isImage(path: string): boolean {
  return previewOf(path)?.image === true || IMAGE_EXTENSION.test(fileNameOf(path))
}

/** 缩略图数据 URL；空串 = 没有可画的缩略图（决定「画图」还是「画占位图标」） */
function thumbOf(path: string): string {
  return previewOf(path)?.dataUrl ?? ''
}

/**
 * 悬浮提示：优先文件名（主进程解析的 `name`），其次是没生成缩略图的原因。
 * 两条都给不出来时退回路径末段 —— 不能让用户看着一个没有名字的方块。
 */
function titleOf(path: string): string {
  const preview = previewOf(path)
  const name = preview !== undefined && preview.name !== '' ? preview.name : fileNameOf(path)
  return preview?.note === undefined ? name : `${name}｜${preview.note}`
}

function remove(path: string): void {
  emit('remove', path)
}
</script>

<template>
  <div v-if="attachments.length > 0" class="attachments" data-field="chat.attachments">
    <div
      v-for="path in attachments"
      :key="path"
      class="attachment"
      :class="{ image: isImage(path), 'with-thumb': thumbOf(path) !== '' }"
      :title="titleOf(path)"
      data-field="chat.attachment"
      :data-path="path"
    >
      <!-- 图片且拿到了缩略图：56×56 封面图；src 只在真有数据时才绑，避免裂图 -->
      <img
        v-if="isImage(path) && thumbOf(path) !== ''"
        class="attachment-thumb"
        data-field="chat.attachment-thumb"
        :src="thumbOf(path)"
        :alt="fileNameOf(path)"
        draggable="false"
      />
      <!-- 图片但没拿到缩略图：占位图标（原因在 title 里），不显示裂图 -->
      <span v-else-if="isImage(path)" class="attachment-placeholder" aria-hidden="true">
        <ImageIcon :size="18" :stroke-width="1.6" />
      </span>
      <!-- 非图片：文件图标 + 文件名（长名省略，不撑破单行） -->
      <template v-else>
        <FileText class="attachment-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
        <span class="attachment-name">{{ fileNameOf(path) }}</span>
      </template>
      <button
        type="button"
        class="attachment-remove"
        data-field="chat.attachment-remove"
        aria-label="移除附件"
        title="移除附件"
        @click.stop="remove(path)"
      >
        <X :size="12" :stroke-width="2.4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 单行横向滚动：不换行（多张图换行会把输入卡顶高，与 textarea 自动增高抢空间）。
 * `overflow-y: hidden` 是必要的：只写 overflow-x 时另一轴会变成 auto，缩略图的圆角/阴影
 * 会让容器冒出一条竖向滚动条。
 */
.attachments {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-2);
  padding: 2px 0 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--fill-3) transparent;
}

/* 每一项都不参与收缩：横向滚动靠容器，不靠把缩略图压小 */
.attachment {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--fill-2);
  color: var(--text-secondary);
}

/* 图片：56×56 卡片（缩略图铺满，圆角裁切） */
.attachment.image {
  width: 56px;
  height: 56px;
  padding: 0;
  overflow: hidden;
}

.attachment-thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}

/* 没有缩略图的图片：只留一枚图标，铺满同一块 56×56 —— 尺寸不变，卡片不会跳 */
.attachment-placeholder {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: var(--text-muted);
}

/* 非图片 chip：28px 高胶囊（与工具行芯片同高），文件名过长就省略 */
.attachment:not(.image) {
  height: var(--control-h-xs);
  max-width: 220px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-pill);
}

.attachment-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.attachment-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--text-xs);
}

/*
 * 移除按钮：24×24 的命中区（WCAG 2.2 SC 2.5.8 下限），视觉上一枚小圆点。
 * 图片卡片上钉在右上角并压一层半透明深底 —— 缩略图本身颜色不可控，浅色图上白叉会消失。
 * 非图片 chip 上内联在行尾（`position: static`），保持胶囊的横向观感。
 */
.attachment-remove {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.attachment-remove:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

.attachment-remove:focus-visible {
  outline: none;
  color: var(--text-primary);
  box-shadow: 0 0 0 1px var(--focus-ring);
}

.attachment.image .attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  background: color-mix(in srgb, #000 52%, transparent);
  color: #fff;
}

.attachment.image .attachment-remove:hover {
  background: color-mix(in srgb, #000 72%, transparent);
  color: #fff;
}
</style>
