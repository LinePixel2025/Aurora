---
date: 2026-10-30
title: 桌面小组件：点击不抢前台（focusable:false）与「固定」= 锁位置
tags: [插件, 小组件, Electron, 窗口, 焦点, 布局, 探针, 坑, 口径]
source: 用户需求 + 本机实测
---

# 桌面小组件：点击不抢前台 + 固定按钮（2026-10-30）

## 现象

- 点插件桌面小组件（卡片本身或卡内按钮）时，Aurora 会被切成 Windows 前台应用：
  用户正在用的应用失去前台，任务栏 / Alt+Tab 焦点跟着跳。
- 小组件没有「固定」入口：只能靠设置页的层级下拉间接管行为，用户想就地锁住位置时没有按钮。
  用户口径：**固定 = 锁定位置与尺寸**（不是置顶），**默认不固定**。

## 原因

- Electron 的 `BrowserWindow` 默认可被激活；点击窗口即激活 → 进程成为前台应用。
  Windows 侧对应样式是 `WS_EX_NOACTIVATE`，Electron 暴露为 `focusable: false`。
- 窗口移动走系统非客户区：页头 `-webkit-app-region: drag` 只是告诉 Chromium「这段按标题栏处理」，
  真正的移动由 OS 完成；只改渲染层 CSS **挡不住**移动，必须主进程关 `setMovable`。

## 实测（Electron 44.5.1 / Windows，标度 1.5）

- `focusable: false`：模拟点击卡片正文 → 页面收到 `click`、`GetForegroundWindow()` 不变；
  页头拖动照常移动窗口（600,300 → 692,349）。对照 `focusable: true`：同一点击后前台窗口立即变成本进程。
- `setMovable(false)`：页头拖动不再移动窗口；`setResizable(false)` 关缩放。
- **代价（既定口径）**：不可激活 ⇒ 小组件窗口拿不到键盘焦点，声明式 schema 里的
  `input` / `textarea` / `number` 输入不能键入。桌面场景优先「不打扰」，不要为了输入能力改回可激活。
- 探针坑：PowerShell 模拟鼠标必须先 `SetProcessDPIAware()`；否则 `SetCursorPos` / `WindowFromPoint`
  的坐标被 DPI 虚拟化（1.5 倍标度下点偏，表现为「窗口没收到点击、也没移动」的假阴性）。

## 做法（长期口径）

- 建窗固定 `focusable: false`（`main/plugins/widgets.ts`，唯一 import electron 的 widget 模块），
  `showInactive()` 不变；图层级 / 材质逻辑不受影响。
- 标题栏「固定」按钮（宿主绘制，`data-field="widget.pin"`，图标 lucide `Pin`，锁定态用
  `--accent-text` 点亮）：点击 → `plugins:setWidgetLocked` → 布局条目 `locked: true` +
  `setMovable(false)` + `setResizable(false)`；再点取消，`locked` 字段删除（布局 version 仍 1，
  不升 `CONFIG_VERSION`）。**默认未固定**，旧布局文件读出来也没有该字段。
- 固定态只锁用户拖动 / 缩放；程序式 `setBounds`（换显示器夹取、层级切换）照常。
  隐藏中的 widget 只落盘，下次建窗时生效。
- 验收：`smoke` 断言 `focusable === false`、`setWidgetLocked` 写布局且 `resizable === false`、
  取消后恢复；`capture` 的 `widget-desktop-plugin` 场景真的点两下按钮，断言
  `aria-pressed` 与布局 `locked` 同步（截图仍拍默认未固定状态）。

> 相关：`docs/14 §5.3`、AGENTS 的「桌面小组件窗口必须 focusable: false」硬规则。
