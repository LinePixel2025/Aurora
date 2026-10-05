/** 自感知顶部流光的纯逻辑：可见条件与工作区几何（docs/07 §2.2）。 */
import type { FileAwarenessAnalysisStage } from '@aurora/shared'

export const AWARENESS_GLOW_HEIGHT = 72

export interface AwarenessGlowVisibilityInput {
  edgeBarEnabled: boolean
  edgeBarVisible: boolean
  needsOnboarding: boolean
  edgeBarQuiet: boolean
  systemQuiet: boolean
  awarenessEnabled: boolean
  consentAccepted: boolean
  knowledgeDirAvailable: boolean
  stage?: FileAwarenessAnalysisStage
}

/**
 * 只在提示条确实可见且文件进入实际处理阶段时显示。
 *
 * `queued` 只表示排队，不一定马上开始处理；空闲时 `stage` 缺失。首屏引导、两类勿扰
 * 和提示条手动隐藏都按“不显示”处理，避免一个纯装饰浮层越过用户已有的可见性口径。
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

/** 横跨工作区顶部；工作区比预设高度更矮时按工作区夹取。 */
export function awarenessGlowBounds(
  workArea: AwarenessGlowRect,
  height = AWARENESS_GLOW_HEIGHT,
): AwarenessGlowRect {
  return {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width: Math.max(0, Math.round(workArea.width)),
    height: Math.max(0, Math.min(Math.round(height), Math.round(workArea.height))),
  }
}
