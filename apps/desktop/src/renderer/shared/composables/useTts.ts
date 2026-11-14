/**
 * 语音朗读播放链路（TTS，docs/06 §13）。
 *
 * 渲染层只做「base64 → Blob → blob: URL → HTMLAudioElement」这一段；
 * 合成（含凭据与出网）全在主进程，渲染层**永远不持有明文密钥**。
 *
 * v43 起分块边播边取（docs/06 §13.8）：`splitTtsText` 清洗 + 总量截断 + 句界分块，
 * `runTtsPipeline`（@aurora/shared/browser，与 Center Web 共用同一份纯逻辑）
 * 合成首块即开播、播放期间预取下一块。首块 ≤120 字，长回复的首声延迟从
 * 「整段合成完」降到「首块合成完」。
 *
 * 为什么走 Blob 而不是 `data:` URL：长文本下 data URL 会撑爆 DOM 属性；
 * 且 `blob:` 需要 CSP 的 `media-src` 放行（见 `main/index.ts` 的 CSP，两态都要有）。
 */
import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'
import { runTtsPipeline, splitTtsText } from '@aurora/shared/browser'
import type { TtsPipelineAudio, TtsPipelineBackend } from '@aurora/shared/browser'

/** 调用方没传 maxChars 时的兜底（与 DEFAULT_TTS.maxChars 一致） */
const DEFAULT_MAX_CHARS = 2000

export interface TtsSpeakOptions {
  /**
   * 缺省 = 主进程按 `tts.active` 选（会话朗读走这条）；
   * 设置页「保存并试听」传入**正在编辑那张卡**的 id，否则非默认 provider 的试听会张冠李戴。
   */
  providerId?: string
  /**
   * 本次朗读的总字数上限（清洗后、分块前截断，docs/11 §4 隐私边界）。
   * 调用方从 `tts.maxChars` 传入；缺省按 2000。
   */
  maxChars?: number
}

export interface UseTts {
  /** 正在播放的 key（消息 id 或 'preview'），没有则为 null */
  speaking: Ref<string | null>
  /** 正在合成（等待首块回包）的 key；首块开播即转 speaking */
  loading: Ref<string | null>
  /** 最近一次失败的说明；成功后清空 */
  error: Ref<string | null>
  /**
   * 播放音量（0–1，默认 1）。流光提醒按用户设置的音量播报时改它；
   * 对话窗朗读保持默认 1（音量归用户系统音量管）。
   */
  volume: Ref<number>
  /**
   * 合成并播放；同一时刻只有一个音频，播新的会先停掉旧的。
   * 长文本自动分块：首块开播后边播边预取后续块（§13.8）。
   */
  speak(text: string, key: string, opts?: TtsSpeakOptions): Promise<void>
  /** 停止播放并释放资源（在途回包作废、管线取消） */
  stop(): void
}

/** base64 → 字节数组（`atob` 给出的是 latin1 字符串，必须逐字符取码点）。 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 当前在播的一块音频：settle 幂等，stop / ended / error 三条路径都收敛到它。 */
interface Playback {
  settle: (error?: Error) => void
}

export function useTts(): UseTts {
  const speaking = ref<string | null>(null)
  const loading = ref<string | null>(null)
  const error = ref<string | null>(null)
  /** 播放音量（0–1）：每次创建 audio 时应用一次（改完在下一块生效即可） */
  const volume = ref(1)

  let playback: Playback | null = null
  /**
   * 自增令牌：`stop()` 或新的 `speak()` 会让在途请求的回包作废
   * （否则用户点了停止、或连点两条消息，旧回包仍会把音频播出来）。
   */
  let token = 0

  /** 停掉当前播放（幂等）：settle 以「正常结束」resolve 在途 play，管线随后见取消即返回。 */
  function releasePlayback(): void {
    const current = playback
    playback = null
    current?.settle()
  }

  function stop(): void {
    token += 1
    releasePlayback()
    speaking.value = null
    loading.value = null
  }

  /**
   * 播放一块音频：真正开始播放时调 onStarted，播放结束 resolve；
   * stop() 经 settle 提前 resolve；播放失败 reject。元素与对象 URL 在 settle 里释放。
   */
  function playAudio(chunk: TtsPipelineAudio, onStarted?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const bytes = base64ToBytes(chunk.audioBase64)
      const url = URL.createObjectURL(new Blob([bytes], { type: chunk.mimeType }))
      const element = new Audio(url)
      element.volume = Math.min(1, Math.max(0, volume.value))
      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        if (playback !== null && playback.settle === settle) playback = null
        element.onended = null
        element.onerror = null
        element.pause()
        element.src = ''
        URL.revokeObjectURL(url)
        if (error !== undefined) reject(error)
        else resolve()
      }
      playback = { settle }
      element.onended = () => settle()
      element.onerror = () => settle(new Error('音频播放失败：编码格式可能不被支持'))
      element.play().then(
        () => {
          if (!settled) onStarted?.()
        },
        (cause: unknown) => {
          // 自动播放被策略拦下 / 设备不可用时会 reject —— 必须说出来，不能静默失败
          settle(new Error(cause instanceof Error ? cause.message : '音频播放被浏览器阻止'))
        },
      )
    })
  }

  async function speak(text: string, key: string, opts?: TtsSpeakOptions): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '') return

    // 播新的先停旧的，并让旧的在途回包作废
    stop()
    const current = ++token
    loading.value = key
    error.value = null

    // 清洗 + 总量截断 + 句界分块（§13.4 / §13.8）；纯标记文本洗后为空 → 静默返回
    const chunks = splitTtsText(trimmed, { maxChars: opts?.maxChars ?? DEFAULT_MAX_CHARS })
    if (chunks.length === 0) {
      loading.value = null
      return
    }

    const providerId = opts?.providerId
    const backend: TtsPipelineBackend = {
      synthesize: async (chunkText) => {
        // 空串与 undefined 都表示「用 `tts.active`」——传空串会被主进程当成不存在的
        // provider id，所以这里显式只传有值的那种。
        const request: { text: string; providerId?: string } = { text: chunkText }
        if (providerId !== undefined && providerId !== '') request.providerId = providerId
        const result = await window.aurora.tts.synthesize(request)
        if (!result.ok) throw new Error(result.message)
        return { audioBase64: result.value.audioBase64, mimeType: result.value.mimeType }
      },
      play: playAudio,
      stop: releasePlayback,
    }

    try {
      await runTtsPipeline(chunks, backend, () => current !== token, {
        onFirstPlay: () => {
          if (current !== token) return
          loading.value = null
          speaking.value = key
        },
      })
    } catch (cause) {
      if (current !== token) return // 已被 stop() 或新的 speak() 取代：不提示
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (current === token) {
        loading.value = null
        speaking.value = null
      }
    }
  }

  onScopeDispose(stop)

  return { speaking, loading, error, volume, speak, stop }
}