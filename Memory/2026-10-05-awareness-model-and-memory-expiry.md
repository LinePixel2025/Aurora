---
date: 2026-10-05
title: 自感知：后台模型、记忆过期与覆盖文件类型
tags: [自感知, 模型, 记忆, 配置, 工具]
source: 模型自动记录
---

# 自感知后台模型、记忆过期与文件类型

## 现象

- 旧实现只对 `.docx` / `.pptx` 做正文分析；图片只在附件或 `view_image` 时使用；PDF、表格、开放文档、HTML、EPUB 和纯文本即使已有提取器也不进入后台笔记。
- Office 只取纯文本，标题层级、表格与幻灯片结构容易丢失；视觉关闭时仍提取附件会浪费解码和内存。
- 后台模型不明确时可能回落主模型，把文件正文发给用户未选择的接收方；过期记忆仍可能从运行摘要侧泄漏。

## 原因

- `extract.ts` 已有多格式能力，但 `file-awareness` 另维护了更窄的 `CONTENT_EXTENSIONS`，两处能力表没有单源。
- Office 统一调 `toText()` / `to('text')`，没有使用 officeparser 的结构化输出；图片提取未按当前模型是否支持视觉输入分流。
- 后台模型解析没有「显式选择即严格使用」的口径；过期只被 UI 标记，`candidatesFor` 与工具侧没有统一过滤。

## 影响

- 大量文件没有记忆；结构化信息丢失让分析不全面；视觉关闭仍解码浪费内存。
- 正文可能发给用户未选的接收方；过期内容可从 `awareness_recent` 的运行摘要侧泄漏。

## 结论与做法

- 后台模型：`fileAwareness.backgroundModel.providerId` 为空时跟随全局 `llm.active`；显式选择后，后台分析必须严格使用该 provider + model。provider 被删除、模型为空、Base URL / Key 缺失或 Center 官方模型不可用时，**暂停队列并显示原因，不回落主模型**（`fileAwarenessModelError`）。
- `visionReady`、提取图片开关与提示条模型标签都必须按**有效后台模型**计算，不能读全局主模型的 `vision`。
- 记忆过期只控制 Agent 可见性，**不删除**状态和 Markdown：`inherit` 按 `updatedAt + defaultMemoryTtlDays` 计算并在重新分析后续期；`never` 永不过期；`at` 是固定绝对时间，不随更新续期（`manual` preset 立即过期）。
- 过期记忆仍可在记忆库和 `INDEX.md` 查看，但后台 `candidatesFor`、`agentNotes`、`agentRecords`、`readAgentNote` 都必须排除它；`agentRecords` 还要按 `noteId` / `sourcePath` 排除同源运行记录，否则会从运行摘要侧泄漏过期内容。
- 配置与状态：`defaultMemoryTtlDays` 与 `backgroundModel` 由 v29 引入（当前 `CONFIG_VERSION = 38`）；`file-awareness/state.json` 当前 `STATE_VERSION = 4`；旧笔记缺 `expiry` 时归一为 `{ mode: 'inherit' }`，默认天数 0 时行为与升级前一致。
- 文件类型：唯一判定在 `extract.ts` 的 `isAwarenessObservedExtension`（文本 / Office / 图片 + legacy Office），不要在 `file-awareness.ts` 再维护第二份清单。`.doc` / `.ppt` / `.xls` 仍是**只观察、不解析**；`.tif` / `.tiff` / `.svg` 可记录，但不直接作为视觉输入（`VISUAL_IMAGE_EXTENSIONS` 排除它们）。
- Office 优先结构化输出：`xlsx` / `ods` 走 CSV，其余走 Markdown（CommonMark、关闭 HTML fallback / formatting / IDs），保留标题、列表、表格和页 / 幻灯片边界；失败才退回 `to('text')` / `toText()`。
- 自感知证据上限 **24KB**（`SELF_AWARENESS_EVIDENCE_LIMIT_BYTES`），分类管线仍保持 **8KB**（`EVIDENCE_LIMIT_BYTES`）；head / tail 截断规则不变。图片像素只在 `visionReady === true` 时提取，关闭视觉时只发送文件名、尺寸等元数据。
- 新增类型时必须改 `extract.ts` 的统一扩展集合，不要重新在 `file-awareness.ts` 维护第二份清单。

> 2026-10-25 合并自 2026-10-05-awareness-file-types-office-extraction.md（原口径：文件类型与结构化提取并入本条）
