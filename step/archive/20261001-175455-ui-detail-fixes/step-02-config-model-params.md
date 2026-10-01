# Step 02 — 配置层 v23：modelParams 下沉 + 删 temperature + 迁移

- Task: ui-detail-fixes
- Step: 2 / 8
- Status: done
- Depends on: step 1
- Produces: `packages/shared` 里改造后的 `LlmProviderSchema` / `LlmModelParamsSchema` / `resolveModelParams`、`WRITABLE_PATH_OVERRIDES` 与 `migrateV22ToV23`，以及覆盖它们的单测
- Phase: 基础与配置
- Writes: `packages/shared/src/config/schema.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/config/store.test.ts`
- Size: L
- Risk: ① 迁移把用户填过的上下文窗口 / 图片开关搬丢（搬丢后界面显示 0 / 关闭，用户看不出是迁移干的）→ 用「v22 旧配置 → v23」的迁移单测把三个值逐个断言；② 双 `*` 路径模式若无单测钉住，可能被后人误改成整组放行（等于把 baseUrl 与凭据子树一起放开）。本步只动 `packages/shared`，不碰主进程与渲染层 —— 下游报错是**预期**的，留给 step 3/4/5 消化。

## 目标

配置 Schema 里 `reasoningEffort` / `contextWindow` / `vision` 从 provider 级下沉到按模型 id 键的 `modelParams`，`temperature` 整个字段消失；旧配置（`version: 22`）能无损迁移到 v23，且迁移可重复执行而不改值。

## 输入

- `packages/shared/src/config/schema.ts`：`CONFIG_VERSION` 在 `:9`；`LlmProviderSchema` 在 `:146-181`（`temperature` `:160`、`modelList` `:159`、`contextWindow` `:171`、`vision` `:180`）；`ReasoningEffortSchema` 与 `REASONING_EFFORT_LEVELS` 在 `:128-137`；`WRITABLE_PATH_OVERRIDES` 在 `:849-853`；匹配器 `matchWritableOverride` 在 `:903-914`（逐段相等 + 段数一致，`*` 匹配恰好一段 —— **支持多个 `*` 段**）。
- `packages/shared/src/config/migrations.ts`：`Migration` 接口在 `:23-28`；v0→v1 里有一处 provider 字面量含 `temperature: 0.7`（`:56`）；`migrateV21ToV22`（以符号名为准定位，约在 `:755-788`）的写法直接照抄：`asRecord` 逐层下钻 + `fillMissing` + `next['version'] = N` + 不覆盖已写值）；`MIGRATIONS` 数组尾部在 `:784` 之后。
- `packages/shared/src/config/migrations.test.ts`：`:33` 断言 v0→v1 结果含 `temperature === 0.7`；`:391-531` 是 v5→v6（modelList）；`:766-808` 是 v10→v11（contextWindow，含「已写值不被覆盖」的幂等用例）；`:1066` 与 `:1100` 按 `describe` 字符串断言迁移条数与内容。
- `packages/shared/src/config/schema.test.ts`：`:72-85` 用 `fieldAccepts` 断言 `llm.providers.deepseek.temperature`；`:142-149` 断言 temperature 越界被拒；`:199 / :225 / :435` 是 provider 夹具。
- `packages/shared/src/config/store.test.ts`：`:156 / :184-216` 是 provider 夹具与 `contextWindow` 断言。
- `packages/shared/src/browser.ts` 用 `export * from './config/schema.js'` 把整册 Schema 透给渲染层 —— 新导出的常量与纯函数**自动**在渲染层可用，不需要额外接线（该文件是纯代码，不得引入 Node 内置模块）。
- 本轮口径（来自 step 1 的文档，逐字沿用）：
  - `LlmModelParamsSchema = { reasoningEffort: ReasoningEffortSchema, contextWindow: int 0–2_000_000, vision: boolean }`。
  - `LlmProviderSchema` 删 `temperature` / `reasoningEffort` / `contextWindow` / `vision`，加 `modelParams: z.record(z.string(), LlmModelParamsSchema).default({})`。
  - 缺省回落入参 `LLM_MODEL_PARAM_DEFAULTS = { reasoningEffort: 'auto', contextWindow: 0, vision: false }`，入口 `resolveModelParams(provider, modelId?)`（`modelId` 缺省取 `provider.model`）。
  - `WRITABLE_PATH_OVERRIDES`：删 `llm.providers.*.temperature`，把 `llm.providers.*.reasoningEffort` 改成 `llm.providers.*.modelParams.*.reasoningEffort`，`llm.providers.*.model` 保留。

## 操作

1. `packages/shared/src/config/schema.ts`
   - 在 `LlmProviderSchema` 之前新增 `LlmModelParamsSchema`（三个字段的约束与今天 provider 级**逐字相同**：`reasoningEffort` 用现成的 `ReasoningEffortSchema`、`contextWindow` 用 `.int().min(0).max(2_000_000).default(0)`、`vision` 用 `.boolean().default(false)`），并导出 `LlmModelParams` 类型、`LLM_MODEL_PARAM_DEFAULTS` 与 `resolveModelParams`。
   - `resolveModelParams(provider: LlmProviderConfig, modelId?: string): LlmModelParams`：取 `provider.modelParams[modelId ?? provider.model]`，未命中（手改配置 / 老配置漏迁移 / 模型不在表里）返回 `LLM_MODEL_PARAM_DEFAULTS`；函数的注释里写明「这是三处消费方（主进程装配、渲染层、Center）**唯一**的取值口径，别在调用处再写 `?? {…}`」。
   - `LlmProviderSchema`：删 `temperature` / `reasoningEffort` / `contextWindow` / `vision` 四个字段（连同它们的注释块），新增 `modelParams: z.record(z.string(), LlmModelParamsSchema).default({})`；注释说明「v23 起参数随模型绑定；键是模型 id（`modelList` 的元素或 `model` 本身），未命中键时由 `resolveModelParams` 回落默认」。
   - `CONFIG_VERSION` 从 `22` 改成 `23`。
   - `WRITABLE_PATH_OVERRIDES`（`:849-853`）：删除 temperature 那条，把 reasoningEffort 那条改成 `{ pattern: 'llm.providers.*.modelParams.*.reasoningEffort', reason: '调整该模型的思考等级（不碰凭据）' }`；注意 `modelParams` 下的 `contextWindow` / `vision` **刻意不登记**（它们是模型能力事实，保持只读），并在表内注释一句。
2. `packages/shared/src/config/migrations.ts`
   - 新增 `migrateV22ToV23`（放在 `migrateV21ToV22` 之后，`MIGRATIONS` 数组末尾追加），`describe: 'v22 → v23：把 provider 级 reasoningEffort / contextWindow / vision 搬进 modelParams[model]，删除 temperature'`。`transform` 逐条 provider 处理：`model` 为非空字符串时写 `modelParams = { [model]: { reasoningEffort, contextWindow, vision } }`，`model` 为空串时写 `{}`；随后删除 provider 级的 `reasoningEffort` / `contextWindow` / `vision` / `temperature` 四个键；已有 `modelParams` 的非空值**不覆盖**（幂等，与 `migrateV10ToV11` 同款）。`llm` 分组或 `providers` 缺失时原样跳过（不造半截对象）。末尾 `next['version'] = 23`。
   - ⚠️ **搬值必须先归一，不能「逐字搬」**：`config.json` 被手改过时旧值可能是非法/缺失（`reasoningEffort` 不在 `REASONING_EFFORT_LEVELS` 内、`contextWindow` 是字符串或负数、`vision` 不是布尔）。`llm.providers` 是 `z.record`，`SettingsStore` 的字段级回退对这类动态键**整体保留候选对象**（见 `packages/shared/src/config/schema.ts` 里 `sanitizeWithDefaults` 的注释），也就是说非法值只能靠迁移兜住 —— 一旦写进 `modelParams` 就会让 `SettingsSchema.parse` 抛错，走「备份 + 重建出厂配置」，用户的 provider / 凭据 / 项目配置一起消失。因此照 `migrateV4ToV5` 的同款口径归一：`reasoningEffort` 不在枚举内（含 `undefined`）→ `'auto'`；`contextWindow` 非有限非负整数 → `0`；`vision` 非布尔 → `false`。
   - v0→v1（`:56`）里那处 `temperature: 0.7` 字面量删掉（它可以由 v23 迁移兜掉，但留在链上会让读代码的人以为该字段还活着）。
3. 同步单测
   - `migrations.test.ts`：`describe` 条数断言（`:1066` / `:1100`）跟上新迁移；`:33` 的 `temperature === 0.7` 断言改成断言 v0→v1 中间产物的其它字段（或改成断言终态配置里**没有** temperature）；新增用例：「v22 旧配置（provider 带 `model: 'deepseek-chat'` + 三个 provider 级值）→ v23：`modelParams['deepseek-chat']` 的三个值与旧值逐个相等、provider 级四个键全部不存在、`version === 23`」；「`model` 为空串时 `modelParams` 为 `{}`」；「迁移两次结果相同（幂等）」；**「非法旧值被归一而不是继承」——provider 缺 `reasoningEffort` / 给了 `reasoningEffort: 'ultra'` / `contextWindow: '128k'` / `vision: 'yes'` 时，迁移后的 `modelParams[model]` 仍是 `{ reasoningEffort: 'auto', contextWindow: 0, vision: false }`，且整份配置能通过 `SettingsSchema.parse`**；沿用 `:766-808` 那组「已写值不被覆盖」的写法。
   - `schema.test.ts`：把 `fieldAccepts('llm.providers.deepseek.temperature', …)` 的断言换成 `llm.providers.deepseek.modelParams.deepseek-chat.reasoningEffort` / `.contextWindow` / `.vision`；`:142-149` 的越界用例改成 `modelParams` 下的 `contextWindow: 9_000_000` 之类；新增一组 `canWriteSettingPath` 断言：`llm.providers.deepseek.modelParams.deepseek-chat.reasoningEffort === true`、`llm.providers.deepseek.temperature === false`、`llm.providers.deepseek.modelParams.deepseek-chat.contextWindow === false`。
   - `store.test.ts`：夹具里的 `temperature` 删掉，`contextWindow` 移进 `modelParams`。
4. 不要在 `packages/shared` 之外做任何改动（`main` / `renderer` 的编译错误留给后续步骤）。

## 分片建议

- 片 A：`schema.ts` + `schema.test.ts`（操作 1 与操作 3 的 schema 用例）。
- 片 B：`migrations.ts` + `migrations.test.ts`（操作 2 与操作 3 的迁移用例）。
- 片 C：`store.test.ts`（操作 3 的夹具）。
- 三片写不同文件、但片 C 依赖片 A 的类型；若派子代理并行，让片 C 在片 A 之后跑。

## 验收标准

- [ ] `pnpm --filter @aurora/shared build` 成功（下游 typecheck 依赖这一步产出的 `dist/*.d.ts`）。
- [ ] `pnpm vitest run packages/shared/src/config` 全绿，其中必须能看到本步新增的四个用例名：v22→v23 搬运三值、`model` 为空不造条目、迁移幂等、`modelParams` 路径可写而 `temperature` 路径不可写。
- [ ] `grep -n "temperature" packages/shared/src/config/schema.ts` 无命中。
- [ ] `grep -rn "modelParams" packages/shared/src/config/schema.ts packages/shared/src/config/migrations.ts` 两处都有命中。
- [ ] `pnpm build && pnpm verify` 通过（**重命令**：build 约 1 分钟、verify 需要构建产物；`scripts/verify-p1.mjs:84` 断言 `fresh.version === CONFIG_VERSION`、`:155-161` 断言迁移条数等于版本号——本步把 `CONFIG_VERSION` 推到 23 后必须同时满足）。

## 交接

- 引导页也写同一批字段（`apps/desktop/src/renderer/onboarding/App.vue`），它由 step 3 一起改 —— 本步只保证 `packages/shared` 侧就位。
- 新导出的符号（后续步骤直接 import，不要再写第二份）：`LlmModelParamsSchema` / `LlmModelParams` / `LLM_MODEL_PARAM_DEFAULTS` / `resolveModelParams` —— 渲染层同样可用（`packages/shared/src/browser.ts` 已整体 `export * from './config/schema.js'`）。
- 旧字段已不存在：任何 `provider.temperature` / `provider.reasoningEffort` / `provider.contextWindow` / `provider.vision` 的读取都会在 `pnpm typecheck` 报错 —— step 3 与 step 4 用这个报错当清单。
- 迁移语义：`modelParams` 的键是模型 id；`model` 为空串的 provider 迁移后是 `{}`。

## 执行记录

**提交：`4a94afa`**（`feat(config): 生成参数按模型下沉 modelParams 并删除 temperature，配置升到 v23`）

### 实现分片
- 主代理 → `schema.ts` + `migrations.ts`（两个源文件互为接口、耦合紧，按 skill「同接口串行」自己写，不并行）
- 子代理 A → `migrations.test.ts`
- 子代理 B → `schema.test.ts` + `store.test.ts`
三片写范围不重叠，子代理未碰实现文件（只读）。

### 实际改动
- `schema.ts`：`CONFIG_VERSION` 22 → 23；新增 `LlmModelParamsSchema`（三字段：`reasoningEffort` 用现成的 `ReasoningEffortSchema`、`contextWindow` 用新抽的私有 `ContextWindowFieldSchema`（`.int().min(0).max(2_000_000).default(0)`）、`vision` `.boolean().default(false)`）与 `LlmModelParams` 类型、`LLM_MODEL_PARAM_DEFAULTS`、`normalizeModelParams`、`resolveModelParams`；`LlmProviderSchema` 删掉 `temperature` / `reasoningEffort` / `contextWindow` / `vision` 四个字段，新增 `modelParams: z.record(z.string(), LlmModelParamsSchema).default({})`；`WRITABLE_PATH_OVERRIDES` 删 temperature 那条、把 reasoningEffort 那条改成双 `*` 的 `llm.providers.*.modelParams.*.reasoningEffort`（`contextWindow` / `vision` 刻意不登记）。
- `migrations.ts`：新增 `migrateV22ToV23` + 私有 `migrateProviderToModelParams`（放在 `migrateV21ToV22` 之后、追加到 `MIGRATIONS` 尾部，共 23 条）；`migrateV0ToV1` 里那处 `temperature: 0.7` 字面量删掉。

### 与计划的偏离（均为收窄风险，逐条说明理由）
1. **新增导出 `normalizeModelParams`**（计划「交接」只点名 4 个符号）。理由是迁移与读取端必须共用同一套「什么算合法 + 回落什么」的判断：写两份判断迟早在改 Schema 上限时漂移。`resolveModelParams` 与 `migrateProviderToModelParams` 都走它。
2. **`resolveModelParams` 按字段归一，而不是「键未命中才回落」**。计划的操作文字写的是「未命中返回默认」，但 step 1 落定的 SSOT（`docs/08 §1`）写的是「**未命中键**（或键在但字段缺失 / 非法）时返回 `{…}`」。取更强的那条：无论配置怎么来的，消费方**绝不**拿到缺字段的对象（`noUncheckedIndexedAccess` 下那会变成 `undefined` 参与运算）。这也是「审查重点」里「`modelParams` 缺失键时消费方是否回落默认（不能读到 `undefined` 崩）」的正面回应。
3. **迁移对手改出来的 `modelParams` 条目也逐条归一**（计划只要求归一 provider 级旧值）。理由是同一个风险面：`llm.providers` 是 `z.record`，`sanitizeWithDefaults` 对它整体保留候选对象、**不下钻**，所以 `modelParams` 子树里任何非法值都会让 `SettingsSchema.parse` 抛错 → 备份 + 重建出厂配置。既然迁移是唯一能拦的地方，就一并拦掉。
4. **改写 `schema.ts` 里两处注释对 `temperature` 的字面提及**，以满足验收项 `grep -n "temperature" packages/shared/src/config/schema.ts` 无命中。其中 `:923` 是**真陈旧**（原文仍把 `temperature` 列在「真的放开」的可写路径里，是前几轮留下的），已改成 `model` 与 `modelParams.<modelId>.reasoningEffort`；另一处（我新写的表内注释）改用中文「采样温度字段」表述 —— 语义未变，只是不再让这个标识符在 schema 里出现。

### 验证（主代理复跑，命令与真实输出）
- `pnpm --filter @aurora/shared build` → `tsc -p tsconfig.json`，无输出，exit 0 ✓
- `pnpm vitest run packages/shared/src/config` → `Test Files 4 passed (4)` / `Tests 177 passed (177)`；verbose 里能看到本步新增的用例名：
  - `v22 旧配置 → v23：三个 provider 级值搬到 modelParams[model]，四个旧键全部消失`
  - `model 为空串时不造模型条目，四个旧键照删`
  - `迁移幂等：对 v23 结果再迁一次，结果逐字相同`
  - `非法旧值被归一为默认（ultra / 128k / yes），且结果能通过 SettingsSchema.parse`
  - `resolveModelParams 是三处消费方的唯一取值口径：命中 / 未命中 / 缺字段都按字段回落（v23）`
  - `llm.providers 只放行 model 与 modelParams.*.reasoningEffort：双 * 覆盖表不得退化成整组放行（v23）`
  - `provider 级 temperature 已从 Schema 删除：写进去既不报错也不落库（v23）`
- `grep -n "temperature" packages/shared/src/config/schema.ts` → **无命中**（exit 1）✓
- `grep -c "modelParams" packages/shared/src/config/schema.ts packages/shared/src/config/migrations.ts` → 8 / 10 ✓
- `npx prettier --check` 五个改动文件 → `All matched files use Prettier code style!` ✓
- `pnpm build` → 全仓成功（含 `apps/desktop` 的 electron-vite 三段产物）✓
- `pnpm verify` → **26/26 项通过**，其中 `config.version = 当前版本 — version=23`、`执行了 v0 → 当前版本的迁移链 — count=23/23` ✓
- 另用 `dist` 直接跑了一遍迁移做交叉验证：搬运三值、四个旧键消失、幂等、`model: ''` → `{}`、非法值归一、手改 `modelParams` 归一，且归一后的配置能通过 `SettingsSchema.parse`。
- 断言强度未下降：`migrations.test.ts` 的 `expect(` 294 → 325；`schema.test.ts` 230 → 265；`store.test.ts` 194 → 202。测试里没有为了变绿而删断言（改的是「值在哪个键下」）。

### 遗留问题（**不在本步范围，未修，供决策**）
1. **`lookupSpec` / `lookupEnum`（`schema.ts`）只做单段 `*` 通配替换**，于是双动态段路径 `llm.providers.<id>.modelParams.<modelId>.<字段>` 查不到登记项，`fieldAccepts` 落到「未登记路径默认接受」分支 —— 即 `fieldAccepts('…modelParams.deepseek-chat.contextWindow', '128k')` 返回 `true`（期望 `false`）。
   影响面**惰性**：`fieldAccepts` 全仓只被 `store.ts` 的 `sanitizeWithDefaults` 使用，而它对 `llm.providers`（`z.record`）整体保留候选对象、不下钻；真正的取值闸门是 `SettingsSchema`（写入路径 `settings-port.ts` 有写后二次校验 + 整份回滚）。此外这个「双动态段」限制并非本步引入 —— `mcp.servers[].headersEnc.*` 早就是同一形态。
   已在 `schema.test.ts` 用一条 `it.fails` 把**期望行为**钉住当探针（`fieldAccepts 应当按 Schema 拒绝 modelParams 下的非法值（已知缺口）`）；子代理已反向复核它不是空转（把那两条断言翻成 `true` 后该用例立刻变红）。修法是让 `lookupSpec` / `lookupEnum` 支持多段通配替换，属**扩大范围**，本步未动。
2. **v23 之后，`modelParams` 子树里的非法值没有字段级回退**：手改配置把 `contextWindow` 写成 `'128k'`，或漏写 `reasoningEffort`（它是三个子字段里**唯一没有 `.default()`** 的），都会让 `SettingsSchema.parse` 抛错 → 备份 + 重建出厂配置（用户 provider / 凭据 / 项目配置一起丢）。存量已由 `migrateV22ToV23` 的归一兜住，这条只影响 v23 之后的写入方。**给 step 3/4/5 的硬要求**：写 `modelParams` 时三项都要写全（step 5 的 `normalizedModelParams` 正是为此），不要只写被改动的那一项。
3. 子代理 A 指出的边界：`model` 为空串的 provider，其 provider 级 `contextWindow` / `vision` 按语义 ③ **被丢弃**（没有可键的模型 id）。这是计划明文规定，非缺陷；但它确实是「搬运丢值」这条风险的唯一遗留面。
