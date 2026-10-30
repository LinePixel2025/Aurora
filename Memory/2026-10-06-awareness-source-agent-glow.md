---
date: 2026-10-06
title: 自感知数据生命周期与流光队列
tags: [自感知, 流光, 坑, 口径]
source: 模型自动记录
---

# 自感知数据生命周期与流光队列

## 现象

- 源文件删除后旧实现只把笔记标成不可用，Markdown、索引与版本备份仍留在记忆库；已删源仍可能被 Agent 工具读到。
- 用户前台 Agent 正在长任务时，自感知仍并发调用后台模型，和前台抢模型 / token。
- 连续分析多个文件时，顶部流光在每个文件交接处淡出再淡入，像反复中断。
- 重置范围不清会误删用户文件，或留下 `awareness-*` 隐藏会话 / 旧用量；记录列表被过程态灌满。

## 原因

- `handleUnlink` 没有走「删除笔记文件 + 状态 + 索引 + 版本目录」的完整清库语义。
- Agent 事件流没有区分 `awareness-*` 后台会话与用户 / 自动化会话，自感知队列缺少忙态闸门。
- `processQueue` 收尾时先清 `current` / `analysisStage` 并广播 `idle`，下一项才延时启动；渲染层按 `stage` 决定 `active`，于是把文件交接解释成分析结束。
- 旧重置只清运行记录，不删笔记、队列、用量、版本备份或隐藏会话；记录把过程态和终态写进同一列表。
- 主进程的隐藏去抖挡不住渲染层透明度往返；按钮点击后焦点残留会让后续 Enter / Space 再触发上一次操作。

## 影响

- 陈旧记忆与隐私残留；前台与后台争资源；流光闪烁让用户以为分析被中断。
- 重置可能误删或看似没重置；过程记录淹没真实文件变化。
- 设置页按钮悬停位移 / 残留焦点会破坏操作可信度。

## 结论与做法

- 源删除：`removeNoteForSource` 同步删除对应 Markdown、状态项、`INDEX.md` 条目与 `versions/<noteId>/`；启动 `init` / `scanNow` 用 `reconcileMissingSources` 核对应用离线期间消失的源文件。监控根不可访问时只跳过核对，不误删全库。
- 忙态：`setAgentBusy` 只闸住 `processQueue` 启动，当前分析允许收尾、不中断在途；只忽略 `awareness-*` 会话，其他用户 / 自动化 Agent 请求存在时暂停，全部结束后自动续跑。
- 批次连续性：`processQueue` 收尾时只要队列仍有下一项且门控允许，就**先同步启动下一项，再决定是否广播空闲态**；只有批次真正结束或停在门控时才发 `idle`（`file-awareness.ts:826` 先 `processQueue()` 再 `emitChanged()`）。`queued` ≠ 可显示：首次排队尚未开始仍应隐藏。回归 `file-awareness.test.ts:273` 断言两文件之间不得出现 `idle` / `queued`。
- 幂等：`WindowManager.showAwarenessGlow()` 在窗口已可见且 bounds 未变时不做重复 `setBounds` / `showInactive` / 置顶，避免扰动原生合成面。
- 几何：定位用显示器 `bounds` 而非 `workArea`（有顶部任务栏 / 贴边停靠时两者不同），详见 `2026-10-16-awareness-glow-apple-spectral.md`。
- 截图：`AWARENESS_GLOW_SETTLE_ACT` 默认等 1100ms，必须先等入场完成再截图，否则可能得到全透明 PNG。
- 退场：`AWARENESS_GLOW_FADE_OUT_MS = 680`（`index.ts:6381`）后再 `hideAwarenessGlow()`；CSS 根过渡为 620ms / 760ms，旧的 560ms / 220ms 数字已作废。
- 重置：`resetAll` / `performReset` 只删除 Aurora 管理的笔记、`INDEX.md` 条目、队列 / 记录 / 最近使用 / 建议 / 用量 / 版本备份 / media 与 `awareness-*` 会话；保留配置、源文件与知识库中的无关文件。重置后恢复监听但用 `suppressNextRootScan` 跳过自动扫描，避免意外 Token 消耗。
- 记录：只写内容变化后的 `done` / `error` / `conflict`，删除源文件写 `skipped(delete)`；`observed` / `queued` / `analyzing` 与内容未变化不写记录，进度只走运行状态。旧状态加载时 `normalizeRecords` 也只保留终态。
- 按钮：`AppButton` 在鼠标点击 `event.detail > 0` 后 `blur()`，键盘激活保留正常焦点。旧「设置窗按钮悬停不位移」已被 `theme.css:800` 的 `.interactive:hover { transform: translateY(-1px) }` 推翻，别再照旧写。

> 2026-10-25 合并自 2026-10-06-awareness-reset-record-policy.md（原口径：重置与记录策略并入本条）
> 2026-10-25 合并自 2026-10-06-awareness-glow-batch-handoff.md（原口径：批量交接连续性并入本条）
