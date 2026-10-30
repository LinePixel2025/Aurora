---
date: 2026-10-24
title: 插件界面启动空窗、Center 模型抢占默认模型与插件配置窗口
tags: [插件, 模型, 窗口, IPC, 坑]
source: 模型自动记录
---

## 现象

- 装带**页面型桌面小组件**的插件后重启：窗口显示「小组件暂无内容」、页面永不加载；同一次启动里另一张 widget 正常，说明是竞态而非清单 / 页面写错。
- 用户已把默认模型设为本机 provider，Center 页「官方模型 → 语言模型」开关一开，默认就被改回 `center-llm`，之后每次读取都是官方。
- 设置 → 插件里的「重启」点完像没反应：进程确实重启，但已打开的面板 / 页面 / 桌面小组件继续显示旧内容；配置表单挤在设置页详情里。

## 原因

- `main/index.ts` 曾在 `registerIpc()` 之前调 `widgetManager.sync()` 建小组件窗口：渲染层挂载即调 `plugins:list` / `settings:get`，此时没有 handler，`ipcRenderer.invoke` 直接 reject；`widget/App.vue` 的 `loadInfo()` 未捕获 reject，`onMounted` 在订阅 `plugins:changed` **之前**就中断，于是永久空窗。
- `syncPluginContributions()` 的 `plugins:changed` 只发给 chat / settings，没有发给 edge-bar、桌面小组件与新窗口；`PluginPageFrame` / `PluginPanel` 也没订阅，所以插件重启后已打开界面不重载。
- chat 的 `pendingPluginPageSrc` 曾是单例字符串：同时挂载两个页面型面板时 `will-attach-webview` / `did-attach-webview` 可能交叉，A 的 URL 被登记给 B guest。
- 默认模型被顶替：`center/aware-settings.ts` 每次 `get()` 都在官方 llm 开启时写 `next.llm.active = 'center-llm'`；`agent-host.ts` 的 provider factory 又有一层「official.enabled 就优先官方」；`modelPickerCore` 同样把 Center 放在本机 active 之前。
- 重启只重启 `utilityProcess`，没有广播，设置页也没有成功反馈。

## 影响

- 启动竞态 = 插件界面永久不可用，且报错只有主进程 stderr；用户无法自愈。
- `llm.active` 被读时改写 = 用户选的默认模型被静默覆盖，配置页显示与实际不一致。
- 不广播 = 重启 / 安装 / 信任变化后旧界面继续跑旧清单。

## 结论与做法

- **`llm.active` 是全局默认唯一事实来源**：`createCenterAwareSettingsStore` 只对 `imagegen / tts / stt` 做读时覆写，**不碰 `llm.active`**；`createProviderFactory` 只有 `llm.active === 'center-llm'` 才构造官方 Provider，并用 `resolveOfficialModelEntry`（选中 → defaultModel → 首个）取模型与参数；`modelPickerCore` 的全局解析顺序改为「active 指向官方才 Center，否则本机」；会话覆盖优先级不变。
- **Center 页 LLM 开关语义**：首次开启（false → true）或从 Center 页显式改模型时把 `llm.active` 切到 `center-llm`；关闭时若默认仍是官方，回落到首个可用本机 provider（没有则置空）；用户在本机默认时开关启停不覆盖 active。
- **小组件窗口必须在 `registerIpc()` 之后创建**：`WidgetManager` 有 `ready` 门，装配层在 `registerIpc` 之后调 `markReady()`（`main/index.ts:3127`）；渲染层同时「先订阅、再加载」+ 有界重试，竞态再出现也能自愈。
- **`plugins:changed` 全量广播**（`main/index.ts:6667`）：chat / settings / edge-bar / plugin-config 与全部桌面小组件窗口；页面型面板 / 小组件重载 webview，声明式面板重拉 schema。重启按钮的可见效果依赖它。
- **插件配置窗口 `plugin-config`**：设置列表只保留总览 / 启停 / 「配置」入口；配置、桌面小组件显隐 / 层级、权限与扩展点、重启 / 回滚 / 卸载收进单例窗口（880×760，`plugins:openWindow` + `plugins:windowRequest`，`showWithPayload` 等页面加载后推送）。
- **页面 src 按 partition FIFO**（`main/page-protocol.ts:150-171`）：同插件多页面并发挂载不串队；不同插件 / 浏览器 guest 不消费彼此的队列项。
- 复现启动期插件界面：复制真实 userData 到临时目录 → 用构建产物加 `--user-data-dir=<temp> --remote-debugging-port=9333` 启动 → 打开 `http://127.0.0.1:9333/json`，每个页面型 widget 都应有 `aurora-plugin://` target，且主进程 stderr 无 `No handler registered`。
