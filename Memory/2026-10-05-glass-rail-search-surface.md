---
date: 2026-10-05
title: 玻璃侧栏里的搜索框不能用透明 glass token 当底
tags: [UI, 搜索, 毛玻璃, 坑]
source: 模型自动记录
---

# 记忆库搜索框背景消失

## 现象

记忆库左侧栏的搜索输入看起来没有背景；向下滚动后，笔记标题还会从 sticky 筛选区后面透出来，
像是搜索框、筛选项和笔记文字叠在一起。

## 原因

第一版搜索框用了 `--glass-surface`，本身就是低透明度玻璃 token；而外层 sticky
`.note-filters` 仍用“玻璃色 → transparent”的渐变。即使把搜索框换成 `--fill-2`，
滚动内容仍会从渐变透明段和侧栏玻璃里透出来，所以看起来依旧“没有背景”。

## 影响

用户会误以为搜索功能或输入框坏了，而不是“样式太透明”；错误方向会先去查 DOM、事件或 IPC。

## 结论与做法

- 玻璃侧栏内的固定输入控件必须用**实心底**表达可输入区域：记忆库搜索框使用
  `color-mix(bg-raised, text-primary)`，聚焦时切换 `--aurora-blue` 边框；不要只叠半透明 fill。
- **sticky 筛选区本身必须是全宽不透明层**：`.note-filters` 用 `--bg-raised` 实底，
  负 margin 铺满侧栏内宽并加一条底部分隔 hairline；不能在滚动容器上用透明渐变做 sticky 背景。
- `--glass-surface` 只适合本身就要融进玻璃的容器，不适合需要明确命中边界的独立表单控件。
- 视觉探针除“输入框存在”外，还要量筛选层的 `background-color`、滚动后的
  `elementFromPoint` 命中，避免只查 DOM 放过透明回归。
