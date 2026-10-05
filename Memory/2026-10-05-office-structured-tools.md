---
date: 2026-10-05
title: Office 主路径改为包内 OfficeCLI，渲染与 PDF 走页面回看
tags: [office, worker, agent, snapshot, 坑]
source: 模型自动记录
---

# Office 专用工具

## 现象

旧 Work 模式把 DOCX / XLSX / PPTX 的创建与编辑交给 Agent 手写 PowerShell COM。弹窗、文件锁、
PowerPoint 可见性、残留 Office 进程和单线程套间都会表现为任务卡住；多步操作还会反复弹
`run_command` 确认卡。

## 结论与做法

- Office 工具面为 `office_read` / `office_help` / `office_create` / `office_edit` /
  `office_render` / `office_pdf` / `office_raw_edit`，共用 `agent.tools.files.enabled`。
  前三个 safe 工具在只读档保留；confirm 工具整件摘除。
- 引擎固定在包内 `OfficeCLI v1.0.153`（Windows x64，SHA256
  `05dd712595690672ea1c220a516c0996a27f7c3e7f870a270c19d538e9fc04f3`）。运行期强制关闭
  OfficeCLI 自动更新、自动安装、技能安装与 resident；不经 shell，不静默下载。
- `office_create/edit/raw_edit` 默认另存；覆盖先写二进制快照。写入目标是**保留正确扩展名**的
  同目录临时文件，先 OfficeCLI batch、再 `validate`，成功后原子替换；失败不改源文件。
- `office_read` 返回稳定元素路径；`office_help` 查询属性 schema；`office_render` 用
  HTML 渲染生成 PNG 并直接把图片回填给模型；`office_pdf` 逐页/逐表截图后用 `pdf-lib`
  合成栅格 PDF（文字不可选择）。OfficeCLI 没有内置 PDF exporter 插件，不能假装 `view pdf`
  可用。
- `office_raw_edit` 是唯一允许 raw XML 的独立 confirm 工具；普通 `office_edit` 禁止
  `raw` / `raw-set`，结构化失败后也不得自动降级到 raw 或 COM。

## 注意

- `.doc/.xls/.ppt` 与宏不在结构化写回范围内；高级图表 / 动画 / SmartArt 通过 OfficeCLI
  L2 属性和命令处理，raw XML 只走 `office_raw_edit`。
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

回归基线：`pnpm typecheck`、`pnpm lint`、`pnpm test`（2453 条）、`pnpm build`、
Electron 冒烟 **183/183** 全绿；本次改动文件单独 `prettier --check` 通过。
