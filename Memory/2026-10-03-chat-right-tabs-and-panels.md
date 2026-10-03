---
date: 2026-10-03
title: 主界面右栏多标签容器与文件/浏览器/终端面板的既有口径
tags: [UI, 标签页, 终端, webview, 坑]
source: 模型自动记录
---

# 右栏多标签容器与三个面板

## 现象

1. **「＋」在 DOM 里在、矩形也在，就是点不到**（2026-10-03 用户实测）：右栏被挤到 280px 时，
   把 88px 当成硬下限，`＋` 被 `overflow: hidden` 裁掉。
2. **网页白屏 / 点链接没反应**：见 `Memory/2026-10-03-ipc-and-csp.md` 的 CSP 注入一条。
3. **webview 里 `target="_blank"` / `window.open` 请求在图层就被丢掉**，到不了 `setWindowOpenHandler`；
   旧口径又是「同窗导航」，点链接会把当前页顶掉。
4. **两个终端标签共用同一条 PTY**：主进程按窗口而不是按标签记账。
5. **刷新后页面上没有麦克风 / 朗读按钮**：镜像里打进了旧前端（见 Center 部署那条）。
6. **折叠标签的锚点被 `v-if` 摘掉 = 静默 FAIL**：多个探针直接
   `querySelector('[data-field="chat.ctx-tab-*"]').click()`。
7. **字形按钮被当成"没有按钮"**：文件工具条 `⟳ ⤴` 字形又细又淡；
   浏览器工具条禁用态 `opacity 0.35` 在浅色主题下几乎不可见（用户口径「没有刷新、上一步等按钮」）。
8. **旧断言 `jobsHiddenOnFiles`（files 下 `chat.jobs` 必须缺席）依赖"上下文面板用 `v-if`"**。

## 原因

- 右栏是**浏览器式多标签容器**（2026-10-03 二次修订，docs/07 §2.3）：一个标签 = 一个面板实例 ——
  文件 / 终端 / 浏览器可各开多个（追加实例 id 为 `files-2` / `browser-2`…，首个沿用种类名），
  **「上下文」是单例**（JobPanel + ContextPanel 收在它里面，旧探针零改动）。
- 面板生命周期**分两档**（这是设计，不是不一致）：文件 / 终端 / 浏览器**首次激活挂载后常驻**
  （切标签只是 `display:none` —— 网页不重载、xterm 不重建）；**上下文面板维持 `v-if`**（激活才挂载）。
- webview 的 `allowpopups` 决定 guest 的弹窗请求会不会被送进主进程；终端要按 `terminalId` 记账才能一标签一 shell。

## 影响

- 标签条 / 按钮的失效表现为"点不到""看不到"，而只查 DOM 存在性的探针全绿；
  把两档生命周期"统一"成一种会打红既有断言。
- 终端共用 PTY、webview 顶掉当前页，都是用户能直接感知的功能性错误。

## 结论与做法

初始四标签「上下文 / 文件 / 终端 / 浏览器」（**缺省激活上下文**），「＋」（`chat.ctx-new-tab`）开新标签；
**溢出 = 固定 88px + 「＋N」菜单折叠（`chat.ctx-tab-more`）+ 滑动窗口保证激活标签可见**
（**88 是舒适宽、不是下限**：空间不够时标签让到 48，先把「＋N」「＋」两枚按钮的宽度留够），总数上限 12。
宽度 384px 缺省、可拖拽（localStorage `aurora.chat.ctxWidth`，**不进 config schema**）；
左栏同样可拖拽（`aurora.chat.navWidth`，240px 缺省，与右栏共用 `startColumnResize`）。六条易踩点：

1. 两侧栏的 `--ctx-w` / `--nav-w` 装的就是**实际生效宽度**（详见 `Memory/2026-10-03-chat-shell-layout.md`），
   别再回硬编码。
2. **面板生命周期两档别统一**（见上「原因」）。
3. `webviewTag` 只对 chat 窗口开启（BrowserPanel 用 `createElement('webview')` 绕开 Vue 编译器；
   `remove()` 只在**关标签**时发生）。**webview 必须设 `allowpopups`**（开了也没有真弹窗 ——
   主进程对一切请求 `deny`）。**站点自开标签**：`target="_blank"` / `window.open` 的 http(s) 目标走主进程
   `setWindowOpenHandler` → `browser:openTab` 推送 → 渲染层**另开一个浏览器标签**加载它；
   **只有 http(s) 放行**，file: / 自定义 / `about:blank` 一律拒绝。
   `@lydell/node-pty` 必须留在 electron-builder 的 `asarUnpack`（.node 不能进 asar）。
   **终端每个标签一个 shell**（主进程按 `terminalId` 记账、每窗口上限 6、关标签 = kill 该 PTY）——
   别改回"每窗口一个 shell"。终端是用户手动操作面，**别给它接 AI 工具面或确认闸门**
   （`show_preview` 走的是浏览器标签，不是终端）。
4. `onHeadersReceived` 的 CSP 注入只作用自家窗口的页面 —— 见 `Memory/2026-10-03-ipc-and-csp.md`。
5. **标签条不得压三键**：`.ctx-tab-list` 永远右让 `--caption-w`（132px）且带 `overflow: hidden`；
   「＋」/「＋N」两个菜单只许**向下**弹（永远不进 caption 矩形）。护栏：`chat-right-tabs` 的
   `captionPinned` / `captionTabOverlap` + 场景 `chat-ctx-tabs` 的菜单矩形断言。
6. **折叠标签的锚点必须仍在 DOM 里**：＋N 菜单内容常驻（`v-show` 收起），别改成 `v-if` ——
   `chat-right-tabs` / `chat-preview-show` / `chat-file-project` / `chat-terminal` 四个场景都直接
   `querySelector('[data-field="chat.ctx-tab-*"]').click()`，锚点被摘掉就是静默 FAIL
   （或更糟：探针替应用做了决定）。

面板既有口径：

- **文件 tab 是「小文件管理器 + 预览」**（docs/07 §2.3）：根 = 会话边界根（绑了项目就是项目文件夹，
  标签「项目：<名>」；孤儿绑定按未绑定展示）—— 列目录走 `preview:list`
  （`apps/desktop/src/main/file-list.ts`，上限 500 条、目录在前、名称数字感知排序），预览走 `preview:read`，
  两条都在主进程侧做 `resolveWithin` 边界校验，**根不可用时直接拒绝**。
  **导航 = 浏览器式历史栈**：位置 `{ dir, file? }`，进目录 / 预览文件 / 点面包屑 / 上级 / 路径输入都是 push 一步
  （前进链截断）；工具条四钮 `chat.file-back` / `-forward` / `-up` / `-refresh` 已**图标化**
  （`ArrowLeft` / `ArrowRight` / `ArrowUp` / `RotateCw`），**别改回字形**；预览态「返回列表」
  （`chat.file-exit`）= 后退一步，无历史可退时退回当前目录列表。面包屑（`chat.file-crumbs`，
  根段 `chat.file-root`）末段即当前目录；旧的 `chat.file-dir` 锚点已删。
  `show_preview` 的「成果展示」走浏览器 tab（`preview:show` 推送 → 自动切 tab），**别把两件事混成同一条通道**。
- **浏览器 tab 的工具条是图标按钮**：`chat.browser-back` / `-forward` / `-reload`（加载中变停止）/ `-home`，
  26×26 命中区、禁用态 `opacity 0.55 + --text-muted`。
- 终端底色固定黑，见 `Memory/2026-10-03-ui-style-and-copy.md`。
- 部署侧"网页上没有麦克风 / 朗读按钮"的另一种成因见 `Memory/2026-10-03-center-remote-and-deploy.md`。

## 无标签页时的重开入口（2026-10-03 追加，2026-10-04 移右）

- 右栏标签**全部关掉**之后，右栏只剩标签条上的「＋」，重开要走「＋ → 菜单 → 选种类」两步。
  2026-10-03 起原先在左栏会话滚动区顶部补一组「工具」卡片；**2026-10-04 按用户要求迁到右栏正文区**
  （`chat.tool-shortcuts` /
  `chat.tool-open-<kind>`，四张 = 上下文 / 文件 / 终端 / 浏览器，图标与标签条同一套）；
  点一张 = **展开右栏 + 开该种类标签**（走 `onNewCtxTab` 同一条链路，含上限提示）。
- 卡片区**只在 `ctxTabs.length === 0` 时存在** —— 它就是「空态」本身，开出任意一个标签即消失；
  别把它做成常驻工具栏（有标签时只是占地方），也别再放回左栏。右栏正文区、两列网格、卡片高
  32px（与左栏固定项同一条命中线）。
- 护栏：capture 场景 `chat-ctx-empty-tools`（**排在 chat 组末尾** + prepare reload 回初始四标签，
  act 逐个点真实 ✕ 关掉全部，check 量四张卡片矩形 ≥ 80×30 + `elementFromPoint` 命中 +
  断言位于右栏且不在左栏，再点「文件」卡片把标签开回来、断言卡片区消失）。该场景会改标签集与面板挂载状态，
  所以别把它挪到 chat 场景组中间。

## 当前全量 capture 的两条红项（2026-10-03 实测，待查）

`AURORA_CAPTURE` 全量一轮（79 条截图 / 探针）退出码 2，`report.json` 里
`chat-preview-tool`（`blankOpened: false`）与 `chat-archive`（撤销归档后
`mainRows 2 / archiveRows 1`，但 `inMain` / `inArchive` 都是 false）两条探针的
`result.pass = false`。两条都在新增场景 `chat-ctx-empty-tools` **之前**执行、现场与左栏
工具卡片无交集，判断与本轮改动无关；下次排查先看这两条是不是竞态（读 DOM 早于列表刷新）。


