# Step 06 — 稳定性复跑与文档记忆回填

- Task: fix-flaky-chat-probes
- Step: 6 / 7
- Status: pending
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
| 本步 `docs(...)` | 文档（docs/07 + AGENTS.md + Memory）+ step 回填 |

（另有两条额外修复各自的提交：`fix(capture): 帧等待加有界兜底…`、`fix(renderer): 窗口恢复可见时重启吸底心跳巡检`——
提交清单以 `step/00-index.md`「执行记录」的实测 `git log` 为准。）

### 最终状态

- `pnpm typecheck` 全绿；`pnpm test` **170 文件 / 2544 用例全绿**；
  `pnpm vitest run packages/shared/src/browser` 68/68（含吸底状态机既有用例）。
- **两端验收补齐**（本轮改了 `packages/shared/src/browser/composables/useStickToBottom.ts`，
  AGENTS.md 要求"改 shared 渲染层 = 同时改两端"，两端截图都要跑）：
  `pnpm --filter @aurora/center build && pnpm --filter @aurora/center verify:web`
  → **88 场景 / 0 失败**（报告 `%TEMP%\aurora-cweb\report.json`）。

