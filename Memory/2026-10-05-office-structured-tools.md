---
date: 2026-10-05
title: Office 主路径改为结构化 worker，COM 只做显式兜底
tags: [office, worker, agent, snapshot, 坑]
source: 模型自动记录
---

# Office 专用工具

## 现象

旧 Work 模式把 DOCX / XLSX / PPTX 的创建与编辑交给 Agent 手写 PowerShell COM。弹窗、文件锁、
PowerPoint 可见性、残留 Office 进程和单线程套间都会表现为任务卡住；多步操作还会反复弹
`run_command` 确认卡。

## 结论与做法

- 新增 `office_read` / `office_create` / `office_edit`，并入 `COMPUTER_TOOL_NAMES`，共用
  `agent.tools.files.enabled`。`office_read` 是 safe，创建 / 编辑是 confirm；只读档只保留读取。
- 引擎固定在 `@office-open/docx|xlsx|pptx@0.14.6`，只在 `office-worker` utilityProcess 中动态
  `import()`；主进程不解析 Office，也不会因解析卡住事件循环。
- `office_edit` 默认另存 `<原名>-Aurora-<时间戳>.<扩展名>`；`overwrite: true` 才覆盖源文件，
  且必须先成功写一份二进制快照。快照端口新增 `bytes` 与 `origin: 'office_edit'`。
- worker 超时 / 崩溃不自动重试；目标文件只在 temp 校验可重新解析后原子替换。
- Work Mode 与 `skills/office-work` 必须把结构化工具列为首选。COM 只在用户明确要求旧格式、
  宏、复杂格式或结构化工具未覆盖的导出时作为手工兜底。

## 注意

- 不要让结构化工具在失败后自动改用 COM；这会恢复原来的卡死路径。
- `.doc/.xls/.ppt`、宏、复杂 SmartArt / 图表 / 动画和 PDF 导出不在首版承诺内。
- 原地覆盖受 `agent.snapshots.maxSnapshotBytes` 限制；普通 Office 文件应默认另存，避免
  因快照上限被拒。
