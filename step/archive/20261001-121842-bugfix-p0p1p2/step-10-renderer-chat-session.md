# Step 10 — 渲染层 chat 会话同步与流收尾

- Task: bugfix-p0p1p2
- Step: 10 / 12
- Status: done
- Depends on: step 5（同改 `apps/desktop/src/main/ipc.ts`，串行避免冲突）
- Produces: 会话删除跨窗口同步（新推送契约，文档先行）；跨窗口重发同文本不再吞消息；非发起侧本轮结束后轨迹与思考块正常收拢；STT 麦克风门控与 docs/07 口径对齐
- Phase: 集成
- Writes: `apps/desktop/src/renderer/shared/composables/useChat.ts`、`apps/desktop/src/renderer/shared/composables/useChat.test.ts`（新建，仅当抽可测纯逻辑）、`apps/desktop/src/renderer/chat/components/MessageList.vue`、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/channels.ts`、`packages/shared/src/ipc/channels.ts`、`docs/07-ui-spec.md`
- Size: M
- Risk: 通道表是编译期双向断言的两处同构文件——漏改一处 `pnpm typecheck` 即报错（这是护栏不是风险）；P2-20 的收尾信号别破坏既有 streaming 边沿路径（docs/07 §2.3 的折叠语义不回退）；P2-19 的去重修正别破坏临时气泡（无 seq）的正常对账

## 目标

设置页删除会话后 chat 窗口左栏与当前会话正确回落；quick 会话短文本重发不再被吞；跨窗口观看 / 中途切走再切回时，本轮轨迹与思考块在回复结束后收拢；本地 whisper 类无密钥 provider 渲染麦克风按钮。

## 输入

- `bug/P2-一般.md` 的 P2-19、P2-20、P2-21、P2-22（每条含 文件:行、触发条件与修复建议）；证据在 `bug/_raw/U6-renderer-chat-shared.md`
- 源码：`apps/desktop/src/renderer/shared/composables/useChat.ts`（用户消息广播去重约 279-309、done 分支约 370-388、error 分支约 392-399）；`apps/desktop/src/renderer/chat/components/MessageList.vue`（streaming 边沿 watch 约 351-364、462-466、518-520）；`apps/desktop/src/renderer/chat/App.vue`（`sttReady` 约 605-615，含自相矛盾的「唯一口径」注释；Enter 发送约 1002-1005——P3-19 的 isComposing 本次不做）；`apps/desktop/src/main/ipc.ts`（deleteSession 约 622-645 无广播）；通道表 `apps/desktop/src/preload/channels.ts`（chat 组约 95-117）与 `packages/shared/src/ipc/channels.ts`（同构、编译期双向断言）
- 文档口径：AGENTS.md 与 `docs/07-ui-spec.md` §2.3 的 STT 门控 = `stt.enabled` + `stt.active` 指向 baseUrl/model 齐全的 provider（**不含** apiKey 条件）；轨迹折叠 = 「跑完收成一行摘要」
- 现有推送先例：`chat:centerVisibilityChanged`、`settings:changed` 的广播 + 渲染层订阅模式，P2-22 照此办理

## 操作

1. P2-22（文档先行）：`docs/07-ui-spec.md` 写明会话删除的跨窗口契约——新增推送 `chat:sessionDeleted`（载荷含被删 sessionId），chat 窗口收到后重拉会话列表，被删会话是当前会话时按「最近会话，无则新建」回落。
2. P2-22 实现：`packages/shared/src/ipc/channels.ts` 与 `apps/desktop/src/preload/channels.ts` **同时**新增通道（编译期双向断言兜底）；`ipc.ts` 的 deleteSession 在删除成功后向各窗口广播；`useChat.ts` 订阅该推送并处理（重拉列表 + activeId 回落）。
3. P2-19：`useChat.ts` 的用户消息去重键修正——已带 seq 的 `u-evt-` 气泡跳过 content 匹配（只对账临时 id 的本地气泡），跨窗口 30 秒内重发同文本不再吞第二条、不再错改第一条的 seq。
4. P2-20：`useChat.ts` 暴露「本轮收尾」显式信号（如 `lastSettledRequestId`，done 分支置位，含非发起侧到达的事件）；`MessageList.vue` 的折叠收尾改为响应「streaming 边沿 **或** 收尾信号」——两个入口任一触发都执行收拢（进入 `historyFoldedIds`、清 `thinkingOpen`）。
5. P2-21：`App.vue` 的 `sttReady` 去掉 `apiKeySet === true` 条件，注释同步改为 docs/07 §2.3 口径（enabled + active 指向 baseUrl/model 齐全的 provider，未配置连按钮都不渲染）。
6. 若去重判定 / 收尾判定可抽成不依赖 electron 与 DOM 的纯函数，抽到 `useChat.test.ts` 可测的纯模块并加用例（vitest 收录渲染层纯逻辑：不 import electron、不依赖 DOM）；Conventional Commits 中文分组提交（`fix(chat): ...`），提交信息尾注覆盖的条目号（如 `...(P2-19, P2-22)`）。

## 验收标准

- [ ] `pnpm typecheck`（双向断言验证通道同步）且 `pnpm build` 通过；`pnpm vitest run` 全绿
- [ ] `docs/07-ui-spec.md` 有 `chat:sessionDeleted` 契约记载；`App.vue` 的 sttReady 判据与 docs/07 §2.3 一致（注释与实现同时改）
- [ ] 代码核对三项：① 去重路径只对无 seq 的临时气泡做 content 匹配；② 收拢逻辑有两个触发入口（streaming 边沿、收尾信号），非发起侧 done 事件能走到收拢；③ deleteSession 广播在删除成功后发出且载荷带 sessionId
- [ ] 若抽了纯函数：新用例覆盖「带 seq 气泡跳过 content 去重」与「同文本重发不吞」

## 交接

- `chat:sessionDeleted` 的载荷形状写进「执行记录」；`ipc.ts` 在 step-05 已改过（restoreSnapshot），本步只动 deleteSession 分支。
- 跨窗口行为（P2-19/P2-20）的完整端到端验证依赖多窗口场景，单测覆盖纯逻辑、其余靠代码核对；如需运行时证据可跑 AURORA_CAPTURE（重量级，可选）。

## 执行记录

**提交**：`e83f414 fix(chat): 会话删除跨窗口同步、广播去重键修正、流收尾信号与 STT 门控对齐`

**分片与结果**：单分片，1 个实现子代理（general-purpose）在 step-05 提交之上继续改。主代理复跑验收命令。

**`chat:sessionDeleted` 的载荷形状（本文件第 42 行要求留档）**：**`{ sessionId: string }`**（类型 `ChatSessionDeletedEvent`，`packages/shared/src/ipc/types.ts:586-592`），`on` / `off` 成对（`subscribe` 返回退订函数）。语义：删除**成功后**向所有窗口广播被删会话 id；渲染层重拉列表，当前会话被删时按**「最近会话回落，列表空则新建」**处理；推送处理全程 try/catch 只 warn（不抛未捕获错误）。

**实际改动**
- P2-22：两处通道表各加一行 `sessionDeleted: 'chat:sessionDeleted'`（编译期双向断言兜住）；`types.ts` 加 `ChatSessionDeletedEvent` 与 `AuroraApi.chat.onSessionDeleted`；`preload/index.ts` 暴露订阅；`ipc.ts:655-661` 的 `deleteSession` 在 `deps.sessions.remove(sessionId)` 的**成功**回调里 `broadcast(IPC.chat.sessionDeleted, { sessionId })`（守卫拒绝 / 失败分支不发）；`useChat.ts:445` 订阅 → `handleSessionDeleted`（:468）先 `loadSessions()`，被删 != 当前会话则只刷左栏，否则回落最近会话 / 新建；`onScopeDispose` 成对退订。docs/07 先写契约。
- P2-19：抽出纯函数 `matchUserMessageEcho`（`useChat.ts:1124`）—— 末尾往前扫 + 30s 时间窗，**带 seq 的气泡 `continue` 跳过**，只与无 seq 的本地临时气泡对账；命中返回下标附回 seq/createdAt，未命中 push 新 `u-evt-` 气泡。
- P2-20：`useChat.ts` 新增 `lastSettledRequestId`（:121），done（:390）/ error（:408）分支置位，`switchSession`（:927）/ `clear`（:1048）复位；`MessageList.vue` 新增 prop `settledRequestId`（:94）与 `settleRound()`（:401，清 `thinkingOpen` + 停表 + `markPresentAsHistory`），既有 streaming 边沿收尾分支改为调用它（:373），新增收尾信号 watch（:387→390）调同一函数。**既有 streaming 边沿语义不回退。**
- P2-21：`App.vue` 的 `sttReady`（:605-614）去掉 `apiKeySet === true` 与 `SttProviderConfig` 断言/导入，判据改为 `stt.enabled && stt.active` 指向存在且 baseUrl/model 齐全的 provider；自相矛盾的「唯一口径」注释同步改掉；docs/07 §2.3 补一句「门槛不含 API Key」。

**⚠️ 超出白名单的 2 个文件（子代理主动报告，主代理确认必需）**
- `packages/shared/src/ipc/types.ts` —— `AuroraApi` 接口与推送载荷类型都在这里，不新增 `ChatSessionDeletedEvent` + `onSessionDeleted` 就没有可订阅的 API 面。
- `apps/desktop/src/preload/index.ts` —— contextBridge 实际暴露 `window.aurora.chat.onSessionDeleted` 的地方（`channels.ts` 只是常量表）。
两者都是**纯追加**，与其它 step 无重叠。**step-10 的 Writes 清单应补上这两处。**

**⚠️ 路径笔误（step 的 Writes 与实际不符）**：`apps/desktop/src/renderer/chat/components/MessageList.vue` **不存在**；真实路径是 **`apps/desktop/src/renderer/shared/components/MessageList.vue`**（全仓唯一，`chat/App.vue` 就从这里 import）。子代理改的是真实文件。step-10 的 Writes 清单应更正该路径。

**验证（主代理实跑）**
```
pnpm typecheck → 全部 Done（双向断言即验证通道同步）
pnpm build     → 全仓 build 成功
pnpm test      → 115 files / 2028 tests 全绿
子代理另跑：pnpm vitest run apps/desktop/src/renderer → 4 files / 38 tests 绿（含新建 useChat.test.ts 7 条）
```

**代码核对三项**
1. 去重只对**无 seq 的临时气泡**做 content 匹配：`useChat.ts:1136` `if (message.seq !== undefined) continue`（位于 `matchUserMessageEcho` :1124-1145），调用点 `useChat.ts:294`。
2. 收拢有**两个触发入口**：`MessageList.vue:365-374`（streaming 边沿，:373 调 `settleRound()`）与 `MessageList.vue:387-391`（`settledRequestId` watch，:390 调同一函数），唯一实现在 `:401-405`；非发起侧 done 经 `useChat.ts:390` 置位 → `App.vue:1208` 透传 → 收拢。
3. deleteSession 广播在**删除成功后**且带 sessionId：`ipc.ts:658`，位于成功回调内（:655-661）。

**遗留 / 注意**
- **端到端跨窗口行为未运行时验证**（P2-20 场景①②、P2-22 设置页删当前会话）：单测只覆盖纯去重逻辑（`matchUserMessageEcho`），其余按代码核对。运行时证据需跑 `AURORA_CAPTURE`（重量级，未跑）。**代码审查应重点复核这三个场景。**
- `App.vue:477-479` 仍有一处 LLM provider 的 `apiKeySet` 判据（默认模型解析用），属 P2-21 范围外（只针对 STT），未动。
- 渲染层无 Vue 组件测试基建；`useChat.test.ts` 覆盖的是抽出的纯函数。

