/**
 * 流光提醒的提示音（docs/07 §2.2.3、R4）。
 *
 * 用 **Web Audio 现场合成**两声清脆的音（A5 → E6），不新增音频资产：
 * 打包体积、CSP（`media-src` 只放行 blob:`/`self`）与"资源找不到"这三件事一起省掉。
 *
 * 音量来自用户设置（`notifications.volume`，0–100 → 这里收到 0–1）：
 * 峰值音量乘上去，`0` 直接不发声（省一次 AudioContext）。
 *
 * 失败一律静默：自动播放策略（窗口未激活 / 设备不可用）会把 `AudioContext` 挂起，
 * 音效只是锦上添花 —— 绝不能因为它没响就让卡片也不显示。
 */
export function playBannerChime(volume = 1): void {
  const level = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0
  if (level <= 0.001) return
  try {
    const context = new AudioContext()
    const start = context.currentTime
    // 两声上行音（A5 / E6）：短促、干净，不喧宾夺主
    const notes = [
      { frequency: 880, at: 0 },
      { frequency: 1318.51, at: 0.13 },
    ] as const
    for (const note of notes) {
      const at = start + note.at
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, at)
      // 快起慢落：attack 12ms，衰减 320ms；峰值 0.05 × 音量（桌面提醒不该刺耳）
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(0.05 * level, at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.34)
    }
    // 两声都放完再关闭上下文（提前 close 会把尾音掐掉）
    window.setTimeout(() => {
      void context.close().catch(() => undefined)
    }, 700)
  } catch {
    // 音效失败只降级：卡片与语音不受影响
  }
}
