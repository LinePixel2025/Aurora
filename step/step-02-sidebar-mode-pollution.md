# Step 02 — 修 chat-sidebar：渲染层启动期丢广播 + 场景自带前置

- Task: fix-flaky-chat-probes
- Step: 2 / 7
- Status: done
- Depends on: step 1
- Produces: 修掉"渲染层启动期丢 `mode:changed` → 面板永久停在旧模式"的产品竞态（含护栏）+ `chat-sidebar.png` 自带可用的前置与"面板必须与主进程一致"的哨兵判据
- Phase: 核心链路
- Writes: `apps/desktop/src/main/capture.ts`、`apps/desktop/src/renderer/shared/bootstrap.ts`、`apps/desktop/src/renderer/shared/stores.ts`（bind/load 语义需要动它时）、`apps/desktop/src/renderer/shared/*.test.ts`（补护栏时）、`docs/07-ui-spec.md`（把"启动期不漏事件"记进右栏口径时）
- Size: M
- Risk: 只把探针"等久一点 / 强制切一次模式"就收工 —— 那会让面板看起来对，而真实用户在"切模式时窗口正好在启动"的现场仍会看到陈旧右栏，属于"绿着没测"。退法：本步必须同时有①产品侧的顺序修复与②探针侧"不许自愈"的哨兵，两者缺一即视为未完成。
- Sources: 本次未联网

## 目标

让"主进程模式已切换、聊天窗右栏却仍显示旧模式"这件事**不再可能发生**（产品修复 + 回归护栏），并让 `chat-sidebar.png` 的判定显式暴露这种不一致，而不是靠时间赌。

## 输入

- `step/step-01-reproduce-and-triage.md` 的「执行记录」里 `chat-sidebar` 那一条（含 3 次组合跑与确定性构造的结果）。
- 竞态位置：`apps/desktop/src/renderer/shared/bootstrap.ts:31-35`
  —— `await Promise.all([settings.load(), modes.load()])` **之后**才 `bind()`；这之间到达的 `mode:changed` 无人接收，且**没有补偿读取**（load 拿到的是切换前的快照）。
- 广播来源（唯一）：`apps/desktop/src/main/ipc.ts:1295-1297`（`deps.modes.onChange` → `broadcast(IPC.mode.changed, event)`，发给**所有**窗口）。
- 同值 no-op：`packages/modes/src/manager.ts:136-143`（`previousId === id` 时提前 return、**不 emit**）；`ipc.ts:542-547` 的 `mode.set` handler 也不额外广播。
  推论：`window.aurora.mode.set('classroom')` 在"主进程已是 classroom、渲染层却是 work"的现场**什么都不做**，拿它当前置必然失败。
- 触发路径（为什么会"窗口在 work 期间启动"）：`edge-bar-work`（`capture.ts:729`）切 work → `packages/modes/src/manager.ts:230-232` 因未完成引导触发 `requestGuideIfNeeded` → 主进程 proactive 调 `windows?.showChat()` → `window-manager.ts` 的 `show()` 会 `ensure()` **建窗** → 新窗口跑 `bootstrapApp`，正好落在上面那段窗口期。
- 受害者：`capture.ts:4301` `CHAT_SIDEBAR_SCRIPT`（同步 IIFE，判据 `:4354-4378`，`:4368` 要求卡片含「今日课程」）；场景定义在 `capture.ts:11351`（当前无 `act`）。
- `ContextPanel.vue:203` 的 classroom 分支里 `:242` 的「今日课程」卡**恒渲染**（零课程也渲染，只是文案变），「工作目录」只在 `:270-273` 的 work 分支 → 卡片集合能唯一区分模式。
- 探针字符串硬规则：不写反引号（注释用「」）、不写带反斜杠的正则（`capture.probe-strings.test.ts` 三条护栏）。

## 操作

1. **产品修复（核心）**：把 `renderer/shared/bootstrap.ts` 的接线顺序改成"**先订阅、再加载**"：先拿到 `settings.bind()` / `modes.bind()` 等 disposer（订阅即刻生效），再 `await` 各 `load()`。要点：
   - 订阅先于 load 时，广播可能在 load 完成前到达 → 必须保证 load 的**结果不会覆盖**已经收到的更晚状态。两种可行做法：① 先 bind 再 load（load 以"当前主进程状态"为准刷新，天然收敛）；② load 完成后补一次轻量再同步，把窗口期丢的事件补回来。选哪一种由执行者按 `stores.ts` 里 `bind()` 的实现决定，并在注释里写清为什么能覆盖窗口期。
   - 同一条规则适用于 `settings` / `window` / `perception` 的订阅（顺序一致，别只改 modes）。
2. **补护栏**：为"订阅先于加载"写一条能独立跑的测试（放在 `apps/desktop/src/renderer/shared/` 下、与实现同目录；建议把顺序收敛成一个可注入依赖的小 helper 再测：订阅 → 期间派发事件 → 加载完成 → 断言最终状态等于事件里的较新值）。若确实无法在 node 环境单测（依赖真实 pinia/IPC），写一条**纯逻辑** helper 测试 + 在「执行记录」说明剩余部分由 capture 哨兵覆盖。
3. **探针前置（自愈，只为截图好看）**：给 `chat-sidebar.png` 场景加 `act`：
   - 读 `window.aurora.mode.list()` 得到主进程当前模式，读 `.ctx-card .ctx-head strong` 得到面板卡片；
   - 若两者**不一致**：做一次**真实的状态变化**（`mode.set('work')` → 轮询到 work 卡片 → `mode.set('classroom')` → 轮询到「今日课程」卡），并把 `forcedToggle = true`、`attempts`、`waitedMs` 放进 `window.__auroraSidebarProbe`；
   - 一致则 `forcedToggle = false` 直接返回。
   - 注意：`classroom → work` 与 `work → classroom` 都是真实变化（会 emit）✓；**不要用同值 set**。
4. **探针哨兵（回归护栏）**：`CHAT_SIDEBAR_SCRIPT` 增加两条断言：
   - `window.__auroraSidebarProbe.forcedToggle === false`（**面板本来就该是对的**；自愈一旦被触发就说明产品竞态又回来了 → FAIL，附带 `attempts/waitedMs` 便于排障）；
   - 面板卡片集合与 `mode.list()` 报的模式一致（两者都放进 payload，失败时能直接看出谁对谁错）。
   其余 classroom 判据保持不变。
5. 把本步的改动与验证写进**本文件的「执行记录」**（执行阶段填写；全任务的汇总由 step 06 统一追加）。

## 验收标准

- [ ] `$env:AURORA_CAPTURE_ONLY='edge-bar-work,chat-sidebar'` **连续 3 次**（各自独立目录）：`chat-sidebar.png` 的 `result.pass` 三次均为 `true`，且 payload 里 `forcedToggle === false`、面板模式与 `mainMode` 一致（贴三次 payload）。
- [ ] **反向复核（确定性）**：临时回退第 1 步的产品修复（只回退 `renderer/shared/bootstrap.ts` 那一处），再跑同一组合：应看到 `forcedToggle === true`（自愈被触发）且因哨兵判据 `pass === false`；测完恢复修复并重跑一次确认转绿。把两次 payload 与命令写进「执行记录」。
- [ ] 若第 1 步选的是"load 后再补一次同步"，额外贴出"窗口期事件不丢"的证据（构造：bind 前派发 → 断言最终值）。
- [ ] `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` 通过；新增/修改的 renderer 测试 `pnpm vitest run apps/desktop/src/renderer` 通过；`pnpm typecheck` 通过。
- [ ] `docs/07-ui-spec.md` 若描述了右栏模式切换口径，把"启动期不漏事件"写进去（不改则说明为什么不需要）。

## 交接

- 产品修复的具体做法（先 bind 再 load / load 后补同步）与新增测试文件路径。
- `window.__auroraSidebarProbe` 的字段名（`forcedToggle` / `attempts` / `waitedMs` / `modeCards` / `mainMode`），供 step 06 的稳定性复跑引用。
- 给 step 03 的提醒：同样存在"`act` 返回值被丢弃（`capture.ts:265-268`）"这个坑 —— 探针要自己把前置状态经全局变量传给 `check`。

## 执行记录（2026-10-10 执行阶段）

### 实际改动

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/renderer/shared/bootstrap.ts` | 接线顺序改成**先订阅、再加载**（旧：`await Promise.all([settings.load(), modes.load()])` 之后才 `bind()`）。注释写清窗口期丢广播的机理与"为什么必须这个顺序"。 |
| `apps/desktop/src/renderer/shared/stores.ts` | `useSettingsStore` / `useModeStore` 各加一个 `loadGate`：`bind()` 回调里 `onPush()`，`load()` 在**发起读取前** `snapshot()`、拿到结果后 `write(mark, …)` —— 首读期间收到过推送就**放弃这次写值**（晚到的旧快照不许盖掉新广播）。 |
| `apps/desktop/src/renderer/shared/load-gate.ts`（新增） | 上面那条判定的纯逻辑（`snapshot` / `write` / `onPush`），node 环境可单测。 |
| `apps/desktop/src/renderer/shared/load-gate.test.ts`（新增，4 例） | 钉住两个方向：① 首读期间无推送 → 写值；② 推送先到、应答后到 → 不写值。 |
| `apps/desktop/src/main/capture.ts` | 新增 `CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT`（有界轮询等「今日课程」真的渲染出来，最多 20×150ms）并绑到 `chat-sidebar.png`；`EDGE_BAR_WORK_CHECK` 的还原确认由 `await wait(120)` 改成**轮询 `mode.list()` 直到 classroom 生效**（回传 `restoreConfirmed` / `restoreWaitedMs`）；`CHAT_SIDEBAR_SCRIPT` 改 async，加**哨兵**：面板卡片推出的模式 === `mode.list()` 报的模式、`forcedToggle === false`，不一致时先在 check 里做一次真实状态变化自愈（只为截图），但哨兵照旧 FAIL。 |
| `docs/07-ui-spec.md` | §2.3 与 §5.3 补"启动期不漏事件"、哨兵字段与 `CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT` 的口径。 |

### 验证

1. **定向复跑（验收第 1 条）**：`$env:AURORA_CAPTURE_ONLY='edge-bar-work,chat-sidebar'` × 3，独立目录 `v2-s2-1..3`，
   三轮全 `pass:true`（exit=0，checks=2）：

   | 轮次 | `contextCards` | `mainMode` / `panelMode` | `panelMatchesMain` | `forcedToggle` | `restoreWaitedMs` |
   | --- | --- | --- | --- | --- | --- |
   | 1 | `["任务清单","今日课程","系统状态"]` | classroom / classroom | true | false | 164 |
   | 2 | 同上 | classroom / classroom | true | false | 165 |
   | 3 | 同上 | classroom / classroom | true | false | 158 |

2. **反向复核（确定性，验收第 2 条）**：三种构造都做了，结论取最有力的那条：
   - (a) 只临时回退 `bootstrap.ts`（保留哨兵与自愈）跑 3 次 → **未复现**（`forcedToggle:false` 三次）。
     原因如实记录：这条竞态要求 chat 窗口恰好在"切换已发生、广播已发出"之后才跑 `bootstrapApp`，
     而本轮 chat 窗口在 `chat-sidebar` 之前先被 `manager.ensure('chat')` 建起来，`modes.load()` 拿到的
     已是切换后的新值 —— 复现率低（历史 1/8）。
   - (b) **确定性注入**：在 chat 渲染层临时加 `window.__auroraForceStaleMode(id)`，把 store 置成
     "work（= 那条广播丢了的残留态）"而主进程仍是 classroom，再跑同一组合：
     payload `{"mainMode":"classroom","panelMode":"classroom","forcedToggle":true,"probeAttempts":0,
     "probeWaitedMs":15,"pass":false}` —— **自愈被触发（forcedToggle=true）且哨兵判 FAIL（exit=2）**，
     正是验收标准要求的两次 payload 之一。取证后产品修复已恢复、注入钩子已删除
     （`git diff` 无 `TEMP-REVERSE` 残留）。
   - (c) 机理取证（step 01 记录）：chat 窗口在 work 收尾后 +60ms 右栏一张 `.ctx-card` 都没有，
     +1060ms 才刚挂上 work 卡 —— 说明"等固定毫秒"从来不是一个有保证的策略。

3. 恢复修复后重跑（第 1 条那 3 轮 + `v2-s3` 轮内的 `chat-sidebar`）共 **4 次全绿**。
4. `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` → 3/3；
   `pnpm vitest run apps/desktop/src/renderer` → 全绿（含新增 `load-gate.test.ts` 4 例）；
   `pnpm typecheck` → 全绿；`pnpm test` → **170 文件 / 2544 用例全绿**。

### 遗留 / 说明

- 触发窗口的**真实**复现仍是低概率事件；但本次修的是"为什么会永久卡住"（丢广播 + 同值 no-op），
  哨兵把"面板与主进程不一致"这件事变成了**显式失败**，而不是靠概率撞。
- `EDGE_BAR_WORK_CHECK` 的 `restoreWaitedMs` 实测 151–172ms —— 比旧的固定 120ms 长，
  正是"旧缓冲不保证"的直接读数；它现在只代表"本窗口还原动作已生效"，不承担下游窗口的保证。

