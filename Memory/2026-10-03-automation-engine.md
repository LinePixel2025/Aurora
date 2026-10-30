---
date: 2026-10-03
title: 自动化引擎的接线：构造期订阅、去重 TTL、runDefinition 与 auto- 确认链
tags: [自动化, 权限, 会话, 坑]
source: 模型自动记录
---

## 现象

- 历史永远停在 `running`：`done` / `error` 事件落在「构造完成 → `start()` 之间」时没人接。
- 两条内置自动化互相挡住：它们共用同一个 `lessonKey`，而 `firedKeys` 用了同一个集合。
- 手动触发 Agent 模式的自动化只落一条「进行中」历史、从不调用 Agent（定义没有 `actions`，而 `runNow` 只执行操作组件）。
- 自测夹具写盘后引擎不认：引擎在 bootstrap 时启动并首读 store（in-flight 缓存）。

## 原因

- 事件订阅若建在 `start()` 里而不是构造期，构造后到 start 之间的事件窗口就没人收；引擎只对 Agent 模式的运行做事件驱动收尾。
- `lessonKey` 每周重复，去重集合必须按自动化隔离并带 TTL，否则会误挡下周同一节课。
- 手动触发与定时触发是两条入口，若不共用同一个分派函数（`runDefinition`），语义必然漂移。

## 影响

- 历史停在「进行中」看着像 Agent 卡住，实际是事件没人收；误挡 = 该提醒的课静默没提醒。

## 结论与做法

- `apps/desktop/src/main/automation/engine.ts` 三处：① 事件订阅在**构造期**建立（`start()` 仍兜底补订阅，`stop()` 后可重新 start）；② `firedKeys` **按自动化隔离**、条目 **48h TTL** + 容量上限，集合只在内存；③ **手动触发与定时触发必须走同一条分派 `runDefinition`**。
- 自测夹具在启动后写盘时必须调 `automationEngine.reload()` 重读；`reload()` 清 `firedKeys` 并按历史重建当日 daily 键。
- 两种模式：**Agent Mode** 跑一次完整 Agent 会话（专属会话 id = runId = `auto-<ts36>-<n>`，`origin: 'automation'`）；**Normal Mode** 按封闭清单五件执行：系统通知 / ClassIsland 提醒 / 打开文件夹 / 打开网址 / 打开应用（没有命令、没有任意写）。定义与历史落在 `<userData>/automations/{automations.json,history.json}`（不是配置、不进迁移链；历史上限 500 条）。
- ClassRoom 的课前提醒 / 课前自动打开科目文件夹由内置自动化（`builtin.pre-class-notify` / `builtin.pre-class-open-folder`）承接，行为逐字保留；旧 `PreClassReminder` 服务已删除，`schedule.ts` 的 `preClassTrigger` / `needsNextDayLessons` 纯函数仍在（前者当前仅测试引用）。
- `auto-` 前缀会话**不进主界面左栏**（只从「自动化 → 历史」进入）；其确认卡走**既有确认链**，无人值守时 60s 超时按拒绝处理。自动化**没有自己的权限体系**，也**不应用勿扰时段**（勿扰只门控内置自动化 / 既有课前提醒）—— 免打扰走权限档设 `auto` 或会话内「本会话都允许」，不要新增静默放行通道。
- `automations.*` 整组在 `SETTINGS_READONLY_PREFIXES`；AI 只能经 `automation_list/create/update/delete/run/history` 六件套增删，写类四个是 `confirm`。
