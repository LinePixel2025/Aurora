# Step 06 — 稳定性复跑与文档记忆回填

- Task: fix-flaky-chat-probes
- Step: 6 / 7
- Status: done
- Depends on: step 2, step 3, step 4, step 5
- Produces: 连续多轮全量的 `report.json` 证据、`docs/07-ui-spec.md` §5.3 的口径更新、`Memory/` 新增一条记忆、基线数字回填
- Phase: 测试与文档
- Writes: `docs/07-ui-spec.md`、`Memory/`、`AGENTS.md`
- Size: M
- Risk: 用"筛选跑"的结果充当稳定性证据（筛选跑本身会产生假 FAIL，见 `Memory/2026-10-03-capture-probe-gotchas.md` 第 6 条）；把 `chat-model-picker` 的红记成本任务的遗留问题。退法：稳定性判据只认**全量**跑，且判定时显式排除 `chat-model-picker.png`。
- Sources: 本次未联网

## 目标

用连续多轮**全量**跑证明四条抖动已经不再抖（失败项只剩范围之外的 `chat-model-picker.png`），并把这次的口径变化写进文档与项目记忆。

## 输入

- `step/00-index.md`「完成标准」第 1 条（连续 3 轮 dark 全量 + 1 轮 light 全量，失败项只剩 `chat-model-picker.png`）。
- `step/02`–`step/05` 各自「执行记录」里的定向复跑与反向复核结论。
- 本机全量跑法：先 `Remove-Item env:ELECTRON_RUN_AS_NODE`；**每轮换独立目录**（`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-stab-1"` 等 + `$env:AURORA_CAPTURE_THEME='dark'`；light 换主题），再 `pnpm dev`（约 4 分钟 / 93 探针）。同目录会被下一轮覆盖 `report.json`，且日志在 `app.exit` 前不 flush —— **判据只认每轮自己的 `report.json`**。
- 判定注意：`AURORA_CAPTURE_ONLY` 是子串匹配（`capture.ts:12214`），所以 `ONLY=failed` 里出现 `theme-chat.png` 只是"失败项 `chat.png` 连带命中"，不代表它失败过（全量检索证明它从未失败）。
- 文档落点：`docs/07-ui-spec.md` §5.3（截图核对工具的口径、场景清单与已知限制）；`AGENTS.md` 里"窗口截图核对"那一节（探针条数等基线数字）；`Memory/`（一个主题一个 md、文件名带日期、同步 `Memory/README.md` 索引）。
- 既有基线数字的教训：`AGENTS.md` 里长期写给冒烟的 `183` 早已过时（实测 192 → 199），所以**本轮要以实测回填**，不要照抄旧数。

## 操作

1. 连续跑 3 轮 dark 全量，每轮把 `report.json` 复制成带序号的文件（例如 `$env:TEMP\aurora-capture-stab-1|2|3`）并记录：探针总数、失败项清单、`chat-model-picker.png` 的 payload 摘要。
2. 跑 1 轮 light 全量，同样记录。
3. 若任何一轮出现四条之外的失败项：**停下来**，把该轮的 payload 写进「执行记录」并回到对应 step 修复（不要在本步顺手改探针）。
4. 更新 `docs/07-ui-spec.md` §5.3：
   - 若探针口径有变（新增 `act`、身份键、轮询等待、离群容忍统计量），逐条写清"为什么改"与"怎么才算回归"；
   - 把已知的红项写明：`chat-model-picker.png` 是**既存红项**（同码基线可复现），并指向它的独立任务。
5. 用 `memory-create` 的口径写一条记忆（文件名形如 `Memory/2026-10-10-flaky-capture-probes.md`）：四条抖动的根因（模式污染 / 相对时间当身份键 / 一次性等待 / 绝对最大值判据）、各自的判据策略、以及"反向复核要人为制造缺陷而不是等它自己复现"这条方法；同步 `Memory/README.md` 索引。
6. 回填 `AGENTS.md` 的基线数字：截图核对的探针条数以本轮实测为准（本轮改动前 92、改动后 93；若 step 02–05 增删了场景，按实测写）。
7. 如需 PR/提交：按 Conventional Commits、中文描述，一个修复一个 commit（四条各一个），本步的文档与记忆单独一个 `docs(...)` commit。

## 验收标准

- [ ] 3 轮 dark 全量 + 1 轮 light 全量的 `report.json` 均存在（**各自独立目录**），且**每一轮**的失败项清单都**只有** `chat-model-picker.png`（把四轮的探针总数与失败清单贴进「执行记录」）。
- [ ] `docs/07-ui-spec.md` §5.3 能读到：本轮改了哪些判据（若改了）、`chat-model-picker.png` 的既存红项说明与去向。
- [ ] `Memory/` 下新增的记忆文件存在且 `Memory/README.md` 索引已更新（能读到新条目）。
- [ ] `AGENTS.md` 的截图探针数字与本轮实测一致。
- [ ] `pnpm typecheck` 与 `pnpm test` 全绿（本步结束时的最终状态）。

## 交接

- 给 step 07：四轮 `report.json` 的路径、每步的 commit 清单、以及"待确认/遗留"清单（应当只有 `chat-model-picker` 这条范围外项）。

## 执行记录（2026-10-10 执行阶段）

### 1–2 稳定性复跑（验收第 1 条）

命令（每轮独立目录）：`Remove-Item env:ELECTRON_RUN_AS_NODE; $env:AURORA_CAPTURE="$env:TEMP\<dir>"; $env:AURORA_CAPTURE_THEME='dark'|'light'; pnpm --config.verify-deps-before-run=false dev`

**代码冻结后**（四条修复各自成 commit + 一个额外产品修复）的最终四轮：

| 轮次 | 目录 | checks | 失败项 |
| --- | --- | --- | --- |
| dark-1 | `%TEMP%\n-full-dark-1` | 93 | **只有 `chat-model-picker.png`** |
| dark-2 | `%TEMP%\n-full-dark-2` | 93 | **只有 `chat-model-picker.png`** |
| dark-3 | `%TEMP%\n-full-dark-3` | 93 | **只有 `chat-model-picker.png`** |
| light-1 | `%TEMP%\n-full-light-1` | 93 | **只有 `chat-model-picker.png`** |

（每轮 139–143s。**这四轮就是验收第 1 条要的证据**：3 轮 dark 全量 + 1 轮 light 全量，
失败项清单每轮都只剩范围之外的 `chat-model-picker.png`。）

### 2b 过程中发现并修掉的两个额外缺陷（同属"抖动探针"范围）

1. **整轮截图可能挂死**（不是一个探针红，而是**整轮不产出 `report.json`**）：
   `g-full-dark-1` 在 `chat.png` 之后挂死 20 分钟、`report.json` 一张没写。
   根因：`CHAT_AUTO_SCROLL_SCRIPT` / `CHAT_FOLLOW_BURST_SCRIPT` / `CHAT_FOLLOW_WHEEL_UP_SCRIPT`
   都用裸 `requestAnimationFrame` 等两帧，而**窗口被隐藏时 Chromium 不派发 rAF**，
   那个 promise 永不 settle。修法（`fix(capture): 帧等待加有界兜底…`）：
   `Promise.race(帧, 120ms)` + `document.hidden` 时直接走定时器快路径（可见时语义不变）。
   验证：`chat-follow-burst` / `chat-follow-wheel-up` / `chat-trace-wheel` 各 2 轮全绿，
   此后 4 轮全量不再挂死。
2. **`chat.png` 的全量真红**（`k-full-dark-1`：`followed:1613`、`awaitedMs:1000`、`attempts:20`、
   `timedOut:true` —— 有界轮询等满 1s 吸底一次都没跟上，而收尾的 `stick()` 又能恢复）：
   根因是**窗口从隐藏恢复可见后没人重启心跳巡检** —— `onVisibility` 端口只在
   `document.hidden === true` 时跳过，恢复可见时只回调一次 `refresh()`（`refresh()` 只在
   `following` 为真时排一帧对齐，**不重排巡检**），而隐藏期间 rAF 被暂停、定时器被节流，
   巡检可能停在"已排帧但帧永不推进"的状态 → 文件头记录的"MutationObserver 回调会停"
   那条路径失去兜底。修法（`fix(renderer): 窗口恢复可见时重启吸底心跳巡检`）：
   在 `useStickToBottom` 的 `onVisibility` 里额外挂一个 `restartGuard`（重置巡检句柄 +
   重排一帧 + `core.onMutated()`）。
   验证：定向 4 轮全绿 + 其后 4 轮全量全绿。

（另有一批 `v-full-dark-1..3` / `v-full-light-1` 与 `k-full-dark-*` 跑在**编辑进行中**
（electron-vite watch 重建与编辑交错），不作为验收证据；其中出现的 `chat-stream-burst` 一次红
无法排除构建交错干扰，而它在冻结后的 4 轮里全绿。）

### 4 文档回填

- `docs/07-ui-spec.md` §5.3：补齐四处口径变化 ——
  ① `chat-sidebar.png` 的模式一致性哨兵 + `CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT` + "启动期不漏事件"；
  ② `chat-archive.png` 的身份键 = `data-session-id`（`movedTitle` 降为排障读数）；
  ③ `chat.png` 的吸底改有界轮询（新增 `awaitedMs` / `attempts` / `timedOut`）；
  ④ `chat-stream-burst.png` 的"离群容忍 + 灾难闸门"双闸门与新增 payload 字段；
  ⑤ `chat-model-picker.png` 的**既存红项**说明与去向（另开任务，不许改写成永远 PASS）。
- §2.3 行结构说明补 `data-session-id` 锚点。

### 5 记忆

新增 `Memory/2026-10-10-flaky-capture-probes.md`（四条抖动的根因与判据策略），
并已同步 `Memory/README.md` 索引（新条目置顶）。

### 6 AGENTS.md 基线回填

「窗口截图核对」一节补：**全量 93 条 checks**、唯一恒红项 `chat-model-picker.png`、
失败判定三选一口径、`AURORA_CAPTURE_ONLY` 子串匹配、每轮必须独立目录。

### 7 提交清单

| 提交 | 内容 |
| --- | --- |
| `dfccea3` | `docs(step): 生成四条抖动探针修复计划（fix-flaky-chat-probes）` |
| `00eb82c` | `fix(renderer): 启动期改为先订阅再加载，避免永久丢掉 mode:changed`（step 2 产品修复 + `load-gate` 单测） |
| `a68ae90` | `fix(capture): chat-sidebar 场景自带 classroom 前置并加模式一致性哨兵`（step 2 探针侧） |
| `1fd93e7` | `fix(capture): chat.png 吸底跟随改成有界轮询`（step 4） |
| `34ec468` | `fix(capture): chat-stream-burst 判据换成离群容忍 + 灾难闸门`（step 5） |
| `0c1dea8` | `fix(capture): chat-archive 身份键换 data-session-id 并补 act 冷窗前置`（step 3） |
| `fc236a3` | `fix(capture): 帧等待加有界兜底，避免隐藏窗口下整轮截图挂死`（额外修复 1） |
| `c857f81` | `fix(renderer): 窗口恢复可见时重启吸底心跳巡检`（额外修复 2） |
| `dd61a15` | `docs: 记录四条抖动探针的根因与判据策略，并回填截图基线` |
| `a12e8f1` | `docs(step): 回填 Center verify:web 88/88 两端验收记录` |
| 审查后修复（本步末） | 心跳侧删掉使闸门不可达的旧判据、闸门重标定 200/260、自愈改为只记录不自愈、`restartGuard` 先取消在途句柄、`loadGate` 只在生效时写 error、新增 `bootstrap.test.ts` 顺序护栏 |

### 8 独立代码审查（step-runner 第 3 步）与处置

按规模派了 **4 个干净上下文的审查子代理**（正确性+验收 / 安全边界+约定 / 独立复跑核对 / 对抗性复核）。
结论汇总：**有条件可交付**，无 P0；三条验收（全量只剩 `chat-model-picker`、定向+反向复核、typecheck/test）
被独立复跑**证实**，但审查发现下列问题并**已全部处置**：

| 级别 | 问题 | 处置 |
| --- | --- | --- |
| P1 | 心跳侧保留旧主判据 `maxUnhiddenHeartbeatMs <= 160`，使新加的闸门**永远不可达**（`secondMax <= max` 恒成立）→ "离群容忍"在心跳侧等于没做，`v2-s5-2`(198.5)/`v3-s5-1`(234.1)/`v-full-dark-3`(182.1) 三轮单点尖峰仍被判红 | 删除旧判据，与帧侧**同口径**（`secondMax <= 160` + 闸门）；注释里那条错误因果（"198.5 会被 260 判红"）一并改写 |
| P1 | 闸门 260/300 是对着**被仪器缺陷污染的读数**标定的；仪器修好后正常尾巴只有 54.2 / 182.1，放宽无必要证据，且 110–260 的单帧回归成了盲区 | 重标定 `BURST_LAG_GUARDS = { maxFrameGapMs: 200, maxUnhiddenHeartbeatMs: 260 }`（对今日尾巴 3.7× / 1.43×，仍是修复前 661.4 的 39%） |
| P1 | step-05「9 轮全绿」漏掉同期两条红轮，且引用的数字与磁盘不符 | 在 step-05 记录里如实补记（13 轮中 11 绿 2 红，红的都是上述心跳旧判据所致） |
| P2 | 侧栏 check 的"自愈"会**真实切两次模式**（走 `requestGuideIfNeeded`、可能建窗），与 docs 的"本场景不改任何状态"冲突 | 自愈**取消**（只记录 `forcedToggle` / `mainMode` / `panelMode` 并由哨兵判 FAIL）；docs 同步改写 |
| P2 | `docs/07` 写闸门 260（代码/报告是 300）、payload 字段写 `topFrameGaps`（实际 `frameGapsTop5`） | 两处按终版改（闸门数字也随重标定更新为 200/260） |
| P2 | `capture.ts` 注释引用"阻塞主线程 400ms"的反向复核，而 step-04 自己写明那次**证不出东西** | 注释改为引用真正有效的那次（临时关掉 `stickToBottomCore.schedule()` → `followed 1966 / timedOut true`） |
| P2 | `restartGuard` 不取消在途句柄，每次 focus / visibilitychange 会**永久多一条巡检链** | 先 `cancelAnimationFrame` / `clearTimeout` 再重排；并加 `document.hidden` 早退 |
| P2 | 「先订阅再加载」这条产品修复**没有任何测试守着**（改回去 2544 用例仍全绿） | 新增 `apps/desktop/src/renderer/shared/bootstrap.test.ts`（解析 AST 比调用偏移，钉住 `bind` 早于 `load`，覆盖 settings / modes / windows） |
| P3 | 被闸门拦下的那次首读仍会写 `error.value`（"新数据 + 旧报错"） | `loadGate.write` 改为按生效结果决定是否写 error（settings / modes 两处） |
| P3 | `chat-ctx-empty-tools` 的探针 payload **没有 `pass` 字段** → 按任何口径都不可能判失败（先于本次存在的盲点） | **不在本轮范围内**：已如实记入本步「遗留问题」，另开任务（它的 4 轮实测 `result.ok` 均为 true，未掩盖本次失败） |
| P3 | `chat.png` 的判定窗口由 150ms 变 ≤1000ms（1s 内的"慢"不再被判红） | 记入 Memory 的已知取舍；`awaitedMs` / `attempts` / `timedOut` 已落盘，且 `r-s4-defect2-1` 证明真坏掉仍红 |

处置后**重跑**：`r2-s5-1..3`（`secondMaxFrame` 37.5/41.7/41.6、`maxFrame` 37.6/50.1/116.7、
`secondMaxHb` 65.3/70.5/53.7、`maxHb` 107.8/116.2/118.1，3/3 绿）、
`r2-s2-1..3`（3/3 绿，`forcedToggle:false`、`panelMatchesMain:true`）、
**全量 `z2-full-dark-1..3` + `z2-full-light-1`（各 93 checks，失败项只剩 `chat-model-picker.png`）**；
`pnpm typecheck` 全绿、`pnpm test` **171 文件 / 2546 用例全绿**。

### 遗留问题（交 step 07 / 用户）

1. `chat-model-picker.png`：**既存红项**，用户明确划出本轮，另开任务。
2. `chat-ctx-empty-tools.png` 的探针缺 `pass` 字段（先于本次存在，任何失败判定口径都对它失效）—— 另开任务。
3. `chat.png` 的判定窗口变成"1s 内跟上"（原 150ms）—— 已知取舍，已在 Memory 记录。
4. `chat-sidebar` 的产品竞态正向复现仍是低概率（回退实验 0/3）；本轮靠哨兵 + `bootstrap.test.ts` 顺序护栏守。

### 最终状态

- `pnpm typecheck` 全绿；`pnpm test` **171 文件 / 2546 用例全绿**；
  `pnpm vitest run packages/shared/src/browser` 68/68（含吸底状态机既有用例）。
- **两端验收补齐**（本轮改了 `packages/shared/src/browser/composables/useStickToBottom.ts`，
  AGENTS.md 要求"改 shared 渲染层 = 同时改两端"，两端截图都要跑）：
  `pnpm --filter @aurora/center build && pnpm --filter @aurora/center verify:web`
  → **88 场景 / 0 失败**（报告 `%TEMP%\aurora-cweb\report.json`）。

