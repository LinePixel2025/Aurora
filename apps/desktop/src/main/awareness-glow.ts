/** 自感知四周流光的纯逻辑：可见条件与工作区几何（docs/07 §2.2）。 */
import type { FileAwarenessAnalysisStage } from '@aurora/shared'

/**
 * 渲染层每条边带的厚度参考（CSS 里的边带高度）。
 *
 * 它**不参与窗口几何** —— v33 起浮层是覆盖整块显示器的透明窗口，四条边由渲染层绘制。
 * 保留这个常量只是给渲染层 / 探针 / 文档一个共同口径。
 */
export const AWARENESS_GLOW_BAND = 72

export interface AwarenessGlowVisibilityInput {
  edgeBarEnabled: boolean
  edgeBarVisible: boolean
  needsOnboarding: boolean
  edgeBarQuiet: boolean
  systemQuiet: boolean
  awarenessEnabled: boolean
  consentAccepted: boolean
  knowledgeDirAvailable: boolean
  /** v33：`appearance.awarenessGlow`。缺字段按开启处理（调用方负责兜底为 true）。 */
  awarenessGlow: boolean
  stage?: FileAwarenessAnalysisStage
}

/**
 * 只在提示条确实可见且文件进入实际处理阶段时显示。
 *
 * `queued` 只表示排队，不一定马上开始处理；空闲时 `stage` 缺失。首屏引导、两类勿扰、
 * 用户关掉流光特效（`appearance.awarenessGlow = false`）和提示条手动隐藏都按“不显示”处理，
 * 避免一个纯装饰浮层越过用户已有的可见性口径。
 */
export function shouldShowAwarenessGlow(input: AwarenessGlowVisibilityInput): boolean {
  return (
    input.edgeBarEnabled &&
    input.edgeBarVisible &&
    !input.needsOnboarding &&
    !input.edgeBarQuiet &&
    !input.systemQuiet &&
    input.awarenessEnabled &&
    input.consentAccepted &&
    input.knowledgeDirAvailable &&
    input.awarenessGlow &&
    input.stage !== undefined &&
    input.stage !== 'queued'
  )
}

export interface AwarenessGlowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 浮层覆盖目标显示器**整块矩形**（v33 起四边流光）。
 *
 * 与 2026-10-06 的「顶部空隙修复」同一原因：定位必须用显示器的 `bounds` 而不是 `workArea`
 * —— 有任务栏 / 贴边停靠时两者不同，用 `workArea` 会让边带离物理屏幕边缘差出一条。
 * 渲染层只在四条边上画光带，中部保持全透明 + 鼠标穿透，因此全屏矩形不会挡住桌面的其它窗口。
 */
export function awarenessGlowBounds(displayBounds: AwarenessGlowRect): AwarenessGlowRect {
  return {
    x: Math.round(displayBounds.x),
    y: Math.round(displayBounds.y),
    width: Math.max(0, Math.round(displayBounds.width)),
    height: Math.max(0, Math.round(displayBounds.height)),
  }
}
