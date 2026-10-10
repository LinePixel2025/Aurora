# Step 04 — 修 chat.png：吸底跟随改有界轮询

- Task: fix-flaky-chat-probes
- Step: 4 / 7
- Status: pending
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
