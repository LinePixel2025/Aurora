---
date: 2026-11-07
title: 智慧提醒（v40）落地 + 冒烟桩 LLM 计数寻址坑：后台对话请求必须带专属标记走专属分流
tags: [智慧提醒, 提醒, 免打扰, 通知, 配置, 迁移, 流光提醒, banner, 冒烟, 桩 LLM, smoke-llm, 计数寻址, 坑, 口径]
source: 模型自动记录
---

# 智慧提醒（v40）与冒烟桩 LLM 计数寻址坑

## 结论与做法（功能口径）

- **抑制闸挂在 `NotificationService.notify()`**：去重之后、通道判定之前（`smartGate` 注入）。
  分类完成 / 课前提醒 / `notify_user` / 插件 `ctx.notify` / `system-notify` 全覆盖；
  显式流光（`notify_banner` / `ctx.banner`）与 `ask_user` 按既有语义边界**不抑制**。
- **「上课中」与课前提醒同源**：`schedule.ts` 的 `currentLesson(lessons, now)` 纯函数
  （`startTime ≤ now < endTime` 半开区间、背靠背取后一节），从 `IScheduleProvider.getToday()`
  推导；ClassIsland status 快照继续「只展示不触发」。
- **SmartReminderService**（`main/smart-reminder.ts`，纯逻辑全注入）：
  - `gate()` 是**同步**的，「上课中」用 evaluate 每拍刷新的**缓存**（课程表 provider 的异步不能拖 `notify()`）；
  - 边沿 = `active → 非active` 且队列非空即结算——窗口到点 / 被编辑 / 总开关被关语义统一；
  - 结算**先清队列再投递**（防重入结两次）；总结失败 / 关闭 / 返回空 → 逐条纯文本回落，**不丢提醒**；
  - `start()` 要补「跨重启遗留队列 + 当前不在免打扰期 → 立即结算」（边沿检测赶不上停机期间的出窗）；
  - 队列落盘 `userData/smart-reminder-queue.json`（上限 50 丢最旧，临时文件 + rename），损坏按空队列。
- **汇总投递必须跳过抑制闸**（`NotificationService.notifyDigest` → `deliver()` 共用路径），
  否则摘要自己也被抑制成环。`bannerDurationMs: 12_000` 只给汇总用（内容长，6s 读不完）。
- **设置页新字段保持扁平**（`notifications.smartEnabled` 等深度 2）：`WRITABLE_PATH_OVERRIDES`
  的 `notifications.*` 按段数匹配，嵌套子对象的叶子绕出通配；不过实测嵌套叶子也落进
  「Schema 叶子默认可写」第三层判定——覆盖表只是给黑名单前缀开口子，别把三层判定记混。
- **`smartWindow` 语义**：`start`/`end` "HH:mm"（复用 `isQuietHour` 跨天口径）+ `daily`（每天重复）
  + `armedDate`（`daily:false` 时仅当天生效，结算后服务自动清空）；取消勾选「每天重复」按今天重新武装。
- **v40 迁移**照 `migrateV37ToV38` 模板；`migrations.test.ts` 三处 applied 硬编码列表要同步（本次 +1 行）。

## 冒烟桩 LLM 计数寻址坑（本次最大的坑）

- **现象**：分支冒烟 276/281，红的五条全是 use_skill 链路（工具事件没了、卡片状态空、
  历史 2 条不是 3 条、续接 4 条不是 5 条）；main 复跑 273/273 全绿。
- **根因**：`smoke-llm.ts` 的默认对话分流按 **`chatRequests().length === 1` 计数寻址**——
  只有第 1 次对话请求才回 `use_skill` 工具调用。v40 的汇总器在 §2.5 结算时向桩发了一条
  **真实的对话请求**，把「第一次」的坑位吃掉；§9 对话链路于是拿到纯文本回复，
  工具事件一个都不发。事件序列对比是关键证据：
  绿 = `job>tool>tool>job>reasoning…`，红 = `job>reasoning…`（中间没有 tool）。
- **修法**（与 `session-title.ts` 的 `TITLE_PROMPT_MARKER` 同款口径）：
  汇总提示词首行带 `SMART_DIGEST_PROMPT_MARKER`；桩里 `isDigestRequest` 分流回固定摘要，
  并**像标题分流一样排除在 `chatRequests()` 与定型快照（recordedRequests）之外**。
  修后 281/281 全绿。
- **长期口径（已进 AGENTS.md 硬规则）**：主进程以后新增任何会向桩发对话请求的后台链路，
  必须带专属标记 + 桩专属分流 + 排除计数，否则冒烟 use_skill 那组断言必红。

## 顺带踩点

- **SettingField 的复选框是 16px**：截图探针量「可点尺寸」别写 ≥20/24（那是分段按钮的阈值）；
  复选框 ≥12、文本输入另量 ≥24 高。探针已把该判据写进注释。
- **总开关不能跟着子控件一起禁用**：智慧提醒区组 dormant 态里总开关自己必须可点
  （不然没法开启），探针判据要把它从「子控件已禁用」里摘出来单独断言 `enabledClickable`。
- **squash 合并后 `git branch -d` 必拒**（分支 tip 不是 main 祖先），内容确认合入后用 `-D`。

## 基线（2026-11-07 全量验收实测）

- `pnpm test` 215 文件 / **3061** 用例；`pnpm verify` **26/26**（`version=40`、迁移 **40/40**）；
- 冒烟 **281/281**（§2.5 智慧提醒 +6：默认值全关 / active / 抑制入队 / 不弹卡 / 结算出卡片 / 还原）；
- 截图三轮共 **118** 条 checks（新增 `settings-notifications-smart`），唯一恒红项仍是
  范围外的 `chat-model-picker.png`。
