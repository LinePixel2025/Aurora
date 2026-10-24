# 给编码 Agent 的插件开发规则

你正在为 **Aurora v0.5.1**（插件 API v1）开发插件。先读：

1. `docs/01-contract.md`（契约与安全边界，SSOT）
2. `docs/02-guide.md`（逐节 API 用法）
3. `template/` 或 `examples/class-board/`

## 硬规则

1. **清单优先**：工具 / Skill / 命令 / 自动化动作与事件 / 面板 / 小组件 / 主题 / 配置字段
   必须全部写在 `manifest.json`；运行期不得动态注册。
2. **权限成对**：声明某类贡献就必须在 `permissions` 声明对应权限，否则安装失败。
   最小权限原则：只声明真正用到的权限。
3. **界面只用声明式 schema**：节点类型必须在白名单内；没有 HTML / `v-html`；
   提示条小组件（`slot: "edge-bar"`）**只允许 `schema`**，不允许 `entry` / `defaultSize`。
4. **页面只走沙箱**：`entry` 页面只能放在桌面小组件或面板；页面只有
   `window.auroraPlugin.request/onEvent`，不能 `fetch`、不能内联脚本、不能引外部资源。
5. **工具默认 confirm**：清单 `sensitivity: "safe"` 只是声明，未「信任此插件」前仍按 confirm；
   `readonly: true` 才会在只读档注册。
6. **工具结果只返回文本**：`{ content, isError?, summary? }`，content ≤ 100 KB。
7. **推送只发自己的目标**：`ctx.ui.panelEvent` 的 `panelId` / `widgetId` 二选一，
   必须是本插件清单里声明过的；事件名 `^[a-z][a-z0-9_.-]{0,63}$`；payload ≤ 64 KB；
   每插件每秒 ≤ 20 条。
8. **不碰 Aurora 凭据**：不读取 API Key / MCP env / safeStorage；插件配置不支持密文字段。
9. **不修改插件目录以外的文件**；不调用系统提权；不在仓库里写 `node_modules`。
10. **安全边界如实写**：插件进程不是 OS 沙箱，安装即信任。README 与提示文案不得宣称隔离。

## 工作流

1. 复制 `template/` 或参考 `examples/class-board/`；
2. 先写 `manifest.json`，再按名字实现 `main.js` 的处理器；
3. 静态资源放 `ui/`，页面脚本用 `<script src="...">`；
4. 每次改完运行：

```bash
node tools/check-plugin.mjs <插件目录>
```

5. 修到退出码 0；若在 Aurora 源码环境，再跑 `node scripts/verify-plugin.mjs <目录|zip>`；
6. 交付时列出：插件 id、版本、权限、工具、面板 / 小组件、事件推送目标、验证命令与结果。

## 禁止

- `manifest.json` 之外的运行期注册；
- 在提示条小组件里塞 webview；
- 用 `v-html` / 内联脚本 / 外部 CDN；
- 把超大对象塞进工具结果或事件 payload；
- 在没有用户确认的路径上执行写文件 / 命令等有副作用动作。
