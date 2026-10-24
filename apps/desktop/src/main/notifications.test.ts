/**
 * 提醒编排层的单测（v37，docs/07 §4）。
 *
 * 只验证**路由**：一条提醒按 `notifications.channel` 投到哪条（或哪两条）通道、
 * 去重是否先于通道判定、`off` 是否真的静默、载体缺失时是否回落而不是丢提醒。
 * 通道自身的实现（系统通知 / 流光窗口）由各自的测试与截图覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Logger, ReminderChannel } from '@aurora/shared'
import { NotificationService, type NotificationRequest } from './notifications.js'

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
  service: NotificationService
  system: Array<NotificationRequest>
  banners: Array<{ title: string; body: string; dedupeKey?: string }>
  setChannel: (channel: ReminderChannel) => void
}

function createHarness(options: { withBanner?: boolean } = {}): Harness {
  const system: NotificationRequest[] = []
  const banners: Array<{ title: string; body: string; dedupeKey?: string }> = []
  let channel: ReminderChannel = 'system'
  const service = new NotificationService({
    logger: quietLogger(),
    present: (request) => {
      system.push(request)
      return true
    },
    channel: () => channel,
    ...(options.withBanner === false
      ? {}
      : {
          banner: (request) => {
            banners.push(request)
            return true
          },
        }),
  })
  return {
    service,
    system,
    banners,
    setChannel: (next) => {
      channel = next
    },
  }
}

describe('NotificationService 的默认提醒方式', () => {
  it('system（缺省）：只走系统通知，行为与 v37 之前一致', () => {
    const { service, system, banners } = createHarness()
    expect(service.notify({ title: 't', body: 'b' })).toBe(true)
    expect(system).toHaveLength(1)
    expect(banners).toHaveLength(0)
    expect(service.shownByBannerCount).toBe(0)
  })

  it('banner：只走流光提醒，且把 dedupeKey 透传下去（两条通道共用同一份合并口径）', () => {
    const { service, system, banners, setChannel } = createHarness()
    setChannel('banner')
    expect(service.notify({ title: 't', body: 'b', dedupeKey: 'k' })).toBe(true)
    expect(system).toHaveLength(0)
    expect(banners).toEqual([{ title: 't', body: 'b', dedupeKey: 'k' }])
    expect(service.shownCount).toBe(1)
    expect(service.shownByBannerCount).toBe(1)
  })

  it('both：两条都发，但只算一次（成功计数不重复）', () => {
    const { service, system, banners, setChannel } = createHarness()
    setChannel('both')
    expect(service.notify({ title: 't', body: 'b' })).toBe(true)
    expect(system).toHaveLength(1)
    expect(banners).toHaveLength(1)
    expect(service.shownCount).toBe(1)
    // 「两者都发」时系统通知也成功了，因此不算「只走流光」
    expect(service.shownByBannerCount).toBe(0)
  })

  it('off：不投递任何通道，返回 false（调用方仍会记日志）', () => {
    const { service, system, banners, setChannel } = createHarness()
    setChannel('off')
    expect(service.notify({ title: 't', body: 'b' })).toBe(false)
    expect(system).toHaveLength(0)
    expect(banners).toHaveLength(0)
    expect(service.shownCount).toBe(0)
  })

  it('去重先于通道判定：同一条提醒切到 both 也不会两条各弹一遍', () => {
    const { service, system, banners, setChannel } = createHarness()
    service.notify({ title: '同一件事', body: '正文', dedupeKey: 'same' })
    setChannel('both')
    expect(service.notify({ title: '同一件事', body: '正文', dedupeKey: 'same' })).toBe(false)
    expect(system).toHaveLength(1)
    expect(banners).toHaveLength(0)
  })

  it('流光载体缺失时 banner / both 回落到系统通知（不静默丢提醒）', () => {
    const { service, system, banners, setChannel } = createHarness({ withBanner: false })
    setChannel('banner')
    expect(service.notify({ title: 't', body: 'b' })).toBe(true)
    expect(system).toHaveLength(1)
    expect(banners).toHaveLength(0)
  })

  it('通道读取失败按系统通知处理（宁可多弹一条，不吞提醒）', () => {
    const system: NotificationRequest[] = []
    const service = new NotificationService({
      logger: quietLogger(),
      present: (request) => {
        system.push(request)
        return true
      },
      channel: () => {
        throw new Error('配置读不出来')
      },
    })
    expect(service.notify({ title: 't', body: 'b' })).toBe(true)
    expect(system).toHaveLength(1)
  })

  it('系统通知载体抛错时流光通道照常投递（两通道互相独立降级）', () => {
    const banners: Array<{ title: string }> = []
    const service = new NotificationService({
      logger: quietLogger(),
      present: () => {
        throw new Error('系统通知不可用')
      },
      channel: () => 'both',
      banner: (request) => {
        banners.push(request)
        return true
      },
    })
    expect(service.notify({ title: 't', body: 'b' })).toBe(true)
    expect(banners).toHaveLength(1)
  })

  it('分类 / 课前提醒的文案与 openPath 仍然只由这里组装（通道切换不改文案）', () => {
    const system: NotificationRequest[] = []
    let channel: ReminderChannel = 'system'
    const service = new NotificationService({
      logger: quietLogger(),
      present: (request) => {
        system.push(request)
        return true
      },
      channel: () => channel,
    })
    const spy = vi.spyOn(service, 'notify')
    service.notifyClassified({ fileName: 'a.docx', subject: '数学', targetDir: 'C:\\x' })
    expect(spy).toHaveBeenCalledWith({
      title: '分类完成',
      body: '《a.docx》已分类到 数学',
      openPath: 'C:\\x',
      dedupeKey: 'classify:a.docx',
    })
    channel = 'off'
    expect(service.notifyPreClass({ subject: '数学', minutesUntil: 5, targetDir: 'C:\\x' })).toBe(
      false,
    )
  })
})
