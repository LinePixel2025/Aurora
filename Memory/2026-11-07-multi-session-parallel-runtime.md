---
date: 2026-11-07
title: 多会话并行：渲染层必须按会话保存运行态，单槽位状态会丢后台进度与切换前的半段回复
tags: [agent, session, 并发, 渲染, IPC, 性能, 探针, capture, 桩 LLM, 坑, 口径]
source: 模型自动记录
---

# 多会话并行：会话级运行态与展示隔离

## 现象

用户一次给多个会话发消息（A 发完切 B 再发）时：

- 切回一个**仍在流式**的会话，主区只有后半段回复，甚至 done 之后还是半截；
- 后台会话的进度、完成 / 失败在主界面上完全看不见（左栏没有任何状态）；
- 两个会话同时触发敏感工具确认时，后到的卡覆盖先到的，先到的那张只能等 60s 超时按拒绝；
- 从流式中的 A 切到空闲 B 会误触发 TTS 自动朗读 B 的旧回复。

## 原因

`useChat` 只有一份「当前会话」状态（`messages` / `streaming` / `activeRequest` / `assistantId` /
`finishedRequests` / 排队草稿 / 子代理 / 用量），并且：

1. `chat:event` 是全窗口广播，但渲染层对 `event.sessionId !== 当前会话` **直接 return**；
2. `switchSession` 把上面那一整套清空再水合，而磁盘只有**轮末**才落整条回复 ——
   切回正在跑的会话时本地没有半成品，之后到达的增量只能建一条从中间开始的助手消息；
3. `paused / done` 后的自愈依赖「切走时本地正在流式」的标记，后台才开始的流不会打上它，
   半截回复就一直留着；
4. 敏感确认卡是单槽位 ref，而主进程 `ProactiveScheduler.pending` 允许多条并存；
5. 自动朗读挂在当前 `streaming` 的下降沿上，切会话也会制造下降沿。

## 影响

「多会话并行」在内核里本来就是允许的（`AgentHost.active` 按 `sessionId` 分桶），
渲染层单槽位会让它表现成"串味 / 丢内容 / 看不见后台进度"；用户会怀疑消息发错会话或回复被截断，
也会因为没有「停止」而无法处置后台任务。

## 结论与做法

1. **事件只归它自己的会话**：渲染层维护 `Map<sessionId, SessionRuntime>`（消息 / 流式 /
   在途请求 / 已完成请求集合 / 草稿 / 子代理 / 用量），当前会话只是投影。纯逻辑放在
   `apps/desktop/src/renderer/shared/composables/chatRuntime.ts`，`useChat` 只做接线。
   `finishedRequests` / `activeRequest` 的过滤必须**每会话一套**，切会话不清空。
2. **非当前会话也照常喂 reducer**（文本增量按帧缓冲里带 `sessionId`）—— 这是"切回正在跑的
   会话能看到完整前半段"的唯一来源。只有隐藏后台会话（`auto-` / `awareness-` / `-sub`）
   在不是当前会话时跳过，避免把大段正文常驻在 chat 渲染进程。
3. **`chat:sessions` 摘要新增 `running`**（主进程现取 `agent.isBusy`），只作运行态初值 /
   兜底（窗口创建前就开跑、渲染层重载）；**不要拿 false 反向覆盖本地事件已建立的状态**。
   该字段没有推送通道，实时状态必须靠事件流维护。
4. **切会话不搬状态**：只标记已读 + 强制 `chat:history` 水合并按消息 id 合并（本地流式状态
   优先、内容取更长）。收尾后的自愈只给「本地可能缺前半段」的会话做（标记 `resyncOnSettle`），
   **不要每次 done 都水合**：整表替换会触发 MessageList 的 `stick()`，把用户上翻的历史拽回底部。
5. **活动态独立于运行态**：`SessionActivity` 记 `running` / `unread` / `attention`，不随运行态
   LRU 淘汰丢失；左栏状态点与头部后台汇总都读它。周期收尾后防抖重拉 `chat:sessions` 对齐时间 / 排序。
6. **运行态有界**：最多 8 个，当前 / 流式 / 有暂停提示的永不淘汰；淘汰后切回由水合恢复。
7. **敏感确认卡必须是数组**（按 `confirmId` 逐张结算），与 `ask_user` 卡同一口径。
8. **自动朗读的下降沿要校验归属会话**：记录「进入流式时的 sessionId」，只有收尾的仍是当前会话才朗读。
9. **逐 token 事件里不要写同值的响应式字段**：`streaming = true`、`reasoningTargetId` 这类
   在 3 万 token 的会话里会每 token 触发一次 computed / 模板重算（2026-10-04 性能轮口径）。
   只在值真的变化时写；`lastTouchedAt` 之类无订阅字段可以照写。
10. **capture 探针的两个坑**（`chat-parallel-sessions`）：
    - act 在 `useCaptureStub` reload 后立刻跑时，「消息区为空」会假成立（历史还没水合），
      于是新会话没切过去、发送落进旧会话。要等**标题变成「新会话」**且消息区为空；
    - 「点了发送按钮」不等于发出去了：v-model 还没更新时 `send()` 会直接 return。
      以**用户气泡真的出现**为发送成功判据。
11. 并行场景的桩分流必须**内容寻址**（`PARALLEL_SESSION_MARKER`），不能用
    `chatRequests().length === 1` 的计数寻址 —— 并行会多发对话请求，计数分派会被顶掉
    （同 `BURST_MARKER` 的理由；另见 2026-11-07 的桩 LLM 计数寻址条目）。
