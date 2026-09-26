# 任务：Aurora Agent 可生产化主线（项目机制 + 三档权限 + 写前快照 + Task/Job 持久化续跑）

- 任务标识：agent-prod-mainline
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-26 10:52
- 执行模式：全部
- 基线提交：afd23827dee06381e72ca1d21d6371dc1d865dcc（用户要求执行阶段重新取 `git rev-parse HEAD`）
- 归档目录：`step/archive/20260926-163345-agent-prod-mainline/`
- 归档时间：2026-09-26 16:33

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
| 1 | step-01-project-agents-md.md | 项目机制 + 项目级 AGENTS.md 注入 | done | - | `packages/shared/src/config/**`、`packages/shared/src/ipc/types.ts`、`packages/agent-core/src/config/**`、`packages/agent-core/src/project/**`、`packages/agent-core/src/context/systemPrompt.ts`、`packages/agent-core/src/host/agentHost.ts`、`apps/desktop/src/main/settings-patch.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/chat/components/ContextPanel.vue`、`apps/desktop/src/renderer/settings/pages/GeneralPage.vue`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/08-settings-onboarding.md`、`docs/07-ui-spec.md` |
| 2 | step-02-permission-modes.md | 三档权限（只读/需确认编辑/自动）+ 项目根路径边界 | done | step 1 | `apps/desktop/src/main/tools/{index,file-port,command-runner}.ts` + 三者 `.test.ts`、`apps/desktop/src/main/agent-host.ts` + `.test.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`packages/agent-core/src/tools/{registry,files,edit,search,terminal,task}.ts` + 对应 `.test.ts`、`packages/agent-core/src/loop/agentLoop.ts`（仅 `confirmTool` 返回类型与判定行）、`packages/agent-core/src/host/agentHost.ts`（仅 `confirmTool` 签名）、`apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`、`apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue`、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/settings/pages/{AdvancedPage,AgentPage}.vue`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/10-user-guide.md`、`docs/11-privacy.md` |
| 3 | step-03-write-snapshots.md | 写前自动快照 + 一键回滚（write_file / edit_file 共用） | done | step 2 | `packages/agent-core/src/snapshots/**`（新，含 `snapshot-port.test.ts`）、`packages/agent-core/src/tools/files.ts`、`packages/agent-core/src/tools/edit.ts`、`packages/agent-core/src/tools/files.test.ts`、`packages/agent-core/src/tools/edit.test.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/tools/index.ts`、`packages/shared/src/config/schema.ts`（**仅加 `agent.snapshots.*` 字段与迁移 v13→v14**）、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/shared/composables/snapshots.ts`（新）、`apps/desktop/src/renderer/chat/components/ContextPanel.vue`、`apps/desktop/src/main/capture.ts`、`apps/desktop/src/main/smoke.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`docs/11-privacy.md` |
| 4 | step-04-durable-jobs.md | Task/Job 持久化与可续跑 + maxRounds·预算可配 + 自动续轮 | done | step 3 | `packages/agent-core/src/jobs/**`（新，含 `jobs/store.test.ts`）、`packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/loop/agentLoop.test.ts`、`packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`packages/agent-core/src/session/store.ts`、`packages/agent-core/src/session/store.test.ts`、`packages/agent-core/src/index.ts`、`packages/shared/src/config/schema.ts`（**仅加 `agent.loop.*` 字段与迁移；版本号在 step 3 的 v14 之上顺延为 v15**）、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/jobs/**`（新）、`apps/desktop/src/main/tools/todo-port.ts`、`apps/desktop/src/main/tools/todo-port.test.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/smoke-llm.ts`、`apps/desktop/src/renderer/chat/components/JobPanel.vue`（新）、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`docs/10-user-guide.md` |
| 5 | step-05-verify-integrate.md | 端到端集成验证（smoke / capture / 文档收口） | done | step 1..4 | `apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/capture.ts`、`docs/README.md`、`docs/04-roadmap.md`、`AGENTS.md`、`docs/06-agent-core.md`、`docs/07-ui-spec.md` |
| 6 | step-06-archive.md | 归档清理 | pending | step 1..5 | `step/` |

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

### Step 1 — 项目机制 + 项目级 AGENTS.md 注入（Status: done）

- 完成时间：2026-09-26；执行模式：全部连续执行。
- 提交清单：
  - `48f669f` `chore(step): 加入 agent-prod-mainline 计划（项目机制 / 三档权限 / 写前快照 / Task-Job 续跑）`
  - `a12ea47` `feat(config): 配置 v13 —— 新增 projects 项目机制分组与 agent.permissionMode 三档权限`
  - `1ca2912` `feat(agent-core): 项目解析与项目级 AGENTS.md 逐层收集 + 系统提示词「项目约定」注入`
  - `221db99` `feat(settings): 项目 IPC 与装配 —— project:status / 目录选择 / openPath kind:project`
  - `ff57d80` `feat(settings): 设置页「项目」区组与右栏「当前项目」卡`
  - `0c7abee` `test(e2e): capture 新增 chat-project-card 场景与 general 页 projects 探针`
  - `5245d87` `docs: 项目机制与三档权限落文档（06 §5.1 / §21.1 / §12.2、07 右栏与锚点、08 §1 与迁移）`
- 验收结果：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` 全绿；`pnpm test` 76 文件 1373 用例全绿（原 1307）；`pnpm verify` 26/26；`AURORA_CAPTURE` 49/49 条 checks、0 FAIL、exit 0；`AURORA_SMOKE` 147/147、exit 0（含新增的"项目级 AGENTS.md 进请求体且 override 优先"断言）。
- 计划偏差：新增 `project:status` / `project:pickDirectory` 两条 IPC 与 `openPath kind:'project'`（原计划的 `kind:'workspace'` 打开的是 `agent.tools.workspaceDir`，不是项目根）；右栏锚点用 `context.project-card`（该文件既有 `context.*` 约定）；补导出 `packages/agent-core/src/index.ts`。详见 `step-01-project-agents-md.md` 的「执行记录 → 与计划的偏差」。
- 过程中修掉两个计划外的真问题：① `main/index.ts` 五处 `settings.update({ agent: { tools } })` 少带 `permissionMode` 会把用户选的权限档静默重置（类型 + 行为双修）；② capture 的 onboarding 引导探针在窗口不产生帧时因进场动画停在 `opacity: 0` 偶发失败（probe 侧 `finish()` 到终态 + 失败原因带真实几何，断言未放宽）。
- 遗留（不阻塞）：capture 的 `chat-tool-card-open` / `chat-stream-burst` 两条 perf·时序探针在帧饥饿时偶发红（本步未动，属环境问题）；设置页"项目根失效标红"缺独立探针；`AURORA_CAPTURE_WINDOWS=onboarding` 单窗口过滤会卡住。

### Step 2 — 三档权限 + 项目根路径边界（Status: done）

- 完成时间：2026-09-26；执行模式：全部连续执行。
- 提交清单：
  - `e9ed4e1` `feat(agent-core): 三档权限判定与确认值「本会话都允许」`
  - `12dca39` `feat(agent-core): allowOutside 透传 + 只读档下子代理工具面收窄`
  - `cf013ff` `feat(settings): 项目根 realpath 边界校验 + 只读档工具门控与端到端断言`
  - `c274838` `feat(settings): 三档权限界面（下拉/设置页/确认卡第三键）与文档落笔`
- 验收结果：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` 全绿；`pnpm test` 77 文件 **1420** 用例全绿（step 1 后 1373）；`AURORA_SMOKE` **149/149**（新增只读档注册集合、auto 档根内免确认+真写入、根外弹卡+未放行写不进去三条证据）；`AURORA_CAPTURE` **50/50 checks、0 FAIL**（新增 `chat-permission-readonly.png`、settings-agent 只读摘要三条断言、`chat-composer-permission` 改三档判据）。
- 计划偏差：权限纯函数落 `packages/shared`（主进程与渲染层共用生效档位）；会话级授权表落内核 `KernelAgentHost`（循环一趟一实例，记忆放循环等于没记住）；`approvedByUser` 作为"越界仍确认"的通道；边界只在**配置了当前项目**时启用；`isWithinRoot` 对含 `..` 路径直接判越界。详见 `step-02-permission-modes.md`。
- 过程：三个子代理中途失败（agent-core 管道 / file-port / 渲染层），主代理接手收尾并补上主进程装配缺口（`getSettings` 未传给 `registerAgentCoreTools`、`workspaceRoot` 未接给 file-port / command-runner）与缺失的 cwd 边界成对断言。

### Step 3 — 写前快照 + 一键回滚（Status: done）

- 完成时间：2026-09-26；执行模式：全部连续执行。
- 提交清单：
  - `5bf3849` `feat(config): 配置 v14 —— agent.snapshots 写前快照策略（开关/保留份数/单份与目录上限）`
  - `0eb2f1f` `feat(agent-core): 写前快照端口（环形保留 + 索引 + 损坏恢复）与工具层透传`
  - `bd9bad5` `feat(settings): 写前快照钩子、snapshots IPC 与一键回滚链路 + 端到端探针`
  - `30ef046` `feat(settings): 右栏「文件备份」卡与设置页「文件备份」区组（两段式回滚）`
  - `48e5169` `docs: 写前快照与回滚落文档（06 §11.8 / §11.4 / §11.6、07 右栏卡与探针、08 §1 与迁移、11 披露）`
- 验收结果：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` 全绿；`pnpm test` 78 文件 **1454** 用例全绿（step 2 后 1420）；`pnpm verify` 26/26（version=14、14 条迁移）；`AURORA_SMOKE` **153/153**（写后留底 + 结果回带 id / 回滚内容还原且自身留 `rollback` 快照 / append 留追加前内容 + edit_file 同样留底 / 连写 30 次后 `.snap` 数 = 20 ≤ keepPerFile）；`AURORA_CAPTURE` **51 张 PNG / 51 条 checks / 0 FAIL**（新增 `chat-snapshot-card.png`、settings-agent 的 `snapshotFields:4`）。
- 计划偏差：`contentPath` 存相对快照根目录（含 sessionId 段）；`totalBudgetBytes` 是**每会话**口径；`restoreSnapshot` 从 ipc.ts 导出以便 smoke 复用同一条链路；`SnapshotRef` 唯一定义在 `@aurora/shared`；额外给设置页加了「文件备份」区组（否则四个新字段是死字段）。
- 遗留：`prune` 无界面入口、右栏卡不按会话过滤（都卡在"渲染层拿不到当前会话 id"）；`useSnapshots()` 无单测。详见 `step-03-write-snapshots.md`。
### Step 4 — Task/Job 持久化与可续跑（Status: done）

- 完成时间：2026-09-26；执行模式：全部连续执行。
- 提交清单：
  - `681b705` `fix(agent-core): 修会话与待办清单的首读竞态（并发首读会拿到空快照并覆盖磁盘历史）`
  - `aad5c06` `feat(config): 配置 v15 —— agent.loop.*（轮次上限 / token 预算 / 自动续轮）`
  - `2e49525` `feat(agent-core): Task/Job 持久化与预算内自动续轮（agent.loop，配置 v15）`
  - `39d10ac` `feat(desktop): 任务面板与续跑入口（chat.jobs / resumeJob / cancelJob + 端到端探针）`
  - `ee2196d` `docs: Job 持久化与续跑落文档（06 §4.1 新增、07 任务面板、08 §1 与迁移、10 用户指南）`
- 验收结果：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` 全绿；`pnpm test` 79 文件 **1496** 用例全绿（step 3 后 1454）；`pnpm verify` 26/26（version=15、15 条迁移）；`AURORA_SMOKE` **157/157**（轮次用尽落 paused + 游标与步骤落盘 / 续跑跑到 done 且**用户消息只有一条** / 预算触顶落 paused(budget) / 取消落 aborted）；`AURORA_CAPTURE` **52 张 PNG / 52 条 checks / 0 FAIL**（新增 `chat-job-panel.png`、settings-agent 的 `loopFields: 3`）。
- 计划偏差：`AgentJob` / `JobSummary` 等形状放 `@aurora/shared`（跨 IPC 只能一份定义）；`E_JOB_STATE` 登记在 `shared/utils/result.ts` 的 `ErrorCode`；jobs 侧 `normalizeSessionId` 不导出（避免与 session 侧同名星号导出撞车）；左栏任务入口在**底部**固定项而非「子代理」那一组（有意偏差，不改 `SessionNav.vue`）；额外给设置页加了「Agent 循环」栏。
- 过程：smoke 抓到"预算形同虚设"（桩服务只在最后一段纯文本回 usage，而预算判定发生在工具轮结束）；`E_BUSY` 用例靠调度运气，改 3 版后用可控闸门稳定；capture 夹具时序踩了 job 存储「首读即缓存」的坑（种在 prepare 里看不到，改到跑计划前）。
- 未覆盖：**"两次独立启动"的重启续跑手工脚本**没做（smoke 的 userData 每次新建、无跨启动 harness）；现有证据是同进程续跑 + 落盘实据（`cursor.nextRound=3`、`stepsDone=3`）+ 换实例读同一份存储的单测。详见 `step-04-durable-jobs.md`。
### Step 5 — 端到端集成验证与文档收口（Status: done）

- 完成时间：2026-09-26；执行模式：全部连续执行。
- 提交清单：`484872a` `test(e2e): 跨特性集成断言、综合截图场景与两次启动的续跑验证`、`cd81b65` `docs: 本轮文档收口（README / roadmap / AGENTS.md）与陈旧锚点修正`、`docs(step): 回填 step 5 执行记录`。
- 验收结果：`typecheck` / `lint` / `format:check` / `build` 全绿；`pnpm test` **79 文件 / 1496 用例**（基线 72 文件 / 1307，净增 189）；`pnpm verify` **26/26**（version=15）；`AURORA_SMOKE` **163/163**，含六条跨特性断言（项目 AGENTS.md 进请求体且**父目录**不进 / auto 档根内写文件不弹卡且落盘且留快照 / readonly 档写不动文件 / 一键回滚还原 + 新增 rollback 快照 / 事件白名单含 `job` / 为第二次启动留 paused job）；**两次启动续跑实测**：`paused → done`、`stepsDone 2→3`、`cursor 2→3`、用户消息 `1→1`（`AURORA_SMOKE_WORKSPACE` 固定工作区 + `AURORA_SMOKE_PHASE=resume`，均仅自测生效）；`AURORA_CAPTURE` **53 张 PNG / 53 条 checks / 0 FAIL**（step 1–4 四个新场景 + 新增综合图 `chat-agent-prod-overview.png`）。
- 过程：本步挖出并修掉一个**真 bug** —— `runSmokeTest` 的收尾无条件删掉自测工作区，而固定工作区正是第二次启动要读的（症状"第一次 file=yes、第二次 found=0"，且 `rm -rf` 与收尾写入抢时序导致偶尔剩几个文件，看起来像随机丢数据）；修法是两处删除加 pinned 守卫 + 2.7 块加落盘自检。另修：第二次启动没起桩服务 → `E_NO_MODEL`（表现为"点了继续没反应"）。
- **独立审查未完成**（如实记录）：两次派只读审查子代理均**无回报结束**；已改为主代理对同样三个最高风险问题定向自查，并在 `step-05` 记录里标明"这是自查、不是独立审查"。自查发现两条 **P1**（均只记录未修，属 step 2/3 范围）：①项目根内的符号链接 / 目录联接可绕过 realpath 前缀校验（写路径本身缺 `lstat` 判定，快照侧已经是安全的）；②`exists:false` 快照回滚**无条件删除**该路径（用户后来新建的同名文件会被删；界面有「当时不存在」标注 + 两段式确认，但文案未说明"当前有文件将被删除"）。
- 计划偏差：六条断言写在主进程 `runSmokeTest` 而不是渲染层脚本模块 `smoke.ts`（后者拿不到桩请求体与 job 存储）；新增两个自测专用环境变量与桩的 `AURORA_WRITE_FILE` 分流；`capture.ts` 新增 `CapturePlanHooks.setProject` 钩子；`docs/07 §2.4` 选"改引用"而非"补建已废弃编号"。
- 逐条验收对照见 `step-05-verify-integrate.md` 的「执行记录」；遗留（自测开关未写进用户文档、渲染层缺单测、`snapshots:prune` 无界面入口、两条 perf 探针帧饥饿偶发红）见该文件末尾。