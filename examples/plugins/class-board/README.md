# 班级事务（示例插件）

演示 Aurora 插件系统的三类界面能力：

- **桌面小组件** `duty-week`：本周值日，置顶浮动卡片，位置 / 尺寸 / 显隐自动记住；
- **提示条小组件** `today-tasks`：今日事务，渲染在提示条展开面板底部（只接受声明式 schema）；
- **事件推送**：Agent 工具 `add_task` 或面板按钮写入事务后，通过 `ctx.ui.panelEvent`
  让已打开的面板与小组件**不点刷新**立即更新。

数据只存在插件私有存储（`<userData>/plugin-data/com.example.classboard/storage.json`），
不读写用户文件，也不接触 Aurora 凭据。

## 安装（开发态）

1. 启动客户端：仓库根执行 `pnpm dev`；
2. 设置 → 插件 → **开发** → 添加目录，选择本目录
   （`examples/plugins/class-board`）；
3. 插件立即加载，桌面右上角出现「本周值日」卡片；提示条展开后底部出现「今日事务」。

也可以打包成 zip 后在「已安装」里安装：

```powershell
Compress-Archive -Path manifest.json,main.js,ui -DestinationPath class-board.zip -Force
```

安装前会展示权限（`ui.widgets` 单独列出）与 SHA-256。

## 试一遍推送

1. 主界面右栏「＋」→ 插件面板 → 班级事务，打开面板；
2. 在输入框填一条事务并点「添加」，或让 Agent 调用 `add_task` 工具；
3. 面板计数 / 列表、桌面「本周值日」、提示条「今日事务」会同时刷新，不需要点面板右上角的「刷新」。

## 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 权限与全部贡献（工具 / 命令 / 面板 / 小组件 / 配置） |
| `main.js` | `invokeTool` / `invokeCommand` / `invokePanel` / `invokeWidget` |
| `ui/panel.json` | 右栏声明式面板的初始 schema |
| `ui/duty.json` | 桌面小组件 schema |
| `ui/tasks.json` | 提示条小组件 schema |

约定：所有界面都是声明式组件，没有 HTML / 脚本注入面；页面型小组件只在桌面槽位允许，
提示条槽位在清单校验阶段就会拒绝 `entry`。
