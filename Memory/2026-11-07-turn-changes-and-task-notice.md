---
date: 2026-11-07
title: 轮终改动卡片 + 任务完成提醒：主进程汇总、只在内存、点击跳会话
tags: [agent, UI, IPC, 快照, 提醒, 通知, 配置, 迁移, 探针, 冒烟, 口径]
source: 模型自动记录
---

# 轮终改动卡片 + 任务完成提醒（对齐 DSH，2026-11-07）

## 结论与做法

- **数据源在主进程，不在内核**：`AgentEvent` 形状不变。`main/index.ts` 的 `agent.onEvent`
  按 `requestId` 收集**已结算**的写文件工具调用（`write_file` / `edit_file` / `office_create` /
  `office_edit` / `office_raw_edit` / `office_pdf` 的显式 `outputPath`），在 `job.status === 'done'`
  时调 `main/turn-changes.ts` 的 `collectTurnChanges()` 汇总。
  - before = 本轮工具调用 id 命中的**最早** `SnapshotRef`（`exists:false` = 新建）；
    after = 轮末读一次盘（≤2 MiB）。同一路径多次写只列一条；内容相同不列。
  - 二进制（扩展名 / NUL）→ `binary`；超限 → `oversized`；没有快照 → `unknown`（**不假装 0 行**）。
  - 行数：先裁公共前后缀再 LCS（滚动数组）；超 4000 行 / 4M 单元格 / 150ms 退化为整文件替换。
    整轮 1s 预算，超时后剩余文件只列路径。
- **推送通道 `chat:turnChanges`**（主进程 → chat 窗口，on/off 成对）：payload
  `{ sessionId, requestId, files: ChangedFileInfo[] }`。**只在主进程与渲染层内存里**，
  不落 `sessions/*.json`、不进 Center 协议、重启即失 —— 与 DSH「Host 重启后旧轮次没有卡片」
  同款。渲染层在 `useChat` 模块级 Map 按 `(sessionId, requestId)` 缓存（≤200，触发一次版本自增），
  `MessageList` 只在该请求**最后一条** assistant 消息的正文/图片之后、朗读按钮之前渲染卡片。
- **卡片文案对齐 DSH 中文**：`已编辑 N 个文件` / `已编辑 <文件名>`、`+n` `-n`、`二进制`、`过大`、
  折叠 4 行 + `全部 N 个文件` / `收起`。行点击打开右栏「文件」标签预览
  （`FilePreviewPanel` 新 `openRequest: { path, token }` prop；`App.vue` 等一次 `nextTick` 再写，
  否则首次开标签时面板还没挂载，点击没反应）。
- **「任务完成」提醒**：`job.status === 'done'` 时组 `{ title: '任务完成', body: 会话标题+改动数 }`，
  走既有 `NotificationService`（默认提醒方式 / 去重 / 智慧提醒抑制闸全部复用），
  `dedupeKey = task-done:<requestId>`、`level: 'success'`、带 `sessionId`。
  `error` / 取消 / `paused` 不发。**v41 起可配置**（`CONFIG_VERSION = 41`，migration `v40 → v41`）：
  `notifications.taskDoneEnabled`（默认开）与 `notifications.taskDoneBackgroundOnly`（默认开 =
  主界面有焦点就不发）。判定抽成 `notifications.ts` 的 `shouldSendTaskDoneNotice(prefs, focused)`
  （纯函数、有单测）；焦点用 `windows.isFocused('chat')`。**smoke 下只记录不真投**且强制按
  「不在前台」跑（冒烟设置里把两个字段固定成 开 + 不限制），记录进 `SmokeDiagnostics.taskNotices`。
- **卡片视觉（同日第二轮，用户要求「明显一点」）**：独立卡片 = `--bg-raised` 表面 + 1px 边界 +
  **3px 强调色左描边** + 图标底块 + 主文本色标题 + 绿/红统计药丸 + 逐行状态图标 + 底部
  「点击文件在右侧预览」。probe 锚点（`chat.changed-files` / `.changed-files-label` /
  `chat.changed-file` / `.changed-files-more`）与折叠 4 行口径不变，改样式别动这些。
- **点击提醒跳会话**：系统通知 `click → NotificationService.handleClick(request)`（有 sessionId
  优先跳会话，否则旧 openPath）；流光卡片 → 新通道 `banner:activate`（invoke，`{ id }`）。
  主进程**只认当前展示中那一条**的 id，会话 id 从 `BannerService.currentSessionId()` 取
  （**不接受渲染层传会话 id**），先 dismiss 再 `bringToFront('chat')` + `wait whenLoaded` +
  `chat:remoteActivate`（与 Computer Use 收尾同一套顺序）。

## 踩点 / 口径

- **别把 `done` 事件当触发**：`abort()` 会立即补发一条不带原因的 `done` 结束 loading，
  按 `done` 发提醒会误报「任务完成」。要用 `job` 事件的终态（`done` 才发）。
- **IPC 契约**：`IPC.chat.turnChanges` 与 `IPC.banner.activate` 两侧通道表必须同步
  （shared `ipc/channels.ts` + preload `channels.ts` 的编译期双向断言）。
  `BannerServiceLike` 新增 `currentId` / `currentSessionId`，`createBannerNotifyPort` 的适配对象要补齐。
- **截图场景**：`chat-changed-files` 用**已归档会话** `chat-seed-archived` 当载体
  （不占主列表行，`chat:remoteActivate` 仍能切进去），主进程在 `prepare` 里推
  `remoteActivate` + `turnChanges`；探针是 **async IIFE**（`executeJavaScript` 会等 Promise），
  点展开 / 点行后要等两帧 rAF 才读 DOM，同步读会看到旧行数（首跑 expanded=false 就是这个）。
- **探针字符串不能写反斜杠**：本场景要 `requestAnimationFrame` 链，别用 `setTimeout` 的
  `\\d` 之类转义；`capture.probe-strings.test.ts` 会直接把模板截断。
- 子代理内部写入、`run_command` 间接改的文件**不列**（没有 git 依赖，DSH 那份能力不移植）。
