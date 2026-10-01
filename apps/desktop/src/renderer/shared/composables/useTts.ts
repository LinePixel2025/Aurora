/**
 * 语音朗读播放链路（TTS，docs/06 §13）。
 *
 * 渲染层只做「base64 → Blob → blob: URL → HTMLAudioElement」这一段；
 * 合成（含凭据与出网）全在主进程，渲染层**永远不持有明文密钥**。
 *
 * 为什么走 Blob 而不是 `data:` URL：长文本下 data URL 会撑爆 DOM 属性；
 * 且 `blob:` 需要 CSP 的 `media-src` 放行（见 `main/index.ts` 的 CSP，两态都要有）。
 */
import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'

export interface UseTts {
  /** 正在播放的 key（消息 id 或 'preview'），没有则为 null */
  speaking: Ref<string | null>
  /** 正在合成（等待主进程回包）的 key */
  loading: Ref<string | null>
  /** 最近一次失败的说明；成功后清空 */
  error: Ref<string | null>
  /**
   * 合成并播放；同一时刻只有一个音频，播新的会先停掉旧的。
   *
   * `providerId` 缺省 = 主进程按 `tts.active` 选（会话朗读走这条）；
   * 设置页「保存并试听」传入**正在编辑那张卡**的 id，否则非默认 provider 的试听会张冠李戴。
   */
  speak(text: string, key: string, providerId?: string): Promise<void>
  /** 停止播放并释放资源（audio.pause + revokeObjectURL） */
  stop(): void
}

/** base64 → 字节数组（`atob` 给出的是 latin1 字符串，必须逐字符取码点）。 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function useTts(): UseTts {
  const speaking = ref<string | null>(null)
  const loading = ref<string | null>(null)
  const error = ref<string | null>(null)

  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  /**
   * 自增令牌：`stop()` 或新的 `speak()` 会让在途请求的回包作废
   * （否则用户点了停止、或连点两条消息，旧回包仍会把音频播出来）。
   */
  let token = 0

  /** 释放当前音频与对象 URL；三条路径（ended / error / stop）都收敛到这里。 */
  function release(): void {
    if (audio !== null) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.src = ''
      audio = null
    }
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  function stop(): void {
    token += 1
    release()
    speaking.value = null
    loading.value = null
  }

  async function speak(text: string, key: string, providerId?: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '') return

    // 播新的先停旧的，并让旧的在途回包作废
    stop()
    const current = ++token
    loading.value = key
    error.value = null

    let audioBase64 = ''
    let mimeType = 'audio/mpeg'
    try {
      // 空串与 undefined 都表示「用 `tts.active`」——`TtsSynthesizeRequest.providerId` 是可选参数，
      // 传空串会被主进程当成一个不存在的 provider id，所以这里显式只传有值的那种。
      const request: { text: string; providerId?: string } = { text: trimmed }
      if (providerId !== undefined && providerId !== '') request.providerId = providerId
      const result = await window.aurora.tts.synthesize(request)
      if (current !== token) return // 已被 stop() 或新的 speak() 取代
      if (!result.ok) {
        error.value = result.message
        loading.value = null
        return
      }
      audioBase64 = result.value.audioBase64
      mimeType = result.value.mimeType
    } catch (cause) {
      if (current !== token) return
      error.value = cause instanceof Error ? cause.message : String(cause)
      loading.value = null
      return
    }

    const bytes = base64ToBytes(audioBase64)
    const blob = new Blob([bytes], { type: mimeType })
    objectUrl = URL.createObjectURL(blob)
    const element = new Audio(objectUrl)
    audio = element

    element.onended = () => {
      release()
      speaking.value = null
    }
    element.onerror = () => {
      error.value = '音频播放失败：编码格式可能不被支持'
      release()
      speaking.value = null
    }

    try {
      await element.play()
    } catch (cause) {
      // 自动播放被策略拦下 / 设备不可用时会 reject —— 必须说出来，不能静默失败
      if (current !== token) return
      error.value = cause instanceof Error ? cause.message : '音频播放被浏览器阻止'
      release()
      speaking.value = null
      loading.value = null
      return
    }

    if (current !== token) return
    loading.value = null
    speaking.value = key
  }

  onScopeDispose(stop)

  return { speaking, loading, error, speak, stop }
}
