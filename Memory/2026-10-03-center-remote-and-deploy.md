---
date: 2026-10-03
title: Aurora Center 的接线、确认卡/提问卡中转与部署口径
tags: [center, 远程, 部署, 坑]
source: 模型自动记录
---

# Aurora Center：接线、中转与部署

## 现象

1. **CLI `start` 秒退**：写成"注册完信号处理器就 return"，bin 启动器在 `runCli` 返回后 `process.exit`。
2. **客户端握手不触发 `'connection'`**：`ws` 库手动 `handleUpgrade` 时回调**替代**了 `'connection'` 事件
   （库内只有自动挂 upgrade 监听的那条路径会 emit）。
3. **镜像里是旧前端**：`deploy/Dockerfile` 只 `COPY dist-web`，镜像里不跑构建 —— 忘了先
   `pnpm --filter @aurora/center build` 就会把旧前端打进镜像（症状正是「客户端配了语音，网页上没有麦克风/朗读按钮」，
   那段 UI 是 v0.3.2 才有的）。
4. **探真实部署时读错语义**（2026-10-03 实测）：`GET /` 会因 SPA 回落返 200；`HEAD /` 返 401
   **不代表路由不存在**；探 WS 必须带**任意非空** `Authorization: Bearer x`，否则经隧道会变成 **502（不是 401）**。
5. **按"每客户端"理解登录限速会判断错**：限速键取 `req.socket.remoteAddress`（**不读可伪造的 `x-forwarded-for`**，
   见 `packages/center/src/server.ts` 的 `AUTH_RATE_LIMITS`）—— Docker / 反代之后所有客户端塌成同一个网关 IP。
6. **提问卡刷新后永远答不上**：服务器没有回放未过期的提问。
7. **网页端验收的装置与判据容易被说糊**：`packages/center/verify/` 起**真实服务器子进程**（临时数据目录）
   + 一台**协议忠实的桩客户端**（脚本化制造流式正文 / 工具三态 / 子代理快照 / 确认卡 / 提问卡 / 文件上传）
   + `puppeteer-core` 驱动的系统 Edge，逐场景推进状态后截图 + 读 DOM 写 `report.json`；
   判据同 `capture.ts`：**任一条 `ok: false` → 退出码 2**。

## 原因

- `packages/center` 是纯 Node 服务器（CLI + Web UI，构建 = tsc + vite），服务器托管的是**构建产物**，
  与桌面端的 dev 流程不同。
- 确认卡与提问卡是两套语义不同的中转（窗口时长、幂等、回放策略都不同），抄成一样就会出错。

## 影响

- 部署类问题表现成"网页功能缺失"，很容易被误判成客户端没上报能力位；
  用 `pnpm --filter @aurora/center verify:web:status --server <url> --user <名> --password <密码>`
  （管理员身份打印每个客户端的 `ClientStatus`，含 `voice`）区分「客户端没上报语音」与「网页是旧包」。
- 限速 / 探测语义读错，会把"基础设施的行为"当成 bug 去改。

## 结论与做法

- **四处接线**：① CLI `start` 必须**常驻**（`await` 信号后才 return）；
  ② 服务器端客户端握手是 `beginClientSession(ws, token)` **直调**，别改成依赖 `clientWss.on('connection')`；
  ③ `center.token` 是凭据路径（⇄ `center.tokenEnc`），
  与 apiKey 同款 5 处同步；`center.*` 整组在 `SETTINGS_READONLY_PREFIXES`，但远程配置走
  `main/center/remote-control.ts` 的独立白名单（`CENTER_REMOTE_CONFIG_PREFIXES`），**两条通道语义不同别混改**；
  ④ 远程补丁应用前必须先在 `structuredClone` 副本上演练（`SettingsStore.mutate` 的 draft 是**活对象**）。
- **确认卡网页批复**：只有 `center-` 前缀会话的敏感工具确认会经 connector 推 Center（`confirm.request`），
  网页批复下发 `confirm.resolve`，最终调 `proactive.resolve`（对已结算 confirmId 幂等，本地卡与网页卡先到先得）；
  v0.2.4 起 `center_send_file` 直接发送不产生确认卡；设备授权登录（`center:deviceLogin` IPC）与账号密码直登的
  **凭据落库路径共用同一函数**，改落库只改一处；上传文件 24h TTL 清理在 `packages/center/src/files.ts`
  （启动 + 每 15 分钟一轮）。
- **提问卡中转（`ask_user`，v0.3.3，docs/12 §5）**：Agent 向用户提问时，本地卡片之外经 `ask.request`
  上行到 Center（网页端渲染提问卡）、网页作答经 `ask.resolve` 下行回 `AskUserService.resolve`，
  与本地卡**先到先得**（幂等，回执 `{ settled }`）。三条口径别改错：
  ① 只有 `center-` 前缀会话上行，且受 `center.allowRemoteSession` 闸门约束（比确认卡更严：关掉时连卡片都不推、
  也拒绝网页作答）；② `ask.resolve` 的 `requestId` 是**提问卡自身的 id**（客户端分配），不是网页端生成的命令 id ——
  与其它命令的约定**相反**，改协议时别顺手"统一"；③ 服务器为提问卡保留 `pendingAsks` 并在网页**新连上时回放**
  未过期项（180s 窗口）；**确认卡没有这条回放**（60s 窗口，属既有行为），别把两者抄成一样。
  装配逻辑抽在 `apps/desktop/src/main/center/ask-relay.ts`（纯函数、有单测）；
  真端到端在 `main/center/ask-relay.e2e.test.ts`（真服务器 + 真连接器 + 真 AskUserService，跑在 vitest 里，
  不需要 Electron —— 所以 `apps/desktop` 有一个**仅测试用**的 `@aurora/center` devDependency）。
- **部署要"先构建、再打镜像"**（docs/12 §10 / `packages/center/deploy/README.md`）；
  `docker-compose.yml` 的镜像 tag 跟着版本号走（本轮从 `0.3.0` 提到当时版本），**别在同一 tag 上反复覆盖**（排障时说不清线上是哪一版）。
- **远程会话与本地发送是同一条链**：Center 的 `session.input` → `SessionBridge` →
  `agent.send({ origin: 'center' })`（`SendMessageRequest.origin` 已放宽）；只转发 `center-` 前缀会话的事件，
  别在别处再写一条"远程专用"发送通路。
