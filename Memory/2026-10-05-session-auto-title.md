---
date: 2026-10-05
title: 会话自动标题是异步侧链路，不能阻塞回复或回填旧会话
tags: [session, title, agent, IPC, 坑]
source: 模型自动记录
---

# 会话自动标题

## 长期口径

- 首个用户需求发出后，主进程异步复用**该会话当前模型**生成 6–14 字任务标题，
  写入 `sessions/<id>.json` 的 `meta.title`；成功后经 `chat:sessionTitleChanged`
  原位更新左栏与主区，不新增聊天消息、不切换会话、不计 `meta.usage`。
- 没有 `meta.title` 时仍回退“首条用户消息前 24 字”；生成失败静默保留回退标题，
  并保留 `meta.titleState: 'pending'`，后续用户发送时重试。
- `awareness-` / `auto-` / `-sub` 后台会话不生成；升级前的旧会话没有 pending 标记，
  **不批量回填**。`SESSION_FILE_VERSION = 6`，title / titleState 都是可选字段、无迁移脚本。

## 两个必须保留的时序细节

1. **空会话只改内存标题，不先写空文件**：`markTitlePending` / `setTitle` 在消息数组为空时
   只更新 `metaCache`，等首条消息 `append` 时一起落盘；否则会破坏“空会话不落盘”的老不变量。
   这同时意味着标题事件可能早于助手回复，界面不能拿它判断一轮是否结束。
2. **空会话改标题也必须失效 `summaryCache`**：没有写盘排队时 `scheduleWrite` 不会跑，
   若只在那里失效缓存，`chat:sessions` 会在这段窗口继续返回“新会话”，
   与刚推送到界面的标题打架（本轮定向截图实测）。

## 验证

- `SessionStore` 覆盖 title 优先、pending、防删除复活；`session-title.test.ts` 覆盖模型选择、
  并发去重、失败重试与后台会话排除。
- 全量 Electron 冒烟 186/186；桌面全量 capture 86/86，
  `chat-auto-title.png` 断言左栏 / 主区 / 持久化标题一致且没有额外消息。
