# Step 05 — 设置页「AI 模型」：模型行参数 + 删 temperature 字段 + 探针同步

- Task: ui-detail-fixes
- Step: 5 / 8
- Status: done
- Depends on: step 2、step 4
- Produces: `LlmPage.vue` 里参数随模型行走的编辑 UI（无 temperature 字段），以及 `capture.ts` 里对应场景（`settings-llm-params` / `settings-llm-models` / `settings-llm-multimodal` / `settings-llm-structure`）的探针改写
- Phase: 界面
- Writes: `apps/desktop/src/renderer/settings/pages/LlmPage.vue`、`apps/desktop/src/main/capture.ts`
- Size: L
- Risk: ➊ **模型行为空时整块参数 UI 不存在** —— 模型行只在 `modelList.length > 0` 时渲染（`LlmPage.vue:855-866` 的 `v-if`/`v-else`），而 `adoptCurrentModel` 只在 `onModelInput` / `selectModel` 里调用（`:206 / :213`），`syncDrafts` 不调用。引导页建的 provider 恰恰是 `modelList: []`（`onboarding/App.vue`），所以真实用户路径与截图路径下「当前使用」的模型**没有行**、三枚参数无处可改；探针点 `.model-row.current [data-action="toggle-model-params"]` 会拿到 `null` → `settings-llm-params` / `settings-llm-multimodal` 必然 FAIL。修法见操作 1 的第 3 条。② 探针按 `[data-field*=".modelList."]` 数行 —— 模型行内新增三个子字段（同样以 `.modelList.` 开头）会让**行数虚高**，`SETTINGS_LLM_MODELS_CHECK` 的 `after === before + 1` 判据当场变假 FAIL；必须换成按 `.model-row` 计数；② 直接改 `draft.modelParams[id].xxx` 会写到 settings 快照对象上（`syncDrafts` 用 `...provider` 展开的是同一份引用），必须每份草稿深拷贝一份 `modelParams`；③ 权限相关探针按 `textContent` 子串断言，本轮不动权限文案，但**不要**顺手改 `data-field$=".reasoningEffort"` / `.vision` / `.type` 这三个后缀锚点。
- Risk: ① **模型行为空时整块参数 UI 不存在** —— 模型行只在 `modelList.length > 0` 时渲染（`LlmPage.vue:855-866` 的 `v-if` / `v-else`），而 `adoptCurrentModel` 只在 `onModelInput` / `selectModel` 里调用（`:206 / :213`），`syncDrafts` 不调用；引导页建的 provider 恰恰是 `modelList: []`（`apps/desktop/src/renderer/onboarding/App.vue`），于是真实用户路径与截图路径下「当前使用」的模型没有行、三枚参数无处可改，探针点 `.model-row.current [data-action="toggle-model-params"]` 只会拿到 `null` → `settings-llm-params` / `settings-llm-multimodal` 必然 FAIL（修法见操作 1 的第 3 条）。② 探针按 `[data-field*=".modelList."]` 数行 —— 模型行内新增三个子字段（同样以 `.modelList.` 开头）会让行数虚高，`SETTINGS_LLM_MODELS_CHECK` 的 `after === before + 1` 判据当场变假 FAIL，必须换成按 `.model-row` 计数。③ 直接改 `draft.modelParams[id].xxx` 会写到 settings 快照对象上（`syncDrafts` 用 `...provider` 展开的是同一份引用），必须每份草稿深拷贝一份 `modelParams`。④ `data-field$=".reasoningEffort"` / `.vision` / `.type` 三个后缀锚点与权限相关探针的子串断言不要顺手改。

## 目标

设置页「AI 模型」里，思考等级 / 上下文窗口 / 支持图片输入三项落在**每个模型行内**、随模型绑定；页面上不再有 temperature 字段；四个 `settings-llm-*` 截图探针全绿。

## 输入

- `apps/desktop/src/renderer/settings/pages/LlmPage.vue`：`ProviderDraft` 定义与 `syncDrafts` 在 `:51-140`（`savedDrafts` 重建时用 `...provider` 展开）；模型辅助函数 `mergeModelIds` / `adoptCurrentModel` / `isCurrent` / `modelNotInList` / `onModelInput` / `selectModel` / `addModel` / `isRenaming` / `startRename` / `cancelRename` / `commitRename` / `removeModel` / `normalizedModelList` 在 `:162-286`；上下文窗口归一化 `CONTEXT_WINDOW_MAX` / `clampContextWindow` / `commitContextWindow` 与 `formatContextWindow` 在 `:287-320`；`saveProvider` 的落盘 patch 在 `:400-440`；`syncDrafts` 主体在 `:320-400`。
- 模板：只读态 `llm.contextWindow.readout` 小字在 `:755-762`；模型列表区在 `:836-936`（行容器 `data-field="llm.providers.<id>.modelList.<index>"`、类 `model-row`、单选 `data-action="select-model"`、`data-action="rename-model"` / `remove-model`、空态 `data-empty="llm.providers.<id>.modelList"`）；`.more` 折叠入口在 `:938-952`；折叠区在 `:954-1068`（`type` `:962-972`、`vision` `:978-987`、`temperature` `:989-1002`、`reasoningEffort` `:1004-1019`、`contextWindow` `:1022-1036`、连接测试按钮与模型 chips `:1038-1066`）。
- 空态与添加入口样板：`:669-677`（`data-empty="llm.providers"` + 主按钮）与 `:681-712`（工具行 + `mode === 'add'` 的预设 chips）。
- `apps/desktop/src/main/capture.ts` 里要改的探针：
  - `SETTINGS_LLM_EFFORT_ACT/CHECK`（`:5817-5940`）：ACT 写的 provider 字面量含 `temperature: 0.7` 与 provider 级 `reasoningEffort: 'high'`；CHECK 断言 `effortFields.length > 0 && temperatureFields.length > 0 && value === 'high'`，并在结尾写回 `reasoningEffort: probe.before`。
  - `SETTINGS_LLM_MODELS_ACT/CHECK`（`:6458-6545`）：`countRows = () => document.querySelectorAll('[data-field*=".modelList."]').length`；ACT 的种子 provider 含 `temperature: 0.7`。
  - `SETTINGS_LLM_MULTIMODAL_ACT/CHECK`（`:6655-6760`）：ACT 写 provider 级 `vision: true` 并记 `beforeVision`；CHECK 读 `[data-field$=".vision"] input[type=checkbox]` 与 `saved.vision`，再写回。
  - `SETTINGS_LLM_FIELDS_SCRIPT`（`:5454-5487`）与 `SETTINGS_LLM_STRUCTURE_ACT/CHECK`（`:6553-6650`）：只断言行容器与「一次只开一张卡」，字段搬进模型行后**预期不改**，但要复跑确认。
  - 护栏：`apps/desktop/src/main/capture.probe-strings.test.ts` 会把探针字符串还原成源码做语法检查 —— 探针字符串**内部**的注释不能写反引号（用「」或单引号），改完必须跑它。
- 场景文件名（`AURORA_CAPTURE_ONLY` 按 PNG 文件名子串匹配）：`settings-llm-models.png` / `settings-llm-params.png` / `settings-llm-structure.png` / `settings-llm-multimodal.png`。
- 取值口径（step 2 产出）：`import { LLM_MODEL_PARAM_DEFAULTS, resolveModelParams } from '@aurora/shared/browser'`（渲染层用 `@aurora/shared/browser` 子路径，别引主入口）。

## 操作

1. `LlmPage.vue` 脚本层
   - 新增两个唯一入口：`paramsOf(draft, id)` = `draft.modelParams[id] ?? { ...LLM_MODEL_PARAM_DEFAULTS }`（只读展示用），`patchParams(draft, id, patch)` = 先 `draft.modelParams[id] = { ...paramsOf(draft, id), ...patch }`（写回时**整体替换**该键的对象，不原地改字段）。
   - 新增 `normalizedModelParams(draft): Record<string, LlmModelParams>`：以 `normalizedModelList(draft)` 为键表，为每个 id 产出 `{ ...LLM_MODEL_PARAM_DEFAULTS, ...draft.modelParams[id] }`；列表里没有的键**丢弃**（这样「删掉一行模型」在保存时就自然清掉它的参数，无需在 `removeModel` 里做清理）。
   - `commitRename`（`:258-276`）：新旧 id 都非空且两者不同时，把 `draft.modelParams[previous]` 搬到 `draft.modelParams[next]`（用 `patchParams` 写、再 `delete draft.modelParams[previous]`），**并且**当 `previous === currentModel` 时参数跟着新 id 走（`model` 同步改了，键必须一起搬，否则新模型读回默认值）。
   - `clampContextWindow` / `formatContextWindow` 保留；`commitContextWindow` 改成 `commitContextWindow(draft, id, event)` 并走 `patchParams(draft, id, { contextWindow: clampContextWindow(...) })`。
   - `syncDrafts`（`:320-400`）：重建每份草稿时把 `modelParams` **深拷贝**成新对象（`Object.fromEntries(Object.entries(provider.modelParams ?? {}).map(([k, v]) => [k, { ...v }]))`），否则编辑卡改的是 settings 快照里的同一个对象。
   - **`syncDrafts` 里补一次 `adoptCurrentModel(draft)`**（复用旧引用的编辑草稿与重建出来的草稿都要过一遍）：让「当前使用的模型」始终在候选列表里占一行，空列表 → 行数 1。这不只是为了探针：引导页落盘的 provider 是 `modelList: []`，不补这一步，第 6 条对默认用户路径只交付一半（参数 UI 根本渲染不出来）。`adoptCurrentModel` 已有的「`model` 为空则不动」语义正好让空白配置仍显示空态。`modelNotInList` 的提示与「删掉当前项不静默换模型」的语义一并保留（本会话内删行仍会看到提示，直到下一次 `syncDrafts`）。
   - `saveProvider` 的落盘 patch（`:414-436`）：删掉 `temperature` / `contextWindow` / `vision` / `reasoningEffort` 四行，改成 `modelParams: normalizedModelParams(draft)`；其余（`type` / `baseUrl` / `apiKeyEnc` / `model` / `modelList`）不动。
2. `LlmPage.vue` 模板层
   - 模型列表行（`:860-925`）：在「重命名 / 删除」旁加一枚参数开关 `<AppButton size="sm" variant="ghost" data-action="toggle-model-params">参数</AppButton>`（`aria-expanded` 绑该行是否展开）；行尾追加一个 `v-if` 展开块，内含三个字段：
     - 思考等级：`data-field="llm.providers.<id>.modelList.<index>.reasoningEffort"`，`<select>` 选项仍取 `REASONING_EFFORT_LABELS[level].full`；
     - 上下文窗口：`data-field="llm.providers.<id>.modelList.<index>.contextWindow"`，`type=number`（`min=0 max=2000000 step=1000`），`@change` 走 `commitContextWindow`，hint 沿用今天那句（单位 token、只作占比分母、0 = 未知）；
     - 支持图片输入：`data-field="llm.providers.<id>.modelList.<index>.vision"`，`<input type="checkbox" data-action="toggle-vision">`，文案「把拖入的图片交给这个模型」（**注意**：写「拖入」，不要写成「插入」）。
   - 展开态用一个 `reactive` 的 `paramsOpen` 映射（键 `${draft.id}:${index}`，与既有的 `renamingModel` / `advancedOpen` 同一套写法），一次可开多个模型行（它不涉及浮层互斥）；`removeModel` / `commitRename` 后按既有惯例收起（`closeRename` 同款）。
   - 删掉折叠区里的「支持图片输入」（`:978-987`）、「temperature」（`:989-1002`）、「思考等级」（`:1004-1019`）、「上下文窗口」（`:1022-1036`）四个 `SettingField`；折叠区只留「接口类型」（保留 `data-field="llm.providers.<id>.type"` 与注释）、连接测试/拉取按钮与模型 chips。
   - 删掉只读态的 `llm.contextWindow.readout` 小字（`:755-762`）；改为在当前使用的模型行内（`isCurrent` 为真时）用小字显示 `窗口 {{ formatContextWindow(paramsOf(draft, item).contextWindow) }}`，`contextWindow > 0` 才渲染，锚点 `data-field="llm.providers.<id>.modelList.<index>.readout"`（保留同一个 `formatTokenCount` 口径）。
3. `capture.ts` 探针同步（改前先读整段，注意 template literal 内不能写反引号）
   - `SETTINGS_LLM_EFFORT_ACT`：种子 provider 字面量删 `temperature: 0.7`、删 provider 级 `reasoningEffort`；先算出合并后真正生效的模型 id（`const modelId = (existing ?? {}).model ?? 'deepseek-chat'`），再写 `modelParams: { ...(existing?.modelParams ?? {}), [modelId]: { reasoningEffort: 'high', contextWindow: 0, vision: false } }`；`probe.before` 记成「该模型原来的 `reasoningEffort`（缺省 `'auto'`）」。展开动作在点 `.more` 之后**再点当前使用模型那一行的** `[data-action="toggle-model-params"]`（用 `.model-row.current` 定位，别取第一个——onboarding 会先种一个 local provider）。
   - `SETTINGS_LLM_EFFORT_CHECK`：删掉 `temperatureFields` 相关断言与返回字段；改用 `.model-row.current` 作用域里的 `[data-field$=".reasoningEffort"] select` 判 `value === 'high'`；写回时改成写回 `modelParams[modelId].reasoningEffort`（`restored === true` 的判据保留）。
   - `SETTINGS_LLM_MODELS_ACT` 与 `SETTINGS_LLM_MODELS_CHECK`：`countRows` 改成 `document.querySelectorAll('[data-field$=".modelList"] .model-row').length`（作用域限定在该 provider 的模型列表区，避免数到别人的卡）；ACT 种子 provider 的 `temperature` 换成 `modelParams`，并**显式带上 `modelList: ['deepseek-chat']`**（夹具写死，别依赖 `syncDrafts` 的自动补行 —— 「+ 手动添加加一行」的行数断言需要确定的起点）；CHECK 的 `restored === before` 判据与 `data-action="add-model"` / `remove-model` / `[data-empty$=".modelList"]` 定位不变。
   - `SETTINGS_LLM_MULTIMODAL_ACT`：ACT 写 provider 时 `temperature` / 三个按钮字段改成 `modelParams: { deepseek-chat: { reasoningEffort: 'auto', contextWindow: 0, vision: true } }`（`model` 写 `'deepseek-chat'`）；`probe.beforeVision` 记成 `existing?.modelParams?.['deepseek-chat']?.vision === true`；展开动作在 `.more` 之后补一次 `.model-row.current` 的 `[data-action="toggle-model-params"]`。
   - `SETTINGS_LLM_MULTIMODAL_CHECK`：DOM 判据改成 `scope.querySelector('.model-row.current [data-field$=".vision"] input[type=checkbox]')`；配置回读改成 `saved.modelParams['deepseek-chat']?.vision === true`；写回时把 `vision` 写回 `modelParams`（`beforeVision`），`restored` 判据保留。
   - 复跑确认不改动即可通过：`SETTINGS_LLM_FIELDS_SCRIPT`（`data-field="llm.providers.<id>"` 行容器计数、`imagegen.*` 锚点）与 `SETTINGS_LLM_STRUCTURE_ACT` / `SETTINGS_LLM_STRUCTURE_CHECK`（一次只开一张卡）。
4. 顺手核对引导页与 Center 网页端对 `modelList` 的用法：本轮它们不在写范围内（`modelList` 仍是 `string[]`），只需确认没有引用已删除的 provider 级字段（typecheck 会报）。

## 分片建议

- 片 A：`LlmPage.vue` 脚本层（操作 1）。
- 片 B：`LlmPage.vue` 模板与样式（操作 2）。
- 片 C：`capture.ts` 的三个探针（操作 3）。
- 片 A 与片 C 可并行；片 B 必须在片 A 之后（依赖新函数名）。三片合计仍是一个可独立验收的整体。

## 验收标准

- [ ] `pnpm typecheck` 全绿。
- [ ] `pnpm vitest run apps/desktop/src/main` 全绿（含 `capture.probe-strings.test.ts` 对探针字符串的语法护栏）。
- [ ] `grep -n "adoptCurrentModel" apps/desktop/src/renderer/settings/pages/LlmPage.vue` 至少命中 3 处（定义 + `onModelInput` + `selectModel` + `syncDrafts`）。
- [ ] 截图探针（**串行跑，别与 step 4 同波**）：PowerShell 下先 `Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`，再
      `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-llm"; $env:AURORA_CAPTURE_WINDOWS='settings'; $env:AURORA_CAPTURE_ONLY='settings-llm'; pnpm dev`
      结束后读 `report.json`：`settings-llm-models` / `settings-llm-params` / `settings-llm-structure` / `settings-llm-multimodal` 四条**全 PASS**；有 FAIL 时按 `report.json` 里的探针返回值定位（本步最可能假 FAIL 的是模型行计数与 `.vision` 定位）。
- [ ] 打开 `settings-llm-params.png` 与 `settings-llm-multimodal.png` 人工核对：模型行内能看到思考等级 / 上下文窗口 / 支持图片输入三个控件；**整页不再出现 temperature 字样**；接口类型仍在 provider 折叠区。
- [ ] `report.json` 里 `settings-llm-params` / `settings-llm-multimodal` 的返回值要能看到「当前模型行存在」的证据（探针在点 `[data-action="toggle-model-params"]` 之前先断言 `[data-field$=".modelList"] .model-row.current` 存在，不存在就以带文案的失败返回，而不是静默 `null`）。
- [ ] `grep -n "temperature" apps/desktop/src/renderer/settings/pages/LlmPage.vue` 无命中。

## 交接

- 模型行参数锚点契约（step 4、step 7 与后续维护都用它）：`llm.providers.<id>.modelList.<index>.{reasoningEffort,contextWindow,vision}`、行读数 `…modelList.<index>.readout`、行内开关 `data-action="toggle-model-params"`、复选框 `data-action="toggle-vision"`。
- 模型列表的展示口径变了：打开编辑卡时当前生效模型总会占一行（`syncDrafts` 里的 `adoptCurrentModel`），落盘时 `modelList` 仍归一为「候选列表 ∪ {`model`}」；引导页那句「候选列表留空、之后在设置里维护」指的是**落盘值**，仍然成立，不用改注释。
- 落盘口径：保存时 `modelParams` 由 `normalizedModelParams` 生成（键表 = `modelList` ∪ `{model}`，值缺省回落 `LLM_MODEL_PARAM_DEFAULTS`，列表外的键被丢掉）。
- 探针契约变化：`SETTINGS_LLM_EFFORT_CHECK` 不再断言 `.temperature` 存在；`SETTINGS_LLM_MODELS_*` 的行数按 `.model-row` 计；`SETTINGS_LLM_MULTIMODAL_*` 按当前模型行定位。

## 执行记录

**提交：`21abf0a`（LlmPage 模型行参数）+ `d8ace1a`（capture 探针同步）**

### 实现分片
- 子代理 → `capture.ts` 的五个 `settings-llm-*` 探针（操作 3）
- 主代理 → `LlmPage.vue` 脚本层 + 模板/样式层（操作 1、2 —— 同一文件且模板依赖脚本层的新函数名，串行自做）

### 实际改动
- 脚本层：新增 `paramsOf` / `patchParams` / `normalizedModelParams` / `paramsExpanded` / `toggleParams` / `closeParams` / `transferModelParams`；`commitContextWindow` 改成按模型 id 写；`commitRename` 重命名时把参数一起搬到新 id；`syncDrafts` 深拷贝 `modelParams` 并**补一次 `adoptCurrentModel`**（引导页落盘的 provider 是 `modelList: []`，不补这一步模型行不存在、三枚参数根本没入口）；`saveProvider` 的 patch 用 `modelParams: normalizedModelParams(draft)` 取代原来那四行；`addPreset` 的新草稿同样按模型 id 建表。
- 模板层：模型行由单层 flex 改成「`.model-row`（纵向）+ `.model-line`（横向行内容）+ `.model-params`（展开块）」，行内新增 `data-action="toggle-model-params"` 的「参数」开关与三枚带锚点的字段（`…modelList.<index>.{reasoningEffort,contextWindow,vision}`），当前使用的那一行另给 `…readout` 小字；**删掉**折叠区里的 图片输入 / temperature / 思考等级 / 上下文窗口 四个 `SettingField` 与行上的 `llm.contextWindow.readout`，折叠区只剩接口类型 + 按钮 + chips。

### 两处与计划不同（都已在跑动中验证过）
1. **三个 `data-field` 挂在**外层 `<label>` **上、控件在它内部**。计划操作 2 写的是「`data-field="…"`，`<select>` 选项…」这种平铺描述，我第一版把锚点直接挂在控件上，结果两条探针 FAIL：`settings-llm-params` 读到 `value:null`（探针是 `[data-field$=".reasoningEffort"] select` —— 在自己身上找 `select` 找不到），`settings-llm-multimodal` 读到 `visionChecked:null`（同理）。改成外层 label 携带锚点后两条立刻 PASS。这也是 `SettingField` 的既有口径。
2. **给两条 ACT 补了 `scrollIntoView`**（`capture.ts`，两家共用同一段代码，`replace_all` 改的）。设置窗是**固定高度 + 内部滚动**，不滚的话 `settings-llm-params.png` / `settings-llm-multimodal.png` 停在页头，「参数在模型行内」这条人工核对项无从核对 —— 而它正是本步验收里唯一能发现「布局崩了」的手段（DOM 探针只证明控件在，不证明画得对）。只滚 DOM、不改配置，check 判据不受影响。

### 验证（主代理复跑）
- `pnpm typecheck` → **全仓 0 错**（本步之前余下的 17 条全部消掉）。
- 截图探针：`AURORA_CAPTURE_WINDOWS='settings'` + `AURORA_CAPTURE_ONLY='settings-llm'` → **5 张图全 PASS**：
  - `settings-llm-params`：`currentRow:true`、`effortFields:1`、`value:"high"`、`restored:true`；
  - `settings-llm-multimodal`：`visionChecked:true`、`typeValue:"openai-responses"`、`savedOk:true`、`restored:true`；
  - `settings-llm-models`：`rowsBefore:1` → `rowsAfterAdd:2` → `rowsAfterRestore:1`（**按 `.model-row` 计数**，不再用 `[data-field*=".modelList."]`）；
  - `settings-llm-structure` 与 `settings-llm` 亦 PASS。
- **人工核对两张 PNG**（Read 工具逐张看）：
  - `settings-llm-params.png`：`deepseek-chat` 行内可见「思考等级 = high（更深入）」「上下文窗口 = 0」「☐ 把拖入的图片交给这个模型」三个控件 + 一行说明，左侧有竖线区分层级；**整页无 temperature 字样**；「高级参数与连接测试」折叠区里**只剩接口类型**（OpenAI 兼容 /chat/completions）+ 保存并测试连接 / 拉取模型列表。
  - `settings-llm-multimodal.png`：同一位置显示「思考等级 = auto（不指定，兼容性最好）」「上下文窗口 = 0」「☑ 把拖入的图片交给这个模型」，接口类型为 `OpenAI Responses API (/responses)`。
- `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` → 2/2 绿（探针字符串语法护栏）。
- `grep -n "temperature" apps/desktop/src/renderer/settings/pages/LlmPage.vue` → **无命中**；`grep -c adoptCurrentModel LlmPage.vue` → 6（≥3 达标）。

### 遗留问题
- 子代理提醒的一条**定向风险**：`SETTINGS_LLM_MODELS_CHECK` 的新选择器（按 `.model-row` 计数）在旧 DOM 上也恰好给出 `1→2→1`，所以那次 PASS 不能证明「行内子字段不再虚高」；本次在**新 DOM**（行内已有三个子字段）上实跑仍是 `1→2→1`，该口径已真实覆盖。
- `settings-llm.png`（生图空态）的人工核对不在本步，归 step 6/7。
