---
date: 2026-10-04
title: 毛玻璃材质类不能擅自补边框，否则会改变标签容量与工作台盒模型
tags: [UI, 毛玻璃, CSS, 坑]
source: 模型自动记录
---

# 毛玻璃材质类与盒模型

## 现象

给共享 `.glass-shell` / `.glass-bar` / `.glass-surface` 统一加 `border: 1px solid …` 后，
现有布局探针出现两处反直觉偏移：

- 桌面 `chat-ctx-tabs` 的右栏总标签数仍为 5，但可见标签从 `browser + browser-2`
  变成只剩 `browser-2`，折叠数从 3 变成 4；
- `chat-preview-tool` 里浏览器工具条的「新建标签」实际已经创建了新标签，但新标签被
  推进 `＋N` 菜单，探针按可见标签读数判成 `toolbarOpened:false`。

## 原因

右栏 `.context` 原本只有 `border-left: 1px`；材质类额外补上另外三边后，在 `box-sizing:
border-box` 下没有改外宽，却把内部可用宽度再吃掉 2px。标签容量恰好卡在边界时，
最后一张标签因此被折叠。`CtxTabStrip` 自身还有一条 `border-bottom` 横带，
材质类再补四边框也会叠加同类问题。

## 影响

纯视觉改动会以“标签点不到 / 新标签没出现 / 工具按钮失效”的形式表现，
但 DOM、事件与数据层都正常；只查存在性或不量容量的探针会把这类静默回归放过去。
同样的盒模型偏移也会影响侧栏、工具栏和其它按内容宽度分栏的固定 UI。

## 结论与做法

- 材质类**只改已有边框的颜色**：`.glass-shell` / `.glass-bar` / `.glass-surface`
  写 `border-color`，不写 `border-width` / `border`；完整边框只允许在明确的
  `.glass-panel` / `.glass` 浮层上出现。
- 新工作台接入玻璃时，先确认元素已有哪几条单边边框；材质层不得改变其布局占位。
- 涉及标签条、工具栏、可拖拽侧栏的视觉改动，验收必须量“可见数量 + 矩形 + 命中”，
  不能只看元素是否存在。回归锚点：`chat-ctx-tabs` 的 visible / folded 与
  `chat-preview-tool` 的 `toolbarOpened`。
