# Step 01 — 契约与配置基线（docs 先行 + Schema v5 + 迁移）

- Task: computer-control
- Step: 1 / 7
- Status: done
- Depends on: none
- Produces: `docs/06 §11`、`docs/08 §1/§2/§6.1`、`packages/shared/src/config/{schema,defaults,migrations}.ts`（CONFIG_VERSION = 5）与对应单测

## 目标

在本任务动任何实现代码之前，把两件事钉死：**配置字段长什么样**、**工具的能力与安全边界是什么**。
本步只产出 Schema / 默认值 / 迁移 / 文档与单测，不写任何工具实现。

## 输入

- `AGENTS.md`（架构硬约束、配置改动必须走迁移链）
- `docs/08-settings-onboarding.md` §1（当前 Schema 示例，v4）、§2（迁移链说明）、§6.1（门控矩阵）
- `docs/06-agent-core.md` §5（工具循环与敏感工具确认）、§10（安全）
- `packages/shared/src/config/schema.ts`、`defaults.ts`、`migrations.ts`
- `packages/shared/src/config/schema.test.ts`、`migrations.test.ts`、`store.test.ts`

## 操作

### 1. 更新文档（先文档后代码）

1. `docs/08-settings-onboarding.md`：
   - §1 标题改为「配置 Schema（config.json，v5）」，`"version": 4` → `5`；
   - `llm.providers.<id>` 示例里 `"temperature": 0.7` 后加一行
     `"reasoningEffort": "auto"  // auto | low | medium | high；auto = 不下发该参数`；
   - 顶层新增 `agent` 块（放在 `advanced` 之前或之后均可，但全文只出现一次）：
     ```jsonc
     "agent": {
       "tools": {
         "enabled": true,          // 电脑操控工具总开关；false 时 5 个工具都不注册
         "workspaceDir": "",       // 工具默认工作目录；空串 = 用户主目录
         "terminal": { "enabled": true, "timeoutMs": 60000, "maxOutputChars": 8000 },
         "files": { "enabled": true, "maxReadBytes": 262144 },
         "open": { "enabled": true }
       }
     }
     ```
   - 字段说明段补两条：`reasoningEffort` 语义（`auto` 表示不带 `reasoning_effort` 字段，
     兼容不认该参数的厂商）；`agent.tools.*` 的 4 个开关与 3 个上限各管什么。
2. `docs/08-settings-onboarding.md` §2 迁移段：当前版本改 `CONFIG_VERSION = 5`，追加
   「`v4 → v5`（补齐 `llm.providers.*.reasoningEffort` 与 `agent.tools.*`）」，
   并保持「五条迁移都幂等且不覆盖用户已写入的值」这句话成立。
3. `docs/08-settings-onboarding.md` §6 补一小节说明新增的「电脑操控」设置页（位置：
   侧栏「AI 能力」组第三项之后）；§6.1 门控矩阵追加两行：
   | `agent.tools.enabled` | 常显（否则无法重新启用） |
   | `agent.tools.terminal.*` / `files.*` / `open.enabled` | `agent.tools.enabled === true` |
4. `docs/06-agent-core.md` 新增 `## 11. 电脑操控工具（v0.7.0）`，至少写清：
   - 工具表（名称 / 参数 / 敏感级 / 实现文件）：
     | 工具 | 参数 | sensitivity |
     |---|---|---|
     | `run_command` | `{ command, cwd?, timeoutMs? }` | confirm |
     | `read_file` | `{ path, maxBytes? }` | safe |
     | `write_file` | `{ path, content, mode?: 'overwrite' \| 'append' }` | confirm |
     | `list_dir` | `{ path, limit? }` | safe |
     | `open_path` | `{ target }` | confirm |
   - 安全边界：逐次确认（走 §5 的 `confirmTool`，超时/勿扰一律按拒绝）、`agent.tools.enabled` 总开关、
     `agent.tools.workspaceDir` 只作为**默认** cwd 而非沙箱（越界不静默：结果里回带绝对路径）、
     输出上限 head 60% + tail 40% 截断、超时后按进程树终止（`taskkill /T /F`）、
     UTF-8 输出约定、**不做命令黑名单**（黑名单必然漏，安全靠确认 + 上限 + 总开关）。
   - `advanced.confirmSensitiveTools = false` 时的语义（沿用既有：直接放行），并明确写出
     「此时命令将不经确认执行」这一后果。
   - 非目标：鼠标键盘模拟、截图录屏、持久交互式 shell、命令黑名单。
   - §3 LLM 提供者小节补一句：`ChatRequest.reasoningEffort` 由 `llm.providers.<id>.reasoningEffort`
     驱动，`auto` 不下发。
5. `docs/07-ui-spec.md` §2.5：侧栏条目从 6 项改为 7 项（「AI 能力」组多一项「电脑操控」）。
   （§5.3 的截图数量改动留到 step 5，因为要等 capture 计划真的变了。）

### 2. 改 Schema

`packages/shared/src/config/schema.ts`：

1. `export const CONFIG_VERSION = 5 as const`。
2. 新增：
   ```ts
   /** 模型思考等级（docs/06 §3）：auto = 不下发 reasoning_effort 字段 */
   export const REASONING_EFFORT_LEVELS = ['auto', 'low', 'medium', 'high'] as const
   export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number]
   export const ReasoningEffortSchema = z.enum(REASONING_EFFORT_LEVELS)
   ```
3. `LlmProviderSchema` 增加 `reasoningEffort: ReasoningEffortSchema`。
4. 新增 `AgentToolsSchema` / `AgentSchema`，并把 `agent: AgentSchema` 加进 `SettingsSchema`
   （字段名与顺序：`version, general, llm, modes, skills, mcp, advanced, agent`）。
   约束：`workspaceDir: z.string()`；`terminal.timeoutMs: z.number().int().min(1000).max(300_000)`；
   `terminal.maxOutputChars: z.number().int().min(500).max(100_000)`；
   `files.maxReadBytes: z.number().int().min(1024).max(4_194_304)`；各 `enabled: z.boolean()`。
5. 新增 `export const COMPUTER_TOOL_NAMES = ['run_command','read_file','write_file','list_dir','open_path'] as const`
   （供设置页静态展示与 smoke 断言共用，避免两处各写一份字符串）。

`packages/shared/src/config/defaults.ts`：新增 `DEFAULT_AGENT_TOOLS`，并在 `DEFAULT_TOOLCHAIN_CONFIG`
里加 `agent: { tools: { ...DEFAULT_AGENT_TOOLS } }`；`DEFAULT_TOOLCHAIN_CONFIG.version` 会跟随
`CONFIG_VERSION`（已引用常量，无需手改）。

### 3. 加迁移（幂等、不覆盖用户值）

`packages/shared/src/config/migrations.ts` 追加 `migrateV4ToV5`：

- `llm.providers` 每个 provider 若 `reasoningEffort` 不是合法枚举值 → 写 `'auto'`；
- 顶层缺 `agent`（或 `agent.tools` 子块缺字段）→ 用默认值补齐；
- **已存在的合法值一律保留**；`version = 5`。
- `MIGRATIONS` 数组追加该项（永不修改历史条目）。

### 4. 补单测

- `packages/shared/src/config/schema.test.ts`：
  - `fieldAccepts('llm.providers.deepseek.reasoningEffort', 'high') === true`
    / `'ultra'` 与 `42` 为 false；
  - `fieldAccepts('agent.tools.terminal.timeoutMs', 60_000) === true` / `'x'` 为 false；
  - 越界拒绝：`agent.tools.terminal.timeoutMs = 999` 与 `400000` 被 Schema 拒绝。
- `packages/shared/src/config/migrations.test.ts`：
  - 一个**完整的 v4 配置**（含自定义 provider 与用户改过的 advanced 值）迁移到 v5 后：
    provider 的其它字段与 advanced 原样保留、`reasoningEffort === 'auto'`、`agent.tools` 为默认值；
  - **幂等**：对已迁移结果再跑一次 `migrate`，结果与第一次一致；
  - 用户已写 `reasoningEffort: 'high'` 时迁移**不覆盖**。
- `packages/shared/src/config/store.test.ts`：若其中断言了默认配置对象 / 字段路径数量，同步更新
  （新字段必须出现在默认值里，这是既有测试的既有责任）。

## 验收标准

- [x] `pnpm vitest run packages/shared` 全绿（含上面新增断言）—— 5 文件 / 80 用例全过
- [x] `pnpm typecheck` 通过
- [x] `pnpm build:packages` 通过
- [x] 字段在新配置链路三处都落地：`grep -n "reasoningEffort" packages/shared/src/config/schema.ts` 与
      `migrations.ts` 命中，`defaults.ts` 命中其常量形式 `DEFAULT_REASONING_EFFORT`
      （原计划写的是小写 `reasoningEffort` 在 defaults 命中 —— 实测不成立，已按实际写法记录）
- [x] `grep -n "CONFIG_VERSION = 5" packages/shared/src/config/schema.ts` 命中
- [x] `docs/08-settings-onboarding.md` 中 `"version": 5` 与迁移链里 `v4 → v5` 都在；`docs/06-agent-core.md`
      存在 `## 11.` 小节且包含 `run_command`

## 交接

- 配置路径清单（后续步骤直接引用，不要改名）：
  `llm.providers.<id>.reasoningEffort`、`agent.tools.enabled`、`agent.tools.workspaceDir`、
  `agent.tools.terminal.{enabled,timeoutMs,maxOutputChars}`、`agent.tools.files.{enabled,maxReadBytes}`、
  `agent.tools.open.enabled`。
- 工具名常量在 `@aurora/shared` 的 `COMPUTER_TOOL_NAMES`（`browser.ts` 转出的 `config/schema.js`
  会自动带上，渲染层可直接 import）。
- 若发现既有测试依赖「settings 只有 7 个顶层键」这类硬编码，按新 Schema 更新，不要放宽断言。

## 执行记录

**状态：done（2026-09-20）**

### 子代理分片

| 分片 | 负责 | 结果 |
|---|---|---|
| docs/06 | `docs/06-agent-core.md`（新增 §11 + §3 一句） | 完成：§11 落在 L180 起，1–11 编号连续；工具表 5 行逐字落地；prettier `--check` 通过 |
| docs/08 | `docs/08-settings-onboarding.md`（§1 v5 / §2 迁移 / §6 / §6.1） | 完成：+40/−6；顶层键顺序 `version,general,llm,modes,skills,mcp,advanced,agent`（全文 `"agent"` 只出现 1 次）；原文「四条迁移」已改为「五条」 |
| 主代理 | `schema.ts` / `defaults.ts` / `migrations.ts` + 三个单测 + 调用点适配 + `docs/07 §2.5` | 完成（见下） |

### 实际改动

- `packages/shared/src/config/schema.ts`：`CONFIG_VERSION = 5`；`REASONING_EFFORT_LEVELS` /
  `ReasoningEffortSchema`；`LlmProviderSchema.reasoningEffort`（必填）；`AgentToolsSchema` /
  `AgentSchema` + `SettingsSchema.agent`；`COMPUTER_TOOL_NAMES`。
- **计划外的必要改动**：`fieldAccepts` 补枚举值校验。计划里 `fieldAccepts(..., 'ultra') === false`
  这条断言在原实现下不可能成立 —— 枚举路径在 `walk()` 里按 `'any'`（接受任意类型）登记，
  非法枚举值会活到 `SettingsSchema.parse` 把**整份配置**判为损坏并重建默认，而不是只回退该字段。
  现在 `walk()` 额外收集 `z.enum` 的合法值表（`enumPaths`），`fieldAccepts` 对枚举路径按值判定。
  这同时修正了 `modes.current` / `advanced.logLevel` 等既有枚举字段的同类问题。
- `defaults.ts`：`DEFAULT_AGENT_TOOLS`、`DEFAULT_REASONING_EFFORT`（计划要求 grep 在 defaults 命中，
  用常量代替各处硬编码 `'auto'`）。
- `migrations.ts`：`migrateV4ToV5` + `MIGRATIONS` 追加（历史条目未改）；没有 `llm.providers` 时
  不凭空造该键（否则会破坏既有单测「v0 的空 apiKey 不生成 provider」的语义）。
- 调用点适配（`reasoningEffort` 必填后 typecheck 才能过）：`LlmPage.vue`、`onboarding/App.vue`、
  `apps/desktop/src/main/index.ts`（smoke 桩配置）、`scripts/verify-p1.mjs`、`classification.test.ts` 夹具；
  `apps/desktop/src/main/smoke.ts` 的 `settings.get.version` 由 4 改 5。
- 文档：`docs/07 §2.5` 侧栏 6 项 → 7 项。

### 验证命令与结果（主代理实跑）

- `pnpm vitest run packages/shared` → 5 文件 / 80 用例全过（改前 598 → 全仓 608）
- `pnpm test` → 43 文件 / 608 用例全过
- `pnpm typecheck` → exit 0（先 `pnpm build:packages`，否则 desktop 读的是旧 `dist/*.d.ts`）
- `pnpm build:packages` → exit 0
- `pnpm lint` → exit 0；`pnpm exec prettier --check <改动文件>` → 通过（migrations.test.ts 由 prettier 回写）
- `Select-String packages\shared\src\config\{schema,defaults,migrations}.ts -Pattern reasoningEffort` → 三处均命中

### 提交

- `b049b65` docs: 先行补齐思考等级与电脑操控工具规格（06 §11 / 08 v5 / 07 侧栏）
- `07b5455` feat(v0.7.0): 配置 Schema v5（思考等级枚举 + 电脑操控工具配置 + v4→v5 迁移）

### 遗留

- `apps/desktop/src/main/smoke.ts` 里注入的 JS 与 `scripts/verify-p1.mjs` 不参与 typecheck，
  已手工补字段；smoke 与 `pnpm verify` 的真实运行留到 step 5/6。
- `docs/06 §11` 引用的 `command-runner.ts` / `file-port.ts` / `open-port.ts` 尚不存在（目标态描述），
  step 3/4 落地时需保证文件名与之一致。
