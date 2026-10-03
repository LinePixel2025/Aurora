---
date: 2026-10-03
title: 跨进程接线：reactive 代理不可克隆、CSP 两处注入、ClassIsland 契约
tags: [IPC, CSP, 渲染层, 坑]
source: 模型自动记录
---

# 跨进程与 CSP 接线点

## 现象

1. **点了没反应、也不报错**：跨 IPC 传 Vue `reactive` / `ref` 产出的 **Proxy** 会抛
   `DataCloneError: An object could not be cloned.`；若在异步 handler 里 `await` 它，错误就被吞成静默。
   `settings:update` 与 `chat:send` 的附件列表都踩过。
2. **开发能播、打包不能播**：渲染层播放合成音频依赖 CSP 的 `media-src 'self' blob:`，
   生产 CSP 的 `default-src 'self'` 会拦掉 `blob:`，而开发态 `default-src` 里本来就带 `blob:`。
3. **内置浏览器白屏、浏览器里点链接没反应**（2026-10-03 修）：`onHeadersReceived` 的 CSP 注入是**无条件**的，
   把 webview 里加载的外部页面一起打瘸（强加 `script-src 'self'` → 内联脚本 / CDN 资源全被拒）。
4. **`{ ...reactiveObj }` 只让顶层变纯**，嵌套子对象仍是 Proxy。

## 原因

- `ipcRenderer.invoke` 用结构化克隆传参，Proxy 不可克隆。
- 两类 CSP（开发态 / 生产态）与两类窗口（自家窗口 / webview 宿主的页面）各自需要不同的口径，
  一刀切就会在"某一端能跑、另一端不能跑"的地方出事。

## 影响

- 静默失败最难查：没有报错、没有日志，只表现为"按钮没反应"。
- CSP 的假阳性跨环境（开发 vs 打包）或跨窗口（自家页面 vs 内置浏览器），
  很容易被误判成"页面本身坏了"。

## 结论与做法

- 渲染层往主进程送对象前统一走 `deepClone()`（`@aurora/shared/browser`，内部 structuredClone → JSON 回落，
  正好把 Proxy 变成纯数据）；只传字面量 / 字符串的通道不用处理。
- 渲染层播放合成音频时，`main/index.ts` 的**两条 CSP 都要有** `media-src 'self' blob:`。
  TTS 出网必须走 `apps/desktop/src/main/net.ts` 的 `netFetch`（否则 `advanced.proxy` 对它无效），
  `TtsSynthesizer` 用 `resolveFetch` 注入；它**不得 import electron**，否则 vitest 收不了它的单测。
- **`onHeadersReceived` 的 CSP 注入只作用于自家窗口的页面**：按 `details.webContentsId` 是否属于
  `BrowserWindow.getAllWindows()` 判定 —— 别把它"简化"回无条件注入。
- ClassIsland 联动**只认 `apps/desktop/src/main/classisland.ts` 的 JSON 契约**，桥接端的实现细节不得泄漏到
  provider 与消费链；桥接数据的一切异常都必须降级为**空课表 + 告警**。
