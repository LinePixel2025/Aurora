# Aurora 项目文档

> **Aurora** —— 将 Windows 接入 AI 生态的系统级 Agent 工具，为用户提供无感的、自主的 AI 服务。

本目录存放 Aurora 项目的规划与设计文档，作为开发的**单一事实来源（SSOT）**。
需求源头为仓库根目录的 [`Aurora.md`](../Aurora.md)；代码结构、接口与交互以实现前的最新文档为准，如需偏离，先改文档再改代码。

## 当前实现状态

**开发中（未发版）：右栏多标签（浏览器式，2026-10-03 二次修订）** ——
右栏从「四个固定 tab」升级为**可多开的标签容器**：文件 / 终端 / 浏览器可各开多个实例
（追加实例 id 为 `files-2` / `browser-2`…），每个标签带图标 + 标题（面板上报）+ 关闭钮；
**溢出 = 固定 88px + 「＋N」菜单折叠**（空间不够时标签让到 48、按钮宽度先留够 ——
右栏被挤到 280px 时「＋」曾被裁掉点不到），激活标签靠**滑动窗口**永远可见
（上限 12 个标签）；**标签条右端继续给 Windows 三键让位**（两个菜单只许向下弹）。
文件 / 终端 / 浏览器面板**首次激活后常驻**（切标签不再重载网页、不再重建 xterm），
上下文面板维持原 `v-if` 口径；主进程终端改为**每标签一个 shell**
（按 `terminalId` 记账、每窗口上限 6、关标签即 kill）。
**浏览器标签页自己也能开标签**（2026-10-03 二次修订）：工具条右端加「新建标签页」，
且网页里 `target="_blank"` / `window.open` 的 http(s) 链接改为**另开一个浏览器标签**
（旧口径是「同窗导航」——会把当前页顶掉）。
另：**主界面默认尺寸上调到 1280×800（min 1060×660）**，配置 Schema 随之推进到 **v26**
（`v25 → v26` 迁移把仍小于新默认的窗口几何放大一次，只放大不缩小）。规格见
[07 §2.3](./07-ui-spec.md) / [08 §2](./08-settings-onboarding.md)，探针 `chat-ctx-tabs` 见
[07 §5.3](./07-ui-spec.md)。

**当前版本 v0.3.6（侧栏优化修补版：内置浏览器修复 / 左栏调宽 / 终端黑底 / AI 展示成果 /
文件管理器），配置 Schema 仍为 v25（无迁移）** ——
五项：
① **左栏可拖拽调宽**（右缘把手 `chat.nav-resizer`，240px 缺省 / 200–420 夹取 /
localStorage 记忆，与右栏共用同一段拖拽实现）；
② **终端固定黑底**（此前跟随系统明暗，浅色系统下拿到白底黑字；容器与 xterm 主题两处都改，
尺寸跟随改用挂在容器上的 ResizeObserver，侧栏拖宽也会重排）；
③ **修内置浏览器打不开网页**（根因：渲染层 CSP 被无条件注入到 webview 的**外部页面**，
内联脚本与 CDN 资源全被拒 → 现在只按 `webContentsId` 注入自家窗口的页面；
另有 `target="_blank"` 的跳转处理（2026-10-03 二次修订：改为**另开一个浏览器标签**，
此前是同窗导航）、加载失败可见提示、本机地址补 `http://`）；
④ **新工具 `show_preview`**（Agent 把成果直接展示在右栏：http(s) 网址或会话边界根内的
本地 HTML / 图片等，自动展开右栏并切到「浏览器」tab，见 [06 §14](./06-agent-core.md)）；
⑤ **文件 tab ＝ 小文件管理器**（会话绑定了项目就缺省展示**项目文件夹**，可逐层进出、
点文件在面板内预览，见 [07 §2.3](./07-ui-spec.md)）。
面向用户的说明见 [release-notes/v0.3.6.md](./release-notes/v0.3.6.md)（原计划编号 v0.3.5.1，四段式版本号无法用于安装包与自动更新，按三段式发为 0.3.6；桌面端与 Center 同号但分属两条独立的版本线）。

**v0.3.5（右栏工作台 / `/init` 与 `/compact` / 平均缓存命中率 / 会话状态持久化），
配置 Schema 仍为 v25（无迁移）** ——
五块：
① **右栏工作台**（右栏改为功能 tab：文件 / 终端 / 浏览器 / 上下文；文件预览受工作目录边界约束、
终端是真 PTY 且每窗口常驻、浏览器为内置 webview；右栏宽度 384px 可拖拽 280–560，
见 [07 §2.3](./07-ui-spec.md)）；
② **`/init` 与 `/compact`**（前者探查项目生成 / 补全 AGENTS.md，后者把历史压成摘要写进
`meta.compact`、此后请求只带压缩点之后的内容且消息本体不删，见 [06 §4/§6](./06-agent-core.md)）；
③ **平均缓存命中率**（上下文条显示本会话累计命中率，`meta.usage` 随会话落盘 ——
跨切换、跨重启连续，见 [06 §21.4](./06-agent-core.md)）；
④ **会话状态持久化**（工具调用时间戳随工具卡落盘：切会话 / 重启后耗时都真实；
轨迹折叠 / 展开等显示状态按会话分桶恢复；切走时在流式的轮次收尾后自动重拉对齐）；
⑤ **Center 服务端 0.3.6**（服务端代码与 0.3.5 相同，重新部署只为版本对齐）。
面向用户的说明见 [release-notes/v0.3.5.md](./release-notes/v0.3.5.md)。

**v0.3.3（会话级模型 + 提问卡补齐 + 与 Center 双向传文件），配置 Schema v25（无迁移）** ——
① **会话级模型**（对话窗模型下拉管的是**本会话**，另有「跟随全局」清除项；会话左栏覆盖态显示模型徽标；
解析链只有一级 —— 会话覆盖 > 全局默认，覆盖失效静默回落；Center 网页端会话行同款可看可切，
见 [06 §3](./06-agent-core.md) 与 [12 §6.3](./12-aurora-center.md)）；
② **`ask_user` 四件事**（一次多问分节 + `allowCustom` 只许选 + 按次 `timeoutMs` 30s–10min；
**修复**：跨会话并发提问不再互相覆盖（内核还在等回执、界面上的卡却已被顶掉）；
**新增**：`center-` 会话的提问留痕写进会话文件（`SESSION_FILE_VERSION` 3 → 4，缺字段即"无留痕"，
老文件天然合法）并随历史回放给 Center，见 [06 §24](./06-agent-core.md)）；
③ **Center → 客户端发文件**（网页上传 → `file.send` → 客户端用自身令牌拉回并落进系统下载目录，
重名追加 ` (1)` 绝不覆盖；门控沿用 `center.allowFileTransfer` / `maxFileMb`；文件页新增来源标注，
见 [12 §5](./12-aurora-center.md)）；
④ **流式增量单源**（`createDeltaBuffer` 迁入 `@aurora/shared/browser`，网页端与桌面共用一份并
按帧合并 —— 桌面观感不变，网页端流式渲染更跟手）。
面向用户的说明见 [release-notes/v0.3.3.md](./release-notes/v0.3.3.md)。

**v0.3.2（Agent 回复排版升级：表格 / 公式 / 图表 / 代码高亮，两端同一渲染器 + 两项修复），
配置 Schema v25（迁移 v24 → v25）** ——
① **Markdown 完整渲染**（KaTeX 公式、Mermaid 流程图与时序图、ECharts 数据图表按需加载、
失败回退源码；**桌面与 Center 网页端共用同一份渲染器与 md.css**）；
② **子代理工作目录跟随父会话**（修复：此前子代理的缺省 cwd / 搜索根 / 文件边界恒落 `桌面\Aurora`）；
③ **退役全局 `projects.current`**（设置页「设为当前」与左栏「当前」徽标一并移除，Schema v24 → v25）。
面向用户的说明见 [release-notes/v0.3.2.md](./release-notes/v0.3.2.md)。

**v0.3.1（图像工具 + 百炼原生 ASR + 左栏「添加项目」修复），配置 Schema v24（迁移 v23 → v24）** ——
`view_image` / `screenshot` / `clipboard_read_image` 三件套（按模型 `vision` 注册级门控）、
`stt.providers.<id>.type` 新增 `dashscope-native`（录音不转码直传）、左栏「添加项目」与设置页对齐。
面向用户的说明见 [release-notes/v0.3.1.md](./release-notes/v0.3.1.md)。

**v0.3.0（会话三分 + 执行轨迹 + 多模态 + 模型级参数 + 全仓审查大修轮），配置 Schema v23（迁移 v21 → v22 → v23）** ——
跨 **71 个提交**的大版本，六块：
① **会话三分**（主界面左栏拆成 项目对话 / 工作目录对话 / Agent 对话，每个会话都有边界根，
Agent 分区目录固定 `桌面\Aurora`；项目分组可折叠；真删除会话 + 跨窗口同步；新设置页「会话管理」，
见 [06 §5.1](./06-agent-core.md) 与 [07 §2.2](./07-ui-spec.md)）；
② **执行轨迹**（思考与工具调用合并为一个轨迹容器：软胶囊 + 时间线 + 限高内滚，完成即自动折叠）
与**自动跟随三处修复**（跟丢 / 滚轮小步长上滚被吞 / 底部上滚被对齐帧抹掉，见 [07 §5.2](./07-ui-spec.md)）；
③ **图片进模型**（模型级 `modelParams.<id>.vision`，出厂关；历史只存路径、每轮重读）+ **Responses API**
（`type = 'openai-responses'`）；
④ **生成参数按模型下沉**（`modelParams` 三级：reasoningEffort / contextWindow / vision）
并**彻底删除 `temperature`**（配置 / 界面 / 请求体三处，见 [08 §1](./08-settings-onboarding.md)）；
⑤ **稳定性与安全大修**（全仓审查报告 P0/P1/P2 共 39 条 + 审查回归 6 条：Center WS 入站校验与回执隔离、
流式 AbortSignal 与解码器、退出协议、工具消息配对、MCP 含点凭据路径、快照回滚边界、免确认模式收紧、
Center 认证限速与异步 scrypt 等，见 [06 §11](./06-agent-core.md) 与 [12 §4.1](./12-aurora-center.md)）；
⑥ **六条界面细节**（权限下拉折行、上下文详解卡三行、输入区去「Enter 发送」、生图空态主按钮等）。
面向用户的说明见 [release-notes/v0.3.0.md](./release-notes/v0.3.0.md)。

**多模态输入 + Responses API 轮（2026-10-01，配置 Schema v22，迁移 v21 → v22）** —— 两件事：
① **图片进模型**（`llm.providers.<id>.vision`，出厂关）：拖入的图片按扩展名分出来，
作为 content parts（`image_url`）下发；会话历史只存**路径**不存 base64（跨轮次续聊按路径重读）；
附件 chip 显示缩略图；关闭开关时图片降级为一行「未读取」说明（对不支持视觉的模型发图片会被 400）；
② **Responses API**（`llm.providers.<id>.type = 'openai-responses'`）：新增
`OpenAiResponsesProvider`（`/responses`，`store: false`），与 chat-completions 共用同一层
超时 / 重试 / 错误码（`llm/transport.ts`）。
设计见 [06 §3.1 / §3.2](./06-agent-core.md)、[08 §1](./08-settings-onboarding.md)、[07 §2.3](./07-ui-spec.md)，
验证见 [04-roadmap.md](./04-roadmap.md) 的「2026-10-01 多模态与 Responses API 轮」。

**v0.2.9（细节优化轮），配置 Schema v21（迁移 v20 → v21）** —— 十一处细节：
输入卡工具行可收缩省略（窄窗 / 高 DPI 下权限文字不再溢出边框）、工具卡完成即自动折叠、
运行态「扫光 + 边框呼吸」双层动效、主区视图切换与自动化弹窗过渡、设置页文案再精简 +
技能表固定列宽（修文字错位）、自动化历史失败原因行内可见 + Agent 记录「查看对话」入口、
Normal Mode 新增「打开网址 / 打开应用」操作组件（http(s) 白名单 + openPath 单通道，docs/13 §5）、
**外观自定义**（`appearance.accent` 五档强调色，用户与 Agent 均可调）、
**提示条贴附显示器与屏幕侧可配置**（`general.edgeBar.display / position`）、
触摸体验（竖条点按展开 / 无 hover 设备常显）、左栏「任务」入口收拢进固定项组（去杂糅）；
Center 网页端移动端对话区保底 60% 高度（面板收进分段切换条）。
面向用户的说明见 [release-notes/v0.2.9.md](./release-notes/v0.2.9.md)。

**v0.2.8（自动化修复 + 启动提权轮），配置 Schema v20（迁移 v19 → v20）** —— 本轮修三件事：
① **自动化会话不能管理自动化**（Agent Mode 触发的会话换一套**无人值守人设** + 独立的
「## 本次运行」小节，并从工具面摘掉 `automation_create / update / delete / run`，执行层另有一道拒绝：
「自动化 → 会话 → 自动化」不得成为自我延续的闭环，见 [13 §7.1](./13-automation.md) 与 [06 §5.2](./06-agent-core.md)）；
② **调用次数**（自动化定义新增 `maxRuns` / `runCount`：触发即计数，**用满的那一次照常执行**后自动停用；
列表卡片、编辑器与 Center 网页都能看与改，见 [13 §3.1](./13-automation.md)）；
③ **启动要求管理员身份**（新配置 `general.requireAdmin` 出厂 `true`：未提权时用 UAC 重新拉起管理员实例，
失败不阻断启动；设置页「常规」可关，见 [08 §1](./08-settings-onboarding.md) / [09 §9](./09-packaging-release.md)）。
面向用户的说明见 [release-notes/v0.2.8.md](./release-notes/v0.2.8.md)。

**v0.2.7（界面减负二轮 + Center 时效轮），配置 Schema v19（无迁移）** —— 把
**输入框**收拾干净（占位只剩一句，不再被一行高度裁掉半句；权限 / 模型 / 思考三枚控件从
40px 带边框降为 28px 零边框「芯片」），把**设置页与引导窗的说明文案**大扫除（23 个文件，
删文档引用与实现细节、同一条信息只讲一遍，**默认值 / 单位 / 边界 / 失败后果 / 修复路径一律保留**），
把**出厂权限档从「变更前确认」提到「完全权限」**（有项目时项目根内免确认、越界仍问；
存量配置不受影响，不迁移），并让 **Center 的上线 / 下线状态刷新提速**（半开连接判离线
90s → 30s、客户端新增心跳看门狗、重连退避 30s → 5s、MCP 不再阻塞启动链、管理端改读实时推送）。
设计见 [06 §11.2](./06-agent-core.md) 与 [07 §2.3/§5.4](./07-ui-spec.md)，
时效表见 [12 §4.1](./12-aurora-center.md)，面向用户的说明见
[release-notes/v0.2.7.md](./release-notes/v0.2.7.md)。

**v0.2.0（Aurora Center 轮），配置 Schema v16** —— 2026-09-27 的 **Aurora Center 轮**落地[网页控制中心](./12-aurora-center.md)（独立服务器 + Web 控制台 + CLI，`packages/center`）与桌面端接入（远程会话 / 远程配置白名单 / 文件发送 / `center_status`·`center_send_file` 工具），并带来 **Agent 能力增强**（`create_skill` 内置技能 + 用户技能目录自动重扫、模式能力对齐 docs/05 §6）。
2026-09-26 的**生产化主线轮**把四项能力落地并验证（项目机制 / 三档权限 / 写前快照 / 可续跑任务），2026-09-27 的**安全加固轮**兑现 v0.1.5 披露的三个已知问题并封堵零弹卡越界写入逃逸链：
**项目机制**（顶层 `projects` 分组：当前项目决定项目根与项目级 `AGENTS.md` 注入）、
**三档权限**（`agent.permissionMode ∈ {readonly, confirm, auto}`）、
**写前快照与一键回滚**（`agent.snapshots.*`）、
**Task/Job 持久化与可续跑**（`agent.loop.*`）；**仍无 OS 级沙箱**（见文末「仍待做」）。
本轮细节见下方「2026-09-26 Agent 生产化主线轮」。

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
- **子代理独立页面**（docs/06 §19.1、docs/07 §2.3）：`task` 子代理的每一步进度经
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
    真发一条 → 断言助手气泡画出回复、上下文条显示真实 token `512 / 128k  · 缓存命中 512（100%）`、
    累计 `528`）。
  - `AURORA_SMOKE`（130 条断言）新增四条流式契约断言：正文按**增量**逐条下发（≥2 条 text 事件，
    旧行为只会 1 条）、每条增量**同轮同 id 且等于落盘的助手消息 id**、`usage` 事件下发
    （`promptTokens` 即本轮上下文占用）；桩服务同步补上结束片的 usage，
    否则这条链路在离线自测里永远是盲区。

**本轮（2026-09-26）修复三条对话体验 BUG**

> 面向用户的更新说明见 [release-notes/v0.2.4.md](./release-notes/v0.2.4.md)（每个版本一份，随 Release 发布）。

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
- **验证新增**（[07 §5.3](./07-ui-spec.md)）：三条截图探针场景 ——
  `chat-composer-flyouts.png`（两个浮层交替打开 + **几何断言**：任一时刻最多一个可见、
  浮层与工具行矩形**不相交**、发送键中心 `elementFromPoint` 命中它自己 ——
  这是「浮层盖死工具行」那条修复的运行时证据，此前只有静态推演）、
  `chat-tool-card-open.png`（展开终点的 `--collapse-h` 必须等于该元素的 `scrollHeight`，
  差 ≤ 2px）、`chat-archive.png`（归档分组 + 真实 UI「归档 → 撤销」往返）。
  全量截图（四个窗口）48 张全部通过；`pnpm verify` 26/26。

**2026-09 工具面扩充轮（+ prompt caching）本轮新增**

> 本轮对齐 opencode 的**工具提示词契约**（只借用文本约定、不缝合它的代码，逐条对照见
> [06 §20](./06-agent-core.md)），把内核从「能读写文件」推到「能改代码」，
> 并让「缓存生效」这件事可观测。配置 Schema 升到 **v12**。

- **电脑操控工具由 5 个扩到 8 个**（[06 §11](./06-agent-core.md)）：
  - **`edit_file`（精确替换，`confirm` 级）**：只替换指定的那一小段，其余部分逐字节不变——
    **改前必须先 `read_file` 过该文件**、`oldString` 命中多处即拒绝（要全局改名显式用
    `replaceAll`）、EOL 保真（混合行尾 / 孤立 `\r` 直接拒绝改动）、单文件上限 1 MiB、
    **没有备份也没有撤销**。它补上的是「为改两行而整篇重写」（token 翻几十倍且极易改坏）
    这个缺口 —— 这也是 Code Mode 至今仍是占位实现的直接技术原因。
  - **`grep` / `glob`（只读检索，`safe` 级）**：`grep` 按正则搜内容（返回 `路径:行号: 命中行`），
    `glob` 按文件名模式找文件。走**自写递归遍历**（零新增依赖），默认跳过
    `node_modules` / `.git` / `dist` 等 8 个目录、不跟随符号链接，
    并有文件数与字节数双重预算（2 万文件 / 64 MiB）——**绝不无限遍历**，触顶如实标注截断。
    新增 `agent.tools.search.{enabled,maxResults}` 组与设置页「文件检索」栏。
- **`read_file` 升级为行窗口契约**：内容每行带 `<行号>: ` 前缀，新增 `offset`（1 起始）/
  `limit`（缺省 2000、上限 5000），单行超 2000 字符截断；关闭「只能读文件开头」的真实缺口
  （大文件后半段现在读得到），超过 16 MiB 的文件只解析开头并提示改用 `grep` 定位。
- **`run_command` 免确认命令模式**（[06 §11.7](./06-agent-core.md)）：在「逐次确认」与
  「全局关掉确认」之间补上中间档 —— 用户在设置页维护一份命令模式白名单
  （`agent.tools.terminal.allowPatterns`，glob **全串**匹配、大小写不敏感），
  命中即跳过确认卡片但**仍写 `info` 级审计日志**。只允许字面字符 + `*` + `?`，
  含花括号（`{a,*}` 这类能编译成「放行全部」的绕过写法）或纯通配一律拒绝，**Schema 与匹配器双层拒绝**；
  该字段属 `SETTINGS_READONLY_PREFIXES`（AI 改不动，防自我提权）。
  定位是「**减少打扰**」而非安全加固（见 [10 §10](./10-user-guide.md) 的用户侧说明）。
- **prompt caching：前缀稳定化 + 命中观测**（[06 §21](./06-agent-core.md)）：
  系统提示词改成「**静态在前、易变在后**」（易变三节 = 更早对话的摘要 / 当前任务清单 / 系统状态
  一律排末尾），`ToolRegistry.toLlmTools()` 按工具名**字典序**返回且 `agentLoop` 与 `agentHost`
  共用这一份有序清单（工具顺序不再随设置变更漂移），请求侧 `messages` 形状不变；
  `TokenUsage` 新增 `cachedTokens`（认 `prompt_tokens_details.cached_tokens` 与
  `prompt_cache_hit_tokens` 两种形态，都缺时**不冒充 0**），在对话窗「上下文详解」条展示
  最近一轮的命中量与占比。**不引入显式 `cache_control`、不加任何配置字段**。
- **验证**：`pnpm test` 72 文件 / **1292** 用例全绿；
  `AURORA_SMOKE` **146/146 passed**（新增三条断言：两轮系统提示词静态前缀逐字节相同、
  两轮 `tools` 顺序相同且已排序、`usage` 事件带 `cachedTokens=512`；
  另有「命中免确认不弹卡片 / 未命中仍弹卡片」成对断言）；
  `AURORA_CAPTURE` 48 张 PNG / 48 条 checks / 0 FAIL
  （`chat-stream` 场景实测上下文条文案 `512 / 128k  · 缓存命中 512（100%）`、累计 `528`）。

**2026-09-26 Agent 生产化主线轮（配置 v12 → v15）本轮新增**

> 把 Agent 从「能改代码」推到「可托付地跑长任务」：知道自己工作在哪个项目、按用户选的档位动手、
> 改动前留底、跑到一半停下还能接着跑。设计口径见
> [06 §4.1 / §5.1 / §11.2 / §11.8 / §12.2](./06-agent-core.md) 与
> [07 §2.3 / §2.5](./07-ui-spec.md)、[08 §1](./08-settings-onboarding.md)。

- **项目机制（v13）**（[06 §5.1](./06-agent-core.md) / [07 §2.5](./07-ui-spec.md)）：
  配置新增顶层 `projects` 分组 —— `current` / `list[{id,name,root}]` / `maxAgentsBytes: 32768`。
  当前项目决定两件事：① **项目级约定注入** —— 从**项目根到当前工作目录逐层**收集 `AGENTS.md`
  （同目录有 `AGENTS.override.md` 时它优先），作为系统提示词的「项目约定」小节注入
  （位置在静态段之后、系统状态之前，见 [06 §5.1 / §21.1](./06-agent-core.md)），
  单次收集上限 **24 层 / 32 KiB**，超限**截断并标注**；② 权限层的「项目根之内 / 之外」判定（下一条）。
  设置页新增「项目」区组、右栏新增「当前项目」卡（项目根不可用时标红并给「重新选择目录」）。
  `openPath` 的 `kind` 新增 **`'project'`** —— 它打开的是**项目根**，
  而 `kind: 'workspace'` 打开的是 `agent.tools.workspaceDir`，两者不是一回事。
- **三档权限（v13，`agent.permissionMode`，默认 `auto` —— 2026-09-29 起出厂即完全权限）**
  （[06 §11.2](./06-agent-core.md)）：
  老的 `advanced.confirmSensitiveTools === false` 由 `auto` 档承接（与默认档镜像，出厂同为 `false`），
  **`readonly` 优先于该布尔**。
  确认卡片新增第三键「**本会话都允许**」（按 会话 × 工具名 记忆，**仅内存、不落盘**）。
  项目根边界是**两层**（[06 §11.2](./06-agent-core.md)）：`auto` 档「要不要弹卡」用**字符串级判定**
  （含 `..` 段、取不到目标路径的工具一律按越界）；「能不能真碰」由主进程对**已存在的最近父目录**
  做 **realpath 前缀校验**（越界即 `E_PATH_OUTSIDE_WORKSPACE`），六个文件类入口与 `run_command.cwd`
  都走它。这条边界**只在配置了当前项目时才启用** —— 没有项目时行为与 v12 之前完全一致。
  `auto` 档下 `run_command` 的命令串里出现绝对路径时一律回到确认卡片。三档的差别是：
  - `readonly` 档**根本不注册**写入 / 执行类工具（连 `todo_write` 也不注册，只保留 `todo_read`），
    所以它不是"注册之后再拒绝"——模型在工具清单里就看不到它们；
  - `confirm` 档与旧行为**逐字一致**；
  - `auto` 档在**项目根之内**免确认（仍写 `info` 级审计日志），越界仍逐次确认。
- **写前自动快照与一键回滚（v14，`agent.snapshots.*`）**（[06 §11.8](./06-agent-core.md)）：
  `write_file` / `edit_file` 落盘**之前**把原内容存进 `<userData>/backups/<sessionId>/`
  （一条一个 `<ISO 时间戳>-<8 位内容哈希>.snap` + `index.json`）；两层淘汰 ——
  每文件环形保留 `keepPerFile`（默认 20）+ 目录总预算 `totalBudgetBytes`（默认 200 MiB）；
  单份超过 `maxSnapshotBytes`（默认 512 KiB）即跳过，并**在工具结果里如实说明**。
  右栏「文件备份」卡可两段式回滚，**回滚本身也先留一份快照**（因此还可以再撤回），
  `exists:false` 的快照回滚 = 删除该文件。
- **Task/Job 持久化与可续跑（v15，`agent.loop.*`）**（[06 §4.1](./06-agent-core.md)）：
  一次请求 = 一条 job，落在 `<userData>/jobs/<sessionId>.json`，每轮结束落游标；
  轮次用尽 / token 预算触顶时落 `paused` 并给出原因（`max-rounds` / `budget`）。
  右栏「任务」面板可看进度（第几轮 / token / 步骤 / 待办）并点「继续」**接着上次的进度跑**
  （**不重复落盘**那条用户消息）。`agent.loop` 三项 = `maxRounds: 8` / `maxTotalTokens: 0`（不限）/
  `autoContinueRounds: 2`，预算内的自动续轮次数**持久化**（重启不会重新获得额度）；
  **应用重启后 `paused` 的 job 仍在面板里，可直接继续**。配置 Schema 升到 **v15**
  （`v12 → v13 → v14 → v15` 三条迁移）。
- **顺带修掉一处既有竞态**：`SessionStore` 与待办清单端口的「首读竞态」——并发首读会拿到**空快照**，
  随后一次写入把磁盘上的历史**整体覆盖**；改成 **in-flight promise 共享**，并在读回时与在途写入合并。
- **验证**：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `pnpm verify` 全绿
  （`verify` **26/26**，`version = 15`、`v0 → 当前版本` **15 条迁移**）；
  `pnpm test` **79 个文件 / 1496 个用例全绿**（本轮起点 72 文件 / 1307 用例）；
  `AURORA_SMOKE` **163/163 passed**，含六条跨特性集成断言（项目 `AGENTS.md` 进请求体、
  且只放在项目根**父目录**的那份不进 / `auto` 档根内写文件不弹卡 + 真落盘 + 留快照 /
  `readonly` 档同一条提问写不动 / 一键回滚还原且新增 `origin:'rollback'` 快照 /
  事件类型白名单含新增的 `job` / 为第二次启动留下 `paused` job）；
  `AURORA_CAPTURE` **53 张 PNG / 53 条 checks / 0 FAIL**，含 step 1–4 的四个新场景
  （`chat-project-card.png` / `chat-permission-readonly.png` / `chat-snapshot-card.png` /
  `chat-job-panel.png`）与综合概览 `chat-agent-prod-overview.png`
  （右栏同时有项目卡 + 文件备份卡 + 任务卡）。
  **两次启动的续跑实测**：第一次启动留下 `paused`（游标 2、已完成步骤 2）→ 退出 →
  第二次启动读回同一条 job（`found=1 status=paused`）→ 继续后 `status=done`、
  `stepsDone 2→3`、`cursor 2→3`，会话里那条用户消息**仍只有一条**。

鼠标键盘模拟、录屏、持久交互式 shell、命令黑名单、Anthropic 等非 OpenAI 兼容协议
**仍属后续范围**（**截图已由 `screenshot` 工具落地**，受模型 vision 门控，见 [06 §25](./06-agent-core.md)）。

仍待做：**OS 级沙箱**（三档权限与项目根 realpath 前缀校验**不是**沙箱 —— 没有作业对象 / 容器 /
受限令牌，`run_command` 仍是当前用户权限）、Code Mode 功能实现（Work 已于 0.0.1 初步实装）、
子代理能力加强（多子代理 / 独立 `model·effort` / 并行 / 可写工作区）、上下文压缩修正
（工具参数计入权重、摘要落盘、预算按真实 token 校准）、代码签名证书、启动耗时 / 内存优化、OCR、多语言。
（**多模态输入与 Responses API 已于 2026-10-01 落地**，见文首那一轮与
[04-roadmap.md](./04-roadmap.md) 的「2026-10-01 多模态与 Responses API 轮」。）
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
| 12 | [12-aurora-center.md](./12-aurora-center.md) | Aurora Center：网页控制中心（服务器 / Web UI / CLI / 客户端连接器 / Center 工具） | 远程控制 |
| 13 | [13-automation.md](./13-automation.md) | 自动化：Agent Mode / Normal Mode、触发器与操作组件、内置自动化、Center 远程管理 | 功能设计 |

## 阅读顺序建议

1. **了解项目是什么** → 01 项目总览
2. **了解怎么落地** → 04 实现路径（阶段与里程碑）
3. **了解怎么搭** → 02 系统架构、03 技术选型
4. **深入功能设计** → 05 模式系统、06 Agent 内核、07 窗口交互、08 设置与引导

## 文档约定

- 文档中的 **P0 / P1 / P2** 为优先级：P0 = v1 必须实现，P1 = v1 尽量实现，P2 = 后续版本实现。
- 文档状态标记：`已定稿` / `草稿` / `待更新`。技术决策变更必须同步更新 03 中的对应 ADR。
- 术语以 01 §3 名词表为准；配置字段以 08 §1 Schema 为准；接口签名以 05 / 06 中的 TypeScript 片段为准。
