<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/** 顶部单条极光边带（2026-10-16 用户口径：只保留顶部，删除三边与光帘）。 */
const EDGES = ['top'] as const

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
 * 顶部流光（2026-10-16）：只在屏幕顶边画一条 Apple Intelligence 光谱极光带。
 * 配色为多色光谱（品红 → 紫罗兰 → 蓝 → 青 → 琥珀），每层 ≤36% 不透明度 +
 * 大半径高斯模糊，呈「液态弥散光」而非硬边彩条。
 * --aurora-blue 参与光谱冷色主调，换强调色时微微偏移，其余色相固定。
 *
 * 已删除：三边（bottom / left / right）与光帘（curtain）动画。
 */
.awareness-glow {
  --glow-accent: var(--aurora-blue, #0a84ff);
  --glow-rose: #ff6b9d;
  --glow-violet: #bc82f3;
  --glow-cyan: #56d8ff;
  --glow-amber: #ffb347;
  --glow-soft: color-mix(in srgb, var(--glow-accent) 42%, #ffffff);
  --glow-ink: color-mix(in srgb, var(--glow-accent) 72%, #0b1f2a);
  position: fixed;
  inset: 0;
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

.glow-edge {
  --glow-band: 72px;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--glow-band);
  pointer-events: none;
}

.glow-edge > span {
  position: absolute;
  top: 0;
  left: -8%;
  width: 116%;
  transform-origin: 50% 0;
  pointer-events: none;
}

/* ─── Bloom：宽幅弥散光谱底色 ─── */
.glow-bloom {
  height: 60px;
  background:
    radial-gradient(
      ellipse 34% 92% at 8% 0%,
      color-mix(in srgb, var(--glow-rose) 26%, transparent),
      transparent 72%
    ),
    radial-gradient(
      ellipse 40% 100% at 28% 0%,
      color-mix(in srgb, var(--glow-violet) 30%, transparent),
      transparent 74%
    ),
    radial-gradient(
      ellipse 44% 104% at 50% 0%,
      color-mix(in srgb, var(--glow-accent) 32%, transparent),
      transparent 74%
    ),
    radial-gradient(
      ellipse 38% 96% at 72% 0%,
      color-mix(in srgb, var(--glow-cyan) 28%, transparent),
      transparent 72%
    ),
    radial-gradient(
      ellipse 30% 88% at 92% 0%,
      color-mix(in srgb, var(--glow-amber) 22%, transparent),
      transparent 70%
    );
  filter: blur(28px);
  opacity: 0.6;
  animation: awareness-glow-bloom 10s ease-in-out -2.2s infinite;
}

/* ─── Halo：主光谱流带（色相沿边带方向流转） ─── */
.glow-halo {
  height: 52px;
  background:
    linear-gradient(
      100deg,
      color-mix(in srgb, var(--glow-rose) 28%, transparent) 0%,
      color-mix(in srgb, var(--glow-violet) 34%, transparent) 12%,
      color-mix(in srgb, var(--glow-accent) 36%, transparent) 26%,
      color-mix(in srgb, var(--glow-cyan) 34%, transparent) 40%,
      color-mix(in srgb, var(--glow-soft) 38%, transparent) 52%,
      color-mix(in srgb, var(--glow-accent) 34%, transparent) 64%,
      color-mix(in srgb, var(--glow-violet) 30%, transparent) 76%,
      color-mix(in srgb, var(--glow-amber) 26%, transparent) 88%,
      color-mix(in srgb, var(--glow-rose) 24%, transparent) 100%
    ),
    repeating-linear-gradient(
      94deg,
      transparent 0 13%,
      rgb(255 255 255 / 6%) 14% 18%,
      transparent 20% 34%
    );
  background-size: 200% 100%;
  background-repeat: repeat-x;
  filter: blur(5px);
  opacity: 0.88;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  animation: awareness-glow-color-flow 18s linear infinite;
}

.glow-halo::before {
  position: absolute;
  inset: -2px 0 auto;
  height: 10px;
  content: '';
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--glow-rose) 34%, transparent) 0%,
    color-mix(in srgb, var(--glow-violet) 40%, transparent) 16%,
    color-mix(in srgb, var(--glow-soft) 48%, transparent) 34%,
    color-mix(in srgb, var(--glow-cyan) 42%, transparent) 52%,
    color-mix(in srgb, var(--glow-accent) 38%, transparent) 70%,
    color-mix(in srgb, var(--glow-amber) 32%, transparent) 86%,
    transparent 100%
  );
  filter: blur(4px);
  opacity: 0.8;
}

.glow-halo::after {
  position: absolute;
  inset: 0;
  content: '';
  background: linear-gradient(
    180deg,
    rgb(255 255 255 / 16%) 0%,
    color-mix(in srgb, var(--glow-soft) 22%, transparent) 28%,
    transparent 68%
  );
  filter: blur(7px);
  animation: awareness-glow-sheen 7s ease-in-out -1.4s infinite;
}

/* ─── Line：聚焦光谱高光带 ─── */
.glow-line {
  height: 52px;
  background: linear-gradient(
    104deg,
    transparent 0%,
    transparent 18%,
    color-mix(in srgb, var(--glow-rose) 20%, transparent) 28%,
    rgb(255 255 255 / 14%) 36%,
    color-mix(in srgb, var(--glow-cyan) 30%, transparent) 46%,
    color-mix(in srgb, var(--glow-violet) 24%, transparent) 56%,
    color-mix(in srgb, var(--glow-amber) 18%, transparent) 66%,
    transparent 78%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-repeat: no-repeat;
  filter: blur(5px);
  opacity: 0.82;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  animation: awareness-glow-flow 8.4s ease-in-out -1.2s infinite;
}

/* ─── Streak：宽幅柔和光谱 ─── */
.glow-streak {
  height: 52px;
  background: linear-gradient(
    102deg,
    transparent 0%,
    transparent 12%,
    color-mix(in srgb, var(--glow-violet) 16%, transparent) 24%,
    color-mix(in srgb, var(--glow-soft) 20%, transparent) 38%,
    rgb(255 255 255 / 22%) 48%,
    color-mix(in srgb, var(--glow-cyan) 18%, transparent) 60%,
    color-mix(in srgb, var(--glow-amber) 14%, transparent) 74%,
    transparent 86%,
    transparent 100%
  );
  background-size: 260% 100%;
  background-repeat: no-repeat;
  filter: blur(12px);
  opacity: 0.5;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 62%, transparent 100%);
  animation: awareness-glow-flow-slow 11.5s ease-in-out -3.8s infinite;
}

/* ─── 关键帧 ─── */

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
    opacity: 0.5;
    transform: translate3d(-2%, 0, 0) scaleX(1.03) scaleY(0.97);
  }
  50% {
    opacity: 0.76;
    transform: translate3d(2%, 1px, 0) scaleX(0.99) scaleY(1.04);
  }
}

@keyframes awareness-glow-sheen {
  0%,
  100% {
    opacity: 0.14;
    transform: translate3d(0, -18%, 0);
  }
  50% {
    opacity: 0.38;
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
    opacity: 0.56;
  }
  58% {
    opacity: 0.82;
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
    opacity: 0.32;
  }
  64% {
    opacity: 0.58;
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
    background-position: 200% 0;
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
