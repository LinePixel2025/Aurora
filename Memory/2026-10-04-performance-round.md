---
date: 2026-10-04
title: 客户端性能轮：探针 / 流式渲染 / 会话内存 / 心跳 / 图片 / 轮询的长期口径
tags: [性能, CPU, 渲染, 内存, 坑]
source: 模型自动记录
---

# 客户端性能轮（2026-10-04）

## 背景

用户要求审查并修复 Aurora 客户端的 CPU / 渲染 / 内存性能问题。审查定位到五类大头：
前台窗口探针每 5s 新建 PowerShell 并现场 `Add-Type`（单次约 1s 级 CPU）、流式 markdown
对增长中的代码块每帧整块重跑 highlight.js（实测 45KB TypeScript 约 145ms、未知语言
`highlightAuto` 5KB 约 300ms）、`SessionStore.summaries()` 把磁盘上每个会话的消息都
常驻内存且永不淘汰、聊天窗口常驻 60fps rAF 心跳、对话图片把原图整张 base64 读进渲染层。

## 结论与做法（改回去会重新变成性能事故）

1. **前台窗口探针不挂后台定时器**：`PerceptionHub` 删除 5s `setInterval`，只保留
   `foregroundTtlMs`（默认 60s）的**非阻塞懒刷新**（`summary()` 消费时触发）。
   PowerShell 探针本身不变，但空闲时不再持续烧 CPU；首次未探测完成按 `unknown` 展示。
2. **流式渲染两段式**：未收盘（`message.pending === true`）的消息 markdown 重解析节流到
   ~80ms，且 `renderMarkdown(..., { highlight: false })` **整体跳过高亮**；`done` / `error`
   收盘后再按完整内容高亮一次。`highlightCode` 对超过 `MAX_HIGHLIGHT_CHARS`（40KB）的
   代码块、以及未知语言且超过 `AUTO_HIGHLIGHT_MAX_CHARS`（2KB）的文本一律转义纯文本；
   `highlightAuto` 只保留给很短的无语言片段。
3. **会话内存有界**：`SessionStore` 的 `maxLoadedSessions`（默认 8）+ `loadedIdleMs`
   （默认 5 分钟）做 LRU 淘汰；脏的 / 有待写定时器的 / 在读盘的永不淘汰。
   ⚠️ **不能拿 `writing` map 当"正在写盘"判据**：它保留的是已结算的 promise（串行写盘
   队列的队尾），用它判会形成"淘汰永远不生效"的死代码；真正的在途写在 `dirty` 清除前
   都受保护。
4. **`summaries()` 不再常驻全部会话**：`summaryCache` 命中就不读盘；未装载过的会话
   「读盘 → 算摘要 → 立即释放消息」（`metaCache` 保留，`modelOverrideOf` / `projectOf`
   等同步读仍可用）。任何 `scheduleWrite` 都会失效对应摘要缓存。
5. **滚动心跳按活跃度分档**：`useStickToBottom` 只在最近 1.2s 内有 DOM 变更 / 尺寸变化 /
   用户滚动 / 程序贴底时走逐帧 rAF，空闲降到 250ms 一次；结构校对先用缓存容器的
   `contains(contentEl)` 校验，不再每帧 `findScroller`（每帧 `getComputedStyle`）。
   **不要再改回常驻 60fps rAF**。
6. **图片按需 + 缩略**：`DisplayImageGallery` 用 IntersectionObserver 进入视口附近才读；
   `chat:readDisplayImage` 请求带 `maxDimension`（列表 720），主进程用 `nativeImage`
   缩到该边长再回 data URL。原图最大 10MB，不缩尺寸直接 base64 会让多图会话常驻几百 MB。
7. **右栏浏览器隐藏回收**：浏览器标签连续 10 分钟未激活时导航到 `about:blank` 释放 guest
   进程，标签 / 地址 / 标题保留、再次激活按原地址重载；终端保留 shell（scrollback 5000
   行硬上限），文件面板无本地状态。
8. **ClassIsland 有 TTL**：provider 内置 `cacheTtlMs`（默认 10s），TTL 内 `getToday` 不再
   读文件 / 发 HTTP；`refreshIfStale` 判定过期与「测试连接」走 `force` 穿透。
9. **配置热路径不深拷贝**：`SettingsStore.snapshot()` 返回只读当前快照，agent loop 的
   `maxRounds` / `maxTotalTokens` / `autoContinueRounds` / 项目字节上限 getter 都走它；
   `get()` 仍是深拷贝（设置页 / 迁移等低频路径用）。
10. **chat 事件只推主界面**：`ipc.ts` 的 eventBuffer 不再向提示条发送任何对话事件。
    2026-10-05 提示条快速对话删除后，这一条比原先的“只对 quick 推给提示条”更彻底：
    常驻 8px 渲染进程不会被流式 delta 唤醒。
11. **字符预算要算工具参数，且必须宽容畸形数据**：`messageWeight` 把 `toolCalls[].arguments`
    计入预算；读取时用 `typeof === 'string'` 守卫 —— 截图 / 手工夹具的历史可能只有 `input`
    没有 `arguments`，直接 `.length` 会让整次 Agent 请求失败（本轮首次截图实测）。

## 第二轮：主进程重依赖按需加载（同日追加）

实测静态 require 成本：`electron-updater` ≈16MB RSS / 190ms、`systeminformation` ≈8MB / 89ms、
`chokidar` ≈4MB / 47ms。三个都不是启动必需，改为按需：

12. **electron-updater 懒加载**（`updater-port.ts`）：只有已打包应用在 20s 自动检查或手动检查时
    才 `import('electron-updater')`；`onDownloadProgress` 先把监听记在本地 Set，模块加载后
    再挂一条原生监听统一转发。开发态 / 未到检查点完全不加载。
13. **感知采集首次消费才激活**（`perception.ts`）：`start()` 不再做首次采集、不起定时器；
    第一次 `summary()` 才并行采电源 + 网络并启动周期任务。`systeminformation` 同时改为
    `import()` 懒加载；DNS 探测超时 2000ms → 800ms（首次 summary 会同步等待它）。
14. **chokidar 懒加载**（`file-watcher.ts`）：只有真正 `watch(dir)` 时才 `import('chokidar')`；
    未启用 ClassRoom 感知 / 未配置 `watchDir` 的进程不加载。文件监听相关测试仍走注入，
    另补了一条**真实 chokidar** 的回归（动态 import 的默认导出互操作别写坏）。
15. **提示条收起态不拉感知、不读历史**（`edge-bar/main.ts` + `App.vue`）：`bootstrapApp`
    不再 `trackPerception`；展开时才 `perception.refresh()` + 30s 轮询。提示条快速对话已于
    2026-10-05 删除，不再有 `chat.hydrate()` 这条恢复链。
    8px 竖条不再强迫主进程加载 `systeminformation` / 起 DNS 探测。

## 验证

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（2369 条）/ `pnpm build` 全绿。
- 桌面全量截图 80 项：78 PASS；仅剩既有红项 `chat-preview-tool` 与 `chat-archive`
  （本轮之前就有，见 `2026-10-03-chat-right-tabs-and-panels.md`）。`chat-stream`、
  `chat-trace-fold`、`chat-stream-burst` 全 PASS；爆发探针 `maxHeartbeatMs 123.9`
  （限 160）、`maxFrameGapMs 69.5`（限 110）、`longTaskCount 0`。
- Center 网页端 `verify:web`：80 场景 / 0 失败（暗浅两档）。
- ⚠️ 全仓 `format:check` 有 47 个**既有**未格式化文件（含 CRLF 口径差异），不是本轮引入；
  改完代码用 `npx prettier --check <改动文件>` 逐个确认，别全仓 `--write`。

第二轮空闲复测（生产构建、隔离 userData、onboarding + 收起提示条）：

| 指标 | 第一轮后 | 第二轮后 |
| --- | --- | --- |
| 启动（日志“启动→就绪”） | 610–693ms | **244ms** |
| 60s 应用 CPU | 1499ms / 2.50% 单核 | **765ms / 1.28% 单核** |
| 主进程 RSS | 127.5MB | **116.4MB** |
| 四进程 RSS 合计 | ≈400MB | **377.2MB** |
| 子 PowerShell 进程 | 0 | 0 |

第二轮收尾验证：`pnpm lint` / `typecheck` / `test`（2370 条，含新增的真实 chokidar 懒加载回归）/
`build` 全绿；桌面全量 capture **80/80 全 PASS**（含 `chat-stream` 系统状态、
`edge-bar-expanded`、`chat-stream-burst`，爆发探针最坏心跳 91.1ms / 最坏帧间隔 63ms）。
Center 本轮无 shared / browser 改动，沿用上一轮的 `verify:web` 80/80。
