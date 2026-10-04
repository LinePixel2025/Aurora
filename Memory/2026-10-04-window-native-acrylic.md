---
date: 2026-10-04
title: 主界面要看见系统背景，必须使用 Electron 原生窗口材质，CSS backdrop-filter 不够
tags: [UI, 毛玻璃, Electron, 性能]
source: 模型自动记录
---

# 主界面原生窗口材质

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
- 原生材质按“固定工作台”给主界面 / 设置窗 / 记忆库；引导继续使用实色基座。提示条曾短暂
  启用原生材质，后因矩形材质 / 阴影在圆角外露出而退出，见下方同日修订。

## 2026-10-04 后续修订：提示条退出原生 Acrylic

用户实测提示条圆角面板后仍露出矩形阴影。根因是 Windows 的原生 Acrylic 与窗口阴影都按
`BrowserWindow` 的整个矩形区域绘制，CSS 圆角只能盖住面板内部，圆角外的矩形材质 / 阴影
仍会露出来。

结论：当时 `NATIVE_GLASS_WINDOWS` 只保留 `chat`；`edge-bar` 使用透明窗口、`hasShadow: false`
和自包含的高不透明度 `.glass-fallback` 圆角面板，不再叠加原生 `backgroundMaterial`。
这样主界面继续获得真实桌面 Acrylic，提示条则不会出现“圆角矩形套矩形阴影”。

## 2026-10-04 设置窗补充

用户实测设置页仍然完全没有毛玻璃。原因是设置窗此前仍被列为实色窗口，
`backgroundColor` 不透明且 `body` 没有透明通道；CSS `backdrop-filter` 无法采样桌面。

结论：`NATIVE_GLASS_WINDOWS` 随后扩为 `chat + settings`；设置窗 `body` 同样使用
`.transparent`，内容区叠 `--glass-content` 保持可读性。提示条仍不启用原生材质。

## 2026-10-04 记忆库补充

用户实测记忆库仍然没有毛玻璃。原因是记忆库也仍在实色窗口集合里，`body` 没有透明通道。

结论：`NATIVE_GLASS_WINDOWS` 最终为 `chat + settings + memory`；记忆库 `body` 使用
`.transparent`，正文区叠 `--glass-content`，列表侧栏继续走 `.rail-surface` 玻璃。

## 2026-10-04 最大化灰色底修订：事件态材质切换

用户实测原生 Acrylic 窗口最大化后会整窗泛灰，向下还原也不能复位。第一版用
「最大化退出 Acrylic、还原恢复 Acrylic」仍无法消除 DWM 灰态；Acrylic 本身更适合短暂浮层，
不是长驻大窗的稳定选择。改 Mica 后用户又实测玻璃感几乎不可见，不能满足界面口径。

结论：恢复 `backgroundMaterial: 'acrylic'`，保留真实系统最大化语义，但材质状态由事件直接驱动：
`maximize` 明确切 `none + 主题实色`，`unmaximize` 明确等待 160ms 后先重置实底与透明通道，
**但不再重新启用 Acrylic**：同一 window handle 重新挂 Acrylic 会把灰态带回来，隐藏 / 重显也
无法清理。还原后使用透明 `backgroundColor + backgroundMaterial: none`，由 CSS 玻璃层继续表达。
**不要**在事件回调里回读 `isMaximized()` 判断目标状态，否则可能拿到切换前旧值。
冒烟探针覆盖「最大化退出 Acrylic → 还原后保持无 DWM 材质回退」。
