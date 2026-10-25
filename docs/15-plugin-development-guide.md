# 15 · 插件开发指南

> 面向**插件作者**与**其他编码 Agent**：从零写一个能装进 Aurora 的插件包。
> 契约与安全模型见 [14-plugin-system.md](./14-plugin-system.md)；本指南只讲怎么做。

## 1. 快速开始

```text
hello-aurora/
  manifest.json          # 必需，包根
  main.js                # 必需，CJS / ESM 均可
  skills/hello/SKILL.md  # 可选
  ui/panel.json          # 可选，声明式面板
  ui/page.html|js|css    # 可选，沙箱页面
  themes/*.json          # 可选（也可内联在 manifest）
  assets/icon.png        # 可选，市场图标（仅 PNG）
  README.md
```

最省事的路径：复制仓库里的 [`examples/plugins/_template`](../examples/plugins/_template)，
改 `manifest.json` 的 `id` / `name` / `version` 与 `main.js` 的处理器。

### 1.1 开发态安装（改文件自动重启）

1. Aurora → 设置 → 插件 → 开发 → 添加目录，选择插件目录；
2. 插件立即出现（`activation: "startup"` 会启动进程；`lazy` 在首次调用时启动）；
3. 改 `main.js` / `manifest.json` 后 300ms 自动重启；
4. 日志：插件详情里的「打开插件日志」，或 `%APPDATA%/Aurora/logs/plugins/<id>.log`。

### 1.2 打包安装

```powershell
# zip 根目录必须直接是 manifest.json（不能包一层文件夹）
Compress-Archive -Path manifest.json,main.js,skills,ui,types -DestinationPath hello.zip -Force
```

设置 → 插件 → 已安装 → 安装插件包，选择 zip。安装前会展示权限、工具与 SHA-256。

### 1.3 发布到 Center 市场

```bash
# 管理员账号；Center 需已启动
aurora-center plugins publish --server http://127.0.0.1:8787 --user admin --dir ./hello-aurora \
  --changelog "首个版本"
```

同版本不能覆盖；发新版本请先改 `manifest.json` 的 `version`。

---

## 2. 清单字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 反向域名、全小写、≤ 40；工具最终名会带这个前缀 |
| `name` | ✓ | 展示名（≤ 60） |
| `version` | ✓ | `x.y.z`（可带预发布后缀） |
| `apiVersion` | ✓ | 必须为 `1` |
| `minAuroraVersion` |  | 例如 `0.5.0`（插件 API v1 的首个版本）；低于该版本拒绝加载 |
| `description` | ✓ | ≤ 300，用于安装确认与市场 |
| `author.name` | ✓ | 作者展示名 |
| `author.url` / `license` / `homepage` |  | 市场展示 |
| `main` | ✓ | 包内入口（`main.js`） |
| `activation` |  | `startup`（默认）/ `lazy` |
| `permissions` |  | 见 §3；声明贡献必须同时声明对应权限 |
| `contributes.tools` |  | 工具（≤ 32；最终名 ≤ 64） |
| `contributes.skills` |  | 包内 Skill 目录 |
| `contributes.commands` |  | 斜杠命令（`action` / `prompt`） |
| `contributes.automation` |  | 自动化动作 / 事件 |
| `contributes.panels` |  | 声明式或页面型面板（二选一） |
| `contributes.widgets` |  | 桌面 / 提示条小组件（`slot`；提示条只允许 `schema`） |
| `contributes.themes` |  | 主题令牌 |
| `config.fields` |  | 插件配置（text / number / boolean / select / textarea） |
| `events` |  | 订阅的宿主事件（见 §5） |
| `icon` |  | 市场图标（PNG 相对路径；Center 可另行上传） |

工具字段：

```json
{
  "name": "echo",
  "description": "原样回显输入文本",
  "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
  "sensitivity": "safe",
  "readonly": true,
  "timeoutMs": 30000
}
```

- `sensitivity` 只是**声明**：未信任时一律按 `confirm` 注册；信任后才可能按 `safe`；
- `readonly: true` 才会在只读档注册；
- `parameters` 必须是 `type: "object"` 的 JSON Schema，≤ 64 KB。

---

## 3. 权限表

| 权限 | 你能做什么 |
| --- | --- |
| `tools` | 贡献并执行工具 |
| `skills` | 挂载 Skill 目录 |
| `commands` | 注册斜杠命令 |
| `automation` | 注册并执行自动化动作 |
| `automation.events` | 注册事件 + `ctx.emitEvent` |
| `storage` | `ctx.storage`（5 MB / 单值 256 KB） |
| `config` | 读取 `ctx.config`（写入由用户在设置页完成） |
| `usage` | `ctx.usage.summary`（本机 Token / 缓存命中 / 生图 / 语音用量，只读聚合） |
| `net` | `ctx.net.fetch`（http/https，≤ 5 MB 响应） |
| `net.private` | 访问 loopback / 私网（必须同时有 `net`） |
| `notifications` | `ctx.notify` / `ctx.banner`（系统通知 / 流光提醒） |
| `logging` | 写插件日志（warn/error 不受限） |
| `ui.panels` | 右栏面板 + `ctx.ui.openPanel` / `toast` / `panelEvent`（面板） |
| `ui.widgets` | 桌面 / 提示条小组件 + `invokeWidget` + `panelEvent`（小组件） |
| `themes` | 主题令牌 |
| `events` | 订阅宿主事件 |

**最小权限原则**：只声明真的用到的权限 —— 安装确认会把它们逐条摊开给用户看。

---

## 4. 处理器 API

`main.js` 导出以下方法（全部可选；缺哪个就回 `E_PLUGIN_INVALID_ARGS`）：

```js
module.exports = {
  async activate(ctx) {},
  async deactivate() {},
  async invokeTool(name, input, ctx) { return { content: '...', summary: '...' } },
  async invokeCommand(name, args, ctx) { return { prompt: '...' } },  // action 命令返回 { summary }
  async invokeAutomationAction(name, params, ctx) { return { summary: '...' } },
  async invokePanel(panelId, method, params, ctx) { return { schema?, toast?, data? } },
  async invokeWidget(widgetId, method, params, ctx) { return { schema?, toast? } },
  onEvent(event, payload, ctx) {},
  onConfigChanged(config, ctx) {},
}
```

### 4.1 `ctx`

```ts
interface PluginContext {
  plugin: { id: string; version: string; root: string; dataDir: string; isDev: boolean }
  config: Readonly<Record<string, unknown>>
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    list(): Promise<string[]>
  }
  usage: {
    /** 本机最近 N 天的 Token / 生图 / 语音用量（N 缺省 30，夹取到 1–90） */
    summary(query?: { days?: number }): Promise<PluginUsageSummary>
  }
  net: {
    fetch(input: {
      url: string; method?: string; headers?: Record<string, string>
      body?: string; timeoutMs?: number
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>
  }
  notify(input: { title: string; body: string }): Promise<boolean>
  banner(input: {
    title: string; body: string; speak?: boolean; sound?: boolean
  }): Promise<boolean>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void
  emitEvent(name: string, payload?: unknown): Promise<void>
  ui: {
    openPanel(panelId: string): Promise<void>
    toast(message: string, kind?: 'info' | 'error'): Promise<void>
    panelEvent(input: { panelId?: string; widgetId?: string; event: string; payload?: unknown }): Promise<void>
  }
  signal: AbortSignal   // 每次工具 / 自动化调用独立
}
```

- `ctx` 是插件进程里的**普通对象**，所有方法都是白名单 RPC 的薄封装；
- 长任务要监听 `ctx.signal`，宿主取消时会 abort；
- 存储键 1–128 位 `[a-zA-Z0-9_.:-]`；超配额回 `E_PLUGIN_INVALID_ARGS`；
- `emitEvent` 只允许清单里声明过的事件名。
- **`ctx.notify` 与 `ctx.banner` 是两条独立通道**：前者走系统通知中心，后者在屏幕顶端弹
  流光 + 置顶卡片（可选朗读 / 提示音）。两者都归 `notifications` 权限，谁也不能降级成对方 ——
  系统通知被关掉时，流光提醒仍然可用。`banner` 返回 `false` 表示没显示（同内容去重合并、
  队列已满 8 条、窗口不可用），**不是错误**，不要重试。

#### 4.1.1 `ctx.banner`：流光提醒（v0.5.6 起）

```js
// 最小用法：只给标题和正文（标题必填，正文允许空串 —— 此时卡片只显示标题）
await ctx.banner({ title: '整理完成', body: `已归档 ${count} 个文件` })

// 可选：本条关闭语音 / 提示音
await ctx.banner({ title: '后台任务结束', body: '导出已保存到桌面', speak: false, sound: false })
```

| 入参 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 标题（≤ 120 字，超出由宿主截断；空白时回落成插件名） |
| `body` | 是 | 正文（≤ 800 字，超出截断；允许空串） |
| `speak` | 否 | 是否朗读本条（缺省跟随用户设置） |
| `sound` | 否 | 是否播提示音（缺省跟随用户设置） |

- **返回 `boolean`**：`true` = 已排入展示（立刻显示或排在队列里），`false` = 没显示
  （同内容 3 秒内被去重、队列已满 8 条、提醒窗口不可用）。**不要重试**，也不要把它当异常。
- **宿主统一排队的**：同一时刻只显示一条，其余按到达顺序排队；提示音 / 音量 / 语音朗读 /
  卡片宽度 / 停留时长都由用户在「设置 → 提醒」里配置，插件**不能**覆盖这些（见下一条）。
- **`speak` / `sound` 是「只能再关」**：用户在提醒设置里关掉提示音或朗读后，
  插件传 `sound: true` / `speak: true` 也不会响 —— 总闸优先；用户开着时，插件仍可让
  某一条静音 / 不读。朗读还要求用户在「语音」页配好 TTS，未配置时静默跳过（不报错）。
- **什么时候用哪个**：需要「用户点一下就打开某个文件 / 文件夹」用 `ctx.notify`（系统通知带点击）；
  只需要「把结果醒目地告诉用户」用 `ctx.banner`（更醒目、支持朗读，但没有可点入口）。

#### 4.1.2 `ctx.usage`：把用量展示在面板里（2026-10 起）

需要 `usage` 权限。返回本机最近 N 天（缺省 30，夹取 1–90）的只读聚合：

```js
async invokePanel(panelId, method, params, ctx) {
  const stats = await ctx.usage.summary({ days: 30 })
  const rows = [
    { label: 'Token 总量', value: stats.tokens.totalTokens.toLocaleString() },
    { label: '缓存命中', value: stats.tokens.cachedTokens.toLocaleString() },
    { label: '命中率', value: `${Math.round(stats.tokens.cacheHitRate * 100)}%` },
    { label: '生图', value: `${stats.images.generated} 次` },
    { label: '语音合成 / 识别', value: `${stats.voice.tts} / ${stats.voice.stt} 次` },
  ]
  return { schema: { version: 1, nodes: [{ type: 'keyValue', items: rows }] } }
}
```

```ts
interface PluginUsageSummary {
  days: number
  from: string // YYYY-MM-DD（含）
  to: string   // YYYY-MM-DD（含）
  tokens: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens: number
    rounds: number
    cacheHitRate: number                 // cachedTokens / promptTokens，0–1
    background: {                        // 其中后台自感知分析消耗
      promptTokens: number; completionTokens: number; totalTokens: number
      cachedTokens: number; rounds: number
    }
  }
  images: { generated: number }          // 成功生图次数
  voice: { tts: number; ttsChars: number; stt: number; sttChars: number }
  daily: Array<{
    date: string                         // 本地日期（含空白日）
    tokens: { promptTokens: number; completionTokens: number; totalTokens: number
              cachedTokens: number; rounds: number; cacheHitRate: number }
    images: number
    voice: { tts: number; stt: number }
  }>
}
```

- **只统计本机、从支持该接口的版本起累积**：升级前的历史用量没有逐日记录，不回溯；
- 只返回计数，不含提示词 / 回复 / 图片 / 音频 / 文件名 / 凭据；
- 按本地日期分桶，账本保留 90 天；`daily` 里没有数据的日期也会出现（值为 0），适合直接画折线；
- 生图 / 语音只计**成功**调用；provider 没回传 Token usage 的轮次不计入，也不会伪造 0。


### 4.2 返回值与超时

| 调用 | 返回值 | 超时 |
| --- | --- | --- |
| `invokeTool` | `{ content, isError?, summary? }`，content ≤ 100 KB | `min(timeoutMs ?? 60s, 600s)` |
| `invokeCommand` | `{ prompt?, summary? }` | 10s |
| `invokeAutomationAction` | `{ summary? }` | 120s |
| `invokePanel` | `{ schema?, toast?, data? }` | 10s |
| `invokeWidget` | `{ schema?, toast?, data? }` | 10s |
| `activate` / `deactivate` | 无 | 10s / 3s |
| `onEvent` | 无 | 10s |

工具抛错 → `E_PLUGIN_TOOL_FAILED`；主动返回 `isError: true` 可以让模型看到错误文本而不算崩溃。

---

## 5. 订阅宿主事件

清单：

```json
{ "permissions": ["events"], "events": ["settings.changed", "message.assistant"] }
```

可用事件：`settings.changed`、`message.user`、`message.assistant`、`tool.after`、
`session.created`、`session.deleted`、`theme.changed`。

```js
onEvent(event, payload, ctx) {
  if (event === 'message.assistant') {
    ctx.log('info', '收到回复', { sessionId: payload.sessionId, length: payload.text.length })
  }
}
```

事件只投给**正在运行**的插件；用 `activation: "startup"` + `activate` 里热身的场景更可靠。

---

## 6. 声明式面板

`ui/panel.json`：

```json
{
  "version": 1,
  "nodes": [
    { "type": "heading", "text": "Hello Aurora" },
    { "type": "text", "text": "受控组件，没有 HTML。", "tone": "muted" },
    { "type": "keyValue", "items": [{ "label": "计数", "value": "0" }] },
    { "type": "button", "text": "计数 +1", "action": { "method": "bump", "toast": "已更新" } }
  ]
}
```

组件：`stack / row / grid / card / divider / heading / text / badge / progress / image / list /
table / keyValue / button / input / textarea / select / toggle / number / slider`。

- 节点 ≤ 500、深度 ≤ 20、整份 JSON ≤ 256 KB；
- 输入控件的 `bind` 会成为 `invokePanel(..., params.values[bind])`；
- 按钮 `action.confirm` 先弹内置确认条，确认后才调用；
- 返回新的 `schema` 可以替换当前面板（动态刷新）。

`invokePanel` 示例：

```js
async invokePanel(panelId, method, params, ctx) {
  if (panelId !== 'board') throw new Error(`未知面板：${panelId}`)
  const count = Number(await ctx.storage.get('count') ?? 0)
  if (method === 'bump') await ctx.storage.set('count', count + 1)
  const next = method === 'bump' ? count + 1 : count
  return { schema: boardSchema(next), ...(method === 'bump' ? { toast: `计数 ${next}` } : {}) }
}
```

---

## 7. 沙箱页面（webview）

`manifest.json`：

```json
{ "permissions": ["ui.panels"], 
  "contributes": { "panels": [{ "id": "info", "title": "插件页面", "icon": "Globe", "entry": "ui/page.html" }] } }
```

页面只能使用：

```html
<script src="page.js"></script>
```

```js
const result = await window.auroraPlugin.request('status', { foo: 1 })
// result 是 invokePanel 返回的 { schema?, toast?, data? }
console.log(result.data)

const off = window.auroraPlugin.onEvent((event, payload) => console.log(event, payload))
```

限制与提示：

- CSP：`connect-src 'none'`、`script-src 'self'` —— **不能内联脚本**、不能直接 `fetch`；
  需要出网就在 `invokePanel` 里用 `ctx.net.fetch`，把数据放进 `data` 返回；
- 页面拿不到 `window.aurora`、Node、文件系统；`window.open` / 外部导航 / 下载 / 权限请求都会被拒绝；
- 页面运行在 `plugin-<id>` 非持久 session；宿主动态注册协议、设置专用 preload；
- 页面 `request` 的 `method` ≤ 64 字符，params ≤ 256 KB；
- 推荐自己带一份暗色 / 亮色 CSS（页面拿不到宿主令牌）；可参考示例 `ui/page.css`。

### 7.1 在 Aurora Center 上的差异

同一份页面也会被 Center 托管（`/p/<id>/<version>/<entry>`，见 docs/12 §6.5），差别：

- **能力更窄**：iframe 固定 `sandbox="allow-scripts"`（opaque origin），没有 `localStorage` /
  `sessionStorage` / cookie / IndexedDB，也没有 `alert` / `confirm` / `prompt` / `showModal`、
  表单提交、弹窗、下载、Worker、音视频；CSP 为 `connect-src 'none'`，**不能自己 `fetch`
  （连包内 JSON 也不行）**。需要的数据一律经 `request` 拿。
- **资源只从市场包出**：页面版本必须已发布到该 Center 的市场，本机目录 / 未发布版本打不开；
  不要引用外部 CDN / 字体。
- **`params` 原样到达** `invokePanel`：与桌面 `request(method, params)` 完全一致，没有额外的
  `{ params, values }` 包装（那是声明式面板的）。
- **视图状态与桌面共享**：Center 的切视图 / 切周会写回同一份插件状态，等于改桌面视图；
  需要两端即时同步就在写操作后 `ctx.ui.panelEvent`。
- 页面自行导航离开（`pagehide`）后中继会断开，用户需要重新打开面板。

---

## 7.5 桌面 / 提示条小组件

清单（每插件 ≤ 4 个）：

```json
{ "permissions": ["ui.widgets"],
  "contributes": { "widgets": [
    { "id": "duty-week", "title": "本周值日", "icon": "CalendarClock", "slot": "desktop",
      "windowLevel": "desktop", "windowMaterial": "acrylic",
      "schema": "ui/widget.json", "defaultSize": { "width": 300, "height": 200 } },
    { "id": "todo-strip", "title": "事务", "icon": "ListChecks", "slot": "edge-bar",
      "schema": "ui/strip.json" }
  ] } }
```

- `slot = "desktop"`：默认置顶浮动卡片，位置 / 尺寸 / 显隐由用户在设置页或拖动决定并持久化；
- `slot = "edge-bar"`：提示条展开面板底部的条目，**只允许声明式 schema**（不能 `entry`）。
- schema 与面板同一套组件与限额；动作调用 `invokeWidget(widgetId, method, params, ctx)`；
- 页面型桌面 widget 用 `entry`，内部仍走 `aurora-plugin://` + 专用 preload（无法在提示条使用）。

桌面 widget 可选的窗口字段（只对 `slot = "desktop"` 生效，**不新增权限 / 宿主 API**）：

- `windowLevel`：`"floating"`（默认，置顶浮动）/ `"normal"`（普通 z-order）/
  `"desktop"`（不置顶并尽力贴合桌面层，Win+D / Win+M 后仍尽量可见，失败回落 `normal`）。
  `desktop` 是普通窗口 + Win32 owner 亲和 + 最小化恢复守护，不是壁纸嵌入 / 桌面图标层 / 点击穿透；
- `windowMaterial`：`"none"`（默认，不透明卡片）/ `"acrylic"`（原生 Acrylic，需 Windows 11 22H2+
  且外观毛玻璃开启；不满足时保持不透明卡片）；
- 两个字段只对桌面小组件有效：`slot = "edge-bar"` 声明非默认值会在清单校验被拒绝；
- 用户在设置 → 插件详情可给每个桌面 widget 覆盖层级（跟随插件 / 置顶 / 普通 / 桌面层），
  覆盖值写在 `<userData>/plugin-widget-layout.json` 的 `windowLevelOverride`，不改清单；
- 旧宿主会**静默忽略**未知字段：用这两个字段时把 `minAuroraVersion` 设为支持它们的宿主版本，
  否则旧宿主按默认 `floating` / `none` 渲染。

```js
async invokeWidget(widgetId, method, params, ctx) {
  if (method === 'bump') return { schema: nextSchema(await bump(ctx)), toast: '已更新' }
  return { schema: currentSchema(await count(ctx)) }
}
```

### 7.6 让已打开的面板 / 小组件即时刷新

```js
await ctx.ui.panelEvent({ panelId: 'board', event: 'count-changed', payload: { count } })
await ctx.ui.panelEvent({ widgetId: 'duty-week', event: 'count-changed', payload: { count } })
```

- `panelId` / `widgetId` 二选一，目标必须在清单声明过；事件名 `^[a-z][a-z0-9_.-]{0,63}$`；
- payload ≤ 64 KB；每插件每秒 ≤ 20 条，超出丢弃（不会让你的调用抛错）；
- 宿主会把事件转成一次 `invokePanel(..., 'event', ...)` / `invokeWidget(..., 'event', ...)`，
  返回的新 schema 直接替换当前画面；页面型目标收到 `window.auroraPlugin.onEvent`；
- 同一事件只投给你自己的面板 / 小组件，不会串到别的插件。

## 8. 主题

```json
{ "permissions": ["themes"],
  "contributes": { "themes": [{ "id": "sand", "name": "沙丘",
    "tokens": { "--bg-base": "#141210", "--text-primary": "#f5f0e8" } }] } }
```

可用令牌见 [14 §7](./14-plugin-system.md)；**不能**覆盖强调色与毛玻璃。
用户在设置 → 插件 → 插件主题里选择；插件停用 / 卸载时令牌自动清理。

---

## 9. 自动化

清单：

```json
{ "permissions": ["automation", "automation.events"],
  "contributes": { "automation": {
    "actions": [{ "name": "add", "title": "添加待办", "description": "...", "fields": [] }],
    "events": [{ "name": "todo-added", "title": "新增待办" }]
  } } }
```

- 用户在「自动化」里用「插件事件」触发 / 「插件动作」执行；
- `params` 在表单里是 JSON 对象文本（≤ 8 KB），到 `invokeAutomationAction` 时已解析成对象；
- 插件动作里再 `emitEvent` 同名事件**不会**再次触发同一条自动化（宿主有防自激守卫）。

---

## 10. 打包与校验

```bash
# 仓库内：独立校验目录或 zip（需要先 pnpm build:packages）
node scripts/verify-plugin.mjs examples/plugins/hello-aurora
node scripts/verify-plugin.mjs ./hello.zip
```

它会检查：清单 schema、`apiVersion`、工具名长度、`main` / Skill / 面板 / **小组件** / 图标路径、
zip 路径安全、大小与压缩比、`manifest.json` 是否在包根。退出码 0 = 通过。

打包要点：

- zip **根目录**必须直接是 `manifest.json`；
- 不要带 `node_modules`（运行时不需要依赖目录；需要第三方库就打包进 `main.js`）；
- 单文件 ≤ 10 MB、总量 ≤ 50 MB、条目 ≤ 2000。

---

## 11. 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| 安装时「清单校验失败：声明了该贡献但缺少权限」 | 加了工具 / 命令 / 面板却忘了在 `permissions` 声明 |
| 「最终工具名超过 64 字符」 | `plugin.<id>.<name>` 太长；缩短 id 或工具名 |
| 「main 入口不存在」 | `main` 路径大小写 / 目录层级不对（包根相对路径） |
| 「Skill 目录缺少 SKILL.md」 | `skills` 指向的目录必须直接含 `SKILL.md`（或下一层技能目录） |
| 插件一直 `E_PLUGIN_NOT_READY` | `apiVersion` 不是 1、`minAuroraVersion` 高于本机、或进程启动即抛错（看插件日志） |
| 页面白屏 / `ERR_FAILED` | 页面放在包内且扩展名在白名单；入口路径大小写正确；不要用绝对路径 |
| 页面 `请求失败：页面尚未就绪` | 页面在 guest 就绪前发请求，宿主已兜底；持续出现看主进程日志 |
| 工具每次都弹确认 | 清单 `sensitivity: "safe"` 但插件尚未「信任」；信任后才免确认 |
| 只读档看不到工具 | 只注册 `readonly: true` 的工具 |
| `E_PLUGIN_PERMISSION` | 调了未声明的宿主 API（storage / net / notify / config / events…） |
| 自动化不触发 | 事件名 / 插件 id 与清单不一致；或事件在自动化执行期间被防自激守卫忽略 |

---

## 12. 给其他 Agent 的提示词模板

> 以下段落可直接粘贴给在**其他项目**里工作的编码 Agent。把 `<...>` 换成你的信息。

### 12.1 新建一个最小插件

```text
你要为 Aurora（Windows 桌面 Agent 工具）写一个插件。请创建目录 <plugin-dir>，包含：
1. manifest.json：id 用反向域名 <com.yourname.plugin>，apiVersion=1，minAuroraVersion="0.5.0"，
   main="main.js"，activation="lazy"，只声明真正需要的 permissions；
2. main.js：CommonJS，导出 invokeTool(name, input, ctx)；工具名与清单一致（不含 plugin. 前缀）；
3. 一个 SKILL.md（如果贡献 skills）；
4. README.md 写清安装与行为。
约束：所有贡献必须在 manifest.json 声明，运行时不得动态注册；工具参数是 type:"object" 的 JSON Schema；
返回 { content, isError?, summary? }，content 只能是文本。不要访问 Aurora 凭据。
最后在 Aurora 仓库根运行 `node scripts/verify-plugin.mjs <plugin-dir>` 并修到通过。
```

### 12.2 给已有插件加一个声明式面板

```text
在 <plugin-dir> 里新增一个右栏声明式面板：
1. manifest.json 的 permissions 增加 "ui.panels"；
2. contributes.panels 增加 { id, title, icon（必须在图标白名单里）, schema: "ui/panel.json" }；
3. 新建 ui/panel.json：{ "version": 1, "nodes": [...] }，只用白名单组件（heading/text/keyValue/button/...），
   按钮动作写 { method, params?, confirm?, toast? }；
4. main.js 增加 invokePanel(panelId, method, params, ctx)，返回 { schema?, toast? }；
作业完成后运行 verify-plugin.mjs。
```

### 12.3 加一个沙箱页面

```text
在 <plugin-dir> 里新增页面型面板：
1. permissions 增加 "ui.panels"；contributes.panels 用 entry: "ui/page.html"（与 schema 二选一）；
2. page.html 只通过 <script src="page.js"> 加载脚本（CSP 禁止内联）；
3. 页面调用 window.auroraPlugin.request(method, params)，结果取 invokePanel 返回的 data；
4. 页面不能 fetch/直接出网：需要数据就在 invokePanel 里用 ctx.net.fetch 再放进 data；
5. 不要引用外部 CDN / 字体；自带 CSS。
完成后运行 verify-plugin.mjs。
```

### 12.4 代码审查清单（可当 review 提示词）

```text
审查这个 Aurora 插件目录，逐条检查：
- manifest：id/工具名长度、权限与贡献是否一一对应、路径是否都在包内、apiVersion=1；
- 工具：参数是 object schema、返回值只有文本、长任务监听 ctx.signal；
- 存储：键是否合法、避免存超大对象（单值 256 KB / 总量 5 MB）；
- 网络：只在 net 权限下经 ctx.net.fetch，不把响应原样塞进超大工具结果；
- 面板：只用白名单组件、节点/深度/大小不超限、按钮动作有 confirm 时确认文案清楚；
- 页面：无内联脚本、无外部资源、无 window.aurora 依赖、出网走 invokePanel；
- 安全：不读取 / 外发用户文件，不尝试绕过确认卡；安装即信任的说明是否写清。
输出：按严重程度列出问题与最小修复建议。
```
