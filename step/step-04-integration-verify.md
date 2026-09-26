# Step 04 — 集成验证：全量检查 + 冒烟 + 三问题场景核对

- Task: agent-context-boundary-fixes
- Step: 4 / 5
- Status: done
- Depends on: step 1, step 2, step 3
- Produces: 全量验证结论（回填 `step/00-index.md` 的「执行记录」）；如有失败项，产出一笔修复改动
- Phase: 测试与文档
- Writes: 除「修复验证中发现的失败项」外不改生产代码；`step/00-index.md` 与 `step/step-04-integration-verify.md` 的「执行记录」由本步回填
- Risk: 本地全绿但真实 Electron 下行为不同（三档权限与默认目录最终由主进程装配决定）；退法 = AURORA_SMOKE 端到端兜底 + 手动场景复核

## 目标

三个修复在**同一份工作树**上互不踩踏：配置层、内核层、装配层、渲染契约全部一致，且用户报障的三句现象在真实行为层面逐条消失。

## 输入

- 本仓库验证口径（AGENTS.md「常用命令」，全部在仓库根执行）：
  - 改了 `packages/shared` 或 `packages/agent-core` 的 `src/` 后必须先重建对应包再看下游类型：`pnpm --filter @aurora/shared build` / `pnpm --filter @aurora/agent-core build`；
  - 全量四连：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`（`pnpm verify` 依赖先 `pnpm build`，断言真实磁盘配置层与 `CONFIG_VERSION = 15` 一致——本轮刻意不推版本号）；
  - CI 顺序：`format:check → lint → typecheck → test → build`（根 package.json 确有 `format:check` = `prettier --check .`，26 行；AGENTS.md 声明 CI 按需触发，本地这套即等价全量）；
  - 端到端冒烟：PowerShell 下 `$env:AURORA_SMOKE='1'; pnpm dev`，结束后读 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`（userData 自动隔离，无需手动清）。
- 三个修复的关键落点（复核 grep 用）：`packages/shared/src/config/schema.ts`（`SETTINGS_READONLY_PREFIXES` 含 `agent.loop` / `agent.snapshots`）、`packages/agent-core/src/host/agentHost.ts`（history/systemPrompt 在 `for (;;)` 内重算）、`apps/desktop/src/main/tools/index.ts`（`effectiveWorkspaceDir` 消费方 + `projectRoot` dep）。
- 前序步骤交接：step 2 的「修复前反证」结果（含失败断言名）、step 3 的三级回落用例清单与 grep 命中处理表、step 1 的「两条黑名单前缀 + 冒烟矩阵两行 expectReject / CONFIG_VERSION 不动」结论——都应已写在各自 step 文件的「执行记录」里。

## 操作

1. 依次跑并记录输出摘要（与 CI 同一顺序，`format:check` 确认存在于根 package.json:26）：`pnpm --filter @aurora/shared build`、`pnpm --filter @aurora/agent-core build`、`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm verify`。任何失败：定位到对应 step 的改动修复（不引入新行为），修复计入本步并写进执行记录；`format:check` 失败用 `pnpm format` 修后复查。
2. 冒烟：`$env:AURORA_SMOKE='1'; pnpm dev` 跑完取 `AURORA_SMOKE_RESULT`；确认 job 生命周期场景（既有 ①轮次用尽 ②续跑单条用户消息 ③预算触顶 ④取消）仍 PASS，且 set_setting 矩阵包含 step 1 新增的两行 `agent.loop.maxRounds` / `agent.snapshots.enabled` 且按 `expectReject` 通过（真端口端到端证据）。
3. 逐条对照用户报障现象做行为核对（能自动化则自动化，不能则结合冒烟日志 + `apps/desktop/src/main/agent-host.test.ts` / `tools/index.test.ts` / `schema.test.ts` 的断言清单在「执行记录」里写出证据链）：
   - 「自动续轮第二轮没有本轮提问、也没有上一轮工具结果」→ step 2 的 `provider.calls` 用例（含反证记录）；
   - 「agent.loop.* 与 agent.snapshots.* AI 改得动」→ step 1 的 `canWriteSettingPath` 用例 + 冒烟矩阵两行 reject；
   - 「缺省 cwd / 搜索根在完全权限档跑主目录、confirm 档失败、grep/glob 越界报错」→ step 3 的三级回落用例（执行端）+ `agent-host.test.ts:480-495`（判定端）+ 上文场景清单。
4. 用 `git log --oneline` 复核提交拆分是否符合「一个功能/修复一个 commit」与 Conventional Commits 中文描述；缺漏在本步补齐说明。
5. 披露收口：用户报障三句原文即 `docs/release-notes/v0.1.5.md` 约 71–85 行「已知限制」1–3；在「执行记录」写明本轮修复对应这三条披露（**不改写 v0.1.5 历史发布说明**；下一版发布说明在打包时标注修复，属 docs/09 发布流程，不在本次范围）。
6. 把三类结果（命令输出摘要、行为核对表、遗留问题）回填到 `step/00-index.md` 的「执行记录」。

## 验收标准

- [ ] 第 1 条命令序列全部零退出码（贴执行记录时每条带时间戳或首尾行摘要，可独立复跑）。
- [ ] `AURORA_SMOKE_RESULT` 为 PASS（含既有 job 场景①–④，且 set_setting 矩阵内 `agent.loop.maxRounds` / `agent.snapshots.enabled` 两条新条目按 reject 通过）。
- [ ] 对照表三条报障现象各有至少一条「命令 + 预期输出」级别的证据指向 step 1–3 的用例名。
- [ ] `pnpm verify` 输出中配置 `version` 仍等于 `CONFIG_VERSION = 15`、`v0 → 当前版本` 迁移断言通过（本轮无新迁移）。
- [ ] `step/00-index.md` 的「执行记录」已回填且「完成标准」四项逐条勾销或写明例外。

## 交接

- 全部通过 → 满足归档前置，交给 step 5；任何一步未过 → 明确报缺什么，不归档。

## 执行记录

**本步性质**：只跑验证 + 修复验证中发现的失败项（一笔生产修复 `f86f360`，见第 2 条），无其他代码改动。无子代理（重命令必须串行，避免争抢 build/dev 产物）。

**1. 命令序列（与 CI 同序，仓库根，2026-09-26 19:09–19:29 本地时间）**

| 命令 | 结果 |
|---|---|
| `pnpm --filter @aurora/shared build` | ✅（tsc Done） |
| `pnpm --filter @aurora/agent-core build` | ✅ |
| `pnpm format:check` | ✅ All matched files use Prettier code style |
| `pnpm lint` | ✅（exit 0，改后复跑一次） |
| `pnpm typecheck` | ✅ 4 包 Done |
| `pnpm test` | ✅ **1503 passed（80 文件）** |
| `pnpm build` | ✅ out/ 产物齐 |
| `pnpm verify` | ✅ **26/26 项通过**，`version === CONFIG_VERSION = 15`、v0→v15 迁移断言过（本轮无新迁移） |

**2. 失败项与修复**：首轮 `$env:AURORA_SMOKE='1'; pnpm dev` 于 19:11:40 **启动失败**——`ERROR 启动失败 {"error":"Cannot access 'projectLogger' before initialization"}`。根因：step 3 把 `projectRoot()` 接进 `registerComputerTools` 后，启动序的 `syncToolRegistries()`（index.ts:782）第一次**提前**执行了这个 getter，而它闭包里的 `projectLogger` 声明在 825/830 行 → TDZ。单测全用假装配器覆盖不到真实装配顺序，只有冒烟抓得到（这正是 step 4 存在的意义）。修复 = `const projectLogger` 上移到 `projectRoot` 声明之前，并留承重注释；提交 `f86f360`。修复后冒烟全绿。

**3. 冒烟（AURORA_SMOKE，修复后重跑，11:23:49Z 起那轮）**：`AURORA_SMOKE_RESULT: SUMMARY **165/165 passed**`，进程 exit 0。关键条目：

- 既有 job 生命周期四场景全 PASS：`Job：轮次用尽落 paused 且 pendingReason='max-rounds'` / `Job 续跑：…用户消息只有一条（不重复落盘）` / `Job：预算触顶落 paused …'budget'` / `Job：取消后状态是 aborted（不是 paused）`。
- step 1 的矩阵两行**真端口端到端兑现**：`PASS 配置写入不会写坏（agent.loop.maxRounds） — accepted=no expected=reject …`、`PASS 配置写入不会写坏（agent.snapshots.enabled） — accepted=no expected=reject …不能修改 agent.snapshots.enabled：「agent.snapshots」属于不可修改的配置`。
- 权限集成场景不回归：`集成②：auto 档根内写文件 —— 不弹确认卡、内容真的落盘、并留下快照` PASS（step 3 接线后 `auto` 档判定与执行仍一致）。

**4. 三句报障 → 证据对照表**

| 报障（= v0.1.5 发布说明「已知问题」1–3） | 证据链 |
|---|---|
| ①「自动续轮第二轮没有本轮提问、也没有上一轮工具结果」 | `agentHost.test.ts`「自动续轮的请求带本轮提问与上一轮工具结果（每 attempt 重读会话组装历史）」（calls[1] 含 问题X+echo:q、calls[2] 含 echo:r、每次请求 user 恰 1 条、落盘 1 条）+ **修复前反证**（stash 生产代码后该用例以 `expected '…' to contain '问题X'` 失败，step-02 有贴文）+ 冒烟 job 四场景 PASS |
| ②「agent.loop.* 与 agent.snapshots.* AI 改得动」 | `schema.test.ts`「agent.loop / agent.snapshots 进黑名单」（9 条路径 false + 中文原因）+ 冒烟矩阵两行 `expected=reject` PASS（上表）+ `settings-hint.ts`/文档口径统一（step-01 grep 记录） |
| ③「缺省 cwd/搜索根：auto 档跑主目录、confirm 档失败、grep/glob 越界」 | 执行端 `tools/index.test.ts`「缺省工作目录三级回落」5 用例（端口实收 `cwd/root === 'C:\proj-root'`；无项目两条逐字不变护栏）+ 判定端 `agent-host.test.ts:480–495`（配对）+ 冒烟集成② PASS（auto 档根内免卡且真落盘）。场景清单①–④ 中「有项目 + run_command 无 cwd」的桌面手动复核以冒烟 `auto=true` 集成组与单测组合替代；「手动继续仍安全」= 冒烟 job 场景② PASS + step 2 未触碰 `ipc.ts`。 |

**5. 提交拆分复核**（`git log --oneline 8da7f26..HEAD`）：`3d7da16 fix:`（报障②，代码+文档一单元）/ `8284226 fix(agent-core):`（报障①）/ `2eac457 fix(desktop):`（报障③）/ `f86f360 fix(main):`（本步失败项修复，单独一条可回滚）。四条各讲清一件完整的事、Conventional Commits 中文描述，与仓库习惯一致。step 文件回填另计 `docs(step)`。

**6. 披露收口**：本轮三修复逐一对应 `docs/release-notes/v0.1.5.md` 约 71–85 行「已知问题」1–3（已核对原文措辞）。**未改写 v0.1.5 历史发布说明**；下一版发布说明在打包时标注修复，属 docs/09 流程、不在本次范围。

**7. 遗留问题（不阻塞，交审查/收尾）**：①「打开工作目录」按钮（`ipc.ts` `openPath kind:'workspace'`）仍两级解析，配项目时与命令实际落地目录分叉——「范围之外」明令不动，需产品决策；②白名单外 3 处代码注释旧口径（`schema.ts:484`、`search.ts:38`、`index.test.ts:214` 用例名【无项目语境下不算错】）；③docs/06 §5.1「决定两件事」句未升「三件事」（新 bullet 已兜住，两处镜像保持一致）；④docs/10 提「当前项目」未指登记入口（P3）。
