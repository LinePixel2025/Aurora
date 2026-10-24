# Aurora 流光提醒（Banner Notification）— 编码 Agent 提示词

> 给编码 Agent 的任务书。动手前它会自己加载 `AGENTS.md` + `Memory/`（本文件只补“这个功能该怎么落地”的
> 需求、架构与接线点）。**全部文档与注释用中文**，遵循仓库既有口径（无分号 / 单引号 / 100 列 / 尾逗号 / LF）。

## 0. 目标一句话

在 Aurora 里新增一套**全新的提醒通道**——**流光提醒（Banner Notification）**，它**独立于**现有的：
- 系统弹窗（`NotificationService` / Electron `Notification`，`apps/desktop/src/main/notifications.ts`）
- ClassIsland 提醒（`classisland_remind`，`apps/desktop/src/main/classisland.ts` + `tools/classisland-remind.ts`）

触发时：**屏幕顶端出现「流光特效」（Apple Intelligence 风格的弥散光谱光带），提醒内容以「置顶弹窗卡片」
的形式从流光中浮现**，卡片分「标题 + 正文」，可选**语音朗读（走 Aurora 已配置的 TTS）**与**提示音效**。
该通道对 **插件系统、Agent 完成工作、Agent 向用户提问** 三类来源都可用。

---

## 1. 需求 → 验收口径（硬性，逐条验收）

| # | 需求 | 可验收口径 |
|---|---|---|
| R1 | 前端简约现代化 | 卡片 + 流光沿用 `packages/shared/src/browser/theme.css` 设计令牌（`--bg-overlay` / `--text-primary` / `--text-secondary` / `--radius-lg` / `--ease-spring` 等），**禁用品牌双色渐变**（`--aurora-gradient` 是纯强调色）；卡片视觉对齐 Apple HIG（克制的分层填充 + hairline + 大圆角 + 柔和阴影），不得出现霓虹彩带/拟物。 |
| R2 | 分「标题 + 内容」 | `BannerRequest` 必须含 `title` 与 `body` 两个字段，卡片渲染为两行结构（标题 semibold + 正文 secondary），缺正文时仍能显示标题。 |
| R3 | 可调用 TTS 语音提醒 | 复用 `main/tts.ts` 的 `TtsSynthesizer`（或渲染层复用 `window.aurora.tts.synthesize`），把 `title + body` 合成为语音并播放；**未配置 TTS（`tts.enabled=false` / `tts.active=''`）时静默跳过，不报错不重试**（口径同 docs/06 §13.5）。 |
| R4 | 要有提醒音效 | 播放一段简短提示音（推荐 **Web Audio 合成两声清脆音**，避免新增音频资产/CSP/打包负担；也可用打包内资源）。 |
| R5 | 三类来源都能调用 | ① 插件：新增 `ctx.banner(...)`（或扩展 `ctx.notify` 的 channel）；② Agent：新增内核工具 `notify_banner`（`sensitivity: 'safe'`）；③ 提问：`ask_user` 弹出提问卡时同步发一条流光提醒。三者都汇聚到同一个主进程 `BannerService.show()`。 |

---

## 2. 动手前先读（现状，全部真实存在，直接复用，别另起炉灶）

- `apps/desktop/src/main/notifications.ts` —— 系统通知服务：**去重 / 计数 / 注入 `present` 的模式照抄**。
- `apps/desktop/src/main/tts.ts` —— `TtsSynthesizer.synthesize({text}) → { audioBase64, mimeType }`；渲染层播放 base64。**不得 import electron**（可单测）。
- `apps/desktop/src/main/classisland.ts` + `apps/desktop/src/main/tools/classisland-remind.ts` —— 一条「桌面专用提醒工具」的完整装配样本（端口注入 + 可用性门控 + `safe`）。
- `apps/desktop/src/main/tools/notify.ts` —— 内核 `NotifyPort` → `NotificationService.notify` 的映射样本。
- `apps/desktop/src/main/tools/index.ts` —— `registerExtensionTools`（`notify_user` 在此注册，`EXTENSION_TOOL_NAMES` + `deps.notify: NotifyPort`）与 `registerAgentCoreTools`（`ask_user` 在此）。
- `packages/agent-core/src/tools/notify.ts` + `tools/ask-user.ts` —— 内核工具 + 端口接口的写法样本（`AskUserPort` 在 ask-user.ts）。
- `apps/desktop/src/main/window-manager.ts` 的 `ensureAwarenessGlow` / `showAwarenessGlow` / `hideAwarenessGlow` —— **内部窗口**（不在 `WINDOW_NAMES` 里、无 windowState 状态机）的建窗/置顶/穿透/销毁样本，照抄它的窗口参数（`frame:false`/`transparent:true`/`alwaysOnTop:true`/`skipTaskbar:true`/`focusable:false`/`backgroundColor:'#00000000'` + `setIgnoreMouseEvents(true,{forward:true})`）。
- `apps/desktop/src/renderer/awareness-glow/`（`main.ts` / `App.vue`）—— 流光渲染样本（光谱色板、`applyAppearance`、关键帧），**只参考其视觉，不共用其类名/状态机**。
- `apps/desktop/src/main/plugins/manager.ts` 的 `PLUGIN_CLIENT_CALLS.notify`（约 1335 行）—— 插件 RPC 白名单方法样本；`options.notify` 注入点。
- `apps/desktop/electron.vite.config.ts` 的 `windowEntries` —— 新增渲染窗口入口在此登记。
- `packages/shared/src/ipc/channels.ts` + `apps/desktop/src/preload/channels.ts` —— IPC 通道表（**双向编译期断言**，漏改任一侧 `pnpm typecheck` 报错）。
- 记忆必读：`Memory/2026-10-16-awareness-glow-apple-spectral.md`（光谱色板口径）、`Memory/2026-10-05-edge-bar-topmost-watchdog.md`（置顶 screen-saver + watchdog）、`Memory/2026-10-03-ipc-and-csp.md`（CSP `media-src 'self' blob:` 两条都要有）、`Memory/2026-10-24-plugin-*.md`（插件清单/RPC/推送口径）。

---

## 3. 推荐架构（照着做，别另想一套）

```
来源层                    主进程                         渲染层
┌─────────────┐   ┌──────────────────────────┐   ┌──────────────────────────────┐
│ 插件 ctx.banner │─▶│  BannerService.show()    │─▶│ banner 窗口（自绘流光 + 卡片） │
│ Agent notify_banner│─▶│  · 队列 / 去重 / 落日志    │   │  · Web Audio 提示音          │
│ ask_user 提问    │─▶│  · 调 TTS 合成（可选）     │   │  · 调 tts:synthesize 播放语音 │
└─────────────┘   │  · 驱动 window-manager     │   │  · 自动淡出 / 点击关闭        │
                  └──────────────────────────┘   └──────────────────────────────┘
```

- **BannerService**（`apps/desktop/src/main/banner.ts`，纯逻辑、不 import electron、可单测）：
  像 `NotificationService` 一样用**注入**接窗口显示（`present`）、TTS 合成、音效开关；内置**队列**（同时只显示一条，其余排队）与**去重**（`dedupeKey`，短窗去重），`show(request): { ok, reason }`。
- **窗口管理**（`window-manager.ts`，唯一 import electron 的窗口模块）：新增 `showBanner(request)` / `hideBanner()` / `isBannerVisible()`。推荐**两扇窗**（各自职责单一，且都是本仓库已验证的模式）：
  1. **`banner-glow`**：覆盖整块显示器、**完全鼠标穿透**的透明窗口，只在**屏幕顶端**画一条光谱流光带（参考 awareness-glow 的视觉，几何用 `display.bounds` 而非 `workArea`，避免任务栏缝隙）。
  2. **`banner-card`**：一张**紧凑置顶卡片窗**，水平居中、贴顶下浮（从流光中“落下”），`frame:false/transparent:true/alwaysOnTop:true/skipTaskbar:true`，**不穿透**（卡片上的“关闭”按钮要能点），`focusable:false` + `showInactive()`（不抢焦点），超时自动 `hide()`。
  - 若你确定能稳妥处理“整窗穿透 + 仅卡片区域可点”，可合并为一扇窗；否则用两扇，**别硬来**。
  - 置顶一律 `setAlwaysOnTop(true, 'screen-saver')` + 监听 `always-on-top-changed` 恢复（照抄 edge-bar watchdog 口径）。
- **渲染层**（`apps/desktop/src/renderer/banner/`，`index.html` + `main.ts` + `App.vue`）：
  - `main.ts` 接 `applyAppearance`（读一次 `settings:get` + 订阅 `settings:changed`，零 Pinia，照抄 awareness-glow/main.ts）。
  - `App.vue`：流光层 + 卡片层。收到 `banner:show` 推送后：先播提示音 → 若 `speak` 为真且 TTS 已配置则 `tts:synthesize` 后播放语音 → 渲染标题/正文 → 入场动效 → 超时/点击关闭时 `banner:dismiss` 回主进程。
  - 提示音：Web Audio 合成（推荐）；语音：`window.aurora.tts.synthesize({ text: title + '。' + body })` 播放返回的 `audioBase64`（`atob` + `Blob` + `audio.play()`，MIME 用返回的 `mimeType`）。
  - 尊重 `prefers-reduced-motion`（流光动画降级为静态/关闭）。
- **IPC**（`shared/src/ipc/channels.ts` + `preload/channels.ts` 双侧同步）：
  - `banner:show`（主 → banner 渲染层，推送，`on/off` 成对）
  - `banner:dismiss`（渲染层 → 主，invoke，用户关闭/超时上报）
  - 类型 `BannerRequest` / `BannerDismissResult` 放 `packages/shared/src/ipc/types.ts`。

---

## 4. 分阶段实施清单（每阶段可独立验收）

### Phase 0 — 文档先行（Docs-first，硬规则）
先改再写码：`docs/07-ui-spec.md`（§2 窗口规格补 banner 窗口、§4 通知与反馈补“流光提醒”）、
`docs/06-agent-core.md`（§14 扩展工具补 `notify_banner`）、`docs/02-architecture.md`（§6 IPC 契约补 `banner:*`）、
`docs/15-plugin-development-guide.md`（权限表 + `ctx` 补 `banner`）。**若新增配置字段**：`docs/08-settings-onboarding.md` §1。

### Phase 1 — IPC 契约 + preload
1. `packages/shared/src/ipc/types.ts` 加 `BannerRequest { title; body; speak?; sound?; durationMs?; dedupeKey?; level? }`（字段名/类型自定但 title+body 必填）、`BannerDismissResult`。
2. `channels.ts` 双侧加 `banner: { show; dismiss }`。
3. `preload/index.ts` 暴露 `window.aurora.banner = { onShow(cb): unsub, dismiss(): Promise<Result> }`（照抄既有 preload 结构）。
4. `pnpm typecheck` 过。

### Phase 2 — 主进程 BannerService + 窗口管理
1. `apps/desktop/src/main/banner.ts`：`BannerService`（队列/去重/注入 `present`、`synthesize`、`playSound` 可空），**不 import electron**，纯逻辑 + 单测 `banner.test.ts`。
2. `apps/desktop/src/main/window-manager.ts`：`ensureBannerGlow()` / `ensureBannerCard()` / `showBanner(request)` / `hideBanner()`（置顶 screen-saver + watchdog + 多显示器用 `edgeBarDisplay()` 或主显示器）。
3. `apps/desktop/src/main/index.ts`：装配 `BannerService`（注入窗口 present + `TtsSynthesizer` + 音效开关），接 IPC `banner:show` 推送 / `banner:dismiss` 处理。
4. 单测：service 队列/去重/降级；窗口管理置顶/穿透断言（照抄 `window-manager` 既有测试与 `main/awareness-glow.test.ts`）。

### Phase 3 — 渲染层 banner 窗口
1. `electron.vite.config.ts` `windowEntries` 加 `banner: r('src/renderer/banner/index.html')`。
2. 实现 `renderer/banner/`（main.ts / App.vue）：流光 + 卡片 + 提示音 + TTS 播放 + 自动淡出 + 关闭上报。
3. **CSP**：确认 `main/index.ts` 两条 CSP 都有 `media-src 'self' blob:`（TTS 播放依赖，缺失则打包态不播）。
4. 视觉自检：`$env:AURORA_CAPTURE_ONLY='banner'; pnpm dev` 定向截图（见 Phase 6）。

### Phase 4 — 三个调用入口
1. **Agent 工具 `notify_banner`**：
   - 内核：`packages/agent-core/src/tools/banner-notify.ts` 定义 `BannerNotifyPort { show({title, body, speak?, sound?}): Promise<{ok, reason?}> }` + 工具（`sensitivity:'safe'`，参数 `title`/`body` 必填、`speak`/`sound` 可选），照抄 `tools/notify.ts`。
   - 主进程：`apps/desktop/src/main/tools/banner-notify.ts` 提供 `createBannerNotifyPort(BannerService)`；在 `tools/index.ts` 的 `registerExtensionTools` 里注册（加 `EXTENSION_TOOL_NAMES` + `deps.banner: BannerNotifyPort`）。
   - **门控口径**：与 `notify_user` 同级——**不受 `agent.tools.enabled` 门控**、`safe`（只弹提醒不碰文件/系统状态）。更新 `docs/06 §14` 工具表。
2. **ask_user 提问**：
   - 在 `ask_user` 提问卡片弹出时（`apps/desktop/src/main/ask-user.ts` 的 `ask()` 里 `present()` 之前，或装配层 `onRequest` 处）同步调 `BannerService.show({ title: header ?? 'Aurora 提问', body: question, speak:false, sound:true })`；**仅当交互窗（chat）未聚焦/未可见时**才发（避免用户正看着卡片还弹一条重复打扰）。子代理不问用户（既有过滤已保证）。
3. **插件 `ctx.banner`**：
   - `packages/shared/src/plugin/manifest.ts` / `permissions.ts`：复用 `notifications` 权限（推荐）或新增 `banner` 权限；`docs/15` 权限表同步。
   - `apps/desktop/src/main/plugins/manager.ts`：加 `PLUGIN_CLIENT_CALLS.banner` → 校验权限 + 长度截断（title ≤120 / body ≤800，照抄 notify）→ `options.banner` 注入。
   - 宿主装配：把 `BannerService.show` 作为 `options.banner` 注入 plugin manager。

### Phase 5 — 设置面（可选，建议做最小化）
- v1 可**不新增配置**：用请求级 `speak`/`sound`/`durationMs` + 合理默认（如 6s 自动关闭、`speak` 默认跟随 TTS 配置、`sound` 默认开）。
- 若要做用户开关（如 `notifications.banner.enabled`/`duration`/`speak`/`sound`）：**必须走 `CONFIG_VERSION` 迁移链**（`schema.ts` + `migrations.ts` + docs/08 §1 + `pnpm verify` 断言版本/迁移条数），并把 `notifications.banner` 的敏感/只读口径按 `SETTINGS_READONLY_PREFIXES` 判断是否需要加。

### Phase 6 — 测试与验收（提交前必过）
- `pnpm typecheck && pnpm test && pnpm build`（全绿；新增单测覆盖 BannerService / `notify_banner` 工具 / 窗口置顶穿透 / 插件 RPC 权限）。
- 冒烟：`$env:AURORA_SMOKE='1'; pnpm dev`（**先确认当前基线全绿再动被测代码**；新增 banner 断言：默认不显示、show 后可见、hide 后不可见、`notify_banner` 工具在工具表）。
- 截图：`capture.ts` 加 `banner` 场景（探针只量矩形不量存在、不写反引号/反斜杠正则；内部窗口走 `captureWindows` 现取，参考 awareness-glow / widget 的取窗方式），迭代期 `AURORA_CAPTURE_ONLY='banner'` 定向、最后全量。
- Center 端未改 `packages/shared/src/browser/**` 则无需跑 `verify:web`；若动了令牌/图标，两端截图都要跑。

---

## 5. 硬性接线点与踩坑（每条都来自项目记忆，务必遵守）

1. **agent-core / modes 不 import electron**：内核工具只定义端口，系统能力（窗口/TTS/音效）主进程注入。
2. **preload 自包含**：改 IPC 必须 `shared/ipc/channels.ts` + `preload/channels.ts` **同时改**（编译期双向断言）。
3. **主进程内联工作区包**：`@aurora/*` 纯 ESM，别在 `electron.vite.config.ts` 把 `externalizeDepsPlugin` 的 exclude 加回去。
4. **渲染层只允许类型导入**：从 `@aurora/shared` 取运行时值走 `@aurora/shared/browser`；新增视觉资产在 `packages/shared/src/browser/**` 时 = 同时改桌面与 Center Web。
5. **出网（TTS）走 `net.ts` 的 `netFetch`**：`TtsSynthesizer` 已注入 `resolveFetch`，别绕过。
6. **跨 IPC 不传 Vue reactive/Proxy**：渲染层往主进程送对象前 `deepClone()`。
7. **置顶**：`setAlwaysOnTop(true, 'screen-saver')` + `always-on-top-changed` 恢复 + watchdog（照抄 edge-bar）；流光窗必须 `setIgnoreMouseEvents(true,{forward:true})`。
8. **定位用 `display.bounds` 不用 `workArea`**（任务栏缝隙坑）。
9. **CSP `media-src 'self' blob:` 两条都要有**（TTS 播放）；`onHeadersReceived` 注入只作用自家窗口页面。
10. **流光类名/关键帧名**：新窗口**不要复用** awareness-glow 的类名与 capture 探针字符串（避免互相污染与探针串误命中）；若复用视觉，复制后重命名。
11. **音效/语音失败只降级不炸主流程**：TTS 未配置静默跳过；音效失败记 debug；`BannerService.show` 失败绝不抛进 Agent 工具循环（折成 `{ok:false, reason}` 回报）。
12. **插件 RPC 长度截断 + 权限校验 + 防失控**：title/body 截断、复用 `notifications` 权限判定、payload 上限与限速口径照抄 panelEvent（若做广播）。
13. **`.vue` 模板不写多语句内联处理器**；`prettier --write` 后必须重跑构建。
14. **日志**：用 `Logger` 接口，不 `console.log`；内容脱敏（TTS 文案可能含用户输入，别把完整正文打进日志）。

---

## 6. 交付物

- 代码：上述 Phase 1–4（+可选 5）全部落地，`pnpm typecheck && pnpm test && pnpm build` 全绿。
- 测试：新增单测 + 冒烟断言 + banner 截图场景，基线不倒退。
- 文档：Phase 0 的 docs 同步完成。
- 提交：Conventional Commits、描述中文（`feat(vX.Y.Z): 新增流光提醒（banner notification）通道…`），一个功能一个 commit。

**做完后自查**：能否用以下三句话分别触发流光提醒——① 插件 `ctx.banner({title,body})`；② Agent 调 `notify_banner`；③ Agent 调 `ask_user` 时（主窗口未聚焦）自动弹一条——三路最终都进同一个 `BannerService.show()`，流光 + 卡片 + 提示音 + 语音（配置了 TTS 时）齐全。
