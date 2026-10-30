---
date: 2026-10-18
title: 子代理多实例并行、写入串行与实际授予
tags: [agent-core, 工具, 权限, 测试, 坑]
source: 模型自动记录
---

## 现象

- 只把 `task.parallel` 改成 true，同轮 8 个 `task` 会同时烧 8 条完整模型循环。
- 两个写子代理会交错「读 → 改 → 写」同一文件；渲染层敏感确认是**单槽位**（`App.vue` 的 `sensitiveRequest`），同时弹两张会互相覆盖，内核等回执只能等超时。
- 旧实现 `writeGranted = 请求了 write && 有确认回调`：只读档父表根本不注册 `write_file` / `edit_file`，快照却写 `permission: 'write'`、UI 徽章显示「可读写」——说假话且无降级说明。
- 排队中的父请求被取消时，可能还悄悄起跑一个子代理，或占着槽位不放。

## 原因

- 一个子代理 = 一条完整模型循环，并发度必须另有上限；该上限是防失控常量（与 `RUNAWAY_MAX_ROUNDS` 同类），不是用户按任务调的工作量旋钮，进配置就要走迁移链。
- 限流器若跟着工具实例走，装配层每次 `settings:changed` 重建工具表后，旧实例里还在跑的子代理与新实例各有一份额度，同会话实际并发超过上限。
- 写锁必须覆盖**整段子循环**而不只是写工具：交错读改写会破坏「读前守卫 / 唯一性检查」的假设。
- 只读档父表没有写工具 → `permission: 'write'` 只能是**请求**，实际授予要看子表里到底有没有写工具。

## 影响

- 并发不设限 → 单轮烧满模型调用；只锁写工具 → 交错覆盖文件、确认卡互相顶掉。
- 授予口径写错 → 快照与徽章说假话，用户以为子代理能改文件、结果只读跑完。

## 结论与做法

- **并行与限流**：`task` 声明 `parallel: true`，复用内核同轮并发批次；模块级限流器 `tools/subagent-limiter.ts` 按**父会话**限 `SUBAGENT_MAX_PARALLEL = 3`、FIFO 排队（超出的不丢弃、不改序）。外层 `agent.loop.maxParallelCalls` 仍是更外层的上限。限流器放**模块级**、不进 `createTaskTool` 实例；单测通过 `TaskToolOptions.limiter` 注入独立实例隔离。
- **写入整段串行**：实际授予了写工具的 `task` 在限流器里额外拿写锁（同一父会话最多 1 个写子代理），从拿到槽位到子循环结束都占着；只读子代理不受影响。FIFO 是刻意保序（写请求排在队首会挡住后面的读，防写在持续读流量下饥饿），换公平性要先设计配额。
- **授予看子表实际工具**：先按父表过滤 + 写白名单 + `subagentToolNames` 交集构造子表，再以「`grantedTools` 里真的有 `write_file` / `edit_file`」判定 `writeGranted`（`task.ts:296`）。两种降级分别说明：① 没接确认链 →「装配层未接入确认链，本次已按只读执行」；② 当前权限档 / 白名单没给写工具 →「当前权限档未提供写工具，本次按只读执行」。快照 `permission` 按实际结果落 `read`，UI 徽章同源。
- **`subagentToolNames` 是内核预留钩子，生产装配当前未注入**（`task.ts:279`）：只读档安全靠「父表不注册写 / 执行工具 + 实际授予判定」，别把它当已生效的额外闸门。
- **abort 与排队**：`acquire` 必须 abort-aware —— 排队中被父请求取消返回 `undefined`，`task` 回「父请求已取消，子代理未启动」的 `isError` 结果；运行中取消由子循环 `signal` 收尾，`finally` 释放写锁 / 槽位；release 幂等，最后一个 release 后清理该会话状态。
- **测试口径**：并发只断言 `maxActive` 同时计数，别断言「快了点」；`createFakeProvider` 全是微任务会让 `maxActive` 恒 1，需可门控（gated）provider 或 `Promise.race([barrier, timeout])`；冒烟里 `tool` 事件是 running + success 两条 / 卡，统计 task 卡按 `state === 'success'` 数（事件总数会得到 4 而不是 2）。
- 子代理工具表永远没有 `task` / `mcp.*` / `ask_user` / `run_command`，也没有独立 `model` / `effort` / 工作目录；渲染层确认单槽位改数组仍未做。
