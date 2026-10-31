/**
 * 流光提醒卡片窗的几何（docs/07 §2.2.3）。
 *
 * 纯逻辑、**不 import electron**：可以在 vitest 里直接构造、直接断言（与 `banner.ts` 同款）。
 *
 * 两条硬口径（改之前先读）：
 * 1. **窗口矩形 = 卡片 + 上下左右各 `margin` 的透明外边距**（阴影留白）。透明 ≠ 穿透，
 *    多出来的每一像素都会挡住下面窗口的点击，所以卡片必须把窗口填满。
 * 2. **宽度按所在显示器的 DIP 宽度取比例**（2026-11-01 起）：固定 360/420/480 在教室投影
 *    与大屏上太小，后排看不清；改成比例后同一档在 1080p / 4K 上都占相近比例，
 *    字号再由渲染层按卡片宽度流体放大（`cqw`），两边不会各写一套数字。
 *
 * 高度**不做字符估算**：窗口先按 `initialHeight` 占位，渲染层用 `offsetHeight` 量出真实
 * 卡片高度后经 `banner:measure` 回报并立刻收缩（多出来的透明区只存在约 1–2 帧）。
 * 字符估算必然在某些中英混排上偏大或偏小 —— 偏大是死区、偏小是裁字。
 */
import type { BannerCardSize } from '@aurora/shared'
import type { AwarenessGlowRect } from './awareness-glow.js'

/** 卡片窗的固定几何常量（像素）。 */
export const BANNER_CARD = {
  /** 卡片四周留给阴影的透明外边距（窗口 = 卡片 + 上下左右各 12px） */
  margin: 12,
  /** 卡片顶到屏幕上边缘的距离（「从流光里落下」，不贴死第 0 像素） */
  topOffset: 16,
  /**
   * 首帧占位高度：够放「标题 + 3 行正文」的最大档（宽大档实测约 228px）。
   * 渲染层一量完就收缩，所以略大比略小安全 —— 略小会先裁掉正文。
   */
  initialHeight: 240,
  /** 卡片高度下限：紧凑档只有标题时约 55px */
  minHeight: 56,
  /** 卡片高度上限（再高必然是误报；正文最多 3 行） */
  maxHeight: 280,
} as const

/** 单档尺寸：卡片宽度占显示器宽度的比例 + 夹取区间。 */
export interface BannerCardSizeProfile {
  /** 卡片宽度占显示器 DIP 宽度的比例 */
  ratio: number
  minWidth: number
  maxWidth: number
}

/**
 * 三档比例（docs/07 §2.2.3 的表格是同一份数字）。
 *
 * 1920 屏落成：紧凑 460 / 标准 691 / 宽大 883；1366 屏：460 / 640 / 780；
 * 2560 屏：614 / 922 / 1178；3840 屏：700 / 1000 / 1280。
 */
export const BANNER_CARD_PROFILES: Record<BannerCardSize, BannerCardSizeProfile> = {
  compact: { ratio: 0.24, minWidth: 460, maxWidth: 700 },
  standard: { ratio: 0.36, minWidth: 640, maxWidth: 1000 },
  large: { ratio: 0.46, minWidth: 780, maxWidth: 1280 },
}

/** 未知档位回落标准档（配置 Schema 已收窄，这里只防脏数据） */
export function bannerCardProfile(size: BannerCardSize): BannerCardSizeProfile {
  return BANNER_CARD_PROFILES[size] ?? BANNER_CARD_PROFILES.standard
}

/**
 * 当前显示器上这一档的卡片**内容宽度**（不含两侧外边距）。
 *
 * 三层夹取：档位区间 → 显示器宽度留 20px×2 → 兜底 320（病态显示器也别算出负数宽度）。
 */
export function resolveBannerCardWidth(size: BannerCardSize, displayWidth: number): number {
  const profile = bannerCardProfile(size)
  const width = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 1920
  const ratioWidth = Math.round(width * profile.ratio)
  const clamped = Math.min(profile.maxWidth, Math.max(profile.minWidth, ratioWidth))
  return Math.max(320, Math.min(clamped, width - 40))
}

/**
 * 卡片窗的**首帧**矩形：水平居中、贴顶下浮 `topOffset`、高度取 `initialHeight`。
 *
 * 渲染层量完真实卡片高度后会经 `resizeBannerCard` 覆盖高度；x / y 不变。
 */
export function bannerCardBounds(
  size: BannerCardSize,
  displayBounds: AwarenessGlowRect,
): AwarenessGlowRect {
  const width = resolveBannerCardWidth(size, displayBounds.width) + BANNER_CARD.margin * 2
  const height = BANNER_CARD.initialHeight + BANNER_CARD.margin * 2
  return {
    x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
    y: Math.round(displayBounds.y + BANNER_CARD.topOffset),
    width,
    height,
  }
}

/** 渲染层量出的卡片高度 → 钳制到合法区间（非法值按 `minHeight` 处理，别把窗口调成 0）。 */
export function clampBannerCardHeight(cardHeight: number): number {
  if (!Number.isFinite(cardHeight)) return BANNER_CARD.minHeight
  return Math.round(Math.min(BANNER_CARD.maxHeight, Math.max(BANNER_CARD.minHeight, cardHeight)))
}
