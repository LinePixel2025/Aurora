---
date: 2026-10-06
title: 删除会话必须级联清理 todo，否则固定会话重建会复活旧任务
tags: [session, todo, IPC, 生命周期, 坑]
source: 模型自动记录
---

# 会话删除与 Todo 生命周期

## 现象

`main` 会话只发了一句“你好”，助手却主动询问是否继续一个“扫描 C 盘空间占用”的旧任务。
待办内容来自 `2026-10-02` 留下的 `todos/main.json`，而 `sessions/main.json` 已在
`2026-10-06` 重建为一轮新对话。

## 原因

- 每次请求都会把当前会话的 todo 清单注入 systemPrompt；模型只看到 `in_progress`，
  无法知道它属于已经删除 / 重建的旧会话。
- `chat:deleteSession` 原先只删 `sessions/<id>.json`，没有清理 `todos/<id>.json`。
- `main` / `quick` 是固定会话 id，删除后会复用；旧 todo 因此再次被读到并注入。

## 结论与做法

- `FileTodoPort.removeSession(sessionId)` 同时删除 `<sessionId>.json` 与
  `<sessionId>-sub.json`。
- 删除必须先取消防抖、清脏标记并排空在途写入，再失效加载 / 缓存并删文件；
  否则待写任务会把文件重新写回来。
- `chat:deleteSession` 顺序固定为：running job guard → 清理 todo → 删除 session → 广播。
  todo 清理失败时不删会话、不广播。
- 归档是可逆状态，不清理 todo；渲染层“清空消息区”只影响本地视图，也不清理后端 todo。

## 验证

- `todo-port.test.ts` 覆盖普通文件、缓存、防抖待写、在途写入和 `-sub` 文件删除。
- Electron smoke 覆盖真实 `chat:deleteSession` 的级联清理与事件顺序。
