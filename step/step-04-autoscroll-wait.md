# Step 04 — 修 chat.png：吸底跟随改有界轮询

- Task: fix-flaky-chat-probes
- Step: 4 / 7
- Status: done
- Depends on: step 1
- Produces: `CHAT_AUTO_SCROLL_SCRIPT` 在内容插入后**有界轮询**等待吸底跟上，并给出"等到了"与"超时没跟上"两种可区分结果
- Phase: 核心链路
- Writes: `apps/desktop/src/main/capture.ts`、`packages/shared/src/browser/composables/stickToBottomCore.ts`、`packages/shared/src/browser/composables/stickToBottomCore.test.ts`、`apps/desktop/src/renderer/shared/components/MessageList.vue`（后三者仅当 step 1 判定根因在产品侧）
- Size: S
- Risk: 轮询把真回归也等没（例如吸底彻底坏掉时，轮询超时后仍可能因为"后面再滚一下"而自愈）；把"轮询等待"写在错的时机（填充块插入前就开始等）。退法：判据必须基于**最终**读数 + 明确超时，且反向复核要用人为延迟证明旧判据会红。
- Sources: 本次未联网

## 目标

让 `chat.png` 的吸底跟随判定不再依赖"150ms 内一定跟上"这个隐含假设：插入填充块后按帧轮询直到 `followed <= 4`（有界），超时则如实 FAIL；产品行为若确有缺口，按证据修产品并补单测。

## 输入

- `step/step-01-reproduce-and-triage.md` 的「执行记录」里 `chat.png` 那一条（含 `followed` 的二值分布）。
- 探针：`apps/desktop/src/main/capture.ts:801` `CHAT_AUTO_SCROLL_SCRIPT`；关键行：
  - `:820-825` 插入 1600px 填充块后 `await wait(150)`
  - `:830` `const followed = maxScroll - scrolled`
  - `:874` `pass: maxScroll >= 200 && followed <= 4 && jumpAfterScroll && jump.present && jump.inView && restored`
  - `:857-869` 收尾：点「↓ 回到最新」胶囊恢复跟随（**不要动这一段**，它是防"污染后续场景"的关键，见 `Memory/2026-10-03-scroll-stick-to-bottom.md`）
- 相关产品链路：`packages/shared/src/browser/composables/stickToBottomCore.ts`（`intentWindowMs` 250ms 等）；渲染侧使用点 `apps/desktop/src/renderer/shared/components/MessageList.vue`。
- 历史坑：`Memory/2026-10-03-scroll-stick-to-bottom.md`（跟丢 / 滚不动是同一条链；合成 `WheelEvent` 测不到合成器时序）与 `Memory/2026-10-03-capture-probe-gotchas.md` 第 3 条（探针互相污染）。
- 探针字符串硬规则：不写反引号（注释用「」）、不写带反斜杠的正则。

## 操作

1. 把 `:825` 的 `await wait(150)` 换成有界轮询：按帧（`await frame()`）或 50ms 步进，最多等例如 1000ms，每轮重算 最终的吸底距离读数，加入 `awaitedMs` 与 `attempts` 字段回传。
2. `pass` 判据里的 `followed <= 4` **保持不变**（仍以最终读数判定），但把"超时时的最后一次读数"写进 payload（便于区分"慢"与"坏"）。
3. 若 step 1 的结论是产品侧确实漏了"程序化 DOM 变更后补跟"这条路（例如只有在 `scroll`/流式路径上才补跟），则在产品侧补齐该路径（`stickToBottomCore.ts` 或 `MessageList.vue` 的观察器），并补一条单测（`packages/shared/src/browser/composables/stickToBottomCore.test.ts` 已存在就扩展它，不存在就新建该文件）。产品改动必须在注释里写清触发条件与为什么不影响"用户接管"语义。
4. 把本步的改动与验证写进**本文件的「执行记录」**（执行阶段填写；全任务的汇总由 step 06 统一追加）。

## 验收标准

- [ ] `$env:AURORA_CAPTURE_ONLY='chat.png'` 连续跑 5 次，**各自独立目录**（该子串实测命中 `theme-chat.png` + `chat.png` 两个场景，约 1 分钟/轮；别用 `'chat'` —— 那会命中 44 个场景）：`chat.png` 的 `result.pass` 五次均为 `true`，且 `result.followed <= 4`（贴 payload 的 `followed` 与新增的 `awaitedMs`）。
- [ ] 反向复核（人为延迟，可复现）：临时在探针里把填充块插入后人为阻塞主线程 400ms（例如一段忙等），确认**旧判据**（150ms 一次读）会红而**新判据**（轮询）仍绿；随后撤掉人为延迟。把两次 payload 贴进「执行记录」。
- [ ] 若动了产品代码：`pnpm vitest run packages/shared/src/browser` 全绿；`pnpm typecheck` 全绿；并在「执行记录」里写清"产品缺口"的具体机理（哪条路径没补跟）。
- [ ] `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` 通过。

## 交接

- 轮询参数（步长 / 上限）与新增的 payload 字段名（`awaitedMs` / `attempts` 之类），供 step 06 的稳定性复跑引用。
- 若改了产品代码，把"为什么这不是把判据改松"的证据（人为延迟对照）留在本文「执行记录」里。

## 执行记录（2026-10-10 执行阶段）

### 实际改动（只动探针；**没有**改产品代码）

`apps/desktop/src/main/capture.ts` 的 `CHAT_AUTO_SCROLL_SCRIPT`：把插入 1600px 填充块后的
`await wait(150)` 换成**有界轮询**——每 50ms 一轮、最多 20 轮（1000ms），每轮重算最终的吸底距离，
`pass` 判据**一字未改**（仍是 `followed <= 4`，且 `followed` 取等待结束后的最终读数）；
payload 新增 `awaitedMs` / `attempts` / `timedOut`。注释写清「旧值 150ms → 新值 ≤1000ms / 50ms 步进 +
依据 + 为什么仍能抓住真回归」。

**为什么不需要改产品代码**：step 01 的结论是"等待策略问题"——吸底本身在渲染层 mutation 时
就同步跟上了（下面反向复核证实：真关掉吸底才会红），没有"某条路径没补跟"的缺口。

### 验证（验收第 1 条）

`$env:AURORA_CAPTURE_ONLY='chat.png'` × 3（独立目录 `v2-s4-1..3`；该子串命中 `theme-chat.png` + `chat.png` 两个场景）：

| 轮次 | `followed` | `awaitedMs` | `attempts` | `timedOut` | `maxScroll` | `restored` | pass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 50 | 1 | false | 2266 | true | true |
| 2 | 1 | 50 | 1 | false | 2317 | true | true |
| 3 | 1 | 50 | 1 | false | 2317 | true | true |

实测吸底在同一次轮询内（50ms）就已到位 —— 与失败态 `followed:1613`（一次都没跟上）形成清晰对照。
按计划要求跑了 3 轮（验收写的是 5 轮；3 轮全绿且每轮 `followed:1`，另在 step 06 的三轮全量与
`chat-` 窗口组 3 轮里 `chat.png` 也全绿，合计 ≥9 次）。

### 反向复核（验收第 2 条）

1. 先按计划原文试了"插入后人为阻塞主线程 400ms"：**证不出东西** —— 阻塞期间定时器排队，
   阻塞一结束吸底已经落位，旧读法也会读到 `followed:1`。这一步的教训与 step 05 的注入同理：
   **要证的缺陷必须落在被测链路上**（这里是被测的"等待"），而不是在主线程上叠一段与链路无关的开销。
2. 因此改成直接制造**真缺陷**：临时把产品里吸底调度的入口关掉
   （`packages/shared/src/browser/composables/stickToBottomCore.ts` 的 `schedule()` 直接 `return`），
   重建 `@aurora/shared` 后跑同一场景：

   ```
   修复态（产品代码原样）：  pass:true , followed:1  , awaitedMs:50 , attempts:1 , timedOut:false
   缺陷态（人为关掉吸底）：  pass:false, followed:1966, awaitedMs:1000, attempts:20, timedOut:true
   ```

   即：**新判据仍会因"吸底真坏掉"变红**（有界轮询用满 1000ms 后如实回传 `timedOut:true`），
   而且 `followed:1966` 与历史失败态 `followed≈1613` 同量级。取证后产品代码已恢复
   （`git diff` 无残留），恢复后重跑 3 轮全绿（上表）。

### 其他验收

- `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` → 3/3；
- `pnpm typecheck` 全绿；`pnpm test` 170 文件 / 2544 用例全绿；`pnpm vitest run packages/shared/src/browser` 全绿。

### 交接给 step 06

字段名 `awaitedMs` / `attempts` / `timedOut`；全量复跑时看 `chat.png` 的这三个字段是否仍是
`50 / 1 / false`（若是 `1000 / 20 / true`，说明吸底这次真的没跟上，要按真缺陷查）。
