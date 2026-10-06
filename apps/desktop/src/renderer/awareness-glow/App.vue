<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const active = ref(false)
const preview = new URLSearchParams(window.location.search).has('preview')
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
    <span class="glow-warp" data-field="awareness-glow.warp" />
    <span class="glow-line" data-field="awareness-glow.line" />
  </div>
</template>

<style scoped>
/*
 * 顶部流光只在文件分析进行时短暂出现。宽柔光、窄辉光、折射带与清晰主线共用同一色序；
 * 动画仅使用 transform / opacity，避免给常驻桌面合成器增加布局或逐帧脚本成本。
 */
.awareness-glow {
  position: fixed;
  inset: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms var(--ease-standard);
}

.awareness-glow.active {
  opacity: 1;
}

.glow-bloom,
.glow-halo,
.glow-warp,
.glow-line {
  position: absolute;
  top: 0;
  left: -12%;
  width: 124%;
  transform-origin: 50% 0;
  pointer-events: none;
}

.glow-bloom {
  height: 44px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgb(74 210 255 / 34%) 16%,
    rgb(116 104 255 / 42%) 34%,
    rgb(223 91 255 / 32%) 52%,
    rgb(255 142 92 / 30%) 70%,
    rgb(91 214 156 / 26%) 84%,
    transparent 100%
  );
  filter: blur(20px);
  animation: awareness-glow-flow 4.8s var(--ease-smooth) infinite alternate;
}

.glow-halo {
  height: 16px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgb(105 213 255 / 52%) 18%,
    rgb(130 112 255 / 58%) 38%,
    rgb(235 105 255 / 48%) 58%,
    rgb(255 157 92 / 44%) 76%,
    transparent 100%
  );
  filter: blur(9px);
  animation: awareness-glow-flow 3.9s var(--ease-smooth) -1.2s infinite alternate-reverse;
}

.glow-warp {
  top: 6px;
  height: 30px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgb(91 220 255 / 72%) 17%,
    rgb(122 104 255 / 78%) 35%,
    rgb(242 102 255 / 68%) 54%,
    rgb(255 157 92 / 62%) 74%,
    transparent 100%
  );
  filter: blur(7px) saturate(145%);
  mix-blend-mode: screen;
  -webkit-mask-image:
    linear-gradient(180deg, transparent 0%, #000 24%, #000 66%, transparent 100%),
    repeating-linear-gradient(90deg, transparent 0 3%, #000 5% 9%, transparent 11% 15%);
  mask-image:
    linear-gradient(180deg, transparent 0%, #000 24%, #000 66%, transparent 100%),
    repeating-linear-gradient(90deg, transparent 0 3%, #000 5% 9%, transparent 11% 15%);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
  animation: awareness-glow-warp 5.2s var(--ease-smooth) -1.4s infinite alternate;
}

.glow-warp::before,
.glow-warp::after {
  position: absolute;
  inset: 0;
  content: '';
  mix-blend-mode: screen;
}

/* 两层错位只做 1–2px 色散，强度保持克制，不把顶部变成大块霓虹。 */
.glow-warp::before {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgb(77 221 255 / 58%) 20%,
    rgb(102 142 255 / 62%) 42%,
    transparent 82%
  );
  filter: blur(6px);
  transform: translate3d(-2px, -1px, 0);
}

.glow-warp::after {
  background: linear-gradient(
    90deg,
    transparent 18%,
    rgb(240 102 255 / 54%) 48%,
    rgb(255 158 94 / 56%) 70%,
    transparent 100%
  );
  filter: blur(6px);
  transform: translate3d(2px, 1px, 0);
}

.glow-line {
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgb(112 220 255 / 92%) 17%,
    rgb(132 126 255 / 96%) 36%,
    rgb(242 118 255 / 92%) 55%,
    rgb(255 176 101 / 88%) 73%,
    transparent 100%
  );
  box-shadow:
    0 0 8px rgb(118 176 255 / 58%),
    0 0 18px rgb(210 116 255 / 36%);
  animation: awareness-glow-flow 3.4s var(--ease-smooth) -0.7s infinite alternate;
}

@keyframes awareness-glow-flow {
  from {
    transform: translate3d(-5%, 0, 0) scaleX(0.92);
  }
  to {
    transform: translate3d(5%, 0, 0) scaleX(1.06);
  }
}

@keyframes awareness-glow-warp {
  from {
    opacity: 0.16;
    transform: translate3d(-3%, -1px, 0) scaleX(0.96) skewX(-1.2deg);
  }
  to {
    opacity: 0.3;
    transform: translate3d(3%, 1px, 0) scaleX(1.04) skewX(1.2deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .glow-bloom,
  .glow-halo,
  .glow-line {
    animation: none;
    transform: none;
  }

  .glow-warp {
    display: none;
  }
}
</style>
