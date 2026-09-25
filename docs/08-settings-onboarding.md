# 08 · 设置与首次安装引导

状态：`已定稿`（v1 基线）

## 1. 配置 Schema（config.json，v8）

```jsonc
{
  "version": 8,
  "general": {
    "language": "zh-CN",
    "launchAtLogin": false,
    "hotkey": "Alt+Space",
    "edgeBar": { "enabled": true, "opacity": 0.9, "quietHours": null },
    // v8 新增：对话窗展示偏好
    "chat": { "showThinking": true }, // 对话界面展示思考过程（MessageList 可折叠思考块的门控，docs/07 §2.3）
    // 各窗口位置 / 尺寸记忆，key 集合见 WINDOW_NAMES（edge-bar / chat / settings / onboarding）
    "windowState": {}
  },
  "llm": {
    "active": "deepseek",
    "providers": {
      "deepseek": {
        "type": "openai-compat",
        "baseUrl": "https://api.deepseek.com",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "deepseek-chat",  // 唯一生效值：请求实际用的模型就是它
        "temperature": 0.7,
        "reasoningEffort": "auto", // auto | low | medium | high；auto = 不下发该参数
        // v6 新增：**候选**模型 id 列表（设置页「模型列表」与对话窗模型选择器共用，见 §5）
        "modelList": ["deepseek-chat", "deepseek-reasoner"]
      }
    }
  },
  "tts": {
    "enabled": true,           // 语音功能总开关；false 时对话窗不显示朗读按钮
    "active": "",              // 默认 TTS provider id；空串 = 未配置（此时对话窗的朗读按钮不出现）
    "autoRead": false,         // 助手回复结束后自动朗读
    "maxChars": 2000,          // 单次朗读的文本上限（50–4096，超出截断）
    "providers": {
      "siliconflow": {
        "type": "openai-compat",
        "baseUrl": "https://api.siliconflow.cn/v1",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "FunAudioLLM/CosyVoice2-0.5B",  // 唯一生效值：合成请求实际用的模型就是它
        "voice": "alex",       // 音色 id，如 alloy / FunAudioLLM/CosyVoice2-0.5B:alex
        "speed": 1,            // 0.25–4
        "format": "mp3"        // mp3 | opus | aac | flac | wav | pcm
      }
    }
  },
  "stt": {
    "enabled": false,          // 语音输入总开关；false 时对话窗连麦克风按钮都不渲染（门控口径同 TTS）
    "active": "",              // 默认 STT provider id；空串 = 未配置（此时麦克风按钮不出现）
    "providers": {
      "openai": {
        "type": "openai-compat",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "whisper-1",  // 唯一生效值：转写请求实际用的模型就是它
        "language": "zh"       // 识别语言（zh / en 等，默认 zh）；空串 = 交给服务端自动检测
      }
    }
  },
  "imagegen": {
    "enabled": false,          // 生图功能总开关
    "active": "",              // 默认生图 provider id；空串 = 未配置
    "providers": {
      "openai": {
        "type": "openai-compat",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnc": "<safeStorage 密文>",
        "model": "dall-e-3",   // 唯一生效值
        "size": "1024x1024"    // 512x512 | 768x768 | 1024x1024 | 1024x1792 | 1792x1024 | auto（auto = 交给服务端决定）
      }
    }
  },
  "modes": {
    "current": "classroom",
    "classroom": {
      "guideCompleted": false,
      "watchDir": "",
      "subjects": [ { "name": "数学", "folder": "分类/数学", "keywords": [] } ],
      "schedule": {
        "provider": "manual",
        "lessons": [],
        // ClassIsland 桥接数据源（docs/05 §3.4 v2）：
        // source = "file"（读 JSON 文件）| "http"（读本机回环端点）；
        // endpoint 为空串表示尚未配置（此时 provider 返回空课表）
        "classisland": { "source": "file", "endpoint": "", "timeoutMs": 3000 }
      },
      "preClassReminder": true,
      // v8 新增：课前提醒触发时是否自动打开科目文件夹（通知照发，仅门控打开动作）
      "preClassOpenFolder": true,
      "classification": {
        "autoMove": true,
        "confidenceThreshold": 0.6,
        "fallbackFolder": "待分类"
      }
    },
    // v8 起 Work 实装：workspaceDir = 办公工作目录，空串 = 未配置（由引导 / 设置页收集）
    "work": { "guideCompleted": false, "workspaceDir": "" },
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
    "confirmSensitiveTools": true,
    // v6 新增：AI 改配置（set_setting）的路径黑名单，按路径段匹配，见 06 §12。
    // 只能在默认项之上追加限制：默认项始终生效，删掉或清空都不能放开（判定的第二道用的是硬编码常量）
    "readonlyPrefixes": [
      "llm.providers", "tts.providers", "stt.providers", "imagegen.providers", "mcp.servers", "version",
      "general.windowState", "advanced.proxy",
      "general.onboarded", "general.firstRun", "general.launchAtLogin", "general.hotkey",
      "advanced.confirmSensitiveTools"
    ]
  },
  "agent": {
    "tools": {
      "enabled": true,          // 电脑操控工具总开关；false 时 5 个工具都不注册
      "workspaceDir": "",       // 工具默认工作目录；空串 = 用户主目录
      "terminal": { "enabled": true, "timeoutMs": 60000, "maxOutputChars": 8000 },
      "files": { "enabled": true, "maxReadBytes": 262144 },
      "open": { "enabled": true }
    }
  }
}
```

- 字段说明：`llm.providers` 支持多组模型配置，`llm.active` 指定默认；`modes.classroom.subjects` 即科目 → 文件夹映射（见 05 §3）；`schedule.provider` 为 `manual | classisland`（见 05 §3.4）。
- `general.windowState` 的 key 集合即 `WINDOW_NAMES`：`edge-bar` / `chat` / `settings` / `onboarding`
  （v4 起移除 `service-dock`、v6 起移除 `mini-chat`，两个窗口均已删除）。
- `general.language` 是**未生效的死字段**（无 i18n 消费方，见 §6.1 门控矩阵），保留仅为避免再动一次配置版本。
- `mcp.lazyConnect`：连接策略（见 06 §7）。`false`（默认）= 启动即连；`true` = 首次使用某个 MCP 工具时才连接。
- MCP 环境变量的**变量名**由 `envEnc` 的键表达，设置页据此展示"已配置的变量名"，
  因此 Schema 不额外维护一份 `env` 列表（避免两处数据不一致）。
- `modes.classroom.classification`（v2 新增，见 05 §3.2）：`autoMove` 关闭时只写分类流水、
  不移动文件；`confidenceThreshold` 是进「待分类」的置信度下限；`fallbackFolder` 是兜底目录
  （相对 `watchDir` 或绝对路径）。
- `advanced.confirmSensitiveTools`（v2 新增）：敏感工具（`sensitivity = 'confirm'`，含全部 MCP 工具
  与 `set_setting`）执行前是否要求用户确认（见 06 §5）。关闭后按 v0.3.0 行为降级为「只记日志留痕、不拦截」。
  **它本身在默认黑名单里**（见下一条）：关闭它等于摘掉敏感工具的确认闸门，属于 AI 自我提权，
  因此只允许用户在设置页手动关（设置页走 `settings:update`，不经过该黑名单）。
- `advanced.readonlyPrefixes`（**v6 新增**，见 06 §12）：AI 通过 `set_setting` 改配置时的路径黑名单，
  按**路径段**前缀匹配。默认值即 `SETTINGS_READONLY_PREFIXES`（覆盖凭据 / 密文、配置版本、
  窗口几何、网络代理、引导与首启标记、开机自启、全局快捷键、敏感工具确认总闸门；**具体条目以该常量为准**）。
  **它只能在默认黑名单之上追加限制，不能放宽 —— 默认项始终生效，无法通过配置放开**：
  判定时先查这个配置项，再**无条件**走 `canWriteSettingPath()`，而后者用的是硬编码的
  `SETTINGS_READONLY_PREFIXES`，**从不读取用户配置**。所以把 `general.hotkey` 从数组里删掉、
  甚至把数组清空，`general.hotkey` 这条路径**仍然被拒**（清空 = 回到默认项，而不是放开）。
  另一条兜底同样不随它变化：「Schema 不认识的路径一律拒绝」，防模型拼错字段名后悄悄写进配置。
  `v5 → v6` 迁移会为旧配置补齐这一项（本字段是在 v6 内追加的，当时没有另起新版本号；
  当前 `CONFIG_VERSION` 已是 **8**，见 §2）。
  **`tts.providers` / `stt.providers` / `imagegen.providers` 含凭据密文**（`apiKeyEnc`），
  同样在默认黑名单里，因此 AI 的 `set_setting` 对它们的任何写入**一律拒绝**。
- `llm.providers.<id>.reasoningEffort`（v5 新增）：`auto | low | medium | high`，默认 `auto`。
  `auto` 表示请求里**不带 `reasoning_effort` 字段**，用于兼容不认该参数的厂商；
  其余三档按值下发（见 06 §3）。它是 **provider 级**字段：作用于该 provider 下的**所有**模型，
  切模型不会切换等级（见 §5 第 6 条与 06 §3 的「已知取舍」）。
- `llm.providers.<id>.modelList`（**v6 新增**，见 §5）：该 provider 下的**候选**模型 id 列表
  （`string[]`，`.default([])`），供设置页「模型列表」编辑区与对话窗模型选择器使用 ——
  两处读写的是**同一份**列表，没有第二份来源。
  它**只作候选**用途：真正生效的仍然是 `llm.providers.<id>.model`（**唯一生效值**），
  往列表里加减模型**不会**改变请求用的模型。
  回落行为：`modelList` 为空（或当前 `model` 不在其中）时，选择器**只显示当前 `model`**
  并标注「（不在列表中）」，**不会**悄悄替换成列表里的第一个模型；对话窗同样显示为
  `<model>（不在列表中）`。`v5 → v6` 迁移会为旧配置的每个 provider 补齐 `modelList: []`
  （已存在的值不动；本字段是在 v6 内追加的，当时没有另起新版本号）。
- `tts`（**v7 新增**，见 06 §13）：**语音输出（TTS）**；语音输入（STT）自 **v8** 起见下一条 `stt`。
  `tts.enabled` 是整个语音功能的**总开关**（`false` 时对话窗不显示朗读按钮）；
  `tts.active` 是默认 TTS provider id，**为空串 = 未配置**，此时对话窗的朗读按钮**不出现**；
  `tts.autoRead` 控制助手回复结束后是否自动朗读；`tts.maxChars` 是**单次朗读的截断上限**
  （50–4096，默认 2000，超出部分先截断再送合成）。
  `tts.providers.<id>`（`{ type, baseUrl, apiKeyEnc, model, voice, speed, format }`）与
  `llm.providers.<id>` **结构同构但彼此独立**：两边的 provider 列表不共享、不联动，
  改一边不影响另一边；`apiKeyEnc` 同为 safeStorage 密文（回传口径见 §1.1）。
  `v6 → v7` 迁移会为旧配置补齐 `tts.*`（`fillMissing` 对已存在的值一律保留，因此天然幂等）。
- `WRITABLE_PATH_OVERRIDES`（**v8 新增**，见 06 §12）：AI 的 `set_setting` **显式可写覆盖表**，
  判定**先于** `advanced.readonlyPrefixes` 黑名单前缀。两类登记：
  ① **真的放开** —— `llm.providers.<id>.model / .reasoningEffort / .temperature` 落在 `llm.providers`
  黑名单前缀之内，但「换模型 / 调参数」不碰凭据，显式放行（baseUrl / apiKeyEnc / modelList 等
  其余字段仍被前缀拒绝）；② **显式登记** —— `tts.enabled|active|autoRead|maxChars`、
  `stt.enabled|active`、`imagegen.enabled|active`、`general.edgeBar.enabled|opacity|quietHours`、
  `general.chat.showThinking`、`modes.current`、`modes.work.workspaceDir`、`agent.tools.*`、
  `skills.userDir|disabled`、`advanced.quietHours` 等本就可写的路径逐条入表
  （供 `set_setting` 工具描述与审计使用，也防未来误加前缀时静默收窄）。
  注意 `advanced.confirmSensitiveTools` 总闸门**不在**表内，仍只读（防 AI 自我提权）。
  **具体条目以该常量为准**。
- `stt`（**v8 新增**）：**语音输入（STT，录音 → 文本）**，与 `tts` **同构但独立** ——
  语音输入与语音输出的可用性互不绑定，共用一份配置会让「换朗读服务」顺手把转写弄坏。
  `stt.enabled` 是总开关（`false` 时对话窗连麦克风按钮都不渲染，门控口径同 TTS，docs/07 §2.3）；
  `stt.active` 是默认 STT provider id，**空串 = 未配置**（麦克风按钮同样不出现）。
  `stt.providers.<id>`（`{ type, baseUrl, apiKeyEnc, model, language }`）：`apiKeyEnc` 为 safeStorage
  密文（回传口径见 §1.1）；`language` 是识别语言（如 `zh` / `en`，默认 `zh`，空串 = 交给服务端自动检测）。
  **Agent 写权限**：`stt.enabled` / `stt.active` 可写（显式登记，见上）；
  `stt.providers` 在默认黑名单（凭据），`set_setting` 一律拒绝。
  `v7 → v8` 迁移为旧配置补齐 `stt.*`（默认关闭、无 provider）。
- `imagegen`（**v8 新增**）：**图像生成**，与 `llm.providers` **同构但独立**。
  `imagegen.enabled` / `imagegen.active` 语义同 `stt`（Agent 均可写，显式登记）；
  `imagegen.providers.<id>`（`{ type, baseUrl, apiKeyEnc, model, size }`）：`size` 是生成尺寸白名单
  `512x512 | 768x768 | 1024x1024 | 1024x1792 | 1792x1024 | auto`（默认 `1024x1024`；
  `auto` = 尺寸决定权交给服务端）。`imagegen.providers` 同样在凭据黑名单里（Agent 只读）。
  `v7 → v8` 迁移为旧配置补齐 `imagegen.*`（默认关闭、无 provider）。
- `general.chat.showThinking`（**v8 新增**）：对话界面是否展示思考过程（MessageList 可折叠思考块的
  门控，docs/07 §2.3，默认 `true`）。Agent 可写（显式登记）。设置页入口在「AI 模型」页（见 §5 / §6）。
- `modes.work.workspaceDir`（**v8 新增**）：Work 模式的办公工作目录，空串 = 未配置
  （由引导问答 / 设置页收集）。它与电脑操控工具的 `agent.tools.workspaceDir` **是两个字段**：
  前者是 Work 模式的场景目录，后者只是 `run_command` 的缺省 `cwd`（见 06 §11）。Agent 可写（显式登记）。
- `modes.classroom.preClassOpenFolder`（**v8 新增**，见 05 §3.3）：课前提醒触发时是否自动打开
  科目文件夹（默认 `true`；通知照发，本字段只门控「打开文件夹」动作）。
  `modes.classroom.*` 本就不在黑名单，Agent 可写。
- `agent.tools`（v5 新增，见 06 §11）：4 个开关 + 3 个上限 ——
  `enabled` 是电脑操控工具**总开关**（`false` 时 5 个工具都不注册）；`workspaceDir` 是 **`run_command`
  的缺省 `cwd`**（空串 = 用户主目录，只作**默认值**、不是沙箱；文件类工具不读它，见 06 §11.1）；`terminal.enabled` 开关终端工具、
  `terminal.timeoutMs` 是单次命令超时（毫秒）、`terminal.maxOutputChars` 是回传输出的截断上限；
  `files.enabled` 开关文件读写、`files.maxReadBytes` 是单次读取上限（字节）；
  `open.enabled` 开关「打开路径」工具。
- 新需求字段一律**先更新本文档 Schema**，再加代码。

### 1.1 仅存在于 IPC 层的字段（非持久化）

`settings:get` / `settings:changed` 回传渲染层的对象会在上述 Schema 之外**补充两个只读标记**，
用于让设置页显示"凭据是否已配置"，同时保证密文永不进入渲染进程：

| 字段 | 位置 | 说明 |
|---|---|---|
| `apiKeySet` | `llm.providers.<id>` / `tts.providers.<id>` / `stt.providers.<id>` / `imagegen.providers.<id>` | `true` 表示该 provider 已保存 API Key（`apiKeyEnc` 始终回传空串） |
| `envSet` | `mcp.servers[]` | 已配置的环境变量名列表（`envEnc` 始终回传空对象） |

两者由主进程在回传前计算，不写入 `config.json`，因此不参与版本迁移。

**回传语义（踩过的坑）**：`apiKeyEnc` 恒为空串、`envEnc` 恒为空对象，所以渲染层回传里的
「空」只能被主进程理解为**本次不改凭据**（`applyPatch` 的合并规则，见 06 §12.4）。其中 MCP 的
`envEnc` 是**逐键**合并的：空对象 = 一个键也不改；某个键的值是空串 = 该键保留已有密文
（新增服务器时它是占位，随后由 `settings:setSecrets` 写成真密文）。渲染层**表达不了**
「只删凭据」这种操作：删除单个 MCP 环境变量只能走 `settings:clearSecret`（`envEnc` 的键随之消失）；
MCP 服务器整体删除由 `mcp.servers` 数组的权威语义表达（不在数组里 = 删除），
provider 整体删除由 `llm.removedProviders` 显式声明（§5 第 5 条）——
两种删除的凭据（密文 + 内存明文缓存）都由主进程在删除**成功之后**一并清理。

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
- 迁移：`version` 字段 + `migrations` 链式执行。当前 `CONFIG_VERSION = 8`：
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
  已存在分组只补缺失键、不凭空造出半截对象）。
  八条迁移都**幂等且不覆盖用户已写入的值**，重复执行结果一致。
- 凭据：`apiKeyEnc` / `envEnc` 用 **safeStorage** 加密后落盘；日志、错误上报、配置导出时一律脱敏（`***`）。

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
     - **删除当前使用的那一项不换模型**：`model` 原样保留，只在页面提示「当前模型已不在列表中」，
       改哪个由用户自己决定——与 §1 的回落口径一致，不静默换模型；
     - 「拉取模型列表」把发现到的 id **去重合并**进现有列表（不覆盖已有项），
       结果提示为「已拉取 N 个，列表共 M 个」；
     - 列表为空时是 `data-empty="llm.providers.<id>.modelList"` 的空状态提示块
       （文案：「还没有模型列表：先在下面填一个模型名，或点「拉取模型列表」」）；
     - 与「模型名」的关系：必填区的 `data-field="llm.providers.<id>.model"` 输入框**保留在原位**，
       它是「当前使用模型」的**唯一编辑点**（也是 capture 抓手）；它填的 id 不在列表里时会
       **自动追加进列表**，让两者保持一致且用户看得见发生了什么。
   - `高级参数与连接测试` 折叠区（**默认收起**）：`temperature`、思考等级、`保存并测试连接` /
     `拉取模型列表`、连接延迟与可用模型 chips；
   - 卡底 `应用`（只提交这一张卡，成功回列表态）/ `取消`。
   - 添加流程：预设 chips（DeepSeek / OpenAI / 本地兼容）+ 自定义 id 输入框；重复 id 提示
     `Provider「<id>」已存在`；选中预设**直接进编辑卡**。
   - **模型列表是页与窗的公共数据**：本页维护 `llm.providers.<id>.modelList`，对话窗的「模型」选择器
     从**同一份**列表里选、并把选中项写回 `llm.providers.<id>.model`（docs/07 §2.3）。
     两边不存在各自的副本，因此「模型页改当前模型 → 对话窗选择器跟着变」是必然而非同步逻辑。
5. **删除是危险操作**：点「删除」先就地出现确认条
   （`删除 provider「<id>」？依赖它的会话将无法再请求模型。` + `确认删除` / `取消`）。
   确认后的 patch 带 `llm.removedProviders: [<id>]` —— `llm.providers` 是 record，
   **缺项表达不了删除**（只回传一份少了它的 `providers` 是合法的局部更新形状，不会删掉它）。
   密文与内存明文缓存在**删除成功之后**由主进程一并清理；删除失败时凭据保持原样。
6. **思考等级**属于 **provider 维度**（`llm.providers.<id>.reasoningEffort`，Schema 就是这么存的），
   所以保留在本页的折叠区里；交互窗另有入口（docs/07 §2.3，读写的是同一个字段）。
   因此它作用于该 provider 下的**所有**模型 —— 在对话窗切模型**不会**切换思考等级，
   这是**已知取舍**；将来若要按模型区分，需要把它扩展成模型级映射（见 06 §3）。
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

## 6. 其他设置页

- **常规**（`general.*`）：开机自启、全局快捷键、提示条（显示 / 透明度 / 独立勿扰时段）均已生效。
  `general.language` 是**未生效的死字段** —— Schema 里保留（避免再动一次配置版本），但**没有 i18n 消费方**，
  改它不会改变界面语言，因此**设置页与引导页都不再显示该选择器**（保存时仍原样回传，配置不丢）。
- **页面骨架**：所有页面统一「标题 + 一句话说明 + 分组卡片」（`theme.css` 的
  `.page` / `.page-title` / `.page-sub` + `settings/settings.css` 的 `.section-card` /
  `.section-title` / `.section-desc` / `.empty-state`）；侧栏按「基础 / AI 能力 / 系统」三组排列。
- **页面结构（v8 目标口径，UI 由另一任务实施，本节为目标 IA）**：设置页由 8 页并为 **6 页**
  （`SETTINGS_PAGE_IDS = ['general', 'modes', 'llm', 'voice', 'agent', 'advanced']`），侧栏仍三组排列：
  - **基础**：`general` 通用（启动与快捷键 / 提示条 / 勿扰时段——全局 + 提示条两组同区 / 关于与更新）、
    `modes` 模式（模式卡 + ClassRoom 区组 + Work 区组，见 §7）；
  - **AI 能力**：`llm` AI 模型（provider 管理 + 「显示思考过程」开关 + 生图模型区组，见 §5）、
    `voice` 语音（TTS 区组 + STT 区组）、
    `agent` 智能与工具（`agent.tools` 区组 + 技能区组 + MCP 区组，三组同页折叠）；
  - **系统**：`advanced` 系统（网络 / 日志 / 安全 / 危险操作）。
  - 旧页深链兼容映射：`?page=tts` → `voice`、`?page=skills|mcp` → `agent`；
    `general` / `modes` / `llm` / `advanced` 页 id 不变，旧深链继续可用。
- **Skill 管理**（目标 6 页 IA 下为「智能与工具」页的技能区组）：内置 Skill 列表 + 用户目录导入 / 添加、启用开关（`skills.disabled`）。
  - 实现状态（v0.6.0）：`skills.userDir` **真正生效**（此前运行时硬编码 `userData/skills`，
    配置项是死字段）。空串回落 `userData/skills`；填自定义目录后保存会**按新目录重扫**。
    页面显示「当前生效目录」与「上次扫描时间」，并提供**真实的**「重新扫描」
    （`skills:rescan`，重扫磁盘而非重新拉取内存清单）；解析失败的技能计入
    `skills:status` 的 `failed` / `warnings` 并在页面提示，不再静默吞掉。
    另：目录切换复用**同一个注册表实例**（`setUserDir` + 重扫）——`use_skill` 工具的闭包
    与提示词组装都持有该实例，换实例会让它们继续指向旧表，表现为「改了目录但模型仍看到旧技能」。
- **MCP 管理**（目标 6 页 IA 下为「智能与工具」页的 MCP 区组）：服务器列表、添加（stdio 命令 / HTTP URL）、连接状态灯、错误日志。
  - 实现状态（v0.3.0）：列表读写与凭据脱敏沿用 v0.1.0；**状态灯**由 `mcp:status` /
    `mcp:statusChanged` 驱动（`ready` / `connecting` / `error` 三态，`error` 时展示
    最近一次失败原因），`lazyConnect` 可在设置页切换（收在「高级」折叠里）。
  - 凭据保真（本轮修）：列表里「环境变量：…（值已加密存储）」读的是主进程补的**只读标记**
    `envSet`（§1.1），不是永远为空对象的 `envEnc`；任何一次保存（添加 / 停用 / 删除）回传的
    空 `envEnc` 都按「本次不改凭据」处理，不再清掉磁盘上的密文。
- **电脑操控**（`agent.tools.*`，v0.7.0）：目标 6 页 IA 下并入「智能与工具」页（`agent`，
  与技能、MCP 区组同页折叠；v8 前为「AI 能力」组独立页）。页面提供电脑操控工具的开关与上限：「总开关」、「工作目录」、
  终端（开关 / 超时 ms / 输出字符上限）、文件（开关 / 单次读取字节上限）、打开（开关）；
  字段路径见 §1，工具能力与安全边界见 06 §11。
  - 总开关 `agent.tools.enabled` 关闭后 `run_command` / `read_file` / `write_file` /
    `list_dir` / `open_path` 5 个工具都不注册（模型看不到它们）；总开关本身**常显**，
    否则关掉就再也无法启用（门控见 §6.1）。
  - 总开关**不是把 AI 锁死**：`set_setting` 仍会注册，AI 仍可（在用户确认后）改 `agent.tools.*`
    把总开关打回来（见 06 §12.6）。`set_setting` 写 `agent.tools.<子字段>` 时
    **以当前分组值为基底深合并**，只覆盖被点名的字段 —— 不会把 `terminal` / `files` / `open`
    的现有值抹掉。
  - 「工作目录」为空串时回落用户主目录；它只是 **`run_command` 的缺省 `cwd`**，**不是沙箱** ——
    越界不静默，结果里回带真实的绝对路径。注意 `read_file` / `write_file` / `list_dir` **不读**该字段
    （相对路径按主进程 CWD 解析，打包应用该值不可预期，故文件类工具只适合用绝对路径；见 06 §11.4）。
  - 逐次确认沿用 `sensitivity` 判定：`run_command` / `write_file` / `open_path` 为 `confirm`
    （走 06 §5 的确认链路，勿扰时段或确认超时一律按拒绝），`read_file` / `list_dir` 为 `safe`；
    由 `advanced.confirmSensitiveTools` 统一开关，关闭后敏感工具不再询问（见 §1）。
- **语音**（`tts.*` / `stt.*`，v0.8.0 起）：目标 6 页 IA 下为「语音」页（`voice`，TTS 区组 + STT 区组；
  v8 前为「AI 能力」组第 2 项、仅 TTS）。TTS 区组提供「总开关」（`tts.enabled`）、「默认 TTS 模型」
  （`tts.active`）、「自动朗读」（`tts.autoRead`）、「截断上限」（`tts.maxChars`），以及 provider 列表的
  **增 / 改 / 删 + 「试听」**（用当前表单值合成一小段试听音频）。字段路径见 §1，请求协议与失败降级见 06 §13。
  - provider 表单与 `llm.providers` **同构但独立**（`baseUrl` / `apiKey` / `model` / `voice` / `speed` / `format`）：
    两边的列表不共享、不联动，改一边不影响另一边（见 §1）。
  - 凭据沿用 §1.1 的只读标记口径：列表里只显示 `apiKeySet`（`凭据已保存` / `缺少凭据`），
    密文**永不回显**，编辑卡里的 API Key 是 write-only 输入，**留空 = 本次不修改**。
  - 列表为空时是 `data-empty="tts.providers"` 的**空状态卡**，不画一排空行。
  - **STT 区组（v8 目标口径，UI 由另一任务实施）**：「总开关」（`stt.enabled`）、「默认 STT 模型」
    （`stt.active`）与 provider 列表增 / 改 / 删（表单 `baseUrl` / `apiKey` / `model` / `language`，见 §1）。
    门控口径同 TTS：未配置时对话窗连麦克风按钮都不渲染（docs/07 §2.3）；
    麦克风（`media`）权限仅对自身窗口放行（主进程 `setPermissionRequestHandler`）。
- **系统**（`advanced`，旧称「高级」）：日志查看与导出、代理设置、日志级别、重置为默认配置。
  目标 6 页 IA 下分组为「网络 / 日志 / 安全 / 危险操作」，勿扰时段控件移至「通用」页
  （全局 + 提示条两组同区；字段仍是 `advanced.quietHours` / `general.edgeBar.quietHours`）；
  「重置为默认配置」需**就地二次确认**（按钮变为「确认重置？」+ 取消），不再用原生 `confirm`。
  - 实现状态（v0.5.0）：**勿扰时段已实际拦截主动行为**——敏感工具确认在时段内直接拒绝
    （`ProactiveScheduler.isQuietHour`），课前提醒在时段内静默跳过。新增
    「敏感工具确认」开关（`advanced.confirmSensitiveTools`，默认开启）：关闭后敏感工具
    不再询问用户，降级为「只记日志留痕」，且**每次调用即时判断**，改设置无需重启。
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

| 设置项（`data-field` 前缀） | 显示条件 |
|---|---|
| `modes.classroom.*` | `modes.current === 'classroom'` |
| `modes.work.workspaceDir` | `modes.current === 'work'`（v8 起 Work 区组有字段，与 ClassRoom 区组同口径；`data-empty="modes.work"` 空状态随之取消） |
| `modes.code.*` | 无字段：Code 选中时只显示「暂无可配置项」空状态（`data-empty="modes.code"`） |
| `modes.classroom.schedule.classisland.*` | `schedule.provider === 'classisland'` |
| `modes.classroom.preClassReminder` | `schedule.lessons.length > 0` |
| `modes.classroom.preClassOpenFolder` | 与 `preClassReminder` 同组同条件（`schedule.lessons.length > 0`；v8 新增） |
| `modes.classroom.classification.confidenceThreshold` | `subjects.length > 0` |
| `modes.classroom.classification.fallbackFolder` | `classification.autoMove === true` |
| `general.edgeBar.opacity` / `general.edgeBar.quietHours.*` | `general.edgeBar.enabled === true`（`enabled` 开关本身常显，否则无法重新启用） |
| `general.language` | **永不显示**（无 i18n 消费方的死字段，字段保留在 Schema 仅为配置兼容） |
| `skills.disabled` | `skills.list()` 非空 |
| `mcp.servers.*` / `mcp.lazyConnect` | `mcp.servers.length > 0` |
| `llm.providers.*`（含 `temperature` / `reasoningEffort` / `modelList`） | `llm.providers` 至少一项 |
| `agent.tools.enabled` | 常显（否则无法重新启用） |
| `agent.tools.workspaceDir` | 常显（总开关关着时也要能改默认工作目录） |
| `agent.tools.terminal.*` / `files.*` / `open.enabled` | `agent.tools.enabled === true` |
| `tts.enabled` | 常显（否则无法重新启用） |
| `tts.providers.*` | `tts.providers` 至少一项，否则整块换成 `data-empty="tts.providers"` |
| `tts.autoRead` / `tts.maxChars` | `tts.providers` 至少一项（没有 provider 时朗读无从发生） |
| `stt.enabled` | 常显（否则无法重新启用；v8 新增，目标口径） |
| `stt.providers.*` | `stt.providers` 至少一项，否则整块换成 `data-empty="stt.providers"` |
| `imagegen.enabled` | 常显（否则无法重新启用；v8 新增，目标口径） |
| `imagegen.providers.*` | `imagegen.providers` 至少一项，否则整块换成 `data-empty="imagegen.providers"` |
| `general.chat.showThinking` | 常显（「AI 模型」页） |

校验方式（不是靠"看代码应该有 `v-if`"）：`AURORA_CAPTURE` 的 DOM 探针按页断言——
`settings?page=general` 要求 `general.language` 计数为 0、`general.edgeBar.enabled` 存在且详情项 > 0；
`settings?page=modes` 在 ClassRoom 下必须能数到 `modes.classroom.*` 字段（具体条数随科目数与展开分组变化，
探针只断言 `> 0` 与「切走必须为 0」），切到 Work 后 classroom 字段必须为 0，且出现 Work 区组的
`modes.work.workspaceDir`（v8 起 Work 有可配置字段，`data-empty="modes.work"` 空状态随之取消；
探针断言由 capture 适配任务同步更新）；
`settings?page=agent` 读 `agent.tools.enabled` 复选框的**实际状态**：开着时终端 / 文件 / 打开三栏的
详情字段都必须存在（且 `data-empty` 为空），关着时只要求总开关自己还在。
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
- **课前提醒**：`modes.classroom.preClassReminder` 开关 + 「提醒时自动打开科目文件夹」
  （`modes.classroom.preClassOpenFolder`，v8 新增：通知照发，仅门控打开动作，见 05 §3.3）。
- **分类行为**：`classification.autoMove`（自动移动）、`confidenceThreshold`（0–1 滑条）、
  `fallbackFolder`（兜底目录）。
- **分类流水**：内嵌 `ClassificationLedger`（默认展开，50 条），可就地修正与打开文件夹。

写入统一走 `settings.update({ modes: { ...当前 modes, classroom: { ...当前 classroom, ...补丁 } } })`：
`settings:update` 是**按顶层分组浅合并**，因此必须展开当前分组，否则会丢掉未被提及的子字段。
