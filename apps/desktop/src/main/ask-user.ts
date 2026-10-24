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
import type { AskSettleOutcome, AskUserRequest, AskUserAnswerInput, Logger } from '@aurora/shared'
import type { AskUserAnswer, AskUserQuestion } from '@aurora/agent-core'

/** 默认等待时长（毫秒）：3 分钟 */
export const ASK_USER_TIMEOUT_MS = 180_000

/**
 * 一次提问的结算事件（本轮，docs/12 §5）：`ask.settled` 上行用的负载。
 *
 * `outcome` 直接映射协议里的 `AskSettleOutcome`，因此这里不再定义第二套取值 ——
 * 网页端据此把卡片切成「已作答 / 已跳过 / 已超时 / 已中止」。
 */
export interface AskSettleEvent {
  requestId: string
  sessionId: string
  outcome: AskSettleOutcome
  /** 结算时的作答（`outcome === 'answered'` 时非空）：网页端只读卡据此显示"答了什么" */
  answers: string[]
  /** 逐问作答（多问时；单问 / 未作答缺省） */
  answersByQuestion?: string[][]
}

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
  /**
   * 卡片弹出前的**旁路播报**（2026-10-24 流光提醒）：典型实现是在交互窗不在前台时
   * 发一条 `BannerService.show()`，让用户不至于错过一次提问。
   *
   * 三条约束（都在调用方实现里守）：
   * - 它**不参与结算**：抛错只记 warn，绝不影响提问本身（提问端口必须保证会返回）；
   * - 它跑在 `present()` **之前**：`present()` 会把交互窗拉到前台，之后再判「窗口是否在前台」
   *   就永远是 true（提醒等于不发）；
   * - 是否播报由调用方判定（窗口焦点 / 用户设置），本服务不认识窗口。
   */
  announce?: (request: AskUserCardRequest) => void
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
  /**
   * 提问**结算**的订阅（本轮，docs/12 §5）：本地作答 / 跳过 / 超时 / 中止四条路径都会触发。
   *
   * 存在的理由：Center 网页端此前只能靠自己的倒计时判断卡片是否还有效 ——
   * 用户在客户端上先答了，网页端的卡还挂着倒计时、点了才知道失效。有了这条事件，
   * 客户端把 `ask.settled` 上行，服务器广播后网页卡立即收起。
   */
  onSettle(listener: (event: AskSettleEvent) => void): () => void
  /** 用户回执（幂等：已结算 / 不存在的 requestId 一律返回 false） */
  resolve(input: AskUserAnswerInput): boolean
  /** 当前挂起的提问数（诊断 / 单测用） */
  pendingCount(): number
}

interface Pending {
  requestId: string
  /** 结算事件要带上的会话 id（`ask.settled` 的路由与留痕都靠它） */
  sessionId: string
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
  const settleListeners = new Set<(event: AskSettleEvent) => void>()
  let sequence = 0

  /** 结算原因（与协议 `AskSettleOutcome` 一一对应；`answers` 非空即「已作答」） */
  function outcomeOf(answer: AskUserAnswer): AskSettleOutcome {
    if (answer.aborted === true) return 'aborted'
    if (answer.timedOut === true) return 'timedOut'
    if (answer.skipped === true) return 'skipped'
    return 'answered'
  }

  /** 广播结算事件；单个订阅者抛错不影响其它订阅者与提问本身 */
  function notifySettle(requestId: string, sessionId: string, answer: AskUserAnswer): void {
    const event: AskSettleEvent = {
      requestId,
      sessionId,
      outcome: outcomeOf(answer),
      answers: [...answer.answers],
      ...(answer.answersByQuestion === undefined
        ? {}
        : { answersByQuestion: answer.answersByQuestion.map((group) => [...group]) }),
    }
    for (const listener of settleListeners) {
      try {
        listener(event)
      } catch (error) {
        options.logger.warn('提问结算通知失败', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  function settle(requestId: string, answer: AskUserAnswer): void {
    const entry = pending.get(requestId)
    if (entry === undefined) return
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.detachAbort()
    entry.settle(answer)
    notifySettle(requestId, entry.sessionId, answer)
  }

  return {
    async ask(question, context): Promise<AskUserAnswer> {
      sequence += 1
      const requestId = `ask-${now().toString(36)}-${sequence}`
      // 等待时长：本次提问可自带（工具参数，已钳制在 30s–10min），否则用服务缺省
      const waitMs = question.timeoutMs ?? timeoutMs
      const request: AskUserCardRequest = {
        requestId,
        sessionId: context.sessionId,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.options === undefined ? {} : { options: question.options }),
        multiSelect: question.multiSelect,
        expiresAt: now() + waitMs,
        ...(question.allowCustom === false ? { allowCustom: false } : {}),
        ...(question.questions === undefined ? {} : { questions: question.questions }),
      }

      return await new Promise<AskUserAnswer>((resolve) => {
        const timer = setTimeout(() => {
          options.logger.info('提问超时，按未回答继续', { requestId, timeoutMs: waitMs })
          settle(requestId, { answers: [], timedOut: true })
        }, waitMs)

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
            notifySettle(requestId, context.sessionId, { answers: [], aborted: true })
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }

        pending.set(requestId, {
          requestId,
          sessionId: context.sessionId,
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
        // 旁路播报（流光提醒）必须在 present() 之前：那一步会把交互窗拉到前台。
        // 抛错只降级 —— 一条提醒发不出去，不能把「等回答」这件事一起带崩。
        try {
          options.announce?.(request)
        } catch (error) {
          options.logger.warn('提问的流光提醒失败（不影响提问）', {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          })
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

    onSettle(listener): () => void {
      settleListeners.add(listener)
      return () => {
        settleListeners.delete(listener)
      }
    },

    resolve(input): boolean {
      const entry = pending.get(input.requestId)
      if (entry === undefined) return false
      const answers = input.answers.map((item) => item.trim()).filter((item) => item !== '')
      // 多问的分组作答原样带上（同一套 trim / 去空口径，避免两张卡对"空答案"的判定分叉）
      const answersByQuestion = input.answersByQuestion?.map((group) =>
        group.map((item) => item.trim()).filter((item) => item !== ''),
      )
      // 空回答 + 没点跳过：当作跳过处理（界面上"直接提交空框"与"跳过"是同一结果）
      settle(input.requestId, {
        answers,
        ...(answersByQuestion === undefined ? {} : { answersByQuestion }),
        ...(input.skipped === true || answers.length === 0 ? { skipped: true } : {}),
      })
      return true
    },

    pendingCount(): number {
      return pending.size
    },
  }
}
