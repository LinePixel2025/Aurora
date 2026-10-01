# Step 01 — 文档先行：字段登记、迁移链与 UI 口径

- Task: ui-detail-fixes
- Step: 1 / 8
- Status: done
- Depends on: none
- Produces: 三册文档里改造后的字段登记、v22 → v23 迁移条目与 UI 口径（后续步骤以它为准）
- Phase: 基础与配置
- Writes: `docs/08-settings-onboarding.md`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`
- Size: M
- Risk: 文档与实现口径漂移 —— 本步写下的字段名与路径就是后面三步的施工图，写错会连锁到 step 2/3/4/5；落笔前先读 `packages/shared/src/config/schema.ts:146-181` 与 `apps/desktop/src/renderer/chat/components/ComposerContextBar.vue` 确认现状，不要凭印象写。

## 目标

把本轮改造的口径先写进单一事实来源（docs），使「字段长什么样、迁移怎么搬、界面怎么呈现」在动代码之前就固定下来；文档里不再有任何字段停留在「provider 级」的旧口径。

## 输入

- `docs/README.md`（SSOT 入口与分册导航）。
- `docs/08-settings-onboarding.md`：§1 示例 JSON 在 `:45-52`；`modelList` 登记在 `:277-285`；`contextWindow` 登记在 `:286-294`；`type` 在 `:296-300`；`vision` 在 `:301-304`；`WRITABLE_PATH_OVERRIDES` 说明在 `:317-318`；迁移链清单在 `:589-633`（`:633` 写着「当前 `CONFIG_VERSION = 22`」）；§5 UI 规格在 `:690-728`。
- `docs/06-agent-core.md`：§3 的 provider / 模型选拔口径在 `:41-51`（`:47-51` 把「思考等级是 provider 级」记成已知取舍）；§3.1 图片能力在 `:74-76`；请求体温度口径在 `:97` 与 `:173-176`；§12.2 覆盖表在 `:1089-1091`；§16.2 上下文用量口径在 `:1478-1500`；§17 settingsHint 在 `:1586-1588`。
- `docs/07-ui-spec.md`：§2.3 输入区在 `:540-560`（`:551` 写着键位提示挂 `.composer-hint`）、上下文详解条与模型/思考下拉在 `:604-640`、`data-field` 契约在 `:168-172` 与 `:515-526`；探针场景清单在 `:1136` 与 `:1481-1518`。
- 本轮已确认的设计口径（用户拍板 + 调研结论，逐条照写）：
  - 新字段：`llm.providers.<id>.modelParams` 是 `Record<modelId, { reasoningEffort, contextWindow, vision }>`，`modelList` 保持 `string[]`。
  - 删除字段：`llm.providers.<id>.temperature`（配置、界面、请求体三处全删，请求不再下发 temperature）。
  - 迁移：新增一条 **v22 → v23**，把 provider 级的 `reasoningEffort` / `contextWindow` / `vision` 搬到 `modelParams[provider.model]`（`model` 为空串时写 `{}`），并删除 provider 级的这四个键。
  - 缺省回落：读 `modelParams[modelId]` 未命中时回落 `{ reasoningEffort: 'auto', contextWindow: 0, vision: false }`；shared 提供一个唯一入口 `resolveModelParams(provider, modelId?)`，主进程 / 渲染层 / Center 都走它。
  - 界面：设置页「AI 模型」的模型行内展开参数（思考等级 / 上下文窗口 / 支持图片输入），provider 级折叠区只留接口类型与连接测试；「上下文详解」卡只留「本轮输入 / 上下文窗口 / 模型」三行；输入行不再有键位提示；生图模型空状态给出「+ 添加生图模型」主按钮。

## 操作

1. `docs/08-settings-onboarding.md`
   - §1 字段登记：删除 `temperature` 整条；把 `contextWindow`（`:286-294`）与 `vision`（`:301-304`）的登记改写为 `llm.providers.<id>.modelParams.<modelId>.contextWindow` / `.vision`，并在 `modelList`（`:277-285`）之后新增 `modelParams`（v23）登记段：说明它是按模型 id 键的参数表、三字段各自的默认值与约束（`contextWindow` 0–2000000、`vision` 布尔、`reasoningEffort` 是 `auto|low|medium|high`）、未命中键时由 `resolveModelParams` 回落默认、以及「`reasoningEffort` 是随模型绑定的」这条口径（替代 `docs/06 §3` 里那句 provider 级已知取舍，见第 3 条）。
   - §1 示例 JSON（`:45-52`）：把 `temperature` 去掉，把 `contextWindow` / `vision` 改成嵌套在 `modelParams` 下的写法，`reasoningEffort` 一并移进去。
   - 可写表说明（`:317-318`）：把放行项从 `model / reasoningEffort / temperature` 改为 `model / modelParams.<modelId>.reasoningEffort`，并写明 `temperature` 已随 v23 删除、`modelParams` 下的 `contextWindow` / `vision` 仍只读（它们是模型能力事实，不是偏好）。
   - 迁移链清单与**全册版本号**（`:582-636`）：新增一条 `v22 → v23` 条目，写清搬运语义与「幂等、不覆盖已写值、`model` 为空时不造模型条目」；把这一段里的版本号与条数（`:582` 的「当前 `CONFIG_VERSION = 22`」、`:636` 的「随之变为 22 条」）改成 23。
   - **同册其它自称版本号的位置也要一起改**（只改迁移链那段会让 SSOT 自相矛盾）：`:270` 的「当前 `CONFIG_VERSION` 已是 **22**」、`:520` 的「不改 `CONFIG_VERSION`（当前为 22）」；`:883` 的字段门控表里 `llm.providers.*（含 temperature / reasoningEffort / modelList）` 要去掉 temperature 并改写成 `modelParams`。
   - §5 UI 规格（`:690-728`）：把「折叠区含接口类型、图片输入、temperature、思考等级」改成「折叠区只含接口类型 + 连接测试；思考等级 / 上下文窗口 / 支持图片输入在模型行内、随模型绑定，锚点是 `llm.providers.<id>.modelList.<index>.<字段>`，行上有 `data-action="toggle-model-params"` 的展开开关」；补两条：上下文详解卡只呈现本轮输入 / 上下文窗口 / 模型三行；生图模型空状态必须有可点的「+ 添加生图模型」按钮（锚点保持不变）。
2. `docs/06-agent-core.md`
   - §3（`:41-51`）：删掉「temperature 等参数可调」里的 temperature；把 `:47-51` 那段「思考等级是 provider 级」的已知取舍改写成「v23 起随模型绑定（`llm.providers.<id>.modelParams.<modelId>.reasoningEffort`），`model` 是唯一生效值、参数随之取」。
   - §3.1（`:74-76`）：能力开关判据从 `llm.providers.<id>.vision` 改成「当前生效模型在 `modelParams` 里的 `vision`」，缺省仍是**关**。
   - 请求体温度口径（`:97` 与 `:173-176`）：改成「v23 起不再下发 `temperature`：主流 Agent（Claude Code / Codex 一类）不设该参数，由服务商默认值决定；内核的 `ProviderConfig.temperature` 能力保留但桌面装配层不再喂值」。
   - §12.2（`:1089-1091`）与 §17（`:1586-1588`）：可写清单里删 temperature、把 reasoningEffort 写成 `llm.providers.<id>.modelParams.<modelId>.reasoningEffort`。
   - §16.2（`:1478-1500`）：把「上下文窗口」的分母来源改写成当前模型的 `modelParams.<modelId>.contextWindow`，并说明界面只保留本轮输入 / 窗口 / 模型三行。
3. `docs/07-ui-spec.md`
   - §2.3 输入区（`:540-560`）：删除「键位提示挂工具行右侧 `.composer-hint`」这条（本轮移除该常驻提示，`.picker-hint` 瞬时提示保留）；工具行元素清单同步成「权限 + 模型 + 思考 + 弹性槽 + 瞬时提示 + 麦克风 + 停止/发送」。
   - 模型列表口径（`:604-640`）：补一句「打开编辑卡时，当前生效模型**总会**占一行（渲染层在重建草稿时把 `model` 补进候选列表），所以新建 provider（引导页落盘的是 `modelList: []`）也能就地配置它的模型级参数；落盘时 `modelList` 仍会被归一为「候选列表 ∪ {`model`}」」。
   - 上下文详解条与模型/思考（`:604-640`）：分母来源改成当前生效模型的 `modelParams.contextWindow`；思考等级读写路径改成 `llm.providers.<active>.modelParams.<model>.reasoningEffort`；卡片内容改成「本轮输入 / 上下文窗口 / 模型」三行 + 缺用量时一句说明。
   - 权限下拉：在 §2.3 里补充「菜单项说明文字允许换行；文案是两短句（有项目 / 无项目两态），且必须保留子串『完全权限』『再点一次确认』（capture 探针按子串断言）」。
   - 探针场景清单（`:1136` / `:1481-1518`）：把「断言 `.temperature` 字段在」这条删掉，改成「断言模型行内的 `.contextWindow` / `.vision` / `.reasoningEffort` 字段在、且值来自配置」。

## 验收标准

- [ ] `pnpm prettier --check docs/08-settings-onboarding.md docs/06-agent-core.md docs/07-ui-spec.md` 退出码 0（本机只对**改动文件**要求格式干净，仓库存在与本次无关的 44 个存量格式问题，见 `step/00-index.md` 的基线）。
- [ ] `grep -n "v22 → v23" docs/08-settings-onboarding.md` 有命中；`grep -n "CONFIG_VERSION = 23" docs/08-settings-onboarding.md` 有命中。
- [ ] `grep -n "22" docs/08-settings-onboarding.md` 里**不再有**把当前版本说成 22 的行（逐条看：允许出现的是「v21 → v22」这类历史迁移条目与行号无关的历史描述）。
- [ ] `grep -n "modelParams" docs/08-settings-onboarding.md docs/06-agent-core.md docs/07-ui-spec.md` 三册都有命中。
- [ ] `grep -rn "temperature" docs/08-settings-onboarding.md docs/06-agent-core.md` 的命中**只**出现在「v23 删除该字段 / 不再下发」的说明语境里，没有任何一处还把它写成可配项或可写路径。
- [ ] 人工核对：按本文档口径，后面四步要写的字段名与锚点能逐字在这一步改完的文档里找到（`modelParams`、`resolveModelParams`、`toggle-model-params`、`llm.providers.<id>.modelList.<index>.<字段>`）。

## 交接

- 字段名与语义（后续步骤逐字沿用）：`llm.providers.<id>.modelParams` : `Record<string, { reasoningEffort, contextWindow, vision }>`；缺省回落入口 `resolveModelParams(provider, modelId?)`；`temperature` 已从 Schema 消失。
- 迁移编号：新增 `migrateV22ToV23`，`CONFIG_VERSION` 从 22 推到 23，迁移链总条数与版本号同增（`scripts/verify-p1.mjs:155-161` 断言 `appliedMigrations.length === CONFIG_VERSION`，加迁移后该断言自动跟上）。
- UI 锚点契约：模型行参数开关 `data-action="toggle-model-params"`，字段锚点 `llm.providers.<id>.modelList.<index>.{reasoningEffort,contextWindow,vision}`；`chat.context` / `chat.context-usage` / `chat.context-detail` / `chat.context-cache` 与 `.ctx-total` 保持不变。

## 执行记录

**提交：`be96b83`**（`docs(config): 登记 v23 模型级参数口径（modelParams 下沉 / 删 temperature / UI 锚点）`）

### 实现分片
3 个文档按**文件**分片、写范围严格不重叠：
- 子代理 A → `docs/08-settings-onboarding.md`（字段登记 / 示例 JSON / 可写表 / 全册版本号 / §5 UI 规格 / 门控表）
- 子代理 B → `docs/06-agent-core.md`（§3、§3.1、§3.2 请求体口径、§12.2、§16.2、§17）
- 主代理 → `docs/07-ui-spec.md`（§2.3 输入区 / 模型与思考口径 / 上下文详解条 / 权限下拉换行 / 探针场景清单）

### 实际改动
- `docs/08-settings-onboarding.md`：删 `temperature` 登记与示例 JSON 键；`reasoningEffort` / `contextWindow` / `vision` 三条登记改写为 `llm.providers.<id>.modelParams.<modelId>.<字段>`；新增 `modelParams`（v23）登记段（三字段默认值与约束、唯一入口 `resolveModelParams`、`modelList` 仍 `string[]`）；可写表放行项改为 `model / modelParams.<modelId>.reasoningEffort`（`contextWindow` / `vision` 明记只读）；**全册版本号 22 → 23**（`:5` / `:9` / `:277` / `:554` / `:616` / `:679-681`）；迁移链新增 `v22 → v23` 条目（幂等 / 不覆盖已写值 / `model` 为空不造条目 / 旧非法值归一，共四条语义）；§5 UI 规格改成「折叠区只留接口类型 + 连接测试、三参数在模型行内、随模型绑定」，并补「上下文详解卡只留三行」与「生图空态须有可点按钮」两条；字段门控表去掉 temperature。
- `docs/06-agent-core.md`：§3 删掉「思考等级是 provider 级」的已知取舍、改为 v23 起随模型绑定（给出 `modelParams` shape 与 `resolveModelParams`）；§3.1 图片能力判据改为当前生效模型的 `modelParams` 里的 `vision`（缺省仍关）；§3.2 请求体口径补「v23 起不下发 `temperature`，内核 `ProviderConfig.temperature` 能力保留但装配层不喂值」（`max_output_tokens` 那句原样保留）；§12.2 / §17 可写清单同口径；§16.2 分母改为模型级并写明界面只留三行；**额外修 §21.4** —— 它原写「展开的详解卡里是独立一行『缓存命中（最近一轮）』」，与本轮「详解卡只剩三行」直接矛盾，计划未点名但不改就是 SSOT 自相矛盾。
- `docs/07-ui-spec.md`：工具行元素清单去掉键位提示（`.composer-hint` 已移除，键位说明只留在 textarea 的 `title`）；「思考等级 / 模型选择」两节改读当前生效模型的 `modelParams`；补「打开编辑卡时当前生效模型总会占一行」；补权限下拉换行口径（`.perm-item-body` 的 `white-space: normal` 是根治点 + 必须保留『完全权限』『再点一次确认』子串）；上下文详解条分母改模型级、明细卡改三行；探针清单三处同步（`SETTINGS_LLM_EFFORT_CHECK` 的 `.temperature` 存在性断言 → 模型行内三字段；`SETTINGS_LLM_MODELS_CHECK` 行数改按 `.model-row` 计；`CHAT_THINKING_LEVEL_CHECK` 的配置路径改模型级）。

### 验证（主代理复跑，命令与真实输出）
- `npx prettier --check docs/08-settings-onboarding.md docs/06-agent-core.md docs/07-ui-spec.md` → `All matched files use Prettier code style!`，exit 0 ✓
- `grep -n "v22 → v23" docs/08-settings-onboarding.md` → 3 命中（`:308` / `:322` / `:668`）✓
- `grep -n "CONFIG_VERSION = 23" docs/08-settings-onboarding.md` → 1 命中（`:616`）✓
- `grep -n "22" docs/08-settings-onboarding.md` → 9 命中，逐条核对**全部**是历史迁移条目（`v21 → v22` / `v22 → v23`）或字段来源标注（「v22 新增 / v22 扩枚举」），**没有一行仍把当前版本说成 22** ✓
- `grep -c modelParams` → 08: 24 / 06: 7 / 07: 3；`resolveModelParams` → 08: 1 / 06: 3；`toggle-model-params` → 08: 3 / 07: 1；`modelList.<index>` → 08: 3 / 07: 1 ✓（后续四步要写的字段名与锚点都能逐字在文档里找到）
- `grep -n temperature` 三册 → 08 三处、06 两处、07 一处，**全部**落在「v23 删除该字段 / 请求不再下发 / 内核能力保留但装配层不喂值 / 探针不再断言它存在」的语境，无一处写成可配项或可写路径 ✓

### 遗留问题
无阻塞项。`temperature` 与 `modelParams` 的**代码侧**落地由 step 2/3/4/5 完成；本步只把口径写进 SSOT。计划给的两处行号已漂移（step-01 的「§3 请求体温度 `:173-176`」现为 §4 的 `user-message` 事件，与本字段无关），已按内容定位而非行号。
