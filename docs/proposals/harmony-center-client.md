# 提案 · Aurora Center 鸿蒙客户端（手机遥控台）

状态：`Center 侧已实施`（2026-11-15：P0 全部 + P1 接口层 E/F/G/H 已落地并测绿，
设计已并入 docs/12 §15；Center 0.7.0。P1 网页卡片 I/J 与 P2 未做。
鸿蒙 App 在**独立仓库**开发，开工提示词见 `harmony-client-kickoff-prompt.md`）
日期：2026-11-15 · 适用 Center 版本线：0.6.0 → 0.7.0（独立版本线，不打 tag）

## 0. 定位与结论速览

**形态（已与需求方确认）**：鸿蒙原生 App 承担 **Center 网页端角色** —— 在手机上遥控
PC 上的 Aurora（远程会话、确认卡 / 提问卡批复、文件收发、用量、自动化、插件面板）。
**不是**把鸿蒙变成一台受控设备：客户端 ⇄ 服务器协议（`/api/client`、hello/status/cmd）
**零改动**，Windows 桌面端与 agent-core **零改动**。

**核心结论**：

1. 现有「网页 ⇄ 服务器」协议面（REST + `/api/ws`）**绝大部分可直接复用**，App 就是
   一个不说浏览器方言的「网页端」。协议演进沿用 docs/12 §4 的「只增不改」口径。
2. 真正的缺口只有五处，全部源于**手机与浏览器的运行环境差异**：
   - 网页会话**只存内存**（`auth.ts` 的 `Map`，7 天 TTL，重启全失效）→ App 需要持久会话；
   - 浏览器页签常驻 vs **鸿蒙后台即挂起**（WS 必断）→ 需要系统级推送（Push Kit）；
   - 推送唤醒后需要**冷启动对账**（确认卡目前不回放）→ 需要待办快照接口；
   - 通知栏要**一键批复**（不打开完整会话）→ 需要 REST 快捷批复（P1）;
   - 浏览器有安全上下文 / 下载 / 录音的现成能力，App 要原生承接（客户端侧工作，Center 零改动）。
3. 推送有一个**产品级约束**：Push Kit 的发送凭据绑定 App 的 AGC 项目，官方 App 的
   服务账号密钥不能分发给每个自托管 Center → 推送默认只在官方 Center 开箱即用，
   自托管需自有 AGC 项目 + 自签 App 变体（§9 风险 R1，需产品决策）。

## 1. 现状盘点：可直接复用的协议面

以下全部已在 0.6.0 落地并经 `verify:web`（106 条断言）验收，App 原样消费，Center 不改。

### 1.1 REST（网页会话鉴权，Bearer 或 `?token=`）

| 端点 | 用途 | 来源 |
|---|---|---|
| `POST /api/auth/login` / `POST /api/auth/register` | 登录 / 注册，回 `{ token, user }` | server.ts:542/568 |
| `GET /api/me` | 当前用户 `{ id, username, role }` | server.ts:867 |
| `GET /api/clients` | 名下客户端快照（管理员全量） | server.ts:871 |
| `GET /api/usage` | Token 用量（用户强制本人；分页 limit/offset） | server.ts:875 |
| `GET /api/files` / `GET /api/files/:fileId` / `DELETE /api/files/:fileId` | 文件清单 / 下载 / 删除（属主或管理员） | server.ts:978/991/995 |
| `POST /api/uploads?clientId=` | 网页上传给指定客户端（图片附件同路） | server.ts:945 |
| `GET /api/updates/current` | 公开更新目录（官网下载区） | server.ts:645 |
| `GET /api/plugins*` / `GET\|HEAD /p/:id/:version/<path>` | 插件市场公开路由 / 页面型面板资源 | docs/12 §14 / §6.5 |

### 1.2 WS `/api/ws?token=`（网页 ⇄ 服务器，docs/12 §4.2）

- **上行命令**（App 全部可用）：`session.create / input / abort / history / list /
  activate / visibility / setPermission / setProject / setModel / readImage`、
  `config.get / update`、`mode.switch`、`confirm.resolve`、`ask.resolve`、`file.send`、
  `stt.transcribe`、`tts.synthesize`、`llm.switch`、`project.list`、
  `automation.list / catalog / save / delete / run / history`、
  `plugin.panelData / subscribe / unsubscribe`。
- **下行事件**：`clients`（全量快照）、`client.status`、`client.event`（AgentEvent 原样）、
  `result`、`file.received`、`confirm.request`、`ask.request`（重连回放未过期项）、
  `ask.settled`、`plugin.event`。
- 路由与授权口径不变：命令按属主 + 管理员；插件面板**只认属主**；`sessionId` 由服务器
  分配（`center-*`）；服务器不缓存会话内容。

**结论**：远程会话、确认 / 提问、文件、语音中转、自动化、插件面板这些功能面，
Center **一个接口都不用加**；要加的是下面 §2 的「移动运行环境适配层」。

## 2. 需新增 / 调整的 API（按优先级）

### P0 —— 没有它，原生 App 的体验不成立

#### A. 持久会话与令牌轮换（改 `auth.ts` + `server.ts`）

现状：`createWebSession` 只写内存 Map，服务器重启 = 所有网页端掉线重登。浏览器可接受，
App 不可接受（用户预期「登录一次长期有效」）。

| 端点 | 鉴权 | 请求 | 响应 / 语义 |
|---|---|---|---|
| `POST /api/auth/login`（** additive 扩展**） | 无 | 追加可选 `{ persistent: true, deviceName?: string }` | 回包追加 `{ expiresAt, persistent: true }`；持久会话落 `sessions.json`（只存 tokenHash），TTL 90 天；不带字段 = 现状完全不变 |
| `POST /api/auth/refresh` | Bearer（仅持久会话） | `{}` | 轮换：颁新令牌、旧令牌立即失效、TTL 重置 90 天；回包同 login。App 每次启动且剩余 < 7 天时调用 |
| `POST /api/auth/logout` | Bearer | `{}` | 服务端删会话（内存或持久）+ **级联删除该会话登记的推送设备**；现状网页「退出」只清 localStorage，服务端无此路由 |

边界：
- 每用户持久会话上限 **10** 条，超限淘汰最旧（同 `MAX_WEB_SESSIONS` 思路）；
- 持久会话只存 SHA-256 哈希（同客户端令牌口径），明文只在 login/refresh 响应出现一次；
- `verifyWebSession` 先查内存再查持久缓存（init 时加载），**临时网页会话行为零变化**；
- refresh 不校验密码，单独限速 scope（建议 60 次/分钟/IP，进 `AUTH_RATE_LIMITS`）；
- 注册 / 登录失败限速口径不变（只记失败、5 次/分钟）。

#### B. 推送登记与通知偏好（新 `push.ts` + `server.ts` 路由）

| 端点 | 鉴权 | 请求 | 响应 / 语义 |
|---|---|---|---|
| `POST /api/push/register` | 网页会话 | `{ platform: 'harmony', token, deviceName?, appVersion? }` | 按 (userId, token) upsert；记录绑定**会话 id**（refresh 轮换令牌不丢登记）；push token 经 SecretBox 加密落 `push-devices.json`；每用户 ≤ 10 台 |
| `POST /api/push/unregister` | 网页会话 | `{ token }` | 删除本人名下该登记（App 登出 / 关闭通知时调用） |
| `GET /api/me/notification-prefs` | 网页会话 | — | `{ confirm, ask, file, sessionDone }`（布尔） |
| `PUT /api/me/notification-prefs` | 网页会话 | 同上部分字段 | 落 `notification-prefs.json`；默认 `confirm/ask/file = true`、`sessionDone = false` |

推送**发送**是服务器内部行为（无对外端点），触发点与路由规则见 §3.3。
AGC 凭据配置 P0 走数据目录文件（`push-config.json`，私钥经 SecretBox 加密），
P1 补管理端 API 与网页卡片（§P1-D）。

#### C. 待办快照（冷启动对账，改 `hub.ts` + `server.ts`）

现状：提问卡有 `pendingAsks` 重连回放；**确认卡不回放**（60s 窗口短，属既有行为）。
App 被推送唤醒时进程是冷的，WS 回放之外还需要一次 REST 拉齐：

| 端点 | 鉴权 | 请求 | 响应 / 语义 |
|---|---|---|---|
| `GET /api/pending?clientId=<可选>` | 网页会话 | 缺省 = 本人全部在线客户端 | `{ confirms: [{ clientId, sessionId, request }], asks: [{ clientId, sessionId, request }] }`；只回未过期项；属主 + 管理员口径同 `buildClientInfos` |

实现：hub 增加 `pendingConfirms` 登记（`confirm.request` 时入表、按 `expiresAt` 清扫；
**不改变网页端「确认卡不回放」的既有行为**，只供 REST 读取）。asks 直接读现有 `pendingAsks`。

#### D. App 连接标识（WS 协议 additive，改 `protocol.ts` + `hub.ts`）

推送判定需要区分「这个用户此刻有没有**手机**在线」——PC 网页开着不代表手机能收到 WS。

```
网页 → 服务器（连接后第一帧，可选）
  { type: 'web.hello', client: 'harmony', appVersion?: string }
```

- `WebConn` 增加可选 `clientKind: 'web' | 'harmony'`（缺省 `'web'`）；旧网页不发此帧，
  行为零变化；旧服务器不认识 `web.hello` → 按「未知 type 忽略」自然降级。
- **推送判定规则**：事件按现有路由算出收方用户集合后，对每个用户：
  偏好开启 **且** 该用户没有 `clientKind='harmony'` 的活连接 → 发推送。
  （手机在前台时 WS 直投，不重复打扰；PC 网页在线**不抑制**手机推送。）

### P1 —— 体验增强

| # | 端点 / 能力 | 鉴权 | 语义 |
|---|---|---|---|
| E | `POST /api/confirm/resolve` `{ clientId, confirmId, approved }` | 网页会话 | 通知栏「批准 / 拒绝」动作直达：与 WS `confirm.resolve` 同授权（属主 + 管理员）、同转发链、同 15s 回执；客户端 `proactive.resolve` 幂等 → 与本机 / 网页批复先到先得 |
| F | `POST /api/ask/resolve` `{ clientId, sessionId, requestId, answers?, skipped?, answersByQuestion? }` | 网页会话 | 同上；`result.data.settled = false` → 回 `409 E_ALREADY_SETTLED`（通知栏动作失效提示） |
| G | `GET /api/admin/sessions?userId=` / `DELETE /api/admin/sessions/:id` | 管理员 | 查看 / 吊销持久会话（回包不含哈希），吊销级联清推送登记 |
| H | `GET /api/admin/push` / `PUT /api/admin/push` | 管理员 | AGC 凭据配置（projectId / keyId / subAccount / privateKey **只写不回显** / enabled），形状与错误口径对齐官方模型配置卡（`apiKeySet` 同款 `keySet`）；配套 `#/admin` 推送配置卡 |
| I | 通知栏动作按钮 + 已结算通知收起 | — | App 侧：确认 / 提问通知带「批准 / 拒绝」「去回答」动作（走 E/F）；`ask.settled` / 批复完成后发同 collapseKey 的更新通知或依赖短 TTL 自然消失 |
| J | 官网下载区鸿蒙入口 | — | `GET /api/updates/current` 回包 additive 追加 `harmony?: { version, storeUrl }`（AppGallery 链接），官网下载区渲染 |

### P2 —— 可选

| # | 端点 / 能力 | 语义 |
|---|---|---|
| K | 扫码登录四端点：`POST /api/auth/qr/start`（网页会话）/ `GET /api/auth/qr/info?code=`（公开）/ `POST /api/auth/qr/authorize`（网页会话）/ `POST /api/auth/qr/poll`（公开） | 手机扫**已登录网页**展示的二维码完成 App 登录，免手机输密码；挑战只存内存、10 分钟、形状照抄设备授权三端点（docs/12 §4.3），颁的是持久网页会话 |
| L | 鸿蒙自托管更新源：`GET /api/updates/harmony`（公开）+ `POST /api/admin/releases/harmony/upload|publish` + 资产下载 | 仅当不走 AppGallery 时需要；ReleaseStore 同款 staging → 校验 → 原子发布，产物 `.app/.hap` + sha256 + 版本清单。**默认走 AppGallery，本项不做** |
| M | 官方推送中继 | 解决 R1：自托管 Center 把推送请求发给 Aurora 官方中继（只转发路由字段，不含内容）。引入官方依赖与隐私面，需单独立项评估 |

## 3. 服务器端实现方案（文件级接线点）

### 3.1 新增数据文件（全部沿用 JsonStore 原子写 + 损坏备份重建）

| 文件 | 内容 |
|---|---|
| `sessions.json` | 持久会话：`{ id, userId, tokenHash, label, clientKind, createdAt, expiresAt }` |
| `push-devices.json` | 推送登记：`{ id, userId, sessionId, platform, tokenEnc, deviceName?, appVersion?, createdAt, lastSeenAt }` |
| `notification-prefs.json` | 每用户通知偏好 |
| `push-config.json` | AGC 凭据：`{ enabled, projectId, keyId, subAccount, privateKeyEnc }` |

加密复用 `secrets.ts` 的 `createSecretBox`（HKDF-SHA256 + AES-256-GCM），为推送另开
salt/info（如 `aurora-center:push:v1`），**主密钥缺失时推送能力视为未配置**、服务器照常
启动 —— 与官方模型能力同一降级口径。

### 3.2 代码改动清单

| 文件 | 改动 |
|---|---|
| `packages/shared/src/center/protocol.ts` | 增 `WebHelloMessage` 并入 `CenterWebMessage`；增推送 / 待办 / 会话管理 REST 类型（纯类型，无 Node 依赖，ArkTS 可移植） |
| `packages/center/src/auth.ts` | 持久会话存储 + 缓存、`refreshWebSession` / `dropWebSession` 级联、每用户上限；临时会话路径不动 |
| `packages/center/src/push.ts`（新） | `PushRegistry`（登记 / 偏好）、`PushSender` 接口 + `AgcPushSender`（§3.4）、`NoopPushSender`（未配置 / 单测注入） |
| `packages/center/src/hub.ts` | `WebConn.clientKind` + `web.hello` 处理；`pendingConfirms` 登记；`HubDeps.push?` 注入；四个推送钩子（§3.3）；`resolveConfirm` / `resolveAsk` 抽成 WS 与 REST 共用的入口 |
| `packages/center/src/server.ts` | §2 新路由；`AUTH_RATE_LIMITS` 增 refresh scope；`/api/pending` 属主过滤 |
| `packages/center/src/secrets.ts` | `createSecretBox` 参数化 salt/info（或新增 `createPushSecretBox`），现有调用点不变 |
| `packages/center/web/` | P1：`#/admin` 推送配置卡 + 会话管理表；官网下载区鸿蒙入口 |
| 测试 | `auth.test.ts`（持久 / 轮换 / 上限 / 重启存活）、`push.test.ts`（假 sender：路由 / 去重 / 偏好 / 在线抑制 / 失效 token 清理）、`hub.test.ts`（web.hello / pendingConfirms）、`server.test.ts`（新路由鉴权 / 限速）；`verify/` 增桩场景 |

### 3.3 推送钩子与路由（hub 内，全部 additive）

| 触发点（现有代码位置） | 推送内容（**最小化**） | TTL / 去重 |
|---|---|---|
| `handleClientMessage` `confirm.request`（hub.ts:981） | 「Aurora 请求确认敏感操作」+ 设备名；data 只带 `{ kind, clientId, sessionId, confirmId, expiresAt }` | TTL = 60s 窗口剩余；collapseKey = `aurora-confirm-<confirmId>` |
| `handleClientMessage` `ask.request`（hub.ts:1003） | 「Aurora 向你提问」+ 设备名；data 带 `{ kind, clientId, sessionId, requestId, expiresAt }` | TTL = 180s 窗口剩余；collapseKey = `aurora-ask-<requestId>` |
| `broadcastFileReceived`（hub.ts:1107） | 「收到文件」+ 文件名；data 带 `{ kind, clientId, fileId }` | 默认 1h；collapseKey = `aurora-file-<fileId>` |
| `session.event` 的 `done` / `error`（hub.ts:963，偏好默认关） | 「任务完成 / 出错」+ 设备名；仅 `sessionOwners` 里该用户创建的会话 | 默认 1h；collapseKey = `aurora-done-<sessionId>` |

规则：
- 收方集合 = 现有 WS 路由同款（属主 + 管理员；`sessionDone` 只发会话创建者）；
- 每用户每事件**至多一条**推送；该用户有 harmony 活连接 → 不发（WS 已直投）；
- **推送载荷绝不带**会话正文、工具入参、文件内容、提问选项 —— 只带路由字段，
  详情进 App 后经 `GET /api/pending` / `session.history` 拉取（与「服务器不缓存会话内容」同口径）；
- 发送失败只记日志（`userId / kind / 错误码`，不记 token 全文）；华为回执为「token 失效」
  类错误码时自动删除该登记（卸载重装 / 恢复出厂会换 token，客户端每次启动重新上报兜底）。

### 3.4 Push Kit 服务端通道（HarmonyOS NEXT / 5.0+，已核官方口径）

- 端点：`POST https://push-api.cloud.huawei.com/v3/{projectId}/messages:send`
  （**v1/v2 老接口推不到 NEXT 设备**）；请求头必带 `push-type: 0`（通知消息）。
- 鉴权：**服务账号 JWT 直接作 Bearer**（NEXT 不再支持 OAuth2 client_credentials）：
  用 AGC「项目级服务账号密钥」签 JWT，claims `kid = key_id`、`iss = sub_account`、
  `aud = https://oauth-login.cloud.huawei.com/oauth2/v3/token`、`exp ≤ 3600s`（可复用缓存）。
  签名算法以官方《基于服务账号生成鉴权令牌》为准（社区实测有 RS256/PS256 口径差异，
  联调时以真机回执定案，实现里做成可配置）。
- 消息体：`{ payload: { notification: { category, title, body, clickAction, ... } },
  target: { token: [...] } }`；**`category` 必填**，且需在 AGC 申请「自分类权益」
  （确认 / 提问类通知按华为消息分类标准选类，如 WORK / DEVICE_REMINDER，
  否则按营销消息限流，到达率不可接受）。
- 客户端 token 来自 `pushService.getToken()`；卸载重装 / 恢复出厂 / 显式 deleteToken
  会变化 → App **每次启动**获取并比对上报（官方建议口径）。
- 纯 Node 实现（`node:crypto` 签 JWT + `fetch` 发送），不引第三方 SDK，维持
  「`ws` 是唯一运行时依赖」的现状（JWT 手写 RS256/PS256 签名约 40 行）。

## 4. 鸿蒙客户端实现方案

### 4.1 技术栈与工程位置

- ArkTS + ArkUI（Stage 模型，HarmonyOS NEXT / API 12+），DevEco Studio 构建；
  建议放 `apps/harmony/`（**不进 pnpm workspace**，hvigor 独立构建；现有 Windows CI
  不覆盖它，验收靠 DevEco 模拟器 + 真机清单）。
- 系统能力：`@ohos.net.webSocket`（长连）、`@ohos.net.http`（REST）、
  `@hms.core.push.pushService`（推送 token）、`@ohos.security.huks`（令牌保险库）、
  `preferences`（服务器列表 / 偏好）、`filePicker` / 安全保存组件（文件）、
  `AVPlayer`（TTS 播放）、`AudioCapturer`（录音）。
- 协议类型从 `packages/shared/src/center/protocol.ts` 移植（纯类型 + 常量，无 Node
  依赖；ArkTS 子集限制下基本可直接搬，作为 `common/protocol/` 单源维护）。

### 4.2 两条路线（建议 v1 走 A，v2 演进 B）

**路线 A · 混合壳（推荐 v1）**：原生壳 + ArkWeb 承载现有 Center Web 控制台。

- 原生负责：登录 / 注册 / 多服务器管理（HUKS 存令牌）、推送登记与深链、
  文件下载接管（`onDownloadStart` → 原生下载 + 保存）、通知栏快捷批复（P1 的 REST）、
  录音桥（可选）；ArkWeb 加载 Center 地址，令牌经同源 `localStorage` 注入
  （Web 端 `lib/api.ts` 本就存 localStorage），hash 路由直达各视图。
- 收益：**即刻继承全部功能面与 106 条断言验收过的移动端 UI**（≤720px 单栏抽屉已适配），
  Center 网页端每次升级 App 自动跟随；原生推送补上最大缺口。
- 代价 / 风险：非原生观感；ArkWeb 明文 HTTP 限制需单独配置（§4.4）；
  `getUserMedia` 需 `onPermissionRequest` 桥接（或原生录音 + JS 桥注入）；
  AppGallery 对「纯 WebView 套壳」有最低功能性审核口径 —— 原生登录 / 推送 / 文件管理
  通常足以过审，需真机送审验证。

**路线 B · 纯原生（v2 目标或一开始就选）**：ArkUI 原生设备列表 / 会话流 / 控制面板。

- 模块：`common/net`（HttpClient：Bearer + 401→refresh→重试一次；WsClient：45s ping
  看门狗、1s→5s 指数退避 ±20% 抖动，**与桌面 connector 同口径**）、`common/store`、
  `features/{auth,devices,session,files,usage,automations,plugins,push}`。
- 会话流按 `messageId` 聚合增量、`requestId` 工作胶囊、工具卡 / 待办卡 / 确认提问卡，
  语义与 Web `MessageStream` 对齐（可参照其 DOM 口径写原生探针）。
- Markdown 分级渲染：基础语法 / 代码块 / 表格原生 RichText；mermaid / KaTeX / echarts
  懒加载 ArkWeb 卡片（共享渲染器的 HTML 产物直接喂 WebView，安全基线不变：
  先转义再白名单，绝不裸渲染模型原文）。
- 插件面板：声明式 schema 原生渲染（移植 `PluginSchemaRenderer` 节点分支）；
  页面型走 ArkWeb 加载 `/p/` 资源 + postMessage 桥（`createWebMessagePorts`，
  桥协议与 `CENTER_PLUGIN_PAGE_SOURCE` 口径一致）。
- 代价：会话流渲染工作量大（Web 侧经 54 场景打磨），v1 周期显著拉长。

### 4.3 WS 生命周期与后台策略（两条路线通用）

- 前台：连 `/api/ws?token=` → 发 `web.hello` → 收 `clients` 快照 + `pendingAsks` 回放；
  另拉 `GET /api/pending` 对账确认卡；断线按退避重连，重连后重放订阅、重拉历史。
- 后台：鸿蒙挂起进程、WS 必断 —— **不做无谓保活**，可靠触达完全交给 Push Kit；
  可选：用户正在进行的会话申请长时任务（continuous task）临时保活，须显式告知并符合审核口径。
- 推送深链：`{ kind, clientId, sessionId, requestId }` → 冷启动先 refresh 令牌 →
  连 WS / 拉 pending → 直达对应会话或待办卡；窗口已过 → 如实显示「已超时 / 已失效」。
- 登出：`POST /api/auth/logout` + `pushService.deleteToken()` 可选 + 清 HUKS。

### 4.4 安全与平台约束（如实写进 App 文档）

- **令牌存 HUKS**，不落 preferences 明文；日志脱敏（同仓库口径）。
- **公网必须 HTTPS**（Center 部署本就要求 TLS 反代，deploy/README）。鸿蒙默认拦截
  明文 HTTP：内网 `http://IP:8787` 直连需在 `resources/base/profile/network_config.json`
  显式放行（API 18+ 域名配置 / cleartext 开关，ArkWeb 与 Network Kit 口径分别核对）；
  **AppGallery 发布包按审核口径强制 HTTPS**，明文放行只进调试包 —— 内网自托管用户
  引导上 TLS 反代，与 Center 现有安全指引一致。
- 推送载荷最小化（§3.3）；通知文案不含会话内容；锁屏通知默认隐藏详情。
- 隐私提示：HarmonyOS NEXT 推送数据处理地固定为中国（华为官方口径），海外用户需知情。
- 限速注意：移动网络 CGNAT 共享出口 IP，认证限速按源 IP 计（只记失败）理论上可能
  误伤 —— 风险低（失败 5 次/分钟才触发），文档注明即可，不改口径。

### 4.5 语音与文件（Center 零改动，客户端承接）

- 语音输入：原生录音（AAC/m4a）→ base64 → `stt.transcribe`（`mime: 'audio/mp4'`）。
  容器 / 编码与桌面 STT provider 的兼容面需真机实测（网页端现用 webm/opus 或 mp4），
  必要时 AudioCapturer 指定编码；Center 只转发，接口形状不变。
- 朗读：`tts.synthesize` 回执 base64 → AVPlayer 播放（分块边播边取口径同 Web v43）。
- 文件：上传 = filePicker 选文件 → `POST /api/uploads?clientId=`；
  下载 = `GET /api/files/:fileId`（会话令牌）→ 安全保存组件落公共目录；
  图片附件随 `session.input.attachments` 上行（≤5 张、单张 ≤8MiB，服务器已校验）。

## 5. 分期里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 文档先行 | 本提案评审 → 并入 docs/12 新章节（§15 鸿蒙遥控台）+ docs/08 无需动（不改桌面配置 Schema） | 评审通过 |
| M1 Center P0 | 持久会话 / refresh / logout、web.hello、pending 快照、推送登记 / 偏好 / AGC 通道、单测 | `pnpm vitest run packages/center` 全绿 + `pnpm typecheck`；`verify:web` 基线 106 条不回归 + 新增桩场景（注册 / 偏好 / pending / 在线抑制 / 假 sender 投递）；**服务器重启后 App 令牌仍有效**实测 |
| M2 App v1（路线 A） | 原生壳 + ArkWeb 控制台 + 推送深链 + 文件下载接管 | 真机清单：登录持久、后台收推送并在 60s 窗口内点开批复成功、文件上下行、语音、断网重连对账 |
| M3 P1 | REST 快捷批复 + 通知栏动作、管理端会话 / 推送配置卡、官网鸿蒙入口 | 通知栏一键批复与本机 / 网页先到先得；管理员吊销会话后 App 立即 401 |
| M4 P2（按需） | 扫码登录 / 纯原生会话流 / 更新源 / 推送中继 | 逐项立项 |

发布口径：Center 升 `packages/center/package.json`（0.6.0 → 0.7.0），按
`packages/center/deploy/README.md` 重新打包换装；**不打 tag、不传 GitHub Releases**
（Center 版本线独立）。App 走 AppGallery 独立发布线。

## 6. 安全边界小结（与 docs/12 §11 对齐）

- 持久会话 = 新的长效凭据面：只存哈希、轮换即吊销旧令牌、每用户上限、管理员可吊销、
  登出级联清推送 —— 护栏不低于客户端令牌。
- 推送不扩大数据可见面：载荷只有路由字段；内容仍走既有属主 / 管理员鉴权的 WS/REST。
- 不引入端到端加密（与 Center 现状一致，文档明示）；公网部署必须 TLS。
- REST 快捷批复不绕过任何闸门：与 WS 同授权、同转发、客户端本地确认链先到先得。
- 设备侧协议、桌面白名单（docs/12 §6.2）、`SETTINGS_READONLY_PREFIXES` 全部不动。

## 7. 风险与开放问题（需决策）

| # | 风险 / 问题 | 建议 |
|---|---|---|
| R1 | **推送凭据与 App 签名绑定**：官方 App 的 AGC 服务账号密钥不能分发给自托管 Center | 默认「推送 = 官方 Center 开箱即用；自托管需自有 AGC 项目 + 自签变体」，文档如实写；是否做官方中继（P2-M）单独立项 |
| R2 | 自分类权益审批：确认 / 提问通知的 category 归类与到达率 | M1 期间在 AGC 申请并真机实测到达率 / 时延；不达标则调整 category 或申请权益 |
| R3 | JWT 签名算法口径（官方文档 PS256 vs 社区实测 RS256） | 实现做成可配置，联调以真机回执定案 |
| R4 | ArkWeb 明文 HTTP / localStorage 注入 / getUserMedia 桥接 | M2 第一周真机 spike 验证，不通则切路线 B 或原生录音桥 |
| R5 | AppGallery「套壳」审核口径 | 原生壳保持实质功能（登录 / 推送 / 文件 / 快捷批复）；送审前自查最低功能性要求 |
| R6 | 鸿蒙后台保活预期管理 | 产品文案明确「后台靠系统推送，前台实时」；不做违规保活 |

## 8. 参考

代码事实（本仓库）：
- `packages/center/src/auth.ts`（会话内存 Map / 7 天 TTL / 令牌哈希口径）
- `packages/center/src/server.ts`（路由装配、`/api/ws` 升级、限速表）
- `packages/center/src/hub.ts`（confirm/ask/file 路由钩子、pendingAsks 回放）
- `packages/center/src/secrets.ts`（HKDF + AES-256-GCM SecretBox）
- `packages/center/src/releases.ts`（更新源 staging→publish 形状）
- `packages/shared/src/center/protocol.ts`（三方共享协议，只增不改）
- `packages/center/web/src/lib/api.ts`（Web 令牌存 localStorage）
- docs/12 §3–§6、§11–§14（鉴权 / 协议 / 安全边界 / 更新源 / 市场）

外部事实（华为官方 / 社区，2026-11 核对）：
- [Push Kit REST v3 请求体结构（push-type / category / JWT 鉴权）](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/push-scenariozed-api-request-struct?docScope=all#request-header)
- [推送服务服务端开发指南（v1/v2 仅旧系统，NEXT 必须 v3）](https://developer.huawei.com/consumer/cn/doc/HmSCore-Guides/android-server-dev-0000001050040110)
- [鸿蒙 5+ Push Kit 服务端接入实战（服务账号密钥 / RS256 口径差异 / 常见坑）](https://developer.huawei.com/consumer/cn/blog/topic/03228341353512028)
- [获取 Push Token（token 变化场景与每次启动上报建议）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-preparations-0000001727885250)
- [HarmonyOS 明文 HTTP 拦截与 network_config.json 放行](https://developer.huawei.com/consumer/cn/blog/topic/03221416988130045)
- [鸿蒙厂商推送自分类权益与 AGC 配置流程（社区整理）](https://doc.dcloud.net.cn/uniCloud/uni-cloud-push/harmony.html#1)
