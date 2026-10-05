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
    <span class="glow-line" data-field="awareness-glow.line" />
  </div>
</template>

<style scoped>
/*
 * 顶部流光只在文件分析进行时短暂出现。三层同源渐变分别承担宽柔光、窄辉光与清晰主线；
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

@media (prefers-reduced-motion: reduce) {
  .glow-bloom,
  .glow-halo,
  .glow-line {
    animation: none;
    transform: none;
  }
}
</style>
