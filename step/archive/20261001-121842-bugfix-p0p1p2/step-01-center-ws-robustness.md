# Step 01 — Center 服务器 WS 健壮性与回执完整性

- Task: bugfix-p0p1p2
- Step: 1 / 12
- Status: done
- Depends on: none
- Produces: 畸形入站 WS 消息不再击穿服务器进程；命令回执按连接隔离、伪造无效；单帧上限 1 MiB；网页端相同内容连续消息不丢失；对应单测
- Phase: 安全与边界
- Writes: `packages/center/src/hub.ts`、`packages/center/src/hub.test.ts`、`packages/center/src/server.ts`、`packages/center/src/server.test.ts`、`packages/center/web/src/store.ts`
- Size: M
- Risk: P1-03 的 pending 键改造横跨 forwardCommand 与 result 两端，改错会断掉正常回执——先读懂 hub.ts 现有 pending 生命周期再动手；回滚 = revert 本步提交

## 目标

任意已认证 WS 连接发送畸形消息（缺字段 / 错型 / 超大帧）不再使服务器进程崩溃；回执只投递给发起连接；网页端多页签与伪造回执两个症状一起消除。

## 输入

- `bug/P0-阻断.md` 的 P0-01、`bug/P1-严重.md` 的 P1-02 与 P1-03、`bug/P2-一般.md` 的 P2-14 与 P2-18（每条含 文件:行、触发条件与修复建议）；证据细节在 `bug/_raw/U5-center.md`
- 源码：`packages/center/src/hub.ts`（checkPatch 约 358 行、handleClientMessage 的 config.update 分支约 149-160 与 confirm.request 约 417、pending 表约 341/371）；`packages/center/src/server.ts`（两个 WebSocketServer 约 107-108、ws message 监听器约 157-169 与 306-310）；`packages/center/web/src/store.ts`（nextRequestId 约 221-224、user-message 去重约 370-372）
- 现有测试：`packages/center/src/hub.test.ts`、`packages/center/src/server.test.ts`（现有用例全部只发合法消息，畸形分支零覆盖）
- 全仓没有任何 `process.on('uncaughtException')` 兜底——监听器内的 try/catch 是唯一防线

## 操作

1. P0-01：`hub.ts` 的 `checkPatch` 开头加形状守卫——`patch` 非纯对象（`typeof !== 'object'` / `null` / `Array.isArray`）时返回错误码（如 `'E_INVALID_PATCH'`），不再让 `Object.keys(patch)` 对 undefined 求值。
2. P1-02：`hub.ts` 的 `confirm.request` 分支加同型守卫——`message.request` 非纯对象即丢弃该消息（或回错误帧），两处调用点都在保护范围内。
3. P0-01/P1-02 兜底：`server.ts` 的两个 ws `message` 监听器统一包 try/catch——单条消息解析或处理抛错时记日志并回错误帧（或断开该连接），异常不得穿透到进程级。
4. P1-03 服务端：pending 回执键改按连接隔离——`${webConnId}:${requestId}` 复合键，或 pending entry 记录发起 clientId 并在 `result` 处理时校验一致（二选一，以改动面小且不破坏既有协议形状者为准）。
5. P1-03 网页端：`packages/center/web/src/store.ts` 的 `nextRequestId()` 从 `web-1`、`web-2` 自增改为 `crypto.randomUUID()`。
6. P2-14：`server.ts` 的两个 WebSocketServer 构造都加 `maxPayload: 1024 * 1024`（超限帧由 ws 自动断开该连接）。
7. P2-18：`web/src/store.ts` 的 user-message 去重改用「内容 + 出现次数」配对口径（对齐本文件 mergeHistory 已有实现），相同内容的第二条消息不再被当回显丢弃。
8. 补单测（见验收标准）；Conventional Commits 中文分组提交（`fix(center): ...`），提交信息尾注覆盖的条目号（如 `...(P0-01, P2-14)`）。

## 验收标准

- [ ] `pnpm vitest run packages/center/src` 全绿，且新增用例覆盖：① 缺 `patch` 的 `config.update` 与缺 `request` 的 `confirm.request` 不抛错、进程不崩（回错误帧或忽略）；② 连接 A 发起的命令，连接 B 发伪造 `result` 不投递给 A；③ 两个连接用相同 requestId 互不串扰；④ 超过 maxPayload 的单帧使该连接被关闭而服务器存活
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm --filter @aurora/center build` 通过（覆盖 `web/src/store.ts` 的 vite 构建）

## 交接

- Step 07 会继续改 `packages/center/src/server.ts`（限速、异步 scrypt、流错误监听），本步收尾时该文件必须处于可编译、测试全绿状态。
- 回执键的最终形状（复合键还是 clientId 校验）写进本文件「执行记录」，供 step-07 与代码审查参考。

## 执行记录

**提交**：`dfe64be fix(center): WS 入站形状校验、回执按连接隔离、单帧上限与网页端去重`

**分片与结果**：单分片，1 个实现子代理（general-purpose；首次派发的 Programmer 子代理立即报 `provider-not-found`，与既往记录一致，改派 general-purpose 后一次通过）。主代理复跑全部验收命令。

**实际改动**
- `hub.ts`：新增模块级 `isRecord()`；`checkPatch(patch: unknown)` 开头 `if (!isRecord(patch)) return 'E_INVALID_PATCH'`；`confirm.request` 分支开头 `if (!isRecord(message.request)) return`；pending 表键改 `` `${webConnId}:${requestId}` ``、entry 记为 `PendingEntry { webConnId, clientId, requestId, timer }`；新增 `settlePending(clientId, requestId)`（按插入顺序首个匹配），`result` 改走它并加 `typeof requestId !== 'string'` 守卫；超时闭包改为只删自己那一条。
- `server.ts`：两处 `ws.on('message')` 统一包 try/catch（客户端侧新增 `dispatchClientMessage()`，实时与排队回放都走它；网页侧能定位 requestId 时回 `E_INTERNAL` 错误帧）；两个 `WebSocketServer` 加 `maxPayload: MAX_WS_PAYLOAD`（1 MiB）；新增 `watchSocketErrors(ws, describe)` 并在两条连接路径各挂一次。
- `web/src/store.ts`：`nextRequestId()` 由 `web-N` 自增改随机 id（`crypto.randomUUID()`，非安全上下文回落 `crypto.getRandomValues` 拼 128 位十六进制）；`user-message` 去重改为「只与 `local-` 乐观气泡按内容逐条配对」，配对成功就地把该气泡 id 升级为 `user-<seq>`（幂等、可重复消费）。

**回执键的最终形状（本文件第 44 行要求留档）**：采用**复合键 + clientId 校验的合并方案**，而非二选一。键是 `` `${webConnId}:${requestId}` `` —— 只有它才能让两个页签各自存一条 pending（纯 requestId 单键会被后者覆盖，正是 P1-03 症状①）；但 `result` 帧只带 requestId，所以 entry 里同时记 `clientId`，`result` 到达时用 `settlePending(clientId, requestId)` 按插入顺序首个匹配取回并删除（症状②伪造注入因此被封堵：猜中 requestId 也匹配不到「目标客户端 + requestId」）。**协议形状零变化**：`result` / `cmd` 字段未动，`apps/desktop` 的 connector 只透传 `cmd.requestId`，全仓无任何代码依赖 `web-N` 格式。代价是一次 O(在途命令数) 线性扫描（量级极小）；step-07 若要优化可加二级索引，当前无必要。

**验证（主代理实跑）**
```
pnpm vitest run packages/center/src   → 7 files / 102 tests 全绿（基线 79 → +23，含 step-07 新增）
pnpm typecheck                        → 全部 Done
pnpm --filter @aurora/center build    → ✓ 55 modules transformed（覆盖 web/src/store.ts）
```
新增用例覆盖验收标准的四类：缺 `patch` 的 `config.update` 与缺 `request` 的 `confirm.request` 不抛错；连接 B 伪造 `result` 不投递给 A；两连接同 requestId 互不串扰；超 maxPayload 单帧断开该连接而服务器存活。

**遗留 / 注意**
- `maxPayload` 必须与 `ws.on('error')` 监听一起上：ws 的 receiver 判超限后 `emit('error', RangeError)`，而服务端 socket 原本没有 error 监听，会抛成 `uncaughtException`（子代理已实测复现）。审查时不要把这条监听当"超出本步意图"回退。
- 网页端随机 id 加了非安全上下文兜底：`packages/center/deploy/README.md` 与 docs/12 §9 支持「明文 HTTP + IP 直连」部署，那种上下文里 `crypto.randomUUID` 为 `undefined`，直接调用会让 `sendInput` 整条炸掉。
- hub 的 `status` 分支与 `session.event` 的 `event` 仍未做形状校验（原始报告 U5 标注为「网页端有 null 守卫、未发现崩溃」，按最小改动未动）。
- 本步的限速 / 异步 scrypt / ReadStream error 监听均未做（属 step-07 范围），`server.ts` 交出手时测试全绿。

