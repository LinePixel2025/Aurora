# 鸿蒙客户端新项目 · 开工提示词

> **用法**：新建鸿蒙工程仓库后，把下面「提示词正文」整段粘贴给编码代理（或作为项目
> README 的开发纲领）。它自包含全部服务端契约，不需要 Aurora 主仓库。
> 上游 SSOT：Aurora 仓库 `docs/12-aurora-center.md` §15（Center **0.7.0** 起提供本契约；
> 仓库地址 https://github.com/LinePixel2025/Aurora）。契约以服务端实际行为为准，
> 本文与上游不一致时以上游为准。

---

## 提示词正文（从这里开始粘贴）

你是一名资深 HarmonyOS 应用工程师。请从零新建一个 DevEco Studio 工程，开发
**「Aurora Center 鸿蒙客户端」**：一个手机遥控台 App，让用户在鸿蒙手机上远程操控
运行在 Windows PC 上的 Aurora AI 助手（远程对话、批准敏感操作、回答提问、收发文件、
查看用量与自动化）。服务端是已有的 **Aurora Center**（纯 Node 服务器，个人 / 小团队
自托管，单端口 HTTP + WebSocket）。**你不需要开发服务端**，只需按本文契约消费它。

技术基线：HarmonyOS NEXT（API 12+）、ArkTS + ArkUI（Stage 模型）、TypeScript 严格模式。
所有界面文案用中文。代码注释用中文。

### 1. 产品定位与范围

- App 是 Center 的**网页端角色**（不是受控设备）：PC 上的 Aurora 客户端主动出站连接
  Center；App 与浏览器控制台地位完全相同，消费同一套「网页 ⇄ 服务器」协议。
- **v1 推荐混合架构**（最快交付、继承网页端全部功能）：
  - 原生壳：登录 / 注册 / 多服务器管理、推送登记与深链路由、文件下载接管、通知栏快捷批复；
  - ArkWeb 组件加载 Center 自带的 Web 控制台（已做 ≤720px 移动适配），令牌注入同源
    localStorage 后由网页自行连接 WS。
  - v2 再逐步原生化设备列表与会话流（本文 §6 给出纯原生模块拆分）。
  - 若产品要求纯原生起步，直接按 §6 实施，契约不变。
- v1 功能清单（P0）：登录持久化、设备列表与在线态、远程会话（发消息 / 看流式回复 /
  停止）、确认卡与提问卡批复、历史回放、文件收发、推送通知与深链、通知偏好开关。
  P1：通知栏一键批复、用量页、自动化管理、插件面板、语音输入 / 朗读。
- **明确不做**：不改服务端协议；不做设备侧（受控端）功能；不引入第三方 UI 库。

### 2. 服务端接入总则

- 服务器地址由用户填写（如 `https://center.example.com:8787`），支持保存多个服务器、
  每个服务器独立账号与令牌。
- **公网必须 HTTPS**。鸿蒙默认拦截明文 HTTP：内网 `http://IP:端口` 直连只能在调试包
  通过 `resources/base/profile/network_config.json` 显式放行（cleartext 配置，API 18+
  按域名放行；ArkWeb 与 Network Kit 的口径分别核对）；**AppGallery 发布包强制 HTTPS**，
  引导内网用户给 Center 上 TLS 反代。
- 所有 REST 鉴权：`Authorization: Bearer <会话令牌>`。错误回包统一 `{ "error": "<码或文案>" }`。
- 协议**只增不改**：遇到未知 `type` / `kind` / 字段一律忽略，不得抛错。
- 限速：登录失败 5 次/分钟/IP、注册 10 次/分钟、refresh 60 次/分钟（429 `E_RATE_LIMITED`）。
  移动网络共享出口 IP 可能误伤，UI 要给出「稍后再试」的可行动提示。

### 3. 鉴权与会话生命周期（REST）

#### 3.1 登录 / 注册（持久会话）

```
POST /api/auth/login
  { "username": "alice", "password": "********",
    "persistent": true, "deviceName": "我的手机", "client": "harmony" }
  → 200 { "token": "<64位hex>", "user": { "id", "username", "role" },
          "expiresAt": "<ISO>", "persistent": true }
  → 401 密码错误 | 429 E_RATE_LIMITED

POST /api/auth/register   { username, password, persistent?, deviceName?, client? }
  → 200 同 login（注册即登录）；用户名 3–32 位字母数字下划线连字符，密码 ≥ 8 位
  → 403 E_REGISTRATION_DISABLED（服务器关闭自助注册）| 409 用户已存在
```

- `persistent: true` 颁发 **90 天**持久会话（服务器落盘、重启不丢）。**App 必须用它**。
- 令牌**只存 HUKS**（`@ohos.security.huks`，AES-GCM 封装或密钥引用），绝不落
  preferences 明文、绝不进日志。`user` 信息可存 preferences（非凭据）。

#### 3.2 轮换 / 登出 / 当前用户

```
POST /api/auth/refresh    （Bearer 持久会话）{}
  → 200 { token, user, expiresAt, persistent: true }   旧令牌立即失效
  → 400 E_NOT_PERSISTENT（临时会话）| 401（令牌已失效）
POST /api/auth/logout     （Bearer）{} → 200 { ok: true }
  服务端删会话并级联清除本会话登记的推送设备。App 侧同时清 HUKS。
GET  /api/me              （Bearer）→ 200 { id, username, role }
```

- **每次冷启动**：令牌剩余有效期 < 7 天 → 先 refresh 再用；refresh 失败（401）→ 回登录页。
- 任何 REST 收到 401：先尝试 refresh 一次并重放原请求；再失败 → 登出态。
- WS 被服务器关闭（令牌失效）同样走这条恢复链。

### 4. 设备与数据（REST）

```
GET /api/clients → { clients: [{ clientId, name, online, version, platform, mode,
                                 ownerUserId, ownerUsername, lastSeenAt, firstSeenAt }] }
GET /api/usage?from=&to=&clientId=&model=&limit=&offset=
  → { scope, range, totals, lifetime, daily: [{ date, requests, promptTokens,
      completionTokens, cachedTokens, totalTokens }], recent: [...], recentTotal }
  普通用户强制本人数据；limit 夹 1..500 默认 100；KPI 永远按全量算，翻页只影响 recent。
GET /api/files → { files: [{ fileId, clientId, name, size, note?, uploadedAt,
                             expiresAt, source?: 'client'|'web' }] }   （24h 自动过期）
GET /api/files/:fileId      （Bearer 或 ?token=）→ 二进制流（Content-Disposition 附件）
DELETE /api/files/:fileId   → { ok: true }
POST /api/uploads?clientId=<目标设备>
  请求头 X-File-Name: <URI 编码的文件名>；请求体 = 文件原始字节流（不是 multipart）
  → 200 { fileId, name, size } | 404 设备不存在 | 403 越权 | 413 超限
```

- 文件下载用原生接管（ArkWeb `onDownloadStart` 或原生 http），保存到用户选择的位置
  （filePicker / 安全保存组件）；下载 URL 可带 `?token=` 直链。
- 给设备发文件：先 `POST /api/uploads` 拿 fileId，再走 WS `file.send`（§5.2）。

### 5. WebSocket 协议（核心）

连接：`wss://<host>/api/ws?token=<会话令牌>`（浏览器 WebSocket 不能自定义头，
令牌走查询串；鸿蒙原生 WebSocket 同样用查询串，保持与网页端一致）。

#### 5.1 连接 lifecycle

1. 连上后**第一帧**发连接标识：`{ "type": "web.hello", "client": "harmony", "appVersion": "1.0.0" }`
   （服务器据此识别手机连接：手机在线时不再发系统推送，避免重复打扰）。
2. 服务器随即下发 `clients` 全量快照 + 各设备 `client.status` + 未过期的 `ask.request` 回放。
3. **心跳**：服务器不向网页端发 ping；App 侧建议 30–45s 无下行任何帧即主动断开重连。
   重连退避：1s 起、指数、5s 封顶、±20% 抖动（与桌面端同口径）。
4. **后台即挂起**：鸿蒙会冻结后台进程网络，WS 必断——不要做无谓保活；后台触达完全
   依赖系统推送（§7）。回前台：重连 → 重发 web.hello → 收快照 → `GET /api/pending`
   对账 → 打开中的会话拉 `session.history` 补齐。
5. 命令-回执模型：每条上行命令带 `requestId`（App 生成，UUID 即可），服务器回
   `{ type: 'result', requestId, ok, data?, error? }`。**例外**：`ask.resolve` 的
   `requestId` 必须是**提问卡自身的 id**（`ask.request` 里的 `request.requestId`），
   它同时是回执关联键。
6. 服务器侧待回执超时：普通命令 15s、语音 60s、file.send 10 分钟、带附件 input 5 分钟；
   超时回 `E_CLIENT_TIMEOUT`。App 侧等待时限应略大于这些值。

#### 5.2 上行命令（App → 服务器；全部要带 requestId 与 clientId，除注明外）

| type | 关键字段 | 语义 / result.data |
|---|---|---|
| `session.create` | clientId | 开远程会话 → `{ sessionId: 'center-xxxx' }`（服务器分配） |
| `session.input` | sessionId, text, attachments?: fileId[] | 发消息；附件先 POST /api/uploads（≤5 张图、单张 ≤8MiB）；回执 `{ agentRequestId }` |
| `session.abort` | sessionId, agentRequestId | 停止当前回复 |
| `session.history` | sessionId | 历史回放 → `CenterSessionHistoryMessage[]`（最近 200 条；含 kind:'ask' 留痕） |
| `session.list` | clientId | 枚举远程会话 → 摘要数组（标题/更新时间/权限/可见性/模型覆盖） |
| `session.activate` | sessionId | 让 PC 主界面切到该会话 |
| `session.visibility` | sessionId, visible | 该会话在 PC 左栏可见性 |
| `session.setPermission` | sessionId, permissionMode | 会话级权限档（'readonly'\|'confirm'\|'auto'，以服务端 schema 为准） |
| `session.setModel` | sessionId, model, providerId? | 会话级模型覆盖；model 空串 = 清除 |
| `session.readImage` | sessionId, imageId | 拉对话图片 → `{ dataUrl, name, mime }` |
| `config.get` | clientId | 脱敏配置（凭据一律 `***`） |
| `config.update` | clientId, patch | 白名单补丁（仅 modes.current / agent.tools.* 开关）；越权回 E_FORBIDDEN_PATH |
| `mode.switch` | clientId, mode | 切工作/课堂/代码模式 |
| `confirm.resolve` | confirmId, approved | 批复确认卡（与 PC 本机先到先得） |
| `ask.resolve` | sessionId, answers: string[], skipped?, answersByQuestion? | 回答提问卡；**requestId = 提问卡 id**；回执 `{ settled }` |
| `file.send` | fileId | 把暂存文件推给设备落盘 |
| `llm.switch` | providerId?, model?, reasoningEffort? | 全局默认模型/思考等级 |
| `project.list` | clientId | 项目选项 → `[{ id, name }]` |
| `stt.transcribe` | audioBase64, mime | 语音识别中转（设备本机 provider）→ `{ text }` |
| `tts.synthesize` | text | 朗读合成中转 → `{ audioBase64, mimeType }` |
| `automation.list/catalog/save/delete/run/history` | 见 §5.4 | 自动化管理 |
| `plugin.panelData/subscribe/unsubscribe` | pluginId, panelId, method?, params?, values? | 插件面板中继（只认设备属主） |

#### 5.3 下行事件（服务器 → App）

| type | 关键字段 | 处理 |
|---|---|---|
| `clients` | clients[] | 全量设备快照（每次变动都推，**不要轮询**） |
| `client.status` | clientId, status | 单设备状态：mode/version/agent 开关/center 闸门/llm/voice?/plugins? |
| `client.event` | clientId, sessionId, event | **AgentEvent 原样转发**，渲染见 §5.5 |
| `result` | requestId, ok, data?, error? | 命令回执 |
| `file.received` | fileId, clientId, name, size, note?, at | 设备上传了文件 → 下载卡 |
| `confirm.request` | clientId, sessionId, request | 确认卡：`{ confirmId, sessionId, toolName, input, createdAt, expiresAt(ISO) }`，**60s 窗口，超时按拒绝**；网页端不回放，冷启动用 GET /api/pending |
| `ask.request` | clientId, sessionId, request | 提问卡：`{ requestId, sessionId, question, header?, options?, multiSelect, expiresAt(毫秒时间戳), questions? }`，**180s 窗口**；重连会回放未过期项 |
| `ask.settled` | clientId, sessionId, requestId, outcome, answers? | 提问已在 PC 侧结算 → 立即收卡（outcome: answered/skipped/timedOut/aborted） |
| `plugin.event` | clientId, pluginId, panelId, event, payload? | 插件事件（仅订阅后） |

注意两种 expiresAt 形状：**确认卡是 ISO 字符串，提问卡是毫秒时间戳**，别混。

#### 5.4 待办快照与快捷批复（REST，推送唤醒配套）

```
GET /api/pending?clientId=<可选>
  → { confirms: [{ clientId, sessionId, request }], asks: [{ clientId, sessionId, request }] }
  只含未过期项；冷启动 / 推送唤醒后拉一次，与 WS 回放合并去重（按 confirmId / requestId）。
POST /api/confirm/resolve  { clientId, confirmId, approved }
  → 200 { ok: true } | 403 | 404 | 503 E_CLIENT_OFFLINE | 504 E_CLIENT_TIMEOUT
POST /api/ask/resolve      { clientId, sessionId, requestId, answers?, skipped?, answersByQuestion? }
  → 200 { ok: true, data: { settled: true } } | 409 E_ALREADY_SETTLED（已被别处答掉）
```

通知栏「批准 / 拒绝」动作直接调这两个 REST（不必打开完整会话）；与 PC 本机、网页端
**先到先得**，失效要如实提示。

#### 5.5 AgentEvent 渲染契约（会话流）

事件类型：`queued / text / reasoning / tool / subagent / usage / done / job / error / user-message`。
聚合规则（与网页端同口径）：

- `text` / `reasoning` 按 `messageId` 聚合增量（delta 追加）；reasoning 渲染为可折叠思考块；
- `tool` 携带 `call`（id/name/state: running|success|error/input/outputSummary）→ 工具卡；
  `subagent` 按 callId 更新子代理快照卡；`job` 渲染任务清单卡；
- 同一 `requestId` 的过程（思考/工具/中间正文）收成一个「工作胶囊」，最终结论留在胶囊外；
  `done` 结束 loading（`pending: true` 表示未收敛结束，显示原因）；`error` 红条（code+message）；
- `usage` 取最新一条的 promptTokens 作「当前上下文占用」，逐轮累加得会话消耗；
- `user-message` 按内容+时间去重（历史回放里已有同一条）；
- 历史回放（session.history）条目：`{ id, role, content, createdAt, requestId?, reasoning?,
  toolCalls?, kind?: 'message'|'ask', ask? }`；助手消息按存储 id 对齐、用户消息按内容去重，
  历史排在实时之前；`kind:'ask'` 渲染只读已结算卡。
- **Markdown 安全基线**：模型输出必须先转义再套白名单标记，绝不裸渲染 HTML；
  链接拒绝 `javascript:`；外链 target=_blank + noopener。混合架构下由网页端负责；
  纯原生路线用分级渲染（基础语法原生，mermaid/KaTeX 懒加载 ArkWeb）。

#### 5.6 错误码速查

`E_UNAUTHORIZED`(401) / `E_FORBIDDEN`(403) / `E_CLIENT_NOT_FOUND`(404) /
`E_CLIENT_OFFLINE`(503) / `E_CLIENT_TIMEOUT`(504) / `E_ALREADY_SETTLED`(409) /
`E_RATE_LIMITED`(429) / `E_PUSH_UNAVAILABLE`(503) / `E_NOT_PERSISTENT`(400) /
`E_REMOTE_DISABLED`（设备侧闸门关闭，WS result）/ `E_FORBIDDEN_PATH`（配置白名单外）/
`E_VOICE_NOT_CONFIGURED`（设备未配语音）/ `E_UNSUPPORTED`（设备不支持该能力）。
设备离线时命令回 E_CLIENT_OFFLINE——UI 显示设备离线态，不静默空白。

### 6. 客户端架构

#### 6.1 混合壳（v1 推荐）

- `EntryAbility`（**singleton 启动模式**，否则热启动收不到 onNewWant）+ ArkUI 壳页：
  服务器管理 / 登录 / 设置（通知偏好、关于）/ 主视图（ArkWeb）。
- ArkWeb 加载 Center 地址；**令牌注入**：页面加载前经 `runJavaScript` /
  `javaScriptOnDocumentStart` 写入同源 localStorage（网页端键名见其 `lib/api.ts`：
  令牌与 user JSON 两个键；上游仓库可查），随后网页自行登录态连接 WS。
- 桥接：`onDownloadStart` → 原生下载；`onPermissionRequest` → 麦克风授权（或原生录音
  经 JS 桥注入）；深链 → 导航到对应 hash 路由（`#/`、`#/files`、`#/usage` 等）。
- 原生推送模块独立于 ArkWeb（网页在后台不工作，推送必须原生处理）。

#### 6.2 纯原生模块拆分（v2 / 或一开始就选）

```
common/protocol/   契约类型（本文 §3–§5 的 TS 形状；与上游 protocol.ts 对齐）
common/net/        HttpClient（Bearer + 401→refresh→重试一次）
                 WsClient（web.hello / 退避重连 / 无下行看门狗 / requestId 回执表）
common/store/      HUKS 令牌库 / preferences（服务器列表、偏好）/ 会话内存缓存
features/auth/     登录 / 注册 / 服务器管理
features/devices/  设备列表（clients 快照驱动）
features/session/  会话流（§5.5 聚合）/ composer（权限/模型/思考芯片、图片附件）
features/cards/    确认卡 / 提问卡（倒计时、先到先得、结算收卡）
features/files/    文件列表 / 上传 / 下载
features/push/     getToken / 登记 / 深链路由 / 通知栏动作
features/usage|automations|plugins/   P1
```

#### 6.3 语音与文件细节

- 语音输入：AudioCapturer 录音（建议 AAC/m4a）→ base64 → `stt.transcribe`
  （mime `audio/mp4`）；容器/编码与设备 STT provider 的兼容面需真机实测，
  失败如实提示（服务端只中转，不改接口）。
- 朗读：`tts.synthesize` 回执 base64 → AVPlayer 播放；长文本分块边播边取。
- 能力门控：`client.status.voice.stt/tts` 为假时**不渲染**麦克风/朗读按钮（不是 disabled）；
  `center.allowFileTransfer` 为假时不渲染发文件按钮；`center.inputAttachments` 为假时
  不提供图片粘贴。

### 7. 推送集成（Push Kit，后台触达的唯一可靠通道）

#### 7.1 前置（AGC 配置，产品/运营侧）

- AppGallery Connect 建项目与应用，开通推送服务；**项目级服务账号密钥**给服务端
  （Center 管理端 `PUT /api/admin/push` 配置 projectId/keyId/subAccount/privateKey）。
- 应用签名证书指纹登记到 AGC；`module.json5` 配 `client_id`（OAuth 2.0 客户端 ID）。
- 申请**自分类权益**（确认/提问类通知的 category，如 WORK/DEVICE_REMINDER），
  否则按营销消息限流，到达率不可接受。
- **产品约束**：推送凭据绑定 App 的 AGC 项目——官方 App 的密钥不会分发给自托管
  Center。自托管用户未配置推送时 `POST /api/push/register` 回 **503 E_PUSH_UNAVAILABLE**，
  App 必须优雅降级为「前台实时、后台无通知」，并在设置页如实说明。
- 鸿蒙 NEXT 推送数据处理地固定为中国，隐私声明需写明。

#### 7.2 客户端流程

```
每次启动：pushService.getToken() → 与本地缓存比对 → 变化则上报：
POST /api/push/register  { platform: 'harmony', token, deviceName, appVersion }
  → 200 { ok, id } | 503 E_PUSH_UNAVAILABLE（降级）
登出：POST /api/auth/logout（服务端级联清登记）；可选 pushService.deleteToken()。
通知权限：首次启动 notificationManager.requestEnableNotification() 申请。
```

- token 在卸载重装 / 恢复出厂 / deleteToken 后会变，**不要固定判断长度**，每次启动上报。
- 通知点击：服务端用 `clickAction: { actionType: 0, data }`，data 经 **Want.parameters**
  透传（≤1024 字节）。冷启动在 `onCreate(want)`、热启动在 `onNewWant(want)` 读取：

```json
{ "kind": "confirm|ask|file|done|error",
  "clientId": "…", "sessionId": "…",
  "confirmId|requestId|fileId": "…", "expiresAt": "…" }
```

- 深链路由：先恢复会话（refresh）→ 连 WS → `GET /api/pending` 对账 →
  kind=confirm/ask 直达对应卡片（**先查 expiresAt / pending，过期如实显示「已超时」**，
  60s/180s 窗口很短）；kind=file 跳文件页；done/error 跳对应会话。
- 通知栏动作按钮（P1）：「批准/拒绝」→ REST `confirm.resolve`；「去回答」→ 深链。
  批复后本地更新通知状态；409/失效要提示。
- 离线缓存语义：服务端按 kind 分组 collapseKey（离线每组只留最新一条）+ ttl
  （确认=窗口剩余、提问=窗口剩余、其余 1h）——**App 打开后一律以 pending 快照为准**，
  不信任通知的时效。
- 推送载荷不含会话内容（服务端保证）；App 侧也不要把通知内容写进日志。

### 8. 安全与质量红线

- 令牌只存 HUKS；日志脱敏（令牌/密码/会话内容一律不进日志）。
- 发布包强制 HTTPS；明文放行只进调试包。
- 不绕过任何闸门：设备侧 `center.allow*` 关闭时命令会回 E_REMOTE_DISABLED，如实展示。
- 确认卡批复是安全敏感操作：通知栏快捷批复也要展示工具名与设备名，误触要有撤销提示
  （批准后不可撤销，文案写清）。
- 崩溃兜底：WS 畸形帧 / JSON 解析失败只丢弃该帧，不得让进程崩溃。
- 单元测试：协议编解码、回执配对（含 ask.resolve 例外）、重连退避、令牌恢复链、
  深链路由（过期/失效分支）。

### 9. 验收清单（真机）

1. 登录 → 杀进程重启 → 免登录；**重启 Center 服务器** → App 仍登录（持久会话）。
2. 令牌剩余 <7 天自动 refresh；refresh 后旧令牌请求 401 → 恢复链生效。
3. 设备列表在线态随 PC 上下线实时变化（WS 快照，非轮询）。
4. 远程会话：发消息 → 流式正文/思考/工具卡 → done；停止按钮生效；历史回放正确。
5. PC 触发敏感操作 → 手机**后台**收到推送 → 点开在 60s 内批准成功；超时显示已失效。
6. 提问卡：选项/自由文本/多问作答；PC 先答 → 手机卡立即收起（ask.settled）。
7. 文件：手机上传 → PC 落盘通知；PC 发文件 → 手机推送 → 下载保存成功。
8. 手机前台（WS 在线）时不重复收推送；退后台后恢复推送。
9. 未配置推送的自托管 Center：register 503 → 降级文案，前台功能全部正常。
10. 登出 → 推送登记级联清除（再触发事件不再收推送）。

### 10. 里程碑

- M1：工程骨架 + 鉴权（HUKS/refresh/恢复链）+ ArkWeb 壳 + 设备列表（混合）或 WS 客户端（原生）。
- M2：会话流 + 确认/提问卡 + 历史回放 + 文件收发。
- M3：推送全链路（AGC 联调：先用 `testMessage` 测试消息，单项目 1000 条上限）+ 深链 + 偏好。
- M4：P1（通知栏动作、用量、自动化、插件面板、语音）+ 送审（HTTPS/隐私/最低功能性）。

### 11. 参考

- 上游契约 SSOT：https://github.com/LinePixel2025/Aurora `docs/12-aurora-center.md`
  （§4 网页协议、§15 鸿蒙遥控台接入；Center 0.7.0）。
- Push Kit REST v3 请求体：https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/push-scenariozed-api-request-struct
- Push Kit 常见错误码（80300002/80300007）：https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/push-kit-faq-00001
- 获取 Push Token：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-preparations-0000001727885250
- 明文 HTTP 与网络安全配置：https://developer.huawei.com/consumer/cn/blog/topic/03221416988130045
- 通知点击跳转与 Want 传参：https://developer.huawei.com/consumer/cn/forum/topic/0208228913886137568

（提示词正文到此结束）

---

## 附：给项目发起人的备注（不用粘贴）

- 服务端已就绪：Aurora 仓库 Center **0.7.0**（`packages/center`），本文契约对应
  `docs/12 §15`，单测 201 条全绿。部署按 `packages/center/deploy/README.md`。
- 推送联调顺序：AGC 开通 → 服务端 `PUT /api/admin/push`（testMessage=true）→
  真机 getToken 上报 → 触发确认卡验证到达 → 关 testMessage 申请自分类权益。
- 若决定做纯原生而非混合壳，§5.5 的渲染契约工作量最大（网页端经 54 个验收场景打磨），
  建议先混合壳上线验证推送链路，再原生化热路径。
- 官方推送中继（让自托管 Center 也能推官方 App）尚未立项，见上游提案 R1。
