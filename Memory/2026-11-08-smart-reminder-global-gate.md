---
date: 2026-11-08
title: 智慧提醒统一拦截默认通知与显式流光入口
tags: [智慧提醒, 提醒, 通知, 流光提醒, banner, 插件, ask_user, 队列, 坑, 口径]
source: 模型自动记录
---

# 智慧提醒统一拦截默认通知与显式流光入口

## 现象

开启智慧提醒后，分类完成、课前提醒和 `notify_user` 会进入免打扰队列，但插件 `ctx.banner`、Agent `notify_banner` 或 `ask_user` 的旁路流光提醒仍可能立即弹出。免打扰期间因此仍会被其他入口打断。

## 原因

v40 的抑制闸最初只挂在 `NotificationService.notify()`，而显式流光直接调用 `BannerService.show()`，提问播报也直接调用该服务。两条链路共用展示窗口，却没有共用抑制判定；流光服务自己的排队也只按展示时刻处理。

## 影响

只修默认通知会留下插件等旁路；只在流光入口拦截又会让已排队的卡片在免打扰状态变化后继续展示。汇总摘要如果复用普通流光入口，还会再次进入队列，形成摘要无法展示的循环。

## 结论与做法

- `NotificationService.notify()` 和 `BannerService.show()` 都必须接入同一个 `SmartReminderService.gate`。去重后、创建系统通知或流光窗口前执行；被抑制的流光请求不建窗、不播声音或语音。
- `BannerService` 的待展示队列出队前必须重新检查闸门。排队期间进入免打扰时，旧卡片转入智慧提醒队列，不继续弹出。
- 汇总使用 `notifyDigest()` 跳过默认通知闸，并向流光入口传递仅供宿主内部使用的 `bypassSmartGate` 标记，确保摘要不会被第二层闸门重新收集。
- `ask_user` 只抑制旁路流光播报，提问卡和作答流程继续正常工作。
- 新增任何提醒入口时，必须明确走 `NotificationService.notify()` 或 `BannerService.show()`，不要在调用方另写排队、去重或抑制逻辑。
