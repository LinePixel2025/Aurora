# 任务：Aurora Agent 可生产化主线（项目机制 + 三档权限 + 写前快照 + Task/Job 持久化续跑）

- 任务标识：agent-prod-mainline
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-26 10:52
- 执行模式：全部
- 基线提交：afd23827dee06381e72ca1d21d6371dc1d865dcc（用户要求执行阶段重新取 `git rev-parse HEAD`）
- 归档目录：（完成后填写）
- 归档时间：（完成后填写）

## 完成标准

- [ ] **项目机制可用**：配置里有 `projects.*`（当前项目 + 项目列表 + 每个项目的根目录），Agent 每轮把「项目根 → 当前工作目录」逐层的 `AGENTS.md`（含 `AGENTS.override.md` 优先规则）按顺序注入系统提示词，且**注入位置在静态前缀之后**、不破坏 prompt caching 的前缀稳定性断言。
- [ ] **三档权限生效且可验证**：`agent.permissionMode ∈ {readonly, confirm, auto}`；`readonly` 档下**写 / 执行 / 有系统副作用的工具根本不注册**（含 `todo_write` —— 它会往 `userData/todos/` 落盘），模型在工具清单里看不到它们，即使用户把 `advanced.confirmSensitiveTools` 设为 `false` 也不会绕过 readonly；`confirm` 档行为与今天完全一致；`auto` 档只在项目根内免确认、越界仍确认。
- [ ] **越界被真实拦住**：`read_file` / `write_file` / `edit_file` / `list_dir` / `grep` / `glob` / `run_command.cwd` 的路径都经过 realpath 归一后的项目根前缀校验，`..` 穿越与符号链接逃逸有单测证明被拒。
- [ ] **写前快照 + 一键回滚可端到端跑通**：`write_file`（overwrite/append）与 `edit_file` 在真正落盘前先把原文件快照进 `<userData>/backups/<sessionId>/`，**每条快照是一个独立内容文件 `<ISO 时间戳>-<8 位哈希>.snap` + 一份 `index.json` 索引**（形状口径见 `step-03` 操作第 4 条），环形保留 N 份；通过 IPC + 界面能把某个文件回滚到某个快照，且回滚本身也会先给"回滚前状态"再打一份快照。
- [ ] **Task/Job 可持久化续跑**：一次 Agent 请求有独立的 job 记录（状态 / 待办 / 已完成步骤 / 游标 / 预算）；`maxRounds` 与 token 预算进配置；轮次或预算用尽时 job 进入 `paused` 而不是静默结束；**应用重启后能把 paused job 接着跑完**，且不会重复落盘同一条用户消息。
- [ ] **端到端验收**：`pnpm typecheck && pnpm test && pnpm build` 全绿；`AURORA_SMOKE=1 pnpm dev` 通过（含本轮新增断言）；`AURORA_CAPTURE` 通过（含本轮新增/更新场景），`report.json` 无 FAIL。

## 现状与关键结论

（来源：本轮三路只读侦察 + 仓库实测。凡结论都可用 `文件:行` 复核。）

1. **配置改动链路是串行瓶颈**：`CONFIG_VERSION = 12`（`packages/shared/src/config/schema.ts:9`）；改字段必须同时动 5 处 —— `schema.ts`（字段 + 只读前缀 `368-394` + 原因表 `516-532` + 覆盖表 `558-599`）、`defaults.ts`（`150-240`）、`migrations.ts`（照抄 `457-484` 的 `migrateV11ToV12`，登记在 `486-499`）、`packages/shared/src/ipc/types.ts:79-113` 的 `SettingsPatch` + `apps/desktop/src/main/settings-patch.ts:231-267`、以及三类硬编码测试桩：**(a) 硬编码整份 settings 的桩**（`apps/desktop/src/main/classification.test.ts:87-146`、`apps/desktop/src/main/tts.test.ts:26-60`、`packages/shared/src/config/store.test.ts` 的 `version: CONFIG_VERSION` 用法、`packages/shared/src/config/schema.test.ts` 的顶层分组覆盖断言 `:87`）；**(b) 对新增分组/字段做严格 `toEqual` 的迁移断言**（`migrations.test.ts:275`、`:342-356`、`:365-377`、`:879` —— `migrate()` 默认 `targetVersion = CONFIG_VERSION`（`migrations.ts:515-518`），所以一次调用会跑完整链到最新版本，**新增 `agent.permissionMode` 会直接打破 `:342` 的 `toEqual`**）；**(c) 写死版本号的断言**（`migrations.test.ts:835` 的 `toBe(12)`）。**因此 step 1–4 必须串行**，不能并波。
   - **`pnpm verify`（`scripts/verify-p1.mjs`）也必须复跑**：它断言 `fresh.version === CONFIG_VERSION`（`:84`）与 `appliedMigrations.length === CONFIG_VERSION`（`:159`），连续改 3 次 `CONFIG_VERSION` 后必须每次跟着走（见各 step 的验收）。
2. **"项目"这一层不存在**：全仓 `grep -i project` 在 `packages/**` 零命中；现在有三个语义互不相通的目录字段 —— `modes.work.workspaceDir`（`schema.ts:317-321`，**只进 systemPrompt 文本**，`packages/modes/src/work.ts:86-91`）、`agent.tools.workspaceDir`（`schema.ts:450`，只喂 `run_command` 缺省 cwd 与 `grep/glob` 默认根，`tools/index.ts:117`）、`modes.classroom.watchDir`（`schema.ts:292`，唯一真有根目录语义的字段）。
3. **AGENTS.md 完全没有自动读取**：全仓 `grep AGENTS` 的 85 处命中全是仓库根 `AGENTS.md` 自身、docs 引用、step 归档与 `.ts` 注释，**没有一处 `readFile`/`readdir` 涉及它**。可照抄的先例是 Skill 加载器 `packages/agent-core/src/skills/registry.ts:179-192`（注入式 fs + 无该文件即忽略）。
4. **注入位置有硬约束，而且位置被一个导出的常量冻结**：`docs/06-agent-core.md:93-101` 与 `§21.1`（`:1237-1252`）要求系统提示词「静态在前、易变在后」，项目级 AGENTS.md 是易变段（切项目即变），**只能排在末尾**（`todoSummary` / `perceptionSummary` 附近）；同时 `packages/agent-core/src/context/systemPrompt.ts:72-82` 导出了 `VOLATILE_SECTION_TITLES`（注释明写"这三个标题的位置必须大于 `## 安全规则`，相对顺序为 历史摘要 → 任务清单 → 系统状态，**改标题或改顺序都要同步改这里**"），`systemPrompt.test.ts:133-166` 按它做顺序断言 → **新增任何易变小节都必须把它并入该常量并改用例**，否则 `:133` 与 `:162` 会 FAIL。
5. **权限判定目前只有两个开关，且收口点极少**：内核闸门在 `packages/agent-core/src/loop/agentLoop.ts:488-510`（条件写死 `sensitivity === 'confirm'`）；主进程唯一总放行分支在 `apps/desktop/src/main/agent-host.ts:271-272`（`enabled()` 为假直接 `return true`）；`run_command` 免确认特例在 `:276-289`。装配在 `apps/desktop/src/main/index.ts:648-656`（都是**每次调用即时读**的闭包）。**改主进程那一处即可覆盖全部 20 个工具**，不必动每个 `sensitivity`。
6. **`advanced.confirmSensitiveTools` 是 AI 不可写的真防线**：三层拦截 —— `main/tools/settings-port.ts:62-70` 查用户态只读数组 → `schema.ts:687-689` 的 `canWriteSettingPath` → 硬编码 `SETTINGS_READONLY_PREFIXES`（`schema.ts:389`）。它**不在** `WRITABLE_PATH_OVERRIDES`（`schema.ts:558-599`，`581-591` 有专门注释）。**新增 `agent.permissionMode` 必须同样登记为只读**，否则等于给 AI 一条自我提权路径。
7. **路径边界目前为零**：`apps/desktop/src/main/tools/file-port.ts` 的 `resolve()` 有 6 个调用点（`:113/:172/:207/:223/:268/:317`），全是裸 `resolve(path)`，**无前缀校验、无 realpath**（全仓 `grep realpath` 在 `packages/**` 与 `apps/desktop/src/main/**` 均 0 命中）；`command-runner.ts:54-75` 的 `cwd` 来自模型且无校验。可照抄的路径比较先例是 `apps/desktop/src/main/imagegen.ts:166-172`（`relative()` + `startsWith('..')` + `isAbsolute`）。
8. **写盘只有一个收口点，最适合插快照**：`write_file` → `files.ts:506` → `file-port.ts:206-220` 的 `writeText`；`edit_file` → `edit.ts:204` → 同一个 `writeText`。原子写在 `file-port.ts:653-662`。**全仓没有任何 backup/undo/rollback 机制**（`edit.ts:14-16` 明写"没有备份、没有撤销"），只有"损坏备份"三处（`session/store.ts:383-405`、`todo-port.ts:147-169`、`config/store.ts:465-471`）。可复用的环形上限写法两套：分类流水 500 条（`main/classification-history.ts:19/96-98`）与会话损坏备份 3 份（`session/store.ts:33/393-405`）。
9. **可持续跑的机制全缺，且有 3 个必须先补的语义缺口**：内核 `DEFAULT_MAX_ROUNDS = 8` 写死（`agentLoop.ts:21`），`apps/desktop` 全仓没有 `maxRounds`（grep 零命中）→ 线上恒为 8。缺口是：① `runAgentLoop` **无条件先落盘用户消息**（`agentLoop.ts:125-126`）→ 续跑会重复落盘；② 循环拿到 `usage` 但**不累计预算**（`:190/:210` 只用一次就透传）；③ `done` 只有 `pending`（`:46/:269`），**没有"为什么停"** → job 终态不可区分。
10. **持久化先例写得很全，但都有一个共同缺陷**：`apps/desktop/src/main/tools/todo-port.ts`（懒加载 / 300ms 防抖原子写 / 损坏备份 3 份 / `flush()` / sessionId 白名单归一）可以逐行照抄；但它的 `ensureLoaded`（`:117-121`）与 `session/store.ts:340-346` 都是**"先标记 loaded 再 await 读盘"** —— 并发首读会读到空快照。`SessionStore` 的写路径有 in-flight promise 去重（`:435-465`），**读路径没有**。job 续跑直接依赖"读到最新游标"，所以这条必须先修。
11. **测试与验收口径**（本轮实测）：`pnpm typecheck` 退出码 0；`pnpm test` = **72 文件 / 1307 用例全绿 / 18.76s**；`pnpm lint` 退出码 0。`vitest.config.ts` 的 include 是 `packages/*/src/**/*.test.ts` + `apps/desktop/src/main/**/*.test.ts` + `apps/desktop/src/renderer/**/*.test.ts`，且有两条硬约束：**主进程测试不得 import electron**（`apps/desktop/src/main/ipc.ts`、`window-manager.ts` 因此无法单测），**别用 `pnpm --filter` 跑测试**（根相对 include 匹配不到，直接 `No test files found` 退出码 1）。
12. **本次未引入任何新的第三方依赖**：本批四项全是内核/主进程基础设施（持久化、权限、路径校验、快照），项目既有约定是"能自研就不加依赖"（`docs/03-tech-stack.md` ADR-004、`docs/06 §7`）；外部只查证了 Windows 上做进程沙箱的业界做法（Codex 与 Anthropic srt 一致收敛到「专用账户 + capability SID + ACL + WFP + Job Object」），**但那属于第二批（OS 沙箱）的范围，本批不做**。
13. **外部事实（本批参考，均为只读查证）**：[openai/codex Windows sandbox 实现](https://github.com/openai/codex/tree/main/codex-rs/windows-sandbox-rs)（访问 2026-09-26，版本 rust-v0.157.1）证明 Windows 沙箱是"专用本地账户 + WFP 出站围栏 + 显式 ACE"；[Claude Code 权限模式文档](https://code.claude.com/docs/en/permission-modes)（访问 2026-09-26）给出 6 档权限 + Protected paths 的分级口径，**本项目选的是它最朴素的三档子集**（只读 / 需确认编辑 / 自动），不引入分类器与 OS 沙箱。

## 假设与待确认

- 假设 1（影响面大，已按用户选择固化）：**`advanced.confirmSensitiveTools` 不删除、不改语义**，与新增的 `agent.permissionMode` **双开关并存**，优先级明确为：`confirmSensitiveTools === false` → 非 readonly 时强制 `auto`；`readonly` 模式下该布尔**无效**（只读优先）。理由：改枚举会连带打掉只读前缀（`schema.ts:389` 是精确前缀）与 4 处界面/探针断言（`capture.ts:1423/1440/1447`、`AdvancedPage.vue:146`、`ComposerPermissionSelect.vue:59-64`）。
- 假设 2：**`agent.permissionMode` 登记为只读前缀**（AI 不可自我提权），只能由设置页/对话窗权限控件改（走 `settings:update`）。
- 假设 3：**快照保留份数默认 20、单份上限 512 KiB、快照目录总预算 200 MiB**，三项都是配置字段（可调），超额从最旧开始淘汰；超上限的文件**不写快照但在结果里明确告知**（不静默）。
- 假设 4：**job 与快照都以 sessionId 为归属键**（`<userData>/jobs/<sessionId>.json`、`<userData>/backups/<sessionId>/`），与现有 `todos` 的归属口径一致；`-sub` 子代理会话经同一套归一自然隔离。
- 假设 5：**job 的"预算"只算 token**（用 provider 回传的 `usage.totalTokens` 累计），不含金额换算（没有价格表）；**自动续轮的计数器 `budget.autoContinued` 必须持久化**，否则重启后会重新拿到额度。
- 假设 6：**AGENTS.md 的文件名沿用 AGENTS.md 社区约定**（Codex / Claude Code / Cursor 与*本仓库自己*的 `AGENTS.md` 都是这个名字），用户原话里的"Agent.md"按此理解；如需兼容其它文件名，追加 `projects.agentsFileNames` 数组即可，本批不做。
- 假设 7：项目根不存在 / 被删除 / 不可读时**降级为"无项目"**（不抛错、不影响对话），并在设置页的项目区与右栏"当前项目"卡上给出可见提示（不是只在日志里 warn）。
- 待确认：无。用户已在本次拆解前确认了「先做主线四项」「三档 + 工作区边界」「多模态与 Responses 合成一步（属第二批，本计划范围之外）」三条决策。

## 范围之外（明确不做）

- **第二批（本计划不做，主线归档后另起一套 step）**：① 多模态输入（图片进模型 + 附件预览）+ OpenAI Responses API；② 子代理能力对齐 Codex（多子代理 / 独立 model·effort / 并行 / 可写工作区 / send·interrupt·list）；③ 上下文压缩修正（`messageWeight` 计入 `toolCalls[].arguments`、摘要落盘、预算按真实 token 校准）。
- **本批也不做**：OS 级沙箱（Windows 专用账户 / capability SID / WFP / Job Object）—— 只做**应用层**三档权限与项目根前缀校验；引第三方设计系统/组件库；`apply_patch` 与统一 diff；git 快照（用文件快照，不依赖 git）；`grep` 移出主进程；命令黑名单；企业管控下发；代码签名与更新链加固。
- **顺手别做**：不要为了"看起来更完整"去改 `Task/Job` 之外的工具 sensitivity 取值；不要把 `advanced.confirmSensitiveTools` 改成枚举（见假设 1）；不要给 `FileSystemPort` 加 `copyFile`（快照用 `readFile + writeFileAtomic` 即可，加方法要同步 3 个实现：`packages/shared/src/config/ports.ts:22-57`、`packages/agent-core/src/testing/fileSystem.ts`、`packages/shared/src/testing/memoryFs.ts`）。

## 步骤

> 并波安排：**依次串行，无并波**。当前计划里 **所有工作步骤都改同一批全局单点文件**，按 step-planner 的"同波必须写范围不重叠"规则，任何两个步骤都不能真正同波执行，因此明确按 1 → 2 → 3 → 4 → 5 顺序执行，每个 step 一个 commit。
>
> 为什么不能并行（三条硬冲突，逐条可复核）：
> 1. **配置版本号是全局单点**：`CONFIG_VERSION`（`packages/shared/src/config/schema.ts:9`）、`MIGRATIONS` 数组（`migrations.ts:486-499`）、`SettingsSchema`、`DEFAULT_TOOLCHAIN_CONFIG`（`defaults.ts:179-240`）都是"改一次就要同步 5 处"的结构（见「现状与关键结论」第 1 条）。步 1 落 `projects` + `agent.permissionMode`（v12→v13）、步 3 落 `agent.snapshots.*`（v13→v14）、步 4 落 `agent.loop.*`（v14→v15）——**版本号只能按提交顺序递增**，否则迁移链会断。
> 2. **`apps/desktop/src/main/tools/file-port.ts` 与 `packages/agent-core/src/tools/{files,edit}.ts` 同时是"项目根路径边界"（步 2）与"写前快照"（步 3）的落点**，两者都在 `writeText` 内部：步 2 定 `resolveWithin` + `allowOutside` 语义，步 3 在其后插入快照，并给 `FilePort.writeText` 加可选 `snapshot` 参数（改接口签名会连带改 `files.ts` / `edit.ts` 的调用处与三个测试文件，与步 2 的重叠无法压缩）。
> 3. **`packages/agent-core/src/loop/agentLoop.ts` 同时被步 2（`confirmTool` 返回 `boolean | 'always'`）与步 4（`paused` 事件 + token 预算累计）修改**；`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/capture.ts`、`apps/desktop/src/main/smoke.ts` 三步都要动（不同区域，但同一文件）。
>
> 执行阶段的收益点不在步骤并行，而在**每个步骤内部**：单测与探针的编写可以派只读/分片子代理并行准备，但生产代码的写入按 step 边界串行。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-project-agents-md.md | 项目机制 + 项目级 AGENTS.md 注入 | pending | - | `packages/shared/src/config/**`、`packages/shared/src/ipc/types.ts`、`packages/agent-core/src/config/**`、`packages/agent-core/src/project/**`、`packages/agent-core/src/context/systemPrompt.ts`、`packages/agent-core/src/host/agentHost.ts`、`apps/desktop/src/main/settings-patch.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/chat/components/ContextPanel.vue`、`apps/desktop/src/renderer/settings/pages/GeneralPage.vue`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/08-settings-onboarding.md`、`docs/07-ui-spec.md` |
| 2 | step-02-permission-modes.md | 三档权限（只读/需确认编辑/自动）+ 项目根路径边界 | pending | step 1 | `apps/desktop/src/main/tools/{index,file-port,command-runner}.ts` + 三者 `.test.ts`、`apps/desktop/src/main/agent-host.ts` + `.test.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`packages/agent-core/src/tools/{registry,files,edit,search,terminal,task}.ts` + 对应 `.test.ts`、`packages/agent-core/src/loop/agentLoop.ts`（仅 `confirmTool` 返回类型与判定行）、`packages/agent-core/src/host/agentHost.ts`（仅 `confirmTool` 签名）、`apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`、`apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue`、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/settings/pages/{AdvancedPage,AgentPage}.vue`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/10-user-guide.md`、`docs/11-privacy.md` |
| 3 | step-03-write-snapshots.md | 写前自动快照 + 一键回滚（write_file / edit_file 共用） | pending | step 2 | `packages/agent-core/src/snapshots/**`（新，含 `snapshot-port.test.ts`）、`packages/agent-core/src/tools/files.ts`、`packages/agent-core/src/tools/edit.ts`、`packages/agent-core/src/tools/files.test.ts`、`packages/agent-core/src/tools/edit.test.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/tools/index.ts`、`packages/shared/src/config/schema.ts`（**仅加 `agent.snapshots.*` 字段与迁移 v13→v14**）、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/shared/composables/snapshots.ts`（新）、`apps/desktop/src/renderer/chat/components/ContextPanel.vue`、`apps/desktop/src/main/capture.ts`、`apps/desktop/src/main/smoke.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`docs/11-privacy.md` |
| 4 | step-04-durable-jobs.md | Task/Job 持久化与可续跑 + maxRounds·预算可配 + 自动续轮 | pending | step 3 | `packages/agent-core/src/jobs/**`（新，含 `jobs/store.test.ts`）、`packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/loop/agentLoop.test.ts`、`packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`packages/agent-core/src/session/store.ts`、`packages/agent-core/src/session/store.test.ts`、`packages/agent-core/src/index.ts`、`packages/shared/src/config/schema.ts`（**仅加 `agent.loop.*` 字段与迁移；版本号在 step 3 的 v14 之上顺延为 v15**）、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/jobs/**`（新）、`apps/desktop/src/main/tools/todo-port.ts`、`apps/desktop/src/main/tools/todo-port.test.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/smoke-llm.ts`、`apps/desktop/src/renderer/chat/components/JobPanel.vue`（新）、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`docs/10-user-guide.md` |
| 5 | step-05-verify-integrate.md | 端到端集成验证（smoke / capture / 文档收口） | pending | step 1..4 | `apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/capture.ts`、`docs/README.md`、`docs/04-roadmap.md`、`AGENTS.md`、`docs/06-agent-core.md`、`docs/07-ui-spec.md` |
| 6 | step-06-archive.md | 归档清理 | pending | step 1..5 | `step/` |

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）
