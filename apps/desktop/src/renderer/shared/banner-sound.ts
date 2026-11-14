/**
 * 流光提醒提示音的**统一播放链**（v42，docs/07 §2.2.3 R4）。
 *
 * 卡片（`BannerCard.vue`）与设置页「试听」（`NotificationsPage.vue`）共用这一份：
 * **有自定义播自定义，否则播默认合成音**（`chime.ts` 的 Win11 风格两音下行）。
 * 两处各写一遍必然漂移 —— 试听的意义就是"和真实提醒一模一样"。
 *
 * 自定义音效的数据由主进程经 `notifications:readSound` 读取（设置里那条路径，
 * 扩展名白名单 + ≤2MB），这里只负责播放：base64 → blob URL → `HTMLAudioElement`
 * （CSP `media-src 'self' blob:` 已放行，与 TTS 播放同款口径）。
 *
 * 失败口径**分场景**：
 * - 卡片侧（`playBannerSound`）：读取 / 播放失败一律**静默回落默认合成音** ——
 *   提醒不能因为音效文件丢了就无声；
 * - 设置页试听：自己组合 `loadBannerSound` + 播放函数，把错误如实显示出来
 *   （用户正在排障，静默吞错会让他以为"设置生效了"）。
 *
 * 模块级单例（同 `chime.ts` 的复用上下文）：同一窗口里新的播放会停掉旧的，
 * 卡片关闭 / 换条时由调用方 `stopBannerSound()`（与 `tts.stop()` 同一时机）。
 */
import type { NotificationSoundData, Result } from '@aurora/shared'
import { playBannerChime } from './chime.js'

/** 一次提示音的来源判定结果（纯数据，node 里可单测）。 */
export type BannerSoundSource =
  | { kind: 'builtin' }
  | { kind: 'custom'; data: NotificationSoundData }
  | { kind: 'error'; message: string }

type ReadSound = () => Promise<Result<NotificationSoundData | null>>

const defaultReadSound: ReadSound = () => window.aurora.notifications.readSound()

/**
 * 读自定义提示音并判定来源：未配置 → builtin；IPC 报错 / 文件不可用 → error。
 * `readSound` 是测试注入点，生产走 `window.aurora.notifications.readSound`。
 */
export async function loadBannerSound(
  readSound: ReadSound = defaultReadSound,
): Promise<BannerSoundSource> {
  let result: Result<NotificationSoundData | null>
  try {
    result = await readSound()
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }
  }
  if (!result.ok) return { kind: 'error', message: result.message }
  if (result.value === null) return { kind: 'builtin' }
  return { kind: 'custom', data: result.value }
}

/**
 * 只声明这里真的用到的那部分音频接口：真实 `HTMLAudioElement` 结构上满足它，
 * 单测可以塞假元素（node 里没有 `Audio`）。
 */
export interface BannerAudioLike {
  volume: number
  src: string
  play(): Promise<void>
  pause(): void
  onended: (() => void) | null
  onerror: (() => void) | null
}

export type BannerAudioFactory = (src: string) => BannerAudioLike

// 窄化成只含本模块用到的成员：真实 HTMLAudioElement 结构上满足，但 DOM 的事件签名更宽
// （同 chime.ts 对 AudioContext 的那一处窄化转换）
const defaultAudioFactory: BannerAudioFactory = (src) =>
  new Audio(src) as unknown as BannerAudioLike

let audio: BannerAudioLike | null = null
let objectUrl: string | null = null
/** 自增令牌：stop / 新播放让在途的 play() 回包作废（同 useTts 的口径）。 */
let token = 0

/** 释放当前音频与对象 URL；ended / error / stop 三条路径都收敛到这里。 */
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

/** 停止自定义音效（默认合成音只有约 1.3s，不提供中途停止）。 */
export function stopBannerSound(): void {
  token += 1
  release()
}

/** base64 → 字节数组（`atob` 给出 latin1 字符串，逐字符取码点；同 useTts）。 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 播放自定义音效（blob URL + HTMLAudioElement）。
 * 音量按 0–1 线性作用（与 TTS 同口径；合成音那边另有感知曲线）。
 * 返回 `true` = 真的开始播了；`false` = 解码 / 播放失败（调用方决定要不要回落）。
 * 被更新的播放取代时也回 `true`（别拿旧请求的失败去覆盖新播放）。
 */
export async function playCustomBannerSound(
  data: NotificationSoundData,
  volume: number,
  createAudio: BannerAudioFactory = defaultAudioFactory,
): Promise<boolean> {
  stopBannerSound()
  const current = token

  let url: string
  try {
    const bytes = base64ToBytes(data.dataBase64)
    url = URL.createObjectURL(new Blob([bytes], { type: data.mime }))
  } catch {
    return false
  }
  objectUrl = url
  const element = createAudio(url)
  audio = element
  element.volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0))
  element.onended = () => {
    if (current === token) release()
  }
  element.onerror = () => {
    if (current === token) release()
  }
  try {
    await element.play()
  } catch {
    // 自动播放被策略拦下 / 设备不可用：卡片侧由调用方回落默认音
    if (current !== token) return true
    release()
    return false
  }
  return true
}

/**
 * 卡片侧入口：播一次提示音（自定义优先，读取 / 播放失败或未配置都回落默认合成音）。
 * 任何失败都静默 —— 音效没响绝不能影响卡片显示。
 */
export async function playBannerSound(
  volume: number,
  readSound: ReadSound = defaultReadSound,
): Promise<void> {
  const source = await loadBannerSound(readSound)
  if (source.kind === 'custom' && (await playCustomBannerSound(source.data, volume))) {
    return
  }
  await playBannerChime(volume)
}
