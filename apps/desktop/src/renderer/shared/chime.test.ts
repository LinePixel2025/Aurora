/**
 * 默认提示音合成逻辑的单测（`renderer/shared/chime.ts`，docs/07 §2.2.3 R4）。
 *
 * 这些用例锁住三类回归：
 * 1. 「有时不响」：必须先 `resume()` 再调度，且起点要在 `currentTime` **之后**
 *    （旧实现排在 0 点，恢复后已成过去）；
 * 2. 「听不见」：音量 0.6 时峰值要明显高于旧实现（旧值 ≈ 0.03）；
 * 3. 「Win11 风格走样」（2026-11-14）：两音下行纯四度（D#6 → A#5）、正弦波、
 *    软起音 + 两段衰减（先快衰到 30% 再长尾）—— 改回上行三连音 / 三角波 / 硬起音都会红。
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

interface RampRecord {
  value: number
  when: number
}

interface FakeLog {
  events: string[]
  starts: number[]
  stops: number[]
  frequencies: number[]
  oscillatorTypes: string[]
  /** 线性爬升（软起音）的目标值与时刻 */
  linearRamps: RampRecord[]
  /** 指数衰减（两段式）的目标值与时刻 */
  exponentialRamps: RampRecord[]
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
    linearRamps: [],
    exponentialRamps: [],
    masterGains: [],
    compressor: {},
  }

  function makeGain(): ChimeGainLike {
    return {
      gain: {
        setValueAtTime: (value: number) => {
          log.events.push('gain')
          if (value >= 0.5) log.masterGains.push(value)
        },
        linearRampToValueAtTime: (value: number, when: number) => {
          log.linearRamps.push({ value, when })
        },
        exponentialRampToValueAtTime: (value: number, when: number) => {
          log.exponentialRamps.push({ value, when })
        },
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

  it('Win11 风格：两音下行纯四度（D#6 → A#5）、第二音晚 0.2s 进入', () => {
    const notes = bannerChimeNotes(0.6)
    expect(notes).toHaveLength(2)
    expect(notes.map((note) => note.frequency)).toEqual([1244.51, 932.33])
    expect(notes[1]!.frequency).toBeLessThan(notes[0]!.frequency)
    expect(notes[0]!.atSeconds).toBe(0)
    expect(notes[1]!.atSeconds).toBeCloseTo(0.2, 5)
  })

  it('默认音量 60% 的峰值明显高于旧实现（0.05 × 0.6 ≈ 0.03），第二音更轻（×0.78）', () => {
    const notes = bannerChimeNotes(0.6)
    expect(notes[0]!.peak).toBeGreaterThan(0.12)
    expect(notes[0]!.peak).toBeCloseTo(0.26 * 0.6 ** 0.7, 5)
    expect(notes[1]!.peak).toBeCloseTo(notes[0]!.peak * 0.78, 5)
  })

  it('软起音：两音各有 0.1s 量级的 attack（不是打击乐式硬起）', () => {
    const notes = bannerChimeNotes(0.6)
    expect(notes[0]!.attackSeconds).toBeGreaterThanOrEqual(0.1)
    expect(notes[1]!.attackSeconds).toBeGreaterThanOrEqual(0.08)
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
    expect(log.starts).toHaveLength(2)
    // currentTime = 3.5 → 起点 3.54，第二音 +0.2
    expect(log.starts[0]).toBeCloseTo(3.54, 5)
    expect(log.starts[1]).toBeCloseTo(3.74, 5)
    expect(log.stops.every((when) => when > 3.54)).toBe(true)
    // 正弦波（Win11 通知音实测近纯音；三角波是旧实现的音色）
    expect(log.oscillatorTypes).toEqual(['sine', 'sine'])
  })

  it('软起音 + 两段衰减：线性爬到峰值，先快衰到 30% 再长尾收干净', async () => {
    const { context, log } = makeFakeContext({ state: 'running' })
    await playBannerChime(1, () => context)

    const level = chimeLevel(1)
    const firstPeak = 0.26 * level
    // 第一音：3.54 起，0.14s 爬到峰值
    expect(log.linearRamps[0]!.value).toBeCloseTo(firstPeak, 5)
    expect(log.linearRamps[0]!.when).toBeCloseTo(3.54 + 0.14, 5)
    // 两段指数衰减：先到 peak × 0.3（快衰段），再到 0.0001（长尾）
    expect(log.exponentialRamps[0]!.value).toBeCloseTo(firstPeak * 0.3, 5)
    expect(log.exponentialRamps[0]!.when).toBeCloseTo(3.54 + 0.14 + 0.12, 5)
    expect(log.exponentialRamps[1]!.value).toBeCloseTo(0.0001, 5)
    expect(log.exponentialRamps[1]!.when).toBeCloseTo(3.54 + 0.14 + 0.95, 5)
    // 第二音同样两段（每音 2 条指数衰减，共 4 条）
    expect(log.exponentialRamps).toHaveLength(4)
    expect(log.exponentialRamps[3]!.when).toBeCloseTo(3.74 + 0.1 + 1.0, 5)
  })

  it('上下文已在 running 时不重复 resume', async () => {
    const { context, log } = makeFakeContext({ state: 'running' })
    await playBannerChime(0.6, () => context)
    expect(log.events).not.toContain('resume')
    expect(log.starts).toHaveLength(2)
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
    expect(log.starts).toHaveLength(2)
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
