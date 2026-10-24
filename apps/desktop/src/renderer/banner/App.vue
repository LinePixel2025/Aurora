<script setup lang="ts">
/**
 * 流光提醒窗口的入口（docs/07 §2.2.3）。
 *
 * 一个入口、两个窗口：`?layer=glow` 画屏幕顶端的流光带（整屏透明、鼠标穿透），
 * `?layer=card` 画置顶卡片（紧凑、可点）。主进程把**同一条** `banner:show` 载荷推给两者，
 * 各自只取自己关心的部分 —— 光带层只要"有人来了"，卡片层要标题 / 正文 / 时长。
 *
 * 两个窗口都不走 `bootstrapApp`：浮层只跑一次 `settings:get` + 订阅（见 settings.ts）。
 *
 * 动效的两条时间线（**必须与 BannerCard.vue / GlowBand.vue 的时长一致**）：
 * - 入场：卡片由 `<Transition>` 播「从流光里落下」（Vue 会强制插入一帧初始态，所以真的会动）；
 * - 退场：到 `durationMs - LEAVE_MS` 时把载荷置空（播 leave）+ 光带淡出，
 *   `durationMs` 时再回执关窗 —— 窗口是全透明浮层，动画只能在窗口内完成。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import type { BannerShowPayload } from '@aurora/shared'
import BannerCard from './BannerCard.vue'
import GlowBand from './GlowBand.vue'
import { ttsReady } from './settings.js'

const params = new URLSearchParams(window.location.search)
const layer: 'glow' | 'card' = params.get('layer') === 'glow' ? 'glow' : 'card'
/** 截图核对用：固定渲染示例卡片，不自动关闭（`AURORA_CAPTURE_ONLY='banner'`） */
const preview = params.has('preview')

/** 示例内容：与真实卡片走**同一套**渲染与探针（截图证明的是这张卡，而不是另一段静态 HTML） */
const PREVIEW_PAYLOAD: BannerShowPayload = {
  id: 'banner-preview',
  title: '文件已整理完成',
  body: '《高数错题整理.docx》已归档到「数学 / 错题本」，共处理 3 个文件。',
  speak: false,
  sound: false,
  durationMs: 60_000,
  level: 'success',
}

const payload = ref<BannerShowPayload | null>(preview ? PREVIEW_PAYLOAD : null)
/** 光带层是否点亮（退场时先关掉，让光带跟着淡出） */
const visible = ref(preview)
/** 当前展示的 id：载荷退场后仍要用它回执（迟到 / 重复回执由主进程按 id 丢弃） */
const currentId = ref(preview ? PREVIEW_PAYLOAD.id : '')
let offShow: (() => void) | null = null
let fadeTimer: number | null = null
let dismissTimer: number | null = null
/** 退场动画是否已开始（决定回执要不要再等一个动画时长） */
let leaving = false

/** 退场动画时长：与 BannerCard 的 leave / GlowBand 的淡出一致 */
const LEAVE_MS = 320

function clearTimers(): void {
  if (fadeTimer !== null) {
    window.clearTimeout(fadeTimer)
    fadeTimer = null
  }
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer)
    dismissTimer = null
  }
}

/** 开始退场：拿掉载荷（卡片播 leave）+ 熄灭光带。重复调用无副作用。 */
function startLeave(): void {
  if (leaving) return
  leaving = true
  payload.value = null
  visible.value = false
}

/** 收到一条提醒：重置计时并重新播入场动画（排队时上一条已由主进程收掉） */
function present(next: BannerShowPayload): void {
  clearTimers()
  leaving = false
  currentId.value = next.id
  payload.value = next
  visible.value = true
  if (preview) return
  fadeTimer = window.setTimeout(
    () => {
      fadeTimer = null
      startLeave()
    },
    Math.max(0, next.durationMs - LEAVE_MS),
  )
  dismissTimer = window.setTimeout(() => {
    dismissTimer = null
    void dismiss()
  }, next.durationMs)
}

/**
 * 关闭（用户点卡片 / 关闭按钮，或到时）：先让卡片播完退场动画，再回主进程。
 *
 * 只有**卡片层**发回执（光带层也订阅了同一条推送，两边都回执会让主进程收到两条，
 * 第二条因 id 不匹配被忽略 —— 不致命但没必要）。主进程另有兜底定时器，
 * 所以就算这里卡住，卡片也不会永远挂在屏幕上。
 */
async function dismiss(): Promise<void> {
  clearTimers()
  const id = currentId.value
  currentId.value = ''
  // 退场还没开始（用户点了关闭）= 需要等一个动画时长；已经开始（到时自动关）= 立刻回执
  const waitForAnimation = !leaving
  startLeave()
  if (layer !== 'card' || id === '' || preview) return
  const send = (): void => {
    void window.aurora.banner.dismiss(id).catch(() => {
      // 主进程已退出 / 通道不可用：不需要补救，窗口会随进程一起消失
    })
  }
  if (waitForAnimation) window.setTimeout(send, LEAVE_MS)
  else send()
}

onMounted(() => {
  offShow = window.aurora.banner.onShow((next) => present(next))
})

onUnmounted(() => {
  offShow?.()
  offShow = null
  clearTimers()
})
</script>

<template>
  <GlowBand v-if="layer === 'glow'" :active="visible" />
  <BannerCard v-else :payload="payload" :tts-ready="ttsReady" :muted="preview" @close="dismiss" />
</template>

<style scoped>
/*
 * 两个窗口的页面底色都必须透明（原生窗口是 transparent: true）。
 * `overflow: hidden` 是硬要求：卡片按「窗口 = 卡片 + 24px」精确摆位，
 * 一旦出现滚动条（默认 `#app` 高度 100% + 内容超出一像素就会出），
 * 视口会比窗口少 8px —— 卡片右边 / 底部就会多留一条挡点击的透明带。
 */
:global(html),
:global(body) {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background: transparent;
  background-image: none;
}
</style>
