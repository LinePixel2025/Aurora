---
date: 2026-11-10
title: 插件临时对话框：可键入、结算即销毁；与小组件 focusable 取舍相反
tags: [插件, 对话框, Electron, 窗口, IPC, webview, 探针, 坑, 口径]
source: 模型自动记录
---

# 插件临时对话框（`contributes.dialogs` / `ui.dialogs`）

## 现象

桌面小组件窗口固定 `focusable: false`（点击不抢前台），代价是卡内文本输入拿不到键盘焦点。
插件需要用户键入文字 / 做一次选择时没有入口；若改成可激活又会破坏「不打扰」的桌面口径。

## 原因

窗口能不能输入文字由 `BrowserWindow.focusable` 决定，和组件本身无关：
小组件为了不抢前台必须不可激活，因此输入控件天然拿不到键盘焦点。两者需求相反，
只能是**两扇窗**，不能在同一扇窗上兼顾。

## 影响

- 把小组件改成 `focusable: true` 会立刻回归「点一下就把 Aurora 顶到前台」的旧问题；
- 没有临时窗口时，插件只能让用户去右栏面板输入，工具链在桌面上不可用；
- 对话框若常驻 / 写几何，会变成第二个「桌面小组件」，用户无法预期。

## 结论与做法（长期口径）

- 清单：`contributes.dialogs` ≤ 4，`schema` 与 `entry` 二选一；`defaultSize` 320–900 × 160–800；
  权限 `ui.dialogs`（`permissions.ts` / 清单校验 / dev-kit / 三份 d.ts 副本同步）。
- 运行期：`ctx.ui.openDialog({ dialogId, params? })` → 窗口销毁后返回
  `{ submitted, values, data? }`；开放方法 `dialog.invoke`，插件可选实现
  `invokeDialog(dialogId, method, params, ctx)`，`params = { params, values, init }`。
- 窗口（唯一创建入口 `main/plugins/dialogs.ts`）：
  **`focusable: true`**、无边框、居中、不可缩放；确定 / 取消 / × / Esc / 10 分钟 /
  插件进程退出都 **`destroy()`**，不写布局、不常驻；每插件同时 1 扇、全局 ≤ 4 扇。
- 声明式：宿主画「取消 / 确定」；点确定时渲染层先拿 `dialogData('submit')` 结果，
  再由**渲染层**调 `closeDialog({ submitted, values, data })` 结算。
  不要在 `dialogData` handler 里直接销毁窗口——IPC 回执会和窗口销毁竞争。
- 页面型：`entry` 复用 `aurora-plugin://` 沙箱；页面 URL 带 `?dialog=<id>`，
  `pageRpc` 带 `dialogId`，guest 登记与校验都要带 dialogId；插件返回 `{ close: true }` 才关闭。
- 错误口径：`dialogData` 已有静态 schema 时**不要静默吞错**（与 widgetData 不同）——
  返回 `{ schema, error }`，让等待中的用户看到校验失败；`close: false` 保留窗口。

## 踩过的坑（实测）

1. **对话框渲染层启动即调 `plugins:dialogInfo`**：`PluginDialogManager` 必须在
   `registerIpc()` 之后 `markReady()`（与小组件同一竞态）；`open()` 要等 ready 后**再查一次**
   插件是否仍启用 / 声明了该对话框。
2. **页面型 guest 的归属**：`registerPluginPageGuest` 原先只解析 `?widget=`；必须同时解析
   `?dialog=` 并在 `plugins:pageRpc` 里校验 `guest.dialogId === request.dialogId`，
   否则页面请求会被当成「面板页面」或直接拒绝。
3. **连续截图场景的竞态**：check 在截图后点「确定 / 提交」，下一条场景若立刻 `openDialog`，
   上一条还没收到 IPC 回执就被按取消结算（实测插件命令拿到「已取消」）。
   修法 = `capture` 对 `target.dialog` 在本轮 check 后 `await wait(400)`，下一条的
   `openDialog` hook 再先等最多 1.5s 让旧窗自然关闭，之后才强制取消。
4. **页面型提交要等 IPC**：页面 check 里用 `webview.executeJavaScript("...click()")`
   同步发起提交，不要用 80ms `setTimeout`——最后一条场景会随 app 退出被取消。
5. **工具里等待用户输入会被默认 60s 工具超时打断**：用 `openDialog` 的工具要把清单
   `timeoutMs` 调大；工具超时不会关闭窗口，但本次调用失败（docs/14 §5.8 已注明）。
6. 对话框只在本机，不上报 Center；没有远程批准 / 页面镜像。

## 验证基线（2026-11-10）

- `pnpm typecheck` / `pnpm test`（3121 用例，中心 server 有一次 flake，重跑全绿）/ `pnpm build` 通过；
- 清单 / 管理器 / 几何单测：`manifest.test.ts`、`manager.test.ts`、`dialog-window.test.ts`；
- 真机定向截图：`AURORA_CAPTURE=<独立目录> AURORA_CAPTURE_WINDOWS=dialog AURORA_CAPTURE_ONLY=plugin-dialog pnpm dev`
  → `plugin-dialog.png`（声明式真实键入 + 确定，插件命令返回「已记录随记…」）与
  `plugin-dialog-page.png`（自定义 HTML/CSS，页面内提交，返回「页面窗口收到…」）2 条 PASS；
  `dialog` 不在四窗默认名单，纳入全量单轮时把 `dialog` 加进 `AURORA_CAPTURE_WINDOWS`。
- 示例插件 `examples/plugins/hello-aurora` 已带 `/hello-note` 与 `/hello-page-note` 两条命令。
