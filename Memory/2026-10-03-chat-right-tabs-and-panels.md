---
date: 2026-10-03
title: 右栏多标签容器：一标签一面板、两档生命周期与三键让位
tags: [UI, 布局, 浏览器, 探针, 坑]
source: 模型自动记录
---

# 右栏多标签容器与面板口径

## 现象

- 「＋」在 DOM 里在、矩形也在，就是点不到：右栏被挤到 280px 时把 88px 当成硬下限，`＋` 被 `overflow: hidden` 裁掉。
- webview 里 `target="_blank"` / `window.open` 请求在图层就被丢掉，旧口径「同窗导航」又会把当前页顶掉。
- 两个终端标签共用同一条 PTY：主进程按窗口而不是按标签记账。
- 折叠标签的锚点被 `v-if` 摘掉 = 静默 FAIL：多个探针直接 `querySelector('[data-field="chat.ctx-tab-*"]').click()`。
- 标签条压住窗口三键：拖宽过渡的瞬时溢出画到了按钮底下。

## 原因

- 右栏是**浏览器式多标签容器**：一个标签 = 一个面板实例（追加实例 id 为 `files-2` / `browser-2`，首个沿用种类名）；「上下文」是单例。
- 面板生命周期**分两档**（设计，不是不一致）：文件 / 终端 / 浏览器**首次激活挂载后常驻**（切标签只是 `display:none`，网页不重载、xterm 不重建）；**上下文维持 `v-if`**。
- **88 是舒适宽、不是下限**：空间不够时标签让到 48，先把「＋N」「＋」两枚按钮的宽度留够。
- webview 的 `allowpopups` 决定 guest 的弹窗请求会不会送进主进程；终端要按 `terminalId` 记账才能一标签一 shell。
- 终端底色固定黑（用户口径）：`TerminalPanel` 只有一份 `XTERM_THEME`（`background: '#000000'`）与 `.tp-host { background: #000 }`，**不要再按 `prefers-color-scheme` 分两档**；`.xterm` 本身透明（xterm 把主题背景画进 canvas），判据取容器 + `.xterm-viewport`。

## 影响

- 失效表现为「点不到 / 看不到」，只查 DOM 存在性的探针全绿；把两档生命周期统一会打红既有断言。
- 终端共用 PTY、webview 顶掉当前页，都是用户能直接感知的功能性错误。

## 结论与做法

- 初始四标签「上下文 / 文件 / 终端 / 浏览器」（缺省激活上下文），`chat.ctx-new-tab` 开新标签；v36 起标签种类增加 **plugin**（同一 `(pluginId, panelId)` 只开一个，已存在则激活）。
- 溢出 = 固定 88px + 「＋N」菜单（`chat.ctx-tab-more`）+ 滑动窗口保证激活标签可见；总数上限 12，两枚按钮固定占宽 56（＋N 30 + ＋ 26）。标签条右端永远让 `--caption-w`（132px）且 `.ctx-tab-list` 带 `overflow: hidden`；两个菜单只**向下**弹，永远不进 caption 矩形。
- 折叠标签的锚点必须仍在 DOM：＋N 菜单内容用 `v-show` 常驻，别改成 `v-if` —— `chat-right-tabs` / `chat-preview-show` / `chat-file-project` / `chat-terminal` 四个场景都直接 click 锚点。
- 右栏 384px 缺省、可拖拽（localStorage `aurora.chat.ctxWidth`，不进 config schema）；左栏 240px 缺省（`aurora.chat.navWidth`），两侧共用 `startColumnResize`。
- `webviewTag` 只对 chat 窗口开启；BrowserPanel 用 `createElement('webview')` 绕开 Vue 编译器，`remove()` 只在关标签时发生。**webview 必须设 `allowpopups`**（开了也没有真弹窗）：`target="_blank"` / `window.open` 的 http(s) 目标走主进程 `setWindowOpenHandler` → `browser:openTab` → 渲染层另开一个浏览器标签；**只有 http(s) 放行**，file: / 自定义 / `about:blank` 一律拒绝。`@lydell/node-pty` 必须留在 electron-builder 的 `asarUnpack`。
- **终端每个标签一个 shell**：主进程按 `terminalId` 记账、每窗口上限 6、关标签 = kill 该 PTY；别改回「每窗口一个 shell」。终端是用户手动操作面，别给它接 AI 工具面或确认闸门（`show_preview` 走浏览器标签）。
- 文件 tab 是「小文件管理器 + 预览」：根 = 会话边界根（绑项目 → 项目文件夹，标签「项目：<名>」）；列目录 `preview:list`（上限 500、目录在前、数字感知排序），预览 `preview:read`，两条都在主进程侧做 `resolveWithin`，根不可用时直接拒绝。导航 = 浏览器式历史栈；四钮 `chat.file-back` / `-forward` / `-up` / `-refresh` 已图标化，预览态 `chat.file-exit` = 后退一步；面包屑 `chat.file-crumbs`（根段 `chat.file-root`），旧 `chat.file-dir` 已删。`show_preview` 的成果展示走浏览器 tab（`preview:show` 推送 → 自动切 tab）。
- 浏览器工具条是图标按钮：`chat.browser-back` / `-forward` / `-reload`（加载中变停止）/ `-home`，26×26 命中区、禁用态 `opacity 0.55 + --text-muted`。
- 右栏标签全关后，正文区只剩空态卡片区 `chat.tool-shortcuts` / `chat.tool-open-<kind>`（四张 = 上下文 / 文件 / 终端 / 浏览器），只在 `ctxTabs.length === 0` 时存在；点一张 = 展开右栏 + 开该种类标签。护栏 `chat-ctx-empty-tools` 排在 chat 组末尾。
- 三键与标签条共享右上角：`WindowCaption` 挂在 app-shell 直属、`position: fixed`；`--head-h` 48px 让标题栏与 tab 条同高，右栏收起时标题栏挂 `.head--corner` 让位。回归护栏 `chat-right-tabs` 的 `captionPinned` / `captionTabOverlap`。
