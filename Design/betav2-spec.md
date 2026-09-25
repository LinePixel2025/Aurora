# Aurora BetaV2 总体规格（1.1.0-beta.2）

> 本文件是本轮升级的唯一执行规格。所有子任务以本文件为准；与旧文档冲突处，改完代码后由对应任务同步文档（docs-first：改 Schema/IPC/窗口交互前先改 docs 对应分册）。
> 用户原始需求：外观（快速会话融入侧边栏、新增主界面、Apple 风格、设置页合并、更多动画）+ 功能（ClassRoom 完善 + ClassIsland 插件、Work Mode 初步实装、Agent 对齐：更多可改设置/更多工具/生图/语音输入/思考过程展示）+ 产出 BetaV2 安装包并上传 GitHub。

## 0. 硬约束（每任务必读）

- `agent-core` / `modes` 不准 import electron / DOM；纯 Node。
- preload 自包含：改 IPC 必须同时改 `packages/shared/src/ipc/channels.ts` 与 `apps/desktop/src/preload/channels.ts`（有编译期双向断言）。
- 渲染层从 `@aurora/shared` 取运行时值只能走 `@aurora/shared/browser`。
- 渲染层传对象给主进程前必须 `deepClone()`（Proxy 不可结构化克隆）。
- 渲染层回传 provider patch 必须剔除 `apiKeyEnc`/`apiKeySet`，否则凭据被清空。
- Prettier：无分号、单引号、printWidth 100、尾逗号 all。TS strict + `import type`。
- `pnpm --filter @aurora/shared build` 后下游 typecheck 才能见到新类型。
- capture 探针依赖 `data-field` / `data-action` 锚点，属契约：重构 UI 必须保留既有锚点名，并按 §9 新增。
- 改了 shared 后先 build shared 再跑下游 typecheck。

## 1. 设计语言：全面转向 Apple HIG（Pinguo tokens）

参考 `Design/Apple Copy/colors_and_type.css`（Apple 系统色锚点）。**theme.css 重写时保留既有 CSS 变量名**（组件零改动跟随），只改值与新增变量：

- 强调色：亮 `#007AFF` / 暗 `#0A84FF`（映射 `--aurora-blue`）；成功 `#34C759`/`#30D158`（`--aurora-green`）；错误 `#FF3B30`/`#FF453A`；警告 `#FF9500`/`#FF9F0A`；running=蓝、idle=`#8e8e93`。
- **废弃 aurora 双色渐变**：`--aurora-gradient` 改为纯强调色值；全仓 grep `linear-gradient(135deg` 等 aurora 品牌渐变用法，一律换成强调色纯色（品牌 mark 可用强调色单色）。
- 中性色：亮 bg `#f5f5f7`、raised `#ffffff`、text `#1d1d1f`/`#6e6e73`/`#aeaeb2`；暗 bg `#000000`、raised `#1c1c1e`、overlay `#2c2c2e`、text `#f5f5f7`/`#aeaeb2`；分层填充亮（黑 .04/.06/.09）暗（白 .06/.09/.12）。
- 字体栈保持 SF 意向（-apple-system, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI'）；display 字距 -0.01~-0.02em。
- 圆角/阴影按 Apple 柔和风微调；玻璃材质 `.glass` 保留但更克制（blur 24、saturate 180%）。
- **动画增量**：设置页切换 `<Transition name="page">`（fade+X 12px）；侧栏/右栏弹簧滑入（`--ease-spring`）；消息入场 rise 保留并加 spring；按钮 `.press` 微缩；思考块展开 collapse；麦克风录音 pulse；模式切换内容 cross-fade。全部尊重既有 `prefers-reduced-motion` 全局覆盖。
- 禁止混入其他风格：不用霓虹/渐变彩带/拟物；留白充足，组件不得互相挤占（右栏与主区之间用分隔而非悬浮卡片）。

## 2. 窗口体系

- 窗口名不变：`edge-bar / chat / settings / onboarding`（`chat` 即**主界面**）。
- **chat 主界面规格**：默认 1120×720，minWidth 940 / minHeight 600，resizable，**alwaysOnTop 改为 false**，place 'center'。其余（frame:false、geometry 持久化、关闭=隐藏）不变。
- edge-bar 规格、双态几何（8px↔228px）不变；面板按钮文案「打开主界面」。
- 托盘菜单「显示主界面」。

## 3. 主界面布局（chat/App.vue 重写）

三栏 grid：`sidebar(232px, 可折叠) | main(1fr) | context(264px, 可折叠)`。

- **左栏**：品牌行（单色 mark + Aurora）→「新对话」按钮（`data-action="chat.new-session"`）→ 固定顶置项「快速对话」（`data-field="chat.quick-item"`，即 sessionId='quick'，点击 switchSession('quick')，**不再有任何独立快捷窗口、不再有双栏 tab**）→ 会话列表（`data-field="chat.session-list"`，标题+时间+条数+激活态）→ 底部：模式徽章 + 右栏开关（`data-field="chat.right-panel-toggle"`）+ 设置齿轮。
- **主区**：头部拖拽区（会话标题 + ModelPickerSelect `data-field="chat.model"` + ThinkingLevelSelect `data-field="chat.reasoningEffort"` + 清空/设置）→ MessageList → composer（附件 chips + textarea + 麦克风按钮 + 停止/发送）。
- **右栏（模式感知上下文栏）**：
  - classroom：当前/下节课卡（classisland status，非 classisland provider 时隐藏）、今日课程（perception lessons）、分类流水（ClassificationLedger 紧凑）、感知文件夹打开。
  - work：工作目录卡（打开 + 前往设置）、办公提示卡。
  - 通用：系统状态卡（时间/电量/网络/前台应用）。非当前模式的功能**一律不渲染**。
- composer 麦克风门控口径（同 TTS）：`stt.enabled && stt.active` 指向 baseUrl/model 齐全的 provider 才渲染按钮，否则**连按钮都不渲染**（不是 disabled），`data-field="chat.mic"`。

## 4. 配置 Schema v7 → v8（packages/shared/src/config/schema.ts）

```ts
// 顶层新增两组（凭据路径，见 §5）
stt: { enabled: false, active: '', providers: record<id, {
  type: 'openai-compat', baseUrl: string, apiKeyEnc: string,
  model: string, language: string /* 默认 'zh'，可空 */
}> }
imagegen: { enabled: false, active: '', providers: record<id, {
  type: 'openai-compat', baseUrl: string, apiKeyEnc: string,
  model: string, size: string /* 默认 '1024x1024'，enum 白名单：'512x512','768x768','1024x1024','1024x1792','1792x1024','auto' */
}> }
// modes.work 从占位 { guideCompleted } 扩为
work: { guideCompleted: boolean, workspaceDir: string /* 默认 '' */ }
// modes.classroom 新增
preClassOpenFolder: boolean /* 默认 true：课前提醒时自动打开科目文件夹 */
// general 新增子组
chat: { showThinking: boolean /* 默认 true：对话界面展示思考过程 */ }
```

- `CONFIG_VERSION = 8`；新增 `v7 → v8` 迁移（幂等补默认值、不覆盖用户已写值），同步 `defaults.ts`（含 `DEFAULT_STT`、`DEFAULT_IMAGEGEN`、`STT_PRESETS`/`IMAGEGEN_PRESETS` 可选）。
- **凭据路径 checklist（漏改=凭据丢失或泄漏）**：
  1. `SETTINGS_READONLY_PREFIXES` += `stt.providers`、`imagegen.providers`（schema.ts）；
  2. `SettingsStore` 四处：`canonicalSecretPath` / `readSecretField` / `writeSecretField` / `toPersisted`；
  3. 主进程 `redactSettings`；
  4. `SENSITIVE_KEY_PATTERN` 已含 `.*api[-_]?key.*`，确认命中即可。
- docs/08 §1 同步（schema 表 + 迁移记录 + 设置页 IA）。

## 5. IPC 契约新增（channels.ts + types.ts + preload/channels.ts 三处同步）

```ts
stt: { transcribe: 'stt:transcribe' }        // req {audioBase64, mime, language?} → {text}
imagegen: {
  generate: 'imagegen:generate',             // req {prompt, size?} → {filePath, dataUrl}
  read: 'imagegen:read',                     // req {filePath} → {dataUrl}  仅允许 userData/generated 下的文件（路径安全校验）
}
// AgentEvent 联合新增：
{ type: 'reasoning'; sessionId: string; requestId: string; delta: string }
// StoredMessage / ChatMessageDto 新增可选字段 reasoning?: string
```

## 6. agent-core 变更

1. **思考链解析**：`llm/sse.ts` 的 delta 提取增加 `delta.reasoning_content ?? delta.reasoning`（字符串、可空），流事件联合新增 `{type:'reasoning', delta}`；`loop/agentLoop.ts` 转发为 AgentEvent 并把增量累积进当条 assistant 消息的 `reasoning` 字段持久化（`session/types.ts` StoredMessage 加 `reasoning?`）。content 内嵌 `<think>...</think>` 不做解析（只认独立字段，避免误伤）。
2. **新工具**（agent-core 定义 + 端口注入，主进程给实现）：
   - `web_fetch` {url} — 端口 `WebFetchPort { fetch(url): Promise<{status:number; text:string}> }`，sensitivity 'safe'；描述注明结果截断 20k 字符、仅 GET。
   - `clipboard_read` () — `ClipboardPort.read(): Promise<string>`，sensitivity **'confirm'**（隐私）。
   - `clipboard_write` {text} — `write(text)`，'confirm'。
   - `notify_user` {title, body} — `NotifyPort.show(title, body)`，'safe'。
   - `generate_image` {prompt, size?} — `ImageGenPort.generate({prompt, size?})`，'confirm'（花 API 费用）；成功返回「已保存到 <filePath>」。
   - 工具都带中文 description；注册进 ToolRegistry（builtin，走 main 的 syncToolRegistries 组装）。
3. **set_setting 可写面扩大**（shared `canWriteSettingPath` 增加显式 WRITABLE 覆盖表，先于 readonly 前缀判定）：
   - `llm.providers.<id>.model | .reasoningEffort | .temperature`（baseUrl/type/apiKeyEnc 仍只读）；
   - `tts.enabled|active|autoRead|maxChars`；`stt.enabled|active`；`imagegen.enabled|active`；
   - `general.edgeBar.enabled|opacity|quietHours`；`general.chat.showThinking`；
   - `modes.current`（允许 Agent 切模式）、`modes.work.workspaceDir`、`modes.classroom.*`（本就可写）；
   - `agent.tools.*`（enabled/workspaceDir/terminal.*/files.*/open.*；confirmSensitiveTools 仍只读，防自我提权）；
   - `skills.userDir|disabled`；`advanced.quietHours`。
   - 每条在 `READONLY_PREFIX_REASONS`/新表给中文理由；`set_setting` 的工具 description 列出这些可写路径（配合 systemPrompt）。
4. **systemPrompt**：`SystemPromptParts` 增加可选 `settingsHint?: string`，主进程传入「Agent 可修改的设置项清单」段落（固定在「可用工具」之后）。

## 7. modes 包

- **work.ts 实装**（placeholder:false）：displayName 工作模式；guide 两步（workspaceDir 问答 + 确认）；systemPrompt = 办公场景人格：文档/表格/PPT/PDF 处理专家，指导用 `run_command` 走 PowerShell COM 自动化 Office（Word/Excel/PowerPoint.Application）与 `read_file`/`write_file`/`list_dir` 组合；强调覆盖/删除前确认；**明确声明本模式不含课堂/课程表功能**；perceptionSubscriptions `[{kind:'clock', intervalMs:60000}]`。
- **classroom.ts**：systemPrompt 增补「可修改的 ClassRoom 设置」清单（watchDir、subjects、schedule.provider/lessons/classisland.endpoint、preClassReminder、preClassOpenFolder、classification.*）与 ClassIsland 当前课状态感知说明。
- code.ts 维持占位。

## 8. 主进程

1. **window-manager**：chat 规格改 §2；其余窗口不动。
2. **stt.ts**（新）：`createSttService({settings, getSecret, fetchImpl})` —— multipart POST `<baseUrl>/audio/transcriptions`（Blob + `model` + `language`），Bearer 解密密钥，回 `{text}`；provider 解析口径同 TTS（`stt.enabled && stt.active`）。
3. **imagegen.ts**（新）：POST JSON `<baseUrl>/images/generations` `{model, prompt, size, n:1, response_format:'b64_json'}`；若回 `url` 则 netFetch 下载；b64 解码存 `userData/generated/<ts>-<rand>.png`；返回 `{filePath, dataUrl}`；`imagegen:read` 做路径校验（resolve 后必须在 generated 目录内）。
4. **新工具端口**：`web_fetch`→netFetch + HTML 剥标签 + 20k 截断；`clipboard_*`→Electron clipboard；`notify_user`→NotificationService；`generate_image`→ImageGenService。接入 `syncToolRegistries`。
5. **ipc.ts**：注册 `stt:transcribe`、`imagegen:generate`、`imagegen:read`。
6. **权限**：`session.defaultSession.setPermissionRequestHandler` 允许 `media`（麦克风），其余维持默认拒绝策略不变（只放行自身窗口的 media）。
7. **pre-class-reminder**：打开科目文件夹的行为受 `modes.classroom.preClassOpenFolder` 门控（通知照发）。
8. **classisland.ts**：payload 增加可选 `status` 对象（`currentSubject`/`nextSubject`/`nextStartTime`/`onClass`），`getStatus()` 透出；`classisland:status` IPC 自然带出。桥接端见 §10。
9. **会话权限/密文**：redactSettings 增 stt/imagegen；`settings-port.ts` 写路径判定改走 shared 新覆盖表。
10. **tray**：「显示主界面」文案。

## 9. 渲染层

- **theme.css**：按 §1 重写（保持变量名与既有类名/锚点契约）。
- **chat 三栏重构**（§3）：删除 152px 历史 sheet 与快速/会话双栏 tab；`useChat` 增加 reasoning 增量聚合（按 requestId 暂存、done 后并入消息）与麦克风录音（MediaRecorder → webm base64 → `stt.transcribe`，录音态 pulse 动画）。
- **MessageList**：助手消息上方可折叠「思考过程」块（流式期间自动展开、完成后收起为摘要行，手动可开，受 `general.chat.showThinking` 门控）；`generate_image` 工具卡成功态渲染图片预览（用 `imagegen:read` 换 dataUrl，img-src 'self' data: 已放行）。
- **设置页 8 → 6**：`SETTINGS_PAGE_IDS = ['general','modes','llm','voice','agent','advanced']`：
  - general 通用：启动与快捷键 / 提示条 / 勿扰时段（全局 + 提示条两组但同区）/ 关于与更新；
  - modes 模式：模式卡 + ClassRoom 区组 + Work 区组（workspaceDir，`data-field="modes.work.workspaceDir"`）；
  - llm AI 模型：provider 管理 + 「显示思考过程」开关（`data-field="general.chat.showThinking"`）+ **生图模型区组**（enabled/active/provider 编辑，锚点 `imagegen.*`）；
  - voice 语音：TTS 区组 + **STT 区组**（enabled/active/provider：baseUrl/model/apiKey/language，锚点 `stt.*`）；
  - agent 智能与工具：agent.tools 区组 + 技能区组 + MCP 区组（三组同页折叠）；
  - advanced 系统：网络 / 日志 / 安全 / 危险操作。
  - 旧深链兼容映射：`?page=tts→voice`、`?page=skills|mcp→agent`。
  - 每组用 `.section-card` + `<Transition name="collapse">`；页切换 `page` 动画。
- **edge-bar**：面板适配新主题；按钮「打开主界面」；work 模式下不渲染课堂卡；动画微调。
- **onboarding**：模式选择页描述对齐 Work 实装；风格随主题。

## 10. ClassIsland 桥接插件 v2（integrations/classisland-bridge）

- 保持既有 schedule.json 契约不变；**新增** `status.json`（同目录，原子写）：`{ version, generatedAt, onClass, currentSubject, nextSubject, nextStartTime }`（30s tick 与课程切换事件时刷新）。
- **使用 ClassIsland 的提醒功能**：课程切换（OnClass）与课前 N 分钟（`BridgeOptions.RemindBeforeClassMinutes`，默认 2，bridge.json 可配）通过 ClassIsland 通知服务（`INotificationService`，以本机 ClassIsland 2.1.0.1 程序集真实 API 为准，编译驱动确认签名；不可用时降级为仅写 status.json + 日志告警）弹课程提醒。
- 本机编译：`dotnet build -c Release -p:ClassIslandDir="C:\Users\22798\Downloads\ClassIsland_app_windows_x64_full_folder"`；产物打包 `dist/AuroraClassIslandBridge-*.zip`（dll + 依赖 + manifest.yml）。
- README 更新 v2 变更与「已验证程度」。

## 11. capture / smoke 适配

- `SETTINGS_PAGE_IDS` 更新为 6 页；chat 窗口变大后既有场景坐标/断言复查。
- 新探针：主界面左栏（session-list/quick-item/new-session）、右栏开关与 classroom/work 分区、思考过程块（seed 一条带 reasoning 的会话消息）、麦克风按钮门控（未配置时断言不存在）、设置页 voice/agent/llm 新区组、modes 页 `modes.work.workspaceDir` 与 `modes.classroom.preClassOpenFolder` 门控。
- report.json 条目以实际计划为准（不按固定张数校验）。

## 12. 发布

1. 全部 package.json 版本 → `1.1.0-beta.2`（root、apps/desktop、packages/*）。
2. `pnpm typecheck && pnpm test && pnpm build`；`AURORA_CAPTURE` 截图视觉验收；`pnpm package` 出 `Aurora-Setup-1.1.0-beta.2.exe`。
3. ClassIsland 插件 zip 一并作为 release 资产。
4. git 分主题提交（Conventional Commits 中文）；push 走代理 `http://127.0.0.1:7897`；`gh release create v1.1.0-beta.2`（若联通）。
