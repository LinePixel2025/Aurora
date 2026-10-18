---
date: 2026-10-18
title: 内置浏览器 Agent 工具（v35）：guest 归属、先 attach 后导航、CDP 输入与并发槽位
tags: [浏览器, Agent, Electron, CDP, webview, 并发, 配置, 坑]
source: 模型自动记录
---

# 内置浏览器 Agent 工具（v35）

## 现象

1. **页面加载期的 console 全丢**：最初让渲染层建好 webview 就加载目标页，主进程 attach 后
   再读控制台，只读到 Electron 的安全警告；夹具页自己的 `console.error` 一条都没有。
2. **`Input.insertText` 不落到输入框**：`browser_act(type)` 后页面读回空值（冒烟输出 `ok:`）。
   换逐字符 `Input.dispatchKeyEvent(type:'char')` 仍然不落；点击（`Input.dispatchMouseEvent`）却正常。
3. 主进程没有任何路径能「按 tabId 找到 guest」：`did-attach-webview` 只是拿到 guest，没记 id；
   渲染层的 `tabId` 只在 `useCtxTabs` 里。
4. 并发没有上限：右栏标签最多 12 个（`CTX_TABS_MAX`），但 Agent 可以连续打开新标签，
   每个标签一个 Chromium 渲染进程，内存会线性上涨。

## 原因

- **先导航再 attach 必然漏日志**：`console-message` / `did-fail-load` 是 webview guest 上的
  事件，主进程要等渲染层回报 `webContentsId` 才能监听。页面在回报前就 load 完了，日志已经发生。
- **CDP 键盘事件依赖页面宿主焦点**：Electron 里 webview guest 的 DOM `focus()` 只改
  `document.activeElement`，不等于窗口/控件拿到系统键盘焦点；`insertText` 与 `char` 事件都可能
  被丢弃（鼠标事件不受这条限制）。所以「输入」必须校验落地并留兜底。
- **guest 归属不能靠 URL/标题猜**：同一 URL 可以开多个标签，标题也可重复；唯一可信的是
  渲染层回报的 `webContentsId`，再校验 `guest.hostWebContents.id === chat.webContents.id`。

## 影响

- 不修第 1 条：Agent 打开页面永远看不到加载期报错，网页测试的核心价值（找 console error）失效。
- 不修第 2 条：表单测试看起来「执行成功」但实际没输入，模型会基于错误状态继续操作。
- 不修第 3 条：会错误驱动用户自己的标签（顶掉用户正在看的页面），或把任意 guest 当成 Agent 的。
- 不修第 4 条：连开十几个网页直接顶爆内存；排队等名额还会自我死锁（同一 Agent 既持有旧会话又想开新的）。

## 结论与做法

- **Agent 标签先停在 `about:blank`**：渲染层建 webview → 回报 `webContentsId` → 主进程装好
  console/network 监听 → 再 `guest.loadURL(url)`。这是「能读到加载期日志」的唯一顺序，别改回去。
- **guest 定位**：渲染层在 `dom-ready` 里调 `webview.getWebContentsId()` 上报；主进程用
  `webContents.fromId` + `hostWebContents` 校验归属后才登记；`tabId` 只做记账，不参与定位。
- **输入**：先 JS `focus()`，再 CDP 逐字符 `dispatchKeyEvent(type:'char')`；然后**读回校验**
  （`el.value` / `contentEditable` 文本是否包含目标串），没落进去就用原生 `value` setter +
  `input`/`change` 事件兜底，并在结果文案里如实说明。`Input.insertText` 在 webview guest 上别用。
- **并发**：`createBrowserSessionSlots`（electron-free）做全局槽位，`maxCount` / `idleMs` 都是
  **live getter**；上限夹到 1..4（硬上限常量 4）；到上限**拒绝不排队**，错误文案给「先 browser_close」；
  空闲 N 分钟回调 manager 收会话；`browser_close` 只结束控制、**保留标签页**。
- **配置**：`agent.browser` 六字段（enabled / maxSessions / idleMinutes / allowPrivateNetwork /
  compatUserAgent / allowMedia），整组进 `SETTINGS_READONLY_PREFIXES`（AI 不可改）；关闭或切
  `readonly` 档时整组注销并 `stopAll`，避免留下 Agent 徽章。
- **兼容 UA 只作用于 Agent 标签**（`navigator.userAgent` 去掉 `Electron/x`、`Aurora/x` token），
  用户自己的标签保持原 UA；网页媒体权限默认拒，`allowMedia` 打开只对 Agent 控制的 guest 放行。
- **探针**：capture 的 `chat-browser-agent.png` 在 check 末尾要**关掉 Agent 标签**再返回，
  否则后续场景在「多一个标签 + 已释放会话」的残局上跑，容易出现互相污染的假红。
