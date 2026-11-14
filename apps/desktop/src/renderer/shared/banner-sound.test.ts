/**
 * 提示音统一播放链的单测（`renderer/shared/banner-sound.ts`，docs/07 §2.2.3 R4）。
 *
 * 锁住三条口径：
 * 1. 来源判定：未配置 → builtin；IPC 错误 / 抛错 → error（设置页据此报错）；
 * 2. 卡片侧回落：读取失败 / 自定义播放失败都回落默认合成音（提醒必须有声）；
 * 3. 资源纪律：新的播放停旧的，ended / error / stop 都释放 blob URL。
 *
 * node 环境没有 `Audio` / `AudioContext`：前者用工厂注入，后者 stub 一个假上下文
 * （默认合成音走 chime.ts 的 `createDefaultContext`，会认这个全局）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSoundData, Result } from '@aurora/shared'
import {
  loadBannerSound,
  playBannerSound,
  playCustomBannerSound,
  stopBannerSound,
  type BannerAudioLike,
} from './banner-sound.js'

/** 假音频元素：记录 play / pause，可配置 play 拒绝。 */
function makeFakeAudio(): BannerAudioLike & { playCalls: number; playRejects: boolean } {
  const element = {
    volume: 1,
    src: '',
    playCalls: 0,
    playRejects: false,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    async play(): Promise<void> {
      element.playCalls += 1
      if (element.playRejects) throw new Error('自动播放被阻止')
    },
    pause(): void {
      // 释放路径会调用；这里只记录
    },
  }
  return element
}

/** 假 AudioContext：只记录振荡器 start（证明默认合成音真的被调度了）。 */
const chimeStarts: number[] = []
class FakeAudioContext {
  currentTime = 1
  state = 'running'
  destination = {}
  async resume(): Promise<void> {}
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: () => undefined },
      connect: () => undefined,
      start: (when: number) => {
        chimeStarts.push(when)
      },
      stop: () => undefined,
    }
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    }
  }
  createDynamicsCompressor() {
    const param = { value: 0 }
    return {
      threshold: param,
      knee: param,
      ratio: param,
      attack: param,
      release: param,
      connect: () => undefined,
    }
  }
}

const SOUND: NotificationSoundData = { dataBase64: btoa('fake-audio-bytes'), mime: 'audio/wav' }

function okResult<T>(value: T): Result<T> {
  return { ok: true, value }
}

beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-sound')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  stopBannerSound()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('loadBannerSound', () => {
  it('未配置（null）→ builtin', async () => {
    const source = await loadBannerSound(async () => okResult(null))
    expect(source).toEqual({ kind: 'builtin' })
  })

  it('有数据 → custom（原样带回 base64 与 mime）', async () => {
    const source = await loadBannerSound(async () => okResult(SOUND))
    expect(source).toEqual({ kind: 'custom', data: SOUND })
  })

  it('IPC 错误 → error（带主进程文案，设置页据此如实报错）', async () => {
    const source = await loadBannerSound(async () => ({
      ok: false,
      code: 'E_IO',
      message: '提示音文件不存在或已被移动，请在设置里重新选择',
    }))
    expect(source).toEqual({
      kind: 'error',
      message: '提示音文件不存在或已被移动，请在设置里重新选择',
    })
  })

  it('IPC 抛错也折成 error（不越界）', async () => {
    const source = await loadBannerSound(async () => {
      throw new Error('通道未装配')
    })
    expect(source.kind).toBe('error')
  })
})

describe('playCustomBannerSound', () => {
  it('blob URL 播放：音量线性作用、play 真的被调用', async () => {
    const element = makeFakeAudio()
    // 与真实 `new Audio(src)` 同款：构造时接收 src
    const played = await playCustomBannerSound(SOUND, 0.4, (src) => {
      element.src = src
      return element
    })
    expect(played).toBe(true)
    expect(element.src).toBe('blob:fake-sound')
    expect(element.volume).toBeCloseTo(0.4, 5)
    expect(element.playCalls).toBe(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('音量越界 / 非法时夹取（与 TTS 同口径）', async () => {
    const loud = makeFakeAudio()
    await playCustomBannerSound(SOUND, 2, () => loud)
    expect(loud.volume).toBe(1)
    const nan = makeFakeAudio()
    await playCustomBannerSound(SOUND, Number.NaN, () => nan)
    expect(nan.volume).toBe(0)
  })

  it('play 被拒 → 返回 false 并释放资源（调用方据此回落）', async () => {
    const element = makeFakeAudio()
    element.playRejects = true
    const played = await playCustomBannerSound(SOUND, 0.6, () => element)
    expect(played).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-sound')
  })

  it('base64 非法 → 返回 false（不建音频元素）', async () => {
    let created = 0
    const played = await playCustomBannerSound(
      { dataBase64: '!!!不是-base64!!!', mime: 'audio/wav' },
      0.6,
      () => {
        created += 1
        return makeFakeAudio()
      },
    )
    expect(played).toBe(false)
    expect(created).toBe(0)
  })

  it('播完（onended）释放 blob URL', async () => {
    const element = makeFakeAudio()
    await playCustomBannerSound(SOUND, 0.6, () => element)
    element.onended?.()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-sound')
  })

  it('新的播放停掉旧的；stopBannerSound 也释放', async () => {
    const first = makeFakeAudio()
    const pauseSpy = vi.spyOn(first, 'pause')
    await playCustomBannerSound(SOUND, 0.6, () => first)
    const second = makeFakeAudio()
    await playCustomBannerSound(SOUND, 0.6, () => second)
    expect(pauseSpy).toHaveBeenCalled()
    expect(first.onended).toBeNull()
    stopBannerSound()
    expect(second.src).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
})

describe('playBannerSound（卡片侧：失败必须回落默认音）', () => {
  it('未配置 → 播默认合成音（两个振荡器被调度）', async () => {
    const before = chimeStarts.length
    await playBannerSound(0.6, async () => okResult(null))
    expect(chimeStarts.length - before).toBe(2)
  })

  it('读取失败 → 静默回落默认合成音（提醒不能无声）', async () => {
    const before = chimeStarts.length
    await playBannerSound(0.6, async () => ({
      ok: false,
      code: 'E_IO',
      message: '提示音文件不存在或已被移动，请在设置里重新选择',
    }))
    expect(chimeStarts.length - before).toBe(2)
  })

  it('自定义播放失败 → 也回落默认合成音', async () => {
    const before = chimeStarts.length
    const element = makeFakeAudio()
    element.playRejects = true
    // 通过全局 Audio 工厂注入失败元素：playBannerSound 内部走默认工厂
    vi.stubGlobal('Audio', function () {
      return element
    })
    await playBannerSound(0.6, async () => okResult(SOUND))
    expect(element.playCalls).toBe(1)
    expect(chimeStarts.length - before).toBe(2)
  })

  it('自定义成功 → 只播文件，不再合成', async () => {
    const before = chimeStarts.length
    const element = makeFakeAudio()
    vi.stubGlobal('Audio', function () {
      return element
    })
    await playBannerSound(0.6, async () => okResult(SOUND))
    expect(element.playCalls).toBe(1)
    expect(chimeStarts.length - before).toBe(0)
  })

  it('音量 0：自定义仍会"播"（静音由元素音量表达），合成音不建上下文', async () => {
    const element = makeFakeAudio()
    vi.stubGlobal('Audio', function () {
      return element
    })
    await playBannerSound(0, async () => okResult(SOUND))
    expect(element.volume).toBe(0)
    const before = chimeStarts.length
    await playBannerSound(0, async () => okResult(null))
    expect(chimeStarts.length - before).toBe(0)
  })
})
