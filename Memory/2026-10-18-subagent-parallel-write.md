---
date: 2026-10-18
title: 子代理多实例并行、写入串行与实际授予（多子代理/并行/可写）
tags: [agent-core, 子代理, 并发, 写权限, 确认链, 测试, 口径, 坑]
source: 模型自动记录
---

# 子代理多实例并行、写入串行与实际授予

本轮把 `task` 从「单实例、串行」推进到「同轮可多实例并行、写入串行」。四条硬约束，
改 `task` / 循环并发 / 写权限之前先读完。

## 1. 并行不是把 `task.parallel` 改成 true 就完了

**做法**：`task` 声明 `parallel: true`，复用 v34 的同轮并发批次；新增模块级限流器
`tools/subagent-limiter.ts`，按**父会话**限制 `SUBAGENT_MAX_PARALLEL = 3`、FIFO 排队。
超出的不丢弃、不改序；外层 `agent.loop.maxParallelCalls` 仍是更外层的上限。

**为什么不能只声明 parallel**：一个子代理 = 一条完整模型循环；同轮 8 个 `task` 会同时烧 8 条
模型调用。上限做成内核常量（与 `RUNAWAY_MAX_ROUNDS` 同类），不做配置项 —— 它不是用户按任务
调的工作量旋钮，进配置就要走迁移链。

**限流器放模块级、不进 `createTaskTool` 实例**：装配层每次 `settings:changed` 都重建工具表；
限流器跟着实例走会让旧实例里还在跑的子代理与新实例各有一份额度，同会话实际并发超过上限。
单测通过 `TaskToolOptions.limiter` 注入独立实例隔离。

## 2. 写入必须**整段串行**，不能只锁写工具

**做法**：实际授予了写工具的 `task` 在限流器里额外拿写锁（同一父会话最多 1 个写子代理），
从拿到槽位到子循环结束都占着；只读子代理不受影响。

**两个原因**：
1. 两个写子代理会交错「读 → 改 → 写」同一文件（读前守卫、唯一性检查都建立在“这次读之后
   没人动过”的假设上）；
2. 渲染层敏感确认是**单槽位**（`App.vue` 的 `sensitiveRequest`，“主进程同一时刻最多推一条”）。
   两个写子代理同时弹确认会互相覆盖，内核还在等回执，只能等超时。
   主循环里的 confirm 工具本就永不并发（`isParallelEligible` 的第二道闸门），这条是同一口径
   在子代理层的延伸。

跨会话的敏感确认单槽位问题**没有**在本轮修（属于既有边界）；要并发写就必须先把确认卡片改成
`ask_user` 那样的数组，否则别放宽写锁。

## 3. `permission: 'write'` 只是请求，授予要看**子表里有没有写工具**

**坑**：旧实现 `writeGranted = 请求了 write && 有确认回调`。只读档父表**根本不注册**
`write_file` / `edit_file`，于是子代理一个写工具都没有，快照却写 `permission: 'write'`，
UI 徽章显示「可读写」—— 说假话，而且结果里没有任何降级说明。

**做法**：先按父表过滤 + 写白名单 + `subagentToolNames` 交集构造子表，再以
「`grantedTools` 里真的有 `write_file` / `edit_file`」判定 `writeGranted`；两种降级分别说明：
① 没接确认链 →「装配层未接入确认链，本次已按只读执行」；
② 当前权限档 / 白名单没给写工具 →「当前权限档未提供写工具，本次按只读执行」。
快照 `permission` 按实际结果落 `read`。

**另一个文档坑**：`subagentToolNames` 是内核预留钩子，**生产装配（`main/index.ts` →
`registerAgentCoreTools`）当前并没有注入**。只读档安全靠「父表不注册写/执行工具 + 实际授予
判定」，不要以为还有一道额外交集闸门。旧 docs/06 §19.2 写成“装配层注入”，本轮已更正。

## 4. abort 与排队：acquire 必须 abort-aware，release 必须在 finally

- 排队中被父请求取消：`acquire` 返回 `undefined`，`task` 直接回「父请求已取消，子代理未启动」
  的 `isError` 结果 —— 不能在取消后还悄悄起跑一个子代理，也不能占着槽位等。
- 运行中取消：既有子循环 `signal` 收尾（部分结果），`finally` 释放写锁/槽位。
- release 幂等；最后一个 release 后清理该会话状态，避免长进程里按会话累积。
- FIFO 是刻意保序：写请求排在队首时会挡住后面的读请求（防写在持续读流量下饥饿），
  代价是极端情况吞吐下降；换公平性要先设计配额，别随手改成“读可越过写”。

## 5. 测试口径（这轮踩到的）

- 并发只断言 **`maxActive` 同时计数**，不要断言“快了一点” —— 后者随机器负载抖。
- `createFakeProvider` 全是微任务，两个 task 用例里第一条会在第二条之前跑完，测出来的
  `maxActive` 恒 1；要用**可门控（gated）provider** 把请求按住，或加有界的
  `Promise.race([barrier, timeout])`。串行用例靠 `holdMs` 让并发 bug 暴露成 `maxActive=2`。
- 冒烟的多子代理靠桩服务首轮 **180ms 延迟**制造重叠窗口；断言是“两个 running 的首个事件
  下标都早于对方的终态下标”，不是墙钟。串行实现会变成 A 完成之后 B 才开始。
- 冒烟里 `tool` 事件是「running + success」两条/卡，统计 task 卡要按 `state === 'success'` 数，
  不要数事件总数（会得到 4 而不是 2）。
- 事件缓冲仍只合并**队尾同 key** 的进度：两个子代理交错上报时合并率下降，但每个 `subagent`
  事件是当前快照，渲染层按 `callId` 归位即可；不要为此引入跨 key 重排（顺序不变量更贵）。

## 6. 文档/数字

- `docs/README` 状态段是“当前状态”，可以写 HEAD 未发版；历史 release-notes 里的
  “2574 用例 / 204 冒烟”等是**发布当时的事实**，不要回写。
- 本轮实测：冒烟 **206/206**（基线 203 + 3 条多子代理断言）；单测 **174 文件 / 2602 用例**
  （基线 173 / 2591，+1 文件 / +11 用例；另 `agentLoop` +1）；`verify-p1` 26/26（version=34，迁移 34/34）。
- 窗口截图：本机全量单轮会在 `onboarding-done` 卡死（onboarding 窗口被完成流程隐藏后
  `capturePage()` 不返回，与 `CHAT_COLLAPSE_CHECK` 注释同款坑）；验收改用三轮覆盖全量 94 条：
  `AURORA_CAPTURE_WINDOWS='edge-bar,chat,settings,automation'`（85 checks，仅 `chat-model-picker` 红）
  + `AURORA_CAPTURE_ONLY='onboarding'`（6 checks 全绿）+ `AURORA_CAPTURE_WINDOWS='memory,awareness-glow'`
  （3 checks 全绿）。**别把这个环境坑归因到本轮改动**。
- 回填前先跑，不要抄旧数字：`docs/README`、根 `README`、`AGENTS`、`docs/07` 探针文案里都曾有
  陈旧值（v0.4.0 / 2400 / 182 / 204 / 88 等）。

## 7. 本轮明确不做

递归派生（子代理工具表仍无 `task`）、独立 `model·effort`、`run_command` / MCP / `ask_user`、
独立工作目录；多级编排需要单独设计。渲染层确认单槽位改数组也不在本轮。
