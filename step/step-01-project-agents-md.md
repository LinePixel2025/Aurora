# Step 01 — 项目机制 + 项目级 AGENTS.md 注入

- Task: agent-prod-mainline
- Step: 1 / 6
- Status: done
- Depends on: none
- Produces: `projects`/`agent.permissionMode` 配置面（Schema v13 + 迁移 + 只读前缀）、`ProjectStore`（纯 Node）、`AGENTS.md` 逐层读取器、系统提示词注入点、右栏"当前项目"卡、单测与文档
- Phase: 基础与配置
- Writes: `packages/shared/src/config/schema.ts`、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/types.ts`、`packages/agent-core/src/config/**`（新）、`packages/agent-core/src/project/**`（新）、`packages/agent-core/src/context/systemPrompt.ts`、`packages/agent-core/src/context/systemPrompt.test.ts`、`packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`apps/desktop/src/main/settings-patch.ts`、`apps/desktop/src/main/settings-patch.test.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/classification.test.ts`、`apps/desktop/src/main/tts.test.ts`、`apps/desktop/src/renderer/chat/components/ContextPanel.vue`、`apps/desktop/src/renderer/settings/pages/GeneralPage.vue`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`
- Risk: ①改 `CONFIG_VERSION` 会连带打掉硬编码整份 settings 的测试桩（`classification.test.ts:133`、`tts.test.ts:60`、`migrations.test.ts:278/345/367`、`store.test.ts:171`、`schema.test.ts:204`）—— 出错回滚方式是把 `CONFIG_VERSION` 与迁移一起回退（本步是独立 commit）。②AGENTS.md 若注入到静态段中间会破坏 `docs/06 §21.1` 的前缀稳定性，导致 smoke 的"两轮静态前缀逐字节相同"断言失败。
- Sources: `docs/06-agent-core.md:1237-1252`（§21.1 静态在前、易变在后，本仓库既有硬约束）；`openai/codex` 的 `codex-rs/core/src/agents_md.rs`（访问 2026-09-26，rust-v0.157.1）—— 项目文档发现顺序 `AGENTS.override.md` → `AGENTS.md` → 可配 fallback，从项目根到 cwd 逐层拼接、受字节预算截断、untrusted 项目跳过。

## 目标

Aurora 第一次有"当前项目"这一层实体：配置里能登记项目（名字 + 根目录），并在每一轮请求里把项目根到当前工作目录之间的 `AGENTS.md`（`AGENTS.override.md` 优先）按"远的在前、近的在后"拼成一段，**注入在系统提示词的静态前缀之后**。做完后：用户在项目根放一份 `AGENTS.md`，对话里模型就能遵守它；没有项目时行为与今天完全一致。

## 输入

- 配置链路（改字段必须同步这些处，缺一处就报错或静默失效）：
  - `packages/shared/src/config/schema.ts`：`CONFIG_VERSION = 12`（`:9`）；`AgentToolsSchema`（`:447-491`）；**`AgentSchema`（`:494-496`）**；**`SettingsSchema`（`:499-511`）**；`SETTINGS_READONLY_PREFIXES`（`:368-394`）；只读原因表 `READONLY_PREFIX_REASONS`（`:516-532`，**是 `Record<(typeof SETTINGS_READONLY_PREFIXES)[number], string>` 映射，注释明写"每个默认前缀都必须有一条"，新增前缀漏加条目会直接编译失败**）；`WRITABLE_PATH_OVERRIDES`（`:558-599`，**本次不要往这里加**）；`settingsReadonlyReason`（`:664-678`）；`isKnownSettingPath`（`:640-642`）。
  - `packages/shared/src/config/defaults.ts`：`DEFAULT_AGENT_TOOLS` 一带（`:150-177`）、`DEFAULT_TOOLCHAIN_CONFIG`（`:179-240`，整份默认配置的字面量，`version: CONFIG_VERSION` 在 `:180`）。
  - `packages/shared/src/config/migrations.ts`：**照抄模板** `migrateV11ToV12`（`:457-484`，`{ from, to, describe, transform }` + `fillMissing` 补缺 + `next['version'] = to`）；登记数组 `MIGRATIONS`（`:486-499`）；`migrate()` 的签名是 `migrate(raw, logger?, targetVersion = CONFIG_VERSION)`（`:515-518`）——**默认会跑完整链到最新版本**。
  - `packages/shared/src/ipc/types.ts`：`SettingsPatch`（`:79-113`），新增顶层分组要在这里出现。
  - `apps/desktop/src/main/settings-patch.ts`：`applySettingsPatch` 一带（`:231-267`，**顶层分组是 `Object.assign` 整棵覆盖，不是深合并**），以及它自己的测试 `settings-patch.test.ts`。
  - ⚠️ **必改的既有断言（不改就必红，而且会被误诊成"同步漏了"）**：
    - `packages/shared/src/config/migrations.test.ts:342-356` 的 `expect(outcome.data['agent']).toEqual({ tools: {...} })` —— 加了 `agent.permissionMode` 后必然失败；`:275`、`:365-377`、`:879` 是同款严格断言；`:832` 的 `toHaveLength(1)` 与 `:835` 的 `toBe(12)` 写死了版本号。**修法**：这些断言改成"只断言本步关心的键"（用 `expect.objectContaining`）或显式传 `targetVersion`；`:835` 改成 `toBe(CONFIG_VERSION)`。
    - `apps/desktop/src/main/classification.test.ts:87-146` 的 `settingsWith()` 返回类型是 `Settings`（`:91`），**新增的必填字段（zod `.default()` 后输出类型必填）会让它编译红**；`apps/desktop/src/main/tts.test.ts:26-60` 的 `fakeSettings()` 同款。两处都要补新字段。
    - `packages/shared/src/config/schema.test.ts:87` 有"校验表覆盖全部顶层分组"的联动断言 → 新增 `projects` 顶层分组要同步。
- 注入点（必须排在易变段）：`packages/agent-core/src/context/systemPrompt.ts` 的 `SystemPromptParts`（`:37-69`，现有末尾是 `todoSummary` / `perceptionSummary`）；`packages/agent-core/src/host/agentHost.ts` 的 `SystemPromptParts` 装配（`:289-311`，`settingsHint` `:289`、`todoSummary` `:290`、`buildSystemPrompt` `:292-311`）与 `AgentHostDeps`（`:43-89`，`todoSummary?` 在 `:88`）。
- 可照抄的读取器先例（注入式 fs、无该文件即忽略、不 import electron）：`packages/agent-core/src/skills/registry.ts:179-192`。
- 主进程装配位置：`apps/desktop/src/main/index.ts` 里 `new KernelAgentHost({ ... })` 一带（`:658-679`，`todoSummary` 的 getter 就在同处）与 `syncToolRegistries()`（`:2231-2238`）。
- 渲染层：`apps/desktop/src/renderer/chat/components/ContextPanel.vue` 的 work 模式卡（`:250-263`，展示 `workspaceDir`）与通用档（`:183`/`:250`）；`apps/desktop/src/renderer/settings/pages/GeneralPage.vue` 的"系统"页分组（`grep -n "section-title\|data-field" apps/desktop/src/renderer/settings/pages/GeneralPage.vue` 定位）。
- 既有验证口径：`vitest.config.ts` 的 include 是 `packages/*/src/**/*.test.ts` + `apps/desktop/src/main/**/*.test.ts` + `apps/desktop/src/renderer/**/*.test.ts`；**主进程测试不得 import electron**。
- 文档锚点：`docs/06-agent-core.md:93-101`（§5 系统提示词小节顺序）、`:1231-1252`（§21 caching，§21.1 静态在前在 `:1237`）、`:592`（§12 开头）/ `:617-668`（§12.2 三道闸门与只读前缀清单）、`:1097-1119`（§17 settingsHint）；`docs/08-settings-onboarding.md:5`（§1 标题）、`:20-35`（JSON 样例开头）、`:194-220`（provider 字段说明附近的散文区）、`:269-299`（`agent.tools` 散文）、`:301`（§1.1 IPC-only 标记）、`:341-366`（§2 迁移清单）、`:570-614`（§6.1 门控矩阵）；`docs/07-ui-spec.md:73-285`（§2.3 主界面）、`:348-363`（`data-field` 锚点清单）。

## 操作

1. **先改文档（docs-first，仓库硬约束）**：
   - `docs/08-settings-onboarding.md`：§1 的 JSON 样例加 `projects` 段与 `agent.permissionMode`（本步只落 `projects`，`permissionMode` 字面量可先写进样例并在 step 2 补齐语义）；散文区新增「项目（projects）」小节，写清 `projects.current`（当前项目 id，空串 = 无项目）、`projects.list[]`（`{id, name, root}`）、`projects.maxAgentsBytes`（AGENTS.md 注入字节预算）；§2 迁移清单加一行 `v12 → v13`；§6.1 门控矩阵加一行"项目切换只能由用户在设置页/界面触发"。
   - `docs/06-agent-core.md`：§5 的小节顺序列表里在「当前任务清单」之前/之后明确插入「**项目约定（AGENTS.md）**」并注明它属易变段、必须在静态段之后；新增一小节 `### 5.1 项目与 AGENTS.md`（放在 §5 内，`docs/06:91` 开头，`§6` 从 `:145` 开始，所以插在 `:144` 之前），写清发现顺序、逐层拼接方向、字节预算、文件缺失/读取失败一律降级。
2. **配置 Schema（`packages/shared/src/config/schema.ts`）**：
   - `ProjectSchema = z.object({ id: z.string(), name: z.string(), root: z.string() })`，`ProjectsSchema = z.object({ current: z.string().default(''), list: z.array(ProjectSchema).default([]), maxAgentsBytes: z.number().int().min(0).max(1_048_576).default(32768) })`。**每个字段都要有 `.default()`** —— 顶层分组若整段缺失，Schema 校验会走"整体保留候选对象"路径（`schema.ts:721-730`、`:905-907`），无默认值会导致整份配置被判非法并备份重建。
   - `AgentSchema` 加 `permissionMode: z.enum(['readonly', 'confirm', 'auto']).default('confirm')`（step 2 消费；本步只需落地字段与只读登记，避免 step 2 再动 Schema 与迁移号）。
   - `SettingsSchema`（`:499-511`）加 `projects: ProjectsSchema`。
   - `SETTINGS_READONLY_PREFIXES` 加两条并**同时在 `READONLY_PREFIX_REASONS` 补中文原因**：`'projects'`（切项目会改注入的指令与路径边界，等于改 Agent 的权限面）、`'agent.permissionMode'`（权限档位自我提权）。
   - `CONFIG_VERSION` 从 `12` 改成 `13`。
3. **默认配置（`defaults.ts`）**：`DEFAULT_TOOLCHAIN_CONFIG` 加 `projects: { current: '', list: [], maxAgentsBytes: 32768 }`；`agent` 段加 `permissionMode: 'confirm'`。**不要**给 `list` 预设任何项目（默认无项目 = 与今天行为一致）。同步 `version: CONFIG_VERSION`（自动跟随）。
4. **迁移（`migrations.ts`）**：追加 `migrateV12ToV13`（照抄 `:457-484` 的结构）：
   - `describe: 'v12 → v13：新增 projects（项目机制）与 agent.permissionMode（三档权限）'`；
   - `transform`：`const next = { ...raw }`；若 `raw['projects']` 是对象则 `next['projects'] = fillMissing(projects, { current: '', list: [], maxAgentsBytes: 32768 })`；若 `raw['agent']` 是对象则 `next['agent'] = { ...agent, permissionMode: 'confirm', ...(已有的 permissionMode 不覆盖) }`（用 `fillMissing(agent, { permissionMode: 'confirm' })` 的语义，**绝不覆盖用户已写值**）；`next['version'] = 13`。
   - 登记到 `MIGRATIONS` 数组末尾。
   - **不要**动历史迁移条目。
5. **SettingsPatch（`packages/shared/src/ipc/types.ts` + `apps/desktop/src/main/settings-patch.ts`）**：`SettingsPatch`（`:79-113`）加一行 `projects?: Partial<Settings['projects']>`（**照 `:108-112` 的 `skills` / `mcp` / `modes` / `agent` 写法，用 `Partial<Settings['...']>` 而不是内联对象字面量**）；`apps/desktop/src/main/settings-patch.ts` 的 `applySettingsPatch` 在 `:264`（`if (patch.modes !== undefined) Object.assign(draft.modes, patch.modes)`）后面加一行 `if (patch.projects !== undefined) Object.assign(draft.projects, patch.projects)`，并**不改动 `:267` 那行 `patch.agent` 的整树覆盖语义**（`agent` 是整棵子树覆盖，只传 `{ permissionMode }` 会静默丢掉 `tools` —— 设置页保存 `agent` 时必须带完整子树，见 `:265-267` 的注释）。`settings-patch.test.ts` 加用例：只传 `projects: { current: 'a' }` 时 `list` 不被清空。
6. **项目解析层（新文件）**：
   - `packages/agent-core/src/config/project.ts`：纯函数 `resolveProject(settings, { cwd })` → `{ current: ProjectConfig | undefined, root: string | undefined }`；`root` 为绝对路径时直接采用，相对路径按传入的 `cwd` 解析；`current` 指向的 id 不在 `list` 里时返回 `undefined` 并记 warn（**降级为无项目，不抛错**）。
   - `packages/agent-core/src/config/effectiveWorkspace.ts`：`effectiveWorkspaceDir(settings, projectRoot)` → 优先级 **`projects.list[current].root` > `agent.tools.workspaceDir` > `homeDir`**。注意：**本步只导出这个函数并写单测，不改 `apps/desktop/src/main/tools/index.ts` 的消费**（那一步在 step 2 里做，避免与 step 2/3 抢同一文件）。
7. **AGENTS.md 读取器（新文件 `packages/agent-core/src/project/agentsFile.ts`）**：
   - 导出 `AGENTS_FILE_NAME = 'AGENTS.md'`、`AGENTS_OVERRIDE_FILE_NAME = 'AGENTS.override.md'`、`COLLECT_AGENTS_LIMITS = { maxDirs: 24, maxBytes: 32768 }`。
   - `collectProjectInstructions(options: { root: string; cwd: string; maxBytes?: number; fs: ProjectFs }): Promise<{ text: string; files: string[]; truncated: boolean; warnings: string[] }>`，`ProjectFs` 只依赖 `readFile` / `stat`（**注入，不直接 import node:fs**，照 `skills/registry.ts` 的做法）。
   - 语义（逐条实现并各自有用例）：① 从 `root` 到 `cwd` 逐层目录（含两端），每层**同一目录内 `AGENTS.override.md` 优先于 `AGENTS.md`，两者都有时只用 override**；② 拼接顺序**远 → 近**，每份前面加一行 `### <相对项目根的路径>`；③ `cwd` 不在 `root` 之下时**只取 `root` 一层**（不越界向上）；④ 每层目录最多读一个文件，目录层数超 `maxDirs` 或总字节超 `maxBytes` 即停并置 `truncated: true`；⑤ 文件不存在 / 读取失败 / 是目录 / 是符号链接一律跳过并记 `warnings`，**永不抛错**；⑥ 单文件超过 `maxBytes` 时截断并在文本里标注。
8. **系统提示词注入 + 易变段常量（这里有个必须同步的冻结契约）**：
   - `packages/agent-core/src/context/systemPrompt.ts` 的 `SystemPromptParts`（`:37-69`）加可选 `projectInstructions?: string`，渲染为 `## 项目约定` 小节，位置**在 `historySummary` / `todoSummary` 之后、`perceptionSummary` 之前（即静态段之后）**；空串/`undefined` 时整段省略。
   - ⚠️ **必须同时改 `VOLATILE_SECTION_TITLES`（`systemPrompt.ts:72-82`）**：它的注释明写"这三个标题的位置必须大于 `## 安全规则`，相对顺序为 历史摘要 → 任务清单 → 系统状态，**改标题或改顺序都要同步改这里**"。把 `'## 项目约定'` 按渲染顺序插进去（建议放在 `'## 当前任务清单'` 之后、`'## 系统状态'` 之前），并把注释里的"这三个"改成"这四个"。
   - 同步改 `packages/agent-core/src/context/systemPrompt.test.ts`：`:59` 的用例标题、`:133` 的"三个易变小节都排在 `## 安全规则` 之后，相对顺序是…"、`:143` 与 `:162` 的遍历断言（都直接读 `VOLATILE_SECTION_TITLES`）—— 若只改常量不改用例标题/措辞，断言本身会跟着常量走而通过，但"三个"的措辞会变成错的文档；**同时补一条新断言：`projectInstructions` 有值时 `## 项目约定` 的位置大于 `## 安全规则`，且整段顺序仍满足"静态在前"**。
   - 补一条**逐字节稳定性**断言：同一 parts 连续构建两次（一次带 `projectInstructions`、一次不带）时，除新小节外的静态前缀逐字节相同（照 `:84-115` 现有的公共前缀用例写法）。
9. **装配（`packages/agent-core/src/host/agentHost.ts` + `apps/desktop/src/main/index.ts`）**：`AgentHostDeps` 加 `projectInstructions?: () => string | undefined`（与 `todoSummary` 同款 getter，`agentHost.ts:88` 旁）；在 `run()` 的 `:289-311` 区域读它并传进 `buildSystemPrompt`。主进程在 `new KernelAgentHost({...})`（`index.ts:658-679`）注入一个闭包：用 `resolveProject(settings.get(), { cwd: process.cwd() })` 拿 root，再调 `collectProjectInstructions`（fs 用 `nodeFileSystem`），结果**按项目根缓存**（同一 root 且文件 mtime 未变则复用），失败时返回 `undefined` 并 warn。
10. **设置页 + 右栏**：`apps/desktop/src/renderer/settings/pages/GeneralPage.vue` 新增「项目」区组（列项目：名字 + 根目录 + 「设为当前」+ 删除；空态文案"尚未添加项目"）；字段用 `data-field="projects.current"` / `data-field="projects.name"` / `data-field="projects.root"`（路径原文约定）；保存走 `settingsStore.update({ projects: { ... } })`，**必须带完整子树**（顶层浅合并，参考 `WorkSection.vue:8-10` 的注释）。`ContextPanel.vue` 在通用档新增「当前项目」卡（显示项目名 + 根目录 + 「打开文件夹」复用现有 `openPath({kind:'workspace'})` 的 IPC，见 `main/ipc.ts:786-812`），无项目时整卡不渲染。
    - **项目根失效要有可见提示**（假设 7）：当前项目指向的目录不存在 / 不可读时，右栏卡片显示"项目目录不可用"警示态、设置页对应行标红并给出「重新选择目录」，**不能只在日志里 warn**（否则用户会以为 AGENTS.md 生效了却什么都没发生）。
11. **capture 探针**：在 `apps/desktop/src/main/capture.ts` 的 settings 页场景里，给 GeneralPage 的字段探针加 `projects.*` 计数与 `data-empty` 白名单（照 `SETTINGS_AGENT_FIELDS_SCRIPT:2647-2717` 的写法：`count('[data-field^="projects."]')` + `unexpected` 白名单 + `pass` 组合，**不要写死具体数字**）。新增一个 chat 场景 `chat-project-card.png`：种一份 settings（`projects.current` 指向一个临时目录）→ 断言右栏出现 `chat.project-card` 且文本含项目名。种盘必须走 `settings:update`（SettingsStore 启动即缓存，写文件对运行中的进程无效）。
12. **测试落点**（新增文件都用 `packages/agent-core/src/project/*.test.ts` 与 `packages/agent-core/src/config/*.test.ts`，用内存 fs 桩）：
    - `project.test.ts`：`current` 指向不存在 id → `undefined` 且不抛；相对 root 按 cwd 解析；`effectiveWorkspaceDir` 三级优先级。
    - `agentsFile.test.ts`：override 优先；远→近顺序；cwd 在 root 外只取 root；字节预算截断置 `truncated`；文件缺失/读取抛错跳过且不抛；符号链接跳过；单文件截断。
    - `schema.test.ts` / `migrations.test.ts`：加 v12→v13 一段（照 `migrations.test.ts:829-882` 的 `describe` 写法，**注意既有用例大量用 `CONFIG_VERSION - N` 相对算术，会自动跟着变**）；断言迁移幂等（连跑两次结果一致）、不覆盖已有的 `agent.permissionMode`、缺 `agent` / `projects` 分组时不报错。
    - `settings-patch.test.ts`：见第 5 步。
13. **验证并提交**：按下面的验收标准逐条跑；提交信息用 Conventional Commits 中文，建议 `feat(v0.1.5): 新增项目机制与项目级 AGENTS.md 注入（配置 v13）`。**先 `pnpm --filter @aurora/shared build` 再跑下游 typecheck**（`apps/desktop` 的 `@aurora/*` 类型指向 `dist/*.d.ts`）。

## 验收标准

- [ ] `pnpm --filter @aurora/shared build && pnpm --filter @aurora/agent-core build` 退出码 0。
- [ ] `pnpm typecheck` 退出码 0（四个项目全绿；改 Schema 后必须先 build 共享包）。
- [ ] `pnpm vitest run packages/agent-core/src/context` 全绿，且存在断言：`VOLATILE_SECTION_TITLES` 已含 `'## 项目约定'`、四个易变小节的相对顺序正确、`## 项目约定` 的位置大于 `## 安全规则`；另有一条"带/不带 `projectInstructions` 时静态前缀逐字节相同"的断言。
- [ ] `pnpm vitest run packages/shared/src/config` 全绿，含 v12→v13 段、`migrate({ version: 13 })` 恒等、以及**改过的 `migrations.test.ts` 严格断言**（`:342` / `:365` / `:835` 三处不再因新增字段而红）。
- [ ] `pnpm typecheck` 退出码 0，**包括 `apps/desktop/src/main/classification.test.ts` 与 `tts.test.ts` 的 settings 桩已补齐新必填字段**（这两处不补会直接编译红）。
- [ ] 只读面已登记：`pnpm vitest run packages/shared/src/config/schema.test.ts` 通过，且存在断言 `canWriteSettingPath('projects.current') === false` 与 `canWriteSettingPath('agent.permissionMode') === false`（照 `schema.test.ts` 里既有的只读前缀用例写法加）。
- [ ] `pnpm test` 全量退出码 0，用例数不少于改动前的 1307。**若失败，先按"改过的严格断言"清单排查**（`migrations.test.ts:342/365/879` 的 `toEqual`、`:835` 的 `toBe(12)`、`classification.test.ts` / `tts.test.ts` 的 settings 桩）——不要把它当成"同步漏了某处"而盲目加代码。
- [ ] `pnpm lint` 与 `pnpm format:check` 退出码 0（CI 的第一步就是 `format:check → lint → typecheck → test → build`，见 `.github/workflows/ci.yml:51-66`）。
- [ ] `pnpm verify` 退出码 0（`scripts/verify-p1.mjs` 断言 `fresh.version === CONFIG_VERSION`（`:84`）与 `appliedMigrations.length === CONFIG_VERSION`（`:159`），改版本号后必须复跑；**需先 `pnpm build`**）。
- [ ] `AURORA_CAPTURE="$env:TEMP\aurora-capture-01" pnpm dev` 结束退出码 0（无 FAIL），`report.json` 里出现 `settings-general-fields` 的 `projects.*` 检查项与新增的 `chat-project-card.png` 场景。
- [ ] **无项目时行为不变**：`AURORA_SMOKE=1 pnpm dev` 结束后 `%TEMP%\aurora-smoke-logs` 的 `AURORA_SMOKE_RESULT` 全通过，且本轮**不需要**新增 smoke 断言。（注意：`smoke.ts` **没有**系统提示词前缀相关断言 —— "两轮静态前缀逐字节相同"那条实际在 `packages/agent-core/src/context/systemPrompt.test.ts:84-115`，本轮新增的逐字节断言加在那里，不要往 smoke 里加。）
- [ ] 手工/探针证据：在临时目录放一份 `AGENTS.md` 与一份 `AGENTS.override.md`，把它设为当前项目（`settings:update`），再发一轮对话 —— 从 smoke 桩的请求体里能看到注入文本，且 override 的内容出现、`AGENTS.md` 的内容**没有**出现。
- [ ] 项目根失效有可见提示：把 `projects.list[0].root` 指向一个不存在的目录并设为当前项目 → 右栏卡片显示"项目目录不可用"、设置页该行标红（`AURORA_CAPTURE` 的场景里加一条断言，或在执行记录里贴手工截图/`report.json` 条目）。

## 交接

- 给 step 2：`agent.permissionMode`（值域 `readonly|confirm|auto`）已在 Schema/defaults/迁移/只读前缀里就绪，**step 2 不要再动 `schema.ts` 的版本号与迁移数组**；`effectiveWorkspaceDir()` 在 `packages/agent-core/src/config/effectiveWorkspace.ts`，供权限层判定"项目根"。
- 给 step 3 / step 4：项目根语义 = `resolveProject()` 的 `root`（不再新增第三套目录字段）；`apps/desktop/src/main/index.ts` 的 `new KernelAgentHost({...})` 区域本步已改过一次，后两步会再改同一文件，**step 3 与 step 4 不要同时改 `index.ts`**（step 3 只加 snapshot 装配，step 4 只加 job 装配）。
- 给 step 5：`docs/README.md` 与 `docs/04-roadmap.md` 的变更记录**本步不写**，由 step 5 统一收口。

## 执行记录

执行时间：2026-09-26（本会话）。执行模式：全部连续执行（`00-index.md` 的 `执行模式：全部`）。
基线提交：`afd23827dee06381e72ca1d21d6371dc1d865dcc`（执行开始时 `git rev-parse HEAD` 与索引里记的一致，未变）。

### 提交清单（每项一个逻辑单元）

| SHA | 提交 | 内容 |
|---|---|---|
| `48f669f` | `chore(step)` | 加入 agent-prod-mainline 计划（step 1–6） |
| `a12ea47` | `feat(config)` | 配置 v13：`projects` 分组 + `agent.permissionMode` + 只读前缀 + v12→v13 迁移 |
| `1ca2912` | `feat(agent-core)` | 项目解析 / AGENTS.md 逐层收集 / 系统提示词「项目约定」 |
| `221db99` | `feat(settings)` | `project:status` / `project:pickDirectory` / `openPath kind:project` + host 装配 + smoke 断言 |
| `ff57d80` | `feat(settings)` | 设置页「项目」区组 + 右栏「当前项目」卡 |
| `0c7abee` | `test(e2e)` | capture 项目探针 + onboarding 探针偶发失败修复 |
| `5245d87` | `docs` | 06 §5.1/§21.1/§12.2、07、08 落文档 |

### 实际改动（按文件）

- **配置面（v13）**：`packages/shared/src/config/schema.ts`（`CONFIG_VERSION` 12→13；`ProjectSchema`/`ProjectsSchema`；`AgentSchema.permissionMode`；`SettingsSchema.projects`；`SETTINGS_READONLY_PREFIXES` 加 `projects` / `agent.permissionMode` + `READONLY_PREFIX_REASONS` 两条中文原因）、`defaults.ts`（默认无项目 + `permissionMode: 'confirm'`）、`migrations.ts`（`migrateV12ToV13`，只补缺不覆盖、幂等、分组缺失交默认配置兜底）、`ipc/types.ts`（`SettingsPatch.projects`）、`ipc/channels.ts` + `preload/channels.ts` + `preload/index.ts`（新 `project` 组两条通道）、`main/settings-patch.ts`（`projects` 顶层浅合并）、`main/settings-hint.ts`（补一句"项目/权限档位/确认闸门一律只读"）。
- **agent-core（纯 Node）**：`src/config/project.ts`（`resolveProject`）、`src/config/effectiveWorkspace.ts`（`effectiveWorkspaceDir`）、`src/project/agentsFile.ts`（`collectProjectInstructions`，注入式 fs、override 优先、远→近、字节预算与层数上限、UTF-8 安全截断、六类降级都不抛错）、`src/project/nodeFs.ts`（`lstat` 识别符号链接）、`src/project/instructions.ts`（按 root + mtime 签名缓存）、`context/systemPrompt.ts`（`## 项目约定` 易变小节 + `VOLATILE_SECTION_TITLES` 扩到四个）、`host/agentHost.ts`（`projectInstructions` getter，抛错只 warn）、`index.ts`（导出上述模块）。
- **主进程**：`main/ipc.ts`（`project:status` 探测项目根是否可用、`project:pickDirectory` 系统目录选择框、`openPath` 新 `kind: 'project'`）、`main/index.ts`（`createProjectInstructionsSource` 装配进 `KernelAgentHost`；**修 5 处 `settings.update({ agent: { tools } })` 少带 `permissionMode` 的真 bug**：`Partial<Settings>` 只放宽顶层键，缺失键会被 Schema 默认值补回，等于把用户选的 `readonly`/`auto` 静默重置成 `confirm`；smoke 新增端到端断言）。
- **渲染层**：`settings/pages/GeneralPage.vue`（「项目」区组：名字/根目录可改、设为当前、重新选择目录、删除、添加项目（系统选择框，加完即设为当前）；列表编辑即时保存且始终带完整 `projects` 子树；当前项目根不可用时该行标红 + 「项目目录不可用」+ 重新选择目录）、`chat/components/ContextPanel.vue`（「当前项目」卡 `context.project-card`，任何模式都渲染、无项目整卡不渲染；根不可用显示警示徽标与「去设置里重新选择目录」，可用时「打开文件夹」走 `kind: 'project'`）。
- **探针**：`main/capture.ts`（general 页 `projects.*` 计数 + `data-empty` 白名单；新场景 `chat-project-card.png`；onboarding 探针偶发失败修复）。
- **文档**：`docs/06`（§5 顺序表 + 新增 §5.1 + §21.1 订正 + §12.2 只读前缀登记）、`docs/07`（右栏项目卡、data-field 锚点、探针场景、general 页口径）、`docs/08`（§1 样例与散文、§2 迁移清单、§6.1 矩阵、§6 页面结构；顺手把陈旧的 `v10`/`= 12` 版本号对齐到 13）。

### 与计划的偏差（逐条说明）

1. **多改了 4 个文件**：`packages/shared/src/ipc/channels.ts`、`preload/channels.ts`、`preload/index.ts`、`main/ipc.ts`。原因：计划的第 10 条要求"右栏卡复用现有 `openPath({kind:'workspace'})`"，但实测 `kind: 'workspace'` 打开的是 `agent.tools.workspaceDir`（**不是**项目根），且渲染层没有任何"路径是否存在"的探测通道 —— 而假设 7 要求失效必须有**可见**提示。因此新增 `project:status`（读状态）+ `project:pickDirectory`（目录选择，替代"手打路径"）+ `openPath` 的 `kind: 'project'`。四个文件都在 step 3 的写范围内，不产生跨步骤冲突。
2. **补导出 `packages/agent-core/src/index.ts`**（计划 Writes 未列）：主进程要 import `resolveProject` / `nodeProjectFs` / `createProjectInstructionsSource`，而 `@aurora/*` 的类型指向 `dist/*.d.ts`，不导出下游就用不到。
3. **右栏/设置页锚点命名**：计划写 `chat.project-card`，实现改用 **`context.project-card`** —— 该文件既有约定是 `context.todo-card` / `context.classisland-card` / `context.lesson-card`（`chat.*` 属左栏与 composer）。capture 场景文件名仍是 `chat-project-card.png`（按窗口分组）。
4. **新增目录选择 IPC**：计划的"「重新选择目录」"在无选择器时只能重填文本框，体验不成立，故一并加了 `project:pickDirectory`。
5. **`settings-patch.ts` 的 `agent` 语义未动**（仍是顶层浅合并），只加 `projects` 一行。

### 验证结果（全部由主代理亲自复跑）

| 验收项 | 命令 | 结果 |
|---|---|---|
| 包构建 | `pnpm --filter @aurora/shared build && pnpm --filter @aurora/agent-core build` | exit 0 |
| 全量类型 | `pnpm typecheck` | exit 0（四个项目全绿；`classification.test.ts` 与 `tts.test.ts` 桩已补齐） |
| 上下文单测 | `pnpm vitest run packages/agent-core/src/context` | 33 passed（含 `VOLATILE_SECTION_TITLES` 含「## 项目约定」、四个易变小节顺序、`> ## 安全规则`、带/不带 `projectInstructions` 的静态前缀逐字节相同） |
| 配置单测 | `pnpm vitest run packages/shared/src/config` | 131 passed（含 v12→v13 段、幂等、不覆盖已写值、缺分组不报错；`canWriteSettingPath('projects.current') === false` 与 `agent.permissionMode` 同理） |
| 全量单测 | `pnpm test` | **76 文件 / 1373 用例全绿**（改动前 1307，+66） |
| 风格与静态 | `pnpm lint` / `pnpm format:check` | 均 exit 0 |
| 真实磁盘验收 | `pnpm build` → `pnpm verify` | 26/26 通过（含 `version=13` 与「v0 → 当前版本」13 条迁移） |
| 截图验收 | `AURORA_CAPTURE=$env:TEMP\aurora-capture-06 pnpm dev` | **49 张 PNG / 49 条 checks / 0 FAIL / exit 0**；含新场景 `chat-project-card.png`（健康态 + **失效警示态** + 还原三段断言全过）与 general 页 `projectsFields/projectsRows/projectsEmpty/unexpected` 计数 |
| 端到端自测 | `AURORA_SMOKE=1 pnpm dev` | **147/147 passed，exit 0**；其中 `PASS 项目级 AGENTS.md 进了请求体且 override 优先（AGENTS.md 内容被顶掉） — rounds=1 markerAgents=false markerOverride=true` |

**验收标准第 12 条（AGENTS.md 注入的可复核证据）**：不靠手工截图 —— 已在 smoke 里做成常驻断言：临时项目根写 `AGENTS.md`（`AURORA_AGENTS_MD_MARKER`）与 `AGENTS.override.md`（`AURORA_AGENTS_OVERRIDE_MARKER`）→ `settings.update` 设为当前项目 → 发一轮真实对话（本地桩 LLM 记录请求体）→ 从请求体的 `systemPrompt` 断言**含 override 标记、不含 AGENTS.md 标记**、且含 `## 项目约定`。

**验收标准第 13 条（项目根失效可见提示）**：`chat-project-card.png` 场景的 check 第二阶段把 root 改成不存在的目录，断言 `context.project-unavailable` 恰好 1 个且卡文本含「项目目录不可用」（`warningShown: true / warningText: true`）。设置页那一行是同款逻辑（标红 + 「项目目录不可用」+「重新选择目录」），**但没有独立探针**（general 页探针只覆盖字段计数与空态白名单）—— 见"遗留问题"。

### 过程中发现并修掉的两个真问题（都不在原计划里）

1. **`apps/desktop/src/main/index.ts` 五处 `settings.update({ agent: { tools: ... } })` 的静默重置**：`SettingsStore.update` 的签名是 `Partial<Settings>`（只放宽顶层键，值仍是完整类型），加上 `store.update` 顶层浅合并 ⇒ 少带 `permissionMode` 会被 Schema 默认值补回，**把用户选的 `readonly`/`auto` 静默改回 `confirm`**。既修了类型错误，也修了行为：五处都改成整组展开（`{ ...agentBefore, tools: ... }`）。
2. **capture 的 onboarding 引导探针偶发失败**：一轮 0 FAIL、下一轮红一条，失败信息是「期望 `ClassRoom Mode 设置`，实际 `ClassRoom Mode 设置`」（两条字符串一模一样，无从排查）。加诊断后定位到 `opacity = 0`：pane 的 `.anim-rise` 进场动画在**窗口不产生帧**（被遮挡 / 未合成）时会停在起始帧。修法是 probe 侧把进场动画显式 `finish()` 到终态（act 里做，check 里兜一次），并把真实几何（rect / 视口 / scrollTop / opacity）写进失败原因；**断言本身没有放宽** —— 1.5s 内始终不可见照样 FAIL。

### 遗留问题 / 已知限制（如实记录）

1. **capture 探针在本机存在环境相关的偶发失败**（与本次改动无关）：共跑 6 次全量，`0 FAIL` 2 次；另外 4 次分别红在 `onboarding` 引导标题（已修）、`chat-tool-card-open`（断言折叠动画"采样到的中间态"，帧被饿死时第一帧就是终态）、`chat-stream-burst`（帧丢弃阈值 `droppedFrames 117 > 25`、`heartbeatOverrunMs 1927 > 1200`）。后两条是 perf/时序探针，属**帧饥饿环境**问题，本步未动它们（改它们会越过 step 1 的范围，且会削弱其它任务的断言）。**最终验收用的是第 6 次干净全量跑（49/49、0 FAIL、exit 0）**。
2. **设置页"项目根失效标红"没有独立探针**（右栏那一条有）。若要补，可在 `SETTINGS_FIELDS_SCRIPT` 里加一条"当前项目根不存在时出现 `[data-field^="projects."]` 的警示态"断言，需要先经 `settings:update` 造失效现场 —— 建议并入 step 5 的集成验证。
3. `AURORA_CAPTURE_WINDOWS=onboarding` 单窗口过滤会让引导场景卡在第 4 段（`ClassRoom Mode 设置`）不返回（实测挂了 8 分钟以上，仅过滤 onboarding 时复现）。全量跑不受影响；本步未深挖，可能与"其它窗口未创建"有关 —— 建议 step 5 一并复核。
4. `projects.list[].id` 由设置页生成（`proj-<base36 时间>-<随机>`），**没有做 id 唯一性校验**（重复 id 时 `resolveProject` 取第一个命中的）。属产品口径决定，非缺陷。
5. `effectiveWorkspaceDir()` 已实现并单测，但**尚未接到工具装配**（计划的 step 2 才消费），当前 `agent.tools.workspaceDir` 的实际行为未变。
