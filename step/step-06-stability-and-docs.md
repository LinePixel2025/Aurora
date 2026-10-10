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
