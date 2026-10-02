/**
 * 提问卡上行（docs/12 §5，v0.3.3）—— 三条判定从 `index.ts` 抽到这里，好被单测钉住。
 *
 * 为什么要单独一层：`index.ts` 依赖 Electron，`vitest.config.ts` 收不了它的单测，
 * 于是「哪些问题会出网」「闸门怎么判」「离线怎么办」这三条只能靠人读代码 ——
 * 而它们恰好是**这个功能最该被钉住的部分**（本地会话绝不出网、关掉远程会话就整条静默、
 * 离线不丢且只入队一次）。抽成纯函数后，装配处只剩一行。
 */
import { CENTER_SESSION_PREFIX, type AskUserRequest } from '@aurora/shared'
import type { AskSettleEvent } from '../ask-user.js'
import { toAskRequest } from './session-bridge.js'

export interface AskRelayDeps {
  /**
   * 连接器在线时的发送函数；返回 `undefined` = 连接器离线（或 emit 未绑定）。
   * 取的是**函数**而不是值：连接会在运行期反复重建（重连），值会被读成旧的。
   */
  emit: () => ((message: unknown) => void) | undefined
  /**
   * 客户端是否允许远程会话（`center.allowRemoteSession`）。
   * 提问卡的闸门比确认卡**更严**：关掉时连卡片都不推给网页，作答也一并拒绝
   * （见 connector 的 `ask.resolve` 分支）—— 两边同一条判定，否则会出现
   * 「能答一张自己没有的卡」。
   */
  allowRemoteSession: () => boolean
  /** 离线 / 发送失败时的补发入队（与确认卡共用一条离线上行队列） */
  enqueue: (message: unknown) => void
  logger?: { warn(message: string, meta?: Record<string, unknown>): void }
}

/** 生成 `AskUserService.onRequest` 的处理器（返回的函数即监听器本身） */
export function createAskRelay(deps: AskRelayDeps): (request: AskUserRequest) => void {
  return (request: AskUserRequest): void => {
    // 本地会话（quick / 普通会话）的提问绝不出网：只在本机卡片上问
    if (!request.sessionId.startsWith(CENTER_SESSION_PREFIX)) return
    if (!deps.allowRemoteSession()) return
    const message = toAskRequest(request)
    const emit = deps.emit()
    if (emit === undefined) {
      // 连接器离线：入补发队列（短暂断连里提出的问题仍能送达网页端）
      deps.enqueue(message)
      return
    }
    try {
      emit(message)
    } catch (error) {
      deps.logger?.warn('向 Center 发送提问请求失败', { error: String(error) })
      deps.enqueue(message)
    }
  }
}

/**
 * 生成 `AskUserService.onSettle` 的处理器（本轮，docs/12 §5）：本地结算 → 上行 `ask.settled`。
 *
 * 与上行同一条闸门（仅 `center-` 前缀 + `allowRemoteSession`），但**离线不入队**：
 * 结算通知过期即无意义（网页端的卡会按自己的 `expiresAt` 消失，且它自己不持有任何状态），
 * 排队反而会在重连后推一批早就失效的"已结算"给网页端。发不出去只记 debug。
 */
export function createAskSettleRelay(deps: {
  emit: () => ((message: unknown) => void) | undefined
  allowRemoteSession: () => boolean
  logger?: {
    warn(message: string, meta?: Record<string, unknown>): void
    debug?(message: string, meta?: Record<string, unknown>): void
  }
}): (event: AskSettleEvent) => void {
  return (event) => {
    if (!event.sessionId.startsWith(CENTER_SESSION_PREFIX)) return
    if (!deps.allowRemoteSession()) return
    const emit = deps.emit()
    if (emit === undefined) {
      deps.logger?.debug?.('连接器离线，提问结算通知未送达', { requestId: event.requestId })
      return
    }
    try {
      emit({
        type: 'ask.settled',
        requestId: event.requestId,
        sessionId: event.sessionId,
        outcome: event.outcome,
        answers: [...event.answers],
        ...(event.answersByQuestion === undefined
          ? {}
          : { answersByQuestion: event.answersByQuestion.map((group) => [...group]) }),
      })
    } catch (error) {
      deps.logger?.warn('向 Center 发送提问结算通知失败', { error: String(error) })
    }
  }
}
