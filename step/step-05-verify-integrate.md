# Step 05 — 端到端集成验证与文档收口

- Task: agent-prod-mainline
- Step: 5 / 6
- Status: pending
- Depends on: step 1, step 2, step 3, step 4
- Produces: 全量验证结果（typecheck / test / lint / build / smoke / capture）、跨特性端到端综合断言、文档收口（README / roadmap / AGENTS.md）、陈旧文档锚点修正、独立审查结论
- Phase: 测试与文档
- Writes: `apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/capture.ts`、`docs/README.md`、`docs/04-roadmap.md`、`AGENTS.md`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`apps/desktop/src/renderer/chat/components/SubagentPage.vue`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`packages/shared/src/ipc/types.ts`
- Risk: ①本步只做"整合 + 收口"，**不要顺手改功能** —— 发现功能缺陷要回到对应 step 修（或在本步记成遗留问题并说明），否则验收对象就变了；②smoke/capture 的断言容易写成"自证"（只断言自己刚写入的东西）—— 每条断言都必须能回答"如果这个特性坏了，它会失败吗"；③`docs/04-roadmap.md` 的变更记录本轮只有一条（防止四条并行条目改乱），只写一次。
- Sources: 本轮所有外部结论的汇总出处见 `step/00-index.md` 的「现状与关键结论」第 13 条与各 step 的 `Sources` 字段（Codex Windows 沙箱实现、Claude Code 权限模式、Codex 配置参考；访问日期 2026-09-26）。本步不引入新外部事实。

## 目标

在真实 Electron 环境里证明四件事串起来是通的：**选项目 → 设三档权限 → Agent 写文件（留快照）→ 长任务被暂停 → 重启后续跑完 → 一键回滚**。同时把文档与仓库约定更新到与实现一致，并清理本仓库已知的陈旧锚点。

## 输入

- 前四步的产出与各自的 smoke/capture 断言（step 2：权限三档；step 3：快照与回滚；step 4：job 与续跑）。
- 全量验证命令（本轮实测口径）：`pnpm typecheck`（4 个项目）、`pnpm test`（改动前 72 文件 / 1307 用例）、`pnpm lint`、`pnpm build`；端到端 `AURORA_SMOKE=1 pnpm dev`（结果看 `%TEMP%\aurora-smoke-logs` 的 `AURORA_SMOKE_RESULT`）、`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-05"; pnpm dev`（结果看 `report.json`，张数与场景以实测条目为准，**不要按固定张数校验**）。
- 文档收口位置：`docs/README.md`（当前实现状态段落，`v0.1.4` 那一段之后要新增本轮；`docs/README.md:8-14` 是状态行、`:16-31` 是 v0.6.0 段、`~:275-320` 是最近几轮的段落与"仍待做"清单）、`docs/04-roadmap.md`（变更记录追加在文件末尾，当前最后一条在 `:357-395`）、`AGENTS.md`（"尚未生效 / 已知限制"与"几个容易踩的接线点"两节）。
- 陈旧锚点（本仓库已知文档债，多个源文件与文档写 `docs/07 §2.4`，但 `docs/07-ui-spec.md` 在 `:73` §2.3 之后的下一个标题是 `:286` 的「输入框规格」，`:391` 才是 §2.5）：**实测的 5 处**是 `apps/desktop/src/renderer/chat/components/SubagentPage.vue:3`、`apps/desktop/src/main/capture.ts:593`、`apps/desktop/src/renderer/chat/App.vue:88`、`apps/desktop/src/renderer/chat/App.vue:1107`、`packages/shared/src/ipc/types.ts:628`（`useChat.ts` **不含** §2.4，不要把它列进去）。本步把子代理页并入 `§2.3` 的子节编号（或补建 `§2.4`），并同步这 5 处引用。
- smoke/capture 的既有口径：事件类型白名单 `smoke.ts:552`（本轮新增了 job 事件 → 白名单要同步，否则会直接 FAIL）；capture 场景注册顺序约束（`chat-collapse` 必须最后，`capture.ts:4690` 注释）；探针是 template literal，**字符串内部注释不能用反引号**。

## 操作

1. **跑一遍完整门禁并记录原始输出**（不改代码）：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm build`；四条命令的退出码、用例数、耗时都写进「执行记录」。任何一条失败 → 停下，回到对应 step 修，修完从本步开头重跑。
2. **跨特性端到端断言（写进 `apps/desktop/src/main/smoke.ts` 的新 describe）**，依次：
   - ① 建一个临时项目目录并在里面放一份 `AGENTS.md`，把它设为当前项目（`settings:update`）→ 发一轮对话 → 断言桩服务收到的请求体里有该项目 `AGENTS.md` 的内容，且**另一份只放在项目外的 `AGENTS.md` 内容没有出现**。
   - ② 切到 `auto` 档 → 让 Agent 在项目根内写一个文件 → 断言：**没有**弹确认卡片、文件真的落盘、`backups/<sid>/` 下有对应快照。
   - ③ 切到 `readonly` 档 → 发"请写文件"→ 断言事件里**不出现** `write_file` / `run_command`（工具不在清单），且磁盘文件未被改动。
   - ④ `maxRounds=2` + `autoContinueRounds=0` 触发 job `paused` → 「重启」（smoke 的两次启动机制）→ `chat:resumeJob` → 断言 job 终态 `done`、`stepsDone` 数量增加、会话里那条用户消息**只有一条**、`cursor.nextRound` 单调递增。
   - ⑤ 对 ②里写过的文件调 `snapshots:restore` → 断言磁盘内容回到写入前，且新增一条 `origin:'rollback'` 的快照。
   - ⑥ 断言 `smoke.ts:552` 的事件白名单已含本轮新增的事件类型（`job`），且未放宽到"任意类型"。
3. **capture 场景收口**：确认 step 1–4 新增的场景（`chat-project-card` / `chat-permission-readonly` / `chat-snapshot-card` / `chat-job-panel`）都在 `report.json` 里出现且 `ok: true`；新增一张综合图 `chat-agent-prod-overview.png`（右栏同时有"当前项目 + 文件备份 + 任务"三张卡，用于人工核对布局不冲突）；settings 页的 `projects.*` / `agent.permissionMode` / `agent.snapshots.*` / `agent.loop.*` 字段探针全部通过。**不要写死张数**。
   - ⚠️ **`SETTINGS_AGENT_FIELDS_SCRIPT`（`capture.ts:2647-2717`）的 `unexpected` 是白名单式的 `data-empty` 过滤器**：新增配置分组若在默认态渲染出 `data-empty`，而且名字不在白名单里，探针会**直接 FAIL**。本步要核对四个新分组（`projects.*` / `agent.permissionMode` / `agent.snapshots.*` / `agent.loop.*`）实际产生了哪些 `data-empty`，把它们按需加进白名单或让控件常显（字段探针的既有口径是"条件不成立时控件不在 DOM、原位换 `data-empty`"，见 `docs/08:572-573`）。
4. **文档收口**：
   - `docs/06-agent-core.md`：确认 §4.1 / §5 / §5.1 / §11.2 / §11.8 / §12.2 / §17 / §18 各处口径一致（尤其"权限三档与 `confirmSensitiveTools` 的优先级"与"job 续跑不重复落用户消息"必须两处一致：§4.1 与 §5）。
   - `docs/07-ui-spec.md`：补齐新增锚点清单（`chat.permission-mode-readonly`、`chat.snapshot-card`、`chat.jobs`、`chat.project-card`），修正 `§2.4` 陈旧引用（含第 5 步输入里列的 5 处源文件）。
   - `docs/README.md`：新增本轮段落（四项能力 + 配置版本 v15 + 验证结论），并把"仍待做"清单同步（去掉已完成的项，保留 Code Mode / 多模态 / 子代理加强 / 上下文压缩 / OS 沙箱）。
   - `docs/04-roadmap.md`：在末尾追加**一条**变更记录（包含四项能力、配置 v13→v15、验证数字、明确未做的部分）。
   - `AGENTS.md`：更新"尚未生效 / 已知限制"（`workspaceDir 不是沙箱` 那条要改成"三档权限 + 项目根前缀校验已落地，但仍无 OS 级沙箱"）、补"几个容易踩的接线点"里的新坑（快照钩子在 `writeText` 内、`ensureLoaded` 竞态已修、`agent.permissionMode` 是只读前缀、`agent.loop.maxRounds` 以 getter 注入才能热改）。
5. **独立审查（推荐做，不做要说明原因）**：派一个**只读**子代理，只给它「用户原话 + 本计划 + 最终 diff（`git diff <基线>..HEAD`）」，让它对抗性挑毛病：哪些验收是自证、哪条要求没兑现、有没有把"注册后拒绝"当成"不注册"、快照淘汰是否有漏洞、续跑是否会重复副作用、文档与代码是否仍不一致。把结论与处置写进「执行记录」；**审查者不改代码**。
6. **交付清单**：把本轮的 commit 列表（`git log --oneline <基线>..HEAD`）与每条对应的 step 写进「执行记录」，并确认每个 commit 是"一个功能一个 commit"、提交信息是 Conventional Commits 中文。

## 验收标准

- [ ] `pnpm typecheck` 退出码 0，输出显示 4 个项目全 Done。
- [ ] `pnpm test` 退出码 0，且报告的用例数 ≥ 1307 + 本轮新增（新增用例数写进执行记录；**不允许用例数下降**，下降说明有测试被删或没被收集）。
- [ ] `pnpm format:check`、`pnpm lint`、`pnpm build` 退出码 0（**CI 的顺序是 `format:check → lint → typecheck → test → build`**，见 `.github/workflows/ci.yml:51-66`）；`pnpm verify` 退出码 0（它断言 `fresh.version === CONFIG_VERSION` 与 `appliedMigrations.length === CONFIG_VERSION`，本轮把 `CONFIG_VERSION` 从 12 推到 15，必须复跑）。
- [ ] `AURORA_SMOKE=1 pnpm dev` 结束后 `%TEMP%\aurora-smoke-logs` 的 `AURORA_SMOKE_RESULT` 全通过，且六条跨特性断言（①–⑥）都在日志里逐条可见。
- [ ] 两次启动的续跑证据齐备：第一次启动后 `%APPDATA%\Aurora\jobs\<sid>.json` 的 `status === 'paused'`；第二次启动并 `chat:resumeJob` 后同一文件 `status === 'done'` 且 `stepsDone.length` 增加；会话文件里该用户消息出现次数为 1（用 `Select-String -Path <sessions>\<sid>.json -Pattern <文本> -AllMatches` 数出现次数）。
- [ ] `AURORA_CAPTURE="$env:TEMP\aurora-capture-05" pnpm dev` 退出码 0，`report.json` 的 `checks` 全部 `ok: true`（0 FAIL），且含 step 1–4 的四个新场景 + `chat-agent-prod-overview.png`。
- [ ] 回滚证据：对同一文件 `snapshots:restore` 后文件内容与快照一致，且 `backups/<sid>/index.json` 里新增一条 `origin: 'rollback'`（用 `Get-Content` + `Select-String` 复核）。
- [ ] `grep -rn "docs/07 §2.4\|docs/07-ui-spec.md §2.4" --include=*.ts --include=*.vue --include=*.md .` 在 `apps/`、`packages/`、`docs/`、`AGENTS.md` 里**零命中**（陈旧锚点已清）。
- [ ] `docs/README.md` / `docs/04-roadmap.md` / `AGENTS.md` 三处都已更新：`git diff --stat <基线>..HEAD -- docs/README.md docs/04-roadmap.md AGENTS.md` 显示三个文件都有改动。
- [ ] 独立审查结论已写进「执行记录」（若未做，写明原因）。

## 交接

- 归档步骤（step 6）会在全部 Status=done 后把 `step/*.md` 整体移入 `step/archive/<YYYYMMDD-HHMMSS>-agent-prod-mainline/`。
- 第二批（多模态 + Responses API、子代理对齐 Codex、上下文压缩修正）**不在本计划内**：本步结束时若还有余力，只在 `docs/04-roadmap.md` 的"仍待做"里登记，**不要**顺手改代码。

## 执行记录

（执行后填写：全量验证原始输出与数字、六条端到端断言结果、两次启动续跑的观测命令与输出、capture 场景清单、文档改动清单、独立审查结论与处置、commit 列表、遗留问题）
