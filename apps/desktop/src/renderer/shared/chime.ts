/**
 * 流光提醒的提示音（docs/07 §2.2.3、R4）。
 *
 * 用 **Web Audio 现场合成**三音上行（A5 → C#6 → E6），不新增音频资产：
 * 打包体积、CSP（`media-src` 只放行 blob:`/`self`）与"资源找不到"这三件事一起省掉。
 *
 * 两个「有时不响 / 听不见」的历史根因（2026-11-01 修）：
 * 1. **每次新建 `AudioContext` 并把音符排在 `currentTime`**：窗口刚显示 / 后台节流时上下文可能
 *    还是 `suspended`，`currentTime` 停在 0；等它恢复时这些音符已经"在过去"，浏览器直接不播。
 *    现在**复用同一个上下文**，播放前 `resume()`，并从 `currentTime + 40ms` 开始调度。
 * 2. **峰值太低**：旧实现 `0.05 × 音量`，默认 60% 下 ≈ 0.03 —— 笔记本 / 投影喇叭上几乎听不见。
 *    现在每音峰值 `0.26 × 音量^0.7`（默认下 ≈ 0.18），三角波 + 压缩器（防叠加削波）。
 *
 * 音量来自用户设置（`notifications.volume`，0–100 → 这里收到 0–1），与语音播报共用。
 * 失败一律静默：音效只是锦上添花 —— 绝不能因为它没响就让卡片也不显示。
 */

/** 单个音（纯数据：node 里也能直接单测）。 */
export interface ChimeNote {
  frequency: number
  /** 相对第一个音的起点（秒） */
  atSeconds: number
  /** 峰值增益（已乘过音量曲线） */
  peak: number
  /** 指数衰减时长（秒） */
  decaySeconds: number
}

/** 三音上行：A5 → C#6 → E6（大三和弦琶音，短促但不刺耳） */
const NOTE_PLAN: ReadonlyArray<{ frequency: number; atSeconds: number }> = [
  { frequency: 880, atSeconds: 0 },
  { frequency: 1108.73, atSeconds: 0.13 },
  { frequency: 1318.51, atSeconds: 0.26 },
]

/** 每音峰值（未乘音量）：桌面提醒要"听得见"，但不该刺耳 */
const NOTE_PEAK = 0.26
/** attack / 指数衰减：快起慢落，约 0.72s 收干净 */
const ATTACK_SECONDS = 0.008
const DECAY_SECONDS = 0.72
/**
 * 调度前瞻：上下文恢复与调度都需要时间，起点不能正好等于 `currentTime`
 * （否则一帧之内的抖动就可能把音符排到"已经过去"）。
 */
const SCHEDULE_LEAD_SECONDS = 0.04
/** 主增益：留出压缩器工作点，避免三音重叠时削波 */
const MASTER_GAIN = 0.9

/** 音量 → 感知曲线（线性音量在低档太轻，0.7 次方接近等响） */
export function chimeLevel(volume: number): number {
  if (!Number.isFinite(volume)) return 0
  const level = Math.min(1, Math.max(0, volume))
  return Math.pow(level, 0.7)
}

/** 这一音量下要播哪些音（0 音量返回空数组 = 不建上下文、不发声）。 */
export function bannerChimeNotes(volume: number): ChimeNote[] {
  const level = chimeLevel(volume)
  // 感知曲线后的有效增益低于这个值在桌面喇叭上已经听不见，直接不建上下文
  if (level <= 0.002) return []
  return NOTE_PLAN.map((note) => ({
    frequency: note.frequency,
    atSeconds: note.atSeconds,
    peak: NOTE_PEAK * level,
    decaySeconds: DECAY_SECONDS,
  }))
}

/**
 * 只声明**这里真的用到**的那部分 Web Audio 接口。
 *
 * 好处：单测可以塞一个假上下文（node 里没有 `AudioContext`），而真实的
 * `AudioContext` 天然满足它（见 `createDefaultContext` 的那一处窄化转换）。
 */
export interface ChimeOscillatorLike {
  type: string
  frequency: { setValueAtTime(value: number, when: number): void }
  connect(node: unknown): void
  start(when: number): void
  stop(when: number): void
}

export interface ChimeGainLike {
  gain: {
    setValueAtTime(value: number, when: number): void
    linearRampToValueAtTime(value: number, when: number): void
    exponentialRampToValueAtTime(value: number, when: number): void
  }
  connect(node: unknown): void
}

export interface ChimeCompressorLike {
  threshold: { value: number }
  knee: { value: number }
  ratio: { value: number }
  attack: { value: number }
  release: { value: number }
  connect(node: unknown): void
}

export interface ChimeContextLike {
  currentTime: number
  state: string
  destination: unknown
  resume(): Promise<void>
  createOscillator(): ChimeOscillatorLike
  createGain(): ChimeGainLike
  createDynamicsCompressor(): ChimeCompressorLike
}

/**
 * 复用的上下文：**不要**每次播放新建 / 播完 close。
 *
 * 新建的上下文在窗口刚显示时常常是 `suspended`，而 close 会让下一次又走一遍同样的路；
 * 提示音很短、上下文常驻的开销可以忽略。
 */
let sharedContext: ChimeContextLike | null = null

function createDefaultContext(): ChimeContextLike | null {
  if (sharedContext !== null && sharedContext.state !== 'closed') return sharedContext
  if (typeof AudioContext === 'undefined') return null
  try {
    // 窄化成只含本模块用到的成员：真实 AudioContext 结构上满足，但 DOM 的重载签名更宽
    sharedContext = new AudioContext() as unknown as ChimeContextLike
    return sharedContext
  } catch {
    return null
  }
}

/** 把音符排进上下文：master → compressor → destination，每音独立振荡器 + 增益包络。 */
function scheduleChime(context: ChimeContextLike, notes: ChimeNote[]): void {
  const master = context.createGain()
  master.gain.setValueAtTime(MASTER_GAIN, context.currentTime)
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = -12
  compressor.knee.value = 6
  compressor.ratio.value = 8
  compressor.attack.value = 0.003
  compressor.release.value = 0.25
  master.connect(compressor)
  compressor.connect(context.destination)

  // 起点在 resume 之后现算：恢复可能推进 currentTime，别用创建上下文时的旧值
  const start = context.currentTime + SCHEDULE_LEAD_SECONDS
  for (const note of notes) {
    const at = start + note.atSeconds
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(note.frequency, at)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(note.peak, at + ATTACK_SECONDS)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.decaySeconds)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(at)
    oscillator.stop(at + note.decaySeconds + 0.02)
  }
}

/**
 * 播一次提示音。
 *
 * - `volume`：0–1（用户音量 / 100）；0 或非法值直接不发声；
 * - `createContext`：测试注入点，生产用复用的 `AudioContext`；
 * - 返回 Promise 只是为了单测能等到「resume → 调度」完成，调用方 `void` 掉即可。
 * - 任何失败（没有音频设备 / 上下文被挂起 / 内部异常）都静默降级，**绝不向上抛**。
 */
export async function playBannerChime(
  volume = 1,
  createContext: () => ChimeContextLike | null = createDefaultContext,
): Promise<void> {
  const notes = bannerChimeNotes(volume)
  if (notes.length === 0) return

  let context: ChimeContextLike | null
  try {
    context = createContext()
  } catch {
    return
  }
  if (context === null) return

  if (context.state !== 'running') {
    try {
      await context.resume()
    } catch {
      // 恢复失败也照样排音：上下文可能在稍后真正恢复，排音本身不会再抛
    }
  }

  try {
    scheduleChime(context, notes)
  } catch {
    // 音效失败只降级：卡片与语音不受影响
  }
}
