# 08 · 设置与首次安装引导

状态：`已定稿`（v1 基线）

## 1. 配置 Schema（config.json，v2）

```jsonc
{
  "version": 2,
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
      "preClassReminder": true,
      "classification": {
        "autoMove": true,
        "confidenceThreshold": 0.6,
        "fallbackFolder": "待分类"
      }
    },
    "work": { "guideCompleted": false },
    "code": { "guideCompleted": false }
  },
  "skills": { "userDir": "", "disabled": [] },
  "mcp": {
    "lazyConnect": false,
    "servers": [
      { "name": "example", "transport": "stdio", "command": "npx", "args": [], "envEnc": {} }
    ]
  },
  "advanced": {
    "proxy": "",
    "logLevel": "info",
    "quietHours": null,
    "confirmSensitiveTools": true
  }
}
```

- 字段说明：`llm.providers` 支持多组模型配置，`llm.active` 指定默认；`modes.classroom.subjects` 即科目 → 文件夹映射（见 05 §3）；`schedule.provider` 为 `manual | classisland`（见 05 §3.4）。
- `mcp.lazyConnect`：连接策略（见 06 §7）。`false`（默认）= 启动即连；`true` = 首次使用某个 MCP 工具时才连接。
- MCP 环境变量的**变量名**由 `envEnc` 的键表达，设置页据此展示"已配置的变量名"，
  因此 Schema 不额外维护一份 `env` 列表（避免两处数据不一致）。
- `modes.classroom.classification`（v2 新增，见 05 §3.2）：`autoMove` 关闭时只写分类流水、
  不移动文件；`confidenceThreshold` 是进「待分类」的置信度下限；`fallbackFolder` 是兜底目录
  （相对 `watchDir` 或绝对路径）。
- `advanced.confirmSensitiveTools`（v2 新增）：敏感工具（`sensitivity = 'confirm'`，含全部 MCP 工具）
  执行前是否要求用户确认（见 06 §5）。关闭后按 v0.3.0 行为降级为「只记日志留痕、不拦截」。
- 新需求字段一律**先更新本文档 Schema**，再加代码。

### 1.1 仅存在于 IPC 层的字段（非持久化）

`settings:get` / `settings:changed` 回传渲染层的对象会在上述 Schema 之外**补充两个只读标记**，
用于让设置页显示"凭据是否已配置"，同时保证密文永不进入渲染进程：

| 字段 | 位置 | 说明 |
|---|---|---|
| `apiKeySet` | `llm.providers.<id>` | `true` 表示该 provider 已保存 API Key（`apiKeyEnc` 始终回传空串） |
| `envSet` | `mcp.servers[]` | 已配置的环境变量名列表（`envEnc` 始终回传空对象） |

两者由主进程在回传前计算，不写入 `config.json`，因此不参与版本迁移。

### 1.2 不属于 config.json 的本地数据

分类流水与规则缓存**不写入 config.json**（避免配置被高频重写），单独存放：

| 文件 | 内容 | 说明 |
|---|---|---|
| `userData/classification.json` | `{ version, records: ClassificationRecord[] }` | 分类流水（上限 500 条，新的在前）；原子写 + 300ms 防抖 + 损坏备份重建 |

规则缓存**不单独持久化**，启动时由流水中的用户修正记录重建（见 05 §3.2），
因而不新增存储面，也不会与流水出现两处数据不一致。

## 2. 存储与安全

- 路径：Electron `userData`（`%APPDATA%/Aurora/`），配置文件 `config.json`、会话 `sessions/`、
  分类流水 `classification.json`、日志 `logs/`、用户技能 `skills/`。
- 写入：原子写（临时文件 + rename）+ 写防抖（300ms）；启动时校验 Schema，非法字段回退默认值。
- 迁移：`version` 字段 + `migrations` 链式执行。当前 `CONFIG_VERSION = 2`：
  `v0 → v1`（补齐 version、扁平字段归一、`llm.apiKey → apiKeyEnc`）、
  `v1 → v2`（补齐 `modes.classroom.classification` 与 `advanced.confirmSensitiveTools`，幂等且不覆盖已有值）。
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
- **实现状态（v0.1.0）**：引导窗共 5 步（欢迎 → AI 模型 → 模式选择 → 模式设置 → 完成），
  其中「模式设置」对 ClassRoom 为表单式（感知文件夹 / 科目列表 / 课前提醒），
  Work / Code 只显示占位说明；「重新引导」会重置 `guideCompleted` 并唤起对话窗口。

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
  - 实现状态（v0.3.0）：列表读写与凭据脱敏沿用 v0.1.0；**状态灯**由 `mcp:status` /
    `mcp:statusChanged` 驱动（`ready` / `connecting` / `error` 三态，`error` 时展示
    最近一次失败原因），`lazyConnect` 可在设置页切换。
- **高级**：日志查看与导出、代理设置、勿扰时段、重置为默认配置。
  - 实现状态（v0.1.0）：代理与日志级别已写入配置（消费方在 P3 接入）；勿扰时段可读写。
  - 实现状态（v0.5.0）：**勿扰时段已实际拦截主动行为**——敏感工具确认在时段内直接拒绝
    （`ProactiveScheduler.isQuietHour`），课前提醒在时段内静默跳过。新增
    「敏感工具确认」开关（`advanced.confirmSensitiveTools`，默认开启）：关闭后敏感工具
    不再询问用户，降级为「只记日志留痕」，且**每次调用即时判断**，改设置无需重启。

## 7. ClassRoom 模式设置页（v0.4.0）

模式为 ClassRoom 时，模式页渲染完整配置区（`renderer/settings/components/ClassroomSection.vue`）：

- **智慧感知文件夹**：输入绝对路径 + 「打开文件夹」（`app:openPath` 的 `watchDir`）。
- **科目列表**：增 / 删 / 改名，每科可配**目标文件夹**与**分类关键词**；
  改科目名会同步改写引用它的课程表条目，删除时提示仍有多少节课引用该科目。
- **课程表**：`schedule.provider`（manual / classisland）+ 课程行
  （星期 0–6 中文、起止 `HH:mm`、科目下拉）。
- **课前提醒**：`modes.classroom.preClassReminder` 开关。
- **分类行为**：`classification.autoMove`（自动移动）、`confidenceThreshold`（0–1 滑条）、
  `fallbackFolder`（兜底目录）。
- **分类流水**：内嵌 `ClassificationLedger`（默认展开，50 条），可就地修正与打开文件夹。

写入统一走 `settings.update({ modes: { ...当前 modes, classroom: { ...当前 classroom, ...补丁 } } })`：
`settings:update` 是**按顶层分组浅合并**，因此必须展开当前分组，否则会丢掉未被提及的子字段。
