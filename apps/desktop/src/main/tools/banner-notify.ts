/**
 * `BannerNotifyPort` 的主进程实现（docs/06 §14、docs/07 §2.2.3）。
 *
 * 把内核的 `notify_banner({ title, body, speak?, sound? })` 映射到
 * `BannerService.show()` —— 与插件 `ctx.banner` 走**同一个**服务实例，
 * 于是排队 / 去重 / 降级只有一份实现。
 *
 * 本文件不 import electron（`BannerService` 自身已可注入窗口载体），可在 Node 里单测。
 */
import type { BannerNotifyPort } from '@aurora/agent-core'
import type { BannerServiceLike } from '../contracts.js'

export function createBannerNotifyPort(service: BannerServiceLike): BannerNotifyPort {
  return {
    async show(input): Promise<{ ok: boolean; reason?: string }> {
      const outcome = service.show(
        {
          title: input.title,
          body: input.body,
          ...(input.speak === undefined ? {} : { speak: input.speak }),
          ...(input.sound === undefined ? {} : { sound: input.sound }),
        },
        { source: 'agent' },
      )
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason ?? '原因未知' }
    },
  }
}
