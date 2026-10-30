# 可直接粘贴的提示词

> 把 `<插件目录>`、`<插件工具包路径>`、`<需求>` 换成你的实际值。
> 建议先让 Agent 读 `AGENTS.md`，再发对应任务。

## 1. 新建一个插件

```text
你要为 Aurora v0.5.8（插件 API v1）开发一个插件，目录：<插件目录>。

先读（必须）：
- <插件工具包路径>/AGENTS.md
- <插件工具包路径>/docs/01-contract.md
- <插件工具包路径>/docs/02-guide.md
- <插件工具包路径>/examples/class-board/

需求：<需求>。

要求：
1. 复制模板结构（manifest.json / main.js / ui/），先写清单再实现处理器；
2. 所有贡献（工具 / 命令 / 面板 / 小组件 / 配置）必须写在 manifest.json，运行期不得动态注册；
3. 只声明真正需要的 permissions；界面只用白名单声明式组件；
4. 工具返回 { content, isError?, summary? }，content 只能是文本；
5. 如需即时刷新，使用 ctx.ui.panelEvent（panelId / widgetId 二选一，目标是清单里声明过的）；
6. 完成后运行 node <插件工具包路径>/tools/check-plugin.mjs <插件目录>，修到退出码 0；
7. 输出：插件 id、权限、工具、面板 / 小组件、推送目标、校验结果。
```

## 2. 给已有插件加桌面 / 提示条小组件

```text
在 <插件目录> 里新增小组件。

先读 <插件工具包路径>/docs/01-contract.md 的「小组件」与 <插件工具包路径>/template/ui/。

要求：
1. manifest.json 的 permissions 增加 "ui.widgets"；
2. contributes.widgets 增加：
   - 桌面：{ id, title, icon, slot: "desktop", schema: "ui/widget.json", defaultSize: { width, height } }
   - 提示条：{ id, title, icon, slot: "edge-bar", schema: "ui/strip.json" }
3. 提示条小组件只允许 schema，不能写 entry / defaultSize；
4. main.js 实现 invokeWidget(widgetId, method, params, ctx)，返回 { schema, toast? }；
5. schema 只用白名单组件，单插件 widgets ≤ 4；
6. 运行 node <插件工具包路径>/tools/check-plugin.mjs <插件目录>。
```

## 3. 让 Agent 操作后面板 / 小组件即时刷新

```text
给 <插件目录> 增加事件推送。

要求：
1. 权限已包含 ui.panels / ui.widgets（按目标选择）；
2. 在状态变化后调用：
   await ctx.ui.panelEvent({ panelId: '<面板 id>', event: '<事件名>', payload: <纯数据> })
   await ctx.ui.panelEvent({ widgetId: '<小组件 id>', event: '<事件名>', payload: <纯数据> })
3. panelId / widgetId 二选一，必须在本插件 manifest 中声明；
4. 事件名匹配 ^[a-z][a-z0-9_.-]{0,63}$，payload ≤ 64 KB，每秒 ≤ 20 条；
5. invokePanel / invokeWidget 要处理 method === 'event'，返回新的 schema；
6. 不要用轮询或让用户点刷新。
```

## 4. 加一个沙箱页面

```text
给 <插件目录> 加一个页面型面板。

要求：
1. permissions 已含 "ui.panels"；
2. contributes.panels 用 { id, title, icon, entry: "ui/page.html" }（与 schema 二选一）；
3. page.html 只用 <script src="page.js">，不能内联脚本、不能引 CDN；
4. 页面用 window.auroraPlugin.request(method, params) 与 onEvent；
5. 页面不能 fetch / 开窗 / 下载；需要数据时在 invokePanel 里用 ctx.net.fetch 后放进 data；
6. 页面型小组件只能放桌面槽位；提示条不允许 entry。
```

## 5. 代码审查提示词

```text
审查 <插件目录>，逐条检查并输出「问题 + 最小修复」：

清单：
- id / 版本 / apiVersion=1；权限与贡献一一对应；路径都在包内；
- 工具名 ≤ 25、最终名 plugin.<id>.<name> ≤ 64；参数是 type:"object"；
- 面板 schema 与 entry 二选一；小组件 ≤ 4，提示条只有 schema；

运行期：
- invokeTool 只返回文本，长任务监听 ctx.signal；
- 存储键合法，单值 ≤ 256 KB、总量 ≤ 5 MB；
- panelEvent 目标在本插件清单内，payload ≤ 64 KB，不跨插件；
- 页面无内联脚本 / 外部资源 / fetch，只依赖 auroraPlugin；

安全：
- 不读取 / 外发用户文件与凭据；写操作有 confirm 或明确说明；
- 文案如实写明「插件不是 OS 沙箱，安装即信任」。
```
