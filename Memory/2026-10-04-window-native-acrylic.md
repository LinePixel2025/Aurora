---
date: 2026-10-04
title: 原生窗口材质（Acrylic）总则
tags: [毛玻璃, 窗口, Electron, Windows, 坑]
source: 模型自动记录
---

# 原生窗口材质（Acrylic）总则

## 现象

- 主界面、设置、记忆库、自动化、插件配置与提示条都需要看见系统桌面背景；只叠 CSS `.glass-*` + `backdrop-filter` 时，视觉上仍只在窗口内部互相模糊。
- 提示条圆角面板开启原生材质后，矩形材质 / 阴影会从圆角外露出（2026-10-04 曾因此让它退出 Acrylic，2026-10-11 已恢复）。

## 原因

- Electron `BrowserWindow` 的 webContents 是一个独立合成面；CSS `backdrop-filter` 只能采样当前页面里元素下方的像素，不能穿透原生窗口边界去读取桌面或别的进程窗口。不透明的 `backgroundColor` 与实色 `body` 也会让系统材质没有可见通道。
- Windows 的 Acrylic 与窗口阴影默认按 `BrowserWindow` 整个矩形绘制；只有 `setShape` 把窗口区域裁成圆角，DWM 材质才会跟着区域裁剪；阴影则由 `hasShadow: false` 关掉。
- 材质是「意图」：非 win32、旧 Windows、`appearance.glass = false` 或 `setBackgroundMaterial` 失败时都必须回退实色，否则会「材质没挂上、窗口又透明」直接裸漏桌面。

## 影响

- 只加大 CSS `blur()` / 降低 tint 透明度只会让页面更糊，仍看不到桌面；只开透明不挂材质会让正文裸在桌面上，可读性和对比度都会崩。
- 圆角外露矩形材质、收起态仍挂材质、或最大化后灰底，都会破坏「真毛玻璃」观感，且只能在真机截图中看出来。

## 结论与做法

- 基础：Windows 11 22H2+ 使用 `BrowserWindow.backgroundMaterial: 'acrylic'`；`backgroundColor` 用 `#00000000`，chat 的 `body` 用 `transparent`，页面固定工作台再叠 CSS 玻璃。失败 / 非 win32 / `appearance.glass = false` 一律回退不透明 `--bg-base`；不能把「窗口透明」当作玻璃可用性的判据。
- 状态：`WindowManager` 用 `nativeGlassWindows` 记录真实启用状态；`glassAllowed()` 读 `appearance.glass`；`applyGlass()` 幂等切换已创建窗口；渲染层 `:root[data-glass='off']` 做令牌降级，原生材质与 CSS 令牌必须由同一份配置在同一时刻驱动。
- 当前 6 窗名单：`chat` / `settings` / `memory` / `automation` / `plugin-config` / `edge-bar`；`onboarding` 继续使用实色基座。
- Electron `^44.5.1` 已恢复原生 `win.maximize()` / `win.unmaximize()` 与 `isMaximized()` 语义；**不要恢复** Electron 33 时代的工作区缩放、`restoreBounds`、`convertingNativeMaximize` 或 0 / 60 / 140ms 重试链，最大化期间仍不落盘几何。
- 提示条：`NATIVE_GLASS_WINDOWS` 含 `edge-bar`；窗口选项维持 `transparent: true` + `hasShadow: false` + `thickFrame: false`。DWM 材质按窗口区域裁剪（`win.setShape()`），`main/edge-bar-geometry.ts` 的 `roundLeftCorners(rect, radius)` 用 1px 阶梯近似圆弧（展开态 = 面板列 28px + 竖条 6px，收起态 = 竖条一块）；面板 CSS 圆角与阶梯必须同一条弧（`--radius-xl` / 6px）。
- 材质只在展开态挂（`WindowManager.syncEdgeBarMaterial()`）；建窗时的 `backgroundMaterial` 构造参数必须与它同口径，否则建窗挂上、内部 `nativeGlassWindows` 却记成「没挂」，之后收起永远不会摘（实测踩过：收起态 `DWMWA_SYSTEMBACKDROP_TYPE` 仍是 3 = Acrylic）。
- 提示条面板用 `left: 0; right: 8px` 盖住除竖条列以外的整个客户区，材质才不会从面板边缘露出；客户区约 334px，`EDGE_BAR_WIDTHS.expanded = 328` 只是建窗请求宽。
- 视觉验收必须分两层：`capturePage` / 截图探针验证页面结构、透明 body 与 `nativeGlassCheck`（`usesNativeGlass`）；真实桌面是否透过 Acrylic，另用系统级屏幕截图核对。
- 取证通道（2026-10-11 踩坑）：`Graphics.CopyFromScreen`（PowerShell BitBlt）拍不到带 `WS_EX_NOREDIRECTIONBITMAP`（DirectComposition）的提示条窗口，会得出「窗口根本没渲染」的假结论；可用 Electron `desktopCapturer.getSources({ types: ['screen'] })`、Win+Shift+S（Windows.Graphics.Capture）或 `PrintWindow(hwnd, dc, 2)`（flag 2 = PW_RENDERFULLCONTENT，flag 0 会全黑）。
- 任何输入 / 视觉 A/B 之前先干净重启（杀 electron + 重新 `pnpm dev`），等热态 30s+ 再测；`electron-vite dev --watch` 因主进程改动重启后，edge-bar 的渲染进程可能是死的（窗口与 shape 都在，但悬停不展开、点击无反应；重启后 15s 内的悬停不展开是假阴性）。

> 2026-10-25 合并自 2026-10-11-edge-bar-native-acrylic-restore.md（原口径：提示条退出 Acrylic 已作废，恢复口径并入本条）
