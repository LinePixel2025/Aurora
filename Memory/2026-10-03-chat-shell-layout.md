---
date: 2026-10-03
title: 主界面 chat 的窗口几何、三栏宽度夹取与「三键固定右上角」
tags: [UI, 布局, 坑]
source: 模型自动记录
---

# 主界面 chat：几何与三栏布局

## 现象

1. **窗口几何被按旧心智模型理解**：主界面 `chat` 是 **1280×800（min 1060×660，2026-10-03 二次修订）、
   `alwaysOnTop=false` 的常驻大窗**（三栏布局 + 右栏模式感知，关闭仍 = 隐藏），
   不是旧版 420×640 侧弹交互窗。
2. **窗口像坏了**：右栏上限提到 720 后，在 1120px 的窄窗口里拖到上限，把对话区挤成一条
   （~175px，一列一个字）。
3. **整组窗口按钮被推出主区**：`WindowCaption` 三键曾排在主区标题栏末尾，主区一窄就被推到右栏 tab 条上。
4. **「按钮整排消失」**（用户实测）：预览带长 URL / 长代码行的文件时右栏被撑宽，超出部分被
   `overflow: hidden` 裁掉 —— 正文被窗口右缘切断、工具条按钮被推出可视区；
   而 **DOM 里都在**，只查存在性的探针全绿。
5. **标签条压住三键**：拖宽过渡的瞬时溢出画到了按钮底下。

## 原因

- 隐含 `auto` 列轨的下限是内容的 **min-content**：长 URL / 长代码行会把列撑宽。
- 两侧栏宽度必须是"实际生效宽度"再分发给栏内子组件，否则 CSS 里会出现第二套窗口比例夹取。
- 三键与标签条共享窗口右上角这块矩形，需要显式让位。

## 影响

- 用户看到的现象（"没有返回按钮""窗口像坏了"）与 DOM 探针的结论相反，会先在错的方向上改代码。
- 宽度夹取写两份 → 子组件按旧变量布局，主区被挤没。

## 结论与做法

- 最小宽 1060 = 左栏 240 + 主区下限 420 + 右栏 384 + 16；
  存量窗口由 `v25 → v26` 迁移**放大一次（只放大不缩小）**，别再塞回别的迁移里。
- 两侧栏宽度是 `min(期望值, 窗口 − 另一侧 − MAIN_MIN_WIDTH 420)`（`App.vue` 的
  `navEffWidth` / `ctxEffWidth`，resize 时重算），内联到 `--nav-w` / `--ctx-w` 的就是**实际生效宽度**：
  栏内子组件（JobPanel / ContextPanel / SessionNav 的 `.nav-inner`）读同一个变量，
  **别再回硬编码 264px，也别在 CSS 里另写一套夹取**。绝对上限：左栏 520 / 右栏 720。
- 列轨一律 `minmax(0, 1fr)`（`.app-shell` / `.nav` / `.context` / `.ctx-panes` / `.ctx-pane`），
  面板内处处 `min-width: 0`，文件预览的 markdown 容器另加 `overflow-wrap: anywhere`。
- `WindowCaption` 三键**挂在窗口右上角**（`.window-caption`，app-shell 直属、`position: fixed`，
  与设置窗同款），**不要**再排回主区标题栏末尾；`--head-h`（48px）让标题栏与 tab 条同高，
  tab 条按 `--caption-w`（132px）右侧让位，右栏收起时标题栏挂 `.head--corner` 让位。
- 回归护栏（capture `chat-right-tabs` / `chat-file-project`）：`captionPinned` / `captionTabOverlap`
  （三键贴右缘贴顶、与 tab 矩形无交集）、`navMainKept` / `ctxMainKept`（主区 ≥ 380）、
  `asideOverflowX` 与按钮矩形的 `toolbarInView` —— **量矩形，不量存在**。
