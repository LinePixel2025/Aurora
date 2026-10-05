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

## 后续修补（COM 挂起、编号与诊断）

- **COM 只保留显式兜底，且默认不给可照抄路径**：用户明确要求旧格式 / 宏 / 复杂格式后，
  才使用短超时（15–30s）、逐步 `AURORA_COM_STEP=` 标记和单实例脚本。Word 在
  `New-Object -ComObject Word.Application` 阶段可静默挂起：没有异常、没有输出、进程已起但目标
  文件未生成；此时按超时停止、不重试，并分别检查目标文件与 Office 残留进程。
- **禁止手写 OOXML / ZIP 降级**：只有 3 个部件的 docx 不是可接受的“简化版”，标题没有大纲级别、
  列表不是真实编号、PDF 导出链路也不可靠。结构化工具失败时如实报限制。
- **DOCX 结构化生成改为真实 Word 语义**：`heading` 落 `Heading1`–`Heading6`；
  `bullets` / `numbered` 落 `w:numPr` + `word/numbering.xml`（支持 0–8 级），不再写字面
  `•` / `1.`。模板占位符替换后追加内容改走“解析 → 追加 → 带编号定义重新生成”，避免向模板
  写入不存在的 `numId`；生成包保留 `styles.xml` / `numbering.xml` / `theme1.xml`。
- **命令编码与超时诊断**：PowerShell 前缀先 `chcp 65001`，再设
  `[Console]::OutputEncoding` / `$OutputEncoding`，原生命令中文也纳入回归测试。超时 / 取消
  结果明确说明已终止整棵进程树，空 stdout / stderr 不代表命令未开始执行。
- **stdout 中文不作校验依据**：即使 `[Console]::OutputEncoding` 已是 UTF-8，历史输出仍可能
  串码；Office 结果必须回读目标文件 / XML / 逐段解析确认。

回归基线：`pnpm typecheck`、`pnpm lint`、`pnpm test`（2439 条）、`pnpm build`、
Electron 冒烟 **183/183** 全绿；本次改动文件单独 `prettier --check` 通过。
