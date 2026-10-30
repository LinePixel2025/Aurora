---
date: 2026-10-24
title: 插件小组件：层级 / 材质 / 推送与布局
tags: [插件, 小组件, 窗口, 毛玻璃, IPC]
source: 模型自动记录
---

# 插件小组件：层级、材质、推送与布局

## 现象

- 插件侧只能声明 `slot: "desktop"` 的小组件，宿主曾把窗口层级硬编码为置顶，插件无法让浮窗只在桌面可见，也无法使用与主界面一致的原生毛玻璃。
- 提示条小组件与面板事件推送需要各自的目标校验；布局、窗口上限和页面型小组件的 guest 归属也各有边界。

## 原因

- 窗口层级 / 材质属于宿主 `BrowserWindow` 能力，插件 API v1 不暴露窗口对象；让插件用外部 Win32 改层级违反插件边界，也会被宿主重启覆盖。必须由宿主扩展 manifest 契约，并在 `main/plugins/widgets.ts`（唯一 import electron 的 widget 模块）创建窗口时落实。
- `desktop` 若用 WorkerW / `SetParent` 做壁纸层嵌入，会破坏透明表面与命中测试，拖拽 / 缩放 / 点击需要额外鼠标注入；本项目改用普通 z-order + Win32 owner 亲和 + minimize 恢复守护。
- `windowMaterial: "acrylic"` 只是意图：必须同时满足 `appearance.glass` 开启、平台 win32、Win11 22H2+、`setBackgroundMaterial` 成功、圆角 shape 成功；任何一步失败都必须回落到不透明卡片。
- `setShape` 若只按内容区裁圆角，会把 Windows 给无边框可缩放窗口补的不可见 resize 边框切出区域外，用户点不到边缘缩放。

## 影响

- 不记住会把 `desktop` 当壁纸嵌入；材质没挂上又透明会裸漏桌面；shape 裁错会让用户无法缩放。
- 布局若写进 settings 会升 `CONFIG_VERSION` 并污染配置；推送越权 / 超限会吵到别的插件；提示条小组件若允许 `entry` / `defaultSize` / 非默认 `windowLevel` / `windowMaterial` 会改坏提示条窗口逻辑。

## 结论与做法

- 清单（仅 desktop 槽位；edge-bar 只允许默认值，否则清单校验拒绝）：`windowLevel: "floating"`（默认，兼容 0.5.1）/ `"normal"` / `"desktop"`；`windowMaterial: "none"`（默认）/ `"acrylic"`。用户层级覆盖写 `<userData>/plugin-widget-layout.json` 的可选 `windowLevelOverride`（布局 version 仍 1，不进 settings、不升 `CONFIG_VERSION`）；设置页每个桌面 widget 一枚层级下拉，走 `plugins:setWidgetWindowLevel`，已创建窗口原地应用、不重建。
- `desktop` 实现：不置顶；创建后异步用 PowerShell P/Invoke 把窗口 owner（`GWLP_HWNDPARENT = -8`）指向 `SHELLDLL_DefView`；同时监听 `minimize`，在 Win+D / Win+M / 任务栏「显示桌面」后 `restore()` + `showInactive()`（2 秒内最多 3 次，超过置 `desktopGuardFailed` 停守护；owner 失败只记日志，恢复守护继续兜底）。**不是**壁纸层嵌入，失败按 `normal` 回落。
- Acrylic：建窗时先 `setBackgroundMaterial('acrylic')`；加载完成后用 `widgetRoundedShape()`（四角 1px 阶梯，半径 20 = `--radius-lg`）按**整个窗口矩形**裁 shape；裁失败就 `setBackgroundMaterial('none')` + `setShape([])` 回退不透明。材质成功才给页面 URL 带 `?material=acrylic`，之后外观开关变化走 `plugins:widgetMaterial` 事件；渲染层只在 `:root[data-glass='on']` + `[data-material='acrylic']` 下映射玻璃令牌。
- 布局与上限：`plugin-widget-layout.json` 为 `{ version: 1, widgets: { "<pluginId>/<widgetId>": { visible, x, y, width, height } } }`；桌面窗口总数上限 8（`PLUGIN_WIDGET_MAX_WINDOWS`）；删布局只丢位置，不丢插件数据。
- 提示条小组件：只接受声明式 schema，清单层就拒绝 `entry` / `defaultSize` 与 `windowLevel` / `windowMaterial` 的非默认值；渲染在提示条展开面板底部「小组件」区，单条最高 220px、内部滚动；不创建窗口、不嵌 webview。
- 推送：`ctx.ui.panelEvent` 必须在主进程校验 panelId / widgetId 二选一、目标在本插件清单、面板目标要 `ui.panels`、小组件目标要 `ui.widgets`、payload ≤64 KB、每插件每秒 ≤20 条（超出丢弃记 warn）；只投给发起插件自己的面板 / 小组件（桌面窗口走 `plugins:widgetEvent`，右栏面板走 `plugins:panelEvent`）。
- 页面型小组件：页面 URL 用 `?widget=<id>`（不是 `?panel=`）；`plugins:pageRpc` 必须同时校验 guest 登记的 widgetId 与清单目标，缺一不可。
- PowerShell `$null` 坑（实测）：P/Invoke 调 .NET 方法时 PowerShell 会把 `$null` 转成空字符串传给 `string` 参数，`FindWindow('Progman', $null)` 恒返回 0（表现为永远 `no-shell-view`）。必须传 `[NullString]::Value`；回归在 `widget-desktop-layer.test.ts` 的 `expect(script).toContain('[NullString]::Value')`。
- 两条实测坑：① Windows 上可缩放的无边框窗口仍带 resize 边框，`getBounds()` 报 304×202（清单写 300×200，多 4×2）；断言只比 `>= 120` 或做近似，别写严格相等。② smoke 读计数别取 `values[1]`：面板 keyValue 顺序是「计数、来源」，`.kv-value` 第 1 个才是计数，取第 2 个永远是「插件存储」，会出现 before / after 相同的假红。
- 崩溃恢复保留最后 schema：桌面 widget 在插件崩溃时只显示「插件已崩溃」角标，旧 schema 继续渲染；`plugins:changed` 回到 ready 时自动重新 `widgetData('refresh')`。

> 2026-10-25 合并自 2026-10-24-plugin-widgets-and-push.md（原口径：小组件推送、布局与提示条槽位并入本条）
