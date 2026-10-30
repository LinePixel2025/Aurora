---
date: 2026-10-17
title: Agent 循环的任务编排：并发批次、插话注入、工具超时与 job 账本
tags: [agent-core, 工具, 会话, 坑]
source: 模型自动记录
---

## 现象

- 同轮多工具改成「谁先跑完谁先回填」后，真机报 `assistant(tool_calls)` 与各 `tool` 消息配对链断裂（网关直接 400），渲染层工具卡顺序也会抖。
- 运行中插话若按排队那条自己的 `requestId` 广播，渲染层 `useChat` 会按 `activeRequest` 过滤整条丢掉，「排队中」气泡永不消失。
- 工具挂起没有墙钟兜底时，一次卡住的调用会把整轮 agentLoop 拖死。
- `JobPanel.vue` 一直渲染 `job.todos`，内核却曾没人写这个字段：面板清单永远空着、且没有任何报错。

## 原因

- `tool` 消息的**追加顺序**就是回给模型的结果顺序，与并发完成顺序无关地必须等于模型写下的调用顺序。
- 注入发生在**正在跑的那次请求**内部，事件归属就必须是那个 requestId；界面排队气泡靠既有文本对账（`matchUserMessageEcho`）转正，不需要新 id。
- 默认超时只该兜「真挂起」；自带预算的长工具（`office_render` 120s、`ask_user` 180s、`run_command` ≤300s、`generate_image` 120s、`web_fetch` 20s）再叠一层计时器只会让归因变模糊。

## 影响

- 并发结算写错 → 配对链断裂、整个请求 400；插话归属写错 → 用户看着话发出去了，界面从此再无反应。
- 超时抢跑 → 正常长任务被误杀；`todos` 没人填 → 任务时间线缺一块且静默。

## 结论与做法

- **同轮并发只改起跑时机，不改落盘顺序**：`ToolDefinition.parallel` 显式 opt-in；两道硬闸门在 `isParallelEligible`（`agentLoop.ts:881`）——`confirm` 级永不并发、非 parallel 调用是串行屏障（「读 → 写 → 再读」仍按模型顺序）。结构是两段：整批发 `running` + 并发跑，再按原始下标结算（`updateToolCall` → tool 事件 → append → 收图片）；**不做跨批次重排**。默认 `DEFAULT_MAX_PARALLEL_CALLS = 8`。
- **插话只有一个注入点**：队列在 `KernelAgentHost.pending`（按会话、仅内存）；`AgentLoopOptions.takePendingInput` 在轮次边界取队首，排在游标落盘之后、预算判定之后、且只在确实还会进下一轮时；`flushPending` 在 `run()` 的 `finally` 补发（沿用队首 requestId）。取队首前校验 `active.get(sessionId)?.requestId === requestId`（`agentHost.ts:971`）；`abort()` 同时清队列；带 `resumeJobId` 的续跑与 `/compact` 仍回 `E_BUSY`。
- **工具级超时只兜真挂起**：`DEFAULT_TOOL_TIMEOUT_MS = 600_000`，`ToolDefinition.timeoutMs` 覆盖、`0` = 不限；实现是 per-call `AbortController`（先 abort 再 reject，`run_command` 据此杀进程树），必须挂 `running.catch(() => undefined)`；`task` 子代理显式 `timeoutMs: 0`。不做设置项，故不走 `CONFIG_VERSION`。
- **job 账本**：`todos` 的唯一来源是装配层注入的 `KernelAgentHost.jobTodos(sessionId)`（`main/index.ts:2027`，与 `todoSummary` 是同一份数据的两种形状），每轮随游标写一次（`agentHost.ts:943`）；端口未注入 / 抛错沿用上一份并 warn，清单被合法清空则如实落空表。`stepsDone` 上限 `MAX_JOB_STEPS = 200`（`jobs/types.ts:27`），`cursor.nextRound` 不受修剪影响；续跑把 job 的 `maxRounds` 刷成当前生效值。`AgentJobStatus` 的 `queued` 仍不产生（插话队列不是 job）。
- **`agent.loop` 只剩 `maxParallelCalls`**（1–32、默认 8，`schema.ts:980`）：轮次上限回到内核常量 `RUNAWAY_MAX_ROUNDS = 512`，token 只统计不限制（`budget` 只剩 `usedTokens`），`SUBAGENT_MAX_ROUNDS = 32` 单独一个常量。**v34 已删 attempt 循环与 `autoContinueRounds`**，「提问已在 history 里」的语义由「续跑前重读会话」接管。
- 冒烟造 `paused` 用 `AURORA_SMOKE_MAX_ROUNDS`（装配处只在 smokeMode 下读），别为测试往生产配置加旋钮。
