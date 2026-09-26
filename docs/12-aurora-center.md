# 12 · Aurora Center —— 网页端控制中心

状态：`已定稿`（v0.2.0 随本设计首次落地）

Aurora Center 是与 Aurora 桌面客户端配套的**独立服务器 + Web 控制台**：

- 安装了 Aurora 的客户端可以连接到 Center，Center 的 Web 端能远程给某个客户端的
  Aurora 发送指令（**单开一个 Session**）、接收回答；
- 用户要求客户端 Aurora 发送文件时，Agent 通过 `center_send_file` 工具把文件传到
  Center，网页端直接下载；
- Center 可以远程修改客户端的一定配置（Agent 各项开关、切换模式），但受客户端侧
  **白名单**约束（见 §7）；
- 服务器是**纯 Node 程序**，Windows / Linux 均可运行，带 `aurora-center` CLI
  （一键启动、建账户、发配对令牌、自更新）；
- Web 端外观为**简约 Apple 风格**（系统字体栈、大圆角卡片、克制的灰阶与毛玻璃顶栏）。

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
| `users.json` | 用户账户：`{ id, username, role: 'admin'\|'user', passHash, passSalt, createdAt }`（口令 scrypt 哈希，绝不存明文） |
| `tokens.json` | 客户端令牌（配对令牌 / 账号登录颁发，§3）：`{ id, userId, tokenHash(SHA-256), label, clientId, createdAt, revokedAt? }` —— **令牌明文只在创建 / 登录响应时出现一次**；账号登录重发时同 `clientId` 旧令牌自动吊销 |
| `clients.json` | 已登记客户端：`{ clientId, name, ownerUserId, version, platform, firstSeenAt, lastSeenAt, lastMode, revokedAt? }` |
| `files/<fileId>-<name>` + `files/index.json` | 客户端上传文件的暂存与索引 |

所有 JSON 落盘沿用仓库约定：**原子写（临时文件 + rename）**，读损坏备份后重建。

## 3. 鉴权模型

| 主体 | 凭据 | 能做什么 |
|---|---|---|
| 网页用户（`role: 'user'`） | REST `POST /api/auth/login` 换会话令牌（随机 32B hex，内存持有，7 天过期） | 看到**自己名下**的客户端；对自己的客户端发起会话 / 远程配置 / 收文件 |
| 网页管理员（`role: 'admin'`） | 同上 | **看到并控制所有客户端**（跨属主"超限控制"）；管理用户（增删、重置口令）；吊销配对令牌 / 客户端 |
| Aurora 客户端 | 客户端令牌（WS 握手 `Authorization: Bearer`） | 维持长连接、收命令、传事件、上传文件；一个令牌**创建即绑定**一个 `clientId`，不得复用到第二台机器 |

- 首个管理员由 CLI 创建（`aurora-center init` / 首次 `start` 自动生成并打印一次性口令）。
- **客户端配对主路径是账号登录（v0.2.1 起，替代"管理员发令牌 → 用户手填"的旧流程）**：
  客户端在设置页填写服务器地址与 Center 账号口令 → `POST /api/client/login`（§4.2）校验
  口令后颁发**归属该用户、创建即绑定该 `clientId`** 的客户端令牌 → 客户端存入安全存储
  （`center.token` 凭据链路）并自动连接。每次登录都会重发新令牌并**吊销同 `clientId` 的旧令牌**
  （换账号 / 重新登录后旧凭据立即失效）；口令本身**绝不落盘**，令牌失效（如服务器数据重置）
  后需在设置页重新登录。
- 手动创建配对令牌（CLI `aurora-center token create --user <名>` 或 Web 管理端）**仍可用**，
  作为兼容路径：首次连接时绑定 `clientId` 的语义不变。
- **属主跟随当前有效令牌**：客户端 hello 登记时 `ownerUserId` 以其令牌属主为准 ——
  设备被释放（令牌吊销）后由另一账号登录即可接管归属；属主未释放前，登录（409
  `E_CLIENT_BOUND`）与配对令牌首次绑定都会拒绝抢注。
- Web 会话令牌与客户端 / 配对令牌都只存哈希，泄露数据库不等于泄露凭据。

## 4. 协议（`packages/shared/src/center/protocol.ts`）

三方向消息都是 `{ type, ... }` JSON。**协议演进只增不改**：消费方对未知 `type` 一律忽略。

### 4.1 客户端 ⇄ 服务器（长连 WS）

```
客户端 → 服务器
  { type: 'hello', hello: ClientHello }        // 连接后第一条；ClientHello 含 clientId/name/version/platform/mode/capabilities
  { type: 'status', status: ClientStatus }     // 状态快照（连接后、配置/模式变更时）
  { type: 'result', requestId, ok, data?, error? }
  { type: 'session.event', sessionId, event }  // event 为内核 AgentEvent 原样转发（JSON 可序列化）

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
```

- `sessionId` 由**服务器分配**，固定形如 `center-<短随机串>`（客户端渲染层据此把
  远程会话与本地会话区分开）。
- 客户端收到 `session.input` 后走与 `chat:send` **同一条** `agent.send()` 通路
  （`origin: 'center'`，docs/06 §4.1 的 job 体系照常生效）；`E_BUSY` / `E_NO_MODEL`
  等错误自然以 `session.event`（error 事件）回传网页端。

### 4.2 网页 ⇄ 服务器

REST：`POST /api/auth/login`、`POST /api/client/login`（**无需已登录**：客户端用
`{ username, password, clientId }` 换客户端令牌，见 §3）、`GET /api/me`、`GET /api/clients`（按角色过滤）、
`GET /api/files/:fileId`（鉴权下载）、管理员 `POST /api/users`、`GET /api/admin/clients`、
`POST /api/admin/tokens`、`POST /api/admin/tokens/:id/revoke`、`DELETE /api/users/:id`。

WS（登录令牌经 `?token=` 传递——浏览器 WebSocket 无法自定义请求头）：

```
网页 → 服务器
  { type: 'session.create', requestId, clientId }
  { type: 'session.input',  requestId, clientId, sessionId, text }
  { type: 'session.abort',  requestId, clientId, sessionId, agentRequestId }
  { type: 'config.get',     requestId, clientId }
  { type: 'config.update',  requestId, clientId, patch }
  { type: 'mode.switch',    requestId, clientId, mode }

服务器 → 网页
  { type: 'clients', clients: ClientInfo[] }              // 连接后与每次变动时的全量快照
  { type: 'client.status', clientId, status }             // 单个客户端状态/元数据更新
  { type: 'client.event',  clientId, sessionId, event }   // 转发的会话事件
  { type: 'result', requestId, ok, data?, error? }
  { type: 'file.received', fileId, clientId, name, size, note?, at }
```

路由规则（`hub.ts`）：命令按 `clientId` 找到该客户端的连接；`session.event` 按
**会话属主**（发起 `session.create` 的网页用户）+ 全部管理员回传；`file.received`
回传给该客户端属主 + 管理员。属主关系由服务器记账（`sessionId → webUserId`），
不信任客户端自报。

## 5. 远程会话与文件发送

1. 网页端对某客户端点「新建会话」→ `session.create` → 服务器分配 `center-*` sessionId
   并记账属主 → 网页端进入会话视图；
2. 用户输入 → `session.input` → 服务器包成 `cmd` 发给客户端 → 客户端
   `agent.send({ sessionId, text, origin: 'center' })`；
3. 客户端把该会话的全部 AgentEvent（正文增量 / 思考 / 工具卡 / done / error）以
   `session.event` 回传 → 服务器按属主路由 → 网页端按 `messageId` 聚合渲染；
4. 「发送文件」：用户在远程会话里让 Agent 发文件 → Agent 调 `center_send_file`
   （§8）→ 客户端 HTTP `POST /api/ingest/files`（配对令牌鉴权，尺寸受
   `center.maxFileMb` 限制）→ 服务器落盘并 `file.received` 通知 → 网页端出现
   下载卡（`GET /api/files/:fileId`，属主或管理员可下载）。

远程会话在客户端主界面左栏的历史里照常可见（`center-*` 前缀），用户可随时查看
甚至继续输入 —— 远程与本地对同一会话的写入顺序由客户端串行化（AgentHost 的
`active` 槽本身按会话互斥，`E_BUSY` 是唯一交叉语义）。

## 6. 状态快照与远程配置

### 6.1 ClientStatus（连接后与每次相关变更时上报）

```ts
{ mode, version, platform,
  agent: { permissionMode, tools: { enabled, files, search, open, terminal } },
  center: { allowRemoteSession, allowRemoteConfig, allowFileTransfer } }
```

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

## 7. 客户端配置（`center` 分组，CONFIG_VERSION 17）

Schema / 默认值 / 迁移见 docs/08 §1。要点：

- **账号登录（v0.2.1 起）**：设置页填服务器地址 + 账号口令，经 `center:login` IPC 由主进程调
  `POST /api/client/login`（出网走 `main/net.ts` 的 `netFetch`）；成功后主进程落三件事 ——
  令牌写入 `center.token`（凭据链路）、`center.account` 记住账号名（**非凭据**，仅展示）、
  `center.enabled = true`，连接器经 `settings:changed` 自动重连。`clientId` 为空时登录前先生成
  并持久化（旧版只展示不生成，导致连接器永远停在"尚未配置"——已修复）。口令只在登录请求里
  使用，**不落配置、不进日志**。
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
| `center_send_file` | `path`（绝对路径）, `note?` | `'confirm'`（对外发送文件，逐次确认） | 同上 + `center.allowFileTransfer` |

- `center_status`：返回连接状态 / 服务器地址 / 本客户端在 Center 的展示名，供模型
  回答"你连着 Center 吗"。
- `center_send_file`：校验路径存在、大小 ≤ `center.maxFileMb`，经端口上传；返回
  `{ fileId, name, size, url }`。上传走 `CenterPort.sendFile`（主进程实现：
  `POST /api/ingest/files`），**不经 shell、不经代理配置**（v1 明确不支持代理）。
- 注册位置与扩展工具五件套一致（`registerExtensionTools` 一侧），**不受
  `agent.tools.enabled` 门控**；文档口径见 docs/06 §11.6。

## 9. CLI（`aurora-center`）

```
aurora-center init    [--data <dir>] [--admin-user <名>] [--admin-password <口令>]
                      # 建数据目录 + 首个管理员；已存在则跳过并提示
aurora-center start   [--port <N>] [--host <0.0.0.0>] [--data <dir>]
                      # 未 init 时自动 init（管理员口令随机生成、打印一次）
aurora-center users   <add|list|passwd|remove> ...
aurora-center token   <create|list|revoke> --user <名> [--label <备注>]
aurora-center status  [--data <dir>]
aurora-center update  [--check] [--registry <npm 源>]
aurora-center version
```

- `update` 的口径（**如实**）：`--check` 查询 npm registry 的 latest 版本并比较；
  不带 `--check` 执行 `npm install -g @aurora/center@latest`（经 `child_process`，
  `--registry` 透传）。**没有**自替换二进制的黑魔法 —— 以 npm 为发布 / 更新通道，
  装不到 npm 的环境用 `git pull && pnpm install && pnpm build`（README 写明）。
- 跨端：纯 Node ≥ 18，无原生依赖；`ws` 是唯一运行时依赖。
- **Docker 离线部署**：`packages/center/deploy/`（构建机 `pnpm deploy` 打自包含产物 →
  scp → `docker compose up -d --build`，服务器全程无需访问 npm）；步骤、更新与安全
  注意（纯 HTTP 明文风险、反代 / cloudflared 加 TLS）见 `packages/center/deploy/README.md`。

## 10. Web UI（Apple 风格）

- 技术栈：Vue 3 + vite + 原生 CSS（不引 UI 库）。hash 路由：`#/login`、`#/`（客户端 +
  会话）、`#/admin`（用户 / 令牌 / 全部客户端）。
- 视觉基调：`-apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei"`
  字体栈；`#f5f5f7` 底 + 白色大圆角卡片（12–16px）+ `#0071e3` 主色（Apple 蓝）；
  顶栏毛玻璃（`backdrop-filter: saturate(180%) blur(20px)`）；克制阴影、无重边框。
- 布局：左侧客户端列表（在线绿点 / 离线灰点 / 名称 / 平台图标）+ 右侧会话主区
  （消息流 + 输入框）；管理员页表格式用户与令牌管理。
- 会话渲染按 `messageId` 聚合 `text` 增量；工具调用渲染为可折叠卡片；`done` 结束
  loading；`error` 红条。

## 11. 安全边界与非目标（v1）

- **没有端到端加密**：Center 可见全部远程会话明文 —— 与"管理员可见所有客户端"的
  产品语义一致，文档明示；敏感环境应自建 Center 于内网。账号登录的口令与颁发的
  客户端令牌同样走明文 HTTP，公网部署必须置于 TLS 反代之后（客户端填 `https://` 地址）。
- **clientId 是设备标识，不可外泄**：知道他人 clientId 的账号无法用账号登录抢注
  （`/api/client/login` 对"clientId 已绑定其他账号的有效令牌"返回 409 `E_CLIENT_BOUND`，
  同属主重登放行），但泄露仍有社工与骚扰面。
- **没有 OS 级沙箱增益**：远程会话里 Agent 的能力与本地完全相同（三档权限、项目根
  边界、确认卡片照常生效于客户端本机）。远程发起的会话中确认卡会弹在**客户端本机**
  —— 远程用户需在 `session.event` 里看到"等待确认"状态；v1 不做远程代批准
  （远程代批准 = 越权操作客户端，刻意不做）。
- Center 不存储会话历史（只转发事件流）；文件暂存由 `files/index.json` 记录、
  手动清理或 CLI `files prune`（后续）。
- 客户端一次只连一个 Center；`clientId` 本机生成、持久化于配置（非凭据）。
