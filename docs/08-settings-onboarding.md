# 08 · 设置与首次安装引导

状态：`已定稿`（v1 基线）

## 1. 配置 Schema（config.json，v6）

```jsonc
{
  "version": 6,
  "general": {
    "language": "zh-CN",
    "launchAtLogin": false,
    "hotkey": "Alt+Space",
    "edgeBar": { "enabled": true, "opacity": 0.9, "quietHours": null },
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
        "model": "deepseek-chat",
        "temperature": 0.7,
        "reasoningEffort": "auto"  // auto | low | medium | high；auto = 不下发该参数
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
    "confirmSensitiveTools": true,
    // v6 新增：AI 改配置（set_setting）一律禁止触碰的路径前缀，按路径段匹配，见 06 §12
    "readonlyPrefixes": [
      "llm.providers", "mcp.servers", "version", "general.windowState", "advanced.proxy",
      "general.onboarded", "general.firstRun", "general.launchAtLogin", "general.hotkey"
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
- `advanced.readonlyPrefixes`（**v6 新增**，见 06 §12）：AI 通过 `set_setting` 改配置时
  **一律禁止触碰**的路径前缀，按**路径段**前缀匹配。默认值即 `SETTINGS_READONLY_PREFIXES`：
  `llm.providers`、`mcp.servers`、`version`、`general.windowState`、`advanced.proxy`、
  `general.onboarded`、`general.firstRun`、`general.launchAtLogin`、`general.hotkey`。
  **改它等于改 AI 的可写范围，属于高级用户的逃生阀**：把它清空**不等于**「全部可写」——
  「Schema 不认识的路径一律拒绝」这条兜底永远生效（防模型拼错字段名后悄悄写进配置）。
  `v5 → v6` 迁移会为旧配置补齐这一项，`CONFIG_VERSION` 仍为 **6**（本字段是本轮 v6 内追加的，
  没有另起新版本号）。
- `llm.providers.<id>.reasoningEffort`（v5 新增）：`auto | low | medium | high`，默认 `auto`。
  `auto` 表示请求里**不带 `reasoning_effort` 字段**，用于兼容不认该参数的厂商；
  其余三档按值下发（见 06 §3）。
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
- 迁移：`version` 字段 + `migrations` 链式执行。当前 `CONFIG_VERSION = 6`：
  `v0 → v1`（补齐 version、扁平字段归一、`llm.apiKey → apiKeyEnc`）、
  `v1 → v2`（补齐 `modes.classroom.classification` 与 `advanced.confirmSensitiveTools`）、
  `v2 → v3`（补齐 `modes.classroom.schedule.classisland`）、
  `v3 → v4`（移除 `general.windowState['service-dock']`，AI 悬浮窗已删除）、
  `v4 → v5`（补齐 `llm.providers.*.reasoningEffort` 与 `agent.tools.*`）、
  `v5 → v6`（移除 `general.windowState['mini-chat']`，独立小窗已删除；补齐 `advanced.readonlyPrefixes`）。
  六条迁移都**幂等且不覆盖用户已写入的值**，重复执行结果一致。
- 凭据：`apiKeyEnc` / `envEnc` 用 **safeStorage** 加密后落盘；日志、错误上报、配置导出时一律脱敏（`***`）。

## 3. 首次安装引导流程

```
欢迎（品牌 + 三模式介绍）
  → AI 模型配置【必填】：provider 预设（DeepSeek / OpenAI / 自定义）+ baseURL + API key + 模型名
        → “测试连接”（展示延迟；可选拉取模型列表）
  → 模式选择（ClassRoom 推荐）
  → 模式引导（若选 ClassRoom）：感知文件夹 + 科目列表 → 完成（见 05 §2）
  → 完成页 → 进入托盘常驻，显示提示条
```

> 早期版本的「语言 / 主题」步骤已删除：`general.language` 是死字段（无 i18n 消费方），
> 主题也没有实现，两件都不可配置。详见 §6.1 的门控矩阵。

- **规则**：AI 模型配置未完成不允许进入主界面（需求：第一次安装要求用户填写）；测试连接失败允许先保存，但持续提示未通过。
- 引导可重跑：设置 → 模式 → “重新引导”。
- **实现状态（v0.1.0）**：引导窗共 5 步（欢迎 → AI 模型 → 模式选择 → 模式设置 → 完成），
  其中「模式设置」对 ClassRoom 为表单式（感知文件夹 / 科目列表 / 课前提醒），
  Work / Code 只显示占位说明；「重新引导」会重置 `guideCompleted` 并唤起对话窗口。

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
   - 「模型」分组：候选模型列表的位置（step 5 接入，列表只是候选项，当前用哪个模型仍由「模型名」决定）；
   - `高级参数与连接测试` 折叠区（**默认收起**）：`temperature`、思考等级、`保存并测试连接` /
     `拉取模型列表`、连接延迟与可用模型 chips；
   - 卡底 `应用`（只提交这一张卡，成功回列表态）/ `取消`。
   - 添加流程：预设 chips（DeepSeek / OpenAI / 本地兼容）+ 自定义 id 输入框；重复 id 提示
     `Provider「<id>」已存在`；选中预设**直接进编辑卡**。
5. **删除是危险操作**：点「删除」先就地出现确认条
   （`删除 provider「<id>」？依赖它的会话将无法再请求模型。` + `确认删除` / `取消`），
   确认后才走「删 provider + 清 `apiKey` secret + `llm.active` 置空」。
6. **思考等级**属于 **provider 维度**（`llm.providers.<id>.reasoningEffort`，Schema 就是这么存的），
   所以保留在本页的折叠区里；交互窗另有入口（docs/07 §2.3，读写的是同一个字段）。
7. 保存语义：`settings:update` 只有**顶层浅合并**，因此任何一次保存都必须**原样回传全部 provider
   再覆盖当前一个**；`apiKeyEnc: ''` 对已有 provider 表示「本次不改凭据」（新建时 Schema 要求该字段存在）；
   明文 API Key 只走 `settings:setSecrets`。
8. 支持范围：DeepSeek / OpenAI / 其他 OpenAI 兼容（含 Ollama 本地）；P2 再评估更多协议（Anthropic 等）。
9. 测试连接：展示延迟与可用模型列表（可选拉取）。

## 6. 其他设置页

- **常规**（`general.*`）：开机自启、全局快捷键、提示条（显示 / 透明度 / 独立勿扰时段）均已生效。
  `general.language` 是**未生效的死字段** —— Schema 里保留（避免再动一次配置版本），但**没有 i18n 消费方**，
  改它不会改变界面语言，因此**设置页与引导页都不再显示该选择器**（保存时仍原样回传，配置不丢）。
- **页面骨架**：所有页面统一「标题 + 一句话说明 + 分组卡片」（`theme.css` 的
  `.page` / `.page-title` / `.page-sub` + `settings/settings.css` 的 `.section-card` /
  `.section-title` / `.section-desc` / `.empty-state`）；侧栏按「基础 / AI 能力 / 系统」三组排列。
- **Skill 管理**：内置 Skill 列表 + 用户目录导入 / 添加、启用开关（`skills.disabled`）。
  - 实现状态（v0.6.0）：`skills.userDir` **真正生效**（此前运行时硬编码 `userData/skills`，
    配置项是死字段）。空串回落 `userData/skills`；填自定义目录后保存会**按新目录重扫**。
    页面显示「当前生效目录」与「上次扫描时间」，并提供**真实的**「重新扫描」
    （`skills:rescan`，重扫磁盘而非重新拉取内存清单）；解析失败的技能计入
    `skills:status` 的 `failed` / `warnings` 并在页面提示，不再静默吞掉。
    另：目录切换复用**同一个注册表实例**（`setUserDir` + 重扫）——`use_skill` 工具的闭包
    与提示词组装都持有该实例，换实例会让它们继续指向旧表，表现为「改了目录但模型仍看到旧技能」。
- **MCP 管理**：服务器列表、添加（stdio 命令 / HTTP URL）、连接状态灯、错误日志。
  - 实现状态（v0.3.0）：列表读写与凭据脱敏沿用 v0.1.0；**状态灯**由 `mcp:status` /
    `mcp:statusChanged` 驱动（`ready` / `connecting` / `error` 三态，`error` 时展示
    最近一次失败原因），`lazyConnect` 可在设置页切换（收在「高级」折叠里）。
- **电脑操控**（`agent.tools.*`，v0.7.0）：侧栏「AI 能力」组第 4 项（该组依序为
  `llm` / `skills` / `mcp` / `agent`）。页面提供电脑操控工具的开关与上限：「总开关」、「工作目录」、
  终端（开关 / 超时 ms / 输出字符上限）、文件（开关 / 单次读取字节上限）、打开（开关）；
  字段路径见 §1，工具能力与安全边界见 06 §11。
  - 总开关 `agent.tools.enabled` 关闭后 `run_command` / `read_file` / `write_file` /
    `list_dir` / `open_path` 5 个工具都不注册（模型看不到它们）；总开关本身**常显**，
    否则关掉就再也无法启用（门控见 §6.1）。
  - 「工作目录」为空串时回落用户主目录；它只是 **`run_command` 的缺省 `cwd`**，**不是沙箱** ——
    越界不静默，结果里回带真实的绝对路径。注意 `read_file` / `write_file` / `list_dir` **不读**该字段
    （相对路径按主进程 CWD 解析，打包应用该值不可预期，故文件类工具只适合用绝对路径；见 06 §11.4）。
  - 逐次确认沿用 `sensitivity` 判定：`run_command` / `write_file` / `open_path` 为 `confirm`
    （走 06 §5 的确认链路，勿扰时段或确认超时一律按拒绝），`read_file` / `list_dir` 为 `safe`；
    由 `advanced.confirmSensitiveTools` 统一开关，关闭后敏感工具不再询问（见 §1）。
- **高级**：日志查看与导出、代理设置、日志级别、勿扰时段、重置为默认配置。
  分组为「网络 / 日志 / 勿扰 / 安全 / 危险操作」；「重置为默认配置」需**就地二次确认**
  （按钮变为「确认重置？」+ 取消），不再用原生 `confirm`。
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
| `modes.work.*` / `modes.code.*` | 无字段：对应模式选中时只显示「暂无可配置项」空状态（`data-empty="modes.work"` / `"modes.code"`） |
| `modes.classroom.schedule.classisland.*` | `schedule.provider === 'classisland'` |
| `modes.classroom.preClassReminder` | `schedule.lessons.length > 0` |
| `modes.classroom.classification.confidenceThreshold` | `subjects.length > 0` |
| `modes.classroom.classification.fallbackFolder` | `classification.autoMove === true` |
| `general.edgeBar.opacity` / `general.edgeBar.quietHours.*` | `general.edgeBar.enabled === true`（`enabled` 开关本身常显，否则无法重新启用） |
| `general.language` | **永不显示**（无 i18n 消费方的死字段，字段保留在 Schema 仅为配置兼容） |
| `skills.disabled` | `skills.list()` 非空 |
| `mcp.servers.*` / `mcp.lazyConnect` | `mcp.servers.length > 0` |
| `llm.providers.*`（含 `temperature` / `reasoningEffort`） | `llm.providers` 至少一项 |
| `agent.tools.enabled` | 常显（否则无法重新启用） |
| `agent.tools.workspaceDir` | 常显（总开关关着时也要能改默认工作目录） |
| `agent.tools.terminal.*` / `files.*` / `open.enabled` | `agent.tools.enabled === true` |

校验方式（不是靠"看代码应该有 `v-if`"）：`AURORA_CAPTURE` 的 DOM 探针按页断言——
`settings?page=general` 要求 `general.language` 计数为 0、`general.edgeBar.enabled` 存在且详情项 > 0；
`settings?page=modes` 在 ClassRoom 下必须能数到 `modes.classroom.*` 字段（具体条数随科目数与展开分组变化，
探针只断言 `> 0` 与「切走必须为 0」），切到 Work 后必须为 0 且出现 `data-empty="modes.work"`；
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
- **课前提醒**：`modes.classroom.preClassReminder` 开关。
- **分类行为**：`classification.autoMove`（自动移动）、`confidenceThreshold`（0–1 滑条）、
  `fallbackFolder`（兜底目录）。
- **分类流水**：内嵌 `ClassificationLedger`（默认展开，50 条），可就地修正与打开文件夹。

写入统一走 `settings.update({ modes: { ...当前 modes, classroom: { ...当前 classroom, ...补丁 } } })`：
`settings:update` 是**按顶层分组浅合并**，因此必须展开当前分组，否则会丢掉未被提及的子字段。
