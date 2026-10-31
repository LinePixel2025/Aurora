/**
 * 提示音合成逻辑的单测（`renderer/shared/chime.ts`，docs/07 §2.2.3 R4）。
 *
 * 这些用例锁住「有时不响 / 听不见」这两个回归：
 * 1. 必须先 `resume()` 再调度，且起点要在 `currentTime` **之后**（旧实现排在 0 点，恢复后已成过去）；
 * 2. 音量 0.6 时峰值要明显高于旧实现（旧值 ≈ 0.03），否则现场就是"几乎听不见"。
 *
 * node 环境没有 `AudioContext`，所以模块留了 `createContext` 注入点，这里塞个假上下文。
 */
import { describe, expect, it } from 'vitest'
import {
  bannerChimeNotes,
  chimeLevel,
  playBannerChime,
  type ChimeContextLike,
  type ChimeGainLike,
  type ChimeOscillatorLike,
} from './chime.js'

interface FakeLog {
  events: string[]
  starts: number[]
  stops: number[]
  frequencies: number[]
  oscillatorTypes: string[]
  notePeaks: number[]
  masterGains: number[]
  compressor: Record<string, number>
}

/** 造一个"写入即记录"的 AudioParam 假对象（压缩器的五个参数都长这样）。 */
function writeTo(target: Record<string, number>, key: string): { value: number } {
  return {
    get value(): number {
      return target[key] ?? 0
    },
    set value(next: number) {
      target[key] = next
    },
  }
}

function makeFakeContext(options: { state?: string; resumeRejects?: boolean } = {}): {
  context: ChimeContextLike
  log: FakeLog
} {
  const log: FakeLog = {
    events: [],
    starts: [],
    stops: [],
    frequencies: [],
    oscillatorTypes: [],
    notePeaks: [],
    masterGains: [],
    compressor: {},
  }

  function makeGain(): ChimeGainLike {
    return {
      gain: {
        setValueAtTime: (value: number) => {
          log.events.push('gain')
          if (value > 0 && value < 0.5) log.notePeaks.push(value)
          if (value >= 0.5) log.masterGains.push(value)
        },
        linearRampToValueAtTime: (value: number) => {
          if (value > 0 && value < 0.5) log.notePeaks.push(value)
          if (value >= 0.5) log.masterGains.push(value)
        },
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    }
  }

  const context: ChimeContextLike = {
    currentTime: 3.5,
    state: options.state ?? 'suspended',
    destination: {},
    resume: async () => {
      log.events.push('resume')
      if (options.resumeRejects === true) throw new Error('音频设备不可用')
      context.state = 'running'
    },
    createOscillator: (): ChimeOscillatorLike => {
      const oscillator: ChimeOscillatorLike = {
        type: 'sine',
        frequency: {
          setValueAtTime: (value: number) => {
            log.events.push('frequency')
            log.frequencies.push(value)
          },
        },
        connect: () => undefined,
        start: (when: number) => {
          log.events.push('start')
          log.oscillatorTypes.push(oscillator.type)
          log.starts.push(when)
        },
        stop: (when: number) => {
          log.stops.push(when)
        },
      }
      return oscillator
    },
    createGain: makeGain,
    createDynamicsCompressor: () => ({
      threshold: writeTo(log.compressor, 'threshold'),
      knee: writeTo(log.compressor, 'knee'),
      ratio: writeTo(log.compressor, 'ratio'),
      attack: writeTo(log.compressor, 'attack'),
      release: writeTo(log.compressor, 'release'),
      connect: () => undefined,
    }),
  }
  return { context, log }
}

describe('chimeLevel', () => {
  it('0 是静音、1 是满档、0.6 走感知曲线后更高（≈0.70）', () => {
    expect(chimeLevel(0)).toBe(0)
    expect(chimeLevel(1)).toBeCloseTo(1, 5)
    expect(chimeLevel(0.6)).toBeCloseTo(0.6 ** 0.7, 5)
    expect(chimeLevel(0.6)).toBeGreaterThan(0.6)
  })

  it('非法值按静音处理', () => {
    expect(chimeLevel(Number.NaN)).toBe(0)
    expect(chimeLevel(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(chimeLevel(2)).toBeCloseTo(1, 5)
  })
})

describe('bannerChimeNotes', () => {
  it('静音不产生音符（也就不建上下文）', () => {
    expect(bannerChimeNotes(0)).toEqual([])
    expect(bannerChimeNotes(0.0001)).toEqual([])
  })

  it('三音上行、时间递增', () => {
    const notes = bannerChimeNotes(0.6)
    expect(notes).toHaveLength(3)
    expect(notes.map((note) => note.frequency)).toEqual([880, 1108.73, 1318.51])
    expect(notes[1]!.atSeconds).toBeGreaterThan(notes[0]!.atSeconds)
    expect(notes[2]!.atSeconds).toBeGreaterThan(notes[1]!.atSeconds)
  })

  it('默认音量 60% 的峰值明显高于旧实现（0.05 × 0.6 ≈ 0.03）', () => {
    const notes = bannerChimeNotes(0.6)
    expect(notes[0]!.peak).toBeGreaterThan(0.12)
    expect(notes[0]!.peak).toBeCloseTo(0.26 * 0.6 ** 0.7, 5)
  })

  it('音量越大峰值越大，且不超过单音上限', () => {
    const low = bannerChimeNotes(0.3)[0]!.peak
    const high = bannerChimeNotes(1)[0]!.peak
    expect(high).toBeGreaterThan(low)
    expect(high).toBeLessThanOrEqual(0.26)
  })
})

describe('playBannerChime', () => {
  it('先 resume 再调度，且起点在 currentTime 之后（不再排在 0 秒）', async () => {
    const { context, log } = makeFakeContext({ state: 'suspended' })
    await playBannerChime(0.6, () => context)

    const resumeIndex = log.events.indexOf('resume')
    const firstStartIndex = log.events.indexOf('start')
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(firstStartIndex).toBeGreaterThan(resumeIndex)
    expect(log.starts).toHaveLength(3)
    // currentTime = 3.5 → 起点 3.54，三个音依次 +0 / +0.13 / +0.26
    expect(log.starts[0]).toBeCloseTo(3.54, 5)
    expect(log.starts[1]).toBeCloseTo(3.67, 5)
    expect(log.starts[2]).toBeCloseTo(3.8, 5)
    expect(log.stops.every((when) => when > 3.54)).toBe(true)
    // 三角波（比旧实现的 sine 更"厚"，小喇叭上更明显）
    expect(log.oscillatorTypes).toEqual(['triangle', 'triangle', 'triangle'])
  })

  it('上下文已在 running 时不重复 resume', async () => {
    const { context, log } = makeFakeContext({ state: 'running' })
    await playBannerChime(0.6, () => context)
    expect(log.events).not.toContain('resume')
    expect(log.starts).toHaveLength(3)
  })

  it('音量 0 不创建上下文', async () => {
    let calls = 0
    const { context } = makeFakeContext()
    await playBannerChime(0, () => {
      calls += 1
      return context
    })
    expect(calls).toBe(0)
  })

  it('resume 失败也照样排音（不抛、不静默吞掉整条提醒）', async () => {
    const { context, log } = makeFakeContext({ state: 'suspended', resumeRejects: true })
    await expect(playBannerChime(0.6, () => context)).resolves.toBeUndefined()
    expect(log.starts).toHaveLength(3)
  })

  it('上下文创建抛错 / 返回 null 时静默降级', async () => {
    await expect(
      playBannerChime(0.6, () => {
        throw new Error('没有音频设备')
      }),
    ).resolves.toBeUndefined()
    await expect(playBannerChime(0.6, () => null)).resolves.toBeUndefined()
  })

  it('走压缩器并把阈值 / 比例设成防削波的一组值', async () => {
    const { context, log } = makeFakeContext({ state: 'running' })
    await playBannerChime(1, () => context)
    expect(log.compressor['threshold']).toBe(-12)
    expect(log.compressor['ratio']).toBe(8)
    expect(log.compressor['knee']).toBe(6)
  })
})
