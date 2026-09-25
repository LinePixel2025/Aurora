/**
 * `NotifyPort` 的主进程实现（Design/betav2-spec.md §8.4、docs/06 §14）。
 *
 * 把内核的 `show(title, body)` 映射到既有的 `NotificationService.notify`：
 * 复用同一条通知链路（去重、点击打开、日志计数、降级），**不再开第二条实现**。
 * 本文件不 import electron（NotificationService 自身已可注入），可在 Node 里单测。
 */
import type { NotifyPort } from '@aurora/agent-core'

/** 结构化最小面：`NotificationService` 天然满足（docs/05 §3.3） */
export interface NotificationServiceLike {
  notify(request: { title: string; body: string; openPath?: string }): boolean
}

export function createNotificationPort(service: NotificationServiceLike): NotifyPort {
  return {
    async show(title: string, body: string): Promise<void> {
      const shown = service.notify({ title, body })
      if (!shown) {
        // notify() 不区分「系统不可用」与「3s 内重复被去重」，如实回报两种可能，
        // 让模型知道用户可能没有看到，而不是收到一条假成功的「已发送」。
        throw new Error('通知未展示（系统不支持，或短时间内重复内容被去重）')
      }
    },
  }
}
