# 任务：修复自动续轮丢上下文、set_setting 越权可写、缺省工作目录越过项目根三处问题

- 任务标识：agent-context-boundary-fixes
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-26 18:04
- 执行模式：（留空，执行阶段按剩余步数询问）
- 基线提交：8da7f26d64e398b7f191de61b02e191996dddac3
- 归档目录：（完成后填写：`step/archive/<YYYYMMDD-HHMMSS>-agent-context-boundary-fixes`）
- 归档时间：（完成后填写）

## 完成标准

- [x] 自动续轮的第二轮及之后请求**带上本轮提问与上一轮全部工具结果**：`packages/agent-core/src/host/agentHost.test.ts` 新增用例用 `provider.calls` 断言「续轮首请求」（`calls[1]`）的 messages 含用户原文与上一轮工具输出（如 `echo:q`），且用户提问在请求与会话里都只出现一条。
- [x] AI 的 `set_setting` 对 `agent.loop.*` 与 `agent.snapshots.*` 一律拒绝：schema 单测（`canWriteSettingPath` 为 `false` 且带中文原因）+ AURORA_SMOKE 真端口矩阵两行 `expectReject` 双重证明；docs / AGENTS.md / 代码注释中不再有「不进 `WRITABLE_PATH_OVERRIDES` ⇒ AI 改不动」这条**错误因果**——封禁的真实机制统一表述为「已进 `SETTINGS_READONLY_PREFIXES`」。
- [x] 配置了当前项目后，缺省 `cwd` 的 `run_command` 与缺省搜索根的 `grep` / `glob` 落在**项目根**（装配层单测直接断言端口收到的 `cwd` / `root` 值）；无项目时行为与今天逐字一致；`auto` 档「按根内放行」的判定与实际执行目录在「项目根存在」的前提下不再脱节（根不存在的残余风险见「范围之外」）。
- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿（与 CI 同一套顺序；改 shared / agent-core 后先重建对应包）。
  - 附加：AURORA_SMOKE 端到端 **165/165 PASS**（含 `agent.loop.maxRounds` / `agent.snapshots.enabled` 两行真端口 reject、job 生命周期四场景、auto 档根内集成组）。

## 现状与关键结论

本次调研未联网，全部结论来自仓库内代码与文档（关键位置 2026-09-26 实测核对）：

- **问题 1（自动续轮丢上下文）根因**：`packages/agent-core/src/host/agentHost.ts` 中 `storedMessages → compressHistory → history`（约 468–501 行）与 `buildSystemPrompt`（约 503–528 行）在 `for (;;)` attempt 循环**之外**只算一次；轮次用尽走自动续轮时（约 728–756 行 `continue`）用**同一份旧快照**新建 `runAgentLoop`，而 `appendUserMessage=false` 使 `packages/agent-core/src/loop/agentLoop.ts:186-205` **既不重落盘也不 push 用户消息**（其前提是「用户消息已在 history 里」——手动续跑重读会话成立，请求内自动续轮不成立）。于是第二轮请求既无本轮提问也无上一轮工具结果，模型会重复已做过的写 / 命令操作。手动点「继续」（`ipc.ts:949` `resumeJob`）之所以安全，是因为它是一次**新请求**、会话重读。
- **问题 2（set_setting 可写面）根因**：`packages/shared/src/config/schema.ts` 的 `settingsReadonlyReason`（766–780 行）真实语义是「命中 `WRITABLE_PATH_OVERRIDES` → 放行；命中 `SETTINGS_READONLY_PREFIXES` → 拒绝；Schema 登记的已知路径 → **默认可写**」——覆盖表只是黑名单内的显式放行与审计清单，**不是白名单**（650–655 行注释自己写明「本就因不在黑名单而可写的路径」）。而 `agent.loop.*`（585–594 行）与 `agent.snapshots.*`（554–574 行）都不在黑名单，所以 AI 改得动。与之矛盾的表述有三处：schema.ts 551–552 / 582–583 行注释、`AGENTS.md`「agent.loop / agent.snapshots 不在黑名单也不在覆盖表，所以默认 AI 改不动」、`docs/06-agent-core.md` §11.8（约 749–750 行）同款错误句；`docs/06` §12.2（837–890 行）反而写的是正确机制。
- 已核实**无父路径夹带漏洞**：`walk()` 对 `ZodObject` 不给组路径登记 `schemaSpecs`（982–999 行），`lookupSpec('agent')` / `('agent.loop')` 均 undefined → 写组路径会被「未知配置路径」拒绝，黑名单只需按叶子前缀加两条即封死（`settings-port.ts:62-70` 的 `reasonOf` 每请求路径过一遍，写入时再深合并）。
- 加黑名单**不需要**配置迁移 / `CONFIG_VERSION` 推进：`settingsReadonlyReason` 从不读用户配置项 `advanced.readonlyPrefixes`（schema.ts 444–457 行注释明确「删掉默认项也放不开」），老配置照样生效。
- `set_setting` 是 `sensitivity:'confirm'`（`packages/agent-core/src/tools/settings.ts:117`），越权调用会弹卡，但「需确认」不等于「应可写」——放大轮次 / 关写前备份属自我提权，方向是**实现对齐文档**（封进黑名单），不是文档放行。
- **问题 3（缺省 cwd / 搜索根）根因**：三级回落纯函数 `packages/agent-core/src/config/effectiveWorkspace.ts`（项目根 > `agent.tools.workspaceDir` > 主目录）**在生产代码零消费方**（只有自身单测）。装配器 `apps/desktop/src/main/tools/index.ts:153` 只算了 `cfg.workspaceDir.trim() === '' ? homeDir() : ...`，项目根从不参与 → `run_command` 缺省 cwd 与 `grep`/`glob` 缺省根都是主目录。而 `apps/desktop/src/main/tools/command-runner.ts:91-93` 与 `file-port.ts` 六个入口对**显式传入的路径**做项目根 realpath 前缀校验（`resolveWithin`），于是「配了项目 → 缺省根越界」：`auto` 档下 `apps/desktop/src/main/agent-host.ts:365-373` 按「缺省 cwd 回落项目根」的错误假设免确认放行（`terminal.ts:119` 把批准透传成 `allowOutside`，边界校验被跳过，命令真的跑在主目录）；`confirm` 档下同类调用落在拒绝 / 越界报错路径（确切失败形态由 step 3/4 场景清单复核）。判定端既有用例 `apps/desktop/src/main/agent-host.test.ts:480-495` 与本问题执行端断言配对，可作回归护栏。
- 文档自身也有口径分裂：`docs/06` §5.1（约 240 行）写了「effectiveWorkspaceDir：项目根 > workspaceDir > 主目录」，§11.1/§11.5（约 507/520/605/658 行）与 `docs/08`（约 297/597 行）仍写「为空回落用户主目录」。修复 = 把 §5.1 的口径接到代码并统一其余表述。
- 验收基建：`pnpm vitest run <路径>`（只在仓库根调用）；`packages/agent-core/src/host/agentHost.test.ts` 的 job 生命周期 describe（1048 行起）已有「自动续轮：maxRounds=1 + 额度 2 → 跑满 3 轮」用例（1464 行起，可参照其参数）与记录 `provider.calls` 的 `createFakeProvider`（`packages/agent-core/src/testing/fakeProvider.ts:40-51` 每次请求的 messages 拷贝快照）；`apps/desktop/src/main/index.ts` 冒烟里有**真端口** `set_setting` 写入矩阵（约 2577–2640 行，`expectReject` 条目 + `writeSettingThroughTool`），step 1 在此补两行；`apps/desktop/src/main/tools/index.test.ts` 已用假端口测装配；改了 shared / agent-core 必须先 `pnpm --filter @aurora/shared|@aurora/agent-core build` 再跑下游 typecheck（AGENTS.md 坑位）。
- 最近提交习惯：Conventional Commits + 中文描述（如 `2e49525 feat(agent-core): Task/Job 持久化与预算内自动续轮（agent.loop，配置 v15）`）。

## 假设与待确认

- 假设 1：三处都按「**实现对齐既有安全意图**」修——问题 2 把 `agent.loop` / `agent.snapshots` 加进 `SETTINGS_READONLY_PREFIXES`（与 `agent.permissionMode` 同款），而不是把文档改成「AI 可写」；问题 1 修好续轮上下文、`autoContinueRounds` 默认值保持 2（推进性方向，用户报的「改成 0」只是临时规避）；问题 3 按 docs/06 §5.1 既有设计接线 `effectiveWorkspaceDir`。
- 假设 2：不改 `advanced.readonlyPrefixes` 的持久化默认值语义、不推进 `CONFIG_VERSION`、不新增配置迁移。
- 假设 3：`read_file` / `write_file` / `edit_file` 显式传入**相对路径**时的解析基准（今天按主进程 CWD）不在本次范围（见「范围之外」）。
- 待确认：无——执行前若用户想「把自动续轮默认值也改成 0」或对 set_setting 采用白名单制重构，请在 step 1 / step 2 开工前提出。

## 范围之外（明确不做）

- 不做 OS 级沙箱 / 作业对象 / 受限令牌（AGENTS.md 已声明现状，本次不动）。
- 不把 `set_setting` 可写面整体反转为「白名单制」（`WRITABLE_PATH_OVERRIDES` 语义不动，只加两条黑名单）。
- 不改 `agent.loop.autoContinueRounds` 的默认值（保持 2）与取值范围。
- 不动 `read_file`/`write_file`/`edit_file` 相对路径的解析基准；不动 `openPath kind:'workspace'` 的语义（项目根入口是 `kind:'project'`）。
- **不处理「配了项目但项目根目录不存在 / 被删」的残余越界**：`command-runner.ts:119-124` 在 cwd 不存在时回落到 `process.cwd()`、`file-port.ts` 把不存在的根视为不可用而跳过校验——这是 v13 既有语义（AGENTS.md「不是沙箱」那条）。本次只保证「项目根存在」时缺省落根、判定与执行一致；该边界在 step-03 的 Risk 里显式记为已知残留，不静默。
- 不新增 `run_command` 的 OS 权限隔离、不改免确认模式 `allowPatterns` 的匹配语义。

## 步骤

> 同波可并行（写范围互不重叠）：无（三个修复都触碰 docs/06-agent-core.md，按串行依赖排）

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-setting-writable-surface.md | 封堵 set_setting 对 agent.loop / agent.snapshots 的写入并统一文档口径 | done | - | `packages/shared/src/config/schema.ts`、`packages/shared/src/config/schema.test.ts`、`apps/desktop/src/main/tools/settings-port.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`（冒烟矩阵两行）、`docs/06-agent-core.md`（§11.8/§12）、`docs/08-settings-onboarding.md`、`AGENTS.md` |
| 2 | step-02-auto-continue-context.md | 自动续轮每轮重读会话组装历史（修「第二轮丢上下文」） | done | step 1 | `packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`docs/06-agent-core.md`（§4.1）、`AGENTS.md` |
| 3 | step-03-default-workspace-root.md | 缺省 cwd / 搜索根接上三级回落（项目根 > workspaceDir > 主目录） | done | step 2 | `apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/tools/index.test.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/agent-host.ts`（仅注释）、`apps/desktop/src/main/tools/command-runner.ts`（仅注释）、`docs/06-agent-core.md`（§11.1/§11.5）、`docs/08-settings-onboarding.md`、`docs/10-user-guide.md`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`（仅文案）、`AGENTS.md` |
| 4 | step-04-integration-verify.md | 集成验证：全量检查 + 冒烟 + 三问题场景核对 | done | step 1..3 | （只跑验证；除修复失败项外不改生产代码） |
| 5 | step-05-archive.md | 归档清理 | pending | step 1..4 | `step/` |

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

- **执行模式**：全部连续执行（用户 2026-09-26 选定）；基线提交回填为 `8da7f26d64e398b7f191de61b02e191996dddac3`。
- **step 1 完成**：提交 `3d7da16`（fix: 封堵 set_setting 对 agent.loop / agent.snapshots 的越权可写并统一文档口径）。代码分片主代理做、文档分片 1 个子代理并行（写范围不重叠）；`schema.test.ts` 40→41 用例全绿、全仓 1497 用例绿、typecheck/build/verify(26/26)/format/lint 全绿、`CONFIG_VERSION` 保持 15。详见 step-01 执行记录。
- **step 2 完成**：提交 `8284226`（fix(agent-core): 自动续轮每个 attempt 重读会话组装历史，修第二轮丢上下文）。主代理串行（假并行禁区）；agentHost 60 用例绿、反证（stash 生产代码）失败点即 bug 现场、全仓 1498 用例绿、typecheck/format/lint/build 全绿。详见 step-02 执行记录。
- **step 3 完成**：提交 `2eac457`（fix(desktop): 缺省工作目录/搜索根接上三级回落）。代码分片主代理做 + 文档分片子代理 061d5dc3 并行（docs/06/08/10、AgentPage 仅文案、AGENTS.md）；新增 5 个执行端用例、护栏五件套 118 绿、全仓 1503 绿、typecheck/build/format/lint 全绿。执行中有误操作（write 覆盖测试文件）已当场 `git checkout` 恢复并改用 edit 重做，如实记在 step-03。遗留 4 项（openPath 按钮分叉、3 处白名单外注释、§5.1「两件事」句、docs/10 登记入口指引）记录在案交审查。
- **step 4 完成**：全量链（shared/agent-core 重建 → format → lint → typecheck → test 1503 → build → verify 26/26）✅；**首轮冒烟抓到并修复一个真回归**：step 3 接线令 `projectRoot()` 在启动序首次执行，撞上其后才声明的 `projectLogger`（TDZ）→ 应用启动失败，单测不可见、冒烟可见；修复提交 `f86f360`（声明上移 + 承重注释），复跑冒烟 **165/165 PASS**（含 step 1 两行真端口 reject 与 job 四场景）。三句报障 ↔ 用例名/冒烟条目对照表、提交拆分复核、v0.1.5 披露收口均见 step-04 执行记录。完成标准四项已勾销。
