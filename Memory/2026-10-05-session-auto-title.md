---
date: 2026-10-05
title: 会话自动标题是异步侧链路，不能阻塞回复或回填旧会话
tags: [会话, 模型, 工具, 坑]
source: 模型自动记录
---

# 会话自动标题

## 现象

- 首个用户需求发出后，主进程异步复用**该会话当前模型**生成 6–14 字任务标题，写入 `sessions/<id>.json` 的 `meta.title`；成功后经 `chat:sessionTitleChanged` 原位更新左栏与主区，不新增聊天消息、不切换会话、不计 `meta.usage`。
- 没有 `meta.title` 时仍回退「首条用户消息前 24 字」；生成失败静默保留回退标题并保留 `meta.titleState: 'pending'`，后续用户发送时重试。
- `awareness-` / `auto-` / `-sub` 后台会话不生成；升级前的旧会话没有 pending 标记，**不批量回填**。
- `SESSION_FILE_VERSION = 7`，title / titleState 都是可选字段、无迁移脚本。

## 原因

- 标题是侧链路：生成请求与主回复并行，不能阻塞回复。
- 空会话不落盘是既有不变量：`markTitlePending` / `setTitle` 在消息数组为空时只更新 `metaCache`，等首条消息 `append` 时一起落盘。

## 影响

- 标题事件可能早于助手回复，界面不能拿它判断一轮是否结束。
- 空会话改标题时若只靠 `scheduleWrite` 失效缓存，`chat:sessions` 会在这段窗口继续返回「新会话」，与刚推送的标题打架。

## 结论与做法

- 保持「空会话只改内存标题、不先写空文件」；标题事件只用于原位更新。
- 空会话改标题也必须失效 `summaryCache`（`markMetaDirtyIfPersistable` 里先 `delete`，再判断是否落盘）。
- 不做旧会话批量回填；失败保留 `pending` 供下次发送重试。
- 验证：`SessionStore` 覆盖 title 优先 / pending / 防删除复活，`session-title.test.ts` 覆盖模型选择 / 并发去重 / 失败重试 / 后台会话排除；冒烟 263/263、全量截图 113。
