# 08 · 设置与首次安装引导

状态：`已定稿`（v1 基线）

## 1. 配置 Schema（config.json，v1）

```jsonc
{
  "version": 1,
  "general": {
    "language": "zh-CN",
    "launchAtLogin": false,
    "hotkey": "Alt+Space",
    "edgeBar": { "enabled": true, "opacity": 0.9, "quietHours": null }
  },
  "llm": {
    "active": "deepseek",
    "providers": {
      "deepseek": {
        "type": "openai-compat",
        "baseUrl": "https://api.deepseek.com",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "deepseek-chat",
        "temperature": 0.7
      }
    }
  },
  "modes": {
    "current": "classroom",
    "classroom": {
      "guideCompleted": false,
      "watchDir": "",
      "subjects": [ { "name": "数学", "folder": "分类/数学", "keywords": [] } ],
      "schedule": { "provider": "manual", "lessons": [] },
      "preClassReminder": true
    },
    "work": { "guideCompleted": false },
    "code": { "guideCompleted": false }
  },
  "skills": { "userDir": "", "disabled": [] },
  "mcp": {
    "servers": [
      { "name": "example", "transport": "stdio", "command": "npx", "args": [], "envEnc": {} }
    ]
  },
  "advanced": { "proxy": "", "logLevel": "info", "quietHours": null }
}
```

- 字段说明：`llm.providers` 支持多组模型配置，`llm.active` 指定默认；`modes.classroom.subjects` 即科目 → 文件夹映射（见 05 §3）；`schedule.provider` 为 `manual | classisland`（见 05 §3.4）。
- 新需求字段一律**先更新本文档 Schema**，再加代码。

### 1.1 仅存在于 IPC 层的字段（非持久化）

`settings:get` / `settings:changed` 回传渲染层的对象会在上述 Schema 之外**补充两个只读标记**，
用于让设置页显示"凭据是否已配置"，同时保证密文永不进入渲染进程：

| 字段 | 位置 | 说明 |
|---|---|---|
| `apiKeySet` | `llm.providers.<id>` | `true` 表示该 provider 已保存 API Key（`apiKeyEnc` 始终回传空串） |
| `envSet` | `mcp.servers[]` | 已配置的环境变量名列表（`envEnc` 始终回传空对象） |

两者由主进程在回传前计算，不写入 `config.json`，因此不参与版本迁移。

## 2. 存储与安全

- 路径：Electron `userData`（`%APPDATA%/Aurora/`），配置文件 `config.json`、会话 `sessions/`、日志 `logs/`、用户技能 `skills/`。
- 写入：原子写（临时文件 + rename）+ 写防抖（300ms）；启动时校验 Schema，非法字段回退默认值。
- 迁移：`version` 字段 + `migrations` 链式执行（v1 起预留）。
- 凭据：`apiKeyEnc` / `envEnc` 用 **safeStorage** 加密后落盘；日志、错误上报、配置导出时一律脱敏（`***`）。

## 3. 首次安装引导流程

```
欢迎（品牌 + 三模式介绍）
  → 语言 / 主题（默认跟随系统，可跳过）
  → AI 模型配置【必填】：provider 预设（DeepSeek / OpenAI / 自定义）+ baseURL + API key + 模型名
        → “测试连接”（展示延迟；可选拉取模型列表）
  → 模式选择（ClassRoom 推荐）
  → 模式引导（若选 ClassRoom）：感知文件夹 + 科目列表 → 完成（见 05 §2）
  → 完成页 → 进入托盘常驻，显示 AI 服务窗
```

- **规则**：AI 模型配置未完成不允许进入主界面（需求：第一次安装要求用户填写）；测试连接失败允许先保存，但持续提示未通过。
- 引导可重跑：设置 → 模式 → “重新引导”。

## 4. 模式切换后的主动引导

- 切换成功 → 检测该模式 `guideCompleted` → 未完成则由 Proactive 在交互窗发起对话式引导（见 05 §2、06 §9）。
- 引导期间设置页对应项同步更新；中断可续接，且可在设置中关闭再次提醒。

## 5. AI 模型设置页

- 多 Provider 管理：新增 / 编辑 / 删除、设为默认。
- 测试连接：展示延迟与可用模型列表（可选拉取）。
- 支持范围：DeepSeek / OpenAI / 其他 OpenAI 兼容（含 Ollama 本地）；P2 再评估更多协议（Anthropic 等）。

## 6. 其他设置页

- **Skill 管理**：内置 Skill 列表 + 用户目录导入 / 添加、启用开关（`skills.disabled`）。
- **MCP 管理**：服务器列表、添加（stdio 命令 / HTTP URL）、连接状态灯、错误日志。
- **高级**：日志查看与导出、代理设置、勿扰时段、重置为默认配置。
