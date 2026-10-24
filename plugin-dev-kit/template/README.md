# Agent 插件模板

复制本目录后按顺序改：

1. `manifest.json`：`id`（反向域名、全小写）、`name`、`version`、`description`、`author`；
2. `main.js`：替换 `invokeTool` / `invokePanel` / `invokeWidget` 的处理器；
3. `ui/*.json`：替换面板 / 小组件的初始 schema；
4. 按需增删 `permissions` 与 `contributes`（贡献与权限必须成对）；
5. 运行校验：

```bash
node ../tools/check-plugin.mjs .
```

## 已演示的能力

- `echo` 工具（safe、只读）；
- 声明式面板 `home`；
- 桌面小组件 `card`（`slot: "desktop"`）与提示条小组件 `strip`（`slot: "edge-bar"`）；
- 计数写入 `ctx.storage` 后，用 `ctx.ui.panelEvent` 同时刷新面板与两个小组件。

## 注意

- 提示条小组件只能声明 `schema`，不能写 `entry` / `defaultSize`；
- 工具结果只返回文本；写操作请保留 `confirm`；
- 插件进程不是 OS 沙箱，安装即信任。
