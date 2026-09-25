# Aurora 项目文档

> **Aurora** —— 将 Windows 接入 AI 生态的系统级 Agent 工具，为用户提供无感的、自主的 AI 服务。

本目录存放 Aurora 项目的规划与设计文档，作为开发的**单一事实来源（SSOT）**。
需求源头为仓库根目录的 [`Aurora.md`](../Aurora.md)；代码结构、接口与交互以实现前的最新文档为准，如需偏离，先改文档再改代码。

## 当前实现状态

**v0.6.0**：P0（脚手架）、P1（基础壳与设置，含首次引导）、P2（四种窗口外壳）、
**P3（Agent 内核：真实对话、会话持久化、工具调用循环、Skill、MCP）**、
**P4（模式系统 + ClassRoom Mode：智慧感知文件夹自动分类、分类流水与就地修正、规则缓存）**、
**P5（系统感知与主动引导：前台窗口 / 显示器 / 课程表采集、课前提醒、敏感工具确认）** 均已完成；
**P6 打包与自动更新已完成**（NSIS 安装包 + 公开 releases 仓库 + electron-updater，见 [09](./09-packaging-release.md)）。

**v0.6.0 本轮新增**：

- **ClassIsland 联动**（原 P7 项提前落地）：`schedule.provider = classisland` 从占位改为真实实现 ——
  读桥接插件写出的本地 JSON（或本机回环端点），感知摘要 / 课前提醒 / `timetable` Skill
  三条消费链零改动复用；随仓库附带桥接插件源码（[`integrations/classisland-bridge`](../integrations/classisland-bridge/)）。
  配置 Schema 升到 **v3**（新增 `modes.classroom.schedule.classisland`，走迁移链）。
- **接线修复**——清掉「设置里能改、运行时没有消费方」的假开关：
  `general.hotkey` 真的注册全局快捷键（含冲突检测与状态回显）、
  `advanced.proxy` 真的接入模型 / MCP / 连接测试的网络栈、
  `advanced.logLevel` 支持热更新（含已存在的子 logger）、
  `skills.userDir` 生效（含重扫与扫描状态）、
  `general.edgeBar.opacity` 与 `general.edgeBar.quietHours` 生效、
  `app:openLogs` 死通道补齐 handler。
- **体验补齐**：对话窗多会话列表与切换、附件拖拽发送（复用现有内容提取）、
  `autoMove=false` 时按 `(路径, 大小, 修改时间)` 去重、长上下文自动摘要压缩（失败退回纯截断）。
- **文档**：新增 [10 用户手册](./10-user-guide.md) 与 [11 隐私说明](./11-privacy.md)。

**v0.7.0 本轮新增**：

- **模型思考等级**：设置页「AI 模型」每个 provider 的「高级参数与连接测试」新增「思考等级」
  （`auto` / `low` / `medium` / `high`），端到端下发为请求体的 `reasoning_effort`；
  `auto`（默认）= **不下发该字段**，以兼容不认该参数的厂商。配置在
  `llm.providers.<id>.reasoningEffort`。
- **终端与文件操控工具**（内核第一次具备真实操作本机的能力，配置在 `agent.tools.*`）：
  `run_command`（PowerShell，confirm）、`read_file`（safe）、`write_file`（confirm）、
  `list_dir`（safe）、`open_path`（用系统默认程序打开，confirm）。真实系统调用全在主进程实现，
  内核只认注入的端口；超时按**进程树**终止；输出 head 60% + tail 40% 截断；**不做命令黑名单**。
- **「电脑操控」设置页 + 全套安全边界**：侧栏第 7 项；总开关 / 工作目录 / 终端 / 文件 / 打开
  分开关，改完**立即生效**（无需重启）；敏感工具逐次确认（60s 不响应 / 勿扰时段按拒绝）；
  关闭「敏感工具确认」后不再逐次询问（能力等同用户自己敲同样的命令）。配置 Schema 升到 **v5**
  （`v4 → v5` 迁移补齐新字段，幂等且不覆盖用户已写值）。关键字段：`agent.tools.enabled`、
  `agent.tools.workspaceDir`、`agent.tools.terminal.{enabled,timeoutMs,maxOutputChars}`、
  `agent.tools.files.{enabled,maxReadBytes}`、`agent.tools.open.enabled`。
- **语音合成朗读（TTS）**：助手消息下方新增「朗读」按钮（播完/停止自动复位），设置页新增
  **「语音」页**（侧栏「AI 能力」组第 2 项）可添加 / 编辑 / 删除任意 **OpenAI 兼容**的
  TTS 服务，支持「自动朗读新回复」与单次字数上限。合成在**主进程**完成
  （`POST <baseUrl>/audio/speech`，走 `main/net.ts` 的 `netFetch` 以受系统代理影响），
  音频以 base64 过 IPC、渲染层转 Blob 播放；**渲染层与日志永远看不到明文密钥**。
  配置 Schema 升到 **v7**（新增 `tts.*` 段，`v6 → v7` 迁移幂等补齐、不覆盖用户已写值）。
  关键字段：`tts.enabled`、`tts.active`、`tts.autoRead`、`tts.maxChars`、
  `tts.providers.<id>.{baseUrl,model,voice,speed,format}`（凭据密文在 `apiKeyEnc`）。
  详见 [06-agent-core.md §13](./06-agent-core.md)、[08-settings-onboarding.md §6](./08-settings-onboarding.md)。
  **语音输入（STT）不在本轮范围**。

**v0.1.0（ClassIsland v3 + 对话展示 + 子代理页 + 动效/图标轮）本轮新增**：

- **ClassIsland 联动升级 v3（双向）**：桥接插件 v2 的「课堂状态快照」补齐起止时间
  （`currentStartTime` / `currentEndTime` / `nextEndTime`，状态版本 3），并新增**入站提醒命令通道**
  （文件模式写 `command.json` + 轮询 `command-result.json`，HTTP 模式 `POST /notify`，
  按 id 去重 + 过期保护），Aurora 因此可以调用 ClassIsland 的提醒功能。
  Aurora 侧：新增 IPC `classisland:notify`、Agent 工具 **`classisland_remind`**（桥接未配置时不注册）、
  设置页「发送测试提醒」；**课堂状态进感知摘要**（`PerceptionSummary.classStatus` +
  `contextSummary()` 的「课堂状态」行）与主界面右栏「课堂状态」卡实时显示当前 / 下节课；
  **课前提前分钟数可配**（`modes.classroom.preClassLeadMinutes`，Schema **v10**）。
  插件 v3 已**真机部署并实跑验证**（加载、状态 v3、提醒弹出、解析对拍）。详见
  [05 §3.4](./05-mode-system.md)、[06 §8.2 / §9.1](./06-agent-core.md)、
  [07 §2.3 / §2.5](./07-ui-spec.md)、[08 §1](./08-settings-onboarding.md)。
- **对话展示的「顺序」修复**（docs/06 §16.1）：`AgentEvent` 新增 `seq`（会话内单调序号）与
  `round`（工具调用轮次）——修掉「工具卡挂错消息 / 跑到列表末尾」「多轮时第二条回复带上一轮
  思考全文」「请求结束后界面继续长内容」三类真实错乱，并让历史水合改为按 id 合并（不再整体替换）。
- **子代理独立页面**（docs/06 §19.1、docs/07 §2.4）：`task` 子代理的每一步进度经
  `ToolContext.emitProgress` 实时上报（新事件 `subagent`），左栏固定项「子代理」把主区切到
  集中页面（状态 / 耗时 / 步骤时间线 / 报告，重启后仍可回看）；工具卡展开体同步显示运行轨迹。
- **动效与图标体系**（docs/07 §2.3 / §5.2）：思考块流式扫光与尾部光标、工具卡运行扫光与
  完成弹跳 / 入场上浮错开、Agent 正文的「湿润边缘」；循环类动画改用
  `--dur-spin` / `--dur-caret` / `--dur-bounce` 令牌；
  **渲染层图标统一换成 [lucide](https://lucide.dev)**（`renderer/shared/icons.ts` 具名再导出，
  工具卡按工具名给语义图标），不再手写内联 SVG。

**v0.0.5（DashScope 原生 TTS 轮）本轮新增**：

- **TTS 供应商新增 `dashscope` 原生类型**（docs/06 §13.6、docs/08 §1 / §6）：`TtsProviderSchema.type`
  增至 `openai-compat | dashscope`（纯增量枚举、无迁移）。走 DashScope 原生非实时协议：
  `POST <base>/services/aigc/multimodal-generation/generation` → 取 `output.audio.url`
  （24h 签名地址）→ 二次 GET 下载（**不带鉴权头**、独立超时预算）；mimeType 按下载响应
  `content-type` → URL 扩展名 → 配置格式三级推导。设置页编辑卡新增「接口类型」下拉，
  baseURL / 输出格式 / 语速提示随类型切换（dashscope 无语速参数、明示不发送）。
- **dashscope baseUrl 规整**：剥误填端点尾巴（复用 §13.2 同套规则）后，裸域名补 `/api/v1`、
  以 `/api` 结尾补 `/v1`（千问AI平台网关漏写 `/v1` 的高频 404 直接根治）。
- **模型列表适配**：DashScope 原生 `/models` 是 `output.models[]`（id 字段为 `model`）且
  **分页**（qianwenai 实测 518 个模型）——按 `output.total` 翻页拉全（页数封顶 6、空页 /
  无新增即停），与 OpenAI `data[].id` 共用同一防御式解析器。
- **错误文案按类型区分**：404 提示按 provider type 取词（dashscope 提示 /api/v1）；
  识别 DashScope 式 400 `url error`（模型不属于该端点族，如 WebSocket 实时专用模型），
  提示更换模型；`output.audio.url` 的签名参数值脱敏后才进错误文案。
- **千问AI平台（maas.qianwenaiapi.com）真实网关端到端实测**：`qwen-tts` / `qwen3-tts-flash`
  合成成功（200 → 下载 WAV）；`qwen-audio-3.x-tts-*` / CosyVoice / Sambert 系列在该网关
  只走 WebSocket 实时，HTTP 一律 400 `url error`；`qwen-tts` 只认内置音色，声音复刻 id
  不被接受；网关忽略 `audio.format` 恒回 WAV。
- **其它**：修复 10 个文件的 Prettier 格式漂移（CI 首步 `format:check` 恢复全绿）。

**v0.0.4（体验修复轮）本轮新增**：

- **TTS 语音 404 根治 + 「获取模型列表」**（docs/06 §13.2、docs/08 §6）：`speechEndpoint`
  规整——剥掉误填的端点尾巴（`/chat/completions` 等）、只填域名时按 OpenAI 惯例自动补
  `/v1`、带自定义路径尊重不动，修掉「baseUrl 漏 /v1 即 404」；404 文案带**实际请求的完整
  URL** 与排查建议；新增 `tts:listModels` 全链路（`GET {baseUrl}/models`，走 `netFetch`
  受代理影响），设置页模型名输入框挂 datalist 直接下拉选择，手填仍可用。
- **提示条快速对话实时刷新与 5 分钟滑动上下文**（docs/06 §4、docs/07 §2.2）：面板展开即
  强制重拉最近 20 条并贴底，展开期间每 5 分钟自动刷新（流式中跳过）；新增 `user-message`
  事件广播，主界面的提问实时同步到提示条（渲染层按 30s 内同文本去重）；quick 会话上下文
  滑动窗口 5 分钟（装配层 `quickContextWindowMs`），窗外消息不进 LLM、不再注入滚动摘要——
  旧上下文不再污染快速对话；修主界面二次进入同一会话显示空列表的 bug。
- **设置「智能与工具」页信息架构收拢**（docs/07 §2.5）：技能 / MCP 区组默认收起，组头摘要
  承载状态（「已启用 x / 共 y」「n 台服务器 / m 台启用」）；同一安全告诫收敛为一处；MCP
  启停改 checkbox 与其它区组统一；Toast 归一为页级一处；技能表 6 列 → 4 列；
  capture 探针联动改 async（先展开再计数），PNG 仍拍默认收起态。
- **发布流程**：`scripts/release.mjs` 支持 `--notes-file` 上传详细 Release Notes
  （存档于 [`docs/release-notes/`](./release-notes/)）。

**v0.0.3（前端重构）本轮新增**：

- **主界面 Apple 风格重构**（docs/07 §2.3）：头部精简（清空改图标钮、Windows 式窗口按钮），
  模型 / 思考等级下拉移入 composer 工具行，消息与 composer 收进 860px 居中内容列，
  会话列表单行化（标题 + 相对时间），用户气泡改强调色浅填充。
- **Windows 式窗口按钮**（docs/02 §2.2、docs/07 §2.3/§2.5）：主界面与设置窗新增
  「最小化 / 关闭」（关闭 = 隐藏）；新增 `window:minimize` / `window:toggleMaximize` 通道
  （shared/preload/main 四方同步），chat / settings 显示任务栏图标、可真最小化；
  最大化期间几何不写入 `general.windowState`。`toggleMaximize` 当前无渲染层调用方
  （拖动区双击最大化由 Windows 原生接管），通道预留给 caption 最大化按钮。
- **提示条面板快速对话**（docs/07 §2.2）：面板「最近消息」升级为可直接输入的对话卡
  （数据仍是 `quick` 会话）；窗口 `focusable` 跟随展开 / 收起切换（输入框可拿到键盘焦点），
  打字中移开鼠标不收起、失焦后补收起。
- **Agent 界面可视化**（docs/07 §2.3）：`todo_write` 渲染结构化任务清单卡（状态圈 + 进度）、
  `task` 渲染子代理卡（任务简述 + 可展开指令）；右栏新增「任务清单」卡
  （数据 = 当前会话最后一次 `todo_write`，空清单为合法的「清空提交」）。
- **设置窗**（docs/07 §2.5）：侧栏导航改图标 + 单行文字（去两行说明文案），
  品牌行换 Windows 式窗口按钮。
- capture 探针同步扩展：收起探针改点 caption 关闭钮、面板探针加快速对话输入断言、
  sidebar 探针加 caption / 任务清单卡 / 子代理卡断言，seed 现场含 todo / task 工具调用。

**v0.0.2（Agent 内核强化）本轮新增**：

- **任务清单工具**：`todo_write`（整表替换）/ `todo_read`（docs/06 §18），按会话持久化到
  `userData/todos/`，当前清单注入 systemPrompt（历史被压缩后模型仍能看到任务状态）。
- **子代理工具 `task`**（docs/06 §19）：独立上下文派生（空白历史 + 子人设 + 白名单工具表，
  禁递归、拿不到敏感工具与 MCP 工具），最终报告作为工具结果回填主循环（20k 截断）。
- **系统提示词工程**：小节顺序扩为 10 段，新增「当前任务清单」「工具使用规范」（按注册工具
  条件生成）；`settingsHint` 改走 `KernelAgentHost` 正式通道（`composeModePrompt` 旁路删除）。
- **Skill**：`use_skill` 返回正文附带 `scripts/` 文件清单（「永不自动执行脚本」口径不变）。
- **MCP 强化**（docs/06 §7）：HTTP 传输自定义请求头（`headersEnc`，凭据与 env 同构，设置页
  可编辑）；stdio 意外断开自动重连（指数退避 1s→60s、最多 5 次）；`tools/list` 跟随
  `nextCursor` 自动分页（上限 20 页）。
- 配置 Schema 升到 **v9**（`v8 → v9` 迁移：为每个 MCP 服务器补 `headersEnc: {}`，幂等）。

**v0.0.1（BetaV2）本轮新增**：

- **主界面三栏**：`chat` 窗升级为常驻主界面（默认 **1120×720**、`alwaysOnTop` 关闭），三栏布局
  （左栏品牌 + 新对话 + 会话列表 / 中区对话 / 右栏模式感知上下文栏，两侧均可折叠）；
  **「快速会话」融入左栏**成为固定顶置项，旧的「快速 / 会话」双栏 tab 与历史 sheet 移除；
  右栏按当前模式渲染（classroom：当前 / 下节课 + 今日课程 + 分类流水；work：工作目录卡；
  通用：系统状态卡），非当前模式的功能一律不渲染。
- **Apple HIG 主题**：设计令牌全面转向 Apple 系统色（强调色 `#007AFF` / `#0A84FF` 系），
  **废弃 aurora 双色渐变**，明暗双档底色 / 分层填充按 HIG 重写（CSS 变量名不变，组件零改动跟随）；
  动画扩充：设置页横向切换、侧栏 / 右栏弹簧滑入、思考块 collapse、麦克风录音 pulse、
  模式切换 cross-fade（全部尊重 `prefers-reduced-motion` 全局覆盖）。
- **设置页 8 → 6**：`general / modes / llm / voice / agent / advanced` 六页 IA ——
  TTS 页并入 voice（与 STT 同页）、Skill / MCP 页并入 agent；旧深链 `?page=tts|skills|mcp`
  单向映射到新页，兼容旧链接。
- **Work Mode 初步实装**：guide 两步（工作目录问答 + 确认）+ 办公场景 systemPrompt
  （文档 / 表格 / PPT / PDF 处理，PowerShell COM 自动化 Office）+ `modes.work.workspaceDir`。
- **ClassIsland 桥接 v2**：`schedule.json` 根对象**内嵌可选 `status` 快照**（当前 / 下节课，
  另写同目录 `status.json` 兄弟文件供人工查看），经 `classisland:status` IPC 透出、
  主界面右栏「当前 / 下节课」卡消费；课程切换与课前提醒改经 **ClassIsland 自己的提醒服务**弹出，
  插件 zip 随 release 一并发布；课前提醒新增「自动打开科目文件夹」开关
  （`modes.classroom.preClassOpenFolder`）。
- **Agent 强化**：`set_setting` 可写面扩大（v8 显式可写覆盖表，可切模式 / 改模型参数 / 开关功能组）；
  新工具五件套 `web_fetch` / `clipboard_read` / `clipboard_write` / `notify_user` / `generate_image`
  （不走 `agent.tools.enabled` 门控，敏感项靠逐次确认）；**生图**（`imagegen.*` provider 体系 +
  工具卡图片预览）；**语音输入 STT**（`stt.*`，composer 麦克风按钮，门控口径同 TTS ——
  未配置时连按钮都不渲染）；**思考过程展示**（`reasoning` 流事件 + 持久化 + 可折叠思考块，
  `general.chat.showThinking` 门控）。
- 配置 Schema 升到 **v8**（`v7 → v8` 迁移：新增 `stt.*` / `imagegen.*` / `general.chat.*` /
  `modes.work.workspaceDir` / `preClassOpenFolder`，幂等补默认值、不覆盖用户已写值）。

**v0.1.2 本轮新增：输入框重做 + 正文流式**

> 面向用户的更新说明见 [release-notes/v0.1.2.md](./release-notes/v0.1.2.md)（每个版本一份，随 Release 发布）。

- **正文流式渲染**（[06 §16.2](./06-agent-core.md)）：不再「等模型把这一轮说完才出现回复」——
  `runAgentLoop` 每轮**先领**助手消息 id（`SessionStore.nextMessageId()` + `NewMessage.id`），
  `text` 增量**逐条**转发并带上它，该轮结束时 `append` 沿用**同一个 id**，
  于是"边流边渲染的半成品"与磁盘上的最终消息就是同一条（水合按 id 合并不会把它换掉）。
  思考增量子此轮**同样带 `messageId`**，「正在思考」因此在正文之前就可见
  ——此前纯思考阶段那条消息还没建出来，界面一片空白。
- **token 用量**（06 §16.2）：新增 `AgentEvent 'usage'`（每轮 LLM 调用的
  prompt / completion / total tokens，`promptTokens` 即该轮真实上下文占用）；
  `openai-compat` 流式请求带 `stream_options.include_usage`，**不认该字段的网关**
  （点名 `stream_options` 的 400）会去掉它**重试一次** —— 拿不到用量事小，打不开对话事大。
- **输入框重做**（[07 §2.3「输入框规格」](./07-ui-spec.md)）：textarea 自动增高（1 行起步 /
  200px 上限）、`Enter` 发送 / `Shift + Enter` 换行；工具行 = **权限模式** + 模型 + 思考等级 +
  （右侧）麦克风 + 停止 / 发送；底下是**上下文详解条**。
  - **斜杠命令**（`data-field="chat.slash-menu"`）：`/new` `/clear` `/stop` `/subagents` `/settings`
    + 全部 enabled 的 Skill，分「命令 / 技能」两组；`↑↓` 移动、`Enter` / `Tab` 确认、`Esc` 关闭；
    命令**选中即执行**，技能**只补全**成 `/技能名 `（与内核 `/` 前缀显式调用同一套）。
  - **权限模式**（`data-field="chat.permission"`）：变更前确认 / 完全权限，写
    `advanced.confirmSensitiveTools`（与设置页同一份配置）。切到完全权限是**两段式**
    ——这条路径是唯一能关掉确认闸门的地方，一次误点不该放权；完全权限档用警示色常驻。
  - **上下文详解条**（`data-field="chat.context"`）：`已用 / 窗口 <进度条> <百分比>` + 累计，
    点开是明细（输入 / 输出 / 累计 / 窗口 / 条数 / 字符数 / 模型）；占用 ≥60% 警示色、≥85% 错误色。
    **没有用量数据就如实说「暂无用量数据」**（不拿字符数换算冒充 token），窗口未知只显示分子。
- **思考块动效加强**（07 §2.3）：块内自动翻滚改为 `requestAnimationFrame` 合并 + 手动上滚接管
  （离底 >24px 暂停跟随）；块头加公转指示点与已思考秒数，正文一开始写就把文案翻成「已深度思考」。
- 配置 Schema 升到 **v11**（[08 §2](./08-settings-onboarding.md) `v10 → v11`：为每个已有 provider
  补 `contextWindow: 0`）；设置页「AI 模型」编辑卡的高级参数新增**上下文窗口**
  （`data-field="llm.contextWindow"`，0 = 未知；它是上下文占用比例的**唯一**分母来源，
  刻意不做内置「模型名 → 窗口」对照表）。
- **验证**（全部无头可跑，见 07 §5.3）：
  - `AURORA_CAPTURE` 新增三个探针场景 —— `chat-composer-slash.png`（斜杠浮层 + 权限钮文案 +
    上下文条 + textarea 自动增高 28→170→28px，含 200px 上限）、
    `chat-composer-permission.png`（权限两段式：点一次不写配置）、
    `chat-stream.png`（**DOM 级端到端**：capture 临时竖起本地桩 LLM → 探针经 textarea + 发送键
    真发一条 → 断言助手气泡画出回复、上下文条显示真实 token `128 / 128k`）。
  - `AURORA_SMOKE`（130 条断言）新增四条流式契约断言：正文按**增量**逐条下发（≥2 条 text 事件，
    旧行为只会 1 条）、每条增量**同轮同 id 且等于落盘的助手消息 id**、`usage` 事件下发
    （`promptTokens` 即本轮上下文占用）；桩服务同步补上结束片的 usage，
    否则这条链路在离线自测里永远是盲区。

**本轮（2026-09-26）修复三条对话体验 BUG**

> 面向用户的更新说明在发版时按仓库惯例补一份 `release-notes/vX.md`（本轮默认不动版本号）。

- **深度思考渲染跟上模型输出**（[06 §16.3](./06-agent-core.md)）：三条里最实质的一条。
  根因有二 —— 渲染层 `MessageList` 的 `rendered` computed 展开 `{ ...message }` 时把 `reasoning`
  也读了进去，于是**每条思考增量都让整份对话的 markdown 重解析**（思考根本不需要 markdown）；
  以及全链路零合并（1 个 token = 1 次 `webContents.send`（还广播给所有窗口）= 1 次 Vue flush）。
  修法是三层各管一段：**markdown 结果按消息 `WeakMap` 缓存**、**渲染层按帧合并增量**、
  **主进程 16ms 合并窗口**；顺序与终态不变（非增量事件一律先 flush 再处理）。
  验证靠新增的**爆发探针** `chat-stream-burst.png`（桩服务按 `burst-probe` 标记各发 150 条分片、
  5ms 间隔，另加两轮各 2 万字前文堆量）：**最坏心跳漂移 661ms → 51ms、掉帧 238 → 0**，
  即修复前那种「0.5 秒级冻结」消失。原来的流式探针只发 2 条分片，这条 BUG 在它面前**必然 PASS**，
  所以探针本身就是本轮的一部分。
  **它不证什么**：本机桩侧的发送路径自身要 ~4.9s，因此这条只能证明渲染层不再冻结，
  不能证明「真实模型速度下端到端不再落后」—— 修复后渲染窗口与桩侧发送耗时已同量级，
  瓶颈看起来已移出渲染层，需要另开一条线测（详见 [06 §16.3](./06-agent-core.md)）。
- **对话窗浮层遮挡与动画乱跳**（[07 §2.3 / §5.1 / §5.2](./07-ui-spec.md)）：
  三个输入区浮层原先锚在三个不同元素上、z-index 手写 20/20/30，其中**上下文详解卡锚在工具行下方，
  卡片底边落在工具行内部 —— 把权限 / 模型 / 思考 / 麦克风 / 停止 / 发送整条盖住且不可点**（不是「看起来乱」，是功能被挡）。
  现在三者统一锚在 `.composer-box` 上、共用 `--z-flyout` 层级令牌、互斥打开（开一个自动关其余）、
  都支持点击外部与 `Esc` 关闭。展开收起从固定 `max-height: 70vh` 改成**实测高度**动画
  （内容实际只有 140/220px，固定高会让全部位移挤在时间轴的一小段里）；
  滚动跟随补上 `transitionend` 信号（此前 CSS 过渡期间长出来的高度收不到任何信号，滚动条会停在半路）；
  切会话不再「旧消息留 250ms + 新消息同时进场」导致高度接近翻倍。
- **会话归档**（[06 §4](./06-agent-core.md) / [07 §2.3](./07-ui-spec.md)）：
  会话项 hover 出现「归档」图标钮（单击即归档、**可逆、不弹确认**），归档会话移入左栏底部
  **「已归档 · N」分组**（默认收起）、仍可点开继续对话，主区头部给一条「已归档 + 取消归档」提示。
  归档状态写在**会话文件自身**的 `meta` 里（`SESSION_FILE_VERSION` 1 → 2，读取对 v1 宽容、
  无需迁移脚本），因此**不动 `CONFIG_VERSION`（仍为 11）**、不新增存储面。
  新增 IPC 通道 `chat:archiveSession`。已知边界：`chat:sessions` 没有推送通道，
  归档只在当前窗口即时生效。

鼠标键盘模拟、截图录屏、持久交互式 shell、命令黑名单、Anthropic 等非 OpenAI 兼容协议
**仍属后续范围**。

仍待做：代码签名证书、启动耗时 / 内存优化、Code Mode 功能实现（Work 已于 0.0.1 初步实装）、OCR、多语言。
详见 [04-roadmap.md](./04-roadmap.md) 的阶段状态与「实现说明」。
实际工程结构见根目录 [README.md](../README.md)；端到端验证见 `pnpm verify`、
`pnpm verify:release`、`pnpm verify:update` 与 `AURORA_SMOKE=1 pnpm dev`。

## 文档索引

| 编号 | 文档 | 内容 | 定位 |
|---|---|---|---|
| 01 | [01-overview.md](./01-overview.md) | 项目总览、设计原则、核心概念、范围与非目标、验收标准 | 产品基线 |
| 02 | [02-architecture.md](./02-architecture.md) | 系统架构、进程/窗口模型、模块划分、目录结构、数据流 | 技术基线 |
| 03 | [03-tech-stack.md](./03-tech-stack.md) | 技术选型与决策记录（ADR） | 决策依据 |
| 04 | [04-roadmap.md](./04-roadmap.md) | 实现路径、阶段划分、里程碑、验收标准与风险 | 执行计划 |
| 05 | [05-mode-system.md](./05-mode-system.md) | 模式系统框架、ClassRoom Mode 详细设计、ClassIsland 联动与 Work/Code 接口预留 | 功能设计 |
| 06 | [06-agent-core.md](./06-agent-core.md) | Agent 内核：LLM、会话、工具循环、Skill、MCP、系统感知、主动引导 | 核心设计 |
| 07 | [07-ui-spec.md](./07-ui-spec.md) | 窗口体系（提示条 / 交互窗 / 设置 / 引导）、设计令牌与动效规范 | 界面规格 |
| 08 | [08-settings-onboarding.md](./08-settings-onboarding.md) | 配置 Schema、存储安全、首次安装引导、设置页设计 | 配置设计 |
| 09 | [09-packaging-release.md](./09-packaging-release.md) | 打包（NSIS）、双仓库发布拓扑、自动更新、SmartScreen 说明 | 发布运维 |
| 10 | [10-user-guide.md](./10-user-guide.md) | 用户手册：安装、引导、各窗口、ClassRoom、ClassIsland、代理、排障 | 用户文档 |
| 11 | [11-privacy.md](./11-privacy.md) | 隐私说明：数据位置、凭据加密、出网场景、权限清单 | 合规说明 |

## 阅读顺序建议

1. **了解项目是什么** → 01 项目总览
2. **了解怎么落地** → 04 实现路径（阶段与里程碑）
3. **了解怎么搭** → 02 系统架构、03 技术选型
4. **深入功能设计** → 05 模式系统、06 Agent 内核、07 窗口交互、08 设置与引导

## 文档约定

- 文档中的 **P0 / P1 / P2** 为优先级：P0 = v1 必须实现，P1 = v1 尽量实现，P2 = 后续版本实现。
- 文档状态标记：`已定稿` / `草稿` / `待更新`。技术决策变更必须同步更新 03 中的对应 ADR。
- 术语以 01 §3 名词表为准；配置字段以 08 §1 Schema 为准；接口签名以 05 / 06 中的 TypeScript 片段为准。
