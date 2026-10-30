---
date: 2026-10-04
title: 客户端性能轮：渲染、会话内存、心跳与重依赖的长期口径
tags: [性能, 测试, 探针, 会话, 坑]
source: 模型自动记录
---

# 客户端性能轮（2026-10-04）

## 现象

- 前台窗口探针每 5s 新建 PowerShell 并现场 `Add-Type`（单次约 1s 级 CPU）。
- 流式 markdown 对增长中的代码块每帧整块重跑 highlight.js（45KB TypeScript 约 145ms，未知语言 `highlightAuto` 5KB 约 300ms）。
- `SessionStore.summaries()` 把磁盘上每个会话的消息都常驻内存且永不淘汰。
- 聊天窗口常驻 60fps rAF 心跳；对话图片把原图整张 base64 读进渲染层。

## 原因

- 定时轮询把「昂贵采集」变成常驻成本；渲染路径对每帧 / 每 token 做全量工作；内存缓存无上限。
- 主进程静态 `require` 重依赖：`electron-updater` ≈16MB RSS / 190ms、`systeminformation` ≈8MB / 89ms、`chokidar` ≈4MB / 47ms。

## 影响

- 空闲也持续烧 CPU，长会话内存线一路上升，多图会话可到几百 MB；启动变慢。

## 结论与做法

下列每一条改回去都会重新变成性能事故。

1. **前台窗口探针不挂后台定时器**：`PerceptionHub` 删除 5s `setInterval`，只保留 `foregroundTtlMs`（默认 60s）的非阻塞懒刷新；首次未探测完成按 `unknown` 展示。
2. **流式渲染两段式**：未收盘（`message.pending === true`）的消息 markdown 重解析节流到约 80ms，且 `renderMarkdown(..., { highlight: false })` 整体跳过高亮；`done` / `error` 收盘后再按完整内容高亮一次。`MAX_HIGHLIGHT_CHARS`（40KB）、`AUTO_HIGHLIGHT_MAX_CHARS`（2KB）之外一律转义纯文本。
3. **会话内存有界**：`SessionStore` 的 `maxLoadedSessions`（默认 8）+ `loadedIdleMs`（默认 5 分钟）做 LRU；脏的 / 有待写定时器的 / 在读盘的永不淘汰。⚠️ **不能拿 `writing` map 当「正在写盘」判据**：它保留的是已结算的 promise，用它判会形成「淘汰永远不生效」的死代码。
4. **`summaries()` 不再常驻全部会话**：`summaryCache` 命中不读盘；未装载过的会话「读盘 → 算摘要 → 立即释放消息」，`metaCache` 保留；任何 `scheduleWrite` 都失效对应摘要缓存。
5. **滚动心跳按活跃度分档**：`useStickToBottom` 只在最近 1.2s 内有 DOM 变更 / 尺寸变化 / 用户滚动 / 程序贴底时走逐帧 rAF，空闲降到 250ms；结构校对先用缓存容器的 `contains(contentEl)` 校验，不再每帧 `findScroller`。**不要再改回常驻 60fps rAF**。
6. **图片按需 + 缩略**：`DisplayImageGallery` 用 IntersectionObserver（rootMargin 300px）进视口附近才读；`chat:readDisplayImage` 带 `maxDimension`（列表 720），主进程用 `nativeImage` 缩到该边长再回 data URL。原图最大 10MB。
7. **右栏浏览器隐藏回收**：连续 10 分钟未激活导航到 `about:blank` 释放 guest，标签 / 地址 / 标题保留；终端保留 shell（scrollback 5000 行硬上限），文件面板无本地状态。
8. **ClassIsland 有 TTL**：provider 内置 `cacheTtlMs`（默认 10s），TTL 内 `getToday` 不读文件 / 不发 HTTP；`refreshIfStale` 与「测试连接」走 `force` 穿透。
9. **配置热路径不深拷贝**：`SettingsStore.snapshot()` 返回只读当前快照，内核上限类 getter 都走它；`get()` 仍是深拷贝，只给设置页 / 迁移等低频路径。
10. **chat 事件只推主界面**：`ipc.ts` 的 eventBuffer 不向提示条发送对话事件；提示条快速对话删除后，常驻 8px 渲染进程不会被流式 delta 唤醒。
11. **字符预算要算工具参数且宽容畸形数据**：`messageWeight` 把 `toolCalls[].arguments` 计入预算；读取时用 `typeof === 'string'` 守卫，别直接 `.length`。
12. **electron-updater 懒加载**（`updater-port.ts`）：只有已打包应用在 20s 自动检查或手动检查时才 `import('electron-updater')`；下载进度监听先记本地 Set，模块加载后统一转发。
13. **感知采集首次消费才激活**（`perception.ts`）：`start()` 不做首次采集、不起定时器；第一次 `summary()` 才并行采电源 + 网络；`systeminformation` 也是 `import()` 懒加载；DNS 探测超时 800ms。
14. **chokidar 懒加载**（`file-watcher.ts`）：只有真正 `watch(dir)` 时才 `import('chokidar')`；未启用感知 / 未配置 `watchDir` 的进程不加载。
15. **提示条收起态不拉感知、不读历史**：`bootstrapApp` 不再 `trackPerception`，展开时才 `perception.refresh()` + 30s 轮询；8px 竖条不再迫使主进程加载 `systeminformation`。

- 爆发判据用 **`secondMax*` + 灾难闸门**（`capture.ts:6640-6659`）：去掉最大一个后的第二大值仍须在稳态线内，绝对上限只挡单帧灾难；不要只拿最大心跳 / 帧距的单阈值下结论。
- 基线：`pnpm test` 2928；桌面全量截图 113（仅范围外 `chat-model-picker` 恒红）；Center `verify:web` 106/106。历史性能数字（启动 244ms / RSS 377MB 等）是 2026-10-04 快照，不作现基线。
