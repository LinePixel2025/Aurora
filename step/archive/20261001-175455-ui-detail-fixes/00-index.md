# 任务：修复六项 UI 细节（设置页说明与入口、权限下拉溢出、上下文详解精简、输入区文案、模型级参数下沉）

- 任务标识：ui-detail-fixes
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-10-01 16:02
- 执行模式：
- 基线提交：963cefc78ff491beac8dc2830d5826bd28e4eb77
- 归档目录：step/archive/20261001-175455-ui-detail-fixes
- 归档时间：2026-10-01 17:54:55

## 完成标准

- `pnpm typecheck` 0 错、`pnpm test` 全绿（改动前基线 118 文件 / 2101 用例）、`pnpm build` 成功、`pnpm verify` 通过（断言 `version === CONFIG_VERSION`，本轮 `CONFIG_VERSION = 23`，且 `appliedMigrations.length === 23`）。
- `AURORA_SMOKE=1` 端到端全量自测 `SUMMARY` 全绿（改动前基线 176/176；条数若变化，必须逐条说明变化只来自本轮有意增删的断言）；多模态段 `AURORA_SMOKE_ONLY='2.8'` 单独跑通。
- `AURORA_CAPTURE` 全量截图 `report.json` 里 **0 个 FAIL**，且下列四张图经视觉核对达标：`chat-composer-permission.png`（权限菜单文字不出卡片边框、工具行右侧不再有「Enter 发送」字样）、`settings-llm-params.png`（上下文窗口 / 图片输入 / 思考等级在**模型行内**，页面上不再有 temperature 字段）、`settings-llm.png`（生图模型空状态有可点的「+ 添加生图模型」按钮）、`settings-general.png`（「通用」页不再有关于会话管理的说明句）。

## 现状与关键结论

- **六条问题的落点（已逐条核实）**
  1. 设置页「通用」里那块说明 = `apps/desktop/src/renderer/settings/pages/GeneralPage.vue:309-317`（一个只有 `<p class="section-desc">` 的空壳 `section-card`，无 `data-field` / `data-empty` 锚点，删掉不影响 `SETTINGS_FIELDS_SCRIPT` 的 `projects.* === 0` 断言）。会话管理页本体在 `apps/desktop/src/renderer/settings/pages/SessionsPage.vue`，侧栏入口 `apps/desktop/src/renderer/settings/App.vue:54`，删句后入口不受影响。
  2. 权限下拉溢出 = `apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue:348-359` 的 `.perm-menu`（`width: 320px`，无 `overflow`）里那行长文案（同文件 `:231-237`）。根因是**继承**了祖先 `apps/desktop/src/renderer/chat/App.vue:1809` 的 `.composer-bar { white-space: nowrap }` —— `white-space` 是继承属性，而 `.perm-item-body`（`:400-405`）虽写了 `min-width: 0`，却没有 `white-space: normal` / `overflow-wrap`，于是文字横向画出卡片。
  3. 上下文详解卡 = `apps/desktop/src/renderer/chat/components/ComposerContextBar.vue:145-207`（7 行 + 一句说明）。
  4. 键位提示 = `apps/desktop/src/renderer/chat/App.vue:1063`（常量 `shortcutHint`）与 `:1342`（`.composer-hint` 那支 span，与 `:1341` 的 `.picker-hint` 是 `v-if / v-else` 成对结构）。工具行的收缩口径见 `App.vue:1813-1819`（两枚提示共用 `flex: 0 1 auto`）、`:1827-1829`（`.send-slot` 不收缩）、`ModelPickerSelect.vue:129-133`（110px → 72px）、`ThinkingLevelSelect.vue:83-87`（→ 62px）。
  5. 生图模型缺入口 = `apps/desktop/src/renderer/settings/components/ImageGenSection.vue:386` 的工具行被 `v-if="drafts.length > 0 || mode === 'add'"` 门控，而空状态（`:381` 的 `data-empty="imagegen.providers"`）只有一行文字、没有按钮 —— 全新配置下用户点不到「添加生图模型」。LlmPage 的空态（`LlmPage.vue:669-677`）是正确样板。
  6. 参数绑错层级 = `packages/shared/src/config/schema.ts:146-181` 的 `LlmProviderSchema` 把 `temperature` / `reasoningEffort` / `contextWindow` / `vision` 全放在 provider 级，而设置页把它们渲染在「高级参数与连接测试」折叠区（`LlmPage.vue:954-1068`），与「模型列表里选中的哪个模型」无关（`selectModel` 只改 `draft.model`，见 `LlmPage.vue:210-214`）。
- **配置现状**：`CONFIG_VERSION = 22`（`schema.ts:9`），provider 级 `temperature: z.number().min(0).max(2)`（无 default，必填）、`reasoningEffort`、`contextWindow`（`.default(0)`）、`vision`（`.default(false)`）；候选模型是纯字符串数组 `modelList: z.array(z.string()).default([])`（`schema.ts:159`）。Schema 对象**没有** `.strict()`，未知键在 parse 时被 strip。
- **可写面**：`WRITABLE_PATH_OVERRIDES`（`schema.ts:849-853`）显式登记了 `llm.providers.*.model` / `.reasoningEffort` / `.temperature`；匹配器 `matchWritableOverride`（`schema.ts:903-914`）支持**多个 `*` 段**（逐段相等 + 段数一致），因此 `llm.providers.*.modelParams.*.reasoningEffort` 这种双通配模式可用。
- **消费点清单（改字段必须同时改）**
  - 请求装配：`apps/desktop/src/main/agent-host.ts` 的 `build()` —— `reasoningEffort` 的映射、`temperature: config.temperature`、`vision: config.vision === true` 三行（以符号名定位，约在 `:175-205`）。
  - 图片能力判定：`apps/desktop/src/main/ipc.ts:1064-1071`（`visionEnabled`，唯一判据是 `llm.providers[active].vision === true`）。
  - 上下文占比分母：`apps/desktop/src/renderer/chat/App.vue:1047-1048` → `ComposerContextBar.vue:35 / 88-89 / 109 / 181-182`。
  - 对话窗思考等级：`apps/desktop/src/renderer/chat/App.vue:433-436 / 513-517`。
  - 能力透传内核：`packages/agent-core/src/host/agentHost.ts:34-43`（`ProviderConfig`）、`:643`（`visionEnabled`）、`:719-721`（temperature 透传）；内核**保持** `temperature?: number` 这个可选能力（单测 `openai-compat.test.ts:341-357`、`responses.test.ts:139-166` 覆盖），只是不再由配置喂值。
  - 内核可写清单：`packages/agent-core/src/tools/settings.ts:67-70`；主进程提示词清单 `apps/desktop/src/main/settings-hint.ts:18`。
  - Center 平价（同一份配置的另一端）：`apps/desktop/src/main/center/remote-control.ts:82`（ClientStatus 快照）、`apps/desktop/src/main/center/connector.ts:670-690`（`llm.switch` 写入）、`packages/center/web/src/store.ts:110-120 / 778-845`、`packages/center/web/src/components/SessionListPanel.vue:58 / 186-188 / 245`、`packages/center/web/src/components/SessionView.vue:77`。
  - 引导页也写同一批字段：`apps/desktop/src/renderer/onboarding/App.vue:104-118` 的 provider 字面量（含 provider 级 `temperature` / `reasoningEffort` / `contextWindow` / `vision`，且 `modelList: []`）与 `:343-344` 的 temperature 输入框 —— step 2 删字段后这里会编译报错，且用户第 6 条的「删除 temperature 字样」包含它（由 step 3 一起改）。
  - 模型行只有在 `modelList` 非空时才渲染（`LlmPage.vue:855-866` 的 `v-if` / `v-else`），而 `adoptCurrentModel` 只在 `onModelInput` / `selectModel` 里调用 —— 引导页建的 provider 是 `modelList: []`，所以「参数随模型走」的 UI 必须靠 `syncDrafts` 自动补行，否则默认路径够不到（step 5 操作 1 第 3 条）。
  - 夹具与字面量：`apps/desktop/src/main/index.ts:1932-1938 / 2159-2168 / 3620-3635 / 3695-3710 / 3810-3814`、`apps/desktop/src/main/smoke.ts:145 / 174 / 196 / 214 / 291 / 339`、`apps/desktop/src/main/settings-patch.test.ts:39-43`、`apps/desktop/src/main/center/remote-control.test.ts:84-121`、`apps/desktop/src/main/center/connector.test.ts:88 / 682-687`、`packages/shared/src/config/migrations.ts:56`（v0→v1 的字面量）。
- **探针契约（改 UI 必须同步；探针字符串在 `apps/desktop/src/main/capture.ts` 里，全是 template literal，注释里禁写反引号）**
  - `SETTINGS_LLM_EFFORT_ACT/CHECK`（`capture.ts:5817-5940`）：点 `[data-action=edit-provider]` → `.more`，断言 `[data-field$=".reasoningEffort"] select.value === 'high'` **且 `[data-field$=".temperature"]` 必须存在**（删 temperature 后这条必然 FAIL）。
  - `SETTINGS_LLM_MODELS_ACT/CHECK`（`capture.ts:6458-6545`）：行数用 `[data-field*=".modelList."]` 计数、`data-action=add-model` / `remove-model`、空态 `[data-empty$=".modelList"]`。
  - `SETTINGS_LLM_MULTIMODAL_ACT/CHECK`（`capture.ts:6647-6760`）：读 `[data-field$=".type"] select` 与 `[data-field$=".vision"] input[type=checkbox]`，并回读配置写回原值。
  - `SETTINGS_LLM_FIELDS_SCRIPT`（`capture.ts:5454-5487`）、`SETTINGS_LLM_STRUCTURE_ACT/CHECK`（`capture.ts:6553-6650`）。
  - 对话窗：`chat.context` / `chat.context-usage` / `chat.context-detail` / `chat.context-cache` 四个锚点与 `.ctx-total` 类被 `capture.ts:2530 / 2570-2582 / 2724-2790 / 3388 / 3550 / 3662-3701 / 4223-4230` 硬依赖；`chat-composer-permission` 探针（`capture.ts:3197-3331 / 3501-3550`）只按 `textContent` 子串断言「完全权限」「再点一次确认」。`composer-hint` **没有任何探针引用**。
  - 场景文件名（`AURORA_CAPTURE_ONLY` 按 PNG 文件名**子串**匹配）：`settings-llm-models.png` / `settings-llm-params.png` / `settings-llm-structure.png` / `settings-llm-multimodal.png`（`capture.ts:8042-8071`）、`settings-general.png` / `settings-llm.png`（由 `SETTINGS_PAGE_IDS` 循环生成，`capture.ts:7952-7985`，分别跑 `SETTINGS_FIELDS_SCRIPT` 与 `SETTINGS_LLM_FIELDS_SCRIPT`）、`chat-composer-permission.png` / `chat-composer-slash.png`（`CHAT_COMPOSER_CHECK` 所在场景）/ `chat-composer-flyouts.png` / `chat-permission-readonly.png` / `chat-model-picker.png` / `chat-thinking-level.png`（`capture.ts:7588-8130` 全表）。
- **文档 SSOT 落点**：`docs/08-settings-onboarding.md`（§1 示例 JSON `:45-52`、`modelList` `:277-285`、`contextWindow` `:286-294`、`type` `:296-300`、`vision` `:301-304`、可写表 `:317-318`、迁移链 `:589-633`、§5 UI 规格 `:690-728`）；`docs/06-agent-core.md`（§3 `:41-51`、§3.1 `:74-76`、§12.2 `:1089-1091`、§16.2 `:1478-1500`、§17 `:1586-1588`）；`docs/07-ui-spec.md`（§2.3 输入区 `:540-560`、上下文详解条与模型/思考 `:604-640`、`data-field` 契约 `:168-172 / 515-526`）。
- **验收基线与已知存量失败（2026-10-01 16:02 实测）**
  - `pnpm typecheck`：0 错。
  - `pnpm test`：118 文件 / 2101 用例全绿（约 21s）。
  - `pnpm format:check`：**改动前就红**（44 个文件，本机 autocrlf 造成）—— 不在本任务范围；本轮只要求「自己改动的文件」过 `pnpm prettier --check <文件>`。
  - `pnpm lint`：**改动前就红**（3 个 error：`packages/shared/src/config/store.ts:746` 的 `MCP_SECRET_MARKERS` 未使用等）—— 同上，不在本任务范围。
  - 全量 `AURORA_SMOKE` / `AURORA_CAPTURE` 本轮**未预跑**（各 25s / 3–5 分钟，且需要桌面会话）；执行阶段第一次跑它们时，先确认输出与「改动前基线」的差异只来自本轮改动。
- **本次未联网**：本任务全部结论来自仓库内代码、文档与本地命令，没有引入新依赖、没有查询外部 API 行为。

## 假设与待确认

- 假设 1（存储形态）：`contextWindow` / `vision` / `reasoningEffort` 下沉为 provider 内的**按模型 id 键的 record** `llm.providers.<id>.modelParams.<modelId>`，`modelList` **保持 `string[]` 不变**（若改成对象数组，会连锁改 Center 网页端的 `modelList: string[]` 类型、`ModelPickerSelect` 属性、`CHAT_MODEL_PICKER` 探针与多份测试，收益不抵成本）。单独一个 `modelParams` 表也天然避免了「重命名模型后参数找不到」——重命名时同步搬 key 即可。
- 假设 2（迁移落点）：v22 → v23 把 provider 级的三个值搬到 `modelParams[provider.model]`；`model` 为空串的条目本来就不发请求，迁移只写 `modelParams: {}`，不凭空造模型条目。删 `temperature` 时**不**做「等价补偿」——用户已确认请求体不再带该参数。
- 假设 3（temperature 彻底删）：配置字段、设置页字段、装配层下发、可写覆盖表登记、`settingsHint` / 内核工具描述、文档登记全部删除；内核 `ProviderConfig.temperature?: number` 能力保留（`fakeProvider` / `task` 子任务 / 单测仍在用），只是不再由配置喂值。分类管线 `apps/desktop/src/main/classify/llm.ts:136` 自己写死的 `0.2` 不动（它不走 `llm.providers`）。
- 假设 4（Center 平价在范围内）：`packages/center/web` 是同一份配置的另一个消费端，`llm.switch` 会真的写到 `llm.providers.<id>.modelParams.<model>.reasoningEffort`，因此网页端的读模型选择 / 思考等级 / 上下文占比必须同步，否则是静默回归。Center 服务器端（`packages/center/src`）只透传 `reasoningEffort` 字段，协议**不改**。
- 假设 5（上下文详解留在 3 行）：保留「本轮输入 / 上下文窗口 / 模型」+ 缺用量时的一句说明；`messageCount` / `charCount` 两个 prop 连同 App.vue 的传参一起删。折叠条（`chat.context` / `chat.context-usage` / `chat.context-cache` / `.ctx-total`）**一字不动**——探针硬依赖。
- 假设 6（权限文案）：换行修根因（CSS）+ 压短成两短句，但必须同时保留「有项目：根内免确认、越界仍询问」与「无项目：不再逐次询问」两个语义（与 `agent-host.ts` 的 auto 分支一致），且保留子串「完全权限」「再点一次确认」（探针按子串断言）。
- 假设 7（模型行内的参数入口形态）：每个模型行给一枚「参数」开关（`data-action="toggle-model-params"`），展开后在该行内呈现思考等级 / 上下文窗口 / 支持图片输入三个字段，锚点为 `llm.providers.<id>.modelList.<index>.<字段>`。provider 级「高级参数与连接测试」区只保留接口类型 + 连接测试 / 拉取按钮 + 模型 chips。
- 假设 8（模型列表自动补当前模型）：`LlmPage` 的 `syncDrafts` 增加一次 `adoptCurrentModel(draft)`，让「当前使用的模型」始终在候选列表里占一行 —— 引导页落盘的 provider 是 `modelList: []`，不补这一步则第 6 条的参数 UI 在默认路径下根本不渲染（模型行只在列表非空时存在）。`model` 为空时 `adoptCurrentModel` 原样不动，空白配置仍显示空态；本会话内删掉当前项仍会看到「当前模型已不在列表中」的提示（下一次 `syncDrafts` 才补回来）。
- 待确认：无。

## 范围之外（明确不做）

- 修 `pnpm format:check` 的 44 个存量格式问题与 `pnpm lint` 的 3 个存量 error（本机 autocrlf 造成，与本任务无关；也**不要**对整个仓库跑 `pnpm format` 把无关文件重排）。
- 分类管线自己的采样温度（`apps/desktop/src/main/classify/llm.ts` 的 `0.2`）。
- 生成参数之外的其它 LLM 请求参数（`max_tokens` / `top_p` 等）不新增设置项。
- Center 服务器端与 hub 协议（`packages/center/src/**`）——`llm.switch` 仍是透传。
- 提示条、托盘、其它模式页的 UI 文案（**引导页的 provider 写盘与 temperature 输入框在范围内**，见 step 3）；`general.language` 这类已知死字段。
- 不把「模型能力表」（内置模型 → 上下文窗口的映射）做进来：仍然由用户照服务商文档填。

## 步骤

> 同波可并行：第 1 波：1、6；第 2 波：2；第 3 波：3、4；第 4 波：5；第 5 波：7
> 说明：第 1 波两条互不依赖（step 1 只写 docs，step 6 只写设置页两个 .vue）；第 3 波的 step 3 只碰 main/center 的 .ts、step 4 只碰 chat 的 .vue 与 `capture.ts`，写范围不重叠；step 5（设置页模型参数 UI）与 step 4 都写 `capture.ts`，因此单独排在第 4 波。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-docs-first.md | 文档先行：字段登记、迁移链与 UI 口径 | done | - | `docs/08-settings-onboarding.md`、`docs/06-agent-core.md`、`docs/07-ui-spec.md` |
| 2 | step-02-config-model-params.md | 配置层 v23：modelParams 下沉 + 删 temperature + 迁移 | done | step 1 | `packages/shared/src/config/` |
| 3 | step-03-runtime-center.md | 运行时、引导页与 Center 接线到模型级参数 | done | step 1、2 | `apps/desktop/src/renderer/onboarding/App.vue`、`apps/desktop/src/main/agent-host.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/settings-patch.test.ts`、`apps/desktop/src/main/center/`、`packages/center/web/src/`、`packages/agent-core/src/tools/settings.ts` |
| 4 | step-04-chat-composer.md | 对话窗输入区：权限下拉换行、去键位提示、上下文详解精简、窗口按模型 | done | step 2 | `apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`、`apps/desktop/src/renderer/chat/components/ComposerContextBar.vue`、`apps/desktop/src/main/capture.ts` |
| 5 | step-05-settings-llm-ui.md | 设置页「AI 模型」：模型行参数 + 删 temperature 字段 + 探针同步 | done | step 2、4 | `apps/desktop/src/renderer/settings/pages/LlmPage.vue`、`apps/desktop/src/main/capture.ts` |
| 6 | step-06-settings-misc.md | 设置页杂项：通用页删说明句 + 生图模型空态入口 | done | - | `apps/desktop/src/renderer/settings/pages/GeneralPage.vue`、`apps/desktop/src/renderer/settings/components/ImageGenSection.vue` |
| 7 | step-07-full-regression.md | 全量回归与视觉核对 | done | step 1..6 | `apps/desktop/src/main/capture.ts`、`apps/desktop/src/main/index.ts`、`step/00-index.md` |
| 8 | step-08-archive.md | 归档清理 | done | step 1..7 | `step/` |

## 审查重点

- **迁移正确性**（step 2）：旧配置升级后用户填过的上下文窗口 / 图片开关是否真的落到「当前使用的那个模型」上；迁移幂等；`temperature` 是否真的从配置里消失；`modelParams` 缺失键时消费方是否回落默认（不能读到 `undefined` 崩）。
- **删字段的覆盖面**（step 2/3）：`temperature` 从 Schema 删掉后，任何残留的写入字面量都会被 `pnpm typecheck` 抓到 —— 用 typecheck 当清单，逐处确认没有「删一半」（例如只删 Schema、留着 `agent-host.ts:200` 的读取）。
- **可写面收窄/放宽**（step 2/3）：`WRITABLE_PATH_OVERRIDES` 与 `settings-hint.ts` / 内核工具描述三处必须同口径；`llm.providers.*.modelParams.*.reasoningEffort` 的双 `*` 匹配要有单测钉住，别退化成整组放行（那会把 baseUrl / 凭据子树一起放出去）。
- **探针与夹具**（step 3/4/5）：`SETTINGS_LLM_EFFORT_CHECK` 对 `.temperature` 的存在性断言、`SETTINGS_LLM_MODELS` 的 `[data-field*=".modelList."]` 行计数（加了子字段后计数会虚高，必须换成按 `.model-row` 计数）、`SETTINGS_LLM_MULTIMODAL` 的多 `.vision` 复选框定位，三处是本轮最容易出假 PASS / 假 FAIL 的地方。
- **UI 硬口径**（step 4/5/6）：`chat.context` / `chat.context-usage` / `chat.context-detail` / `chat.context-cache` 四个锚点与 `.ctx-total` 类不得改动；`data-empty="imagegen.providers"` 与 `data-action="edit-provider"` 等既有抓手必须保留；`.composer-bar` 的三枚控件尺寸（`--control-h-xs` + pill + 静止态零边框）逐字不动。
- **模型行为空的分支**（step 5）：`syncDrafts` 必须补 `adoptCurrentModel`，否则引导页建出来的 provider（`modelList: []`）下三枚参数 UI 完全不渲染 —— 那是用户第 6 条的默认路径，也是两条 settings 探针会红的原因。
- **Center 切模型后的占比分母**（step 3）：`llm.switch` 的状态推送不含 `contextWindow`，网页端的 `remoteLlm` 只在选中客户端时拉一次 —— 下沉到模型级后必须补一次 `fetchRemoteConfig`，否则分母停在上一个模型。
- **迁移的非法值回落**（step 2）：`llm.providers` 是 `z.record`，字段级回退对动态键整体保留候选对象，非法旧值若被原样搬进 `modelParams` 会让整份配置被判损坏重建（用户 provider / 凭据一起丢）。迁移必须做同 v4→v5 的归一，并有单测覆盖非法输入。
- **局部重构的连坐**（step 4）：删 `.composer-hint` 时 `.picker-hint` 的 `v-else` 必须一起摘（否则模板编译报错）；删 props 时要连 `defineProps`、`withDefaults` 默认值与 App.vue 的传参一起清，否则留下死传参。

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

### 提交清单

| # | 提交 | 说明 |
|---|------|------|
| 1 | `be96b83` | `docs(config): 登记 v23 模型级参数口径（modelParams 下沉 / 删 temperature / UI 锚点）` |
| 2 | `4a94afa` | `feat(config): 生成参数按模型下沉 modelParams 并删除 temperature，配置升到 v23` |
| 3 | `54f4cf9` | `feat(llm): 主进程/引导页/冒烟夹具改按模型参数取值，请求体不再下发 temperature` |
| 3 | `101be7f` | `fix(center): 网页端与远程切换改读 modelParams，切模型后补拉远端配置` |
| 4 | `6468715` | `fix(chat): 权限下拉说明文字在卡片内折行（不再横向溢出卡片）` |
| 4 | `306aee9` | `fix(chat): 去掉输入区常驻键位提示，上下文详解卡精简为三行，窗口与思考等级按当前模型` |
| 4 | `8252fb6` | `test(capture): 同步对话窗三处探针（权限菜单溢出护栏 / 思考等级模型级 / 详解卡三行）` |
| 5 | `21abf0a` | `feat(settings): AI 模型页的生成参数随模型走（模型行内参数开关），删掉 temperature 字段` |
| 5 | `d8ace1a` | `test(capture): 设置页 LLM 三条探针改按模型级同步，并把参数块滚进视口供拍图核对` |
| 6 | `61ebdbe` | `fix(settings): 通用页删掉会话管理说明句，生图模型空态补上「+ 添加生图模型」主按钮` |
| 6 | `8791873` | `test(capture): AI 模型页拍图前把生图区组滚进视口，供人工核对空态按钮` |
| 审 | `63da971` | `fix(config): 可写覆盖表支持含点的模型 id（** 段），并钉住不放宽的边界` |
| 审 | `c2f7722` | `fix(config): 迁移合并已写条目改用原始值，兑现「旧值补缺键」语义` |
| 审 | `d5d92c6` | `fix(center): 远程切思考等级在 provider 无生效模型时显式报错，不再静默 no-op` |
| 审 | `1fb9be2` | `docs: 清掉 9 处仍指向 provider 级旧路径的注释（v23 已搬到 modelParams）` |
| 审 | `9d5e23c` | `fix(config): modelParams 三个子字段都补默认值，手改配置漏写不再重建整份配置` |
| 审 | `c0b28da` | `test(capture): 补生图空态按钮与「无 temperature」断言，探针保留兄弟字段并加零元素护栏` |
| 审 | `e653bde` | `docs: 补登记可写覆盖表的 ** 段语义，并改准一处 provider 级旧路径` |
| 审 | `4f8b04d` | `fix(settings): 可写判定改回「覆盖表先于黑名单」，兑现 AI 能改模型与思考等级的承诺` |
| 审 | `0091b95` | `fix(center): 远程切档守卫只在本次不改模型时才拦；matchesPattern 拒绝多个 **` |
| 审 | `02f5d77` | `docs: 改准 20 处「reasoningEffort 没有默认值」的过期注释` |
| 审 | `eb9e7ad` | `docs: 改准思考等级下拉的尺寸注释（减负轮起是 28px 而不是 40px）` |
| 审 | `be9bda2` | `fix(config): lookupSpec/lookupEnum 改成逐段匹配，双动态段路径的非法值不再被放行` |
| 审 | `d2e91f5` | `refactor(center): 远程 llm.switch 的四条前置守卫抽成纯函数并补单测（此前零覆盖）` |
| 审 | `9aaf862` | `test(center): 抽出可测的 remote-llm 切片解析并补单测；vitest include 覆盖 packages/*/web/src` |

### step 1（文档先行）—— done

3 个文档按文件分片并行（08 / 06 两个子代理，07 主代理自做），写范围不重叠。要点：三册全部把
`reasoningEffort` / `contextWindow` / `vision` 写成 `llm.providers.<id>.modelParams.<modelId>.<字段>`；
`temperature` 从登记、示例 JSON、可写表、门控表全部删除（只留「v23 删除 / 不再下发」的说明）；
全册版本号 22 → 23；迁移链新增 `v22 → v23`（四条语义）；UI 口径补「模型行内参数 + `toggle-model-params`
开关」「上下文详解卡只留三行」「生图空态必须有可点按钮」「权限菜单文字允许换行」。额外修了 `docs/06 §21.4`
（原文说详解卡里有独立的「缓存命中」行，与本轮三行口径矛盾）。

验证：prettier 三册全绿；`v22 → v23` / `CONFIG_VERSION = 23` 均有命中；`grep 22` 余下 9 处逐条确认都是
历史迁移条目或字段来源标注；`temperature` 三册共 6 处全部在「已删除 / 不再下发」语境。详见 step-01 的
「执行记录」。

### step 2（配置层 v23）—— done

主代理自写两个源文件（`schema.ts` / `migrations.ts` 互为接口，耦合紧），子代理分别改三份测试（写范围不重叠）。
`CONFIG_VERSION` 22 → 23；`modelParams` 落地（`LlmModelParamsSchema` / `LlmModelParams` / `LLM_MODEL_PARAM_DEFAULTS` /
`normalizeModelParams` / `resolveModelParams`）；provider 级 `temperature` 从 Schema 删除，另三字段下沉；
可写覆盖表改成双 `*` 的 `llm.providers.*.modelParams.*.reasoningEffort`；新增 `migrateV22ToV23`（幂等 / 不覆盖已写值 /
空 `model` 不造条目 / 旧非法值归一）。

验证：`shared build` 通过；`vitest run packages/shared/src/config` → 177/177 全绿（含 7 条新用例）；
`grep temperature schema.ts` 无命中；`pnpm build` 全仓成功；`pnpm verify` **26/26**（`version=23`、`count=23/23`）。

**两条遗留（不在本步范围，未修，需在 step 3 的评审里一起看）**：
① `lookupSpec` / `lookupEnum` 只做单段 `*` 替换，双动态段路径的 `fieldAccepts` 查不到登记、按「未登记放行」——
影响**惰性**（该函数只被 `sanitizeWithDefaults` 使用，而它不下钻 `z.record` 子树；且 `mcp.servers[].headersEnc.*`
早就是同一形态），已在 `schema.test.ts` 用一条 `it.fails` 当探针钉住期望行为；
② v23 之后 `modelParams` 子树里的非法值（含漏写没有 `.default()` 的 `reasoningEffort`）没有字段级回退，
会让整份配置被判损坏重建 —— 存量由迁移归一兜住，**写入方必须写全三项**（step 5 的 `normalizedModelParams` 即为此）。

### step 3（运行时 / 引导页 / Center）—— done

提交 `54f4cf9`（主进程运行时 + 引导页 + 冒烟夹具）与 `101be7f`（Center 平价）。两片子代理 + 主代理各领一片，
写范围不重叠。请求装配与图片判定改走 `resolveModelParams`；请求体**不再下发 temperature**；
`switchLlm` 把思考等级写进 `modelParams[新模型]`；引导页删 temperature 输入框；
Center 网页端切片改读模型级参数、切模型后补拉远端配置（否则占比分母停在旧模型）。

**偏离**：新增了 `apps/desktop/src/main/llm-params.ts` + 单测（计划 Writes 未列）—— 因为「`llm.switch` 落值」的真身
在 `index.ts`（import electron，vitest 收不了），而验收要求一条能指到该路径的断言；抽成纯函数后 `index.ts` 三处
调用点共用一份实现，也让「只写一项」这个本步头号风险有了可执行护栏。

验证：`pnpm typecheck` 本步 11 个文件零错误（全仓余下 17 条**全部**落在 step 4 的 `chat/App.vue` 与 step 5 的
`LlmPage.vue`，正是下一步的施工清单）；`vitest run apps/desktop/src/main packages/center` → 65 文件 / 1004 用例全绿；
多模态冒烟段 `AURORA_SMOKE_ONLY='2.8'` → `SUMMARY 133/133 passed`、0 FAIL，含「开启时图片作为 `image_url` 分片、
关闭时不下发」那条。详见 step-03 的「执行记录」。

### step 4（对话窗输入区四处修正）—— done

提交 `6468715`（权限下拉折行）/ `306aee9`（去键位提示 + 详解卡三行 + 参数按模型）/ `8252fb6`（探针同步）。
权限菜单的根因是**继承**了 `.composer-bar` 的 `white-space: nowrap`，修在 `.perm-item-body` 上；
`.composer-hint` 与 `shortcutHint` 删除（键位说明只剩 textarea 的 `title`）；
详解卡只留「输入/窗口/模型」三行，`cachedTokens` 系列计算属性保留（折叠条仍要）；
窗口与思考等级改走 `resolveModelParams`，写回时整份替换 `modelParams[模型]`。

验证：`AURORA_CAPTURE_WINDOWS='chat'` + 5 个场景筛选 → **7 张图全 PASS、`"pass": false` 出现 0 次**，
其中 `noOverflow:true`/`menuOverflow:0`、`detailRows:3` + 标签恰为三行、`restored:true`；
`chat-composer-permission.png` 人工核对：第三项说明**折成两行**且不出卡片、工具行右侧**无**「Enter 发送」、
两枚下拉未被压扁。`typecheck:web` 本步三个 .vue 零错误（余下 13 条全在 `LlmPage.vue` = step 5 清单）。

**子代理的实测发现**：计划给的溢出判据（`.perm-item` 的 `getBoundingClientRect()` 越界）在该布局下**恒真**
（文字溢出的是行盒、读不到）；用最小 Electron 复现验证后，改以 `scrollWidth > clientWidth + 1` 作为真实判据
纳入 `menuOverflow`，矩形断言保留为兜底。详见 step-04 的「执行记录」。

### step 5（设置页 AI 模型）—— done

提交 `21abf0a`（LlmPage 模型行参数）+ `d8ace1a`（capture 探针）。模型行新增 `data-action="toggle-model-params"` 的
「参数」开关与三枚模型级字段（`…modelList.<index>.{reasoningEffort,contextWindow,vision}`），折叠区删掉四个旧字段、
只剩接口类型；`syncDrafts` 补 `adoptCurrentModel`（否则引导页建的 `modelList: []` 下参数 UI 根本不渲染）；
写入口收敛到 `patchParams` / `normalizedModelParams`（整份替换该键对象）。`temperature` 已从该页彻底消失。

**跑动中纠正的两处**：① 三个 `data-field` 必须挂在**外层 label** 上、控件在内部（挂控件上会让
`[data-field$=".reasoningEffort"] select` 取空 → 探针 `value:null`，实测两条 FAIL 后改回）；② 两条 ACT 补了
`scrollIntoView` —— 设置窗固定高度 + 内部滚动，不滚就拍不到行内参数块，人工核对无从做起。

验证：`pnpm typecheck` **全仓 0 错**；`settings-llm` 5 场景全 PASS（`value:"high"`、`visionChecked:true`、
行数 `1→2→1`、`currentRow:true`、`restored:true`）；两张 PNG 人工核对：三枚控件在模型行内、
**整页无 temperature**、折叠区只剩接口类型。

### step 6（设置页杂项）—— done

提交 `61ebdbe`（两处 UI）+ `8791873`（capture 滚动前置）。通用页删掉空壳说明卡与配套注释；生图空态补上
可点的主按钮「+ 添加生图模型」，空态文案不再指向「下面」，`data-empty="imagegen.providers"` 锚点保留。
**偏离**：新增 `SETTINGS_LLM_SCROLL_ACT` 接到 `SETTINGS_PAGE_IDS` 循环的 `act` 上 —— 生图区组在该页最底部，
不滚就永远拍不到那枚新按钮，而「能看到可点的按钮」正是本步唯一的视觉验收。

验证：`settings-general`（`projectsFields:0`）与 `settings-llm`（`imagegenEmpty:true`）两场景 PASS；
两张 PNG 人工核对：通用页「启动」下直接是「外观」（无会话管理说明），AI 模型页能看到空态卡与蓝色主按钮。

### step 7（全量回归与视觉核对）—— done

本步未改源码（全量报告 0 FAIL）。

- **静态门禁**：`pnpm typecheck` 0 错；`pnpm test` **119 文件 / 2117 用例全绿**（基线 118/2101，增量全部来自本轮新增用例，
  无删减）；`pnpm build` 成功；`pnpm verify` **26/26**（`version=23`、迁移 `count=23/23`）。
- **全量冒烟**：`SUMMARY 177/177 passed`、0 FAIL。
  ⚠️ **计划与 `AGENTS.md` 里写的基线「176/176」是陈旧的**：日志实证，本任务开工前（本地 13:17 / 13:24）的全量跑已经是
  `177/177`；把开工前那次的断言名清单与本轮这次**逐条 diff，两者逐字相同** —— 本轮没有增删任何冒烟断言。
- **全量截图**：71 张图 / 71 条检查项，`"pass": false` 出现 **0** 次。
- **视觉核对**（逐张写下「看到什么」）：`chat-composer-permission.png`（菜单第三项折两行不出框、工具行无「Enter 发送」、
  两枚下拉未被挤压）、`settings-llm-params.png`（三枚参数控件在 `deepseek-chat` 行内、**整页无 temperature**、折叠区只剩接口类型）、
  `settings-llm-multimodal.png`（图片输入已勾选、接口类型 Responses API）、`settings-llm.png`（生图空态 + 可点蓝色主按钮）、
  `settings-general.png`（启动下直接是外观，无会话管理说明）；另抽查 `chat-composer-flyouts.png`（详解卡三行不盖工具行）与
  `chat-stream.png`（折叠条仍是「上下文 512 / 128k · 缓存命中 512（100%）」+「累计 528」，与改动前一致 —— 闭合 step 4 的遗留项）。
- **六条问题逐条闭合**，明细见 step-07 的「执行记录」。

**审查重点提醒**：本轮把两处计划外的改动写进了执行记录 —— 新增 `main/llm-params.ts`（含单测）与三处
`scrollIntoView`（两条对话窗 ACT 参数块、一条设置页 ACT 生图区组），理由都是「让计划自己要求的验收/断言可执行」。

### 独立代码审查（6 维度 + 1 次复核）—— 已完成，结论：**可交付**（遗留 4 条 P2/P3，不阻塞）

按 skill 分档：diff ≈ 2000+ 行 + 数据迁移 + 公共接口变更 → 派 6 个只读 `Reviewer` 子代理按维度并行审查
（迁移与配置层 / 可写面与安全边界 / 运行时与 Center / UI 与探针 / 测试质量 / 文档约定与独立复跑），
全部干净上下文；修完两轮后再派 1 个复核代理逐条验证修复。

**审查共发现 1 个 P1 + 若干 P2/P3，全部处置完**：
- **P1（可写面）**：`settings-port.ts` 的可写判定把顺序弄反了 —— 先拿用户配置的
  `advanced.readonlyPrefixes`（默认值即硬编码黑名单的镜像，含 `llm.providers`）做前缀匹配，于是覆盖表对
  `llm.providers.<id>.model` 与 `...modelParams.<modelId>.reasoningEffort` 的放行**一次都没生效过**；
  而 `docs/08 §1` 明文写着「覆盖表先于黑名单」。已修（`4f8b04d`），并**同提交**恢复写路径对含点模型 id 的
  段还原（`splitSettingPath`），否则修好闸门只会把「拒绝」换成「写到错误的键上」。
- **P2（数据安全）**：`modelParams` 漏写 `reasoningEffort`（三兄弟里唯一没有默认值的）会让整份配置被判损坏
  重建、provider / 凭据 / 项目配置一起丢 → 已补 `.default('auto')`（`9d5e23c`），只兜「缺」不放过「错」。
- **P2（迁移）**：迁移语义②承诺「旧值只补缺的键」而实现会整条丢弃 → 已修 + 回归用例（`c2f7722`）。
- 其余 P2/P3：含点模型 id 的 `**` 段支持、远程静默 no-op、探针零元素恒真、生图空态按钮与「无 temperature」
  缺少自动化护栏、两条设置页 ACT 会把兄弟字段写死、约 30 处注释因果失效 —— 逐条修掉或改准。

**遗留 4 条 —— 已按用户要求**在归档前全部处理**（`be9bda2` / `d2e91f5` / `9aaf862`）**：
① `packages/center/web/src/**` 不在 vitest include 内 → include 补 `packages/*/web/src/**/*.test.ts`，
   并把 `extractRemoteLlm` 抽成纯模块 `web/src/remote-llm.ts`（`store.ts` 顶部就 import vue、有模块级副作用）
   补 5 条单测（含「换模型后分母跟着换」「非法值按字段回落」）；
② 远程 `llm.switch` 四条前置守卫零覆盖 → 抽成 `main/llm-params.ts` 的纯函数 `llmSwitchRejection`
   （`index.ts` 的 handler 依赖 Electron、vitest 收不了），补 5 条单测覆盖四条分支 + 「同时改模型与等级」的合法组合；
③ `lookupSpec` / `lookupEnum` 只做单段 `*` 替换 → 改成**逐段比对登记键**（`matchPathPattern`），
   双动态段路径的非法值现在会被正确拒绝；两条「现状断言」翻成期望行为并加正对照。
   剩下「**含点模型 id** 在点分路径里天然有歧义」（`gpt-4.1` 被当成两段）—— 这是点分路径表示的固有歧义，
   对 `fieldAccepts` 仍是惰性（它只被 `sanitizeWithDefaults` 使用，而后者不下钻 `z.record` 子树）；
   写入侧的歧义由 `settings-port.ts` 的 `splitSettingPath` 按已知结构还原，已有往返用例。
④ `advanced.readonlyPrefixes` 无法再封掉覆盖表已放行的叶子 —— 这是 `docs/08 §1`「覆盖表先于黑名单」
   既定语义的必然结果，**不修**（已在此处与 step-07 记录）。

**复核代理实测报告**：14 条修复逐条 `PASS/部分通过`，无新增 P0/P1；`pnpm typecheck` 0 错、
`pnpm test` 119 文件 / 2123 用例全绿、`pnpm verify` 26/26（`version=23`、`count=23/23`）。
遗留项修完后最终门禁：`pnpm typecheck` 0 错、`pnpm test` **120 文件 / 2132 用例全绿**、`pnpm build` 成功、
`pnpm verify` **26/26**、全量 `AURORA_SMOKE` **177/177**、全量 `AURORA_CAPTURE` **71/71 且 0 FAIL**。
