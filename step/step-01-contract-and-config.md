# Step 01 — 工具契约与提示词基线（docs 先行）+ 配置 Schema v12

- Task: opencode-parity
- Step: 1 / 7
- Status: done
- Depends on: none
- Produces: `docs/06` 的 §5 顺序表 + §11 工具表 + §11.5/§11.6/§11.7/§20/§21 五个新小节；`docs/07` / `docs/08` 的字段与门控同步；`packages/shared` 的 Schema v12 + 迁移 + 单测
- Phase: 基础与配置
- Writes: `docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`packages/shared/src/config/schema.ts`、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/store.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/agent-core/src/tools/files.test.ts`、`apps/desktop/src/main/tools/index.test.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`（只改 `TOOL_GATES` 与两处计数文案）
- Risk: 这是**唯一**把规格写进 SSOT 的步骤，写错会被后面五步原样实现。两个具体风险：① 新字段是**必填**（现有 `AgentToolsSchema` 不用 `.default()`，默认值来自 `defaults.ts`），漏改某个配置构造点会让 `pnpm typecheck` 失败——这是好事，按报错逐个改即可，**不要**用 `as` 断言或 `?` 绕过；② `READONLY_PREFIX_REASONS` 是 `SETTINGS_READONLY_PREFIXES` 元组的 `Record`，加前缀必须同时加原因，漏加即编译失败。
- Sources: opencode `packages/opencode/src/tool/{read,edit,grep,glob,skill,task,todowrite}.txt`，仓库 `sst/opencode` 分支 `dev` commit `adee738`，MIT License，访问日期 2026-09-26

## 目标

后续五步要用到的**全部规格**先落进 `docs/`（仓库的单一事实来源），
并把三个新工具与免确认模式需要的配置面（`agent.tools.search.*`、`agent.tools.terminal.allowPatterns`）
连同迁移链一起就位——这样步骤 2–6 只写代码，`pnpm typecheck` 已经是绿的。

## 输入

- `docs/README.md`（文档索引与"docs 是 SSOT"的定位）
- `docs/06-agent-core.md` 现有 §5（系统提示词小节顺序 + `buildToolGuidance` 条件条目）、
  §11（电脑操控工具表 / 开关 / 安全边界）、§12.2（可写面三道闸门）、§19（最大节号，新节从 §20 起）
- `packages/shared/src/config/schema.ts`：`CONFIG_VERSION`（`:9`，当前 `11`）、
  `COMPUTER_TOOL_NAMES`（`:421`，当前 5 个）、`AgentToolsSchema`（`:435` 起）、
  `SETTINGS_READONLY_PREFIXES` / `READONLY_PREFIX_REASONS` / `WRITABLE_PATH_OVERRIDES`（`:477` 起）
- `packages/shared/src/config/defaults.ts`：`DEFAULT_AGENT_TOOLS`（`:150`）
- `packages/shared/src/config/migrations.ts`：`migrateV9ToV10`（`:392`）与 `migrateV10ToV11`（`:423`）
  的写法与 `fillMissing` 助手；`MIGRATIONS` 数组注册处
- `packages/shared/src/config/schema.test.ts:186`（`COMPUTER_TOOL_NAMES` 的精确数组断言）
- `apps/desktop/src/main/settings-hint.ts`（`SETTINGS_HINT` 常量）
- `docs/08-settings-onboarding.md`：§1 的 JSON 示例（约 `:140`）与字段说明（约 `:259`）、
  迁移链列表（约 `:312`）、§6 设置页说明（约 `:456` / `:534` / `:552`）
- 下列 opencode 提示词原文（本步要逐条翻译成 Aurora 口径并写进 `docs/06 §20`）：
  - `read.txt`：`filePath` 用绝对路径；默认返回**开头 2000 行**；`offset` 是**1 起始**的行号；
    内容以 `<行号>: <内容>` 前缀返回（例：文件内容 `foo\n` → 返回 `1: foo\n`）；
    目录按一行一条返回（子目录带尾 `/`，无行号）；**单行超 2000 字符截断**；
    建议并行读多个文件；不要切成 30 行的小片段、要看更大的窗口；不确定路径先用 `glob`；
    大文件用 `grep` 定位。
  - `edit.txt`：**改前必须在本会话 Read 过该文件，否则工具报错**；`oldString` 必须与 Read 输出
    **去掉行号前缀之后**的内容逐字一致（保留缩进）；`oldString` 找不到 → 报错
    `oldString not found in content`；命中**多处** → 报错并要求补足上下文或改用 `replaceAll`；
    `replaceAll` 用于全局改名。
  - `grep.txt`：正则内容检索，不限仓库规模；`include` 支持 `*.js`、`*.{ts,tsx}` 这类过滤；
    返回**文件路径 + 行号 + 命中行**；需要计数或更复杂统计时改用 `Bash` + `rg`。
  - `glob.txt`：按文件名模式匹配（`**/*.js`、`src/**/*.ts`），只返回文件路径。
  - `todowrite.txt` / `task.txt`：见 §20 的对照表（本步只登记结论，不改这两个工具的既有实现——
    Aurora 的 `todo_write` 是**整表替换**、`task` 子代理**不可递归**，与 opencode 的差异要点写明"不采纳"及理由）。
- `AGENTS.md` 的「文档先行」「改了 shared 必须先 `pnpm --filter @aurora/shared build`」两条

## 操作

### 1. `docs/06-agent-core.md`

**(a) §5 的小节顺序表：改为"静态在前、易变在后"**，并写明这是缓存稳定化要求。
新顺序固定为：
基础人设 → 当前模式 → 可用 Skill 清单 → 可用工具清单 → 工具使用规范 →
Agent 可修改的设置 → 安全规则 → **更早对话的摘要** → **当前任务清单** → **系统状态（感知摘要）**。
同时把 §5 里 `buildToolGuidance` 的条件条目清单补两条：
注册了 `edit_file` 才追加「改文件前必须先 `read_file`、`oldString` 要带足上下文保证唯一」；
注册了 `grep` / `glob` 才追加「找代码先用 `grep` / `glob` 定位，不要用 `list_dir` 逐层翻目录」。

**(b) §11 工具表**：`COMPUTER_TOOL_NAMES` 由 5 个扩到 **8 个**，新增
`edit_file`（`sensitivity: confirm`，与 `write_file` 同族）、`grep`（`safe`）、`glob`（`safe`）。
把 §11 的"5 个工具"计数改成 8，并写清开关分派：
`agent.tools.enabled` 是总开关；`agent.tools.terminal.enabled` → `run_command`；
`agent.tools.files.enabled` → `read_file` / `write_file` / `edit_file` / `list_dir`；
`agent.tools.search.enabled` → `grep` / `glob`；`agent.tools.open.enabled` → `open_path`。
（`EDIT_FILE` 不单独加开关，与 `write_file` 共用 `files.enabled`。）

**(c) 新增 §11.5 `grep` / `glob`：搜索层规格**
- 两个工具都走**自写的递归目录遍历**（不引入 ripgrep / fd 依赖；仓库既有"零新增依赖"约定见 §7）。
- 默认忽略目录常量（内核持有，可注入覆盖）：
  `node_modules` / `.git` / `dist` / `out` / `build` / `.next` / `coverage` / `.turbo`。
- 预算与上限：单文件超过阈值不扫（二进制按既有 NUL 探测跳过）、`maxResults` 截断并明确标注、
  遍历有**文件数与字节数双重预算**，超预算时返回已收集的结果并标注 `truncated`，
  **绝不无限遍历**；**不跟随符号链接**（防目录环导致死循环）。
- `grep` 结果格式：`<相对/绝对路径>:<行号>: <该行内容>`；**每行最多记一条**（一行内多次命中不重复计数）。
- `glob` 结果格式：每行一个匹配到的文件路径。
- 两者的 `path` 参数是搜索根，缺省用 `agent.tools.workspaceDir`（为空回落用户主目录）。

**(d) 新增 §11.6 `edit_file`：替换语义与保真**
- 参数 `{ path, oldString, newString, replaceAll? }`，`additionalProperties: false`。
- **改前必须先 `read_file` 过该文件**（同一会话内），否则返回 `isError` 并提示先读；
  守卫以**解析后的绝对路径**为键，防 `a/../b` 这类写法绕过。
- `oldString` **去找**：0 处 → `isError`，文案含「未找到」；多处且 `replaceAll !== true` →
  `isError`，文案含**出现次数**并要求补足上下文；`replaceAll === true` → 全部替换并回报次数。
- 空 `oldString` → `isError`（空串会匹配任意位置）；`oldString === newString` → `isError`（无意义改动）。
- **EOL 保真**：读写往返必须保持文件原有行尾。做法是"匹配前把文件与 `oldString` / `newString`
  统一归一为 `\n` 比较，写回前再按原文行尾还原"；原文含**孤立 `\r`**（非 `\r\n`）时**拒绝改动**
  并说明原因，宁可不改也不写坏。
- **整文件读取**：为做替换必须拿到完整内容，因此**不能用** `read_file` 的 `maxReadBytes` 截断读取；
  单文件上限是内核常量 `MAX_EDIT_BYTES = 1_048_576`（1 MiB），超过即 `isError` 并建议改用
  `run_command` 或分块 `write_file`。**截断后替换再写回 = 静默损坏文件，这是本步最必须堵死的路径。**
- 写入复用既有的原子写语义（`FilePort.writeText` 的 `overwrite`）。
- 结果回带解析后的绝对路径与替换次数。

**(e) 新增 §11.7 `run_command` 免确认模式列表**
- 新配置 `agent.tools.terminal.allowPatterns: string[]`（默认空数组 = 现状不变，全部逐次确认）。
- 匹配语义：**glob 全串匹配、大小写不敏感**，`*` 匹配任意字符（含空）、`?` 匹配单字符（与 §11.5 共用
  同一个模式编译器）。**全串锚定**意味着 `git *` 不会命中 `echo git`。
- 命中即**跳过确认卡片**，但**仍写审计日志**（含命令与被命中的模式），
  且与 `advanced.confirmSensitiveTools = false` 一样属于"减少打扰"而**不是安全加固**。
- 非法模式拒绝保存：空串 / 纯空白 / **不含任何字面字符**的模式（如 `*`、`**`、`?*`）
  —— 纯通配等于"全部放行"，等同于悄悄关掉确认闸门，必须在保存与匹配两处都拒绝。
- **该字段加入 `SETTINGS_READONLY_PREFIXES`**：AI 的 `set_setting` 一律拒绝读写它。
  理由写明："否则 AI 可以给自己加一条 `git*` 直接摘掉自己的确认闸门，属于自我提权"。

**(f) 新增 §20 工具使用契约（对齐 opencode）**
- 一张对照表，逐条列出上面「输入」里六个 `.txt` 的约定，每行四列：
  opencode 原文要点 / Aurora 的结论（**采用** / **改写** / **不采纳**）/ 落地位置 / 理由。
  必须覆盖：read 的行号前缀与 offset（采用，落到 §11 与 step 2）、edit 的读前置与唯一性（采用，step 4）、
  grep 的 `include` 与结果格式（采用，step 3）、glob 的模式语法（采用，step 3）、
  grep.txt 里"计数请改用 Bash + rg"（**不采纳**——Aurora 的 `run_command` 是 PowerShell 且逐次确认，
  没有 `rg` 可用，改为在 `grep` 的描述里不承诺计数能力）、
  read.txt 里"可读图片与 PDF 作为附件返回"（**不采纳**——Aurora 的 `read_file` 明确拒绝二进制，
  图片 OCR 未启用）。
- 一节"措辞规范"：Aurora 的工具 description 一律**中文**、先说"做什么"再说"什么时候用"与"注意什么"，
  与 opencode 的英文原文不逐字对应但**信息量对齐**。

**(g) 新增 §21 prompt caching：前缀稳定化与命中观测**
- 写明 `SystemPromptParts` 的字段集合不变，**只调整渲染顺序**（即 (a) 的新顺序），
  并解释理由：OpenAI 兼容网关的前缀缓存按**最长公共前缀**命中，
  易变小节（系统状态每轮都带时间与前台窗口）排在中间会让其后所有静态文本每轮重新计费。
- 写明第二处：`ToolRegistry.toLlmTools()` 改为**按工具名排序**返回，消除
  "设置变更 → 工具摘除重建 → `tools` 数组顺序变化 → 前缀失效"这条链路；
  系统提示词里的工具清单（`describeTools`）必须用**同一个有序列表**生成，否则两处顺序不一致。
- 写明**请求侧不需要改动**：`runAgentLoop` 的 `messages` 已是 `[system, ...history, user, extraContext]`，
  易变的 `extraContext` 已在尾部，`[system, ...history]` 天然是稳定前缀。
- 写明观测口径：`TokenUsage` 新增可选 `cachedTokens`，从
  `prompt_tokens_details.cached_tokens`（OpenAI 形态）或 `prompt_cache_hit_tokens`（DeepSeek 形态）
  解析；两者都缺 → `undefined`，**不拿其它数字冒充**；只在「上下文详解」条展示，不落盘。
- **明确不做**：不引入显式 `cache_control`（Anthropic 方言，部分网关会 400）；不加任何配置字段。

**(h) `docs/06` 顶部状态行与相关交叉引用同步**（§11 的"5 个工具"、各处计数）

### 2. `docs/08-settings-onboarding.md`

- §1 字段表新增三行并标注只读性：
  `agent.tools.search.enabled`（可写）、`agent.tools.search.maxResults`（可写）、
  `agent.tools.terminal.allowPatterns`（**只读，AI 改不动**，理由同 §11.7）；
  §1 的 JSON 示例同步补上这三个字段。
- §1 的迁移链列表追加 `v11 → v12`（补 `agent.tools.search.*` 与 `terminal.allowPatterns`）。
- §6 的「智能与工具」页说明补两处：终端卡片下的「免确认命令模式」列表、
  新增的「文件检索」栏（`agent.tools.search.*`）；并更新 §6 末尾的字段门控表——
  新字段的门控口径是 `agent.tools.enabled === true`。
- **两处容易漏掉的计数**（都在 `docs/08`）：§1 的 JSON 示例注释里那句
  「`enabled` 是电脑操控工具总开关；`false` 时 **5** 个工具都不注册」要改成 8；
  迁移链那一节里「十一条迁移都幂等」要改成**十二条**（加 v11 → v12）。

### 3. `docs/07-ui-spec.md`

- §5.3 的截图与探针清单：注明本轮预期新增/变化的探针条目
  （`settings-agent` 页新增字段计数、`chat.context-usage` 文案含缓存命中），
  并写明**张数与条目以 `report.json` 实际为准，执行后回填**。
- 对话窗 §2.3 的「上下文详解」条说明补一句：展示最近一轮的缓存命中 token 数。

### 4. `packages/shared/src/config/schema.ts`

```ts
export const CONFIG_VERSION = 12 as const

export const COMPUTER_TOOL_NAMES = [
  'run_command', 'read_file', 'write_file', 'edit_file', 'list_dir', 'open_path', 'grep', 'glob',
] as const
```

`AgentToolsSchema` 增补（**保持既有字段一个不改名**）：

```ts
terminal: z.object({
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  maxOutputChars: z.number().int().min(500).max(100_000),
  /** 命中即免确认的命令模式（glob 全串匹配、大小写不敏感）。空数组 = 全部逐次确认。 */
  allowPatterns: z.array(z.string().max(200)).max(100),
}),
search: z.object({
  enabled: z.boolean(),
  maxResults: z.number().int().min(1).max(1_000),
}),
```

- `SETTINGS_READONLY_PREFIXES` 追加 `'agent.tools.terminal.allowPatterns'`，
  并在 `READONLY_PREFIX_REASONS` 加对应中文原因（**不加会编译失败**）。
- `WRITABLE_PATH_OVERRIDES` 追加两条：
  `{ pattern: 'agent.tools.search.enabled', reason: '开关文件检索工具' }`、
  `{ pattern: 'agent.tools.search.maxResults', reason: '调整文件检索的结果上限' }`。
  **不要**给 `agent.tools.terminal.allowPatterns` 加条目——覆盖表判定先于黑名单，加了就等于放行。
- ⚠️ 一个容易误判的点：`advanced.readonlyPrefixes` 的默认值是**持久化**的（老用户的配置里存的是
  旧数组，不含新前缀）。这**不影响安全性**——`canWriteSettingPath()` 内部无条件再走一遍硬编码常量，
  用户配置项只能在默认之上**追加**限制。在该常量附近补一句注释说明，避免后人误以为漏了迁移。
- `allowPatterns` 的元素级 `refine`（拒绝"纯通配"这类等于全放行的模式）**本步不做**，
  由 step 5 连同 `describeInvalidPattern` 一起加——因为那条规则的中文原因与匹配器的实现必须同一口径，
  分开写会漂移。本步只加字段与只读前缀。

### 5. `packages/shared/src/config/defaults.ts`

`DEFAULT_AGENT_TOOLS` 补 `terminal.allowPatterns: []` 与 `search: { enabled: true, maxResults: 200 }`。

### 6. `packages/shared/src/config/migrations.ts`

照 `migrateV10ToV11` 的形状写（用 `fillMissing`，**只补缺不覆盖**，幂等；不做范围修正）：

```ts
const migrateV11ToV12: Migration = {
  from: 11,
  to: 12,
  describe: 'v11 → v12：为 agent.tools 补 search.* 与 terminal.allowPatterns（文件检索与免确认模式）',
  transform(raw) { /* 见下 */ },
}
```

`transform` 的要求：从 `raw.agent.tools` 取出 `terminal` 与 `files`，
`fillMissing(terminal, { allowPatterns: [] })`，`fillMissing(tools, { search: { enabled: true, maxResults: 200 } })`，
`agent.tools` 本身缺失时**不要凭空造半截对象**（交给默认配置兜底，与 v10 → v11 同款）；
最后 `next['version'] = 12`。把它注册进 `MIGRATIONS` 数组。

### 7. `packages/shared/src/config/schema.test.ts`

- 更新 `COMPUTER_TOOL_NAMES` 的精确数组断言（5 → 8，顺序照上面）。
- 新增断言：
  - `canWriteSettingPath('agent.tools.terminal.allowPatterns') === false`，
    且 `settingsReadonlyReason('agent.tools.terminal.allowPatterns')` 返回非空中文原因；
  - `canWriteSettingPath('agent.tools.search.enabled') === true` 与 `.maxResults` 同理；
  - `DEFAULT_TOOLCHAIN_CONFIG` 能被 `SettingsSchema.safeParse` 通过（新字段已进默认值）；
  - 迁移 v11 → v12：对一份**缺 `search` 与 `allowPatterns` 的 v11 配置**跑一次，
    断言补出正确默认值且 `version === 12`；**再跑一次**断言结果与第一次逐字段相同（幂等）；
    对一份**已写过** `allowPatterns: ['git status*']` 的配置跑，断言用户值原样保留（不被覆盖）。

### 8. `apps/desktop/src/main/settings-hint.ts`

把 `SETTINGS_HINT` 里的 `- agent.tools.enabled / workspaceDir / terminal.* / files.* / open.*`
改成**逐条列举**（`terminal.enabled / timeoutMs / maxOutputChars`、新增 `search.enabled / maxResults`），
**不要**继续用 `terminal.*` 通配写法——`terminal.*` 现在包含了只读的 `allowPatterns`，
会出现「说能改但不能改」的偏差，而这正是 §17 明确要避免的。

### 9. 配置调用点与既有断言的适配（**清单已核实，不是猜测**）

新字段是必填（`AgentToolsSchema` 不用 `.default()`，默认值来自 `defaults.ts`），
且 `COMPUTER_TOOL_NAMES` 从 5 个变 8 个。已核实会变红的是下面这几处，**逐处改**：

1. `packages/shared/src/config/schema.test.ts:186` 的 `COMPUTER_TOOL_NAMES` 精确数组断言（5 → 8）。
2. `packages/shared/src/config/schema.test.ts:193` 附近的 `toEqual` 精确对象断言（缺新字段即失败）。
3. `packages/shared/src/config/store.test.ts:172` 附近的 `toEqual` 精确对象断言
   （内含 `terminal: { enabled, timeoutMs, maxOutputChars }`，缺 `allowPatterns` 即失败）。
4. `packages/shared/src/config/migrations.test.ts:279` / `:340` / `:356` 附近：
   `v4 → v5` 的迁移用 `DEFAULT_AGENT_TOOLS` 补齐 `agent.tools`（`migrations.ts:178`），
   所以**迁移结果必然多出 `search` 与 `allowPatterns`**，这三处断言要同步。
5. `packages/agent-core/src/tools/files.test.ts:83` / `:90`：
   断言 `COMPUTER_TOOL_NAMES.filter(n => n !== 'run_command')` 等于 4 个文件工具名 ——
   新数组里多了 `edit_file` / `grep` / `glob`，这条要改成"过滤出**文件类**子集"的显式列表，
   **不要**改成"断言长度"（那会失去意义）。
6. `apps/desktop/src/main/tools/index.test.ts:106` / `:108` / `:109`：
   `expect(registry.sync()).toEqual([...COMPUTER_TOOL_NAMES])` ——
   注意 step 3 会把 `sync()` 的返回值改成"**实际注册成功的名字**"，
   而 `edit_file` / `grep` / `glob` 要到 step 3 / step 4 才真正被创建出来，
   所以**本步**这里应改成断言"当前配置下注册的名字集合"，不要写死 8 个。
7. `apps/desktop/src/renderer/settings/pages/AgentPage.vue:73`：
   ```ts
   const TOOL_GATES: Record<ComputerToolName, (t: AgentToolsConfig) => boolean> = { ... }
   ```
   它是 `Record<ComputerToolName, …>`，**加名字必编译失败**。本步补三个键：
   `edit_file: (t) => t.files.enabled`、`grep: (t) => t.search.enabled`、`glob: (t) => t.search.enabled`；
   顺带把 `:91` 附近的工具数量文案与 `:407` 的「5 个电脑操控工具」改成按 `COMPUTER_TOOL_NAMES.length` 渲染
   （**不要**再写死数字，否则下次加工具还会漏）。UI 的卡片与字段（`search.*` 栏）由 step 3 交付，本步不做。

跑 `pnpm build:packages && pnpm typecheck` 与 `pnpm test` 把剩余的红点找齐
（**不要**为了省事把新字段设成可选或加 `as Settings`）。
`scripts/verify-p1.mjs` 不在 tsconfig 的 include 里（`.mjs`，不被 typecheck 覆盖），
本步**不动**它，除非执行 `pnpm verify` 时它真的报错。

## 验收标准

- [ ] `pnpm build:packages` → exit 0
      （**必须先建包**：`packages/shared` 与 `packages/agent-core` 的 `types` 都指向各自的 `dist/`
      ——见 `packages/agent-core/package.json:8`、`packages/shared/package.json`，
      不重建的话下游 typecheck 会对着**旧类型**报「no exported member」，看着像自己写错了）
- [ ] `pnpm typecheck` → exit 0（新字段进默认值、`READONLY_PREFIX_REASONS` 已补、
      `AgentPage.vue` 的 `TOOL_GATES` 已补三个键、所有断言点已适配）
- [ ] `pnpm vitest run packages/shared` → 全绿，且能指出新用例：
      `grep -n "allowPatterns" packages/shared/src/config/schema.test.ts` 命中，
      `grep -n "v11 → v12\|11, 12\|from: 11" packages/shared/src/config/migrations.ts` 命中
- [ ] `pnpm vitest run packages/agent-core/src/tools/files.test.ts apps/desktop/src/main/tools/index.test.ts`
      → 全绿（这两处是 `COMPUTER_TOOL_NAMES` 从 5 变 8 的直接受害者，属本步预期改动）
- [ ] `COMPUTER_TOOL_NAMES` 的证据是**单测里的精确数组断言**（`toEqual` 一个长度为 8 的完整数组，
      不是 `toContain`）：跑 `pnpm vitest run packages/shared` 并在输出里指认该用例通过
      （不要用 `grep -c` 之类"命中了就算过"的判据——那种判据没有期望值，等于没断言）
- [ ] `grep -n "'agent.tools.terminal.allowPatterns'" packages/shared/src/config/schema.ts`
      **恰好命中 2 处**（`SETTINGS_READONLY_PREFIXES` 与 `READONLY_PREFIX_REASONS`），
      且 `grep -rn "allowPatterns" packages/shared/src/config/schema.ts | grep WRITABLE` **无命中**
      （证明没被覆盖表放行）
- [ ] `docs/06-agent-core.md` 出现 `## 20.` 与 `## 21.` 两个新小节及 §11.5 / §11.6 / §11.7，
      且 §20 的对照表**六行齐全**：
      `grep -c "read.txt\|edit.txt\|grep.txt\|glob.txt\|todowrite.txt\|task.txt" docs/06-agent-core.md` ≥ 6
- [ ] `grep -n "静态在前" docs/06-agent-core.md` 命中（§5 的顺序表已更新）
- [ ] `grep -rn "terminal\.\*" apps/desktop/src/main/settings-hint.ts` **无命中**（已改逐条列举）
- [ ] `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过

## 交接

- **配置字段（步骤 2–6 直接消费，不要改名）**：
  `agent.tools.search.enabled` / `agent.tools.search.maxResults` / `agent.tools.terminal.allowPatterns`。
- **`COMPUTER_TOOL_NAMES` 的 8 个名字与顺序**是 `registerComputerTools.sync()` 的按名分派依据，
  也是 `schema.test.ts` 精确断言的依据——步骤 3 / 4 加工具时必须与此完全一致。
- **`docs/06` 新增节号**：§11.5（grep/glob）、§11.6（edit_file）、§11.7（allow 列表）、
  §20（工具使用契约）、§21（prompt caching）。步骤 2–6 只在这些节里**订正偏差**，不新起节。
- **`TokenUsage.cachedTokens` 的字段名与解析口径**已写进 §21，由 step 6 实现
  （`packages/shared/src/ipc/types.ts` 的改动也在 step 6，不在本步）。
- 若实现中发现规格本身有误（例如某个上限取值不现实），**就地改 `docs/06` 对应节并把改动写进执行记录**，
  不要默默按别的做法实现。

## 执行记录

执行时间：2026-09-26（会话内连续执行）

### 实际改动

四个互不重叠的写范围分片并行完成（子代理各领一片，主代理集成 + 复跑验收）：

| 分片 | 负责文件 | 结果 |
| --- | --- | --- |
| 配置包 | `packages/shared/src/config/{schema,defaults,migrations}.ts` + 三个 `.test.ts` | `CONFIG_VERSION=12`、`COMPUTER_TOOL_NAMES` 8 个、`search.*` 与 `terminal.allowPatterns` 字段、只读前缀 + 原因、覆盖表两条、`migrateV11ToV12`。**145 用例全绿** |
| `docs/06` | `docs/06-agent-core.md` | §5 顺序表改「静态在前、易变在后」+ 三条工具规范条目；§11 工具表 8 行；新增 §11.5 / §11.6 / §11.7 / §20（4 列 8 行对照表）/ §21；§12.2 / §12.6 / §17 / §19 同步。951 → 1224 行 |
| `docs/07` + `docs/08` | 两个文件 | §1 三行新字段 + JSON 示例 + `v11 → v12` + 「十二条」；§6 门控与栏位；§5.3 探针清单加「预期新增/变化」条与 `chat.context-cache`；§2.3 补缓存命中说明 |
| 应用层适配 | `settings-hint.ts`、`AgentPage.vue`、`files.test.ts`、`tools/index.test.ts` | `SETTINGS_HINT` 逐条列举（不再用 `terminal.*` 通配，理由：`allowPatterns` 只读）；`TOOL_GATES` 补三键、两处计数改 `COMPUTER_TOOL_NAMES.length`；两处测试断言改为显式列表派生（不写死 8 个，因为工具要到 step 3/4 才创建得出来） |

### 验收命令与真实结果（主代理复跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm build:packages` | exit 0（shared / agent-core / modes 三个包 Done） |
| `pnpm typecheck` | exit 0（含 `apps/desktop` 的 `vue-tsc`） |
| `pnpm test` | **66 文件 / 1094 用例全绿**，13.17s |
| `pnpm lint` | exit 0 |
| `pnpm exec prettier --check "**/*.{ts,md,json}"` | All matched files use Prettier code style! |
| `grep -n "'agent.tools.terminal.allowPatterns'" packages/shared/src/config/schema.ts` | 恰好 **2 处**（`:393` 黑名单、`:515` 原因表）✅ |
| `grep allowPatterns schema.ts \| grep WRITABLE` | 无命中 ✅（没被覆盖表放行） |
| `grep -n "^## 20\.\|^## 21\.\|^### 11\.5\|^### 11\.6\|^### 11\.7" docs/06-agent-core.md` | 5 处全命中 ✅ |
| `grep -c "read.txt\|edit.txt\|grep.txt\|glob.txt\|todowrite.txt\|task.txt" docs/06-agent-core.md` | **8**（≥ 6）✅ |
| `grep -c "静态在前" docs/06-agent-core.md` | 4 ✅ |
| `grep -rn "terminal\.\*" apps/desktop/src/main/settings-hint.ts` | 无命中 ✅ |
| `COMPUTER_TOOL_NAMES` 精确数组断言 | `packages/shared/src/config/schema.test.ts:192` 的 `toEqual` 8 元素完整数组，随 `pnpm vitest run packages/shared` 通过 ✅（不是 `toContain`） |

### git 提交

| SHA | 说明 |
| --- | --- |
| `c320096` | `docs(step): 落盘 opencode 对齐任务计划（工具面 + 免确认模式 + prompt caching）` |
| `f769e0a` | `docs: 落盘工具面扩充规格（§11.5 grep/glob、§11.6 edit_file、§11.7 免确认模式、§20 契约对照、§21 prompt caching）` |
| `088b91b` | `feat(config): 配置 Schema v12（agent.tools.search.* 与 terminal.allowPatterns），电脑操控工具扩到 8 个` |

### 与计划的偏差

1. **`DEFAULT_AGENT_TOOLS.terminal.allowPatterns` 写成 `[] as string[]`**（计划原文是裸 `[]`）。
   原因：该对象是 `as const`，裸 `[]` 被推断成只读空元组 `readonly []`，赋给 Schema 推出的可变
   `string[]` 会 `TS2322` 编译失败。已由子代理用隔离 `tsc --strict` 实测确认。
2. **`tools/index.test.ts` 的适配写法**用了**显式本地常量** `IMPLEMENTED_COMPUTER_TOOLS`（5 个名字）
   而不是计划里说的"当前配置下注册的名字集合"——后者无法在不写死的情况下表达，
   而写死 8 个立刻会红（`edit_file` / `grep` / `glob` 要到 step 3/4 才创建得出来）。
   常量带注释说明"新增工具时同步加名字"，step 3 / step 4 各加一条。
3. **`docs/07` 顺带订正了三处会变成事实错误的陈述**（`workspaceDir` 兼作 `grep`/`glob` 缺省搜索根、
   `sensitivity` 枚举含 `edit_file` / `grep` / `glob`、`agent.tools.*` 可写例外的注释）——超出 step-01 字面清单，
   但不改就与 `docs/06 §11.1/§11.4/§11.5` 直接冲突。
4. **`docs/06 §11` 正文里落盘了 `read_file` 的新输出契约**（行号前缀 + `offset`/`limit` + 常量默认值），
   因为 step-02 的 `Writes` 不含 `docs/06`，而 §20 要求 read 契约「落到 §11 与 step 2」。

### 已登记、未修

- `docs/08 §1` 的标题与 JSON 示例里 `version` 仍写 `10`（改动前就是 10，上一次 `v10 → v11` 迁移提交
  同样没动它们，见 `2e848f5`）。属既有滞后，与本轮无关，未顺手改。
- `AgentPage.vue` 脚本头注释（`:10-13`）里对「五个工具」的枚举与「文件」小节说明里
  只提 `read_file / write_file / list_dir` 的文案仍待 step 3 / step 4 更新。

### 对后续步骤的影响

- **本步之后 UI 会短暂显示「5 / 8 个工具生效」**：`grep` / `glob`（step 3）、`edit_file`（step 4）
  尚未装配。这是预期内状态，不是 bug。
