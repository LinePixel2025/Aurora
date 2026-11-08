---
date: 2026-11-08
title: 桌面小组件统一不透明，windowMaterial 仅作兼容字段
tags: [插件, 小组件, 毛玻璃, Electron, 窗口, 材质, 兼容, 口径]
source: 模型自动记录
---

# 桌面小组件统一不透明，windowMaterial 仅作兼容字段

## 现象

旧版桌面小组件清单可以声明 `windowMaterial: "acrylic"`，宿主也曾按外观开关尝试挂原生 Acrylic、裁剪窗口 shape，并在渲染层映射玻璃令牌。用户现在要求删除桌面小组件的毛玻璃效果。

## 原因

小组件窗口是透明无边框窗口，材质、shape、页面玻璃令牌分别由主进程和渲染层控制；只删除其中一层会留下透明窗口露底、旧材质事件或 CSS 玻璃路径。清单和 IPC 已经发布，直接删除字段会破坏旧插件兼容。

## 影响

保留任一 Acrylic 路径都会让外观设置继续改变小组件材质；只改视觉样式而保留原生材质则仍会产生系统毛玻璃。删除清单字段或 IPC 又会让已安装插件出现解析和契约问题。

## 结论与做法

- `windowMaterial` 继续接受并保留在插件摘要中，但宿主统一解析为 `none`；旧的 `acrylic` 声明不再启用原生材质。
- `WidgetManager` 不调用 `setBackgroundMaterial`、`setShape`，不拼接 `material=acrylic`，也不随 `appearance.glass` 切换材质。
- 小组件页面使用实色背景和普通 `bg-raised` 卡片，移除 `data-material`、材质事件订阅和玻璃令牌映射；兼容的 `widgetMaterial` IPC 事件实际只发送 `none`。
- 层级、桌面 owner、`focusable: false`、固定/缩放和页面型插件隔离链路与材质无关，必须继续保留。
- 回归验证应同时检查旧 `acrylic` 清单仍能加载、运行态 `materialActive === false`，以及小组件没有 `backdrop-filter` 和材质 DOM 路径。
