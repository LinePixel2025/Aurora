/**
 * 流光提醒服务的单测（docs/07 §2.2.3）。
 *
 * 断言的是**纯逻辑**（队列 / 去重 / 降级 / 时长钳制 / 迟到的回执），
 * 窗口与语音那两段由 `capture` 与冒烟覆盖 —— 这里不 import electron。
 */
import { describe, expect, it, vi } from 'vitest'
import { BannerService, type BannerServiceOptions } from './banner.js'
import type { BannerShowPayload, Logger } from '@aurora/shared'

function quietLogger(): Logger {
  const noop = (): void => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => quietLogger(),
    setLevel: noop,
  } as unknown as Logger
}

interface Harness {
  service: BannerService
  shown: BannerShowPayload[]
  hide: ReturnType<typeof vi.fn>
}

function createHarness(overrides: Partial<BannerServiceOptions> = {}): Harness {
  const shown: BannerShowPayload[] = []
  const hide = vi.fn()
  const service = new BannerService({
    logger: quietLogger(),
    present: (payload) => {
      shown.push(payload)
      return true
    },
    hide,
    now: () => 1_000,
    ...overrides,
  })
  return { service, shown, hide }
}

describe('BannerService', () => {
  it('第一条直接显示：标题 / 正文 / 缺省值都按约定解算', () => {
    const { service, shown } = createHarness({
      preferences: () => ({ sound: true, speak: true, volume: 0.6, durationMs: 6000 }),
    })
    const outcome = service.show({ title: '构建完成', body: '产物已写到 out/' })
    expect(outcome.ok).toBe(true)
    expect(outcome.queued).toBe(false)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: '构建完成',
      body: '产物已写到 out/',
      speak: true,
      sound: true,
      volume: 0.6,
      durationMs: 6000,
      level: 'info',
    })
    expect(service.diagnostics().visible).toBe(true)
  })

  it('提醒细节来自用户设置；请求级只能再关，不能越过总闸', () => {
    let prefs = { sound: true, speak: true, volume: 0.4, durationMs: 9000 }
    const { service, shown } = createHarness({ preferences: () => prefs })
    const first = service.show({ title: 'A', body: '' })
    service.dismiss(first.id ?? '')
    // 请求级显式关掉其中两项、并覆盖时长
    service.show({ title: 'B', body: '', sound: false, speak: false, durationMs: 3000 })
    expect(shown[0]).toMatchObject({ sound: true, speak: true, volume: 0.4, durationMs: 9000 })
    expect(shown[1]).toMatchObject({ sound: false, speak: false, volume: 0.4, durationMs: 3000 })

    // 总闸关掉后，请求级 true 也不能越过
    prefs = { ...prefs, sound: false, speak: false }
    service.dismiss(shown[1]?.id ?? '')
    service.show({ title: 'C', body: '', sound: true, speak: true })
    expect(shown[2]).toMatchObject({ sound: false, speak: false })
  })

  it('未注入设置时按保守缺省（提示音开、不朗读、满音量、6 秒）', () => {
    const { service, shown } = createHarness()
    service.show({ title: 'A', body: 'B' })
    expect(shown[0]).toMatchObject({ speak: false, sound: true, volume: 1, durationMs: 6000 })
  })

  it('设置读取失败时按保守缺省处理（不能因为读配置失败就不弹）', () => {
    const { service, shown } = createHarness({
      preferences: () => {
        throw new Error('配置读不出来')
      },
    })
    expect(service.show({ title: 'A', body: 'B' }).ok).toBe(true)
    expect(shown[0]).toMatchObject({ speak: false, sound: true })
  })

  it('一次只显示一条：第二条进队列，dismiss 后自动补上', () => {
    const { service, shown, hide } = createHarness()
    const first = service.show({ title: '第一条', body: '' })
    const second = service.show({ title: '第二条', body: '正文' })
    expect(shown).toHaveLength(1)
    expect(second.queued).toBe(true)
    expect(service.diagnostics()).toEqual({ visible: true, pending: 1, shownCount: 1 })

    const dismissed = service.dismiss(first.id ?? '')
    expect(dismissed).toEqual({ dismissed: true, pending: 0 })
    expect(hide).toHaveBeenCalledTimes(1)
    // 队首自动显示，不需要第二次 show
    expect(shown).toHaveLength(2)
    expect(shown[1]?.title).toBe('第二条')
  })

  it('迟到的回执不会关掉新卡片（id 不匹配一律忽略）', () => {
    const { service, shown, hide } = createHarness()
    const first = service.show({ title: '旧', body: '' })
    service.dismiss(first.id ?? '')
    const second = service.show({ title: '新', body: '' })
    expect(shown).toHaveLength(2)

    expect(service.dismiss(first.id ?? '')).toEqual({ dismissed: false, pending: 0 })
    expect(service.dismiss(second.id ?? '')).toEqual({ dismissed: true, pending: 0 })
    // 只有两次真实关闭（旧 / 新），迟到回执没有触发第三次 hide
    expect(hide).toHaveBeenCalledTimes(2)
  })

  it('同内容在去重窗口内只显示一次，显式 dedupeKey 也生效', () => {
    const { service, shown } = createHarness()
    expect(service.show({ title: '同一条', body: '正文' }).ok).toBe(true)
    const duplicate = service.show({ title: '同一条', body: '正文' })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.reason).toContain('重复')
    expect(shown).toHaveLength(1)

    service.show({ title: '甲', body: '', dedupeKey: 'k' })
    expect(service.show({ title: '乙', body: '', dedupeKey: 'k' }).ok).toBe(false)
  })

  it('去重按时间窗失效（过了窗口就能再弹）', () => {
    let now = 1_000
    const shown: BannerShowPayload[] = []
    const service = new BannerService({
      logger: quietLogger(),
      present: (payload) => {
        shown.push(payload)
        return true
      },
      hide: () => {},
      now: () => now,
      dedupeWindowMs: 1_000,
    })
    const first = service.show({ title: '周期提醒', body: '' })
    service.dismiss(first.id ?? '')
    now = 1_200
    expect(service.show({ title: '周期提醒', body: '' }).ok).toBe(false)
    now = 2_100
    const third = service.show({ title: '周期提醒', body: '' })
    expect(third.ok).toBe(true)
    expect(shown).toHaveLength(2)
  })

  it('队列满了拒绝新请求并说明原因（而不是静默丢弃）', () => {
    const { service } = createHarness({ maxQueue: 2 })
    service.show({ title: '一', body: '' })
    expect(service.show({ title: '二', body: '' }).queued).toBe(true)
    expect(service.show({ title: '三', body: '' }).queued).toBe(true)
    const rejected = service.show({ title: '四', body: '' })
    expect(rejected.ok).toBe(false)
    expect(rejected.reason).toContain('队列已满')
    expect(service.diagnostics().pending).toBe(2)
  })

  it('载体失败时降级：不抛错、不卡队列，下一条继续尝试', () => {
    const attempts: string[] = []
    let failFirst = true
    const service = new BannerService({
      logger: quietLogger(),
      present: (payload) => {
        attempts.push(payload.title)
        if (failFirst) {
          failFirst = false
          throw new Error('窗口销毁')
        }
        return true
      },
      hide: () => {},
    })
    const outcome = service.show({ title: '第一条', body: '' })
    expect(outcome.ok).toBe(true)
    expect(attempts).toEqual(['第一条'])
    expect(service.diagnostics().visible).toBe(false)

    // 第二条必须还能正常显示（失败的那条不留在队列里）
    expect(service.show({ title: '第二条', body: '' }).ok).toBe(true)
    expect(service.diagnostics().visible).toBe(true)
  })

  it('present 返回 false 也算失败（窗口没显示出来）', () => {
    const { service } = createHarness({ present: () => false })
    service.show({ title: '看不见', body: '' })
    expect(service.diagnostics()).toEqual({ visible: false, pending: 0, shownCount: 0 })
  })

  it('时长钳制在 2s–30s，标题 / 正文按上限截断且正文可空', () => {
    const { service, shown } = createHarness()
    service.show({ title: 'x'.repeat(300), body: '', durationMs: 10 })
    service.dismiss(shown[0]?.id ?? '')
    service.show({ title: 'y', body: 'z'.repeat(2000), durationMs: 999_999 })
    expect(shown[0]?.title.length).toBeLessThanOrEqual(120)
    expect(shown[0]?.durationMs).toBe(2000)
    expect(shown[0]?.body).toBe('')
    expect(shown[1]?.body.length).toBeLessThanOrEqual(800)
    expect(shown[1]?.durationMs).toBe(30_000)
  })

  it('空标题回落成「Aurora 提醒」，等级非法按 info', () => {
    const { service, shown } = createHarness()
    service.show({ title: '   ', body: '', level: 'bogus' as never })
    expect(shown[0]?.title).toBe('Aurora 提醒')
    expect(shown[0]?.level).toBe('info')
  })

  it('dispose 之后不再接受请求（应用退出路径）', () => {
    const { service, shown } = createHarness()
    service.dispose()
    const outcome = service.show({ title: '退出后', body: '' })
    expect(outcome.ok).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it('超时兜底：没收到渲染层回执时按 durationMs + 宽限强制收尾', async () => {
    vi.useFakeTimers()
    try {
      const { service, hide } = createHarness({
        minDurationMs: 2_000,
        // 用户设置的停留时长（v38）：兜底判据跟着它走
        preferences: () => ({ sound: true, speak: false, volume: 1, durationMs: 2_000 }),
      })
      service.show({ title: '无人回执', body: '' })
      expect(hide).not.toHaveBeenCalled()
      // 兜底 = durationMs + 1500ms 宽限
      vi.advanceTimersByTime(3_600)
      expect(hide).toHaveBeenCalledTimes(1)
      expect(service.diagnostics().visible).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
