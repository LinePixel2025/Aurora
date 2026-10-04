---
date: 2026-10-05
title: 自感知建议执行必须先持久化新会话再激活
tags: [自感知, session, IPC, 坑]
source: 模型自动记录
---

# 建议执行的会话切换顺序

## 现象

点击文件自感知建议的 Agent 操作后，主界面没有切到刚创建的目标会话，或看起来切到了错误现场。

## 原因

旧顺序是 `createSession → presentSession(remoteActivate) → send`。`createSession()` 刻意不落空文件，
因此激活推送到达主界面时，目标 id 既不在磁盘会话列表里，也没有对应的历史可 hydrate；
列表补拉找不到它，界面只能停在原会话或被后续刷新拉到别处。

## 影响

用户明明点了执行动作，却看不到对应任务和后续流式回复，容易重复点击并创建多条会话。

## 结论与做法

- 建议执行顺序固定为：`createSession → persistEmptySession → presentSession → send`。
- `SessionStore.createSession()` 保持“不落空文件”的默认语义；需要外部先激活的新建路径显式调用
  `persistEmptySession()`。
- 回归护栏：`file-awareness-execute.test.ts` 断言调用顺序；
  `SessionStore.store.test.ts` 断言持久化后 `listSessions()` 已包含目标 id 且消息仍为空。
