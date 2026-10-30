---
date: 2026-10-16
title: 自动化历史：详略三层 + 吸顶 + 内层阻断
tags: [自动化, UI, 布局, 探针, 坑]
source: 模型自动记录
---

# 自动化历史：详略三层、吸顶与内层阻断

## 现象

- 旧历史把对话回放追加在 100 条列表最下方，等于看不见；每次 `automation:historyChanged` 还 `runs=[] + detail=null` 整表重建，把正在看的回放冲掉。
- 回放只是 `{{ message.content }}` 纯文本，工具过程与思考全丢；Center 表把裸 `sessionId` 当正文显示，`v-else-if` 让失败的 Agent 记录连原因都不显示。
- 吸顶的分组标题处「时间标识错乱」：滚到吸顶时「昨天」与行里的「20:27」叠字，底下的记录透出来，标题上方还露半条。
- 点回放里折叠的工具调用记录，整条记录被收起（用户描述为「关闭历史对话窗口」）。

## 原因

- 详略没有分层：列表、摘要、明细混在同一层，派生量又不在运行记录里，只能回读会话文件。
- `.day-head` 底色是半透明 `--glass-content`，吸顶时透出滚过去的行；组间距靠 `margin-top`（吸顶盒的外间距不算在定位盒里）、`.view-body` 又有 `padding-top: 16px` —— 吸顶按滚动区**内容盒**上沿对齐，顶部 16px 始终露记录。
- `.run-detail` 是 `.run-item` 里的一块，而整行挂着 `@click="toggleRow(run)"`；明细里任何点击都冒泡到行首把 `expandedId` 清空。Center 端明细是独立弹层、遮罩用 `@click.self`，所以没有这个问题。

## 影响

- 用户看不到回放内容、也看不到失败原因；推送刷新还会把正在看的现场冲掉。
- 吸顶叠字看着像花屏，实际是三条 CSS 缺陷叠在同一处。
- 内层点击收起记录会让人以为整个窗口被关了。

## 结论与做法

- **详略三层（两种模式同构）**：① 列表一行只放「一眼读得完」的字段（状态图标 / `HH:mm` / 名称 / 触发上下文 chip / 状态 / 用时）；② 第二行小字放派生摘要；③ 点行就地展开明细。列表按本地日期分组（今天 / 昨天 / `10 月 12 日`，跨年补年份）+ 组标题 `position: sticky` 吸顶。
- **派生量落进运行记录，正文不落**：`AutomationRun` 增加 `triggerDetail`、Agent 的 `toolCallCount` + `summary`、Normal 的 `steps[]`。Agent 步数与结论由引擎在既有事件订阅里累加（`tool` 按 `call.id` 去重、`text` 按 `messageId` 只留最后一段非空），**不回读会话文件**；`summary` 取首行、剥掉 Markdown 标记后截 90 字。正文仍只在 `sessions/<id>.json`。
- **Agent 回放两端复用现成消息流**：桌面 `MessageList`（`streaming: false` + `latestTurnGroupable` + `:key="sessionId"`），Center `MessageStream` + `loadRunTranscript()`（只读 `SessionState`，不进 `activeSessionKey`、不收实时事件；`historyLoaded` 失败要回退，否则重开永远空）。
- **`auto-` 会话对 Center 只放宽到读**：`connector.ts:725-730` 只额外放行 `session.history` + `session.readImage`；`session.list` 仍只列 `center-`（不可枚举），实时事件转发仍只走 `center-`，整组受 `center.allowRemoteSession`。别扩到 `activate` / `input` / `abort`。
- **Normal「无详情层」口径作废**：操作组件是封闭清单，逐步结果没有额外隐私面；capture 断言由 `normalClickable === 0` 翻成 `normalClickable >= 1` + `.step-item === 2`。
- **推送刷新要静默**：`historyChanged` 只重拉当前页，不清列表、不收起展开态；分页无 `total`，「这次没取满一页 = 到底」；`store.listRuns` 的 `limit = 0` 保留全量语义，正数才钳到 `AUTOMATION_HISTORY_QUERY_CAP = 200`。
- **吸顶三件套**：`.day-head` 用不透明 `background: var(--bg-raised)` + `border-bottom: 1px solid var(--border-subtle)`；`margin: 0`，间距全走 padding；`.view-body { padding: 0 var(--space-4) var(--space-4) }` —— **滚动容器顶部禁止 `padding-top`**，顶部留白由 `.day-head` 的上内边距给，「加载中 / 没有运行记录」两句提示补外边距。
- **明细必须内层阻断冒泡**：`.run-detail` 挂 `@click.stop`；同类「可点容器里再嵌可点块」都在内层阻断，别指望外层判 `event.target`。
- **夹具要能让列表真滚**：`seedAutomationFixture` 追加 16 条跨天 Agent 记录（4 个分组），**刻意不带 `sessionId`**（不可展开），让「点开第一条可回放记录」仍命中原来种下的那条，也不影响 `CHAT_AUTOMATION_NORMAL_CHECK`（数的是定义卡，不是运行记录）。
- 探针 `CHAT_AUTOMATION_HISTORY_ACT/CHECK`：明细里先点 `.trace-head` 再点 `.tool-head`，`automation.run-detail` 必须还在且 `.tool-card.open` 真开；`.day-head` 计算色 alpha 必须是 1；两个滚动位置各量「吸顶那条离滚动区上沿 ≤1px」；吸顶矩形内取 3 点做 `elementsFromPoint`，最上层必须是标题自己。ACT 里 `scrollTop = 90` 停在吸顶态（不滚起来拍不到）。
- 锚点契约：`.day-head` / `.run-meta` / `.step-item` + `data-field="automation.replay"` / `automation.run-detail`（Center 侧 `data-panel="automation-run-detail"`）；`.detail-message` 随纯文本回放一起删除。

> 2026-10-25 合并自 2026-10-17-sticky-day-head-and-nested-clickable-row.md（原口径：吸顶缺陷只作一次性修复记录、夹具只有 2 条记录/1 个分组——均已作废；规则本身保留在本条）。
