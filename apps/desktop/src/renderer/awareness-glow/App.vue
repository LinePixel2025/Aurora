<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

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
    <span class="glow-bloom" data-field="awareness-glow.bloom" />
    <span class="glow-halo" />
    <span class="glow-line" data-field="awareness-glow.line" />
    <span class="glow-streak" data-field="awareness-glow.streak" />
  </div>
</template>

<style scoped>
/*
 * 竖向光幕：底层色晕承托主色带，光幕本体使用横向渐变的颜色分区，
 * 两条低对比度软光带在光幕内部统一从左向右流动，颜色分布同步向右流转。
 * 动画只使用 transform / opacity / filter / background-position。
 */
.awareness-glow {
  position: fixed;
  inset: 0;
  overflow: hidden;
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

.glow-bloom,
.glow-halo,
.glow-line,
.glow-streak {
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
      transparent 0%,
      rgb(86 219 255 / 36%) 8%,
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
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 5%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 5%, #000 62%, transparent 100%);
  animation:
    awareness-glow-curtain 11.5s ease-in-out -2.6s infinite,
    awareness-glow-color-flow 13s linear infinite;
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
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 4%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 4%, #000 62%, transparent 100%);
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
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 4%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 4%, #000 62%, transparent 100%);
  animation: awareness-glow-flow-slow 10.6s ease-in-out -3.8s infinite;
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
