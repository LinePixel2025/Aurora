# Step 05 — 集成验证：全量链 + 冒烟 + 逃逸/always/竞态场景核对

- Task: approval-boundary-hardening
- Step: 5 / 6
- Status: done
- Depends on: step 1, step 2, step 3, step 4
- Produces: 全量验证结论（回填 `step/00-index.md` 的「执行记录」与「完成标准」勾选）；如有失败项，产出一笔修复改动
- Phase: 测试与文档
- Writes: 除「修复验证中发现的失败项」外不改生产代码；`step/00-index.md` 与 `step/step-05-integration-verify.md` 的「执行记录」由本步回填
- Risk: 单测全绿但真实 Electron 下语义不同（逃逸封堵依赖 realpath 与 junction 行为，Windows 环境敏感）。退法 = AURORA_SMOKE 端到端兜底 + 逐条场景核对；无法自动化项（按钮实际打开目录）如实列残留

## 目标

四个修复在同一份工作树上互不踩踏，逃逸链在**真实运行体**里被证实封住，且各档 UX 无回归。

## 输入

- 验证口径（AGENTS.md「常用命令」，全部仓库根）：改 shared/agent-core 后先重建对应包；全量链 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify`（与 CI 同序）；冒烟 `$env:AURORA_SMOKE='1'; pnpm dev` → 读 `%TEMP%\aurora-smoke-logs` 的 `AURORA_SMOKE_RESULT`。**冒烟条数不构成校验标准**（step 2 会新增场景条目），核对关键条目 + SUMMARY 零 FAIL。
- 前序交接（先读各 step 文件「执行记录」）：step 1 的 `'machine'` 契约与反证红用例名；step 2 的冒烟 ②/②b/竞态用例改造与 crash 矩阵值断言；step 3 的 `resolveWorkspaceOpenTarget` 纯函数与 AgentPage 门控未动声明；step 4 的 redactSettings 搬移（settings-port 测试 electron 地雷拆除）、notifyChanged 回滚用例、readonlyPrefixes 黑名单、projectRoot 合并。
- 基线对照：改动前 `pnpm test` = 1504 passed、`verify` 26/26、SMOKE 165/165（00-index「现状与关键结论」）。

## 操作

1. 顺序跑并记录每条摘要（时间戳或首尾行）：`pnpm --filter @aurora/shared build`、`pnpm --filter @aurora/agent-core build`、`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm verify`。任何失败：定位到对应 step 修复（不引入新行为），计入本步执行记录；format 失败用 `pnpm format` 修后复查。
2. 冒烟：`$env:AURORA_SMOKE='1'; pnpm dev`（全量输出落盘文件再读，勿用 Select-String 管道缓冲——上一任务踩过：输出全被 `Select-Object -Last` 吞掉无法诊断）。核对：
   - 权限集成组：② `autoInside=... written:true`（**不带** approvedByUser 头衔仍写成功 = 无 UX 回归）；②b 逃逸场景 `rejected:true noCard:true`（建不出 link 时允许 `SKIP:` 注记，但必须在执行记录单列并判断环境原因）；③ 根外弹卡拒写仍绿；
   - crash 矩阵：`agent.loop.maxRounds` / `agent.snapshots.enabled` 两行 `expected=reject effect=ok`（值逐字未变断言生效）；
   - SUMMARY 零 FAIL。若启动即 ERROR（TDZ 类），立即定位修复（上一任务先例）。
3. 逐条对照完成标准做行为核对表（自动化证据优先，落「执行记录」）：
   - 逃逸链封堵 → step 1 反证红用例名 + step 2 冒烟 ②b/竞态条目 + 端口轨 文件:行；
   - 仅当次卡片免校验 → step 1 `agent-host.test.ts`（卡片放行的 true 与 'always' 期望、机器放行的 'machine' 期望矩阵）+ `agentLoop.test.ts` 新增用例；
   - 按钮同目录 → step 3 纯函数三用例 + 「无项目逐字等价」护栏；实际点击无自动化，注明属代码审查+纯函数证据；
   - 加固收口 → step 4 用例（notifyChanged 一次、readonlyPrefixes 拒绝、projectRoot 合并 grep 计数、§1 标题 grep 零命中、redactSettings 搬移：settings-port.test.ts 可收集 + `../ipc.js` import 零命中）。
4. `git log --oneline <基线>..HEAD` 复核提交拆分（一个逻辑单元一条、Conventional Commits 中文）。
5. 把命令摘要、行为核对表、遗留问题回填 `step/00-index.md`「执行记录」，勾选「完成标准」。

## 验收标准

- [ ] 第 1 条命令序列全部零退出码，每条带首尾行摘要可独立复跑。
- [ ] `AURORA_SMOKE_RESULT` 无 FAIL；权限组含「auto 无头衔仍写进 inside」与「指向根外链接被拒（或 SKIP+原因）」两类条目，crash 矩阵两条 reject 带值未变断言。
- [ ] 行为核对表每条至少一条「命令 + 预期输出」级证据指向 step 1–4 的用例名/冒烟条目。
- [ ] `pnpm verify` 输出 `version === CONFIG_VERSION = 15`、迁移断言全过（本轮无新迁移）。
- [ ] `step/00-index.md`「执行记录」已回填、「完成标准」逐条勾销或写明例外。

## 交接

- 全部通过 → 满足归档前置交 step 6；任何未过 → 明确报缺什么，不归档。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）

**执行日期**：2026-09-26（全部连续执行模式，主代理亲自执行；本步零生产代码改动）

**命令链摘要（全部零退出码，仓库根）**：
- `pnpm --filter @aurora/shared build` → `tsc -p tsconfig.json` 完成
- `pnpm --filter @aurora/agent-core build` → 完成
- `pnpm format:check` → All matched files use Prettier code style!
- `pnpm lint` → eslint 完成、零告警
- `pnpm typecheck` → 4 包全 Done
- `pnpm test` → **81 文件 / 1515 passed**（基线 1504：+11 全部为本任务新增用例）
- `pnpm build` → 三包 + Electron 产物 Done
- `pnpm verify` → **26/26 项通过**（`version === CONFIG_VERSION = 15`、迁移断言全过）

**冒烟（AURORA_SMOKE=1，真实 Electron）**：`SUMMARY 166/166 passed`，零 FAIL（基线 165，+1 为新增 ②b 条目）。关键条目：
- ②：`autoInside=approve:true noCard:true written:true noWaiver:true` —— **不带** approvedByUser 头衔真根内写入成功（无 UX 回归）。
- ②b（新增）：「auto 根内经指向根外的链接写入被 realpath 兜底拒绝（机器放行零弹卡）」`machine:true noCard:true blocked:true noWaiver:true` —— junction 真实建出（无 SKIP），判定返 `'machine'` 且零弹卡、写入被拒、根外无文件。
- ③：`autoOutside=card:true blocked:true` —— 根外仍弹卡、未放行拒写。
- crash 矩阵：`agent.loop.maxRounds` / `agent.snapshots.enabled` 两行 `accepted=no expected=reject effect=ok disk=ok 拒绝后配置逐字未变`。
- 日志侧证：三条机器放行日志均带「（边界校验仍生效，不带 allowOutside）」新文案。

**行为核对表（完成标准 → 证据）**：
1. 逃逸链封堵 → step 1 反证红用例 ×3（auto 根内改回 `true` 即红）+ step 2 端口轨 file-port.test.ts:992-1034 + command-runner 竞态用例（反证带 allowOutside 翻红）+ 冒烟 ②b 端到端 PASS。
2. 仅当次用户卡片放行免校验 → step 1 `agent-host.test.ts` 机器路径 `'machine'` ×6 与卡片路径 `true`/`'always'` 期望矩阵 + `agentLoop.test.ts`「'machine' 执行但 ctx 无 approvedByUser」+ `agentHost.test.ts`「首次 always 带 true、二次短路 undefined」。
3. 按钮同目录 → step 3 `workspace-target.test.ts` 4 用例（有项目返项目根 / 无项目逐字等价护栏）；实际点击无自动化（shell.openPath 不可自动断言），按计划以纯函数单测 + 代码审查双轨覆盖。
4. 加固收口 → step 4 settings-port.test.ts 3 用例（notifyChanged 恰一次 / 正常写不重复 / 可选依赖）；schema.test readonlyPrefixes 不可写 + 误伤护栏；grep 计数（deps.projectRoot() 2→1、resolveProject 内联 3→1、settings-port 无 `../ipc.js`）；docs/08 §1 标题 v15。

**提交复核**：`git log --oneline 009fa09..HEAD` 共 4 条（df9a05c / 08d5ad4 / 7e6adfd / 184762d），Conventional Commits 中文、一单元一条；diff 合计 22 文件 +589/−128。

**遗留问题**：无阻塞项。「按钮实际打开哪个目录」无端到端自动化证据，属已声明残留（纯函数 + 审查双轨）。

**提交**：本步无代码改动，无提交。
