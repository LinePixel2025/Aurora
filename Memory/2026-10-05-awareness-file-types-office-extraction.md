---
date: 2026-10-05
title: 自感知覆盖图片与常用文档，Office 走结构化提取
tags: [自感知, 文档, 图片, officeparser, 性能]
source: 模型自动记录
---

# 自感知文件类型与结构提取

## 现象

自感知最初只对 `.docx` / `.pptx` 做正文分析，图片只在上传附件或 Agent `view_image` 时使用；
同类 PDF、表格、开放文档、HTML、EPUB 和纯文本即使已有提取器能力，也不会进入后台笔记。
Office 正文只取纯文本，标题层级、表格和幻灯片结构容易丢失。

## 原因

- `extract.ts` 已经有多类格式能力，但 `file-awareness` 另维护了更窄的 `CONTENT_EXTENSIONS`，
  两处能力表没有单源。
- Office 统一调用 `toText()` / `to('text')`，没有使用 officeparser 的结构化生成器。
- 图片提取与“当前模型是否支持视觉输入”没有在提取请求处分流。

## 影响

用户看不到大量文件的记忆；压缩成纯文本后，标题、表格行列和页 / 幻灯片边界丢失，模型分析不全面；
视觉关闭时仍提取附件会浪费解码和内存。

## 结论与做法

- 自感知正文类型由 `extract.ts` 的统一判定单源提供：图片、DOCX / PPTX / XLSX、PDF、
  ODF、RTF、HTML / HTM、EPUB、CSV / MD / TXT 等常见文本都进入队列。
- `.doc` / `.ppt` / `.xls` 仍是**只观察、不解析**；`.tif/.tiff/.svg` 可记录，但不直接作为视觉输入。
- Office 优先结构化输出：表格格式走 CSV，其余走 Markdown（CommonMark、关闭 HTML fallback /
  formatting / IDs），保留标题、列表、表格和页 / 幻灯片边界；失败才退回纯文本。
- 自感知证据上限 **24KB**，分类管线仍保持 **8KB**；head/tail 截断规则不变。
- 图片像素只在 `visionReady === true` 时提取；关闭视觉时只发送文件名、尺寸等元数据。
- 新增类型时必须改 `extract.ts` 的统一扩展集合，不要重新在 `file-awareness.ts` 维护第二份清单。
