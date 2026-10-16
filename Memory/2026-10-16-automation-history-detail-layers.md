---
date: 2026-10-16
title: 自动化历史详略三层、auto- 会话只读放宽，与两处只在打包后暴露的坑
tags: [自动化, 历史, Center, UI, 探针, 坑, 口径]
source: 模型自动记录
---

# 自动化历史显示的详略分层与双端口径

## 现象

1. **点行展开的对话回放被追加在整条列表最下方**（100 条平铺），等于看不见；每次
   `automation:historyChanged` 推送还会 `runs=[] + detail=null` 整表重建，把正在看的回放冲掉。
2. **回放是纯文本倾倒**：`chat:history` 已经把 `toolCalls` / `reasoning` / `requestId` 送进渲染层，
   旧视图只渲染 `{{ message.content }}`，工具过程与思考全丢。
3. **Center 表里把裸 `sessionId` 当正文显示**，且 `v-else-if` 让「有 sessionId 的失败 Agent 记录」
   连失败原因都不显示；docs/13 §10 早就写了要回放，代码从没实现。
4. **`Cannot access 'H' before initialization`**（只在 `verify:web` 里出现，`pnpm typecheck` 全绿）：
   `AutomationsView` 的 `watch(clientId, …, { immediate: true })` 在 setup 期就调 `load()`，
   而 `load()` 新读到的分页常量声明在它**下面** → TDZ。
5. **表格里一枚按钮被撑成 720px 宽**（截图才看得见）：我给弹层写的 `.auto-detail { width: 720px }`
   被同行内 `class="ui-btn ui-btn--ghost auto-detail"` 的按钮命中 —— 与
   `Memory/2026-10-03-ui-style-and-copy.md` 的「scoped 不隔离同名类」是同一个坑，这次栽在自己新写的类上。

## 结论与做法

- **详略三层（两种模式同构）**：① 列表一行只放「一眼读得完」的字段（状态图标 / `HH:mm` /
  名称 / 触发上下文 chip / 状态 / 用时）；② 第二行小字放**派生摘要**；③ 点行**就地展开**明细。
  列表**按本地日期分组**（今天 / 昨天 / `10 月 12 日`，跨年补年份）+ 组标题 `position: sticky` 吸顶
  —— 时刻不再重复日期，坐标由分组给。
- **派生量落进运行记录，正文不落**（`AutomationRun` 新增 `triggerDetail` /
  Agent 的 `toolCallCount` + `summary` / Normal 的 `steps[]`）。Agent 的步数与结论
  **由引擎在既有事件订阅里累加**（`tool` 事件按 `call.id` 去重计数、`text` 事件按 `messageId`
  切段只留最后一段非空正文），**不回读会话文件**；`summary` 取首行、剥掉 Markdown 的
  `#` / 列表符号 / `*_\`>` 后截 90 字。消息正文仍然只在 `sessions/<id>.json`（docs/13 §12）。
- **Agent 回放两端都复用现成消息流，不新写精简版**：桌面 = `MessageList`
  （`streaming: false` + `latestTurnGroupable: true` + `:key="sessionId"` 走历史水合折叠态）；
  Center = `MessageStream` + `commands.ts` 的 `loadRunTranscript()`（造一个**只读** `SessionState`，
  不进 `activeSessionKey`、不收实时事件，`historyLoaded` 失败要回退否则重开永远空）。
  两端都因此白得 Markdown / 执行轨迹折叠 / 工具卡 / 子代理卡 / 图片。
- **`auto-` 会话对 Center 的放宽只到「读」为止**（`center/connector.ts` 前缀闸门）：
  额外放行 `session.history` + `session.readImage` 两条只读命令命中 `isAutomationSession()`；
  `session.list` 仍只列 `center-`（**不可枚举**，网页只能拿 `automation.history` 给的 id 定点读），
  `session-bridge.ts` 的实时事件转发**仍只走 `center-`**（运行的过程不出网），
  整组仍受 `center.allowRemoteSession` 闸门。别把这条放宽顺手扩到 `activate` / `input` / `abort`。
- **Normal「无详情层」口径作废**（docs/13 §11）：原口径「不展示具体操作」被实现成「什么都不给」，
  连失败原因都看不到；操作组件是封闭清单（§5），逐步结果没有额外隐私面，因此放开，
  capture 断言由 `normalClickable === 0` 翻成 `normalClickable >= 1` + `.step-item === 2`。
- **推送刷新要静默**：`historyChanged` → 重拉**当前页**（不清列表、不收起展开态），
  只把那条记录刷成终态。分页没有 `total` 字段（回执形状不变），「加载更多」按
  「这次没取满一页 = 到底了」判；`store.listRuns` 的 `limit = 0` 保留「全量」语义
  （引擎 `restoreDailyKeys` 依赖它），正数才钳到 `AUTOMATION_HISTORY_QUERY_CAP = 200`。
- **探针锚点换了**：`.detail-message` 随纯文本回放一起消失，新契约是
  `.day-head` / `.run-meta` / `.step-item` + `data-field="automation.replay"` /
  `automation.run-detail`（Center 侧 `data-panel="automation-run-detail"`）。
  `Memory/2026-10-05-automation-standalone-window.md` 里那句「保留 `.detail-message` 锚点」已按此更正。
- **两条通用防线**（本轮各栽一次）：① `watch(..., { immediate: true })` 回调里用到的任何
  `const` 都必须在它之前声明（同文件已有先例注释「watch 回调会重置它，须先声明」）——
  TDZ 只在打包产物里炸，`tsc` 看不见；② 新写一个语义类名前先 grep 全文件，
  别和已有类撞名（`.auto-detail` 撞车后**只有截图**能看出来）。
