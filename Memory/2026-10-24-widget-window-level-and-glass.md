---
date: 2026-10-24
title: 桌面小组件层级（floating / normal / desktop）与原生 Acrylic：owner 亲和、恢复守护与圆角 shape
tags: [插件, 小组件, Electron, 窗口, 毛玻璃, Win32, PowerShell, 坑, 口径]
source: 模型自动记录
---

# 桌面小组件层级与毛玻璃（v37）

## 现象

插件侧只能声明 `slot: "desktop"` 的小组件，宿主把窗口层级硬编码为置顶（`alwaysOnTop: true`
+ `setAlwaysOnTop(true, 'floating')`），插件无法让浮窗只在桌面可见；也没有办法让小组件使用
与主界面一致的原生毛玻璃。

## 原因

窗口层级 / 材质属于宿主 `BrowserWindow` 能力，插件 API v1 不暴露窗口对象；让插件用外部
Win32 改层级违反插件边界，也会被宿主重启覆盖。必须由宿主扩展 manifest 契约并在
`main/plugins/widgets.ts`（唯一 import electron 的 widget 模块）创建窗口时落实。

## 影响

不记住会误判三件事：

1. `windowLevel: "desktop"` **不是** WorkerW / `SetParent` 壁纸层嵌入。Electron 下重挂父窗口会
   破坏透明表面与命中测试，拖拽 / 缩放 / 点击需要额外鼠标注入；本项目改用
   **普通 z-order + Win32 owner 亲和 + minimize 恢复守护**，失败如实回落 `normal`。
2. `windowMaterial: "acrylic"` 只是**意图**：必须同时满足 `appearance.glass` 开启、平台 win32、
   `setBackgroundMaterial` 成功、圆角 shape 成功。任何一步失败都必须回落到不透明卡片，
   否则会「材质没挂上、窗口又透明」直接裸漏桌面。
3. `setShape` 若只按内容区裁圆角，会把 Windows 给无边框可缩放窗口补的不可见 resize 边框切出
   区域外，用户点不到边缘缩放。shape 必须用**整个窗口矩形**，圆角半径加上内容区 inset
   （多出 1–2px 的材质边，属可接受代价）。

## 结论与做法

- 清单新增（仅 desktop 槽位；edge-bar 只允许默认值，否则清单校验拒绝）：
  - `windowLevel: "floating"`（默认，兼容 0.5.1）/ `"normal"` / `"desktop"`；
  - `windowMaterial: "none"`（默认）/ `"acrylic"`。
- 用户层级覆盖写 `<userData>/plugin-widget-layout.json` 的可选 `windowLevelOverride`
  （布局 version 仍 1，不进 settings、不升 `CONFIG_VERSION`）；设置页每个桌面 widget 一枚
  层级下拉，走 `plugins:setWidgetWindowLevel`，已创建窗口原地应用、不重建。
- `desktop` 实现：不置顶；创建后异步用 PowerShell P/Invoke 把窗口 owner
  （`GWLP_HWNDPARENT = -8`）指向 `SHELLDLL_DefView`；同时监听 `minimize`，在 Win+D / Win+M /
  任务栏「显示桌面」后 `restore()` + `showInactive()`（2 秒内最多 3 次，超过标记
  `desktopGuardFailed` 按 normal 回落）。owner 失败只记日志，恢复守护继续兜底。
- Acrylic 实现：建窗时先 `setBackgroundMaterial('acrylic')`；加载完成后用
  `widgetRoundedShape()`（四角 1px 阶梯，半径 20 = `--radius-lg`）裁窗口 shape；裁失败就
  `setBackgroundMaterial('none')` + `setShape([])` 回落不透明。材质成功才给页面 URL 带
  `?material=acrylic`，之后外观开关变化走 `plugins:widgetMaterial` 事件；渲染层只在
  `:root[data-glass='on']` + `[data-material='acrylic']` 下映射玻璃令牌。
- **PowerShell 的 `$null` 坑（实测）**：P/Invoke 调 .NET 方法时 PowerShell 会把 `$null`
  转成空字符串传给 `string` 参数，`FindWindow('Progman', $null)` 恒返回 0（表现为永远
  `no-shell-view`）。必须传 `[NullString]::Value`；回归护栏在
  `widget-desktop-layer.test.ts` 的 `expect(script).toContain('[NullString]::Value')`。
- 验证基线（2026-10-24）：`pnpm test` 195 文件 / 2834 用例全绿；
  `AURORA_SMOKE=1 pnpm dev` **243/243**（新增 4 条：清单默认值 / normal 覆盖 / desktop
  非置顶与 owner / auto 恢复置顶；本机 `desktopOwner=true`、`materialActive=true`）；
  `pnpm verify` 26/26（`version=36`、迁移 36/36）；定向截图
  `settings-plugins-detail` / `widget-desktop-plugin` 通过（widget 的 `data-material=acrylic`）。
