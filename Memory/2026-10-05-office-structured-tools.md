---
date: 2026-10-05
title: Office 主路径改为包内 OfficeCLI，渲染与 PDF 走截图回填
tags: [工具, Windows, 权限, 坑]
source: 模型自动记录
---

## 现象

- 旧 Work 模式把 DOCX / XLSX / PPTX 的创建与编辑交给 Agent 手写 PowerShell COM：弹窗、文件锁、PowerPoint 可见性、残留 Office 进程和单线程套间都会表现为任务卡住，多步操作还会反复弹 `run_command` 确认卡。
- 结构化工具失败后若自动降级到 raw XML 或 COM，源文件可能被改坏。

## 原因

- COM 没有稳定契约：`New-Object -ComObject Word.Application` 阶段可静默挂起（无异常、无输出、进程已起但文件未生成）。
- 手写 OOXML / ZIP 不是「简化版 docx」：标题没有大纲级别、列表不是真实编号，PDF 导出链路也不可靠。

## 影响

- 误用 COM 主路径 = 任务卡住 + 残留进程 + 反复弹确认；自动降级 = 源文件被不可逆改写；只做 ZIP 拼装 = 生成物格式全丢。

## 结论与做法

- Office 工具面为 `office_read` / `office_help` / `office_create` / `office_edit` / `office_render` / `office_pdf` / `office_raw_edit`（`office.ts:11-17`），共用 `agent.tools.files.enabled`；前三个 safe 工具在只读档保留，confirm 工具整件摘除。
- 引擎固定在包内 **OfficeCLI v1.0.153**（Windows x64，SHA256 `05dd712595690672ea1c220a516c0996a27f7c3e7f870a270c19d538e9fc04f3`，`index.ts:611` / `scripts/fetch-officecli.mjs:9`）；运行期强制关闭自动更新 / 自动安装 / resident，不经 shell、不静默下载。
- `office_create/edit/raw_edit` 默认另存；覆盖先写**二进制快照**，受 `agent.snapshots.maxSnapshotBytes` 限制。写入目标是保留正确扩展名的同目录临时文件，先 OfficeCLI batch、再 `validate`，成功后原子替换；失败不改源文件。
- `office_read` 返回稳定元素路径；`office_help` 查属性 schema；`office_render` 用 HTML 渲染生成 PNG 并直接回填图片给模型；`office_pdf` 逐页 / 逐表截图后用 `pdf-lib` 合成**栅格 PDF，文字不可选择**（OfficeCLI 没有内置 PDF exporter，不能假装 `view pdf` 可用）。
- `office_raw_edit` 是唯一允许 raw XML 的独立 confirm 工具；普通 `office_edit` 禁止 `raw` / `raw-set`，结构化失败后也不得自动降级到 raw 或 COM。
- `.doc/.xls/.ppt` 与宏不在结构化写回范围内；COM 只作显式兜底（短超时 15–30s、不重试），并分别检查目标文件与残留 Office 进程；stdout 中文不作校验依据，结果必须回读目标文件 / XML 确认。
