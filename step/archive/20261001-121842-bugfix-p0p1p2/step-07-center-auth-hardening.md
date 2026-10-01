# Step 07 — Center 认证限速与资源防护

- Task: bugfix-p0p1p2
- Step: 7 / 12
- Status: done
- Depends on: step 1（同改 `packages/center/src/server.ts` 与 `server.test.ts`，串行避免冲突）
- Produces: 登录/注册/设备授权端点限速；设备挑战表清扫 + 上限；密码校验异步化；下载/静态流挂 error 监听；CLI 与运行中服务器的并发写防护；配套单测
- Phase: 安全与边界
- Writes: `packages/center/src/auth.ts`、`packages/center/src/auth.test.ts`、`packages/center/src/device.ts`、`packages/center/src/device.test.ts`、`packages/center/src/server.ts`、`packages/center/src/server.test.ts`、`packages/center/src/cli.ts`、`packages/center/src/cli.test.ts`（新建）、`docs/12-aurora-center.md`
- Size: M
- Risk: 异步 scrypt 会改 `verifyPassword` 签名，调用点（`server.ts` 约 322、376）要跟着 await，漏一处就是同步上下文拿到 Promise 恒真——改完全局搜调用点；限速键取 IP 时注意部署在反代后 `x-forwarded-for` 可伪造，优先用 socket 地址（当前直连部署无反代）

## 目标

公网部署的 Center 服务器：登录不可被不限速穷举、无认证端点不能撑大内存、密码校验不阻塞事件循环、TTL 清理竞态不再击穿进程、CLI 管理命令不再与运行中服务器互相覆盖 users.json。

## 输入

- `bug/P2-一般.md` 的 P2-12、P2-13、P2-15、P2-16、P2-17（每条含 文件:行、触发条件与修复建议）；证据在 `bug/_raw/U5-center.md`
- 源码：`packages/center/src/server.ts`（登录/注册/设备授权端点约 320-415、`scryptSync` 调用点约 322 与 376、文件下载与静态服务 ReadStream 约 646、662）；`packages/center/src/auth.ts`（`scryptSync` 约 47-49、会话表约 210-225、`verifyPassword` 跳过 scrypt 的分支约 161-162——注意 P3-13 时序侧信道本次不修，但改异步时别扩大范围）；`packages/center/src/device.ts`（start 约 58-66）；`packages/center/src/cli.ts`（users 管理命令约 111-115）；`packages/center/src/store.ts`（整文件覆盖写约 72-73，本步不改它，P2-17 靠 CLI 侧拒绝解决）
- 部署事实：Center 已部署阿里云 120.24.223.65:8787（直连，无反代）；本步只改代码，不部署
- P3 例外：P3-13（假盐拉平时序）、P3-14（CLI 回显）、P3-16（令牌传递加固）属 P3 范围，本步不做

## 操作

1. P2-12：`server.ts` 的 login / register / 设备授权端点加按源 IP 的滑动窗口限速（如 login 5 次/分钟，超限回 429 或错误帧；注册与设备授权可用更宽阈值）；`auth.ts` 的 `createWebSession` 时顺带清扫过期会话（会话表不再只靠查询时顺带删）。
2. P2-13：`device.ts` 的 `start()` 开头调 `sweep()`，并给挑战表设总量上限（超限拒绝新挑战或淘汰最旧，二选一）。
3. P2-15：`auth.ts` 的 `scryptSync` 换异步 `crypto.scrypt`（`promisify` 后 await）；`server.ts` 两个调用点跟随 await；全局搜索确认无其他 `scryptSync` 调用点遗漏。
4. P2-16：`server.ts` 两处 `createReadStream`（文件下载约 646、静态服务约 662）挂 `error` 监听——headersSent 前回 404、之后 destroy 响应，ENOENT 不再击穿进程。
5. P2-17（文档先行）：`docs/12-aurora-center.md` §9 标注「users 子命令需先停服」；`cli.ts` 的 users 写命令（passwd/add/remove）执行前检测服务器运行中——数据目录锁文件方案（server 启动创建、退出删除；崩溃残留的陈旧锁按 mtime 超时视为无服务器），命中则警告并拒绝执行；检测逻辑抽纯函数供单测。
6. 测试：`server.test.ts` 加限速用例（第 6 次登录被拒）与下载竞态用例（流 open 前删文件 → 404 而非崩）；`auth.test.ts` 回归异步 scrypt（含错误密码路径）；`device.test.ts` 加 sweep + 上限用例；`cli.test.ts` 新建，覆盖锁文件检测纯函数（无锁放行、新鲜锁拒绝、陈旧锁放行）。
7. Conventional Commits 中文分组提交（`fix(center): ...`），提交信息尾注覆盖的条目号（如 `...(P2-12, P2-15)`）。

## 验收标准

- [ ] `pnpm vitest run packages/center/src` 全绿，且含上述新用例（限速、异步 scrypt、挑战 sweep/上限、下载竞态 404、锁检测三态）
- [ ] `pnpm typecheck` 通过；`pnpm --filter @aurora/center build` 通过
- [ ] `docs/12-aurora-center.md` §9 有「users 子命令需先停服」标注
- [ ] 代码核对：异步化后无残留 `scryptSync`；限速只挡认证类端点、不影响 WS 心跳与正常 API

## 交接

- 锁文件路径与超时阈值写进「执行记录」——部署到阿里云后（不在本计划内）CLI 与服务器要同版本上线，否则旧 CLI 不认识锁文件。
- 限速参数（阈值/窗口）集中在一处常量并写进「执行记录」，便于调参。

## 执行记录

**提交**：`c785313 fix(center): 认证端点限速、异步 scrypt、挑战表清扫、流错误监听与 CLI 停服防护`

**分片与结果**：单分片，1 个实现子代理（general-purpose）在 step-01 提交之上继续改。主代理复跑验收命令。

**实际改动**
- `auth.ts`（P2-15 / P2-12）：`scryptSync` → `promisify(scrypt)`，`hashPassword` 变 `async`，三处调用点（`createUser` :151 / `verifyPassword` :192 / `resetPassword` :207）全部 `await`；新增 `AuthStoreOptions.now` / `maxSessions`，`createWebSession` 先 `sweepSessions()` 再按 `MAX_WEB_SESSIONS = 10_000` 淘汰最旧；`verifyWebSession` 改用注入时钟；加只读 `sessionCount`。
- `server.ts`（P2-12 / P2-16 / P2-17）：新增 `AUTH_RATE_LIMITS`（:75）+ `SlidingWindowLimiter`（:91，窗口内时间戳数组、键上空即删防自身膨胀）+ `sourceKeyOf`（**只取 `req.socket.remoteAddress`**）；限速只出现在 4 个认证端点（login :490、register :521、client/login :547+567、device/start :600）；新增 `streamFile`（:861）——`open` 事件里才 `writeHead(200)`，挂 `error` → 未发头 404、已发头 `res.destroy()`，`serveFile` / `serveStatic` 都改走它；锁文件 `acquireLock` / `releaseLock`（:922 / :948），`listen` 成功回调里创建、`close()` 里删除并清 interval。
- `device.ts`（P2-13）：`start()` 开头 `sweep()` + `evictOldest()`（**淘汰最旧**，不拒绝新挑战，避免"刷满挡人"）；新增 `DEVICE_MAX_CHALLENGES = 1000` 与 `maxChallenges` 选项、只读 `size`。
- `cli.ts`（P2-17）：`USER_WRITE_ACTIONS = {add, passwd, remove}`，`runUsers` 在这三个动作前 `inspectServerLock`：`running` → stderr 三行说明 + 返回 1；`stale` → 仅提示继续；`list` 不限。USAGE 补一行「写命令需先停服」。
- `docs/12-aurora-center.md`：§2.2 / §3 / §4.3 / §9 / §11 同步。

**锁文件契约（本文件第 43 行要求留档）**
- 路径：**`<dataDir>/server.lock`**；内容 `{ pid, startedAt }`。
- 生命周期：服务器 `listen` **成功后**创建、`close()` 删除、每 **15s** `utimes` 刷 mtime。
- 陈旧判定：**`SERVER_LOCK_STALE_MS = 60_000`**（`now - mtime > 60s` → `stale`，视为无服务器放行）。
- 常量位置：`server.ts:134-136`（`SERVER_LOCK_FILE` / `SERVER_LOCK_STALE_MS` / `SERVER_LOCK_REFRESH_MS`）；纯函数 `evaluateServerLock`（:149）+ 读盘 `inspectServerLock`（:159）。
- ⚠️ 部署提示：**CLI 与服务器必须同版本上线** —— 旧服务器不写 `server.lock`，新 CLI 认不出"服务器在跑"（行为与升级前一致，不会误拒）。`init` 按 step 范围**未**加停服约束（只覆盖 `users` 的 add / passwd / remove）。

**限速参数（本文件第 44 行要求留档，集中在 `server.ts:75 AUTH_RATE_LIMITS`）**
| 端点 | 阈值 | 记数口径 |
|---|---|---|
| `/api/auth/login` + `/api/client/login`（共用一把） | **5 次 / 60s** | **只记失败** |
| `/api/auth/register` | **10 次 / 60s** | 成功也记 |
| `/api/device/start` | **30 次 / 60s** | 记全部 |
键 = 作用域 + **socket 源 IP**（`sourceKeyOf` 只取 `req.socket.remoteAddress`，不信任可伪造的 `x-forwarded-for`）。超限回 `429 {"error":"E_RATE_LIMITED"}`。**部署提示**：当前是直连无反代，上反代必须改这一处口径。

**异步 scrypt 调用点核对清单（全仓 `scryptSync` 源码零残留）**：`auth.ts:61`（唯一实现处 `await scryptAsync`）、`auth.ts:151` / `:192` / `:207`（三处调用点）、`server.ts:497-498`（login，**原本就已 await**）、`server.ts:567`（client/login，原本就已 await）。`hashPassword` 未导出；desktop / agent-core 不 import `@aurora/center`。残留的 `scryptSync` 字样只在注释 / docs / bug / step 里。

**验证（主代理实跑）**
```
pnpm vitest run packages/center/src → 7 files / 102 tests 全绿（device 11 / store 2 / files 8 / cli 4 / hub 25 / auth 18 / server 34）
pnpm typecheck                      → 全部 Done
pnpm --filter @aurora/center build  → tsc + vite，✓ 55 modules transformed
pnpm test                           → 115 files / 2028 tests 全绿
```
子代理两次反向复核（验完已还原）：把 `serveFile` 还原成裸 `createReadStream(path).pipe(res)` → 下载竞态用例 FAIL（20s 超时）+ `Uncaught Exception — ENOENT`（正是 P2-16 的崩溃形态）；去掉 `verifyPassword` 的 `await` 与 `createWebSession` 的 `sweepSessions()` → `auth.test.ts` 7 failed。

**遗留 / 注意**
- 限速状态在**进程内存、按单源 IP 计**，不是 DDoS 防护（分布式源 IP 可绕、重启即清零）—— docs/12 §11 已如实标注。
- `serveStatic` 的一处**有意行为变化**：stat 成功但流 open 前文件消失时回 404，不再回落到 `index.html`（SPA 路由仍照常回落，因为那些路径 stat 就失败）。
- 失败登录现在落 `warn` 日志（按源 IP，量被限速封顶）；嫌吵可降 debug。
- 会话上限默认 10 000 条并按插入序淘汰最旧（极端活跃客户端可能需重登；正常规模远达不到）。
- P3-13 / P3-14 / P3-16 按要求未做；`store.ts` 未改（P2-17 走 CLI 侧拒绝）。

