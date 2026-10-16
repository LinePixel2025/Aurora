---
date: 2026-10-17
title: 吸顶分组标题的三条硬约束（滚动区上内边距 / 不透明底 / 无外间距）与「明细嵌在可点行里」的点击冒泡
tags: [自动化, UI, 布局, CSS, 探针, 夹具, 坑]
source: 模型自动记录
---

# 自动化历史的吸顶日期标题 + 明细里的点击冒泡

两个用户报的界面问题，根因互不相干，但都出在 `AutomationHistoryView.vue`（自动化独立窗口的运行历史）。

## 现象

1. **吸顶的分组标题处「时间标识 ui 错乱」**（用户附截图）：滚到分组标题吸顶时，标题的
   「昨天」与行里的「20:27」叠在一起、底下一整条被压住的记录透出来，看着像花屏；
   标题上方还露出上半条记录。
2. **点回放里折叠的工具调用记录 → 整条记录（对话回放）被收起**，用户描述为「关闭历史对话窗口」。
   实际上不是窗口关了，是那一行被收起了（回放块消失）。

## 原因（都实测过，不是推断）

1. 三条独立缺陷叠在同一处：
   - `.day-head` 的底色原来是 `--glass-content`（`rgba(18,18,21,0.54)` / 浅色档 0.64）——
     **半透明**，吸顶时从它底下滚过去的行会透出来，与标题文字叠字；
   - 标题原来靠 `margin-top` 拿组间距 —— **吸顶盒的外间距不算在定位盒里**，标题上方那条缝
     不上色，记录从缝里露出来；
   - **滚动容器（`.view-body`）的上内边距会把整条吸顶线一起往下顶**：实测容器
     `padding-top: 16px` 时，浅处（首组内）与深处（列表中部某组内）量到的吸顶位置
     **都是「离滚动区上沿 16px」**（`headGaps = { shallow: [16, …], deep: [16, …] }`）。
     即吸顶是按滚动区**内容盒**上沿对齐的，容器上边距内的 16px 会一直露着记录。
     把 `.view-body` 的上内边距拿掉后立刻 `headGap = 0`。
2. `.run-detail`（明细 / 回放）是 `.run-item` 里的一块，而**整行挂着 `@click="toggleRow(run)"`**
   —— 回放里任何一次点击（开合轨迹、点开一条工具行）都冒泡到行首，`expandedId` 被清成 null，
   于是「一点工具记录，回放就没了」。桌面端有这个问题，Center 端没有（那边明细是独立弹层，
   遮罩用 `@click.self`）。

## 结论与做法

- **吸顶标题三件套**（`.day-head`）：`background: var(--bg-raised)`（不透明、与面板材质同一色系，
  且在任何降级分支里本就等于面板色）+ `border-bottom: 1px solid var(--border-subtle)`；
  `margin: 0`，间距全走 padding（padding 跟着底色一起被盖住）。
- **滚动容器顶部不留白**（`.view-body { padding: 0 var(--space-4) var(--space-4) }`）：
  顶部留白改由 `.day-head` 的上内边距给；「加载中… / 还没有运行记录。」两句提示补上外边距
  （`.feedback` 与 `.view-body > p.tiny`）。别再往吸顶容器上写 `padding-top`。
- **`.run-detail` 上 `@click.stop`**：明细不是行首的一部分，明细里的交互不许冒泡到行首。
  同类结构（可点容器里再嵌可点块）都要在**内层**阻断冒泡，别指望外层判 `event.target`。
- **夹具要能让列表滚起来**：`seedAutomationFixture` 追加 16 条跨天 Agent 记录（4 个分组），
  **刻意不带 `sessionId`** —— 不可展开，因此「点开第一条可回放的记录」仍命中原来种下的那条；
  条数也不影响 `CHAT_AUTOMATION_NORMAL_CHECK`（它数的是定义卡，不是运行记录）。
  此前只有 2 条记录、1 个分组，**列表根本滚不动**，吸顶路径截图与探针都覆盖不到，坑才漏到用户手上。
- **探针（`CHAT_AUTOMATION_HISTORY_ACT/CHECK`）新增 4 条**：① 明细里先点 `.trace-head`、
  再点 `.tool-head`，两步之后 `[data-field="automation.run-detail"]` 必须还在、且 `.tool-card.open`
  真的开出来了（这就是「点了折叠行会收起记录」的回归护栏）；② `.day-head` 计算色 alpha 必须是 1；
  ③ 两个滚动位置（浅 200 / 深 `scrollHeight/2`）各量一次「吸顶那条离滚动区上沿 ≤ 1px」；
  ④ 吸顶矩形内取 3 点做 `elementsFromPoint`，最上层必须是标题自己。ACT 里加一次
  `scrollTop = 90`，截图停在吸顶态（不滚起来拍不到）。
- **`capture.ts` 的探针字符串不能写反斜杠正则**：模板字面量里的 `\(` 会被 ESLint
  `no-useless-escape` 判错（lint 直接红，`tsc` 不拦）。解析计算色改成
  `slice(indexOf('(')+1, indexOf(')')).split(',')` —— 与文件头那条「能不用带反斜杠的正则就别用」同源。
- 已验证：`pnpm typecheck` / `pnpm lint` / `pnpm test`（2574 全绿）通过；定向截图
  `AURORA_CAPTURE_ONLY='automation'` 4/4 绿（含深色档 `AURORA_CAPTURE_THEME=dark` 目视确认
  吸顶条压在记录上、无叠字）。全量 capture 未跑（按 2026-10-10 的迭代期预算）。
