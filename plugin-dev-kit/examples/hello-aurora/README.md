# Hello Aurora

Aurora 插件系统的示例：一个 `echo` 工具、一个 Skill、四条斜杠命令、两个配置项、
本机用量统计（`ctx.usage`），以及一条「自动化动作 + 事件」链路。

## 安装

- 设置 → 插件 → 安装插件包，选择本目录打包出的 `.aurora-plugin` / `.zip`；
- 或在设置 → 插件 → 开发页把本目录加进开发目录（原地加载、改文件自动重启）。

## 文件

```
manifest.json                 清单：贡献与权限、配置字段、订阅的宿主事件
main.js                       处理器：工具 / 命令 / 自动化动作 / 面板 / 事件 / 配置变化
skills/hello/SKILL.md         插件贡献的 Skill
ui/panel.json                 声明式面板（受控组件）
ui/page.html|js|css           沙箱页面（auroraPlugin.request）
types/aurora-plugin.d.ts      契约类型（编辑器补全用）
```

## 行为

- 工具 `plugin.com.example.hello.echo`：原样回显 `text`；
- 命令 `/hello [补充]`：prompt 命令，把打招呼提示词追加给 Agent；
- 命令 `/hello-count`：action 命令，计数 +1 并触发 `count-changed` 插件事件；
- 命令 `/hello-usage`：action 命令，读取本机最近 7 天的 Token / 缓存命中 / 生图 / 语音次数；
- 自动化动作 `add-count`：计数 +1、触发 `count-changed`；打开「计数时发系统通知」后同时弹通知；
- 宿主事件：订阅了 `settings.changed`，只在插件日志里记录（不打扰用户）。

## 试一条自动化

1. 设置 → 自动化 → 新建，触发选「插件事件」，插件 id 填 `com.example.hello`、事件填 `count-changed`；
2. 添加操作「插件动作」，插件 id 同理、动作填 `add-count`，参数留空；
3. 在对话里输入 `/hello-count`，运行历史里会出现一条由插件事件触发的记录。

插件以你的用户权限运行，安装前请确认来源可信。
