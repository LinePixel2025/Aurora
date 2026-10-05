# 08 · 设置与首次安装引导

状态：`已定稿`（v1 基线）

## 1. 配置 Schema（config.json，v30）

```jsonc
{
  "version": 30,
  "general": {
    "language": "zh-CN",
    "launchAtLogin": false,
    "hotkey": "Alt+Space",
    // v20 新增：要求以管理员身份运行（出厂 true）。启动时若当前进程未提权，用 UAC
    // 重新拉起一个管理员实例（先释放单实例锁再退出，否则子进程会因「已有实例」秒退）；
    // 用户拒绝 UAC 时不阻断启动（以普通权限继续 + 记 warn）；改动重启后生效。
    // 只读：AI 的 set_setting 一律拒绝，只能由用户在设置页改（见下方 advanced.readonlyPrefixes）
    "requireAdmin": true,
    "edgeBar": {
      "enabled": true,
      "opacity": 0.9,
      "quietHours": null,
      // v21 新增：提示条贴附的显示器与屏幕侧（默认主显示器 + 右缘）
      "display": "primary", // 'primary' 主显示器 | 'cursor' 跟随鼠标所在显示器
      "position": "right", // 'right' 屏幕右缘 | 'left' 屏幕左缘
    },
    // v30 新增：检测到 Game Bar 游戏或独占全屏 D3D 应用后，
    // 自动隐藏提示条并暂停文件自感知；退出后恢复。仅 Windows 生效。
    "gameMode": { "enabled": true },
    // v8 新增：对话窗展示偏好
    "chat": { "showThinking": true }, // 对话界面展示思考过程（MessageList 可折叠思考块的门控，docs/07 §2.3）
    // 各窗口位置 / 尺寸记忆，key 集合见 WINDOW_NAMES
    "windowState": {},
  },
  // v21 新增：外观自定义（用户在设置页选，Agent 也可经 set_setting 调）
  "appearance": {
    "accent": "aurora", // 界面强调色：aurora 品牌蓝（默认）| teal | violet | rose | amber
  },
  "llm": {
    "active": "deepseek",
    "providers": {
      "deepseek": {
        // v22 新增：接口协议（openai-compat = /chat/completions | openai-responses = /responses，见 06 §3.2）
        "type": "openai-compat",
        "baseUrl": "https://api.deepseek.com",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "deepseek-chat", // 唯一生效值：请求实际用的模型就是它
        // v23 新增：**按模型 id 键**的参数表（见下文的 modelParams 登记）。三个字段
        // 缺省回落 { reasoningEffort: 'auto', contextWindow: 0, vision: false }；
        // 未发生命中的模型一律按这份默认值理解 —— 不再有 provider 级的同名旧字段
        "modelParams": {
          "deepseek-chat": {
            "reasoningEffort": "auto", // auto | low | medium | high；auto = 不下发该参数
            "contextWindow": 128000, // 上下文窗口（token）；0 = 未知，见 §1.2
            // v22 新增、v23 起按模型绑定：该模型是否支持**图片输入**（多模态，见 06 §3.1）。
            // 默认 false —— 关闭时图片附件按「未读取」降级为一行文字；
            // 对不支持视觉的模型发图片会被服务端 400
            "vision": false,
          },
        },
        // v6 新增：**候选**模型 id 列表（设置页「模型列表」与对话窗模型选择器共用，见 §5）
        "modelList": ["deepseek-chat", "deepseek-reasoner"],
      },
    },
  },
  "tts": {
    "enabled": true, // 语音功能总开关；false 时对话窗不显示朗读按钮
    "active": "", // 默认 TTS provider id；空串 = 未配置（此时对话窗的朗读按钮不出现）
    "autoRead": false, // 助手回复结束后自动朗读
    "maxChars": 2000, // 单次朗读的文本上限（50–4096，超出截断）
    "providers": {
      "siliconflow": {
        "type": "openai-compat", // openai-compat | dashscope（DashScope 原生协议，见 docs/06 §13.6）
        "baseUrl": "https://api.siliconflow.cn/v1",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "FunAudioLLM/CosyVoice2-0.5B", // 唯一生效值：合成请求实际用的模型就是它
        "voice": "alex", // 音色 id，如 alloy / FunAudioLLM/CosyVoice2-0.5B:alex
        "speed": 1, // 0.25–4
        "format": "mp3", // mp3 | opus | aac | flac | wav | pcm
      },
    },
  },
  "stt": {
    "enabled": false, // 语音输入总开关；false 时对话窗连麦克风按钮都不渲染（门控口径同 TTS）
    "active": "", // 默认 STT provider id；空串 = 未配置（此时麦克风按钮不出现）
    "providers": {
      "openai": {
        "type": "openai-compat", // 或 "dashscope-native"（阿里云百炼原生 ASR，v24 起，见 06 §15.1）
        "baseUrl": "https://api.openai.com/v1", // 原生协议填服务根，如 https://dashscope.aliyuncs.com
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "whisper-1", // 唯一生效值：转写请求实际用的模型就是它（原生协议例：qwen3-asr-flash）
        "language": "zh", // 识别语言（zh / en 等，默认 zh）；空串 = 交给服务端自动检测
      },
    },
  },
  "imagegen": {
    "enabled": false, // 生图功能总开关
    "active": "", // 默认生图 provider id；空串 = 未配置
    "providers": {
      "openai": {
        "type": "openai-compat",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "dall-e-3", // 唯一生效值
        "size": "1024x1024", // 512x512 | 768x768 | 1024x1024 | 1024x1792 | 1792x1024 | auto（auto = 交给服务端决定）
      },
    },
  },
  "modes": {
    "current": "classroom",
    "classroom": {
      "guideCompleted": false,
      "watchDir": "",
      "subjects": [{ "name": "数学", "folder": "分类/数学", "keywords": [] }],
      "schedule": {
        "provider": "manual",
        "lessons": [],
        // ClassIsland 桥接数据源（docs/05 §3.4 v2）：
        // source = "file"（读 JSON 文件）| "http"（读本机回环端点）；
        // endpoint 为空串表示尚未配置（此时 provider 返回空课表）
        "classisland": { "source": "file", "endpoint": "", "timeoutMs": 3000 },
      },
      "preClassReminder": true,
      // v8 新增：课前提醒触发时是否自动打开科目文件夹（通知照发，仅门控打开动作）
      "preClassOpenFolder": true,
      // v10 新增：课前提前分钟数（整数，1–30，默认 5）；pre-class-reminder 的 lookahead 直接用它
      "preClassLeadMinutes": 5,
      "classification": {
        "autoMove": true,
        "confidenceThreshold": 0.6,
        "fallbackFolder": "待分类",
      },
    },
    // v8 起 Work 实装：workspaceDir = 办公工作目录，空串 = 未配置（由引导 / 设置页收集）
    "work": { "guideCompleted": false, "workspaceDir": "" },
    "code": { "guideCompleted": false },
  },
  "skills": { "userDir": "", "disabled": [] },
  "mcp": {
    "lazyConnect": false,
    "servers": [
      {
        "name": "example",
        "transport": "stdio",
        "command": "npx",
        "args": [],
        "envEnc": {},
        // v9 新增：自定义请求头（键 = header 名，值 = safeStorage 密文；HTTP 传输消费，
        // stdio 条目上同样存在但通常用不到），见 06 §7
        "headersEnc": {},
      },
    ],
  },
  // v13 新增：项目机制（见 06 §5.1）。current 为空串 = 无项目（默认，行为与 v13 之前完全一致）；
  // list 里每条是 { id, name, root }，root 支持绝对路径或相对进程 cwd 的路径；
  // maxAgentsBytes 是每轮注入的项目级 AGENTS.md 字节预算
  "projects": {
    "current": "",
    "list": [],
    "maxAgentsBytes": 32768,
  },
  "advanced": {
    "proxy": "",
    "logLevel": "info",
    "quietHours": null,
    // 与 agent.permissionMode 镜像（界面写档位时两条一起写）：默认档是 auto ⇒ 这里为 false
    "confirmSensitiveTools": false,
    // v6 新增：AI 改配置（set_setting）的路径黑名单，按路径段匹配，见 06 §12。
    // 只能在默认项之上追加限制：默认项始终生效，删掉或清空都不能放开（判定的第二道用的是硬编码常量）
    "readonlyPrefixes": [
      "llm.providers",
      "tts.providers",
      "stt.providers",
      "imagegen.providers",
      "mcp.servers",
      "version",
      "general.windowState",
      "advanced.proxy",
      "general.onboarded",
      "general.firstRun",
      "general.launchAtLogin",
      "general.hotkey",
      "advanced.confirmSensitiveTools",
      // v13 新增：项目根同时决定注入的指令与权限边界；权限档位等于 Agent 自己的确认闸门
      "projects",
      "agent.permissionMode",
      // v20 新增：提权是 Agent 自己能碰到的权限边界本身 —— AI 关掉它（或阻止自己重启提权）
      // 等于自己降低权限约束面，属自我提权；只能由用户在设置页改
      "general.requireAdmin",
      // 权限边界根的一级（boundaryRoot → Work 空间目录）：AI 改写它 = 把 confirm 档根内免确认扩到任意目录
      "modes.work.workspaceDir",
    ],
  },
  "agent": {
    // v13 新增：三档权限 readonly | confirm | auto（默认 auto = 完全权限，2026-09-29 起）
    // 只读：AI 的 set_setting 一律拒绝（自我提权），只能由用户在设置页 / 对话窗改，见 06 §11.2
    "permissionMode": "auto",
    // v14 新增：写前快照（见 06 §11.8）。写文件前把原内容留底，可在右栏「文件备份」卡回滚
    "snapshots": {
      "enabled": true, // 关掉后写文件不再留底，改动将不可回滚
      "keepPerFile": 20, // 同一个文件最多留几份（环形淘汰，最旧的先删）
      "maxSnapshotBytes": 524288, // 单个文件超过这个大小就不留底（工具结果里会说明）
      "totalBudgetBytes": 209715200, // 备份目录总预算，超出时从最旧开始删
    },
    // v15 新增：Agent 循环（见 06 §4.1）。轮次用尽 / 预算触顶时任务落「已暂停」，可续跑
    "loop": {
      "maxRounds": 32, // 1–128；一次请求内最多几轮「工具调用 → 结果回填」（默认 32）
      "maxTotalTokens": 0, // ≥0；累计 token 预算，0 = 不限，触顶即暂停
      "autoContinueRounds": 8, // 0–8；轮次用完后自动再续几轮，0 = 不自动续、直接暂停等点「继续」
    },
    "tools": {
      "enabled": true, // 电脑操控工具总开关；false 时全部工具都不注册
      "workspaceDir": "", // 工具默认工作目录；空串 = 按 06 §5.1 回落链（Work 模式目录 > 它 > 主目录）
      "terminal": {
        "enabled": true,
        "timeoutMs": 60000,
        "maxOutputChars": 8000,
        // v12 新增：命中即免确认的命令模式（glob 全串匹配、大小写不敏感）；空数组 = 全部逐次确认
        // 只读：AI 的 set_setting 一律拒绝读写它（防自我提权），只能由用户在设置页维护，见 06 §11.7
        "allowPatterns": [],
      },
      "files": { "enabled": true, "maxReadBytes": 262144 },
      // v12 新增：文件检索（grep / glob）的开关与单次检索的结果条数上限
      "search": { "enabled": true, "maxResults": 200 },
      "open": { "enabled": true },
    },
  },
  // v16 新增：Aurora Center 连接（docs/12）。整组在 SETTINGS_READONLY_PREFIXES 里 ——
  // 连接目标是数据外发通道，AI 的 set_setting 一律拒绝；只能由用户在设置页操作
  "center": {
    "enabled": false, // 总开关；false 时不连接 Center，center_* 工具也不注册
    "serverUrl": "", // Center 服务器地址（ws(s):// 或 http(s)://，连接时统一换 ws 协议）
    "tokenEnc": "<safeStorage 密文>", // 客户端令牌（凭据路径：center.token ⇄ center.tokenEnc，同 apiKey 链路；由账号登录颁发，见 12 §3）
    "account": "", // 已登录的 Center 账号名（v17 新增；非凭据，仅展示与诊断）
    "clientId": "", // 本机客户端 id（首次登录时生成并持久化；非凭据）
    "displayName": "", // 在 Center 展示的名字；空串 = 主机名
    "allowRemoteSession": true, // 允许 Center 远程开 session 对话（客户端侧最终闸门）
    "allowRemoteConfig": true, // 允许 Center 远程改配置（仍受 12 §6.2 白名单约束）
    "allowFileTransfer": true, // 允许 center_send_file 上传文件
    "maxFileMb": 64, // 单个上传文件上限（1–512）
  },
  // v19 新增：自动化总开关（docs/13 §2.2）。自动化的**定义与历史不是配置** ——
  // 它们落在 `<userData>/automations/automations.json` 与 `history.json`（同会话 / 待办的口径，
  // 不进迁移链；历史上限 500 条，超出淘汰最旧），配置里只有这一道闸门
  "automations": {
    "enabled": true, // 关闭 = 引擎停止评估与触发（定义与历史原样保留）
  },
  // v28 新增：文件自感知（docs/06 §26）。整组在默认黑名单里；只有用户显式同意后
  // 才会提取正文并发送给你配置的模型。
  "fileAwareness": {
    "enabled": false,
    "contentConsentAccepted": false,
    "watchedDirs": [],
    "knowledgeDir": "",
    "includeRecent": true,
    "suggestionsEnabled": true,
    "dailyAnalysisLimit": 20,
    "maxFileMb": 100,
    "defaultMemoryTtlDays": 0,
    "backgroundModel": {
      "providerId": "",
      "model": "",
    },
  },
}
```

- 字段说明：`llm.providers` 支持多组模型配置，`llm.active` 指定默认；`modes.classroom.subjects` 即科目 → 文件夹映射（见 05 §3）；`schedule.provider` 为 `manual | classisland`（见 05 §3.4）。
- `general.windowState` 的 key 集合即 `WINDOW_NAMES`：`edge-bar` / `chat` / `settings` / `memory` /
  `onboarding` / `automation`
  （v4 起移除 `service-dock`、v6 起移除 `mini-chat`，两个窗口均已删除；`memory` 为记忆库
  独立窗口，`automation` 为自动化详情窗口；两者仅扩枚举不推进 `CONFIG_VERSION` ——
  旧配置没有该键时保持默认不可见）。
- `general.language` 是**未生效的死字段**（无 i18n 消费方，见 §6.1 门控矩阵），保留仅为避免再动一次配置版本。
- `mcp.lazyConnect`：连接策略（见 06 §7）。`false`（默认）= 启动即连；`true` = 首次使用某个 MCP 工具时才连接。
- MCP 环境变量的**变量名**由 `envEnc` 的键表达，设置页据此展示"已配置的变量名"，
  因此 Schema 不额外维护一份 `env` 列表（避免两处数据不一致）。
  自定义请求头（`headersEnc`，v9 新增）同款：header 名由键表达，设置页展示"已配置的请求头名"。
- `mcp.servers.<id>.headersEnc`（**v9 新增**，见 06 §7）：MCP **HTTP 传输的自定义请求头**，
  键 = header 名、值 = safeStorage 密文，与 `envEnc` **完全同构**：明文只经 `settings:setSecrets`
  （路径 `mcp.servers.<name>.headers.<key>`）加密落盘；渲染层只见 `headersSet` 只读标记
  （已配置的 header 名数组，§1.1），`headersEnc` 恒回传空对象——「空 = 本次不改」的逐键合并语义、
  `settings:clearSecret` 清单键、删除服务器时清凭据缓存，全部与 `envEnc` 同款。
  用户配置的头**覆盖**同名默认头（典型用途：Bearer / API Key 鉴权头，传输侧行为见 06 §7）。
  字段在 stdio / HTTP 两种传输的条目上都存在（`v8 → v9` 迁移为每个已有条目补 `headersEnc: {}`），
  但只有 HTTP 传输消费它；`mcp.servers` 整棵子树仍在凭据黑名单里，AI 的 `set_setting` 改不动。
- `modes.classroom.classification`（v2 新增，见 05 §3.2）：`autoMove` 关闭时只写分类流水、
  不移动文件；`confidenceThreshold` 是进「待分类」的置信度下限；`fallbackFolder` 是兜底目录
  （相对 `watchDir` 或绝对路径）。
- `advanced.confirmSensitiveTools`（v2 新增）：敏感工具（`sensitivity = 'confirm'`，含全部 MCP 工具
  与 `set_setting`）执行前是否要求用户确认（见 06 §5）。**默认 `false`**（2026-09-29 起，
  与默认权限档 `auto` 镜像）：为 `false` 时由 `auto` 档承接 —— **完全权限，所有敏感工具不再弹卡**；
  切回 `confirm` 档会恢复旧 auto 的项目边界语义：根内直接执行、越界弹卡。
  **它本身在默认黑名单里**（见下一条）：改它等于摘掉 / 收紧敏感工具的确认闸门，属于 AI 自我提权，
  因此只允许用户在设置页手动改（设置页走 `settings:update`，不经过该黑名单）。
- `advanced.readonlyPrefixes`（**v6 新增**，见 06 §12）：AI 通过 `set_setting` 改配置时的路径黑名单，
  按**路径段**前缀匹配。默认值即 `SETTINGS_READONLY_PREFIXES`（覆盖凭据 / 密文、配置版本、
  窗口几何、网络代理、引导与首启标记、开机自启、全局快捷键、敏感工具确认总闸门、
  项目分组与权限档位等自我提权路径、权限边界根一级的 `modes.work.workspaceDir`；
  **具体条目以该常量为准**）。
  **它只能在默认黑名单之上追加限制，不能放宽 —— 默认项始终生效，无法通过配置放开**：
  判定时先查这个配置项，再**无条件**走 `canWriteSettingPath()`，而后者用的是硬编码的
  `SETTINGS_READONLY_PREFIXES`，**从不读取用户配置**。所以把 `general.hotkey` 从数组里删掉、
  甚至把数组清空，`general.hotkey` 这条路径**仍然被拒**（清空 = 回到默认项，而不是放开）。
  另一条兜底同样不随它变化：「Schema 不认识的路径一律拒绝」，防模型拼错字段名后悄悄写进配置。
  **本字段自身也在 `SETTINGS_READONLY_PREFIXES` 里**（v15）：AI 往里追加路径等于自己收紧自己的
  可写面（自我 DoS）、放宽又本就不生效，因此 `set_setting` 一律拒绝；用户经设置页
  `settings:update` 修改不受影响（设置页不经过该黑名单）。
  `v5 → v6` 迁移会为旧配置补齐这一项（本字段是在 v6 内追加的，当时没有另起新版本号；
  当前 `CONFIG_VERSION` 已是 **30**，见 §2）。
  **`tts.providers` / `stt.providers` / `imagegen.providers` 含凭据密文**（`apiKeyEnc`），
  同样在默认黑名单里，因此 AI 的 `set_setting` 对它们的任何写入**一律拒绝**。
- `llm.providers.<id>.modelParams.<modelId>.reasoningEffort`（v5 新增，v23 起按模型绑定）：
  `auto | low | medium | high`，默认 `auto`。
  `auto` 表示请求里**不带 `reasoning_effort` 字段**，用于兼容不认该参数的厂商；
  其余三档按值下发（见 06 §3）。它现在是**模型级**参数（`modelParams[<modelId>]` 的一个字段）：
  哪个模型生效就取哪一份，**换模型即换思考等级**（见 §5 第 6 条与 06 §3）。
- `llm.providers.<id>.modelList`（**v6 新增**，见 §5）：该 provider 下的**候选**模型 id 列表
  （`string[]`，`.default([])`），供设置页「模型列表」编辑区与对话窗模型选择器使用 ——
  两处读写的是**同一份**列表，没有第二份来源。
  它**只作候选**用途：真正生效的仍然是 `llm.providers.<id>.model`（**唯一生效值**），
  往列表里加减模型**不会**改变请求用的模型。
  回落行为：`modelList` 为空（或当前 `model` 不在其中）时，选择器**只显示当前 `model`**
  并标注「（不在列表中）」，**不会**悄悄替换成列表里的第一个模型；对话窗同样显示为
  `<model>（不在列表中）`。`v5 → v6` 迁移会为旧配置的每个 provider 补齐 `modelList: []`
  （已存在的值不动；本字段是在 v6 内追加的，当时没有另起新版本号）。
- `llm.providers.<id>.modelParams`（**v23 新增**）：按**模型 id** 键的参数表，
  `Record<modelId, { reasoningEffort, contextWindow, vision }>`（`.default({})`），
  把「随模型而异」的三个参数收拢到一处 —— 它们此前是 **provider 级**字段（作用于该 provider
  下的所有模型），v23 起改为**模型级**：哪个模型生效就取哪一份，换模型即换参数。三字段：
  - `reasoningEffort`：`auto | low | medium | high`（默认 `auto`，见上一条）；
  - `contextWindow`：整数 `0 … 2_000_000`（默认 `0`，`0` = 未知，见下一条）；
  - `vision`：布尔（默认 `false` = 不支持图片输入，见 §1 的 `vision` 登记条）。
    **缺省回落**：shared 导出**唯一入口** `resolveModelParams(provider, modelId?)` ——
    读 `provider.modelParams[modelId]`，**未命中键**（或键在但字段缺失 / 非法）时返回
    `{ reasoningEffort: 'auto', contextWindow: 0, vision: false }`；`modelId` 缺省取
    `provider.model`。主进程 / 渲染层 / Center **三处都走它**，不在任何一处再写一套默认值 ——
    否则「同一个模型在设置页显示 128K、在对话窗按未知处理」这类分叉迟早出现。
    `modelList` 仍是 `string[]`（只记**有哪些模型**），模型参数一律进 `modelParams`：两者不是
    同一张表，往列表里加模型不会为它造条目（读到就按默认值），删列表项也不清它的参数。
    `v22 → v23` 迁移把 provider 级的三个旧键搬进 `modelParams[provider.model]`（`model` 为空串时
    写 `{}`），并删除 provider 级的旧键（见 §2）。
- `llm.providers.<id>.modelParams.<modelId>.contextWindow`（**v11 新增，v23 起按模型绑定**）：
  该模型的**上下文窗口**（token，整数，
  `0 … 2_000_000`，`.default(0)`）。**唯一用途**是对话窗输入框底部「上下文详解」条的
  **占用比例分母**（`promptTokens / contextWindow`，见 07 §2.3 与 06 §16.2）。
  - `0` = **未知**：此时只显示 token 数与字符数，**不显示进度条与百分比** —— 分母不知道就不编；
  - 刻意**不做内置的「模型名 → 窗口大小」对照表**：模型名千变万化，猜错一个数量级比不显示更误导
    （用户会以为快爆上下文了，或以为还很空）。取值来源就是用户在设置页照服务商文档填；
  - 设置页入口在「AI 模型」卡的**模型行内展开的参数**里
    （`data-field="llm.providers.<id>.modelList.<index>.contextWindow"`，行上 `data-action="toggle-model-params"`
    展开开关；v23 起不再位于 provider 级「高级参数」折叠区，见 §5）；
    只读态在该模型行上以「上下文窗口 128K」的形式显示（为 0 时不渲染这一行）；
  - `v10 → v11` 迁移为旧配置的每个 provider 补 `contextWindow: 0`（已写过的值不动），
    `v22 → v23` 起该值被搬进 `modelParams[<model>]`（见 §2）。
- `llm.providers.<id>.type`（**v22 扩枚举**）：该条目的**接口协议**，取值
  `openai-compat`（默认，`POST {baseUrl}/chat/completions`）或 `openai-responses`
  （`POST {baseUrl}/responses`，见 06 §3.2）。**纯增量枚举，`v21` 及更早的配置天然合法**
  （它们写的就是 `openai-compat`），因此迁移只补字段不改正值。
  凭据与连接字段（`baseUrl` / `apiKeyEnc`）仍在 `llm.providers` 只读前缀里：AI 不能把
  自己的请求改道到别的地址去。
- `llm.providers.<id>.modelParams.<modelId>.vision`（**v22 新增，v23 起按模型绑定**）：
  该模型是否支持**图片输入**（多模态，见 06 §3.1），
  布尔，默认 `false`。关闭时附件里的图片按「内容未读取（当前模型未开启图片输入）」降级成一行
  文字，请求体里不出现图片分片 —— 对不支持视觉的模型发图片会被服务端 400，这个开关就是那道闸。
  **该开关同时决定图像工具是否注册**：`view_image` / `screenshot` / `clipboard_read_image`
  仅在开启时进工具表，关闭时连工具都不出现（判据与附件管线同源，见 06 §25）。
  与 `contextWindow` 同一口径：**不做内置模型能力表**，由用户照服务商文档填；
  **只读**（AI 的 `set_setting` 改不动它 —— 它是模型能力事实，不是偏好，见 `WRITABLE_PATH_OVERRIDES`）。
- `tts`（**v7 新增**，见 06 §13）：**语音输出（TTS）**；语音输入（STT）自 **v8** 起见下一条 `stt`。
  `tts.enabled` 是整个语音功能的**总开关**（`false` 时对话窗不显示朗读按钮）；
  `tts.active` 是默认 TTS provider id，**为空串 = 未配置**，此时对话窗的朗读按钮**不出现**；
  `tts.autoRead` 控制助手回复结束后是否自动朗读；`tts.maxChars` 是**单次朗读的截断上限**
  （50–4096，默认 2000，超出部分先截断再送合成）。
  `tts.providers.<id>`（`{ type, baseUrl, apiKeyEnc, model, voice, speed, format }`，
  `type` 为 `openai-compat`（06 §13.2）或 `dashscope`（06 §13.6，DashScope 原生协议））与
  `llm.providers.<id>` **结构同构但彼此独立**：两边的 provider 列表不共享、不联动，
  改一边不影响另一边；`apiKeyEnc` 同为 safeStorage 密文（回传口径见 §1.1）。
  `v6 → v7` 迁移会为旧配置补齐 `tts.*`（`fillMissing` 对已存在的值一律保留，因此天然幂等）。
- `WRITABLE_PATH_OVERRIDES`（**v8 新增**，见 06 §12）：AI 的 `set_setting` **显式可写覆盖表**，
  判定**先于** `advanced.readonlyPrefixes` 黑名单前缀。两类登记：
  ① **真的放开** —— `llm.providers.<id>.model / .modelParams.<modelId>.reasoningEffort` 落在
  `llm.providers` 黑名单前缀之内，但「换模型 / 调思考等级」不碰凭据、也不改模型能力事实，
  显式放行（baseUrl / apiKeyEnc / modelList 等其余字段仍被前缀拒绝）。
  模式里的 `**` 段（**v23 起**）表示「一个或多个段」，专为**模型 id 可以带点**
  （`gpt-4.1` / `claude-3.5-sonnet` 一类）而设：路径按 `.` 切段，用 `*`（恰好一段）匹配不了它们。
  `**` 只允许出现在收尾的字面量段之前，所以 `contextWindow` / `vision` / 凭据子树不会被顺带放开；
  **`modelParams` 下的 `contextWindow` / `vision` 仍只读**（它们是**模型能力事实**、不是偏好 ——
  AI 把窗口改大或打开视觉，只是把一条假事实告诉用户，出问题的还是用户）；`temperature` 已随
  v23 从 Schema 删除，不再存在这条可写路径（请求也不再下发它，见 06 §3）；
  ② **显式登记** —— `tts.enabled|active|autoRead|maxChars`、
  `stt.enabled|active`、`imagegen.enabled|active`、`general.edgeBar.enabled|opacity|quietHours|display|position`、`appearance.accent`、
  `general.chat.showThinking`、`modes.current`、`agent.tools.*`
  （`terminal.allowPatterns` **除外** —— 它在黑名单里，见 §1）、
  `skills.userDir|disabled`、`advanced.quietHours` 等本就可写的路径逐条入表
  （供 `set_setting` 工具描述与审计使用，也防未来误加前缀时静默收窄）。
  注意 `advanced.confirmSensitiveTools` 总闸门**不在**表内，仍只读（防 AI 自我提权）。
  **具体条目以该常量为准**。
  **`modes.work.workspaceDir` 已从本表移出并进黑名单**（它是权限边界根的一级，见下方该字段条）——
  只删覆盖表登记**不够**：那样会落回「Schema 登记过即默认可写」，必须同时进 `SETTINGS_READONLY_PREFIXES`。
- **写入闸门的顶层分组**（主进程 `main/tools/settings-port.ts` 的 `TOP_LEVEL_GROUPS`）：`set_setting`
  的 `set` 只接受这些顶层分组，`tts` / `stt` / `imagegen` **三组已补齐**（覆盖表登记的可写面
  `tts.enabled` 等此前因分组缺席被写闸门整体拒绝 → 「工具描述承诺可写、写入必拒」）；
  `center` **维持缺席**（整组只读，与覆盖表里没有它的条目一致）。两条判定必须同时通过：
  先过 `canWriteSettingPath`，再过这个分组清单。
- `stt`（**v8 新增**）：**语音输入（STT，录音 → 文本）**，与 `tts` **同构但独立** ——
  语音输入与语音输出的可用性互不绑定，共用一份配置会让「换朗读服务」顺手把转写弄坏。
  `stt.enabled` 是总开关（`false` 时对话窗连麦克风按钮都不渲染，门控口径同 TTS，docs/07 §2.3）；
  `stt.active` 是默认 STT provider id，**空串 = 未配置**（麦克风按钮同样不出现）。
  `stt.providers.<id>`（`{ type, baseUrl, apiKeyEnc, model, language }`）：`apiKeyEnc` 为 safeStorage
  密文（回传口径见 §1.1）；`language` 是识别语言（如 `zh` / `en`，默认 `zh`，空串 = 交给服务端自动检测）。
  **`type`（v24 起两取值，见 06 §15.1）**：`openai-compat`（默认，OpenAI 兼容
  `/audio/transcriptions`，`baseUrl` 是端点根）与 `dashscope-native`（阿里云百炼原生同步接口，
  `baseUrl` 是**服务根**）。协议不同则 `baseUrl` / `model` 的语义不同，设置页的编辑卡把「接口协议」
  放在第一位并按当前协议切换提示词；两条预设（OpenAI / 阿里云百炼）各自带上 `type`。
  **Agent 写权限**：`stt.enabled` / `stt.active` 可写（显式登记，见上）；
  `stt.providers` 在默认黑名单（凭据），`set_setting` 一律拒绝。
  `v7 → v8` 迁移为旧配置补齐 `stt.*`（默认关闭、无 provider）；
  `v23 → v24` 迁移归一 `stt.providers.<id>.type`（只补缺失 / 非法值，不改正值）。
- `imagegen`（**v8 新增**）：**图像生成**，与 `llm.providers` **同构但独立**。
  `imagegen.enabled` / `imagegen.active` 语义同 `stt`（Agent 均可写，显式登记）；
  `imagegen.providers.<id>`（`{ type, baseUrl, apiKeyEnc, model, size }`）：`size` 是生成尺寸白名单
  `512x512 | 768x768 | 1024x1024 | 1024x1792 | 1792x1024 | auto`（默认 `1024x1024`；
  `auto` = 尺寸决定权交给服务端）。`imagegen.providers` 同样在凭据黑名单里（Agent 只读）。
  `v7 → v8` 迁移为旧配置补齐 `imagegen.*`（默认关闭、无 provider）。
- `general.chat.showThinking`（**v8 新增**）：对话界面是否展示思考过程（MessageList 可折叠思考块的
  门控，docs/07 §2.3，默认 `true`）。Agent 可写（显式登记）。设置页入口在「AI 模型」页（见 §5 / §6）。
- `general.requireAdmin`（**v20 新增**，见 `main/elevation.ts` 与 docs/09 §9）：
  **要求以管理员身份运行**，出厂默认 `true`。启动时（配置就绪之后、建窗 / 托盘 / Center 连接
  之前）若当前进程未提权，用 `powershell -Command Start-Process -Verb RunAs` 拉起一个带
  `--aurora-elevated` 标记的新实例，随后**先 `app.releaseSingleInstanceLock()` 再 `app.quit()`**
  —— 先放锁再退，否则子进程会因「已有实例」立刻退出。四条边界：
  ① **反循环**（子进程看到标记参数就不再提权）；② **用户拒绝 UAC 不阻断启动**
  （以普通权限继续并记 warn）；③ **开发态默认不强制**（`pnpm dev` / smoke / capture
  常跑在非提权终端里，需要验证时用 `AURORA_REQUIRE_ADMIN=1` 显式打开）；
  ④ **探测拿不到结论时按「已提权」处理**（能跑优先）。
  开着它的意义是「不被权限卡住」：`run_command` 与文件类工具跑在当前用户权限下，
  未提权时写 `C:\Program Files`、改系统设置这类操作会直接失败。注意它**不是沙箱** ——
  提权只提高"能做什么"，不改变「越界要确认」的判定链（见 06 §11.2）。
  **只读**（`SETTINGS_READONLY_PREFIXES`）：提权是 Agent 自己能碰到的权限边界本身，
  AI 关掉它等于自己降低权限约束面，属自我提权；只能由用户在设置页「常规」改
  （设置页走 `settings:update`，不经过该黑名单），**改动重启后生效**。
- `modes.work.workspaceDir`（**v8 新增**）：Work 模式的办公工作目录，空串 = 未配置
  （由引导问答 / 设置页收集）。它与电脑操控工具的 `agent.tools.workspaceDir` **是两个字段**：
  前者是 Work 模式的场景目录，后者只是 `run_command` 的缺省 `cwd`（见 06 §11）。
  **只读**（`SETTINGS_READONLY_PREFIXES`）：它是**权限边界根回落链的一级**（`boundaryRoot` 的
  Work 空间目录，见 06 §5.1 / §11.2）—— AI 能改写它，就等于把 `confirm` 档
  「根内免确认」扩到任意目录 = **自我提权**（与 `projects` 整组被拉黑的理由完全同构）。
  AI 的 `set_setting` 一律拒绝读写它；只能由用户在设置页「模式 → Work」或引导问答改
  （设置页走 `settings:update`、引导走 `guide-runner`，都不经过该黑名单）。
  **对照**：`agent.tools.workspaceDir` 仍可写 —— 它只是缺省 `cwd` / 搜索根、不是边界（06 §11.1）。
- `modes.classroom.preClassOpenFolder`（**v8 新增**，见 05 §3.3）：课前提醒触发时是否自动打开
  科目文件夹（默认 `true`；通知照发，本字段只门控「打开文件夹」动作）。
  `modes.classroom.*` 本就不在黑名单，Agent 可写。
- `modes.classroom.preClassLeadMinutes`（**v10 新增**，见 05 §3.4）：课前**提前多少分钟**提醒
  （整数，范围 **1–30**，默认 **5**）。装配层 `main/index.ts` 构造 `PreClassReminder` 时把它作为
  `getLookaheadMinutes` getter 注入（**每次 tick 即时读取** → 设置页改完即时生效；此前恒为
  模块常量 `DEFAULT_LOOKAHEAD_MINUTES = 5`）。设置页「模式 → ClassRoom → 课程表」区有数字输入
  （`data-field="modes.classroom.preClassLeadMinutes"`）。Schema 层已 `min(1).max(30).int()` 约束，
  越界值在写入时被拒（渲染层输入框 `min`/`max` 同步限制）。Agent 可写（`modes.classroom.*` 不在黑名单）。
- `modes.classroom.schedule.classisland.timeoutMs` 同时是**提醒命令通道**（05 §3.4 v3）文件模式
  轮询 `command-result.json` 的超时预算 —— 桥接不可用时按此超时返回 `ok: false`，不阻塞调用方。
- `agent.tools`（v5 新增，见 06 §11）：5 个开关 + 4 个上限 + 1 份免确认模式列表 ——
  `enabled` 是电脑操控工具**总开关**（`false` 时全部工具都不注册）；`workspaceDir` 是 **`run_command`
  的缺省 `cwd`**，同时也是 `grep` / `glob` 的**缺省搜索根**（取值按 06 §5.1 的 `effectiveWorkspaceDir`
  回落链：**当前项目根（配置了当前项目时）> 激活模式工作目录（Work）> `workspaceDir` > 用户主目录**，没配当前项目时与既往一致；
  它只作**默认值**、不是沙箱；其余文件类工具不读它，见 06 §11.1 / §11.5）；`terminal.enabled` 开关终端工具、
  `terminal.timeoutMs` 是单次命令超时（毫秒）、`terminal.maxOutputChars` 是回传输出的截断上限；
  `files.enabled` 开关文件读写与 Office 专用工具（`office_read` / `office_help` /
  `office_create` / `office_edit` / `office_render` / `office_pdf` / `office_raw_edit`）、
  `files.maxReadBytes` 是单次文本读取上限（字节）；Office safe 工具在只读档保留，
  create / edit / pdf / raw 等 confirm 工具与写文件同档摘除；
  `search.enabled` 开关文件检索（`grep` / `glob`，**v12 新增**）、`search.maxResults` 是**单次检索的
  结果条数上限**（1–1000，默认 200，超出即截断并在结果里标注）；
  `open.enabled` 开关「打开路径」工具；`open.urlMode`（**v27 新增**）只控制模型打开
  `http(s)` 网址时的去向：`internal`（默认，右栏内置浏览器）/ `external`（系统浏览器）。
  本地文件预览、设备授权登录、自动化打开网址与用户手动入口不读取该字段。
- `agent.tools.search.*`（**v12 新增**，见 06 §11.5）：文件检索工具 —— `grep`（按**正则**搜文件内容，
  回带路径 / 行号 / 命中行）与 `glob`（按**文件名模式**找文件，只回路径），两个都是 `safe` 级只读工具，
  用来替代「用 `list_dir` 逐层翻目录」。这两个字段**均可写**（显式登记在 `WRITABLE_PATH_OVERRIDES`，
  见上一条）：开关检索能力或调整结果上限不碰凭据、也不动任何确认闸门。它们仍归 `agent.tools.enabled`
  总开关管辖 —— 总开关关闭时 `grep` / `glob` 与其余 6 个工具一样不注册。
- `agent.tools.terminal.allowPatterns`（**v12 新增**，见 06 §11.7）：命中即**跳过确认卡片**的命令模式
  列表（`string[]`，默认空数组 = 现状不变、全部逐次确认；每条最长 200 字符、最多 100 条），
  匹配语义是 **glob 全串匹配、大小写不敏感**（`*` 匹配任意字符含空、`?` 匹配单字符，与
  `grep` / `glob` 共用同一个模式编译器；全串锚定意味着 `git *` 不命中 `echo git`）。
  **但 `*` 不区分命令分隔符**：它同样匹配 `;` / `&&` / `|`，所以 `git status*` 会命中
  `git status; <任意命令>` —— 写法是「以某段文字开头的任意命令串」，不是「只放行这一条命令」；
  要收窄就写完整命令（`git status`）或明确到参数级（`git log --oneline *`）。
  它是**白名单**而不是黑名单：命中只是免确认，**审计日志照写**（含命令与被命中的模式），
  与 `advanced.confirmSensitiveTools = false` 同属「减少打扰」，**不是安全加固**。
  非法模式一律拒绝保存与匹配：空串 / 纯空白 / **不含任何字面字符**的模式（`*` / `**` / `?*`）
  以及含 `{` `}` 的模式 —— 纯通配等于「全部放行」，花括号交替（如 `{a,*}`）能绕过字面字符检查，
  两者都必须在保存与匹配两处拒掉。
  **它本身在默认黑名单里**（`SETTINGS_READONLY_PREFIXES`，即 `advanced.readonlyPrefixes` 的默认项）：
  **只读，AI 的 `set_setting` 一律拒绝读写它**，只能由用户在设置页手动维护 ——
  否则 AI 可以给自己加一条 `git*` 直接摘掉自己的确认闸门，属于**自我提权**
  （与 `advanced.confirmSensitiveTools` 只读同款理由）。
- `projects`（**v13 新增**，见 06 §5.1）：项目机制 —— `projects.list[]` 每条是
  `{ id, name, root }`（`root` 可为绝对路径，或相对进程 cwd 的路径），
  `projects.maxAgentsBytes` 是每轮注入的项目级 `AGENTS.md` 字节预算（1 字节 – 1 MiB，默认 32768）。
  ⚠️ **`projects.current` 已于 v25 删除**（迁移删除该字段，界面的「设为当前」一并退役）：
  v17 起项目根就按**会话绑定**解析（`sessions/<id>.json` 的 `meta.projectId`），
  全局 current 只是过时的回落级；项目现在只是「可被会话绑定的目录清单」。
  项目根决定：① 绑定它的会话每轮把「项目根 → 当前工作目录」逐层收集的 `AGENTS.md`
  （同目录 `AGENTS.override.md` 优先）注入系统提示词的「项目约定」小节；
  ② 权限层判定「项目根之内 / 之外」的边界；
  ③ 缺省工作目录 / 搜索根的最高优先级（06 §5.1 回落链：**会话绑定项目根 > 会话空间目录** >
  Work 模式工作目录 > `agent.tools.workspaceDir` > 主目录）。
  **会话空间（2026-09-30，docs/06 §4）不是配置**：左栏三分（项目对话 / 工作目录对话 / Agent对话）
  的判定字段 `space` 与会话绑定项目一样写在**会话文件自身**（不进本 Schema、不进迁移链）；
  Agent 空间的工作目录是**固定常量** `%USERPROFILE%\Desktop\Aurora`（不设配置项），由主进程懒创建。
  项目根不存在 / 被删除 / 不可读时**降级为无项目**：不抛错、不影响对话，
  但界面必须有可见提示（设置页该项目行标红并显示「项目目录不可用」+「重新选择目录」，
  右栏「当前项目」卡显示警示徽标）—— 只在日志里 warn 会让用户以为约定生效了却什么都没发生。
  **整组在默认黑名单里**（`SETTINGS_READONLY_PREFIXES`，即 `advanced.readonlyPrefixes` 的默认项）：
  **只读，AI 的 `set_setting` 一律拒绝读写它**，只能由用户在设置页「通用 → 项目」维护 ——
  切项目等于同时改 Agent 的**指令面**与**权限面**，属自我提权。
- `agent.permissionMode`（**v13 新增**，见 06 §11.2）：三档权限
  `readonly`（只读：写 / 执行 / 有系统副作用的工具**根本不注册**，模型在工具清单里看不到它们）|
  `confirm`（边界自动：项目根内直接执行、越界弹卡；无项目直接放行）|
  `auto`（**默认档**，2026-09-29 起：完全权限，**所有敏感工具调用都不弹确认卡**；
  项目根只作为缺省工作目录与 `confirm` 档边界，不再决定是否询问，见 06 §11.2）。
  与 `advanced.confirmSensitiveTools` **双开关并存**，优先级是：`confirmSensitiveTools === false` 时
  非 readonly 档被强制按 `auto` 处理；`readonly` 档下该布尔**无效**（只读优先）。
  两个字段是**镜像**关系（界面写档位时同时写老开关），出厂默认因此是
  `permissionMode: 'auto'` + `confirmSensitiveTools: false`，两者不矛盾。
  **只读**（`SETTINGS_READONLY_PREFIXES`）：改档位等于给自己放宽或收紧确认闸门，属自我提权，
  只能由用户在设置页 / 对话窗改。
- `agent.snapshots`（**v14 新增**，见 06 §11.8）：写前快照 —— `enabled`（默认 `true`，
  关掉后 `write_file` / `edit_file` 写盘前不再留底，**改动将不可回滚**）、
  `keepPerFile`（同一文件最多留几份，1–200，默认 20，环形淘汰最旧的）、
  `maxSnapshotBytes`（单个文件超过这个大小就不留底，默认 512 KiB —— **不静默**：
  工具结果里会写"未保存快照：文件过大"）、`totalBudgetBytes`（备份目录总预算，默认 200 MiB，
  超出时从最旧开始删）。快照落在 `<userData>/backups/<sessionId>/`。
  **用户可写**（「智能与工具」页调整），**AI 不可写**：`agent.snapshots` 在
  `SETTINGS_READONLY_PREFIXES` 里（与 `agent.permissionMode` 同款），AI 的 `set_setting` 一律拒绝——
  关掉写前备份等于拆掉回滚保险。
- `agent.loop`（**v15 新增**，见 06 §4.1）：Agent 循环的刹车与油门 ——
  `maxRounds`（一次请求内最多几轮「工具调用 → 结果回填」，1–128，默认 **32**）、
  `maxTotalTokens`（累计 token 预算，≥0，**0 = 不限**即默认；触顶时任务暂停而不是静默结束）、
  `autoContinueRounds`（轮次用完后允许自动再续几轮，0–8，默认 8；**0 = 不自动续**，
  直接落「已暂停」等用户点「继续」）。
  三个值都以 **getter** 注入装配层，设置页改完**下一次请求即生效**（v15 之前轮次上限是常量，改配置要重启）。
  **用户可写**（「智能与工具 → Agent 循环」里调），**AI 不可写**：`agent.loop` 在
  `SETTINGS_READONLY_PREFIXES` 里（与 `agent.permissionMode` 同款）—— 让 AI 给自己放大预算，
  等于绕过"该停下来问用户"的那道闸门。
- `automations`（**v19 新增**，见 docs/13 §2.2 / §11）：**自动化（Agent Mode / Normal Mode）**的
  总开关，整组只有 `enabled` 一个字段（默认 `true`）。**关闭 = 引擎停止评估与触发**，
  定义与运行历史原样保留（回看历史不受影响）；设置页入口在「模式」页顶部的「自动化」区组
  （`data-field="automations.enabled"`，**常显** —— 关掉必须还能开回来），
  管理入口在主界面左栏「自动化」（docs/07「自动化页规格」）。
  - **定义与历史不是配置**：`<userData>/automations/automations.json`（用户自建定义）与
    `history.json`（运行历史，上限 **500** 条，超出淘汰最旧）—— 同会话 / 待办的口径，
    **不进 `CONFIG_VERSION` 迁移链**，也不参与「导出脱敏配置」（见 §1.2 与 docs/13 §2.1）。
  - **只读（`SETTINGS_READONLY_PREFIXES`）**：这是用户对「AI 能不能自己安排后台动作」的**总闸门** ——
    AI 关掉它可以让用户的自动化静默失效，打开它再配合 `automation_*` 工具等于自己给自己排程。
    因此 AI 的 `set_setting` 对 `automations.*` 一律拒绝；AI 增删 / 启停自动化走**专用工具**
    （`automation_list` / `automation_history` 为 `safe`，其余 `confirm` 进入确认链，
    是否弹卡由权限档与项目边界决定，docs/13 §8）。
  - `SettingsPatch` 新增可选 `automations` 字段（**顶层浅合并**，`{ automations: { enabled } }`
    的形状即可）；设置页那一处开关走 `settings:update`，不经过黑名单。
  - **不引入任何凭据路径**：本组没有密文（对照 `apiKeyEnc` / `envEnc` / `headersEnc` /
    `center.token ⇄ center.tokenEnc`），`SettingsStore` 的四处凭据读写与主进程 `redactSettings`
    都不需要为它改动。
- `fileAwareness`（**v28 新增，v29 扩展**，见 06 §26）：文件自感知。`enabled` 与
  `contentConsentAccepted` 同时为真才允许读取图片 / 文档正文并调用模型；`watchedDirs` 最多 3 个，
  `knowledgeDir` 是用户可见 Markdown 知识库；`includeRecent` 控制 Windows 最近使用记录，
  `suggestionsEnabled` 控制提示条气泡，`dailyAnalysisLimit`（1–200，默认 20）和
  `maxFileMb`（1–500，默认 100）控制后台预算；`defaultMemoryTtlDays`（0–3650，默认 0）
  控制跟随默认记忆的有效期，0 = 永不过期；`backgroundModel` 为空时跟随全局主模型，
  显式选择后严格使用该 provider + model，不可用时暂停而不是回落。整组在 `SETTINGS_READONLY_PREFIXES` 里：
  它同时改变文件读取范围、数据出网与后台任务，AI 不得自行开启或放宽。
  内嵌图片是否真正读取由有效后台模型的 `vision` 决定；运行状态会如实显示「已开启 / 仅分析文字」。
- 新需求字段一律**先更新本文档 Schema**，再加代码。

### 1.1 仅存在于 IPC 层的字段（非持久化）

`settings:get` / `settings:changed` 回传渲染层的对象会在上述 Schema 之外**补充两个只读标记**，
用于让设置页显示"凭据是否已配置"，同时保证密文永不进入渲染进程：

| 字段         | 位置                                                                                           | 说明                                                               |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apiKeySet`  | `llm.providers.<id>` / `tts.providers.<id>` / `stt.providers.<id>` / `imagegen.providers.<id>` | `true` 表示该 provider 已保存 API Key（`apiKeyEnc` 始终回传空串）  |
| `envSet`     | `mcp.servers[]`                                                                                | 已配置的环境变量名列表（`envEnc` 始终回传空对象）                  |
| `headersSet` | `mcp.servers[]`                                                                                | 已配置的自定义请求头名列表（`headersEnc` 始终回传空对象；v9 新增） |

两者由主进程在回传前计算，不写入 `config.json`，因此不参与版本迁移。

**回传语义（踩过的坑）**：`apiKeyEnc` 恒为空串、`envEnc` / `headersEnc` 恒为空对象，所以渲染层回传里的
「空」只能被主进程理解为**本次不改凭据**（`applyPatch` 的合并规则，见 06 §12.4）。其中 MCP 的
`envEnc` 是**逐键**合并的：空对象 = 一个键也不改；某个键的值是空串 = 该键保留已有密文
（新增服务器时它是占位，随后由 `settings:setSecrets` 写成真密文）；v9 起 `headersEnc` 同款逐键合并。
渲染层**表达不了**
「只删凭据」这种操作：删除单个 MCP 环境变量或自定义请求头只能走 `settings:clearSecret`
（`envEnc` / `headersEnc` 的键随之消失）；
MCP 服务器整体删除由 `mcp.servers` 数组的权威语义表达（不在数组里 = 删除），
provider 整体删除由 `llm.removedProviders` 显式声明（§5 第 5 条）——
两种删除的凭据（密文 + 内存明文缓存，env 与 headers 并列清理）都由主进程在删除**成功之后**一并清理。

### 1.2 不属于 config.json 的本地数据

分类流水与规则缓存**不写入 config.json**（避免配置被高频重写），单独存放：

| 文件                           | 内容                                           | 说明                                                                  |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| `userData/classification.json` | `{ version, records: ClassificationRecord[] }` | 分类流水（上限 500 条，新的在前）；原子写 + 300ms 防抖 + 损坏备份重建 |

规则缓存**不单独持久化**，启动时由流水中的用户修正记录重建（见 05 §3.2），
因而不新增存储面，也不会与流水出现两处数据不一致。

**对话归档状态同样不进 config.json**：它写在会话文件自身（`sessions/<id>.json` 的
`meta.archived`，见 06 §4），因此归档功能**不改 `CONFIG_VERSION`**（当前版本号见 §2）。
会话文件自己的版本号 `SESSION_FILE_VERSION` 由 1 提到 2，读取对 v1 宽容（缺 `meta` = 未归档），
不存在需要执行的迁移脚本 —— 「会话文件版本」与「配置版本」是两条独立的链，别混。

**自动化的定义与运行历史同样不进 config.json**（v19，docs/13 §2.1）：落在
`<userData>/automations/automations.json`（用户自建定义）与 `history.json`（运行历史，上限 500 条），
因此自动化只把**总开关**计入配置版本（`v18 → v19`，见 §2 与 §1 的 `automations` 一条）。
存储实现沿用仓库统一约定：in-flight promise 共享的 `ensureLoaded`、300ms 防抖 + 原子写、
损坏文件备份 `.corrupt-<ts>.json` 后重建、退出前 `flush()`。

### 1.3 资源名称约定与凭据路径（P1-07）

provider id（`llm.providers.<id>` / `tts.providers.<id>` / `stt.providers.<id>` /
`imagegen.providers.<id>`）与 MCP 服务器名（`mcp.servers[].name`）一律遵守：

```text
/^[A-Za-z0-9_-]+$/      # 只能含字母、数字、下划线、连字符；禁 `.`
```

- **为什么禁 `.`**：凭据路径以 `.` 分段（`llm.providers.<id>.apiKey`、
  `mcp.servers.<name>.env.<KEY>`、`mcp.servers.<name>.headers.<KEY>`），
  含点的名称会让「名称」与路径分隔符无法区分 —— `SettingsStore` 的
  `canonicalSecretPath` / `readSecretField` / `writeSecretField` 定位不到条目，
  `setSecret` 抛 `SettingsSecretError: 无法识别的凭据路径`；MCP 添加流程更糟：
  服务器行已落库、`settings:setSecrets` 失败，env 明文静默丢失。
- **校验口径（三处同源，不写第二份正则）**：① `packages/shared/src/config/schema.ts` 的
  `RESOURCE_NAME_PATTERN`（`McpServerSchema.name` 上的 `.regex(...)`，提示文案
  `RESOURCE_NAME_RULE`）；② 五个设置页新增入口（LlmPage / Tts / Stt / ImageGen / Mcp）
  经 `@aurora/shared/browser` 取**同一个常量**、同一句提示当场拒绝；
  ③ 主进程 `settings:update` 因 Schema 校验失败而拒绝整次写入。
- **存量兼容口径**：读取侧对**含点名称**改贪婪 / 按标记从右往左拆分匹配（`store.ts`
  的 `canonicalSecretPath` 与各 matcher，见 06 §11 之外的凭据链说明），因此老的
  `llm.providers['api.deepseek']`（`llm.providers` 是 record，键不受 Schema 约束）
  **仍可继续使用**，只是不建议再新增；MCP 服务器名受 Schema 约束，含点存量在
  `SettingsStore.init()` 里被**规整**（非法字符替换为 `-`、冲突追加 `-2`…，
  同 `pruneUnknownWindowState` 的「只修这一处、不动其它配置」口径），凭据密文存在条目
  内部的 `envEnc` / `headersEnc`、随条目一起搬走不会丢 —— 不做这一步，含点名称会让
  `mcp.servers` 数组在 `SettingsSchema.parse` 硬抛、整份配置被备份重建
  （用户所有 provider / 课表 / 项目一起消失）。
- **MCP 路径的拆分约定（候选 + 按真实服务器名择优，2026-10-01 补齐）**：env 键 / header 名
  **没有**「不含 `.`」的硬约束（`envEnc` / `headersEnc` 是 `z.record(z.string(), …)`），
  所以不用「键段 `[^.]+`」判定。`store.ts` 的 `splitMcpSecretPath` 把每个受控标记
  （`.env.` / `.envEnc.` / `.headers.` / `.headersEnc.`）的**每一个出现位置**都算作一个
  候选拆法，**从右往左**逐个用「该服务器名在当前 `mcp.servers` 里是否真实存在」校验，
  命中第一个存在者即采用：
  - 「键名自身含标记词」不再误判 —— `mcp.servers.srv.headers.env.X` 解析为服务器 `srv`
    的 header `env.X`（只取最右标记会把它错拆成服务器 `srv.headers`）；
  - 正常形状（`mcp.servers.srv.env.KEY` / `...headers.Authorization`）逐字不变；
  - **一个候选都不命中**（服务器确实不存在，或无上下文的纯字符串调用方）时**回落到
    「最右标记」** —— 与择优之前的行为逐字一致，保证 `canonicalSecretPath`、`toPersisted`、
    主进程 `redactSettings` 这些拿不到 settings 上下文的路径不变。
  - **已知限制**：服务器名**本身**含点（如 `my.server`）时，择优只能靠 `mcp.servers` 里的
    真实名字判定；由于 `McpServerSchema.name` 现在禁 `.`，这类名字在 `init()` 就被规整成
    `my-server`，所以实际只影响 `canonicalSecretPath` 这类纯字符串归一化。另外，
    「同一路径的多个候选都真实存在」时只认从右往左第一个存在的名字，不保证与写入意图一致；
    新配置不要用带标记词的键名。

## 2. 存储与安全

- 路径：Electron `userData`（`%APPDATA%/Aurora/`），配置文件 `config.json`、会话 `sessions/`、
  分类流水 `classification.json`、日志 `logs/`、用户技能 `skills/`。
- 写入：原子写（临时文件 + rename）+ 写防抖（300ms）；启动时校验 Schema，非法字段回退默认值。
- 读取：`get()` 返回**深拷贝**（调用方可安全改写，用于设置页 / 迁移等低频路径）；
  `snapshot()` 返回**只读的当前快照**，供 agent loop 的每轮 getter（`maxRounds` / 预算 /
  自动续轮等）热路径使用，避免每 attempt 深拷贝整份配置。两者只差拷贝成本，语义都是"当前值"。
- 迁移：`version` 字段 + `migrations` 链式执行。当前 `CONFIG_VERSION = 30`：
  `v0 → v1`（补齐 version、扁平字段归一、`llm.apiKey → apiKeyEnc`）、
  `v1 → v2`（补齐 `modes.classroom.classification` 与 `advanced.confirmSensitiveTools`）、
  `v2 → v3`（补齐 `modes.classroom.schedule.classisland`）、
  `v3 → v4`（移除 `general.windowState['service-dock']`，AI 悬浮窗已删除）、
  `v4 → v5`（补齐 `llm.providers.*.reasoningEffort` 与 `agent.tools.*`）、
  `v5 → v6`（移除 `general.windowState['mini-chat']`，独立小窗已删除；
  补齐 `llm.providers.*.modelList` 与 `advanced.readonlyPrefixes`）、
  `v6 → v7`（补齐 `tts.*`）、
  `v7 → v8`（补齐 `stt.*` 与 `imagegen.*`（语音输入 / 生图）、`modes.work.workspaceDir`、
  `modes.classroom.preClassOpenFolder`、`general.chat.showThinking`；新增顶层分组无条件补默认值，
  已存在分组只补缺失键、不凭空造出半截对象）、
  `v8 → v9`（为每个已有 `mcp.servers` 条目补 `headersEnc: {}`，HTTP 传输自定义请求头，见 06 §7）、
  `v9 → v10`（为已存在的 `modes.classroom` 补 `preClassLeadMinutes: 5`，课前提早分钟数）、
  `v10 → v11`（为每个已有 `llm.providers.<id>` 补 `contextWindow: 0`，上下文窗口，
  只用于对话窗底部的上下文占用比例，见 §1.2）、
  `v11 → v12`（为 `agent.tools` 补 `search.enabled / search.maxResults`（文件检索，见 06 §11.5）
  与 `terminal.allowPatterns: []`（免确认命令模式，见 06 §11.7）；缺字段就补默认值、
  `agent.tools` 分组本身缺失时交给默认配置兜底，不凭空造半截对象）、
  `v12 → v13`（新增顶层分组 `projects`（项目机制，见 06 §5.1）与 `agent.permissionMode`
  （三档权限，见 06 §12.2）；`projects` / `agent` 分组已存在时只补缺失键
  （`current: ''` / `list: []` / `maxAgentsBytes: 32768` / `permissionMode: 'confirm'`），
  分组本身缺失时交给默认配置兜底，同样不凭空造半截对象）、
  `v13 → v14`（为 `agent` 补 `snapshots.*`（写前快照的开关、保留份数与容量上限，见 06 §11.8）；
  `agent` 已存在时只补缺键，用户调过的保留份数原样保留）、
  `v14 → v15`（为 `agent` 补 `loop.*`（轮次上限、token 预算与自动续轮，见 06 §4.1）；
  `agent` 已存在时只补缺键，用户调过的那三个值原样保留。默认值刻意等于 v15 之前写死的行为
  —— `maxRounds: 8` / 预算不限 / 自动续 2 轮 —— 因此升级后既有的长任务表现不变，
  只是"停下来"现在会明确说是停在哪）、
  `v15 → v16`（新增顶层分组 `center`（Aurora Center 连接，docs/12）：整组缺失时补默认值，
  已存在时只补缺失键；`center.token` 是凭据路径，迁移只补 `tokenEnc: ''` 不碰已有值）、
  `v16 → v17`（为已存在的 `center` 补 `account: ''`（账号登录后记住的账号名，见 12 §7）；
  其余键原样保留，`center` 分组本身缺失时交给默认配置兜底）、
  `v17 → v18`（放宽 `agent.loop` 轮次上限（见 06 §4.1 / §5）：恰好等于旧默认值的
  `maxRounds: 8` → `32`、`autoContinueRounds: 2` → `8` —— v15 迁移把旧默认值显式写进了
  已有配置，单改 Schema 默认值对老用户无效，故按哨兵值抬升；用户显式改过的其它值
  （哪怕恰好也是 8 / 2）同样被抬升，这是「放宽」方向的迁移，宁可多放不误收紧）、
  `v18 → v19`（新增顶层分组 `automations`（自动化总开关，见 §1 与 docs/13 §2.2）：
  **整组缺失时补 `{ enabled: true }`，已存在时原样保留、一个键也不改** —— 幂等、
  不覆盖用户已写值；自动化的定义与历史是用户数据（`<userData>/automations/`），不走迁移链）、
  `v19 → v20`（新增 `general.requireAdmin`（要求管理员身份启动，见 §1 / docs/09 §9）：
  只为**已有 `general` 分组**补缺字段（默认 `true`），用户已写的 `false` 原样保留、
  一个键也不改；`general` 整组缺失时留给 Schema 兜底，不凭空造半截对象）、
  `v20 → v21`（新增 `general.edgeBar.display` / `general.edgeBar.position`
  （提示条贴附的显示器与屏幕侧，见 §1）：只为**已有 `general.edgeBar`** 补缺字段
  （默认 `primary` / `right`），已写值原样保留，`edgeBar` 缺失时留给 Schema 兜底；
  同时新增 `appearance` 分组（外观自定义，见 §1）：**整组缺失时补 `{ accent: 'aurora' }`**，
  已存在时原样保留、一个键也不改 —— 与 `v18 → v19` 的 automations 同一套路）、
  `v21 → v22`（**多模态输入 + Responses API**，见 06 §3.1 / §3.2：为**每个已有
  `llm.providers.<id>`** 补 `vision: false`，并把缺失 / 非法的 `type` 归一为
  `openai-compat`（旧配置写的本来就是这个值，迁移**不改正值**、只补缺字段与非法值）；
  两个都是**能力开关**，出厂一律「关 / 旧协议」，因此升级后请求体与 v21 逐字一致）、
  `v22 → v23`（**模型级参数表**，见 §1 的 `modelParams`：新增
  `llm.providers.<id>.modelParams`（`Record<modelId, { reasoningEffort, contextWindow, vision }>`），
  把 provider 级的 `reasoningEffort` / `contextWindow` / `vision` 三个旧键**搬到**
  `modelParams[provider.model]` 下，并删除 provider 级的**四个**键（三个旧键 + `temperature` ——
  它随 v23 从 Schema 消失，请求不再下发）。四条语义：① **幂等** —— 重复执行结果一致，
  `modelParams` 已有对应模型条目时只补缺失键、不重建；② **不覆盖已写值** ——
  已有的 `modelParams[<model>]` 条目（以及其中已写的值）原样保留；③ **`model` 为空串时不造模型条目** ——
  此时 `modelParams` 写 `{}`，四个旧键照删（不凭一个不存在的模型名编出条目）；
  ④ **旧非法值归一到默认** —— `reasoningEffort` 非法 / 缺失 → `'auto'`、
  `contextWindow` 非法 / 缺失 → `0`、`vision` 非法 / 缺失 → `false`；
  没有 `llm.providers` 时整组交给默认配置兜底，不凭空造半截对象）、
  `v23 → v24`（**语音输入支持阿里云百炼原生 ASR**，见 06 §15.1：
  归一**每个已有** `stt.providers.<id>` 的 `type` —— 只把「缺失 / 不是已知取值」的补成
  `openai-compat`（v23 及更早的配置写的本来就是这个值，旧配置升级后请求体逐字不变），
  已是 `dashscope-native` 的**不动**（迁移不替用户改协议）；
  `stt` 分组缺失时留给默认配置兜底，不凭空造半截对象）、
  `v24 → v25`（**退役全局 `projects.current`**（见 §1 的 `projects`）：从 `projects` 分组里
  **删除该字段**（置空串等于让死字段永生），`list` / `maxAgentsBytes` 原样保留；
  界面的「设为当前」与左栏「当前」徽标随本轮一并退役 —— 项目改由会话绑定
  （`sessions/<id>.json` 的 `meta.projectId`，见 06 §5.1））、
  `v25 → v26`（**主界面默认尺寸上调**：1120×720 → 1280×800（min 940×600 → 1060×660，
  见 07 §2.3）。窗口几何是**用户态**（拖动即落盘），所以这一步只做一次「跟着新默认长大」的
  补偿：`general.windowState.chat` 的宽 / 高若**小于**新默认就抬到新默认，**只放大、不缩小**
  —— 用户自己拖得更大的尺寸原样保留；几何缺失时不动 `general`。窗口管理器还有第二级抬底
  （`SPECS.chat` 的 minWidth / minHeight 会把越界旧值夹上来），两者不冲突）、
  `v26 → v27`（**模型打开网址默认走内置浏览器**：在已存在的 `agent.tools.open` 分组补
  `urlMode: 'internal'`；已有合法值原样保留，分组缺失时交给默认配置兜底）、
  `v27 → v28`（**文件自感知**：补齐默认关闭的 `fileAwareness` 分组；只补缺失键，
  不覆盖已有值）、
  `v28 → v29`（**记忆过期与后台模型**：为 `fileAwareness` 补
  `defaultMemoryTtlDays: 0` 与空的 `backgroundModel`；已有值原样保留）、
  `v29 → v30`（**游戏模式**：为已有 `general` 补 `gameMode: { enabled: true }`；
  `general` 组缺失时不凭空造半截对象）。
  三十条迁移都**幂等且不覆盖用户已写入的值**（`v17 → v18` 例外：它**刻意**改写旧默认哨兵，
  方向是放宽；`v25 → v26` 同样刻意改写，但**只往上抬**），重复执行结果一致 ——
  `pnpm verify` 的迁移条数断言
  （`v0 → 当前版本的迁移条数 === CONFIG_VERSION`）随之变为 **30** 条。
- 凭据：`apiKeyEnc` / `envEnc` / `headersEnc` 用 **safeStorage** 加密后落盘；日志、错误上报、配置导出时一律脱敏（`***`）。

## 3. 首次安装引导流程

```
欢迎（品牌 + 三模式介绍）
  → AI 模型配置【必填】：provider 预设（DeepSeek / OpenAI / 自定义）+ baseURL + API key + 模型名
        → “测试连接”（展示延迟；可选拉取模型列表）
  → 模式选择（ClassRoom 推荐）
  → 模式引导（若选 ClassRoom）：感知文件夹 + 科目列表；（若选 Work）：工作目录问答（v8 起实装）
  → 完成（见 05 §2）
  → 完成页 → 进入托盘常驻，显示提示条
```

> 早期版本的「语言 / 主题」步骤已删除：`general.language` 是死字段（无 i18n 消费方），
> 主题也没有实现，两件都不可配置。详见 §6.1 的门控矩阵。

- **规则**：AI 模型配置未完成不允许进入主界面（需求：第一次安装要求用户填写）；测试连接失败允许先保存，但持续提示未通过。
- 引导可重跑：设置 → 模式 → “重新引导”。
- **实现状态（v0.1.0）**：引导窗共 5 步（欢迎 → AI 模型 → 模式选择 → 模式设置 → 完成），
  其中「模式设置」对 ClassRoom 为表单式（感知文件夹 / 科目列表 / 课前提醒）；
  Work 自 v8 起改为「工作目录（`modes.work.workspaceDir`）问答 + 确认」（目标口径，UI 由另一任务实施），
  Code 仍只显示占位说明；「重新引导」会重置 `guideCompleted` 并唤起对话窗口。

## 4. 模式切换后的主动引导

- 切换成功 → 检测该模式 `guideCompleted` → 未完成则由 Proactive 在交互窗发起对话式引导（见 05 §2、06 §9）。
- 引导期间设置页对应项同步更新；中断可续接，且可在设置中关闭再次提醒。

## 5. AI 模型设置页

信息架构是**目录行列表 + 一次只开一张编辑卡**（前端刷新轮重写）：
不再把所有 provider 平铺成一屏长滚动卡片，而是自上而下四块 ——

1. **页头摘要**：标题 + 一句话说明（凭据加密、日志脱敏）+ 当前默认状态
   （`当前默认：<activeId> · <model>`；`llm.active` 为空或指向不存在的 provider 时显示「尚未选择默认模型」）。
2. **工具行**：`+ 添加 Provider`（切到添加态）与「保存全部」（逐个保存全部 provider）。
3. **provider 行列表**：每个 provider 一行，行上只有
   - 名称（`.mono`）；
   - **凭据状态 badge**：`apiKeySet === true` → `凭据已保存`（ok），否则 `缺少凭据`（warn）——
     凭据**永不回显**（§1.1），编辑卡里的 API Key 是 write-only 输入，**留空 = 本次不修改**；
   - 是否默认 badge（`默认` / 不显示）；
   - 行尾操作：`编辑` / `设为默认`（已是默认时 disabled）/ `删除`。
   - 列表为空时是 `data-empty="llm.providers"` 的**空状态卡**（文案与「添加 AI 模型」主按钮），
     不画一排空行。
4. **编辑卡**（`editingId` 是单值，因此**同一时刻最多一张卡**）：
   - 必填区：`baseUrl` / `apiKey` / `model`（必填项前置，缺失时当场提示是哪个 provider 的哪个字段，
     不再等到保存后由 Schema 兜底）；
   - 「模型设置」区（必填区与 `高级参数与连接测试` 折叠区**之间**）——该 provider 的**候选模型列表**：
     - 头部：标题「模型列表」+「拉取模型列表」（与折叠区里同名按钮共用同一段 `loadModels` 拉取逻辑）
       与「+ 手动添加」；
     - 列表：每项一行，行上有
       - **「当前使用」标记**（选中即把 `llm.providers.<id>.model` 设为该 id，即改的是唯一生效值）；
       - 模型 id 文本（`.mono`）；重命名（改的就是列表里的 id，若是当前使用的那个则同步改 `model`）；
       - 删除（从列表移除）；
       - **展开模型参数**（行上的 `data-action="toggle-model-params"` 开关）：就地展开这一行的
         三个字段 —— **思考等级 / 上下文窗口 / 支持图片输入**，锚点
         `llm.providers.<id>.modelList.<index>.{reasoningEffort,contextWindow,vision}`，
         读写的是 `llm.providers.<id>.modelParams[<modelId>]`（v23，见 §1）——
         **参数随模型绑定**：换模型即换这一份参数。开关是**行内**的，与 provider 级
         「高级参数与连接测试」折叠区无关（后者只有接口类型与连接测试，见下）。
     - **删除当前使用的那一项不换模型**：`model` 原样保留，只在页面提示「当前模型已不在列表中」，
       改哪个由用户自己决定——与 §1 的回落口径一致，不静默换模型；
     - 「拉取模型列表」把发现到的 id **去重合并**进现有列表（不覆盖已有项），
       结果提示为「已拉取 N 个，列表共 M 个」；
     - 列表为空时是 `data-empty="llm.providers.<id>.modelList"` 的空状态提示块
       （文案：「还没有模型列表：先在下面填一个模型名，或点「拉取模型列表」」）；
     - 与「模型名」的关系：必填区的 `data-field="llm.providers.<id>.model"` 输入框**保留在原位**，
       它是「当前使用模型」的**唯一编辑点**（也是 capture 抓手）；它填的 id 不在列表里时会
       **自动追加进列表**，让两者保持一致且用户看得见发生了什么。
   - `高级参数与连接测试` 折叠区（**默认收起**）：**只剩两样** —— **接口类型**
     （`llm.providers.<id>.type`，`openai-compat | openai-responses`，v22）与
     `保存并测试连接` / `拉取模型列表` 按钮、连接延迟与可用模型 chips；
     **思考等级 / 上下文窗口 / 支持图片输入不在这一层**（v23 起改为在**模型行内**、随模型绑定，
     见上一条），`temperature` 已随 v23 从 Schema 删除、本区不再有它；
   - 卡底 `应用`（只提交这一张卡，成功回列表态）/ `取消`。
   - 添加流程：预设 chips（DeepSeek / OpenAI / 本地兼容）+ 自定义 id 输入框；重复 id 提示
     `Provider「<id>」已存在`；选中预设**直接进编辑卡**。
   - **模型列表是页与窗的公共数据**：本页维护 `llm.providers.<id>.modelList`，对话窗的「模型」选择器
     从**同一份**列表里选、并把选中项写回 `llm.providers.<id>.model`（docs/07 §2.3）。
     两边不存在各自的副本，因此「模型页改当前模型 → 对话窗选择器跟着变」是必然而非同步逻辑。
   - **对话窗「上下文详解」卡只呈现三行**：本轮输入 / 上下文窗口 / 模型 ——
     分母取**当前生效模型**的 `modelParams.<modelId>.contextWindow`（`0` = 未知则不显示百分比，
     见 §1 与 docs/07 §2.3）；v23 起卡片正文就这三行（`chat.context-detail` 锚点与
     `chat.context` / `chat.context-usage` / `chat.context-cache` / `.ctx-total` 保持不变）。
5. **删除是危险操作**：点「删除」先就地出现确认条
   （`删除 provider「<id>」？依赖它的会话将无法再请求模型。` + `确认删除` / `取消`）。
   确认后的 patch 带 `llm.removedProviders: [<id>]` —— `llm.providers` 是 record，
   **缺项表达不了删除**（只回传一份少了它的 `providers` 是合法的局部更新形状，不会删掉它）。
   密文与内存明文缓存在**删除成功之后**由主进程一并清理；删除失败时凭据保持原样。
6. **思考等级 / 上下文窗口 / 支持图片输入**属于**模型维度**
   （`llm.providers.<id>.modelParams.<modelId>.*`，v23 起，见 §1），因此**不在** provider 级折叠区，
   而在「模型设置」区的**模型行内**展开编辑（行上 `data-action="toggle-model-params"` 开关，
   字段锚点 `llm.providers.<id>.modelList.<index>.<字段>`）；交互窗另有入口
   （docs/07 §2.3，读写的是同一份 `modelParams`）。语义因此是「**参数随模型绑定**」——
   在对话窗切模型即切参数，`model` 是唯一生效值、参数随之取（见 06 §3）。
7. 保存语义：`settings:update` 只有**顶层浅合并**，因此任何一次保存都必须**原样回传全部 provider
   再覆盖当前一个**；`apiKeyEnc: ''` 对已有 provider 表示「本次不改凭据」（新建时 Schema 要求该字段存在）；
   **缺项 ≠ 删除**（删除必须显式声明 `llm.removedProviders`，见第 5 条）；
   明文 API Key 只走 `settings:setSecrets`。`modelList` 是数组，跨 IPC 前必须**深拷贝成新数组**
   （`reactive` 里的数组是 Proxy，直接传会 `DataCloneError`）。
8. 支持范围：DeepSeek / OpenAI / 其他 OpenAI 兼容（含 Ollama 本地）；P2 再评估更多协议（Anthropic 等）。
9. 测试连接：展示延迟与可用模型列表（可选拉取）。
10. **v8 目标口径增量（UI 由另一任务实施）**：本页在 6 页 IA（见 §6「页面结构」）下还承载 ——
    「显示思考过程」开关（`general.chat.showThinking`，门控对话窗可折叠思考块，docs/07 §2.3）与
    **生图模型区组**（`imagegen.*`：总开关 / 默认生图模型 / provider 增改删；provider 表单为
    `baseUrl` / `apiKey` / `model` / `size`，与 `llm.providers` 同构但独立，见 §1；
    凭据沿用 §1.1 的 `apiKeySet` 只读标记口径，编辑卡 API Key 留空 = 本次不修改）。
    **生图模型列表为空时**是 `data-empty="imagegen.providers"` 的**空状态卡**（锚点保持不变），
    卡上必须有**可点的「+ 添加生图模型」主按钮** —— 空状态只留一句话、不给入口，
    用户会以为这功能没实现（v23 起的目标口径）。

## 6. 其他设置页

- **常规**（`general.*`）：开机自启、全局快捷键、提示条（显示 / 额外透明度 / 独立勿扰时段）均已生效；
  提示条本体固定使用毛玻璃材质，透明度设置只叠加整窗淡化，不替代材质。
  **「启动」区组新增「以管理员身份运行」开关**（v20，`data-field="general.requireAdmin"`，
  出厂开）：启动时未提权会弹 UAC 重新拉起（理由与四条边界见 §1 的 `general.requireAdmin`），
  提示文案已写明「改动重启后生效」。
  **已知限制**：开机自启（`general.launchAtLogin`）时同样会弹一次 UAC —— 当前**没有**用
  计划任务做最高权限自启（见 docs/09 §8）。
  `general.language` 是**未生效的死字段** —— Schema 里保留（避免再动一次配置版本），但**没有 i18n 消费方**，
  改它不会改变界面语言，因此**设置页与引导页都不再显示该选择器**（保存时仍原样回传，配置不丢）。
- **页面骨架**：所有页面统一「标题 + 一句话说明 + 分组卡片」（`theme.css` 的
  `.page` / `.page-title` / `.page-sub` + `settings/settings.css` 的 `.section-card` /
  `.section-title` / `.section-desc` / `.empty-state`）；侧栏按「基础 / AI 能力 / 系统」三组排列。
- **页面结构（2026-09-30 起 8 页；本节为目标 IA）**：设置页由 8 页并为 **6 页**，
  再于 2026-09-30 新增 `sessions` 会话管理，现为 **8 页**
  （`SETTINGS_PAGE_IDS = ['general', 'sessions', 'modes', 'llm', 'voice', 'agent', 'center', 'advanced']`），
  侧栏仍三组排列：
  - **基础**：`general` 通用（启动与快捷键 / 提示条 / 勿扰时段——全局 + 提示条两组同区 / 关于与更新）、
    **`sessions` 会话管理（2026-09-30 新增）**：
    **项目管理区组整体自「通用」页迁入**（`projects.*` 锚点与逻辑原样搬，见 §1 的 `projects`；
    项目根可用性警示也从右栏卡改到这里的 AppToast 文案「项目目录不可用」）+
    **会话列表区组**（`data-field="sessions.section"` / 行 `sessions.row`）：
    按左栏三分口径分组展示（项目对话 / 工作目录对话 / Agent对话 / 已归档），行内提供
    **归档 / 取消归档**（可逆，`chat:archiveSession`）与**删除**（不可逆，
    `chat:deleteSession`：**两步确认** —— 第一次点翻成「确认删除」+「取消」，第二次点才真删；
    主进程对「还有 running 任务」的会话拒绝 `E_INVALID_STATE`；守卫通过后先清理
    `todos/<id>.json` / `todos/<id>-sub.json`，再删 `sessions/<id>.json`，最后广播删除事件。
    todo 清理失败时不删会话、不广播；`quick` 与普通会话走同一删除路径）、
    `modes` 模式（**自动化总开关区组（v19，`automations.enabled`，不跟模式门控）** + 模式卡 +
    ClassRoom 区组 + Work 区组，见 §7）；
  - **AI 能力**：`llm` AI 模型（provider 管理 + 「显示思考过程」开关 + 生图模型区组，见 §5）、
    `voice` 语音（TTS 区组 + STT 区组）、
    `agent` Agent 设置（`agent.tools` 区组 + 技能区组 + MCP 区组，三组同页折叠；2026-10 前称「智能与工具」）；
  - **系统**：`advanced` 系统（网络 / 日志 / 安全 / 危险操作）。
  - 旧页深链兼容映射：`?page=tts` → `voice`、`?page=skills|mcp` → `agent`；
    `general` / `modes` / `llm` / `advanced` 页 id 不变，旧深链继续可用。
- **Skill 管理**（目标 6 页 IA 下为「Agent 设置」页的技能区组）：内置 Skill 列表 + 用户目录导入 / 添加、启用开关（`skills.disabled`）。
  - 实现状态（v0.6.0）：`skills.userDir` **真正生效**（此前运行时硬编码 `userData/skills`，
    配置项是死字段）。空串回落 `userData/skills`；填自定义目录后保存会**按新目录重扫**。
    页面显示「当前生效目录」与「上次扫描时间」，并提供**真实的**「重新扫描」
    （`skills:rescan`，重扫磁盘而非重新拉取内存清单）；解析失败的技能计入
    `skills:status` 的 `failed` / `warnings` 并在页面提示，不再静默吞掉。
    另：目录切换复用**同一个注册表实例**（`setUserDir` + 重扫）——`use_skill` 工具的闭包
    与提示词组装都持有该实例，换实例会让它们继续指向旧表，表现为「改了目录但模型仍看到旧技能」。
- **MCP 管理**（目标 6 页 IA 下为「Agent 设置」页的 MCP 区组）：服务器列表、添加（stdio 命令 / HTTP URL）、连接状态灯、错误日志。
  - 实现状态（v0.3.0）：列表读写与凭据脱敏沿用 v0.1.0；**状态灯**由 `mcp:status` /
    `mcp:statusChanged` 驱动（`ready` / `connecting` / `error` 三态，`error` 时展示
    最近一次失败原因），`lazyConnect` 可在设置页切换（收在「高级」折叠里）。
  - 凭据保真（本轮修）：列表里「环境变量：…（值已加密存储）」读的是主进程补的**只读标记**
    `envSet`（§1.1），不是永远为空对象的 `envEnc`；任何一次保存（添加 / 停用 / 删除）回传的
    空 `envEnc` 都按「本次不改凭据」处理，不再清掉磁盘上的密文。
  - **自定义请求头（v9）**：服务器编辑新增「自定义请求头」输入（多行 `Key: Value`、每行一个，
    编辑交互与「环境变量」完全同款）；已配置的头在服务器条目上按名字列出并注明「值已加密存储」
    （读只读标记 `headersSet`，§1.1），留空 = 不改动已有值，删除某一行 = 删除该头。
    字段与凭据链路见 §1 / §1.1，传输侧行为见 06 §7。
- **电脑操控**（`agent.tools.*`，v0.7.0）：目标 6 页 IA 下并入「智能与工具」页（`agent`，
  与技能、MCP 区组同页折叠；v8 前为「AI 能力」组独立页）。页面提供电脑操控工具的开关与上限：「总开关」、「工作目录」、
  终端（开关 / 超时 ms / 输出字符上限 / **免确认命令模式列表**）、文件（开关 / 单次读取字节上限）、
  **文件检索**（开关 / 结果条数上限，`agent.tools.search.*`，v12 新增）、打开（开关）；
  字段路径见 §1，工具能力与安全边界见 06 §11。
  - 终端卡片下新增**「免确认命令模式」列表**（`agent.tools.terminal.allowPatterns`，v12 新增）：
    逐条增删模式（glob 全串匹配、大小写不敏感，语义与非法模式的拒绝规则见 §1 与 06 §11.7），
    默认空列表 = 全部逐次确认；列表为空时是空状态提示，不画一排空行。
    ⚠ **`*` 也匹配 `;` / `&&` / `|` 等命令分隔符**：写 `git status*` 等于放行「以 `git status`
    开头的任意命令串」（`git status; <任意命令>` 一样命中、一样跳过确认卡片），**不是**「收窄到
    `git status` 这一条」；要真正收窄就写完整命令（`git status`）或明确到参数级
    （`git log --oneline *`）。命中免确认 = **放行了整串命令**，详见 06 §11.7。
    它是**只读路径**：AI 的 `set_setting` 读写它一律被拒，只能由用户在这里维护。
  - 新增**「文件检索」栏**（`agent.tools.search.*`，v12 新增）：总开关（`search.enabled`）与
    结果条数上限（`search.maxResults`）两项，控制 `grep` / `glob` 两个只读检索工具是否注册
    与单次返回多少条结果（见 06 §11.5）。
  - 总开关 `agent.tools.enabled` 关闭后 `run_command` / `read_file` / `write_file` / `edit_file` /
    `list_dir` / `open_path` / `grep` / `glob` 以及 Office 工具都不注册（模型看不到它们）；总开关本身**常显**，
    否则关掉就再也无法启用（门控见 §6.1）。
  - 总开关**不是把 AI 锁死**：`set_setting` 仍会注册，AI 仍可（在用户确认后）改 `agent.tools.*`
    把总开关打回来（见 06 §12.6）。`set_setting` 写 `agent.tools.<子字段>` 时
    **以当前分组值为基底深合并**，只覆盖被点名的字段 —— 不会把 `terminal` / `files` / `search` / `open`
    的现有值抹掉。
  - 「工作目录」只是 **`run_command` 的缺省 `cwd`**（也是 `grep` / `glob` 的缺省搜索根，见 06 §11.5），
    **不是沙箱** —— 缺省起点按 06 §5.1 的 `effectiveWorkspaceDir` 回落链：**当前项目根
    （配置了当前项目时）> 「工作目录」> 用户主目录**，「工作目录」为空串且没配当前项目时才落主目录；
    未配置当前项目时与既往行为完全一致。越界不静默，结果里回带真实的绝对路径。
    注意 `read_file` / `write_file` / `edit_file` / `list_dir`
    **不读**该字段（相对路径按主进程 CWD 解析，打包应用该值不可预期，故文件类工具只适合用绝对路径；
    见 06 §11.4）。
  - 敏感工具仍按 `sensitivity` 进入确认链路：`run_command` / `write_file` / `edit_file` /
    `open_path` 为 `confirm`，`read_file` / `list_dir` / `grep` / `glob` 为 `safe`。
    生效后由权限档决定：`auto` 完全权限直接放行；`confirm` 档按旧 auto 的项目边界执行
    （根内直接执行、越界弹卡、无项目直接放行）；命中 `allowPatterns` 的 `run_command`
    在 confirm 档仍免确认（见 06 §11.7）。
- **语音**（`tts.*` / `stt.*`，v0.8.0 起）：目标 6 页 IA 下为「语音」页（`voice`，TTS 区组 + STT 区组；
  v8 前为「AI 能力」组第 2 项、仅 TTS）。TTS 区组提供「总开关」（`tts.enabled`）、「默认 TTS 模型」
  （`tts.active`）、「自动朗读」（`tts.autoRead`）、「截断上限」（`tts.maxChars`），以及 provider 列表的
  **增 / 改 / 删 + 「试听」**（用当前表单值合成一小段试听音频）。字段路径见 §1，请求协议与失败降级见 06 §13。
  - provider 表单与 `llm.providers` **同构但独立**（`type` / `baseUrl` / `apiKey` / `model` /
    `voice` / `speed` / `format`）：两边的列表不共享、不联动，改一边不影响另一边（见 §1）。
    「接口类型」（`tts.providers.<id>.type`）下拉切换两套请求协议：`openai-compat` →
    OpenAI 兼容 `/audio/speech`；`dashscope` → DashScope 原生生成端点（baseURL 提示与
    输出格式说明随类型切换，协议细节见 06 §13.6）；新建草稿默认 `openai-compat`。
  - 凭据沿用 §1.1 的只读标记口径：列表里只显示 `apiKeySet`（`凭据已保存` / `缺少凭据`），
    密文**永不回显**，编辑卡里的 API Key 是 write-only 输入，**留空 = 本次不修改**。
  - **「获取模型列表」（编辑卡内，模型名输入框旁）**：调 `tts:listModels`
    （`GET {baseUrl}/models`，端点规整见 06 §13.2），把返回的模型 id 填进模型名输入框的
    datalist 作下拉候选，按钮旁显示「共 n 个」；baseUrl / apiKey 用**编辑中的草稿值**，
    留空则由主进程回落已保存配置与凭据。失败走 toast 提示、**不改任何配置**；
    模型名始终可直接手填，列表只是候选不是必经步骤。
  - 列表为空时是 `data-empty="tts.providers"` 的**空状态卡**，不画一排空行。
  - **STT 区组（v8 起实装，v24 加「接口协议」）**：「总开关」（`stt.enabled`）、「默认 STT 模型」
    （`stt.active`）与 provider 列表增 / 改 / 删（表单 `type` / `baseUrl` / `apiKey` / `model` / `language`，见 §1）；
    「接口协议」是编辑卡的第一项（`data-field="stt.providers.<id>.type"`），切换后 baseURL / 模型名的
    提示词随协议改写（两套接口的字段语义不同，见 06 §15.1）；两条预设各自带 `type`。
    门控口径同 TTS：未配置时对话窗连麦克风按钮都不渲染（docs/07 §2.3）；
    麦克风（`media`）权限仅对自身窗口放行（主进程 `setPermissionRequestHandler`）。
- **系统**（`advanced`，旧称「高级」）：日志查看与导出、代理设置、日志级别、重置为默认配置。
  目标 6 页 IA 下分组为「网络 / 日志 / 安全 / 危险操作」，勿扰时段控件移至「通用」页
  （全局 + 提示条两组同区；字段仍是 `advanced.quietHours` / `general.edgeBar.quietHours`）；
  「重置为默认配置」需**就地二次确认**（按钮变为「确认重置？」+ 取消），不再用原生 `confirm`。
  - 实现状态（v0.5.0）：**勿扰时段已实际拦截主动行为**——敏感工具确认在时段内直接拒绝
    （`ProactiveScheduler.isQuietHour`），课前提醒在时段内静默跳过。新增
    「敏感工具确认」开关（`advanced.confirmSensitiveTools`，**默认关闭** —— 2026-09-29 起
    它与默认档 `auto` 镜像）：关闭后敏感工具不再逐次询问（`auto` 档语义：完全权限、
    所有敏感工具直接放行），且**每次调用即时判断**，改设置无需重启。
    用户要在项目边界之外重新逐次确认，就在设置页「智能与工具」或对话窗把档位切回「变更前确认」；
    该档现在恢复旧 auto 语义：项目根内直接执行、越界弹卡，无项目时直接放行。
  - 实现状态（v0.6.0）：**代理与日志级别真正生效**（此前是「存了不生效」的死配置）——
    - `advanced.proxy`：`main/net.ts` 交给 `session.setProxy`，出网改用 Electron `net.fetch`
      （走 Chromium 网络栈 → 自动遵守代理）并保留 `globalThis.fetch` 回落；
      注入到 LLM provider、MCP HTTP 传输与「测试连接」，**保存后立即生效**（含关闭残留连接）。
      漏写 scheme（如 `127.0.0.1:7890`）会自动补 `http://`；分协议规则（`http=…;https=…`）原样保留。
    - `advanced.logLevel`：`FileLogger` 的级别改为**共享可变引用**，改一次即对整棵日志树
      （含已存在的子 logger）生效。此前是构造期快照，改级别只影响之后新建的 logger。
    - 另：「日志查看」走 `app:openLogs`（该通道此前只有常量与 preload 镜像、没有 handler，
      调用会挂起，v0.6.0 补齐）。

### 6.1 按条件显示的设置项（前端刷新轮）

每个控件带 `data-field="<配置路径>"`（与 §1 Schema 路径一致），**条件不成立时控件不存在于 DOM**
（不是 `disabled`、也不是 `opacity: 0`），原位置改为一段 `data-empty="<路径>"` 说明。
门控矩阵：

| 设置项（`data-field` 前缀）                                                                   | 显示条件                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `modes.classroom.*`                                                                           | `modes.current === 'classroom'`                                                                                                                                    |
| `modes.work.workspaceDir`                                                                     | `modes.current === 'work'`（v8 起 Work 区组有字段，与 ClassRoom 区组同口径；`data-empty="modes.work"` 空状态随之取消）                                             |
| `modes.code.*`                                                                                | 无字段：Code 选中时只显示「暂无可配置项」空状态（`data-empty="modes.code"`）                                                                                       |
| `modes.classroom.schedule.classisland.*`                                                      | `schedule.provider === 'classisland'`                                                                                                                              |
| `modes.classroom.preClassReminder`                                                            | `schedule.lessons.length > 0`                                                                                                                                      |
| `modes.classroom.preClassLeadMinutes`                                                         | 与 `preClassReminder` 同组同条件（`schedule.lessons.length > 0`；v10 新增）                                                                                        |
| `modes.classroom.preClassOpenFolder`                                                          | 与 `preClassReminder` 同组同条件（`schedule.lessons.length > 0`；v8 新增）                                                                                         |
| `modes.classroom.classification.confidenceThreshold`                                          | `subjects.length > 0`                                                                                                                                              |
| `modes.classroom.classification.fallbackFolder`                                               | `classification.autoMove === true`                                                                                                                                 |
| `general.edgeBar.opacity` / `general.edgeBar.quietHours.*`                                    | `general.edgeBar.enabled === true`（`enabled` 开关本身常显，否则无法重新启用）                                                                                     |
| `general.language`                                                                            | **永不显示**（无 i18n 消费方的死字段，字段保留在 Schema 仅为配置兼容）                                                                                             |
| `skills.disabled`                                                                             | `skills.list()` 非空                                                                                                                                               |
| `mcp.servers.*` / `mcp.lazyConnect`                                                           | `mcp.servers.length > 0`                                                                                                                                           |
| `llm.providers.*`（含 `modelList` 与 `modelParams.<modelId>.*`）                              | `llm.providers` 至少一项                                                                                                                                           |
| `agent.tools.enabled`                                                                         | 常显（否则无法重新启用）                                                                                                                                           |
| `agent.tools.workspaceDir`                                                                    | 常显（总开关关着时也要能改默认工作目录）                                                                                                                           |
| `agent.tools.terminal.*`（含只读的 `allowPatterns`）/ `files.*` / `search.*` / `open.enabled` | `agent.tools.enabled === true`                                                                                                                                     |
| `tts.enabled`                                                                                 | 常显（否则无法重新启用）                                                                                                                                           |
| `tts.providers.*`                                                                             | `tts.providers` 至少一项，否则整块换成 `data-empty="tts.providers"`                                                                                                |
| `tts.autoRead` / `tts.maxChars`                                                               | `tts.providers` 至少一项（没有 provider 时朗读无从发生）                                                                                                           |
| `stt.enabled`                                                                                 | 常显（否则无法重新启用；v8 新增，目标口径）                                                                                                                        |
| `stt.providers.*`                                                                             | `stt.providers` 至少一项，否则整块换成 `data-empty="stt.providers"`                                                                                                |
| `imagegen.enabled`                                                                            | 常显（否则无法重新启用；v8 新增，目标口径）                                                                                                                        |
| `imagegen.providers.*`                                                                        | `imagegen.providers` 至少一项，否则整块换成 `data-empty="imagegen.providers"`                                                                                      |
| `general.chat.showThinking`                                                                   | 常显（「AI 模型」页）                                                                                                                                              |
| `projects.*`                                                                                  | 常显（否则用户无法添加第一个项目；v13 新增）。`projects.list` 为空时列表区换成 `data-empty="projects.list"` 空状态（「尚未添加项目」），「添加项目」按钮**始终在** |
| `agent.permissionMode`                                                                        | 常显（权限档位必须随时能改回来；v13 新增）                                                                                                                         |
| `agent.snapshots.*`                                                                           | 常显（`enabled` 必须随时能改回来；v14 新增）。关掉 `enabled` 时三个数字字段整块换成 `data-empty="agent.snapshots"`                                                 |
| `agent.loop.*`                                                                                | 常显（**不跟 `agent.tools.enabled` 门控**：它管的是"一次请求怎么停下来"，不是"注册哪些工具"；v15 新增）。三个字段一次到位、没有空态                                |
| `automations.enabled`                                                                         | 常显（总开关关掉必须还能开回来；v19 新增）。所在区组在「模式」页顶部，**不跟模式门控**                                                                             |
| `general.requireAdmin`                                                                        | 常显（「常规」页「启动」区组；v20 新增）。被删掉 / 改名时 capture 的 general 页探针立刻报 FAIL                                                                     |

校验方式（不是靠"看代码应该有 `v-if`"）：`AURORA_CAPTURE` 的 DOM 探针按页断言——
`settings?page=general` 要求 `general.language` 计数为 0、`general.edgeBar.enabled` 存在且详情项 > 0、
**`general.requireAdmin` 恰好 1 个**（v20 新增：它是常显字段，数到 0 就说明「启动」区组里的
提权开关被删掉 / 改名了），
且**项目区组要么给出 `data-empty="projects.list"`、要么至少渲染一行 `projects.name`**
（v13 新增；探针只断言「空态或 ≥ 1 行」，不写死条数 —— 用户有几个项目都能过），
本页除 `general.edgeBar` 与 `projects.list` 之外的 `data-empty` 一律视为回归；
`settings?page=modes` 在 ClassRoom 下必须能数到 `modes.classroom.*` 字段（具体条数随科目数与展开分组变化，
探针只断言 `> 0` 与「切走必须为 0」），切到 Work 后 classroom 字段必须为 0，且出现 Work 区组的
`modes.work.workspaceDir`（v8 起 Work 有可配置字段，`data-empty="modes.work"` 空状态随之取消；
探针断言由 capture 适配任务同步更新）；另断言 `automations.enabled` **恰好 1 个**（v19 新增：
它是常显字段，数到 0 就说明「自动化」区组整块没渲染）；
`settings?page=agent` 读 `agent.tools.enabled` 复选框的**实际状态**：开着时终端 / 文件 / 检索 / 打开
四栏的详情字段都必须存在（且 `data-empty` 为空；**检索栏**（`agent.tools.search.*`）与终端卡片下的
**免确认命令模式**列表（`agent.tools.terminal.allowPatterns`）随 v12 新增，探针条目同步扩展，
**具体计数以 `report.json` 的实际条目为准**），关着时只要求总开关自己还在；
**文件备份区组**（`agent.snapshots.*`，v14 新增）要求"四个字段都在、或给出
`data-empty="agent.snapshots"`"，且该页 `data-empty` 白名单里要放行它（默认开启时不会出现）。
**Agent 循环区组**（`agent.loop.*`，v15 新增）要求 `[data-field^="agent.loop."]` 计数 **≥ 3**
（轮次上限 / token 预算 / 自动续轮三个字段常显，不跟 `agent.tools.enabled` 门控），
且**不为它放行任何 `data-empty`**（它没有空态，多一个就说明门控串了）。
探针结果写 `<目录>/report.json` 并以 `AURORA_SMOKE_RESULT:` 前缀落日志，存在 FAIL 时进程退出码为 2。

## 7. ClassRoom 模式设置页（v0.4.0）

模式为 ClassRoom 时，模式页渲染完整配置区（`renderer/settings/components/ClassroomSection.vue`）：

- **智慧感知文件夹**：输入绝对路径 + 「打开文件夹」（`app:openPath` 的 `watchDir`）。
- **科目列表**：增 / 删 / 改名，每科可配**目标文件夹**与**分类关键词**；
  改科目名会同步改写引用它的课程表条目，删除时提示仍有多少节课引用该科目。
- **课程表**：`schedule.provider`（manual / classisland）+ 课程行
  （星期 0–6 中文、起止 `HH:mm`、科目下拉）。
  - **ClassIsland 联动（v0.6.0）**：选中 `classisland` 时展开子配置 ——
    「数据来源」（JSON 文件 / 本地 HTTP 端点）、「端点 / 文件路径」、
    「读取超时」（毫秒）与「**测试连接**」按钮。
    测试连接会立即按当前配置解析一次，回传**今日课程预览 + 逐行告警 + 错误原因 + 耗时**；
    页面同时显示最近一次同步状态（是否成功、今日课程数、最近同步时间）。
    改动端点或来源时会清空上一次的测试结果，避免把「旧地址的成功状态」误读为当前可用。
  - **提醒通道（v3 新增，05 §3.4）**：同一子配置区新增
    - 「**发送测试提醒**」按钮（`data-field="settings.classisland-notify-test"`）：
      调 `classisland:notify` 发一条固定文案的自定义提醒（`channel: 'custom'`），
      成功 / 失败（含原因与耗时）就地回显；
    - **提醒通道状态回显**：来自 `classisland:status` 的 `notify` 字段
      （`available` / `ok` / `lastAt` / `error`），显示「可用 / 不可用 + 最近一次结果」，
      不可用时提示去桥接插件 README 排障（插件未装 v3 / 端点未配 / 命令通道被关）。
- **课前提醒**：`modes.classroom.preClassReminder` 开关 +「**提前分钟数**」
  （`modes.classroom.preClassLeadMinutes`，数字输入 1–30，默认 5，v10 新增：改完即时生效）
  - 「提醒时自动打开科目文件夹」
    （`modes.classroom.preClassOpenFolder`，v8 新增：通知照发，仅门控打开动作，见 05 §3.3）。
- **分类行为**：`classification.autoMove`（自动移动）、`confidenceThreshold`（0–1 滑条）、
  `fallbackFolder`（兜底目录）。
- **分类流水**：内嵌 `ClassificationLedger`（默认展开，50 条），可就地修正与打开文件夹。

写入统一走 `settings.update({ modes: { ...当前 modes, classroom: { ...当前 classroom, ...补丁 } } })`：
`settings:update` 是**按顶层分组浅合并**，因此必须展开当前分组，否则会丢掉未被提及的子字段。
