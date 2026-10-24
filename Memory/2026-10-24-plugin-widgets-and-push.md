---
date: 2026-10-24
title: 插件小组件（桌面 / 提示条）与面板事件推送：窗口归属、限速与布局口径
tags: [插件, 小组件, Electron, IPC, 推送, 布局, 探针, 坑, 口径]
source: 模型自动记录
---

# 插件小组件与 `ui.panelEvent`（2026-10-24）

## 结论（长期口径）

- **桌面小组件是置顶浮动卡片**，不是壁纸层嵌入：每个可见 widget 一张 `BrowserWindow`
  （`frame:false` / `transparent:true` / `alwaysOnTop:true` / `skipTaskbar:true`），
  唯一创建入口是 `apps/desktop/src/main/plugins/widgets.ts`；窗口总数上限 8（防失控常量）。
- **提示条小组件只接受声明式 schema**：清单层就拒绝 `entry` 与 `defaultSize`；
  渲染在提示条展开面板底部「小组件」区，单条最高 220px、内部滚动；不创建窗口、不嵌 webview。
- **布局独立于 settings**：`<userData>/plugin-widget-layout.json`
  （`{ version: 1, widgets: { "<pluginId>/<widgetId>": { visible,x,y,width,height } } }`），
  不升 `CONFIG_VERSION`；删它只丢位置，不丢插件数据。
- **推送只走自己的目标**：`ctx.ui.panelEvent` 必须在主进程校验 panelId / widgetId 二选一、
  目标在清单内、面板要 `ui.panels`、小组件要 `ui.widgets`、payload ≤ 64 KB、
  每插件每秒 ≤ 20 条（超出丢弃回 `{ dropped: true }`，不抛错）。
- **页面型小组件的 guest 归属带 widgetId**：页面 URL 用 `?widget=<id>`（不是 `?panel=`），
  `plugins:pageRpc` 同时校验 guest 登记的 widgetId 与清单目标，缺一不可。

## 踩过的坑（每条都是实测）

1. **布局里的尺寸比 `defaultSize` 大 4×2**：Windows 上可缩放的无边框窗口仍带 resize 边框，
   `getBounds()` 报 304×202（清单写 300×200）。断言只比 `>= 120` 或做近似，别写严格相等。
2. **widget 窗口首次加载偶发 `ERR_FAILED`**：dev 下 Vite 首次编译 `widget/index.html` 时
   可能失败一次，之后 `capturePage()` 仍能截到正常画面；不要把它当回归，
   先看 widget 窗口是否已渲染（截图 / `widgetData` 返回 schema）。
3. **提示条截图要滚两次**：小组件区在面板挂载后才异步拉 `plugins:list` + `widgetData`，
   第一次 `scrollTop = scrollHeight` 时常还没到底；capture 的 act 里隔 500ms 再滚一次。
4. **smoke 读计数别取 `values[1]`**：面板 keyValue 的值顺序是「计数、来源」，
   `.kv-value` 的第 1 个才是计数；取第 2 个永远是「插件存储」，会出现 before/after 相同的假红。
5. **崩溃恢复保留最后 schema**：桌面 widget 在插件崩溃时只显示「插件已崩溃」角标，
   旧 schema 继续渲染；`plugins:changed` 回到 ready 时自动重新 `widgetData('refresh')`。

## 验证基线（2026-10-24）

- `pnpm test` 193 文件 / 2796 用例；`pnpm verify` 26/26（`version=36`、迁移 36/36）；
- 冒烟 **239/239**（新增小组件摘要 / widgetData / 布局 / 面板推送 4 条）；
- 截图新增 `widget-desktop-plugin` / `edge-bar-plugin-widget` / `chat-plugin-panel-push`，
  全量基线 105 条；桌面 widget 目标通过 `captureWindows` 的 `widgetWindow` 现取；
- `node scripts/verify-plugin.mjs examples/plugins/hello-aurora` 通过（含 widgets 文件校验）。

## 2026-10-24 后续修订（v37）

上述「桌面小组件是置顶浮动卡片、层级硬编码」已被后续修订取代：清单现支持
`windowLevel`（floating / normal / desktop）与 `windowMaterial`（none / acrylic），
默认仍为 floating / none；用户层级覆盖写布局文件的 `windowLevelOverride`。
实现口径、Win32 owner 亲和、minimize 恢复守护、Acrylic 圆角 shape 与 PowerShell `$null`
坑见 [2026-10-24-widget-window-level-and-glass.md](2026-10-24-widget-window-level-and-glass.md)。
