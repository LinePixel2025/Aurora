<script setup lang="ts">
/**
 * 流光提醒的**卡片层**（docs/07 §2.2.3）。
 *
 * 视觉口径：Apple HIG 的克制分层 —— 一块 `--bg-overlay` 填充 + 1px hairline + `--radius-lg`
 * 大圆角 + `--shadow-2` 柔和阴影；左侧一条 3px 语义色条（info / success / warning / error）。
 * **不用品牌双色渐变**（`--aurora-gradient` 是纯强调色，全仓禁渐变彩带）。
 *
 * 入场 / 退场走 Vue `<Transition>` 而不是「挂载时就把最终 class 写上」：
 * 后者浏览器不会播动画（元素插入时没有发生样式变化），表现就是「弹出来没有动效」。
 * `<Transition>` 会先插入初始态、强制一帧、再切到终态，动画才真的发生。
 *
 * 高度由**内容**决定（`height: auto`），量出来之后立刻回报主进程 —— 主进程把窗口调成
 * 「卡片 + 24px 外边距」。为什么不按字符数估算：真实换行取决于字体与中英混排，
 * 估算偏大 = 透明窗口多出一块挡点击的死区，偏小 = 正文被裁掉。主进程因此只用
 * `BANNER_CARD.initialHeight` 占位（约 1–2 帧），真实高度一律以这里量到的为准。
 *
 * 字号 / 内边距 / 关闭按钮全部用 `cqw` 跟卡片宽度联动（根节点是容器查询锚点）：
 * 主进程只决定宽度（按显示器比例），渲染层决定"字有多大"，两边不会各写一套数字。
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BannerShowPayload } from '@aurora/shared'
import { useTts } from '../shared/composables/useTts.js'
import { playBannerChime } from '../shared/chime.js'

const props = defineProps<{
  payload: BannerShowPayload | null
  ttsReady: boolean
  /** 截图核对 / 预览：不播音、不朗读（否则每跑一轮截图都会响） */
  muted: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const tts = useTts()
const cardEl = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null
let reportedHeight = -1

/**
 * 把卡片真实高度回报主进程（幂等：0.5px 内的重复回报直接跳过，避免和窗口 resize 来回抖）。
 * 用 `offsetHeight` 而不是 `getBoundingClientRect()`：后者把入场动画的 `transform: scale`
 * 算进去，量到的是「动画中的高度」。
 */
function reportHeight(): void {
  const element = cardEl.value
  if (element === null) return
  const height = element.offsetHeight
  if (height <= 0) return
  if (Math.abs(height - reportedHeight) < 0.5) return
  reportedHeight = height
  void window.aurora.banner.measure({ id: props.payload?.id ?? '', height })
}

watch(
  () => props.payload,
  (next) => {
    tts.stop()
    if (next === null) return
    reportedHeight = -1
    // 内容换了 → 高度可能变了：等 DOM 更新再量（ResizeObserver 只在尺寸真的变化时才回调）
    void nextTick(() => requestAnimationFrame(reportHeight))
    if (props.muted) return
    if (next.sound) playBannerChime(next.volume)
    // 语音也按同一个音量设置播（用户调的是「提醒有多大声」，不是「音效多大声」）
    tts.volume.value = next.volume
    if (next.speak && props.ttsReady) {
      // 朗读「标题 + 正文」：正文为空时只读标题，避免念出一个孤零零的句号
      const text = next.body === '' ? next.title : `${next.title}。${next.body}`
      void tts.speak(text, next.id)
    }
  },
)

onMounted(() => {
  observer = new ResizeObserver(() => reportHeight())
  if (cardEl.value !== null) observer.observe(cardEl.value)
  reportHeight()
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
  tts.stop()
})
</script>

<template>
  <div class="banner-card-root">
    <!--
      入场：从流光里落下（位移 + 轻微放大 + 淡入，春季曲线收尾）。
      退场：向上缩回并淡出 —— 窗口在动画结束后才被主进程隐藏（见 App.vue 的时间线）。
    -->
    <Transition name="banner-card">
      <article
        v-if="payload !== null"
        :key="payload.id"
        ref="cardEl"
        class="banner-card"
        :class="`banner-card--${payload.level}`"
        role="alert"
        data-field="banner.card"
        @click="emit('close')"
      >
        <span class="banner-card-accent" aria-hidden="true" />
        <div class="banner-card-text">
          <h1 class="banner-card-title" data-field="banner.title">{{ payload.title }}</h1>
          <p v-if="payload.body !== ''" class="banner-card-body" data-field="banner.body">
            {{ payload.body }}
          </p>
        </div>
        <button
          class="banner-card-close"
          type="button"
          aria-label="关闭提醒"
          data-field="banner.close"
          @click.stop="emit('close')"
        >
          <span aria-hidden="true">×</span>
        </button>
      </article>
    </Transition>
  </div>
</template>

<style scoped>
.banner-card-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  /*
   * 字号随卡片宽度流体放大（大屏 / 教室投影后排可读）：根节点就是**容器查询锚点**，
   * 它的宽度 = 窗口宽 = 卡片 + 24px 外边距，所以卡片里的 `cqw` 永远跟主进程给的宽度同源，
   * 不用 `100vw`（会踩「滚动条让视口比窗口少几像素」的老坑），也不需要主进程再写一套字号。
   */
  container-type: inline-size;
}

.banner-card {
  /* 卡片内的尺寸尺度统一从这里派生：全部跟窗口宽度联动 */
  --banner-pad: clamp(14px, 2cqw, 22px);
  --banner-gap: clamp(10px, 1.4cqw, 16px);
  --banner-close: clamp(30px, 3.6cqw, 40px);
  --banner-accent: clamp(3px, 0.5cqw, 5px);
  /* 12px 外边距留给阴影：主进程据此把窗口调成「卡片 + 24px」，多出来的区域才会挡住点击 */
  position: relative;
  box-sizing: border-box;
  display: flex;
  gap: var(--banner-gap);
  width: calc(100% - 24px);
  margin: 12px;
  /* 右侧给关闭按钮留位（pad + 按钮 + 4px 余量）：卡片放大后文字不会压到按钮 */
  padding: var(--banner-pad) calc(var(--banner-pad) + var(--banner-close) + 4px) var(--banner-pad)
    var(--banner-pad);
  border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
  border-radius: var(--radius-lg);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-2);
  color: var(--text-primary);
  pointer-events: auto;
  cursor: default;
  transform-origin: 50% 0;
  will-change: transform, opacity;
}

/* ─── 入场：从流光里落下 ─── */
.banner-card-enter-from {
  opacity: 0;
  transform: translate3d(0, -26px, 0) scale(0.93);
}

.banner-card-enter-active {
  transition:
    opacity 280ms var(--ease-standard),
    transform 540ms var(--ease-spring);
}

.banner-card-enter-to {
  opacity: 1;
  transform: none;
}

/* ─── 退场：缩回流光并淡出（时长与 App.vue 的 LEAVE_MS 一致） ─── */
.banner-card-leave-from {
  opacity: 1;
  transform: none;
}

.banner-card-leave-active {
  transition:
    opacity 320ms var(--ease-standard),
    transform 320ms var(--ease-standard);
}

.banner-card-leave-to {
  opacity: 0;
  transform: translate3d(0, -14px, 0) scale(0.97);
}

/* 语义色条：只表达档位，不做渐变 */
.banner-card-accent {
  flex: none;
  width: var(--banner-accent);
  border-radius: 2px;
  background: var(--aurora-blue);
}

.banner-card--success .banner-card-accent {
  background: var(--status-ok);
}

.banner-card--warning .banner-card-accent {
  background: var(--status-unread);
}

.banner-card--error .banner-card-accent {
  background: var(--status-error);
}

.banner-card-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: clamp(6px, 0.9cqw, 10px);
}

/* 标题与正文比卡片晚一点点出现（30ms 错峰），落下的层次更清楚 */
.banner-card-enter-active .banner-card-text {
  animation: banner-card-text-in 300ms var(--ease-standard) both;
  animation-delay: 60ms;
}

@keyframes banner-card-text-in {
  from {
    opacity: 0;
    transform: translate3d(0, -4px, 0);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.banner-card-title {
  margin: 0;
  font-size: clamp(19px, 3.3cqw, 34px);
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: 0.1px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.banner-card-body {
  margin: 0;
  font-size: clamp(16px, 2.8cqw, 28px);
  line-height: 1.45;
  /* 投影 / 大屏上看的是对比度：正文用主文本色，层次靠字号而不是靠"更灰" */
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.banner-card-close {
  position: absolute;
  /* 锚定卡片自身（`.banner-card` 是 relative），内缩量与内边距联动 */
  top: calc(var(--banner-pad) - 4px);
  right: calc(var(--banner-pad) - 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--banner-close);
  height: var(--banner-close);
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-secondary) 16%, transparent);
  color: var(--text-secondary);
  font-size: calc(var(--banner-close) * 0.6);
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 160ms var(--ease-standard),
    color 160ms var(--ease-standard);
}

.banner-card-close:hover {
  background: color-mix(in srgb, var(--text-secondary) 28%, transparent);
  color: var(--text-primary);
}

.banner-card-close:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .banner-card-enter-active,
  .banner-card-leave-active {
    transition: opacity 120ms linear;
  }

  .banner-card-enter-from {
    transform: none;
  }

  .banner-card-leave-to {
    transform: none;
  }

  .banner-card-enter-active .banner-card-text {
    animation: none;
  }
}
</style>
