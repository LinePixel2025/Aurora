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

## 2026-10-04 最大化灰色底再修订：工作区缩放

用户再次实测：毛玻璃窗口最大化后再还原，背景仍是灰色。上一版「最大化退出 Acrylic，还原后保持透明无材质」本身就会露出灰色 DWM/合成器底；同一 HWND 重新挂 Acrylic 则会把最大化期间的灰态带回来。

结论：毛玻璃窗口（chat / settings / memory）**不要走系统 `WS_MAXIMIZE`**。caption 最大化改为 `setBounds(当前显示器 workArea)`，`WindowState.maximized` 由逻辑最大化态现算。拖动区双击 / Win+↑ 的原生 maximize 事件立即 unmaximize 并改走同一条工作区缩放。还原后 Acrylic 保持开启，禁止再切成透明无材质底。

## 2026-10-05 公开案例核对与原生入口补丁

上网核对的 Electron 公开案例（Electron 33 本地实行）：

- [#41824](https://github.com/electron/electron/issues/41824)：`frame: false + backgroundMaterial` 最大化会永久破坏窗口，材质消失 / 背景变黑 / 圆角与边框丢失；这是最早的系统性问题。
- [#42393](https://github.com/electron/electron/issues/42393)：Windows 11 上启用 `backgroundMaterial` 后最大化变黑、圆角消失，Electron 30 / 33 均可复现。
- [#46753](https://github.com/electron/electron/issues/46753)：即使 Electron 35.2.1，拖拽到顶部 / 标题栏双击 / 从最大化拖回，仍会走一条材质丢失路径；只有程序化最大化按钮有时不受影响。
- [PR #45456](https://github.com/electron/electron/pull/45456)：Electron 34 / 35 的临时修复把 translucent 窗口的最大化改成 `setBounds(workArea)`；**没有进入 Electron 33 线**。
- [PR #47386](https://github.com/electron/electron/pull/47386)：后续根因修复（Chromium 的 `DwmExtendFrameIntoClientArea` 会破坏材质）落在 38 线，并回移到 37.2.6 / 36；[#48031](https://github.com/electron/electron/issues/48031) 又记录到后续版本的黑色 / 灰色底回归。

Electron 33 阶段因此保留「工作区缩放」兜底；2026-10-05 升到 Electron 44 后该兜底已退役。

2026-10-05 实测补了一条关键边界：caption 按钮的工作区缩放正常，但拖动区双击 / Win+↑ 的原生
`maximize()` 路径曾失败。根因是 `maximize` 事件里立即 `unmaximize()` 后，系统还会异步落一次
原来的普通尺寸，紧接着调用的 `setBounds(workArea)` 被它覆盖。修正为先等 `unmaximize` 事件，
再在 0 / 60 / 140ms 三个落位点重试工作区尺寸；期间用 `convertingNativeMaximize` 锁住泛型
`unmaximize` 监听器，避免异步事件顺序把逻辑最大化态清掉。若用户在这段窗口内主动还原，
`logicalMaximized` 已被清空，重试会自行停止。

冒烟回归护栏同时覆盖两条入口：caption 的工作区缩放，以及直接调用原生 `maximize()` 后
必须仍落到 workArea、原生 `isMaximized()` 为 false、Acrylic 保持开启、还原几何可逆。

## 2026-10-05 Electron 44：恢复原生最大化与提示条 shape

Electron 升级到 44.5.1 后，先在真实 Windows 环境中做了直通诊断：临时绕过 Aurora 的工作区
缩放，直接调用系统 `maximize()`，再通过 `DwmGetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE)`
读取材质。结果在最大化与还原两步都保持 `3`（`DWMSBT_TRANSIENTWINDOW`，即 Acrylic），
且原生 `isMaximized()` 语义正常。说明 Electron 44 已修复 Electron 33 的材质锁死路径。

结论：

- chat / settings / memory 删除逻辑最大化、`restoreBounds`、`convertingNativeMaximize` 与
  0 / 60 / 140ms 重试链，恢复直接 `win.maximize()` / `win.unmaximize()`。
- `WindowState.maximized` 重新直接读 `win.isMaximized()`；最大化期间仍不落盘几何。
- Electron 44 冒烟护栏改为断言「系统最大化保持、Acrylic 保持、还原几何可逆」。
- 提示条是另一类问题：Electron 44 对透明 frameless 窗口施加约 33 DIP 的最小宽度，
  收起态请求 8px 会被夹到 33 / 34px。处理方式是继续请求目标尺寸，但用实际宽度把窗口
  锚到工作区边缘，并调用 `win.setShape()` 把可见与可交互区域裁成 8px（展开态 328px），
  多余透明区不绘制、不接收鼠标。`getEdgeBarShape()` 作为探针读取口。
- Electron 44 破坏性迁移已处理：`clipboard.readText/writeText` Promise 化，
  剪贴板图片改为 `clipboard.read()` + `ClipboardItem`；
  `console-message` 改用事件对象字段（`level/message/lineNumber/sourceId`）。

验证基线（Electron 44.5.1）：`pnpm typecheck`、`pnpm test`（2400）、`pnpm build` 全绿；
全量 Electron 冒烟 182/182；桌面全量截图 83 个产物 / 78 条探针 0 失败（含流式爆发探针）；
`pnpm lint`、`pnpm package` 通过，打包产物 `Aurora-Setup-0.3.9.exe` 为 Electron 44.5.1；
`win-unpacked` 在跳过预期 UAC 等待后进入 `Aurora 就绪`。
