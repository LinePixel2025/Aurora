<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/** 四条边：屏幕上下左右各一条极光边带（v33）。顺序稳定，探针按它逐条量矩形。 */
const EDGES = ['top', 'bottom', 'left', 'right'] as const

const preview = new URLSearchParams(window.location.search).has('preview')
const active = ref(preview)
let offChanged: (() => void) | null = null
let refreshToken = 0

async function refresh(): Promise<void> {
  if (preview) {
    active.value = true
    return
  }
  const token = ++refreshToken
  const result = await window.aurora.awareness.status()
  if (token !== refreshToken) return
  const progress = result.ok ? result.value.analysisProgress : undefined
  active.value =
    result.ok &&
    result.value.enabled &&
    result.value.consentAccepted &&
    result.value.knowledgeDirAvailable &&
    // v33：用户在设置页 / Agent 关掉流光特效后，这一页连 active 都不进
    result.value.glowEnabled !== false &&
    progress !== undefined &&
    progress.stage !== 'queued'
}

onMounted(() => {
  offChanged = window.aurora.awareness.onChanged(() => {
    void refresh()
  })
  void refresh()
})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
  refreshToken += 1
})
</script>

<template>
  <div
    class="awareness-glow"
    :class="{ active }"
    data-field="awareness-glow.root"
    aria-hidden="true"
  >
    <span
      v-for="edge in EDGES"
      :key="edge"
      class="glow-edge"
      :data-edge="edge"
      :data-field="`awareness-glow.${edge}`"
    >
      <span class="glow-bloom" />
      <span class="glow-halo" />
      <span class="glow-line" />
      <span class="glow-streak" />
    </span>
  </div>
</template>

<style scoped>
/*
 * 四周流光（v33）：窗口覆盖整块显示器，只在**四条边**上画极光边带 ——
 * 中部保持完全透明，配合主进程的鼠标穿透，全屏矩形不会挡住桌面与提示条。
 *
 * 每条边带的**内容、动画与关键帧与顶部那条完全同源**（只写一份）：方向差异靠三处：
 * 1. 上下边带的流光沿 screen-x 走（`background-position-x`），左右边带沿 screen-y 走
 *    （`background-position-y`）—— 同一条 `background-position` 简写，两个轴向都能生效，
 *    于是不需要四套关键帧，也不需要恢复 `alternate` 往复（那会让光带看起来在扫描）；
 * 2. 四条边都用**布局**摆位，只有下边带保留一个 `scaleY(-1)`（它要把「光幕向屏内渐隐」
 *    翻成自下而上；左右边带改用**换轴 + 横向遮罩**，不做旋转）；
 * 3. 关键帧里的 `opacity` / `translate` / `scale` 值在四条边上一字不差 —— 镜像与换轴只发生在
 *    容器与图层盒上。左右两条边带的世界坐标走向与上下相反：带内光带是宽而软的低对比度色团，
 *    贴着屏幕边缘时方向不可辨，这是刻意接受的简化（真要四向一致就得四套关键帧 + 四份图层规则）。
 */
.awareness-glow {
  position: fixed;
  inset: 0;
  /* 边带的 bloom 用 blur 溢出边带 —— 这里不能裁，否则四条边会出现硬切边 */
  overflow: visible;
  opacity: 0;
  transform: translate3d(0, -8px, 0) scaleY(0.84);
  transform-origin: 50% 0;
  filter: blur(11px);
  pointer-events: none;
  transition:
    opacity 620ms var(--ease-standard),
    transform 760ms var(--ease-spring),
    filter 620ms var(--ease-standard);
}

.awareness-glow.active {
  opacity: 1;
  transform: none;
  filter: none;
  animation: awareness-glow-enter 920ms cubic-bezier(0.16, 0.84, 0.3, 1) both;
}

/*
 * 边带容器：四条边都用**布局**定位（不用 rotate 摆位）——这样布局盒本身就是屏幕上
 * 那条边带，探针量到的矩形才有意义（rotate 只改渲染、不改布局盒，量出来的是旋转前的
 * 位置，会得出"边带跑到屏幕外"的假结论）。
 * 朝向差异只保留一处 `scaleY(-1)`：下边带需要把「bloom 贴边、光幕向屏内渐隐」翻过来。
 *
 * ⚠️ 这里**必须**用 `top` / `right` / `bottom` / `left` 长手属性，不能用 `inset` 简写：
 * CSS 的 `inset` 只接受长度与百分比，**不接受 `auto`** —— `inset: 0 auto auto 0` 整条声明
 * 非法被丢弃，回落到基准规则的 `inset: 0 0 auto`，纵向边带于是被 top+bottom 夹成 72px 方块
 * （2026-10-11 实测：左/右边带量到 72×72，只有左上角发光；长手属性则一切正常）。
 */
.glow-edge {
  --glow-band: 72px;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--glow-band);
  pointer-events: none;
}

.glow-edge[data-edge='bottom'] {
  top: auto;
  bottom: 0;
  transform: scaleY(-1);
  transform-origin: 50% 100%;
}

/* 左 / 右边带：沿屏幕**纵向**的一条边带（换轴，不做旋转）。
 * 高度必须显式 `auto` 把基准规则的 `height: 72px` 让掉，再由 top+bottom 拉满整条视口。 */
.glow-edge[data-edge='left'] {
  bottom: 0;
  width: var(--glow-band);
  height: auto;
}

.glow-edge[data-edge='right'] {
  left: auto;
  right: 0;
  bottom: 0;
  width: var(--glow-band);
  height: auto;
}

/*
 * 图层：参考「顶部 72px 边带」的原始比例定尺寸。
 * 基准形（上下边带）：沿边带方向 = 116% / -8%（两端各溢出 8%，避免 blur 后露硬边）；
 * 向屏内 = 52px / 60px。
 */
.glow-edge > span {
  position: absolute;
  top: 0;
  left: -8%;
  width: 116%;
  transform-origin: 50% 0;
  pointer-events: none;
}

.glow-bloom {
  height: 60px;
  background:
    radial-gradient(ellipse 32% 90% at 16% 0%, rgb(84 216 255 / 28%), transparent 72%),
    radial-gradient(ellipse 46% 104% at 45% 0%, rgb(124 111 255 / 30%), transparent 74%),
    radial-gradient(ellipse 38% 96% at 74% 0%, rgb(236 119 255 / 24%), transparent 72%),
    radial-gradient(ellipse 26% 82% at 94% 0%, rgb(255 172 108 / 18%), transparent 70%);
  filter: blur(22px);
  opacity: 0.55;
  animation: awareness-glow-bloom 9s ease-in-out -2.2s infinite;
}

.glow-halo {
  height: 52px;
  background:
    linear-gradient(
      101deg,
      rgb(86 219 255 / 36%) 0%,
      rgb(104 128 255 / 50%) 20%,
      rgb(104 128 255 / 56%) 27%,
      rgb(194 112 255 / 52%) 50%,
      rgb(246 127 220 / 40%) 70%,
      rgb(255 174 105 / 28%) 88%,
      transparent 100%
    ),
    repeating-linear-gradient(
      94deg,
      transparent 0 13%,
      rgb(255 255 255 / 10%) 14% 18%,
      transparent 20% 34%
    );
  background-size: 150% 100%;
  background-repeat: repeat-x;
  filter: blur(4px);
  opacity: 0.9;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  animation:
    awareness-glow-curtain 11.5s ease-in-out -2.6s infinite,
    awareness-glow-color-flow 13s linear infinite;
}

.glow-halo::before {
  position: absolute;
  inset: -2px 0 auto;
  height: 10px;
  content: '';
  background: linear-gradient(
    100deg,
    rgb(86 219 255 / 52%) 0%,
    rgb(104 128 255 / 64%) 28%,
    rgb(194 112 255 / 60%) 54%,
    rgb(246 127 220 / 48%) 74%,
    rgb(255 174 105 / 34%) 90%,
    transparent 100%
  );
  filter: blur(4px);
  opacity: 0.86;
}

.glow-halo::after {
  position: absolute;
  inset: 0;
  content: '';
  background: linear-gradient(
    180deg,
    rgb(255 255 255 / 18%) 0%,
    rgb(144 226 255 / 24%) 28%,
    transparent 68%
  );
  filter: blur(7px);
  animation: awareness-glow-sheen 6.4s ease-in-out -1.4s infinite;
}

.glow-line {
  height: 52px;
  background: linear-gradient(
    104deg,
    transparent 0%,
    transparent 25%,
    rgb(255 255 255 / 16%) 34%,
    rgb(180 232 255 / 46%) 47%,
    rgb(185 143 255 / 32%) 57%,
    transparent 72%,
    transparent 100%
  );
  background-size: 200% 100%;
  background-repeat: no-repeat;
  filter: blur(5px);
  opacity: 0.86;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  animation: awareness-glow-flow 7.6s ease-in-out -1.2s infinite;
}

.glow-streak {
  height: 52px;
  background: linear-gradient(
    102deg,
    transparent 0%,
    transparent 18%,
    rgb(255 192 255 / 18%) 32%,
    rgb(255 255 255 / 28%) 48%,
    rgb(139 220 255 / 22%) 61%,
    transparent 78%,
    transparent 100%
  );
  background-size: 240% 100%;
  background-repeat: no-repeat;
  filter: blur(10px);
  opacity: 0.46;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  animation: awareness-glow-flow-slow 10.6s ease-in-out -3.8s infinite;
}

/*
 * 左 / 右两条边带的**图层重排**：换轴后，「沿边带方向」是纵向（top/height），
 * 「向屏内」是横向（left/width）。百分比在这里会失真（8% of 72px ≈ 6px，另一轴 8% of 2000px
 * 却是 160px），所以两条边一律用**固定像素**溢出：向屏内 8px、沿屏幕高度铺满并加 8px。
 */
.glow-edge[data-edge='left'] > span,
.glow-edge[data-edge='right'] > span {
  top: -8px;
  left: 0;
  width: 100%;
  height: calc(100% + 16px);
  transform-origin: 0 0;
}

/* 左 / 右两条边带：遮罩改横向（贴屏处不透明、向屏内渐隐），其余（曲率、呼吸、柔光）不变 */
.glow-edge[data-edge='left'] .glow-halo,
.glow-edge[data-edge='right'] .glow-halo,
.glow-edge[data-edge='left'] .glow-line,
.glow-edge[data-edge='right'] .glow-line,
.glow-edge[data-edge='left'] .glow-streak,
.glow-edge[data-edge='right'] .glow-streak {
  -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(90deg, #000 0%, #000 62%, transparent 100%);
}

/* 左右边带的流动沿屏幕纵向（上下边带沿屏幕横向）：同一个 `background-position` 简写 */
.glow-edge[data-edge='left'] .glow-line,
.glow-edge[data-edge='right'] .glow-line {
  background-size: 100% 200%;
  background-repeat: repeat-y;
}

.glow-edge[data-edge='left'] .glow-streak,
.glow-edge[data-edge='right'] .glow-streak {
  background-size: 100% 240%;
  background-repeat: repeat-y;
}

@keyframes awareness-glow-enter {
  0% {
    opacity: 0;
    filter: blur(16px);
    transform: translate3d(0, -10px, 0) scaleY(0.72);
  }
  62% {
    opacity: 1;
    filter: blur(2px);
    transform: translate3d(0, 1px, 0) scaleY(1.04);
  }
  100% {
    opacity: 1;
    filter: none;
    transform: none;
  }
}

@keyframes awareness-glow-bloom {
  0%,
  100% {
    opacity: 0.48;
    transform: translate3d(-2%, 0, 0) scaleX(1.03) scaleY(0.97);
  }
  50% {
    opacity: 0.78;
    transform: translate3d(2%, 1px, 0) scaleX(0.99) scaleY(1.04);
  }
}

@keyframes awareness-glow-curtain {
  0%,
  100% {
    opacity: 0.66;
    transform: translate3d(-2%, 0, 0) skewX(-1.6deg) scaleX(1.02);
  }
  46% {
    opacity: 0.9;
    transform: translate3d(1%, 2px, 0) skewX(1.2deg) scaleX(0.99);
  }
  74% {
    opacity: 0.74;
    transform: translate3d(3%, -1px, 0) skewX(-0.5deg) scaleX(1.01);
  }
}

@keyframes awareness-glow-sheen {
  0%,
  100% {
    opacity: 0.16;
    transform: translate3d(0, -18%, 0);
  }
  50% {
    opacity: 0.42;
    transform: translate3d(0, 22%, 0);
  }
}

@keyframes awareness-glow-flow {
  0% {
    background-position: -95% 0;
    opacity: 0;
    transform: translate3d(-3%, 0, 0);
  }
  24% {
    opacity: 0.58;
  }
  58% {
    opacity: 0.84;
    transform: translate3d(1%, 1px, 0);
  }
  100% {
    background-position: 145% 0;
    opacity: 0;
    transform: translate3d(4%, -1px, 0);
  }
}

@keyframes awareness-glow-flow-slow {
  0% {
    background-position: -105% 0;
    opacity: 0;
    transform: translate3d(-4%, 0, 0);
  }
  30% {
    opacity: 0.34;
  }
  64% {
    opacity: 0.62;
    transform: translate3d(-1%, -1px, 0);
  }
  100% {
    background-position: 125% 0;
    opacity: 0;
    transform: translate3d(4%, 1px, 0);
  }
}

@keyframes awareness-glow-color-flow {
  from {
    background-position: 0% 0;
  }
  to {
    background-position: 150% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .awareness-glow {
    transition: none;
  }

  .awareness-glow.active,
  .glow-bloom,
  .glow-halo,
  .glow-halo::after,
  .glow-line,
  .glow-streak {
    animation: none;
  }
}
</style>
