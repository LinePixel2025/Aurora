---
date: 2026-10-05
title: 提示条置顶需要 screen-saver 等级与 watchdog 恢复
tags: [edge-bar, Windows, 窗口, 坑]
source: 模型自动记录
---

# 提示条置顶恢复

## 现象

右侧提示条 `edge-bar` 偶发被其他窗口遮挡，表现为“应该置顶但有时失效”，没有稳定复现步骤。

## 原因

提示条创建时只依赖 `alwaysOnTop: true`，默认优先级仍可能被其他置顶窗口覆盖；
显示 / 展开 / 收起 / 外部置顶状态变化后也没有再次断言原生命中置顶位。

## 影响

提示条是常驻入口，偶发掉到底下会让用户以为功能被关闭或窗口管理器坏了；单靠重启排查成本高。

## 结论与做法

- 提示条创建、显示、展开、收起后统一调用
  `setAlwaysOnTop(true, 'screen-saver')`；显示时再执行一次无焦点 `moveTop()`。
- 监听 `always-on-top-changed`：原生状态变为 `false` 时立即恢复。
- 保留 10 秒 watchdog，只在提示条可见且 `isAlwaysOnTop() === false` 时恢复；
  不要高频 `moveTop()`，避免与系统其他置顶窗口无意义抢层级。
- 不改变 `focusable: false` 与鼠标穿透现状；独占全屏应用、UAC 安全桌面仍是系统不可覆盖场景。
- 回归护栏：Electron 冒烟直接读取原生 `BrowserWindow.isAlwaysOnTop()`，并覆盖强制清除后的恢复路径。
