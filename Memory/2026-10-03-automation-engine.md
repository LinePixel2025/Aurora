---
date: 2026-10-03
title: 自动化引擎的三处接线与 auto- 会话的确认链
tags: [自动化, agent, 坑]
source: 模型自动记录
---

# 自动化引擎接线

## 现象

1. **历史永远停在 `running`**：`done` / `error` 事件落在「构造完成 → `start()` 之间」时没人接。
2. **两条内置自动化互相挡住**：它们共用同一个 `lessonKey`，而 `firedKeys` 用了同一个集合。
3. **手动触发落一条永远"进行中"的历史且从不调用 Agent**（v0.2.5 的 smoke 实测就是这个症状）：
   Agent 模式的定义没有 `actions`，而 `runNow` 只执行操作组件。
4. **自测夹具写盘后引擎不认**：引擎在 bootstrap 时就启动并**首读 store**（in-flight 缓存）。

## 原因

- 事件订阅建在 `start()` 里而不是**构造期**；引擎只对 Agent 模式的运行做事件驱动收尾。
- `lessonKey` 每周重复，去重集合必须**按自动化隔离**并带 TTL，否则会误挡下周同一节课。
- 手动触发与定时触发是两条入口，若不共用同一个分派函数（`runDefinition`），二者的语义就会漂移。

## 影响

- 历史停在"进行中"看着像 Agent 卡住，实际是事件没人收；
- 误挡 = 该提醒的课没提醒，而且是静默的。

## 结论与做法

- `apps/desktop/src/main/automation/engine.ts` 三处：① 事件订阅在**构造期**建立（不是 `start()`）；
  ② `firedKeys` **按自动化隔离**，条目 **48h TTL**；
  ③ **手动触发与定时触发必须走同一条分派**（`runDefinition`）。回归护栏在 `engine.test.ts`。
- 自测夹具在启动后写盘时必须调 `automationEngine.reload()` 重读（capture 的 `seedAutomationFixture` 就是这么用的）。
- 两种模式的分界别搞反：**Agent Mode** 触发后跑一次完整 Agent 会话
  （专属会话 id = runId = `auto-<ts36>-<n>`，`origin: 'automation'`）；**Normal Mode** 按预设操作组件执行
  （**封闭清单五件**：系统通知 / ClassIsland 提醒 / 打开文件夹 / 打开网址 / 打开应用，见 docs/13 §5 ——
  没有命令、没有任意写，这就是它与 Agent Mode 的安全分界；别照旧文档只数三件）。
- 定义与历史落在 `<userData>/automations/{automations.json,history.json}`（**不是配置**、不进迁移链；历史上限 500 条）；
  ClassRoom 既有的课前提醒 / 课前自动打开科目文件夹由**内置自动化**
  （`builtin.pre-class-notify` / `builtin.pre-class-open-folder`）承接，行为逐字保留
  （同一提前窗口 / 文案 / 勿扰 / `lessonKey` 去重），旧 `PreClassReminder` 服务已**删除**
  （`schedule.ts` 的 `preTrigger` / `needsNextDayLessons` 纯函数保留给条件评估用）；
  **自动分类不在迁移范围**（仍是独立管线）；`auto-` 前缀会话**不进主界面左栏**
  （只过滤展示，只从「自动化 → 历史」进入）。
- `auto-` 会话的确认卡走**既有确认链**：无人值守时 60s 超时按拒绝处理；自动化**没有自己的权限体系**，
  也**不应用勿扰时段**（勿扰只门控内置自动化 / 既有课前提醒）。
  给自动化会话免打扰的正路是把权限档设为 `auto` 或在会话里点「本会话都允许」——
  **不要**为自动化新增静默放行通道。
- `automations.*` 整组在 `SETTINGS_READONLY_PREFIXES`（AI 只能经 `automation_*` 六件套工具增删，写类四个是 `confirm`），
  见 `Memory/2026-10-03-settings-write-guards.md`。
