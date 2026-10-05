# 12 · Aurora Center —— 网页端控制中心

状态：`已定稿`（v0.2.0 随本设计首次落地；2026-09 扩展轮：注册、设备授权登录、确认卡网页批复、文件 24h 管理与自动删除、移动端适配，并删除手动配对令牌；v0.2.5：§6.3 追加 `automation.*` 六命令、§10 追加自动化视图；
v0.3.3：§4/§5 追加 `ask.request` / `ask.resolve`（提问中转）、§6.1 补语音能力位的重连语义、
§10 整节按三栏控制台重写并补验证 harness）

Aurora Center 是与 Aurora 桌面客户端配套的**独立服务器 + Web 控制台**：

- 安装了 Aurora 的客户端可以连接到 Center，Center 的 Web 端能远程给某个客户端的
  Aurora 发送指令（**单开一个 Session**）、接收回答；
- 用户要求客户端 Aurora 发送文件时，Agent 通过 `center_send_file` 工具把文件传到
  Center，网页端直接下载；
- Center 可以远程修改客户端的一定配置（Agent 各项开关、切换模式），但受客户端侧
  **白名单**约束（见 §7）；
- 服务器是**纯 Node 程序**，Windows / Linux 均可运行，带 `aurora-center` CLI
  （一键启动、建账户、自更新）；
- Web 端外观与桌面端同源：**HarmonyOS Sans**、大圆角卡片、克制的灰阶与毛玻璃顶栏。

## 1. 总体拓扑

```
┌──────────────┐  WebSocket(出站, Bearer 登录令牌)  ┌───────────────────────────┐
│ Aurora 桌面端 │ ────────────────────────────────▶ │ Aurora Center (packages/  │
│ main/center/ │ ◀──────── cmd / event ─────────── │ center，纯 Node)          │
└──────────────┘   HTTP POST /api/ingest/files    │  ├─ HTTP + WS 服务器       │
                                                  │  ├─ Web UI (dist-web SPA) │
                                                  │  └─ 数据目录 ~/.aurora-   │
┌──────────────┐  REST 登录 + WS 订阅              │      center/              │
│ 浏览器（用户/ │ ────────────────────────────────▶ └───────────────────────────┘
│ 管理员）     │ ◀──────── clients/event ─────────
└──────────────┘
```

- **客户端 → Center 的连接是客户端发起的出站 WebSocket**：客户端无需暴露端口、
  无需公网 IP；Center 只需自身可达（内网或公网均可）。
- Center 单进程单端口：`/api/*`（REST + WS 升级）、`/api/ingest/*`（客户端上传）、
  其余路径静态服务 Web UI（`packages/center/dist-web/`，SPA 用 hash 路由）。

## 2. 模块与数据

### 2.1 代码位置

| 模块 | 位置 | 说明 |
|---|---|---|
| 协议类型 | `packages/shared/src/center/protocol.ts` | 客户端 / 服务器 / Web 三方共享的 JSON 契约（纯类型，无 Node 依赖，渲染层可 `import type`） |
| 服务器 | `packages/center/src/` | 纯 Node：`server.ts`（HTTP+WS 装配）、`auth.ts`（账户/令牌）、`hub.ts`（路由）、`clients.ts`、`files.ts`、`store.ts`（数据目录持久化）、`update.ts`（自更新）、`cli.ts` |
| Web UI | `packages/center/web/` | Vue 3 + vite SPA，构建到 `packages/center/dist-web/`（服务器静态服务） |
| 客户端连接器 | `apps/desktop/src/main/center/` | `connector.ts`（WS 客户端 + 重连）、`remote-control.ts`（远程配置）、`session-bridge.ts`（远程会话） |
| Agent 工具 | `packages/agent-core/src/tools/center.ts` | `center_status` / `center_send_file`（经 `CenterPort` 注入，内核不碰网络） |

### 2.2 Center 数据目录（默认 `~/.aurora-center`，`--data` / `AURORA_CENTER_DATA` 可改）

| 文件 | 内容 |
|---|---|
| `config.json` | `{ version, port, host }` 服务器自身配置 |
| `users.json` | 用户账户：`{ id, username, role: 'admin'\|'user', passHash, passSalt, createdAt }`（密码 scrypt 哈希，绝不存明文；`config.json` 的 `allowRegistration` 控制是否开放自助注册，默认开） |
| `tokens.json` | 客户端令牌（账号登录 / 设备授权颁发）：`{ id, userId, tokenHash(SHA-256), label, clientId, createdAt, revokedAt? }` —— **令牌明文只在登录 / 授权响应时出现一次**；同 `clientId` 重登自动吊销旧令牌 |
| `clients.json` | 已登记客户端：`{ clientId, name, ownerUserId, version, platform, firstSeenAt, lastSeenAt, lastMode, revokedAt? }` |
| `files/<fileId>-<name>` + `files/index.json` | 客户端上传文件的暂存与索引；**每条带 `expiresAt`（上传 + 24h），过期自动清理**（启动清一次 + 每 15 分钟一轮） |
| `server.lock` | **服务器运行标记**（v0.2.9）：`{ pid, startedAt }`，`start` / `listen` 成功后创建、`close()` 删除、每 15s 刷 mtime —— CLI 的 `users` 写命令据它拒绝与运行中服务器并发写 `users.json`（§9）；mtime 超过 60s 未刷新视为崩溃残留（当作无服务器） |

所有 JSON 落盘沿用仓库约定：**原子写（临时文件 + rename）**，读损坏备份后重建。

## 3. 鉴权模型

| 主体 | 凭据 | 能做什么 |
|---|---|---|
| 网页用户（`role: 'user'`） | REST `POST /api/auth/login`（或注册后自动登录）换会话令牌（随机 32B hex，内存持有，7 天过期） | 看到**自己名下**的客户端；对自己的客户端发起会话 / 远程配置 / 批准确认卡 / 收发文件管理 |
| 网页管理员（`role: 'admin'`） | 同上 | **看到并控制所有客户端**（跨属主"超限控制"）；管理用户（增删、重置密码）；吊销客户端 |
| Aurora 客户端 | 客户端令牌（WS 握手 `Authorization: Bearer`） | 维持长连接、收命令、传事件、上传文件；一个令牌**创建即绑定**一个 `clientId`，不得复用到第二台机器 |

- 首个管理员由 CLI 创建（`aurora-center init` / 首次 `start` 自动生成并打印一次性密码）。
- **自助注册**：`POST /api/auth/register`（用户名 3–32 位字母数字下划线连字符、密码 ≥ 8 位），
  成功即创建 `role:'user'` 并直接登录；服务器 `config.json` 的 `allowRegistration`（默认 true）
  可整体关闭。
- **客户端接入主路径有两条**（手动配对令牌已删除）：
  1. **账号登录**：客户端在设置页填写服务器地址与 Center 账号密码 → `POST /api/client/login`
     （§4.2）校验密码后颁发**归属该用户、创建即绑定该 `clientId`** 的客户端令牌 → 客户端存入
     安全存储（`center.token` 凭据链路）并自动连接。每次登录都会重发新令牌并**吊销同
     `clientId` 的旧令牌**；密码本身**绝不落盘**。
  2. **设备授权登录（推荐，v0.2.2 起）**：客户端设置页点「登录账户」→ `POST /api/client/device/start`
     取得设备码与确认页地址 → 自动打开浏览器进入 Center 网页 `#/device?code=<userCode>` →
     用户在网页**注册 / 登录后一键确认** → 客户端轮询 `POST /api/client/device/poll`
     拿到令牌自动接入（§4.3）。适合不想在桌面端输入密码的场景，网页上还可以顺带完成注册。
- 一个用户可以同时在多台机器登录（每台一个 `clientId`，各自持有独立令牌）；每个用户
  （除管理员）在网页端**只能看到自己名下的客户端**，事件（会话 / 文件 / 确认卡）也只
  路由给属主 + 管理员。
- **认证端点限速**（v0.2.9）：`/api/auth/login` 与 `/api/client/login` 共用一把按**源 IP**
  的滑动窗口计数器（**只记失败**：成功登录不消耗额度），窗口内失败达 **5 次 / 分钟** 后
  返回 `429 {"error":"E_RATE_LIMITED"}`（此后连正确密码也一并挡住，直到窗口滚过）；
  `/api/auth/register` 10 次/分钟、`/api/client/device/start` 30 次/分钟（各作用域独立）。
  源 IP 取 socket 地址（`req.socket.remoteAddress`），**不读 `x-forwarded-for`** ——
  当前是直连部署（无反代），放到反代后面必须先改这一处的取值口径，否则所有请求会共用一个键。
  限速只作用于上述认证端点：WS 心跳、`/api/me` 等常规 API 不受影响。参数集中在
  `server.ts` 的 `AUTH_RATE_LIMITS`。
- **密码校验异步**（v0.2.9）：`scryptSync` → `crypto.scrypt`（线程池），登录 / 注册 / 改密
  不再阻塞事件循环（同步版每次约 32ms，公网穷举几十 req/s 就能让 WS 心跳被误判超时）。
- **网页会话表有界**（v0.2.9）：颁发会话时清扫过期项，并按上限（默认 10000 条）淘汰最旧。
- **属主跟随当前有效令牌**：客户端 hello 登记时 `ownerUserId` 以其令牌属主为准 ——
  设备被释放（令牌吊销）后由另一账号登录即可接管归属；属主未释放前，登录（409
  `E_CLIENT_BOUND`）与设备授权确认都会拒绝抢注。
- Web 会话令牌与客户端令牌都只存哈希，泄露数据库不等于泄露凭据。

## 4. 协议（`packages/shared/src/center/protocol.ts`）

三方向消息都是 `{ type, ... }` JSON。**协议演进只增不改**：消费方对未知 `type` 一律忽略。

### 4.1 客户端 ⇄ 服务器（长连 WS）

```
客户端 → 服务器
  { type: 'hello', hello: ClientHello }        // 连接后第一条；ClientHello 含 clientId/name/version/platform/mode/capabilities
  { type: 'status', status: ClientStatus }     // 状态快照（连接后、配置/模式变更时）
  { type: 'result', requestId, ok, data?, error? }
  { type: 'session.event', sessionId, event }  // event 为内核 AgentEvent 原样转发（JSON 可序列化）
  { type: 'confirm.request', request }         // 敏感工具确认请求（ConfirmRequestPayload：confirmId/sessionId/toolName/input/createdAt/expiresAt）
  { type: 'ask.request', request }             // 向用户提问的请求（AskUserRequestPayload，v0.3.3；§5 第 4 步）
  { type: 'ask.settled', requestId, sessionId, outcome }  // 提问已在客户端结算（本轮；outcome = answered/skipped/timedOut/aborted）

服务器 → 客户端
  { type: 'welcome', serverVersion, clientId }
  { type: 'cmd', cmd: CenterCommand }
  { type: 'ping' }                             // 心跳；客户端回 'pong'（在 result 通道之外固定处理）

CenterCommand =
  | { kind: 'session.input',  requestId, sessionId, text }
  | { kind: 'session.abort',  requestId, sessionId, agentRequestId }
  | { kind: 'config.get',     requestId }
  | { kind: 'config.update',  requestId, patch }      // 白名单校验后落到 SettingsStore（§7）
  | { kind: 'mode.switch',    requestId, mode }       // 等价 config.update 的 modes.current，语义独立成命令
  | { kind: 'confirm.resolve', requestId, confirmId, approved }  // 网页端确认卡批复的转发
  | { kind: 'ask.resolve', requestId, sessionId, answers, skipped?, answersByQuestion? }  // 网页端提问卡作答的转发（v0.3.3，§5）；result.data 携带 { settled }
  | { kind: 'session.history', requestId, sessionId } // 历史回放（v0.2.4，§6.3）；result.data 携带 CenterSessionHistoryMessage[]
  | { kind: 'session.readImage', requestId, sessionId, imageId } // 对话图片读取（v27，§14）；result.data 携带 { dataUrl, name, mime }，服务器不缓存
  | { kind: 'session.setModel', requestId, sessionId, providerId?, model }  // 会话级模型覆盖（本轮，§6.3）；model 为空串 = 清除覆盖
  | { kind: 'file.send',      requestId, fileId, name, size }  // 服务器 → 客户端下发文件（本轮，§5）；客户端用自身令牌下载后落盘
  | { kind: 'stt.transcribe', requestId, audioBase64, mime }  // 语音识别中转（v0.3.2，§6.4）；客户端用本机已配 provider 转写
  | { kind: 'tts.synthesize', requestId, text }               // 朗读合成中转（v0.3.2，§6.4）；result.data 携带 { audioBase64, mimeType }
```

- `sessionId` 由**服务器分配**，固定形如 `center-<短随机串>`（客户端渲染层据此把
  远程会话与本地会话区分开）。
- 客户端收到 `session.input` 后走与 `chat:send` **同一条** `agent.send()` 通路
  （`origin: 'center'`，docs/06 §4.1 的 job 体系照常生效）；`E_BUSY` / `E_NO_MODEL`
  等错误自然以 `session.event`（error 事件）回传网页端。

#### 上线 / 下线的时效（2026-09-29 提速）

网页端的「在线」= **此刻服务器上还有没有这条连接**（`hub.clientConns`），
每次变化都由 `broadcastClients()` 推全量快照（**没有轮询**）。因此各段耗时上限就是
用户感知的「上线 / 下线快慢」，逐段定值如下：

| 环节 | 触发 | 现状 | 旧值 |
|---|---|---|---|
| 上线（HTTP 升级 → `hello` → 注册 → 广播） | 客户端 `start()` 拨号 | 毫秒级（注册后**立即**广播，不等心跳） | 同 |
| 下线（正常退出 / 关窗口） | WS `close` 帧 | 毫秒级 | 同 |
| 下线（半开连接：拔网线 / 休眠 / 硬杀） | 服务器心跳判死 | 15s 一拍 × **2 拍** = 最坏 **30s** 后 `terminate()` | 30s × 3 = 90s |
| 客户端检测服务器失联 | 客户端心跳看门狗 | 45s 无 `ping` 即主动断开重连（`SERVER_PING_TIMEOUT_MS`），不等 TCP 超时 | 无（只有服务端兜底） |
| 客户端重连 | 退避计时器 | 1s 起、指数、**5s 封顶** + ±20% 抖动 | 30s 封顶 |
| 网页端自己掉线后重连 | WS `onclose` | 1s 起、指数、**5s 封顶** | 15s 封顶 |
| 桌面端启动到拨号 | `bootstrap()` 末尾 | MCP 建连**不再阻塞**（`void mcp.start()`，此前单台连不上的 MCP 服务器可推迟最多 30s） | 串行 `await` |

`hub.removeClient(clientId, conn)` 带**连接身份校验**：同一 clientId 的重连场景下，
旧 socket 迟到的 `close` 不会把刚注册的新连接删掉（否则设备会显示离线且要等下次重连才恢复）。

Web UI 的两处消费口径：控制台（`ClientList`）与**管理端「全部客户端」表**都读同一份
WS 快照（管理端的 REST 只做首次水合），页面停留期间在线位随推送实时变 —— 管理端此前是
一次性 REST 快照，停在那一页永远看不到变化。

### 4.2 网页 ⇄ 服务器

REST：`POST /api/auth/login`、`POST /api/auth/register`（§3）、`POST /api/client/login`（**无需已登录**：
客户端用 `{ username, password, clientId }` 换客户端令牌）、**设备授权三端点**（§4.3，`start` / `poll`
无需登录，`authorize` 需网页会话）、`GET /api/me`、`GET /api/clients`（按角色过滤）、
`GET /api/files`（文件清单，属主过滤）、`GET /api/files/:fileId`（**网页会话**鉴权下载）、
`POST /api/uploads`（**本轮**：网页上传给指定客户端，`?clientId=` 目标；网页会话鉴权）、
`DELETE /api/files/:fileId`（属主或管理员删除）、管理员 `POST /api/users`、`GET /api/admin/clients`、
`DELETE /api/users/:id`、`DELETE /api/admin/clients/:id`（吊销客户端）。
另有一条**客户端令牌**鉴权的下载路由 `GET /api/client/files/:fileId`（**本轮**，`Bearer <clientToken>`
+ `X-Client-Id`）：`file.send` 命令里客户端据此把文件拉回本机 —— 原有的 `/api/files/:id` 只认网页会话，
客户端令牌拿不到，两条路由的鉴权口径不可互换。

WS（登录令牌经 `?token=` 传递——浏览器 WebSocket 无法自定义请求头）：

```
网页 → 服务器
  { type: 'session.create', requestId, clientId }
  { type: 'session.input',  requestId, clientId, sessionId, text }
  { type: 'session.abort',  requestId, clientId, sessionId, agentRequestId }
  { type: 'config.get',     requestId, clientId }
  { type: 'config.update',  requestId, clientId, patch }
  { type: 'mode.switch',    requestId, clientId, mode }
  { type: 'confirm.resolve', requestId, clientId, confirmId, approved }
  { type: 'ask.resolve', requestId, clientId, sessionId, answers, skipped?, answersByQuestion? }  // 提问卡作答（v0.3.3，§5）
  { type: 'session.history', requestId, clientId, sessionId }  // 历史回放（v0.2.4，§6.3）
  { type: 'session.setModel', requestId, clientId, sessionId, providerId?, model }  // 会话级模型（本轮，§6.3）
  { type: 'file.send', requestId, clientId, fileId }           // 把暂存文件推给该客户端落盘（本轮，§5）
  { type: 'stt.transcribe',  requestId, clientId, audioBase64, mime }  // 语音识别中转（v0.3.2，§6.4）
  { type: 'tts.synthesize',  requestId, clientId, text }               // 朗读合成中转（v0.3.2，§6.4）

服务器 → 网页
  { type: 'clients', clients: ClientInfo[] }              // 连接后与每次变动时的全量快照
  { type: 'client.status', clientId, status }             // 单个客户端状态/元数据更新
  { type: 'client.event',  clientId, sessionId, event }   // 转发的会话事件
  { type: 'result', requestId, ok, data?, error? }
  { type: 'file.received', fileId, clientId, name, size, note?, at }
  { type: 'confirm.request', clientId, sessionId, request }  // 客户端转来的确认卡
  { type: 'ask.request', clientId, sessionId, request }      // 客户端转来的提问卡（v0.3.3）；网页重连时服务器回放未过期项
  { type: 'ask.settled', clientId, sessionId, requestId, outcome }  // 提问已在客户端结算（本轮），网页据此收起卡片
```

路由规则（`hub.ts`）：命令按 `clientId` 找到该客户端的连接；`session.event` / `confirm.request` /
`ask.request` / `file.received` 按**会话 / 客户端属主**（发起 `session.create` 的网页用户）+
全部管理员回传；`confirm.resolve` / `ask.resolve` 只转发给该客户端的连接。属主关系由服务器记账
（`sessionId → webUserId`），不信任客户端自报。

**确认卡与提问卡的两处差异**（都源于提问窗口更长，180s vs 60s）：

| | 确认卡（v0.2.2） | 提问卡（v0.3.3） |
|---|---|---|
| 触发者 | 敏感工具（`sensitivity: 'confirm'`）执行前 | `ask_user` 工具（`safe` 级，不进确认链） |
| 超时 | 60s，超时**按拒绝** | 180s，超时**按「用户未回答」**继续（模型说明假设） |
| 客户端离线 | 补发队列（FIFO 20，重连 flush） | 同款补发队列 |
| 网页刷新后 | **不回放**（窗口短，属既有行为） | **回放未过期项**（`pendingAsks`，见下），否则刷新一下就永远答不上 |
| 客户端先作答/超时 | 本地结算即结束（网页卡随之失效） | 客户端上行 `ask.settled`（本轮）→ 服务器摘除 `pendingAsks` 并广播，网页卡**立即收起** |

`hub` 的 `pendingAsks`（requestId → 请求体）只在内存里、按 requestId 幂等覆盖，
在 `ask.settled`（客户端结算，本轮）、网页 `ask.resolve`、或过期后被清除；客户端断开
（`dropClientSessions`）时**连同该客户端的条目一起清** —— 否则离线陈旧提问会被新页签回放、
点了必然得到 `E_CLIENT_OFFLINE`。`registerWeb` 时随 `sendStatusTo` 一起回放未过期项 ——
**不新增任何持久化**（与"服务器不缓存会话内容"同口径，这里缓存的是一条尚未结算的待答问题）；
提问的**长期留痕**在客户端（会话文件 `asks` sidecar，§5），历史回放时随 `session.history` 回来。

### 4.3 设备授权登录（docs/12 §3 主路径 2）

```
POST /api/client/device/start    { clientId }                    （无需登录）
  → { deviceCode, userCode, verifyUrl, expiresAt, intervalMs }    deviceCode 43 位随机、
                                                                   userCode 形如 ABCD-1234
                                                                   （展示给用户核对）、10 分钟有效
POST /api/client/device/poll     { deviceCode, clientId }        （无需登录；按 intervalMs 轮询）
  → { status: 'pending' } | { status: 'approved', token, username }
    | { status: 'expired' } | { status: 'denied' }                approved / denied / expired 后挑战删除
POST /api/client/device/authorize { deviceCode, approve }        （需网页会话；网页端 #/device 页调用）
  → approve=false 置 denied；approve=true 校验属主护栏（clientId 已绑其他账号 → 409 且挑战置 denied）
    后用 mintClientToken 为当前网页用户颁发并绑定 clientId
GET /api/client/device/info?code=<userCode>                      （无需登录；#/device 页把
  → { deviceCode, expiresAt }                                      URL 里的 userCode 换回 deviceCode）
```

- 挑战**只存内存**（重启即失效，客户端重新发起即可），`start` 时先清扫过期项；表有上限
  （默认 1000 条，v0.2.9），超限**淘汰最旧**——既不永续增长，也不给"刷满上限把新设备挡在
  门外"的攻击留口子。该端点另有 30 次/分钟的按源 IP 限速（§3）。

流程：客户端设置页点「登录账户」→ start → `shell.openExternal(verifyUrl)` 打开浏览器 →
用户在网页注册 / 登录并确认 → 客户端轮询 approved 拿令牌落 `center.token` 凭据链路、自动重连。

## 5. 远程会话与文件发送

1. 网页端对某客户端点「新建会话」→ `session.create` → 服务器分配 `center-*` sessionId
   并记账属主 → 网页端进入会话视图；
2. 用户输入 → `session.input` → 服务器包成 `cmd` 发给客户端 → 客户端
   `agent.send({ sessionId, text, origin: 'center' })`；
3. 客户端把该会话的全部 AgentEvent（正文增量 / 思考 / 工具卡 / 任务清单 / 子代理 / done / error）以
   `session.event` 回传 → 服务器按属主路由 → 网页端按 `messageId` 聚合渲染；
4. **敏感工具确认（v0.2.2 起）**：远程会话中工具触发确认卡时，客户端在弹**本机**确认卡的
   同时把 `confirm.request` 推给 Center → 网页端（属主 / 管理员）看到工具名、入参摘要与
   倒计时，可「批准 / 拒绝」→ `confirm.resolve` 转回客户端调 `proactive.resolve`。两条通道
   先到先得（`proactive.resolve` 对已结算 confirmId 幂等）；客户端离线 / 超时（默认 60s）
   一律按拒绝。
   **推送范围（v0.2.4 起）**：仅 `center-` 前缀会话全量推送（v0.2.3 曾对本地会话的
   `center_send_file` 也推送；v0.2.4 起该工具改为直接发送、不再走确认链路，本地会话
   不再有需要推网页端的确认卡）；连接器短暂离线期间的
   确认请求进**补发队列**（FIFO 上限 20 条，重连后 flush；长时间离线仍按本地 60s 超时拒绝）。
   网页端除会话视图内的卡之外，另有**全局待批复确认卡栏**（ConsoleView 顶部）展示所有未过期
   请求——本地会话来源的请求没有会话视图，只能在这里批复；
   **向用户提问（`ask_user`，v0.3.3 起；本轮补齐流内渲染与留痕）**：Agent 在远程会话里调用
   `ask_user` 时，客户端在弹本机提问卡的同时把 `ask.request` 推给 Center
   （`AskUserService.onRequest` → 仅 `center-` 前缀会话上行，离线进同一补发队列）→
   网页端在**该会话的消息流内**渲染提问卡（未打开该会话时另在顶部待办栏列一条，点进去即可作答，
   两处都可答、与会话内本地卡**先到先得**）→ 作答经 `ask.resolve` 转回客户端调
   `AskUserService.resolve`（已结算 / 未知 requestId 返回 `false`，网页端据此提示"已失效"）→
   Agent 在**同一次请求内**拿到答案继续。多问卡的 `questions` / `allowCustom` 与作答的
   `answersByQuestion` 全链透传（v0.3.5 起，此前网页端只按首问降级渲染、逐问作答会被拍平）。
   超时（180s）/ 跳过 / 中止都按「用户未回答」结算，模型说明假设后继续，不挂死；网页刷新后
   服务器回放未过期的提问（`pendingAsks`，§4.2）。**客户端先作答 / 超时 / 中止时上行
   `ask.settled`（本轮）**：服务器摘除 `pendingAsks` 并广播，网页卡立即收起 ——
   此前本地结算不外发，网页卡会一直挂着倒计时、直到用户点了提交才被告知已失效。
   提问的**长期留痕**（问题、选项、作答、结算原因）随会话文件持久化（`StoredSession.asks`），
   历史回放（第 7 步）时作为 `kind: 'ask'` 的条目回到网页端，渲染成**只读的已结算卡**
   —— 刷新页面 / 换设备后「刚才问了什么、答了什么」仍然可见；
5. 「发送文件」：用户在远程会话里让 Agent 发文件 → Agent 调 `center_send_file`
   （§8）→ 客户端 HTTP `POST /api/ingest/files`（客户端令牌鉴权，尺寸受
   `center.maxFileMb` 限制）→ 服务器落盘并 `file.received` 通知 → 网页端出现
   下载卡（`GET /api/files/:fileId`，属主或管理员可下载）。**所有上传文件 24h 后自动删除**
   （索引带 `expiresAt`，启动 + 每 15 分钟清理一轮）；`#/files` 文件管理页可查看 / 下载 /
   手动删除（§10）。`center_send_file` **不逐次确认、直接发送**（v0.2.4：闸门在配置层
   —— `center.enabled` / `center.allowFileTransfer` / `center.maxFileMb`，见 §8 与
   docs/06 §11.2）；
   **反方向「网页 → 客户端」（本轮）**：网页端在控制台对选中设备点「发送文件」
   （或文件管理页对某条暂存文件点「发送到客户端」）→ `POST /api/uploads`（网页会话鉴权，
   `?clientId=` 指目标）把文件存进同一个 `FileStore`（`source: 'web'` 标记来源）→
   WS `file.send` → 服务器查索引补齐 name/size 后下发 `cmd` → 客户端校验
   `center.allowFileTransfer`，再用**自身令牌**走 `GET /api/client/files/:fileId` 流式拉回，
   落盘到本机下载目录（重名追加 ` (1)`，超 `center.maxFileMb` 拒绝）并弹系统通知告知路径，
   回执带 `{ path }`。该命令的待回执超时**放宽到 10 分钟**（大文件远超 15s，
   否则服务器会先超时把成功下载报成 `E_CLIENT_TIMEOUT`）；
6. **会话管理（v0.2.3 起，仅 `center-` 会话，§6.3）**：网页端可枚举客户端的远程会话
   （`session.list`）、让客户端主界面切到某个会话（`session.activate`）、为会话开关
   **客户端左栏可见性**（`session.visibility`，缺省可见，隐藏仍可远程输入）、覆盖
   **会话级权限档**（`session.setPermission`，SessionMeta 数据，不动全局
   `agent.permissionMode`）、绑定**会话级项目**（`session.setProject`，复用 docs/06 §5.1
   会话级项目链）、覆盖**会话级模型**（`session.setModel`，本轮：写会话文件
   `meta.llm = { providerId, model }`，`model` 为空串 = 清除覆盖回落全局，
   与全局 `llm.switch` 是两份数据 —— 详见 §6.3）。历史 center- 会话（客户端侧已存在、
   非本页签创建）的事件流对属主可见
   （服务器在 `sessionOwners` 未命中时回落到客户端登记表的属主）；
7. **历史回放（v0.2.4 起，仅 `center-` 会话）**：网页端打开某个远程会话时发
   `session.history` → 服务器按普通命令转发（授权 / 离线判定同其他命令）→ 客户端从
   SessionStore 读该会话的渲染层历史（`rendererHistory`，最近 200 条）经 `result` 回执
   带回 → 网页端映射进会话 items（助手消息按存储消息 id 对齐、用户消息按内容去重，
   与实时事件聚合同一套口径；可选 `requestId` 用于请求级工作折叠，旧客户端缺字段时按相邻
   助手消息回退）。**服务器不缓存任何会话内容**——历史只在回执里路过；
   `applyEvent` 对未见过的会话**补建空壳再应用**（不再丢弃），事件先于历史到达时
   按 id / 内容去重合并，历史条目排在实时条目之前；
8. **可见性变更的客户端同步（v0.2.4 起）**：`session.visibility` 在客户端落盘成功后，
   客户端主进程经 `chat:centerVisibilityChanged` 推送通道（docs/12 §6.3）通知 chat 渲染层
   重拉会话列表 —— 左栏立即按新可见性过滤，无需重启或手动刷新。

远程会话在客户端主界面左栏的历史里**默认可见**（`center-*` 前缀），用户可随时查看
甚至继续输入；Center 可按会话关闭可见性（§5 第 6 步 `session.visibility`，隐藏的会话
不出现在客户端左栏但仍可远程输入）。远程与本地对同一会话的写入顺序由客户端串行化
（AgentHost 的 `active` 槽本身按会话互斥，`E_BUSY` 是唯一交叉语义）。

## 6. 状态快照与远程配置

### 6.1 ClientStatus（连接后与每次相关变更时上报）

```ts
{ mode, version, platform,
  agent: { permissionMode, tools: { enabled, files, search, open, terminal } },
  center: { allowRemoteSession, allowRemoteConfig, allowFileTransfer },
  llm: { activeProviderId, model, reasoningEffort },   // v0.2.3 起
  voice: { stt: boolean, tts: boolean } }              // v0.3.2 起：本机语音能力位（§6.4）
```

`voice` 为**可选字段**（旧客户端不下发）：`stt` = 本机 STT 可用（`stt.enabled` + 激活
provider 的 `baseUrl`/`model` 齐全，同桌面端门控口径）；`tts` = 本机 TTS 可用。网页端据此
决定**是否渲染**麦克风 / 朗读按钮（未配置连按钮都不出现，不是 disabled）——字段缺失时
按钮不渲染（向后兼容旧客户端）。

能力位随**每一次** `status` 上行刷新：连接建立、`settings:changed`（改 STT/TTS 配置即触发）、
远程命令（`llm.switch` / `config.update` / `mode.switch`）之后都会重报。**重连不丢能力位**：
`hello` 派生的占位快照只带 capabilities、不含 `voice`，因此 `hub.registerClient` 在覆盖已存
快照时**沿用旧 `voice`**（新连接的第一条真 `status` 毫秒级到达即刷新）——否则每次重连都会把
带 voice 的完整快照换成"没有语音"，恰好在此刻新连上的网页页签会读到一个没有麦克风按钮的界面。
⚠️ 排查「配置了语音但网页没有按钮」时按这个顺序看：① 本机设置页是否**启用**了 STT/TTS
（`enabled` + `active` 指向存在的 provider，TTS 还要 `voice` 齐全）——桌面端同款门控，
桌面没有按钮则网页也不会有；② 网页包是否与客户端同版本（语音 UI 自 v0.3.2 才有，
旧镜像 tag 部署的 Center 提供的整份前端根本没有这两个按钮，见 `deploy/README.md`）；
③ 用 `pnpm --filter @aurora/center verify:web:status` 打印服务器侧的 `ClientStatus.voice`。

### 6.2 远程配置白名单（客户端侧强制）

Center 的远程修改**不走** AI 的 `set_setting` 通道，也不受 `SETTINGS_READONLY_PREFIXES`
管辖（那条黑名单防的是 AI 自我提权；Center 是人操作的远端）。但客户端只接受
以下**显式白名单**（`main/center/remote-control.ts` 内的常量），其余一律拒绝：

| 允许的路径前缀 | 对应能力 |
|---|---|
| `modes.current` | 切换工作 / 课堂 / 代码模式（`mode.switch` 命令同源） |
| `agent.tools.enabled` | 电脑操控工具总开关 |
| `agent.tools.files.enabled` / `agent.tools.search.enabled` / `agent.tools.open.enabled` / `agent.tools.terminal.enabled` | 各子开关 |
| `agent.permissionMode` | ⚠️ **不允许** —— 远程改权限档位等于把确认闸门交给远端，白名单不含它 |

刻意**不包含**：凭据类（`llm/mcp/tts/stt/imagegen.providers`）、`agent.tools.terminal.allowPatterns`
（免确认模式，同 `set_setting` 的只读理由）、`projects`（切项目同时改权限边界与注入指令）、
`agent.loop` / `agent.snapshots`。白名单外的补丁**整条拒绝**（不部分应用），回执
`error: 'E_FORBIDDEN_PATH: <路径>'`。

`config.get` 回传**脱敏后**的完整配置（复用主进程 `redactSettings`，密文一律 `***`）。

### 6.3 远程会话管理与 LLM 切换（v0.2.3 专用命令）

通用补丁白名单**不适配**这组能力（`llm.providers.` 前缀会连带放行 `apiKeyEnc`，
`agent.permissionMode` 被明文禁止），因此走**专用命令**（协议见
`packages/shared/src/center/protocol.ts`），服务器只转发、不做白名单预检；授权、
离线判定与 `result` 回执同其他命令：

| 命令（web → server → client） | 语义与边界 |
|---|---|
| `session.list` | 枚举客户端的 `center-` 会话（`CenterSessionSummary[]`：标题 / 更新时间 / projectId / 权限覆盖 / 可见性 / 模型覆盖 `llm`） |
| `session.history`（v0.2.4） | 拉取某个 `center-` 会话的历史（`CenterSessionHistoryMessage[]`，`result.data` 携带；客户端只回 `center-` 前缀会话，最近 200 条）。条目含 `kind: 'message' \| 'ask'`：`ask` 是提问留痕（本轮，渲染成只读已结算卡）；普通消息可带 `requestId` 供请求级折叠。仅用于网页端打开会话时的回放，服务器不缓存 |
| `session.readImage`（v27） | 网页按 `{ sessionId, imageId }` 拉取助手消息图片区的一张图片。客户端从会话工具卡查 imageId、再次校验路径后返回 `{ dataUrl, name, mime }`；本地路径不离开客户端，服务器只转发不缓存 |
| `session.activate` | 让客户端主界面切到指定会话（经 `chat:remoteActivate` 推送通道驱动渲染层 `switchSession`；会话未落盘时客户端兜底创建） |
| `session.visibility` | 开关该会话在客户端左栏的可见性（`SessionMeta.centerVisible`，缺省可见；隐藏仍可远程输入）。落盘成功后客户端经 `chat:centerVisibilityChanged` 推送通知渲染层重拉会话列表（v0.2.4） |
| `session.setPermission` | **会话级权限档覆盖**（`SessionMeta.permissionMode`，生效于该会话的确认判定：会话覆盖 > 全局档）。不动全局 `agent.permissionMode`——全局档仍只能由用户在本机设置页调 |
| `session.setProject` | 会话绑定项目（复用 docs/06 §5.1 会话级项目链；`''` 清除；projectId 必须在客户端 `projects.list` 内） |
| `session.setModel`（本轮） | **会话级模型覆盖**（`SessionMeta.llm = { providerId, model }`，docs/06 §3：会话覆盖 > 全局 `llm.active`）。`model` 为空串 = 清除覆盖；providerId 缺省沿用全局激活 provider。与 `llm.switch` 是**两份数据**：后者改的是全局默认（所有未覆盖会话立刻跟随），本命令只作用于该会话 |
| `project.list` | 客户端项目选项（`CenterProjectOption[]`，绑定下拉用） |
| `llm.switch` | 切客户端模型 / 思考等级：`providerId`（→ `llm.active`）、`model` / `reasoningEffort`（→ 激活 provider 的对应字段，经 `settings.mutate` 即时生效）。**绝不触碰** `apiKeyEnc` / `baseUrl`；可选项列表由网页端从 `config.get` 的脱敏配置取 |
| `automation.list` | 枚举客户端的自动化（`AutomationListResult`：`user` 自建 + `builtin` 内置），docs/13 §10 |
| `automation.catalog` | 组件目录（`AutomationCatalog`：触发器 7 类 + 操作组件 3 类的表单元数据，`available` 现取），供网页端渲染动态表单 |
| `automation.save` | 新建（`definition.id` 为空）/ 修改一份自建自动化；`result.data` 携带保存后的定义。校验与拒绝语义同 `automation_create` 工具（非法组件 / 参数回错误原因） |
| `automation.delete` | 删除自建自动化（内置 `builtin.` 前缀不可删，回错误原因） |
| `automation.run` | 手动触发一次；`result.data` 携带 `{ runId }`（Agent 模式即该次会话 id） |
| `automation.history` | 运行历史（`AutomationRun[]`，`triggeredAt` 倒序；可按 `automationId` / `mode` / `limit` 过滤），服务器不缓存 |

会话管理范围**仅限 `center-` 前缀会话**：客户端本地会话对 Center 不可见、不可枚举、
不可切换。自动化命令**不受该前缀限制**（它们操作的是自动化元数据，不是会话）；但同样受
客户端 `center.allowRemoteSession` 闸门与服务器侧属主 / 管理员鉴权约束。
**自动化定义与历史只存在客户端**（`<userData>/automations/*.json`），服务器零存储改动
—— 与 `session.history` 的「只转发不缓存」同一口径。

### 6.4 语音中转命令（v0.3.2）

浏览器直连 STT/TTS provider 会被 CORS 拦截，且 API Key 不能落浏览器；网页端的语音能力
**经桌面客户端中转**——客户端复用本机已配置的 provider（safeStorage 里的密钥），服务器
只转发命令与回执、零存储（与 `session.history` 同口径）：

| 命令（web → server → client） | 语义与边界 |
|---|---|
| `stt.transcribe` | 网页端录一段音频（webm/opus 或 mp4，`mime` 标明容器）以 base64 随命令上行，客户端调本机 STT service（`main/stt.ts`，协议与桌面端语音输入完全一致）转写，`result.data` 携带 `{ text }` |
| `tts.synthesize` | 网页端把一段文本送客户端 TTS service（`main/tts.ts`）合成，`result.data` 携带 `{ audioBase64, mimeType }`，网页端 blob 播放 |

- 门控：两条命令都受客户端 `center.allowRemoteSession` 闸门约束（同其他中转命令）；
  客户端本机未配置 STT / TTS 时回 `E_VOICE_NOT_CONFIGURED`，网页端按能力位
  （`ClientStatus.voice`，§6.1）**预先不渲染**按钮。
- 时效：STT / TTS 合成耗时可能超过网页端命令的默认 30s 超时，网页端对这两条命令
  的回执等待放宽到 **60s**。
- **已知限制**：网页端录音（`getUserMedia`）需要安全上下文——Center 以 `http://IP:端口`
  裸部署时语音输入不可用（需 HTTPS 反代或 localhost 访问）；朗读（TTS）不受此限。
  v0.3.5 起：点麦克风时若当前是**域名**入口（非 IP / localhost），网页自动切到同路径的
  `https://` 并提示；IP 直连则给出明确提示（浏览器硬限制，代码层无解）。
  另：朗读的 `audio.play()` 发生在合成回执之后，按「瞬态激活」判定自动播放的浏览器
  （Safari）在合成耗时超过激活窗口时可能拒绝播放——表现为「朗读失败」红条，属浏览器
  策略限制，不是链路故障。

## 7. 客户端配置（`center` 分组，CONFIG_VERSION 17）

Schema / 默认值 / 迁移见 docs/08 §1。要点：

- **账号登录（v0.2.1 起）**：设置页填服务器地址 + 账号密码，经 `center:login` IPC 由主进程调
  `POST /api/client/login`（出网走 `main/net.ts` 的 `netFetch`）；成功后主进程落三件事 ——
  令牌写入 `center.token`（凭据链路）、`center.account` 记住账号名（**非凭据**，仅展示）、
  `center.enabled = true`，连接器经 `settings:changed` 自动重连。`clientId` 为空时登录前先生成
  并持久化（旧版只展示不生成，导致连接器永远停在"尚未配置"——已修复）。密码只在登录请求里
  使用，**不落配置、不进日志**。
- **设备授权登录（v0.2.2 起，§4.3）**：设置页「登录账户」按钮走 `center:deviceLogin` IPC →
  主进程 `POST /api/client/device/start` 并 `shell.openExternal` 打开 Center 网页确认页 →
  用户网页确认后轮询拿令牌，落库路径与账号登录共用同一函数（`center:deviceLoginResult`
  推送通道把最终结果回给设置页）。适合不想在桌面端输密码、或需要先注册的场景；
  账号密码直登表单保留作为回落。
- `center.tokenEnc` 是**凭据路径**（safeStorage 密文）：`canonicalSecretPath` 把
  `center.token` / `center.tokenEnc` 规范到 `center.token`；`SettingsStore` 的
  `readSecretField` / `writeSecretField` / `toPersisted`、`canonicalSecretPath`，
  以及主进程 `redactSettings` 与 `redactKeys` 的 `SENSITIVE_KEY_PATTERN`（`tokenEnc`
  派生名）**同步修改** —— 漏改 writeSecretField = 凭据静默丢失，漏改 redact = 密文泄漏。
- `center.*` 整组进入 `SETTINGS_READONLY_PREFIXES`：AI 的 `set_setting` 一律拒绝。
  理由：连接目标是**数据外发通道**，AI 自行启用 / 改向或换账号登录，等于把本机数据发往
  任意服务器；启用、改址、登录只能由用户在设置页操作（`center:login` 也不对 AI 开放）。
- 三个 `allow*` 开关是**客户端本地的最终闸门**：Center 发来的命令类别若被对应开关
  拒绝，客户端回 `result: { ok: false, error: 'E_REMOTE_DISABLED' }`，Center 端如实展示。

## 8. Aurora Center Tools Kit（Agent 工具）

`packages/agent-core/src/tools/center.ts`，经 `CenterPort` 注入（内核不做网络与
Electron 任何操作）：

| 工具 | 入参 | sensitivity | 门控 |
|---|---|---|---|
| `center_status` | 无 | 无（只读） | `center.enabled` 且 `serverUrl` 非空才注册（未配置不注册，与 STT/TTS 同口径） |
| `center_send_file` | `path`（绝对路径）, `note?` | `'safe'`（v0.2.4 起直接发送，不逐次确认；闸门是 `center.enabled` / `allowFileTransfer` / `maxFileMb` 三层配置开关，均只读前缀 AI 改不动） | 同上 + `center.allowFileTransfer` |

- `center_status`：返回连接状态 / 服务器地址 / 本客户端在 Center 的展示名，供模型
  回答"你连着 Center 吗"。
- `center_send_file`：校验路径存在、大小 ≤ `center.maxFileMb`，经端口上传；返回
  `{ fileId, name, size, url }`。上传走 `CenterPort.sendFile`（主进程实现：
  `POST /api/ingest/files`），**不经 shell、不经代理配置**（v1 明确不支持代理）。
  **不逐次确认、直接发送（v0.2.4）**：v0.2.3 的外发类特例（`ALWAYS_CONFIRM_TOOLS`）已删除，
  工具 `sensitivity: 'safe'`，确认链路（含推 Center 网页端）不再经过它 —— 安全闸门是
  `center.enabled` / `center.allowFileTransfer` / `center.maxFileMb` 三层配置开关
  （均只读前缀，AI 改不动），口径见 docs/06 §11.2。
- 注册位置与扩展工具七件套一致（`registerExtensionTools` 一侧），**不受
  `agent.tools.enabled` 门控**；文档口径见 docs/06 §11.6。

## 9. CLI（`aurora-center`）

```
aurora-center init    [--data <dir>] [--admin-user <名>] [--admin-password <密码>]
                      # 建数据目录 + 首个管理员；已存在则跳过并提示
aurora-center start   [--port <N>] [--host <0.0.0.0>] [--data <dir>]
                      # 未 init 时自动 init（管理员密码随机生成、打印一次）
aurora-center users   <add|list|passwd|remove> ...
aurora-center status  [--data <dir>]
aurora-center update  [--check] [--registry <npm 源>]
aurora-center version
```

- `update` 的口径（**如实**）：`--check` 查询 npm registry 的 latest 版本并比较；
  不带 `--check` 执行 `npm install -g @aurora/center@latest`（经 `child_process`，
  `--registry` 透传）。**没有**自替换二进制的黑魔法 —— 以 npm 为发布 / 更新通道，
  装不到 npm 的环境用 `git pull && pnpm install && pnpm build`（README 写明）。
- **`users` 的写命令需先停服**（`add` / `passwd` / `remove`；v0.2.9 起 CLI 会**拒绝执行**
  并提示，不再只有口头约定）：CLI 与运行中的服务器各自缓存整份 `users.json`，谁后写谁
  整文件覆盖 —— 服务器在跑时用 CLI 改密，改动会被服务器下一次落盘**静默回滚**（旧密码继续
  可用），CLI 建的户也可能覆盖掉服务器新注册的用户。判定依据是数据目录里的锁文件
  `server.lock`（服务器监听成功后创建、`close()` 时删除、每 15s 刷 mtime；崩溃残留的陈旧锁
  按 mtime 超过 60s 视为无服务器）。`users list` 只读，不受此限。
  ⚠️ 升级时 **CLI 与服务器要同版本上线**：旧版服务器不写这个锁文件，新版 CLI 会认不出
  "服务器正在运行"（表现为照旧直接改写 users.json）。
- 跨端：纯 Node ≥ 18，无原生依赖；`ws` 是唯一运行时依赖。
- **Docker 离线部署**：`packages/center/deploy/`（构建机 `pnpm deploy` 打自包含产物 →
  scp → `docker compose up -d --build`，服务器全程无需访问 npm）；步骤、更新与安全
  注意（纯 HTTP 明文风险、反代 / cloudflared 加 TLS）见 `packages/center/deploy/README.md`。

## 10. Web UI（与桌面端同源的克制风格）

- 技术栈：Vue 3 + vite + 原生 CSS（不引 UI 库）。hash 路由：`#/login`（登录 / 注册切换）、
  `#/`（控制台）、`#/files`（文件管理）、`#/device`（设备授权确认页，未登录可访问）、
  `#/admin`（用户 / 全部客户端）、`#/automations`（自动化）。
- 视觉基调（**v0.3.3 起与桌面端同一份 `theme.css`**，见下面的「视觉单源」）：系统字体栈、
  分层填充、大圆角、柔和阴影、克制阴影无重边框；暗浅两档由 `prefers-color-scheme`
  驱动（**没有**独立的主题开关）。旧版 Center 自带的那套调色板
  （`#f5f5f7` / `#0071e3` / 12–16px 圆角）已随本轮重写退役。
- **布局（v0.3.3 重写：三栏控制台）**：`设备列表(264px) | 会话流(1fr, 内容列 860px 中轴)
  | 控制面板(300px, 可收起，状态存 localStorage)`；待办栏常驻会话流上方。
  顶栏是网页自己的（品牌 + 四个导航项 + 在线台数 + WS 链路状态 + 账号 + 退出）。
  会话流 / 输入卡的阅读动线与桌面端一致（860px 中轴）。
- **开发态**：`pnpm --filter @aurora/center dev:web` 起 vite dev，`/api`（含它的 WebSocket）
  代理到本地 Center（默认 `http://127.0.0.1:8787`，`AURORA_CENTER_URL` 可改）。
  生产托管方式不变：服务器直接吐 `dist-web`。
- 会话渲染按 `messageId` 聚合 `text` 增量；助手正文与思考块走 **Markdown 渲染**
  （v0.3.2 起自写渲染器；**2026-10-02 起与桌面端共用同一份实现** ——
  `@aurora/shared/browser` 的 markdown 渲染器 + `md.css`，含表格 / 提示块 / 任务列表 /
  代码高亮 / 可点击外链，以及 P2 的 KaTeX 公式与 mermaid / echarts 图表（同一水合器，
  懒加载分包 + 按源码缓存 + 视口内才渲染）；HTML 转义 + scheme 白名单防 XSS；
  渲染结果按消息缓存，代码块复制按钮走容器事件委托；用户气泡保持纯文本）；
  正常完成的请求按 `requestId` 收成一个工作胶囊（摘要含步骤数与总用时，展开看思考 / 工具 /
  中间正文），最终结论和对话图片保持在胶囊外且图片位于结论之后；失败 / 取消 / 暂停保留过程；
  工具调用渲染为可折叠卡片；思考过程折叠块；
  任务清单（job）与子代理（subagent）各渲染为一张状态卡（子代理快照挂在 `task` 工具行
  **内部**展开看只读对话，与桌面端同构）；`done` 结束 loading；`error` 红条；
  **待办栏**（v0.3.3）同时承接敏感工具确认卡（倒计时 + 批准 / 拒绝）与提问卡
  （header / 问题 / 选项单选多选 / 自由文本 + 提交 / 跳过，倒计时按 `expiresAt`）。
  **两张卡的面板位置**：桌面端确认卡与提问卡都是「会话内浮层卡 + 全局待办栏」两处；
  **提问卡（本轮起）**网页端对齐成两处：**该会话的流内**渲染完整可答卡（与会话里的消息同序），
  以及**未打开该会话时**顶部的待办栏条目（点进去跳到会话再答）—— 同一张卡不会同时出现两处，
  两处都答仍是先到先得。敏感工具确认卡**有意分叉**：网页端只有待办栏一条
  （浏览器里再叠一层浮层会挡住输入卡，而这条栏本来就在视线内）。
  两者共用同一份 state，行为完全一致。
  **提问卡结算（本轮）**：页面内作答走 `ask.resolve`；客户端本地先作答 / 超时 / 中止时
  服务器广播 `ask.settled`，网页端据此**立即收起卡片**（不再挂着倒计时等用户点了才报失效）。
  已结算的提问以**只读卡**留在会话流内（显示所选答案 / 未回答 / 已超时），
  刷新后随 `session.history` 的 `kind: 'ask'` 条目回来 —— 见 §5 第 4 步。
  ⚠️ 已过期/已结算的**只读灰态**只在流内的历史条目上出现（待办栏仍按 `remainingMs > 0`
  过滤掉，不显示灰态）。
- **视觉单源（v0.3.3 起）**：观感与桌面端**同一套令牌**——设计变量 / 暗浅主题 /
  `aurora-*` keyframes / 过渡预设 / 语义图标查表（`toolIcons` / `toolLabels`）/
  吸底状态机全部来自 `@aurora/shared/browser`（`theme.css` 与各纯函数模块），
  不再各自维护一份；Markdown 仍走共享渲染器与 `md.css`（§10 上一段）。
  有意分叉的只有**标记结构**（`.vue` 组件不跨端共享——shared 走 tsc 构建、不处理 SFC），
  因此两端组件的 `data-field` / `data-action` 命名保持同名（`chat.mic` /
  `chat.ask-user-card` / `chat.trace-live` / `chat.task-card` / `chat.todo-card` …），
  探针判据也就能逐条对齐。
- **自动跟随滚动**：与桌面端同一套「吸底」语义（`stickToBottomCore`，v0.3.3 起
  是**同一份实现**而不是搬运版）——跟随状态只由真实用户输入（滚轮 / 拖动 / 翻页键）关闭，
  流式增量的 scroll 事件不关；250ms 意图窗口按之后的读数重判；非跟随态显示「回到最新」。
- **视觉与行为验收 harness（v0.3.3，`packages/center/verify/`）**：桌面端有
  `AURORA_CAPTURE` 那套 Electron 截图 + DOM 探针，网页端原先**没有任何"看得见它"的手段**。
  现在有 `pnpm --filter @aurora/center verify:web`：起**真实服务器子进程**（临时数据目录）
  + 一台**协议忠实的桩客户端**（`verify/stub-client.mjs`，负责脚本化地制造流式正文 / 工具三态 /
  子代理快照 / 确认卡 / 提问卡 / 文件上传）+ `puppeteer-core` 驱动的系统 Edge/Chrome，
  逐场景推进状态后**截图 + 读 DOM**，最后写 `report.json`（与 `capture.ts` 同一口径：
  每条含 `{ name, file, result, checked, ok }`，任何一条 `ok: false` → 退出码 2）。
  开关：`AURORA_CWEB_OUT`（输出目录，默认 `%TEMP%/aurora-cweb`）、`AURORA_CWEB_ONLY`
  （子串过滤；特殊值 `failed` = 只重跑上次失败的）、`AURORA_CWEB_THEME=dark|light`、
  `AURORA_CWEB_VIEWPORT=mobile`、`AURORA_CWEB_KEEP=1`（保留子服务器与数据目录排障）、
  `AURORA_CWEB_BROWSER`（指定浏览器；找不到浏览器时**明确 SKIP 并退出 0**）。
  覆盖 37 个场景 ×（暗/浅两档）＝ 74 条断言：登录 / 设备授权 / 空态控制台 / 设备能力位芯片 /
  语音门控两态 / 建会话 / 用户气泡 / 流式光标 / Markdown 代码块与外链（含复制按钮回执）/
  轨迹折叠与阅读顺序（思考 → 工具行 → 正文）/ 思考块（220px 内滚 + 秒数）/ 工具三态与
  展开体实测高度（`--collapse-h` 与 `scrollHeight` 相差 ≤ 2px）/ 子代理卡与**只读**对话视图 /
  任务清单卡 / 历史回放 / 确认卡（会话内 + 批复命令）/ 提问卡（选项 / 自由文本 / 作答命令 /
  过期）/ **提问卡进会话流 + 客户端结算后切成只读**（`ask-in-stream`，本轮）/
  文件条与文件页 / **文件页「发送到客户端」发出 `file.send`**（本轮）/ 自动化 / 管理员 /
  三个面板 / **会话行模型下拉发出 `session.setModel`**（`panel-session-model`，本轮）/
  主题两档 / **`prefers-reduced-motion` 兜底把过渡压到 1ms**（`reduced-motion`，本轮）/
  移动端单栏抽屉。
  另有一条诊断工具 `pnpm --filter @aurora/center verify:web:status --server <url> --user <名>
  --password <密码>`：以管理员身份连上 Center 打印每个客户端的 `ClientStatus`（含 `voice`
  能力位），用来区分「客户端没上报语音」与「网页是旧包」（见 §6.1 的排查顺序）。
- **会话管理面板（v0.2.3，§6.3）**：客户端面板内列出该客户端的 `center-` 会话
  （`session.list` 拉取），每项提供：切换查看（网页本地）、「在客户端打开」
  （`session.activate`）、可见性开关（`session.visibility`）、权限档下拉
  （`session.setPermission`，含「跟随全局」）、项目下拉（`session.setProject` +
  `project.list`）、**模型下拉（本轮）**（`session.setModel`，选项 = 该会话生效 provider 的
  `modelList`，含「跟随全局」清除项；provider 的切换仍只在「模型」页签的全局默认上做）。
  同一面板的「模型」页签改的是**全局默认**（`llm.switch`），与这里的会话级覆盖是两份数据。
- **全局待批复确认卡栏（v0.2.3）**：ConsoleView 顶部常驻，展示所有未过期的
  `confirm.request`，行内批准 / 拒绝；与会话视图内的卡先到先得。
  （v0.2.4 起只有 `center-` 会话来源的请求 —— 本地会话的 `center_send_file` 已改为
  直接发送，不再产生确认卡。）
- **Token 用量（v0.2.3）**：会话视图渲染 `usage` 事件（此前到达但被忽略）——
  最新轮 prompt/completion tokens、会话累计、占 contextWindow 比例
  （contextWindow 从 `config.get` 取）。
- **自动化视图（v0.2.5，`#/automations`）**：设备下拉选定客户端后列出其自动化 ——
  Agent Mode / Normal Mode / 内置三组卡片（名称 + 触发描述 + 启停开关 + 立即运行 +
  编辑 / 删除；内置无编辑删除、启停提示去客户端设置页）；「新建 / 编辑」弹层按
  `automation.catalog` 渲染动态字段（触发器 7 类 + 操作组件 3 类，`available: false`
  的组件不可选）；底部运行历史（时间 / 自动化 / 状态 / 用时，可按自动化筛选）。
  刷新为显式按钮 + 操作后重拉（桌面端的 `automation:changed` 推送不经 Center WS，
  网页端不做实时订阅）。
- 文件管理页：全部上传文件的表格（名称 / 来源客户端 / 大小 / 备注 / 上传与过期时间 /
  **来源**：客户端发送 or 网页上传，本轮），行内下载与删除，过期前 < 24h 显示倒计时。
  **本轮新增「发送到客户端」**：行内选一台设备，把该暂存文件推给客户端落盘（§5 第 5 步）；
  控制台对选中设备也有「发送文件」（先上传再推送），按 `ClientStatus.center.allowFileTransfer`
  门控渲染（不具备能力就不渲染按钮，与语音门控同口径）。
- **语音（v0.3.2，§6.4）**：composer 麦克风按钮（按 `ClientStatus.voice.stt` 门控，
  未配置连按钮都不渲染）录音 → `stt.transcribe` 中转识别 → 文本填入输入框；
  助手消息行内「朗读」按钮（按 `voice.tts` 门控）→ `tts.synthesize` 中转合成 → blob 播放。
  录音需安全上下文（HTTPS / localhost），见 §6.4 已知限制。
- **移动端适配（v0.3.3 跟随三栏布局重做）**：≤ 720px 单栏——会话流占满，**设备列表与
  控制面板都变成覆盖式抽屉**（`grid-template-rows: minmax(0,1fr) auto`：主区吃剩余高度、
  底部标签栏按内容高），开会话后抽屉自动收起；表格横向滚动、触摸目标 ≥ `--hit-target`（40px）、
  safe-area 与 composer 16px 输入字号（规避 iOS 聚焦缩放）。
  ⚠️ 外层抽屉容器**不要**与子组件根节点共用类名（`.rail`）：Vue 会把父组件的 scope 属性
  一并加到子组件根节点上，于是「离屏抽屉」那套 `opacity: 0 / pointer-events: none` 也套到了
  内层列表上（打开抽屉也看不见内容，harness 的 `mobile-single-column` 实测抓到过）。
  现在外层叫 `.rail-drawer` / `.panel-drawer`，内层列表用 `data-panel="rail"` 标识。

## 11. 安全边界与非目标（v1）

- **没有端到端加密**：Center 可见全部远程会话明文 —— 与"管理员可见所有客户端"的
  产品语义一致，文档明示；敏感环境应自建 Center 于内网。账号登录的密码与颁发的
  客户端令牌同样走明文 HTTP，公网部署必须置于 TLS 反代之后（客户端填 `https://` 地址）。
- **限速是"防穷举 / 防批量"级别，不是 DDoS 防护**（v0.2.9）：认证端点的计数器在进程内存里、
  按**源 IP** 计（直连部署下取 socket 地址，不信任 `x-forwarded-for`），分布式源 IP / 代理池
  仍可绕过；它挡的是单点暴力破解与批量建号，且限速状态**不跨重启保留**。部署到反代后面时
  必须同时改 `server.ts` 的取值口径（否则所有请求共用一个键 —— 要么误伤所有人，要么形同虚设）。
- **clientId 是设备标识，不可外泄**：知道他人 clientId 的账号无法用账号登录或设备授权抢注
  （`/api/client/login` 与 `device/authorize` 对"clientId 已绑定其他账号的有效令牌"返回
  409 `E_CLIENT_BOUND`，同属主重登放行），但泄露仍有社工与骚扰面。
- **没有 OS 级沙箱增益**：远程会话里 Agent 的能力与本地完全相同（三档权限、项目根
  边界照常生效于客户端本机）。远程发起的会话中确认卡会同时弹在**客户端本机**并推送
  **网页端**（v0.2.2 起，§5 第 4 步）：两条通道先到先得，任何一边批准即放行、拒绝即拦下，
  `proactive.resolve` 对已结算的 confirmId 幂等 —— 远程批准不绕过任何本地闸门，只是
  把"问用户"的界面延伸到了网页。本地会话仅 `center_send_file` 的确认卡推网页端
  （v0.2.3，§5 第 4 步）——它是数据出域动作，属主应可见；本地会话的其余活动不推。
- **会话级权限覆盖不等于远程改全局档**（v0.2.3，§6.3）：Center 能为**单个 `center-`
  会话**覆盖权限档（`session.setPermission`），全局 `agent.permissionMode` 仍只能由
  用户在本机设置页调整。会话覆盖存于客户端会话文件（SessionMeta），属会话数据，
  不进 CONFIG_VERSION；放开它的理由与 §6.2 的禁令不矛盾——禁令防的是"远程一把
  改掉所有会话的闸门"，会话级覆盖的作用面被限制在 Center 自己创建 / 可见的远程会话上。
- Center 不存储会话历史（只转发事件流）；文件暂存 24h 自动删除，网页端也可手动删除。
- 客户端一次只连一个 Center；`clientId` 本机生成、持久化于配置（非凭据）。
