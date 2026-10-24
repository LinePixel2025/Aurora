<script setup lang="ts">
/**
 * 流光提醒的**光带层**（docs/07 §2.2.3、R1）。
 *
 * 只在屏幕**顶端**画一条 Apple Intelligence 风格的光谱流光带（品红 → 紫罗兰 → 强调色 →
 * 青 → 琥珀），每层经 `color-mix(..., transparent)` 压到 ≤36% 不透明度 + 大半径高斯模糊，
 * 呈「液态弥散光」而不是硬边彩带。窗口覆盖整块显示器、中部全透明且鼠标穿透，
 * 所以覆盖全屏不等于挡住全屏。
 *
 * **与自感知流光（`awareness-glow`）刻意不复用类名 / 关键帧名**：两者独立驱动，
 * 共用名字会让截图探针互相误命中（`capture.ts` 按 `animationName` 断言）。
 */
defineProps<{ active: boolean }>()
</script>

<template>
  <div
    class="banner-glow"
    :class="{ 'is-active': active }"
    data-field="banner.glow"
    aria-hidden="true"
  >
    <span class="banner-glow-edge" data-field="banner.glow.band">
      <span class="banner-glow-bloom" />
      <span class="banner-glow-halo" />
      <span class="banner-glow-line" />
    </span>
  </div>
</template>

<style scoped>
.banner-glow {
  --banner-rose: #ff6b9d;
  --banner-violet: #bc82f3;
  --banner-cyan: #56d8ff;
  --banner-amber: #ffb347;
  --banner-accent: var(--aurora-blue, #0a84ff);
  --banner-soft: color-mix(in srgb, var(--banner-accent) 42%, #ffffff);
  position: fixed;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  opacity: 0;
  /* 入场：光带从中间向两侧铺开、同时淡入（320ms 与 App.vue 的 LEAVE_MS 同一档） */
  transform: translate3d(0, -6px, 0) scaleX(0.94) scaleY(0.9);
  transform-origin: 50% 0;
  transition:
    opacity 320ms var(--ease-standard),
    transform 560ms var(--ease-spring);
  will-change: opacity, transform;
}

.banner-glow.is-active {
  opacity: 1;
  transform: none;
}

.banner-glow-edge {
  --banner-band: 64px;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--banner-band);
  pointer-events: none;
}

.banner-glow-edge > span {
  position: absolute;
  top: 0;
  left: -6%;
  width: 112%;
  pointer-events: none;
}

/* ─── Bloom：宽幅弥散光谱底色（大半径模糊 = 液态感） ─── */
.banner-glow-bloom {
  height: 54px;
  background:
    radial-gradient(
      ellipse 32% 90% at 10% 0%,
      color-mix(in srgb, var(--banner-rose) 26%, transparent),
      transparent 72%
    ),
    radial-gradient(
      ellipse 38% 100% at 32% 0%,
      color-mix(in srgb, var(--banner-violet) 30%, transparent),
      transparent 74%
    ),
    radial-gradient(
      ellipse 44% 104% at 52% 0%,
      color-mix(in srgb, var(--banner-accent) 32%, transparent),
      transparent 74%
    ),
    radial-gradient(
      ellipse 36% 96% at 72% 0%,
      color-mix(in srgb, var(--banner-cyan) 28%, transparent),
      transparent 72%
    ),
    radial-gradient(
      ellipse 28% 88% at 90% 0%,
      color-mix(in srgb, var(--banner-amber) 22%, transparent),
      transparent 70%
    );
  filter: blur(26px);
  opacity: 0.62;
  animation: banner-glow-breathe 9s ease-in-out -1.8s infinite;
}

/* ─── Halo：主光谱流带（色相沿顶边流转） ─── */
.banner-glow-halo {
  height: 46px;
  background:
    linear-gradient(
      100deg,
      color-mix(in srgb, var(--banner-rose) 28%, transparent) 0%,
      color-mix(in srgb, var(--banner-violet) 34%, transparent) 14%,
      color-mix(in srgb, var(--banner-accent) 36%, transparent) 30%,
      color-mix(in srgb, var(--banner-cyan) 34%, transparent) 46%,
      color-mix(in srgb, var(--banner-soft) 36%, transparent) 58%,
      color-mix(in srgb, var(--banner-accent) 30%, transparent) 70%,
      color-mix(in srgb, var(--banner-amber) 26%, transparent) 86%,
      color-mix(in srgb, var(--banner-rose) 22%, transparent) 100%
    ),
    repeating-linear-gradient(
      94deg,
      transparent 0 15%,
      rgb(255 255 255 / 5%) 16% 20%,
      transparent 22% 38%
    );
  background-size: 200% 100%;
  background-repeat: repeat-x;
  filter: blur(6px);
  opacity: 0.88;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 100%);
  animation: banner-glow-spectrum 16s linear infinite;
}

/* ─── Line：贴着屏幕第 0 像素的高光带（保证顶边没有空隙） ─── */
.banner-glow-line {
  height: 3px;
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--banner-rose) 46%, transparent) 0%,
    color-mix(in srgb, var(--banner-violet) 52%, transparent) 20%,
    color-mix(in srgb, var(--banner-soft) 60%, transparent) 38%,
    color-mix(in srgb, var(--banner-cyan) 50%, transparent) 58%,
    color-mix(in srgb, var(--banner-accent) 52%, transparent) 76%,
    color-mix(in srgb, var(--banner-amber) 40%, transparent) 100%
  );
  background-size: 220% 100%;
  filter: blur(1.5px);
  opacity: 0.9;
  animation: banner-glow-spectrum 9.6s linear infinite reverse;
}

@keyframes banner-glow-breathe {
  0%,
  100% {
    opacity: 0.5;
    transform: translate3d(-1.5%, 0, 0) scaleX(1.02) scaleY(0.96);
  }
  50% {
    opacity: 0.78;
    transform: translate3d(1.5%, 1px, 0) scaleX(0.99) scaleY(1.05);
  }
}

@keyframes banner-glow-spectrum {
  from {
    background-position: 0% 0;
  }
  to {
    background-position: 200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .banner-glow {
    transition: none;
    transform: none;
  }

  .banner-glow-bloom,
  .banner-glow-halo,
  .banner-glow-line {
    animation: none;
  }
}
</style>
