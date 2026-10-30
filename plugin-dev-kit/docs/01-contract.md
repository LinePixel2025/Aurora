# 14 · 插件系统

> 状态：**已定稿（v36，2026-10）**
> 本文是插件契约的单一事实来源；面向插件作者的逐步指南见 [15-plugin-development-guide.md](./15-plugin-development-guide.md)。

Aurora 的插件系统让第三方代码以**受控运行时**的形式扩展客户端：贡献 Agent 工具 / Skill / 斜杠命令、
自动化动作与事件、右栏面板、**桌面 / 提示条小组件**、配置页字段与主题令牌；插件包可本地安装，也可从 Aurora Center 插件市场获取。

**先说清楚边界**：这不是操作系统沙箱。插件进程以**当前用户权限**运行，可以直接读写文件、
联网、调用子进程、绕过 Aurora API。**安装插件 = 信任其代码**。宿主保证的是：崩溃隔离、
API 白名单、工具确认、安装 / 更新路径安全与页面渲染隔离（见 §6）。

---

## 1. 设计原则

### 1.1 清单优先（manifest-first）

插件的**所有贡献**都在 `manifest.json` 里声明：工具 schema、Skill 目录、命令、自动化动作 / 事件、
面板、主题、配置字段。`main.js` 只导出处理器，**运行期不允许动态注册**工具或命令。

好处：

- 安装前就能完整展示权限、工具与敏感度，做安装同意；
- 主进程不必等插件进程 ready 就能注册工具表、命令与 Skill 目录；
- 桌面安装器、Center 市场与 `scripts/verify-plugin.mjs` 共用同一份 zod schema；
- 对其他编码 Agent 最友好：先写清单，再按名字填 handler。

### 1.2 受控运行时，而不是沙箱

- 每个启用的插件一个 `utilityProcess`（上限 `PLUGIN_MAX_RUNNING = 8`）；
- 插件通过 `parentPort` 上的白名单 RPC 使用宿主 API；权限按 API 逐条门控；
- 插件崩溃 / 死循环 / OOM 不牵连主进程与其他插件；
- 但插件进程内仍有完整 Node：**权限门控拦的是 Aurora API，不是系统能力**。

### 1.3 v1 明确不做

- OS 级沙箱 / AppContainer / 受限令牌；
- 代码签名与发布者认证（市场只做 SHA-256 完整性校验）；
- 壁纸层 / 桌面图标层嵌入、插件创建任意自有窗口、任意全屏覆盖层、点击穿透画布；
- 提示条里加载页面型 webview（提示条小组件**只允许声明式 schema**）；
- 插件访问 Aurora 凭据 / API Key / MCP env；插件配置不允许密文字段；
- 插件自动更新（只做「发现更新 + 用户点击安装」）；
- 已安装插件的热更新（开发目录除外）。

---

## 2. 进程与 RPC

### 2.1 进程模型

| 项 | 口径 |
| --- | --- |
| 进程 | 一个启用插件一个 `utilityProcess`（`out/main/plugin-host.js`） |
| 并发上限 | 8（防失控常量，不做成设置项） |
| 启动时机 | `activation: "startup"` 在管理器 `start()` 时启动；`lazy` 在首次工具 / 命令 / 面板调用时启动 |
| 崩溃重启 | 1s / 5s / 15s 退避；10 分钟内第 4 次崩溃 → `crashed` 并自动停用 |
| 心跳 | 每 30s `plugin.ping`，连续 2 次未回 → 重启 |
| 日志 | `<userData>/logs/plugins/<id>.log`（统一脱敏） |
| 退出 | 先 `plugin.deactivate`（3s 超时），再 `kill()`；在途请求全部以 `E_PLUGIN_CRASHED` 拒绝 |

### 2.2 RPC 信封

结构化克隆消息（不用 NDJSON）：

```ts
type PluginRpcMessage =
  | { v: 1; kind: 'req'; id: string; method: string; params: unknown }
  | { v: 1; kind: 'res'; id: string; ok: true; result: unknown }
  | { v: 1; kind: 'res'; id: string; ok: false; error: { code: string; message: string; detail?: string } }
  | { v: 1; kind: 'evt'; event: string; payload: unknown }
  | { v: 1; kind: 'cancel'; id: string }
```

- 单插件在途请求上限 **32**；单帧上限 **1 MiB**（超限拒绝 / 终止并记 `E_PLUGIN_FRAME_TOO_LARGE`）。
- 默认超时：init / activate / command / panel / event 10s，configChanged 5s，ping 5s，
  工具 `min(manifest.timeoutMs ?? 60s, 600s)`，自动化动作 120s。
- 工具取消：内核 `ToolContext.signal` abort → 宿主发送 `cancel` → 插件侧 abort 本地 `AbortSignal`；
  宿主以 `E_PLUGIN_CANCELLED` 返回。
- 错误码：`E_PLUGIN_NOT_READY` / `E_PLUGIN_CRASHED` / `E_PLUGIN_TIMEOUT` / `E_PLUGIN_CANCELLED` /
  `E_PLUGIN_PERMISSION` / `E_PLUGIN_TOOL_FAILED` / `E_PLUGIN_INVALID_ARGS` /
  `E_PLUGIN_FRAME_TOO_LARGE` / `E_PLUGIN_TOO_MANY_INFLIGHT` / `E_PLUGIN_DISABLED`。

### 2.3 调用名

**宿主 → 插件**：`plugin.init`、`plugin.activate`、`plugin.deactivate`、`plugin.ping`、`tool.invoke`、
`command.invoke`、`automation.action`、`panel.invoke`、`widget.invoke`、`event.deliver`、`config.changed`、`system.event`。

**插件 → 宿主（按权限白名单）**：`storage.get/set/delete/list`、`net.fetch`、`notify`、`banner`、`log`、
`emitEvent`、`ui.openPanel`、`ui.toast`、`ui.panelEvent`、`config.get/set`、`usage.summary`。

> `banner`（v0.5.6 起）与 `notify` 同属 `notifications` 权限：`notify` 走系统通知中心（可点击打开
> 文件 / 文件夹），`banner` 在屏幕顶端弹流光 + 置顶卡片（支持朗读 / 提示音，无可点入口）。
> 两者的提示音 / 朗读都受用户在「设置 → 提醒」里的总闸约束，插件传 `true` 不能越过。

### 2.4 工具返回

工具只允许文本：

```ts
interface PluginToolResult {
  content: string      // 上限 100 KB，超长由宿主截断
  isError?: boolean
  summary?: string
}
```

v1 不开放图片 / 附件返回值。面板 / 页面返回值见 §5。

---

## 3. 清单参考

完整 zod schema 在 `packages/shared/src/plugin/manifest.ts`，安装器、市场与校验脚本共用。

```json
{
  "id": "com.example.todo",
  "name": "Todo 面板",
  "version": "1.0.0",
  "apiVersion": 1,
  "minAuroraVersion": "0.5.0",
  "description": "在右栏维护待办，并给 Agent 一个添加待办的工具。",
  "author": { "name": "Example" },
  "license": "MIT",
  "homepage": "https://example.com",
  "main": "main.js",
  "activation": "startup",
  "permissions": ["tools", "skills", "commands", "automation", "automation.events",
                  "storage", "config", "usage", "ui.panels", "themes", "net", "notifications", "events"],
  "contributes": {
    "tools": [{
      "name": "add_todo",
      "description": "添加一条待办",
      "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
      "sensitivity": "confirm",
      "readonly": false,
      "timeoutMs": 30000
    }],
    "skills": ["skills/todo"],
    "commands": [{ "name": "todo", "title": "打开待办", "description": "打开待办面板", "mode": "action" }],
    "automation": {
      "actions": [{ "name": "add", "title": "添加待办", "description": "把事件内容加入待办",
                    "fields": [{ "key": "text", "label": "内容", "type": "text" }] }],
      "events": [{ "name": "todo-added", "title": "新增待办" }]
    },
    "panels": [
      { "id": "board", "title": "待办", "icon": "ListChecks", "schema": "ui/panel.json" },
      { "id": "info", "title": "插件页面", "icon": "Globe", "entry": "ui/page.html" }
    ],
    "widgets": [
      { "id": "duty-week", "title": "本周值日", "icon": "CalendarClock", "slot": "desktop",
        "schema": "ui/widget.json", "defaultSize": { "width": 300, "height": 200 } },
      { "id": "todo-strip", "title": "事务", "icon": "ListChecks", "slot": "edge-bar",
        "schema": "ui/strip.json" }
    ],
    "themes": [{ "id": "sand", "name": "沙丘",
                 "tokens": { "--bg-base": "#141210", "--text-primary": "#f5f0e8" } }]
  },
  "config": { "fields": [{ "key": "showDone", "label": "显示已完成", "type": "boolean", "default": true }] },
  "events": ["settings.changed"]
}
```

### 3.1 标识与命名

- `id`：反向域名，`^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?)+$`，总长 ≤ 40；
  保留段（`aurora|builtin|plugin|mcp|skill` 等）拒绝。
- 工具名 `^[a-z][a-z0-9_]{0,24}$`；最终工具名 **`plugin.<id>.<name>` ≤ 64 字符**。
  单插件工具 ≤ 32，全部插件工具总数 ≤ 128。
- 命令名 `^[a-z][a-z0-9_-]{0,31}$`，不得与内置命令重名（`new/clear/init/compact/subagents/settings/stop`）。
- 面板 ≤ 8；`schema` 与 `entry` **二选一**；schema JSON ≤ 256 KB；entry 必须在包内。
- 小组件 ≤ 4；`slot ∈ { "desktop", "edge-bar" }`；`schema` 与 `entry` 二选一；
  **`slot = "edge-bar"` 只允许 `schema`**（不允许在提示条里塞 webview），也不接受 `defaultSize`；
  桌面小组件 `defaultSize` 宽 120–1200、高 80–900；同时存在的桌面小组件窗口总数 ≤ 8（防失控常量）。
- 桌面小组件窗口：`windowLevel ∈ { "floating", "normal", "desktop" }`（默认 `"floating"`）；
  `windowMaterial ∈ { "none", "acrylic" }`（默认 `"none"`）。两者只对 `slot = "desktop"` 生效，
  提示条小组件声明非默认值时**清单校验直接拒绝**；不新增权限 / 宿主 API。
- `hideCloseButton`（默认 `false`）：设为 `true` 时宿主不渲染标题栏右上角的「隐藏小组件」按钮；
  只对 `slot = "desktop"` 生效，提示条小组件声明 `true` 会被清单校验拒绝。
  使用这些字段时把 `minAuroraVersion` 设为支持它们的宿主版本（旧宿主会静默忽略未知字段）。
- 主题 ≤ 8；令牌走白名单（§7），颜色只接受 `#rgb/#rrggbb/rgb()/rgba()/hsl()/hsla()`；单主题 ≤ 64 个令牌。
- `apiVersion` 必须等于宿主 `PLUGIN_API_VERSION = 1`；`minAuroraVersion` 与宿主版本比较。
- `main` / `skills` / `ui` / icon 路径 `resolve` 后必须仍在插件根内。

### 3.2 权限与贡献的对应

声明贡献但缺对应权限 → **清单校验失败**（安装与市场都会拒绝）。完整权限表见 §4。

### 3.3 Skill 口径

- `contributes.skills` 每项指向包内目录：目录本身含 `SKILL.md`，或目录下一层技能子目录；
- 扫描顺序 **builtin → plugin → user**：用户同名覆盖插件，插件不能遮蔽内置；
  两个插件同名时**先加载者优先**，后者跳过并记 issue。

---

## 4. 权限（API 级门控）

| 权限 | 允许的 API / 贡献 |
| --- | --- |
| `tools` | 注册 `contributes.tools` 并执行 `invokeTool` |
| `skills` | 挂载插件 Skill 目录 |
| `commands` | 注册斜杠命令 |
| `automation` | 注册并执行 `automation.actions` |
| `automation.events` | 注册并 `ctx.emitEvent` |
| `storage` | 插件私有键值存储（5 MB 总量、单值 256 KB） |
| `config` | `ctx.config` 读取与 `config.set` 写入（非密文） |
| `usage` | 本机用量统计（`ctx.usage.summary`：Token / 缓存命中 / 生图 / 语音次数，只读聚合） |
| `net` | `ctx.net.fetch`（只 http/https，响应 ≤ 5 MB） |
| `net.private` | 允许 loopback / 私网（必须同时声明 `net`） |
| `notifications` | 系统通知（`ctx.notify`）与流光提醒（`ctx.banner`） |
| `logging` | 写插件日志（无权限也允许 warn/error，避免无法排障） |
| `ui.panels` | 右栏面板 + `ui.openPanel` / `ui.toast` / `ui.panelEvent`（面板目标） |
| `ui.widgets` | 注册 `contributes.widgets`、`invokeWidget`、`ui.panelEvent`（小组件目标） |
| `themes` | 主题令牌 |
| `events` | 订阅清单 `events` 中声明的宿主事件 |

未声明的宿主 API 一律回 `E_PLUGIN_PERMISSION`。

### 4.1 用量统计（`ctx.usage`）

需要 `usage` 权限。`ctx.usage.summary()` 返回**本机**最近一段时间的只读聚合：

```ts
const stats = await ctx.usage.summary({ days: 30 }) // days 缺省 30，夹取到 1–90
// stats.tokens = { promptTokens, completionTokens, totalTokens, cachedTokens, rounds,
//                   cacheHitRate, background }
// stats.images = { generated }
// stats.voice  = { tts, ttsChars, stt, sttChars }
// stats.daily  = [{ date, tokens, images, voice }, ...]（含没有数据的日期）
```

| 字段 | 含义 |
| --- | --- |
| `tokens.totalTokens` | 期间所有经宿主 provider 的 LLM 轮次真实 Token 总量（主对话、子代理、摘要与后台自感知） |
| `tokens.cachedTokens` / `cacheHitRate` | 缓存命中量与命中率（`cachedTokens / promptTokens`，无数据为 0） |
| `tokens.rounds` | 已累计的 LLM 轮次（provider 未回传 usage 的轮次不计） |
| `tokens.background` | 其中后台自感知分析消耗的部分（同样含四个 Token 字段与轮次） |
| `images.generated` | 成功完成的生图次数（失败不计数） |
| `voice.tts` / `voice.ttsChars` | TTS 合成成功次数 / 实际送出的字符数 |
| `voice.stt` / `voice.sttChars` | STT 识别成功次数 / 识别结果字符数 |
| `daily[].date` | 本地日期 `YYYY-MM-DD`（按天分桶，含空白日） |

口径与边界：

- **只统计本机、从引入该接口的版本起累积**：历史会话只有累计值、没有逐日时间戳，因此不回溯；
  升级前发生的用量不会出现在这里。
- **只存计数**：不包含提示词、回复、图片、音频、文件名或任何凭据；后台自感知的消耗单独给出，
  便于插件区分「用户主动对话」与「后台分析」。
- 按**本地日期**分桶；账本保留 90 天（超出窗口的旧数据自动清理），查询窗口上限同为 90 天。
- 数据来自 Agent 宿主 provider 的真实 `usage` 收尾（含子代理 / 摘要等内部轮次）与服务成功返回：
  provider 没回传 usage 的轮次不会伪造 0；生图 / TTS / STT 失败也不计入。
- 该权限在安装确认里逐条展示；插件不需要、也拿不到 Center 账号或模型凭据。

---

## 5. 面板与页面

### 5.1 声明式面板（优先）

`schema` 指向包内 JSON：`{ "version": 1, "nodes": PluginUiNode[] }`。组件白名单：

`stack / row / grid / card / divider / heading / text / badge / progress / image / list / table /
keyValue / button / input / textarea / select / toggle / number / slider`

- 只有文本与受控控件，**没有 HTML / v-html**，不存在脚本注入面；
- 上限：节点 500、深度 20、文本 4000 字、动作参数 8 KB、整份 JSON 256 KB；
- 按钮动作 `{ method, params?, confirm?, toast? }` 由 `invokePanel` 处理；`confirm` 由宿主内置确认条展示；
- 图片 `src` 是包内相对路径，渲染层拼成 `aurora-plugin://<id>/<path>`。

`invokePanel(panelId, method, params, ctx)` 返回 `{ schema?, toast? }`：返回 `schema` 可替换当前面板
（动态面板）；校验失败时宿主保留旧面板并报错。

### 5.2 沙箱页面（webview）

`entry` 指向包内 HTML：

- 自定义协议 `aurora-plugin://<pluginId>/<path>`：路径 `realpath` 必须落在插件根内，
  MIME 白名单 `html/js/mjs/css/json/png/jpg/jpeg/webp/woff2`；
- 响应头 CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; connect-src 'none'; ...`（页面不能直接出网）；
- 每个插件独立**非持久** partition `plugin-<id>`，协议处理器逐 session 注册；
- 强制 `sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webSecurity:true`，
  专用 preload、禁弹窗 / 下载 / 权限请求、禁跨插件导航；
- 页面只拿到：

```ts
window.auroraPlugin = {
  request(method: string, params?: unknown): Promise<unknown>
  onEvent(listener: (event: string, payload: unknown) => void): () => void
}
```

`request` 经宿主渲染层 `plugins:pageRpc` 中继到 `invokePanel`；主进程校验 guest 归属、插件 id、
参数 ≤ 256 KB、方法名 ≤ 64。页面型面板 / 桌面小组件的处理器可返回 `data`，以及可选的
`message` / `error` 字符串——三者都原样交给页面，用于渲染数据与页面内状态条。

页面**没有** `window.aurora`、没有 Node、没有文件系统。

### 5.3 桌面小组件

`slot = "desktop"` 的小组件默认是**置顶浮动卡片**：每个可见 widget 一张 `BrowserWindow`，
`frame:false` / `transparent:true` / `skipTaskbar:true`、最小 120×80；位置与尺寸夹取到当前显示器
`workArea`，屏幕变化时重新夹取。窗口层级由清单 `windowLevel` 声明，用户可在设置页逐 widget 覆盖：

- `"floating"`（默认）：置顶浮动卡片（`alwaysOnTop: true`），与旧版本行为一致；
- `"normal"`：不置顶，按普通无边框窗口参与 z-order；
- `"desktop"`：不置顶；宿主把窗口的 Win32 owner 指向桌面 shell 视图（`SHELLDLL_DefView`），
  并带最小化恢复守护，让 Win+D / Win+M 后仍尽量可见；属尽力而为，失败回落 `"normal"`。
  它只是「普通窗口 + owner 亲和 + 恢复守护」，**不是**壁纸层嵌入 / 桌面图标层 / 点击穿透。
- 材质由 `windowMaterial` 声明：`"none"`（默认）保持现有不透明卡片；`"acrylic"` 使用原生 Acrylic，
  仅 Windows 11 22H2+ 且外观 `appearance.glass` 开启时逐 widget 生效，窗口 shape 按卡片四角圆角
  裁剪；不满足条件或启用失败时保持不透明卡片。
- 声明式 widget 复用 `PluginSchemaRenderer`；页面型复用 `aurora-plugin://` + 专用 preload
  （与 §5.2 完全同一套沙箱口径；widget 窗口只为它开启 `webviewTag`）。
- 布局写 `<userData>/plugin-widget-layout.json`（**不进 settings、不升 `CONFIG_VERSION`**，
  文件版本仍为 `1`；`windowLevelOverride` / `locked` 是可选扩展字段）：

```ts
{ "version": 1, "widgets": { "<pluginId>/<widgetId>": {
  "visible": boolean, "x": number, "y": number, "width": number, "height": number,
  "windowLevelOverride"?: "floating" | "normal" | "desktop",
  "locked"?: boolean
} } }
```

- `windowLevelOverride` 记录用户在设置页选的层级，缺省 = 跟随清单；读取时丢弃非法值。
- `locked` 记录用户点标题栏「固定」后的锁定状态（锁拖动 / 缩放），缺省 = 未固定。
- 桌面小组件窗口不可激活：点击卡片 / 卡内按钮不抢前台焦点，卡内文本输入拿不到键盘焦点。
- 新 widget 默认可见，位置从工作区右上角级联；用户拖动 / 缩放 / 改层级后 250ms 防抖原子写。
- 设置 → 插件详情里每个桌面 widget 一枚「显示在桌面」开关 + 一枚层级下拉
  （跟随插件 / 置顶 / 普通 / 桌面层）；关闭开关即销毁窗口、保留布局条目。
- 插件停用 / 卸载 / 总开关关闭 / 崩溃反复超限：立即销毁窗口；布局文件保留用户位置。
- 开发目录热重载：同 id widget 更新标题 / 入口，位置不丢；入口类型变化时重建窗口。
- 布局文件损坏按空布局重建；未知 id 原样保留，不主动删用户布局。

### 5.4 提示条小组件

`slot = "edge-bar"` 的小组件渲染在提示条**展开面板底部**的「小组件」区：

- **只接受声明式 schema**，不创建窗口、不嵌 webview，提示条窗口的 shape / 尺寸逻辑不变；
- 单条最大高度 220px，超出在条目内部滚动；没有小组件时整块不渲染；
- 拉取失败或插件未就绪只显示一行极简占位，不弹全局错误。

### 5.5 事件推送（无需刷新）

插件用 `ctx.ui.panelEvent()` 把事件推给它**自己的**已打开面板 / 小组件：

```ts
await ctx.ui.panelEvent({ panelId: 'board', event: 'count-changed', payload: { count } })
await ctx.ui.panelEvent({ widgetId: 'todo-strip', event: 'count-changed', payload: { count } })
```

- `panelId` / `widgetId` **二选一**；目标必须在清单里声明过；面板目标要 `ui.panels`、
  小组件目标要 `ui.widgets`；跨插件 id 一律拒绝。
- `event` 匹配 `^[a-z][a-z0-9_.-]{0,63}$`；payload ≤ 64 KB；每插件每秒 ≤ 20 条，
  超出由主进程**丢弃并记 warn**（不抛错打断插件）。
- 路由：面板 → `plugins:panelEvent` → `PluginPanel` 以 `method = 'event'` 调 `invokePanel`；
  页面型面板 / 桌面页面 widget → `webview.send('aurora:event')`；
  桌面声明式 widget → `plugins:widgetEvent` → `widgetData('event', ...)`；提示条同样订阅 `plugins:widgetEvent`。
- 推送内容按纯数据（结构化克隆）传输，不做 HTML 拼接；渲染层仍禁止 `v-html`。

---

## 6. 安全模型

### 6.1 安装与包安全

- 安装前 `inspect` 展示：id、名称、版本、作者、SHA-256、权限、工具及敏感度、面板 / 主题，
  以及「插件将以你的用户权限运行」的警告；
- zip 解压到 `<userData>/plugins/.staging/<random>`，逐项拒绝绝对路径、盘符、UNC、`..`、NUL、
  符号链接（解压后 `lstat` + `realpath` 前缀校验）；
- 条目 ≤ 2000，单文件 ≤ 10 MB，解压总量 ≤ 50 MB，压缩比 > 200:1 拒绝；`manifest.json` 必须在包根且 ≤ 64 KB；
- 校验通过后 `rename` 到 `versions/<version>`，**绝不原地覆盖**；更新保留 `previousVersion` 可回滚；
- 卸载默认保留 `plugin-data/<id>`，UI 可勾选「同时删除数据」；
- **SHA-256 只保证完整性，不保证发布者身份**（v1 无签名）。

### 6.2 工具信任

- 插件工具在清单里声明 `sensitivity`，但宿主**默认强制 `confirm`**；
- 用户在插件详情里显式「信任此插件」后，清单声明 `sensitivity: "safe"` 的工具才按 `safe` 注册；
- `agent.permissionMode = 'readonly'` 时只注册 `readonly: true` 的插件工具；
- 插件工具不参与 `agent.tools.enabled` 门控，但受 `plugins.enabled`、插件自身 enabled、
  只读档与信任开关约束；
- 工具名天然带 `plugin.<id>.` 前缀，不会与内置 / MCP 工具撞名。

### 6.3 事件推送的边界

- 主进程只接受**插件进程发来的、目标属于该插件清单**的推送；未知目标 / 跨插件 id 拒绝；
- 限速（20 / 秒）与载荷上限（64 KB）在**主进程**判定，渲染层不信任；
- 推送只在插件自己的面板 / 页面 / 小组件之间流转，不会跨插件串台。

### 6.4 明确不防护的面

插件进程拿到完整 Node：可 `fs` / `child_process` / `net` 绕过所有 Aurora API 与确认闸门；
可读取用户文件、截屏、外发数据。**真正的隔离需要 OS 沙箱，v1 不做。**
文档与安装弹窗必须如实写明这一点。

---

## 7. 主题令牌

只允许覆盖**表面 / 文字 / 边框 / 圆角 / 状态色**；强调色（`--aurora-blue`）与毛玻璃
（`--glass-*` / `--blur-*`）由「外观」设置独占。

```
--bg-base --bg-raised --bg-overlay --bg-glass --fill-1 --fill-2 --fill-3
--border-subtle --border-strong --text-primary --text-secondary --text-muted
--ok-text --ok-fill --error-text --error-fill --danger-text --danger-fill
--selection-fill --scrollbar-hover
--radius-xs --radius-sm --radius-md --radius-lg --radius-xl --radius-pill
```

应用顺序：`applyAppearance()`（强调色 / 毛玻璃）→ 插件令牌（内联到 `document.documentElement`）。
切换 / 禁用插件时先清掉上一组内联变量，不留「幽灵主题」。

---

## 8. 自动化集成

- 触发器 **`plugin-event`**：字段 `pluginId` + `event`；插件 `ctx.emitEvent(name, payload)`
  （需 `automation.events` 且事件在清单声明）时匹配运行。
- 操作 **`plugin-action`**：字段 `pluginId` + `action` + `params`（JSON 对象文本，≤ 8 KB），
  调用插件的 `invokeAutomationAction`。
- 事件是**边沿触发**（每次 emit 都是一次机会），不走定时去重键；
- **防自激**：同一 `(pluginId, event)` 在自动化执行期间再次 emit 会被忽略（插件动作里再发同名事件
  不会无限递归）；一次事件运行结束后守卫释放。
- 运行历史记 `triggerDetail = 插件事件 <id>/<event>`，操作步骤同样落 `steps`。

---

## 9. 宿主事件

清单 `events` 只能从下列名字里选（需要 `events` 权限）：

| 事件 | payload |
| --- | --- |
| `settings.changed` | `{}` |
| `message.user` | `{ sessionId, text }`（文本截断 16 KB） |
| `message.assistant` | `{ sessionId, requestId, text }`（16 KB） |
| `tool.after` | `{ sessionId, requestId, call }` |
| `session.created` | `{ sessionId }` |
| `session.deleted` | `{ sessionId }` |
| `theme.changed` | `{}` |

只投给**正在运行**且声明了该事件的插件；投递失败只记 debug 日志。

---

## 10. 数据与配置

```
<userData>/plugins/<id>/versions/<version>/   安装版本（保留上一版用于回滚）
<userData>/plugins/registry.json              安装 / 启用 / 信任状态（原子写）
<userData>/plugin-data/<id>/config.json       插件配置（非密文）
<userData>/plugin-data/<id>/storage.json      插件键值存储（5 MB 配额）
<userData>/plugin-widget-layout.json         桌面小组件位置 / 尺寸 / 显隐 / 层级覆盖 / 固定（独立于 settings）
<userData>/usage-stats.json                  本机用量账本（按日计数，保留 90 天；插件只读汇总）
<userData>/logs/plugins/<id>.log
```

- 安装态**不进 settings**：`settings.plugins` 只有 `enabled` / `devDirs` / `activeTheme` 三个字段；
- `plugins` 整组在 `SETTINGS_READONLY_PREFIXES`：AI 的 `set_setting` 不得安装 / 启停 / 信任插件；
- 插件配置**不支持密文字段**，也不向插件暴露任何 Aurora 凭据；
- 开发目录插件原地加载（不复制），300ms 防抖后自动重启。

---

## 11. 市场（Aurora Center）

- 公开路由（无需登录）：`GET /api/plugins`（搜索 / 分页 / 排序）、`GET /api/plugins/:id`、
  `GET /api/plugins/:id/download?version=`（带 `X-Checksum-Sha256`）、`GET /api/plugins/:id/icon`；
- 管理员：`GET /api/admin/plugins`、`POST /api/admin/plugins/upload`（zip → staging）、
  `POST /api/admin/plugins/publish`、`DELETE /api/admin/plugins/:id/:version`、
  `POST /api/admin/plugins/:id/icon`（PNG ≤ 256 KB）；
- 同版本**不可覆盖**；删除当前版本后 `latestVersion` 回落到剩余最高版本；
- 桌面端：`PluginMarketplaceClient` 下载 → 校验大小与 SHA-256 → `PluginManager.install`
  （来源记 `marketplace`）；校验失败**不落任何安装状态**；
- CLI：`aurora-center plugins list|publish|unpublish`；
- v1 无签名：市场与安装弹窗都必须写明「安装即信任」。

---

## 12. 验证与已知限制

- 单测：清单 / 主题 / 面板 schema / 小组件清单与布局夹取 / 迁移 v36 / RPC 协议（超时、取消、帧上限、在途上限）/
  管理器（权限、超时、取消、崩溃退避、面板事件路由与限速）/ 自动化事件与动作 / 市场客户端与 Center 市场路由 /
  **用量账本（按日分桶、缓存命中率、90 天保留、损坏归化）、provider 层 usage 回报与 `usage.summary` 权限透传**；
- 端到端：`AURORA_SMOKE=1 pnpm dev` 覆盖安装 → 工具 / Skill / 命令 → 插件事件自动化 →
  面板 schema → **小组件窗口 / 面板事件推送** → 主题令牌 → 停用 / 启用 / 卸载；
- 截图：`chat-plugin-panel.png` / `chat-plugin-page.png` / `settings-plugins-installed.png` /
  `settings-plugins-marketplace.png` / `widget-desktop-plugin.png` / `edge-bar-plugin-widget.png` /
  `chat-plugin-panel-push.png` + 设置页 `settings-plugins.png`；
- Center：`verify:web` 的 `marketplace` / `plugins-admin` 场景；
- 独立校验：`node scripts/verify-plugin.mjs <目录|zip>`。

已知限制：

- 插件进程**不是沙箱**；OS 级隔离不在 v1；
- 页面 `connect-src 'none'`，出网必须经 `invokePanel` → 插件进程的 `ctx.net.fetch`；
- 插件返回工具结果只支持文本；
- 市场不提供签名 / 发布者认证；
- 桌面小组件默认置顶，可声明 `normal` / `desktop` 层级；`desktop` 的桌面亲和是尽力而为
  （失败回落 `normal`），不做壁纸层嵌入 / 桌面图标层 / 点击穿透；
- `windowMaterial: "acrylic"` 只在 Windows 11 22H2+ 且外观毛玻璃开启时生效，否则保持不透明卡片；
- 提示条小组件只支持声明式 schema（并拒绝 `windowLevel` / `windowMaterial` 非默认值）；
- 插件工具不参与 `agent.tools.enabled` 门控（与扩展工具六件套同口径），只受插件总开关 /
  单插件开关 / 只读档 / 信任约束。
