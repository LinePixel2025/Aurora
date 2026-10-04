---
date: 2026-10-04
title: 主界面要看见桌面后方内容，必须使用 Electron 原生 Acrylic，CSS backdrop-filter 不够
tags: [UI, 毛玻璃, Electron, 性能]
source: 模型自动记录
---

# 主界面原生 Acrylic

## 现象

主界面已经给侧栏、标题栏、输入区铺了多层 `.glass-*` 与 `backdrop-filter`，
视觉上仍只在窗口内部互相模糊，完全看不到桌面或后方窗口内容；用户看到的是“毛玻璃不够”，
而不是样式漏配。

## 原因

Electron `BrowserWindow` 的 webContents 是一个独立合成面。CSS `backdrop-filter`
只能采样当前页面里位于元素下方的像素，不能穿透原生窗口边界去读取桌面或别的进程窗口。
主界面此前还使用不透明的 `backgroundColor` 与实色 `body`，因此系统材质即使开启也没有可见通道。

## 影响

只继续加大 CSS `blur()` / 降低 tint 透明度，只会让页面内容变糊，仍然看不到桌面；
反过来，只为窗口开透明却不启用系统材质，会让正文直接裸在桌面上，可读性和对比度都会崩。

## 结论与做法

- Windows 11 22H2+ 主界面使用 `BrowserWindow.backgroundMaterial: 'acrylic'`；
  `backgroundColor` 使用透明值，chat 的 `body` 使用 `transparent`，页面固定工作台再叠 CSS 玻璃。
- 系统材质启用失败（旧 Windows / 非 win32）必须回退不透明 `--bg-base`；
  不能把“窗口透明”当作玻璃可用性的判据。`WindowManager` 以 `nativeGlassWindows` 记录真实启用状态。
- 视觉验收必须分两层：`capturePage` / 截图探针验证页面结构与透明 body；
  真实桌面是否透过 Acrylic，另用系统级屏幕截图核对。
- 只给主界面与提示条开原生材质；设置、引导、记忆库继续保持实色基座，避免多窗同时采样桌面。
