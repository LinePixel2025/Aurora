/**
 * `ask_user` 的装配层实现（2026-09，docs/06 §21）：把内核的提问变成一张卡片 + 等一个回执。
 *
 * 形状刻意与 `createConfirmTool`（`agent-host.ts`）对齐：同样是
 * 「进程内 pending 表 + 推给渲染层的请求 DTO + 回执解析」，同样**必须自己保证会返回**
 * （超时 / 中止都要落一条结论），因为内核那侧在 `await` 它。
 *
 * 与确认卡片的三处差异（都是产品语义，不是实现偷懒）：
 * 1. **超时更长**（3 分钟 vs 60 秒）：确认是安全闸门，等的是"敢不敢放行"；
 *    提问是协作，用户在读背景、想方案，一分钟太短；
 * 2. **超时不算失败**：回执带 `timedOut`，工具把它转成「用户没答，按你的假设继续」——
 *    无人应答的问题不该把整轮请求挂死；
 * 3. **可以主动跳过**：卡片上有「跳过」入口（`skipped`），语义比超时明确。
 */
import type { AskUserRequest, AskUserAnswerInput, Logger } from '@aurora/shared'
import type { AskUserAnswer, AskUserQuestion } from '@aurora/agent-core'

/** 默认等待时长（毫秒）：3 分钟 */
export const ASK_USER_TIMEOUT_MS = 180_000

/**
 * 推给渲染层的提问卡片（= `@aurora/shared` 的 `AskUserRequest`）。
 * 别名只为让本文件的读法统一，**不另立形状** —— IPC 契约只在 shared 定义一份。
 */
export type AskUserCardRequest = AskUserRequest

export interface AskUserServiceOptions {
  /** 有提问时把交互面显示出来（与确认卡片同款：卡片无处可显示 = 静默超时） */
  present: () => void
  logger: Logger
  timeoutMs?: number
  now?: () => number
}

export interface AskUserService {
  /** 内核端口：提问并等回答（**一定返回**，见文件头三条差异） */
  ask(
    question: AskUserQuestion,
    context: { sessionId: string; toolCallId?: string; signal?: AbortSignal },
  ): Promise<AskUserAnswer>
  /**
   * 推给渲染层的订阅（ipc 用）：返回解除函数。
   * 监听器由**本服务**维护而不是外部传入 —— 内核端口与 ipc 依赖是同一个实例，
   * 两边的接线在装配层只连一次（少一处"接错实例"的可能）。
   */
  onRequest(listener: (request: AskUserRequest) => void): () => void
  /** 用户回执（幂等：已结算 / 不存在的 requestId 一律返回 false） */
  resolve(input: AskUserAnswerInput): boolean
  /** 当前挂起的提问数（诊断 / 单测用） */
  pendingCount(): number
}

interface Pending {
  requestId: string
  settle: (answer: AskUserAnswer) => void
  timer: ReturnType<typeof setTimeout>
  /** 中止监听器的解绑（结算时务必调用，否则监听器会跟着 signal 长期挂着） */
  detachAbort: () => void
}

export function createAskUserService(options: AskUserServiceOptions): AskUserService {
  const now = options.now ?? (() => Date.now())
  const timeoutMs = options.timeoutMs ?? ASK_USER_TIMEOUT_MS
  const pending = new Map<string, Pending>()
  const listeners = new Set<(request: AskUserRequest) => void>()
  let sequence = 0

  function settle(requestId: string, answer: AskUserAnswer): void {
    const entry = pending.get(requestId)
    if (entry === undefined) return
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.detachAbort()
    entry.settle(answer)
  }

  return {
    async ask(question, context): Promise<AskUserAnswer> {
      sequence += 1
      const requestId = `ask-${now().toString(36)}-${sequence}`
      const request: AskUserCardRequest = {
        requestId,
        sessionId: context.sessionId,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.options === undefined ? {} : { options: question.options }),
        multiSelect: question.multiSelect,
        expiresAt: now() + timeoutMs,
      }

      return await new Promise<AskUserAnswer>((resolve) => {
        const timer = setTimeout(() => {
          options.logger.info('提问超时，按未回答继续', { requestId, timeoutMs })
          settle(requestId, { answers: [], timedOut: true })
        }, timeoutMs)

        // 中止（用户点停止 / 退出）：立刻结算，别让卡片留在界面上等一个不会来的答案
        const signal = context.signal
        const onAbort = (): void => {
          options.logger.info('提问被中止', { requestId })
          settle(requestId, { answers: [], aborted: true })
        }
        if (signal !== undefined) {
          if (signal.aborted) {
            clearTimeout(timer)
            resolve({ answers: [], aborted: true })
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }

        pending.set(requestId, {
          requestId,
          settle: resolve,
          timer,
          detachAbort: () => signal?.removeEventListener('abort', onAbort),
        })

        options.logger.info('向用户提问', {
          requestId,
          sessionId: context.sessionId,
          options: request.options?.length ?? 0,
          multiSelect: request.multiSelect,
        })
        // 先把卡片推出去，再把交互面显示出来（顺序反了会闪一下空卡片）
        for (const listener of listeners) {
          try {
            listener(request)
          } catch (error) {
            // 单个订阅者出错不影响提问本身（端口必须保证会返回）
            options.logger.warn('提问推送失败', {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        options.present()
      })
    },

    onRequest(listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    resolve(input): boolean {
      const entry = pending.get(input.requestId)
      if (entry === undefined) return false
      const answers = input.answers.map((item) => item.trim()).filter((item) => item !== '')
      // 空回答 + 没点跳过：当作跳过处理（界面上"直接提交空框"与"跳过"是同一结果）
      settle(input.requestId, {
        answers,
        ...(input.skipped === true || answers.length === 0 ? { skipped: true } : {}),
      })
      return true
    },

    pendingCount(): number {
      return pending.size
    },
  }
}
