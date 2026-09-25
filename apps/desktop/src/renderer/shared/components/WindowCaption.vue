<script setup lang="ts">
/**
 * Windows 式窗口按钮（2026-09 重构新增，docs/07 §2.3 / §2.5）。
 *
 * 应用全部窗口都是 `frame: false`，此前主界面与设置没有任何系统标题栏按钮；
 * 本组件在自绘头部里补上「最小化 / 关闭」两枚标准 caption 按钮：
 * - 「最小化」走 `window:minimize` **真最小化**（进任务栏，可从任务栏恢复；
 *   只有 chat / settings 的 spec 允许，其余窗口主进程侧是 no-op）；
 * - 「关闭」沿用应用约定 = **隐藏窗口**（`window:hide`，不退出应用，退出只走托盘）。
 *
 * 命中区 46×32px（Windows 11 caption 规格的压缩版，与 44px 头部同高），
 * 关闭悬停用系统红；本组件始终出现在拖动区内，因此按钮自带 `.no-drag`
 * （theme.css 的标签兜底是保险，显式挂类才是契约）。
 * `data-caption-btn` 是 capture 探针定位的唯一抓手（`CHAT_COLLAPSE_CHECK`）。
 */
import type { WindowName } from '@aurora/shared'
import { useWindowStore } from '../stores.js'

const props = withDefaults(
  defineProps<{
    /** 目标窗口（按钮直接对它调 minimize / hide，不经过父级转发） */
    window: WindowName
    /** 不可最小化的窗口（提示条等）只渲染「关闭」；chat / settings 默认两枚都渲染 */
    minimizable?: boolean
  }>(),
  { minimizable: true },
)

const windowStore = useWindowStore()

function onMinimize(): void {
  void windowStore.minimize(props.window)
}

function onClose(): void {
  void windowStore.hide(props.window)
}
</script>

<template>
  <div class="caption" role="group" aria-label="窗口控制">
    <button
      v-if="minimizable"
      type="button"
      class="caption-btn no-drag press"
      data-caption-btn="minimize"
      title="最小化"
      aria-label="最小化窗口"
      @click="onMinimize"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 5h9" /></svg>
    </button>
    <button
      type="button"
      class="caption-btn close no-drag press"
      data-caption-btn="close"
      title="关闭（隐藏窗口）"
      aria-label="关闭窗口"
      @click="onClose"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.7 0.7l8.6 8.6M9.3 0.7L0.7 9.3" /></svg>
    </button>
  </div>
</template>

<style scoped>
/* 命中区对齐 Windows 11 caption（46×32 的压缩版）；整组贴头部右缘。 */
.caption {
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  align-self: stretch;
}

.caption-btn {
  display: grid;
  place-items: center;
  width: 44px;
  border-radius: 0;
  color: var(--text-secondary);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.caption-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 关闭悬停 = 系统红底白叉（Win11 语义，两档主题同色） */
.caption-btn.close:hover {
  background: #c42b1c;
  color: #ffffff;
}

.caption-btn svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  stroke-linecap: round;
}
</style>
