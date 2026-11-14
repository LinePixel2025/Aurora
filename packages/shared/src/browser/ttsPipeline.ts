/**
 * TTS 分块朗读管线（docs/06 §13.8，v43）——桌面 `useTts` 与 Center Web 朗读共用的
 * **纯逻辑**：合成 / 播放 / 停止全部由 backend 注入，本模块不碰 DOM、不碰 IPC，
 * 可以在 node 环境直接单测。
 *
 * 时序：合成块 0 → 开播，**播放期间预取块 1**；块 i 播完接已预取的 i+1。
 * 同一时刻最多 1 个在途合成（防限流）；合成远快于播放时后续块零等待。
 *
 * 失败语义（§13.5 的分块延伸）：
 * - 块 0 合成失败 → 立即抛错（还没出声，直接提示）；
 * - 块 i>0 合成失败 → **当前块播完**再抛错（不打断正在播放的声音）；
 * - 播放失败 → 立即抛错。
 * 取消：每步检查 `isCancelled()`；调用方负责让 `backend.stop()` 结束在途播放、
 * 并让在途合成回包作废（令牌机制）。
 */

/** 一块合成音频（与 IPC / 中转回执同形）。 */
export interface TtsPipelineAudio {
  audioBase64: string
  mimeType: string
}

export interface TtsPipelineBackend {
  /** 合成一块文本；失败 reject（message 进错误提示）。 */
  synthesize(text: string): Promise<TtsPipelineAudio>
  /**
   * 播放一块音频：真正开始播放时调 `onStarted`（首块用它把 UI 从「合成中」切到
   * 「播放中」），播放结束 resolve；`stop()` 必须让它尽快 resolve（提前结束）。
   * 播放失败 reject。
   */
  play(audio: TtsPipelineAudio, onStarted?: () => void): Promise<void>
  /** 停止当前播放（幂等；没有在播的也安全）。 */
  stop(): void
}

export interface TtsPipelineHooks {
  /** 首块真正开始播放时回调（loading → speaking 的状态切换点）。 */
  onFirstPlay?: () => void
}

/**
 * 按顺序朗读所有块。抛错 = 需要向用户提示的失败；正常播完 / 被取消都 resolve。
 * `chunks` 为空直接 resolve（调用方不必先判空）。
 */
export async function runTtsPipeline(
  chunks: string[],
  backend: TtsPipelineBackend,
  isCancelled: () => boolean,
  hooks?: TtsPipelineHooks,
): Promise<void> {
  if (chunks.length === 0 || isCancelled()) return

  // 预取槽：块 i 播放期间，这里挂着块 i+1 的合成 Promise。
  // 先挂一个「空 catch」防止取消场景下在途回包变成 unhandled rejection；
  // 真正的错误仍在循环里 await 时抛出（catch 副本不影响原 Promise 的拒绝）。
  const prefetch = (index: number): Promise<TtsPipelineAudio> | null => {
    if (index >= chunks.length || isCancelled()) return null
    const promise = backend.synthesize(chunks[index]!)
    promise.catch(() => undefined)
    return promise
  }

  let next = prefetch(0)
  for (let i = 0; i < chunks.length; i += 1) {
    if (isCancelled()) return
    if (next === null) return
    let audio: TtsPipelineAudio
    try {
      // i>0 时这个 await 发生在上一块播完之后 —— 「后块失败播完再报」天然成立
      audio = await next
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (isCancelled()) return

    next = prefetch(i + 1)
    try {
      await backend.play(audio, i === 0 ? hooks?.onFirstPlay : undefined)
    } catch (error) {
      backend.stop()
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (isCancelled()) return
  }
}
