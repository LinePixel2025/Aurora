# Step 05 — 模型列表建模 + 模型页「模型设置」区 + 对话窗模型选择器

- Task: chat-window-ux-fixes
- Step: 5 / 8
- Status: done
- Depends on: step 4
- Produces: `llm.providers.*.modelList` 配置字段 + 模型页的模型列表编辑区 + `ModelPickerSelect.vue` + 对话窗模型选择器 + 两条 capture 探针

## 目标

用户追加的两条要求一起落地：
① **模型页要有「模型设置」**——一个 provider 下可以维护一份模型列表（拉取 / 手动添加 / 删除），
   并在其中指定当前使用的那一个；
② **对话窗口要有选择模型的选项**——和 step 3 的思考等级并排，切换后下一次请求就用新模型。

两者必须是**同一份数据**：模型页维护列表，对话窗从同一份列表里选，不允许各自维护一套。

## 设计依据与取舍

- 参考 DSH 的模型设置页（`.../dsh-client-ui-settings-models/lib/types/client/DeepSeekModelsEditor.d.ts`、
  `ModelListEditor.d.ts`、`ModelRow.d.ts`）：每个模型是一**行可展开条目**（id / 显示名 / 容量字段 + 删除），
  行内可选；「拉取模型列表」把发现的 id 追加进这份列表。Aurora 的 Schema 比它简单，
  本步按**字符串数组**建模（`modelList: string[]`），每行的可编辑字段只有模型 id。
- 参考它对思考等级的判断（`ProviderEditor.d.ts` 的注释）：reasoning effort 属于**模型级能力**。
  Aurora 当前把它存在 provider 级（`llm.providers.*.reasoningEffort`），本步**不**改成模型级映射
  ——那会让 step 3 的控件、迁移与两处 UI 全部重做。折中并在文档里写清：
  「思考等级作用于当前 provider 下的所有模型；将来若要按模型区分，需要扩展成 `effortByModel`」。

## 硬约束

0. ⚠️ **写冲突**：本步与 step 3、step 6 都要新增常量并改 `apps/desktop/src/main/capture.ts` 的
   `defaultCapturePlan`。**不要并行改这个文件**——串行执行（3 → 5 → 6），或指定一人独占并在完事后通知其余步骤。
1. **不许把 `llm.providers.*` 移出 `set_setting` 的黑名单**（step 2 定的），
   也不要把模型列表纳入 AI 可写范围——凭据与该子树由用户侧 UI 独占。
2. `apps/desktop/src/main/capture.ts` 里这些抓手必须继续可用：`data-field^="llm.providers"`、
   `llm.active`（`<button>`）、`llm.providers.<id>.baseUrl` / `.model` / `.temperature` /
   `$=".reasoningEffort"`（内含 `<select>`）、`.more`（折叠按钮）。本步是在同卡片内**新增**
   一组字段，不要把上面任何一个挪走或改名。
3. 所有跨 IPC 的 patch 必须原样回传**全部** provider 再覆盖当前一个
   （`settings:update` 只有顶层浅合并）；并且必须经 `settingsStore.update()`（内部 `deepClone`），
   不能把 `reactive` / `ref` 对象直接传出去（`DataCloneError` 静默失败）。

## 输入

- `packages/shared/src/config/schema.ts:76-93`（`LlmProviderSchema` / `LlmSchema`）
- `packages/shared/src/config/migrations.ts`（step 1 加的 `migrateV5ToV6`）
- `packages/shared/src/config/schema.test.ts`（`fieldAccepts` 用例风格）
- `apps/desktop/src/renderer/settings/pages/LlmPage.vue`（step 4 重构后的版本，含 `saveProvider` / `removeProvider` / `loadModels`）
- `apps/desktop/src/renderer/chat/App.vue`（step 1/3 改过的版本，含 `.composer-bar` 与 `ThinkingLevelSelect`）
- `apps/desktop/src/renderer/shared/components/ThinkingLevelSelect.vue`（step 3 新建，本步的 ModelPickerSelect 照它的 props/emits 风格）
- `apps/desktop/src/main/capture.ts`（step 1/3/4 改过的版本）
- `docs/08-settings-onboarding.md` §5、`docs/06-agent-core.md`（思考等级那段）

## 操作

### 1. 配置建模（`packages/shared`）

1. `packages/shared/src/config/schema.ts`
   - `LlmProviderSchema` 新增：

     ```ts
     /**
      * 该 provider 下可选的模型 id 列表（docs/08 §5）。
      * 用 `.default([])` 而不是「可选字段」：设置页与对话窗都必须能无条件读到一个数组，
      * 否则每一处消费都要写 `?? []`，漏一处就是一个运行时崩点。
      * 仅作**候选列表**用途：真正生效的仍是 `model`——列表里没有 `model` 时，
      * 选项串里要把当前值显示为「（不在列表中）」而不是把它悄悄替换掉。
      */
     modelList: z.array(z.string()).default([]),
     ```

   - 保持 `model: z.string()` 不变（它仍是**唯一生效值**，单一事实来源）。
   - 已迁移到 v6 的配置缺 `modelList` 时由 `.default([])` 补齐；`migrateV5ToV6` 里
     再用既有的 `fillMissing` 给每个 provider 补 `modelList: []`（与 `reasoningEffort` 的补法一致，
     幂等且不动用户已有值），并把该迁移的 `describe` 更新为
     「v5 → v6：移除 general.windowState['mini-chat']；补齐 llm.providers.*.modelList 与 advanced.readonlyPrefixes」。
2. `packages/shared/src/config/store.test.ts` / `schema.test.ts`
   - 加用例：`fieldAccepts('llm.providers.deepseek.modelList', ['a','b']) === true`、
     `fieldAccepts('llm.providers.deepseek.modelList', 'a') === false`（必须是数组）；
     一份缺 `modelList` 的旧配置经 `SettingsStore` 读入后 `modelList` 为 `[]` 且其余字段不变。
   - `migrations.test.ts`：把「v5 → v6」用例扩展为同时断言 `modelList` 被补成 `[]`
     且**已有的** `modelList`（如 `['x']`）不被动。

### 2. 模型页的「模型设置」区（`LlmPage.vue`，step 4 之后的卡片骨架）

3. 在编辑卡的必填区与 `.more` 折叠区**之间**插入「模型」分组（常量名建议 `MODEL_SECTION` 相关的注释标明它是模型设置区）：
   - 头部：标题「模型列表」+ 右侧两个按钮
     「拉取模型列表」（复用现有 `loadModels`）与「+ 手动添加」。
   - 列表：`draft.modelList` 每一项一行，行结构：
     - 一个 radio（或可点整行）标记「当前使用」——选中即把 `draft.model` 设为该 id；
     - 模型 id 文本，`font-family: var(--font-mono)`；
     - 一个「重命名」入口（可选）：点开变输入框，改的就是列表里的 id（若 `draft.model` 等于旧 id 要同步改成新 id）；
     - 一个删除按钮（从列表移除；若删的正是当前 `draft.model`，保留 `model` 不变并提示
       「当前模型已不在列表中」——不要静默改成别的模型）。
   - 空态：`draft.modelList.length === 0` 时显示 `data-empty="llm.providers.<id>.modelList"` 的提示块
     （文案：「还没有模型列表：先在下面填一个模型名，或点「拉取模型列表」」）。
     ⚠️ 注意：`SETTINGS_AGENT_FIELDS_SCRIPT` 的 `emptyStates.length === 0` 断言只作用于
     **电脑操控页**，这里的 `data-empty` 不会影响它；但 `SETTINGS_FIELDS_SCRIPT` 会把
     `[data-empty]` 原样回传，新增条目是预期的。
   - 与「模型名」必填项的关系：现有的 `data-field="llm.providers.<id>.model"` 输入框**保留在原位**
     （它是「当前使用模型」的唯一编辑点，也是 capture 抓手）。在它下面加一行小字说明
     「这里填当前使用的模型 id；模型列表只是候选项」。`draft.model` 改变时若不在列表里，
     自动把它追加进列表（保持两者一致，且用户看得见发生了什么）。
   - `loadModels` 拿到结果后：`draft.modelList = 去重合并(现有列表, 拉取结果)`，
     并把「已拉取 N 个模型」提示改成「已拉取 N 个，列表共 M 个」。
   - `data-field` 抓手指南（新增）：
     - 整个模型设置区容器：`data-field="llm.providers.<id>.modelList"`
     - 每行：`data-field="llm.providers.<id>.modelList.<index>"`
     - 「+ 手动添加」按钮：`data-action="add-model"`
     - 「拉取模型列表」按钮保留原名与位置（`loadModels` 仍是 capture 与手工验证的入口）。
4. `saveProvider` 的 patch 必须带上 `modelList`（`[...draft.modelList]`，
   **深拷贝成新数组**：`reactive` 里的数组是 Proxy，直接传会 `DataCloneError`）。
   现有 `settingsStore.update()` 内部已有 `deepClone`，但显式展开更安全且可读。

### 3. 对话窗模型选择器

5. 新建 `apps/desktop/src/renderer/shared/components/ModelPickerSelect.vue`：
   - props：`modelValue: string`（当前模型）、`models: string[]`（候选）、`disabled?: boolean`、`title?: string`。
   - emits：`update:modelValue`。
   - 渲染 `<select class="input model-picker" data-field="chat.model">`：
     - 选项 = `models` 去重后的列表；若 `modelValue` 不在其中，**在最前面插一条**
       `<option :value="modelValue">{{ modelValue }}（不在列表中）</option>`；
     - `models` 为空且 `modelValue` 也空时，渲染一条 `value=""`、文案「未选择模型」的 option 并 `disabled`；
     - 长模型名要 `text-overflow: ellipsis`，控件宽度固定（约 110px），不要撑破输入区。
   - 与 `ThinkingLevelSelect.vue` 保持同一套尺寸与视觉（同高、同样 `flex: 0 0 auto`）。
6. 在 `apps/desktop/src/renderer/chat/App.vue` 接线：
   - 取当前 provider 与两个字段（步骤 3 已有 `activeProviderId`；本步复用）：
     `currentModel = computed(() => provider?.model ?? '')`、
     `modelOptions = computed(() => provider?.modelList ?? [])`。
   - 把步骤 3 的 `setEffort()` 抽成共用的 `updateActiveProvider(patch: Partial<LlmProviderConfig>)`
     （原样回传 `llm.active` 与全部 `providers`，只覆盖当前一个），`setEffort` 与新的
     `setModel(next: string)` 都调它。`setModel` 成功后提示「模型已切换为 <next>」2 秒。
   - UI 顺序：`.composer-bar` 里依次是 `meta` 文本 → **模型**选择器 → **思考**选择器 → 停止/发送按钮。
     420px 宽下放不下时必须优雅降级：把 `meta` 那一行（「会话：… · 可调用 Skill 与 MCP 工具」）
     在窄窗时隐藏（用 CSS `@container` 或简单地把 meta 设成 `overflow: hidden` + `min-width: 0`，
     以实际截图不换行为准）。**发送按钮绝不能被挤出行外**。
   - 无可用 provider 时两个选择器都 `disabled` + 提示去设置页（与 step 3 一致的口径）。
7. 模型切换的生效性：不需要改主进程——`createProviderFactory()` 每次请求都重新读
   `settings.get().llm`（`agent-host.ts:140-155`），所以下一次发送就用新 `model`。

### 4. capture 探针

8. 新增两个脚本常量 `SETTINGS_LLM_MODELS_ACT` 与 `SETTINGS_LLM_MODELS_CHECK`（模型页）：
   - 先 `await window.aurora.settings.get()` 确定当前 active provider；
   - 点开第一行的「编辑」（若 `LlmPage` 提供了 `data-action="edit-provider"` 就用它，否则点行内的「编辑」按钮）；
   - 断言：模型列表区 `data-field$=".modelList"` 存在；
     点一次 `data-action="add-model"` 后 `.modelList.<n>` 行数 +1（**注意这个动作会改配置**——
     所以它必须在 `settings-llm-params` 那条**之前**跑，或者结束后把新增项删掉恢复原状；
     推荐后者：探针结束时点掉刚加的那一行，让 `report.json` 里后续场景看到的还是干净配置）。
   - `pass` 条件 = 列表区存在 && 行数 ≥ 1 && 添加后行数增加 && 恢复后行数还原。
9. 新增 `CHAT_MODEL_PICKER_ACT` / `CHAT_MODEL_PICKER_CHECK`（对话窗）：
   - ACT：读 `settings.get()` 造一个有两个模型 id 的 provider（参考 `SETTINGS_LLM_EFFORT_ACT` 的做法：
     只在没有 provider 时造 `capture` 这个 id，`modelList: ['deepseek-chat', 'deepseek-reasoner']`，
     `active: 'capture'`），等 `settings:changed` 生效后，把 `[data-field="chat.model"]` 的 select
     切到第二个模型并派发 `change`，等 600ms，记录原值到 `window.__auroraModelProbe`。
   - CHECK：`await window.aurora.settings.get()`，断言
     `llm.providers[llm.active].model === 'deepseek-reasoner'`，且 DOM 里 select 的 `.value` 与之相同，
     且 option 数量 ≥ 2；结束时把 `model` 写回原值。
   - `pass` = 三条件全真。
10. `defaultCapturePlan` 加两条：

    ```ts
    { name: 'chat', file: 'chat-model-picker.png', act: CHAT_MODEL_PICKER_ACT, check: CHAT_MODEL_PICKER_CHECK },
    { name: 'settings', file: 'settings-llm-models.png', query: { page: 'llm' }, act: SETTINGS_LLM_MODELS_ACT, check: SETTINGS_LLM_MODELS_CHECK },
    ```

    - `chat-model-picker` 必须排在 `chat-collapse.png` **之前**（收起后窗口隐藏，做不了 DOM 操作）；
      交互窗场景的全局顺序由 step 3 定死：`thinking-level` → `model-picker` → `drag` → `collapse` → `chat.png`。
    - `settings-llm-models` 与 `settings-llm-params` 的先后：让 `settings-llm-models` **在前**
      （它会临时加一行再删回），避免它把 `params` 场景造出来的 provider 状态搅乱；
      若实测仍有干扰，就把两条场景的 provider id 分开（`capture-models` / `capture`）并在注释里写明理由。

### 5. 文档

11. `docs/08-settings-onboarding.md`
    - §1 配置表新增 `llm.providers.*.modelList`：含义（候选模型 id 列表）、`model` 仍是唯一生效值、
      `modelList` 为空时的回落行为。
    - §5 模型页描述补「模型设置区」：列表 + 当前使用标记 + 手动添加 + 拉取合并 + 删除规则。
12. `docs/07-ui-spec.md` §2.3 补一句：输入区含「模型」与「思考」两个选择器，模型列表来自
    `llm.providers.<active>.modelList`；§5.3 截图清单补 `chat-model-picker.png` 与 `settings-llm-models.png`。
13. `docs/06-agent-core.md` 思考等级那段补一句：思考等级作用于当前 provider 下的所有模型；
    若将来要按模型区分，需要把它扩展成模型级映射（写清这是**已知取舍**，别让后人对不上）。
14. `docs/10-user-guide.md` 对话窗操作说明补「在输入框旁可以切模型」。

## 验收标准

- [ ] `node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit` 退出码 0
- [ ] `node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js -p apps/desktop/tsconfig.web.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit` 退出码 0
- [ ] `node node_modules/vitest/vitest.mjs run packages/shared/src/config` 全绿
- [ ] `pnpm build` 成功
- [ ] `grep -rn 'modelList' packages apps` 至少 5 处命中（Schema / 迁移 / 模型页 / 对话窗 / capture 探针）
- [ ] `grep -n 'chat.model' apps/desktop/src/renderer/` 命中，且 `chat.reasoningEffort` 仍存在（两个选择器都在）
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; $env:AURORA_CAPTURE_WINDOWS='chat,settings'; pnpm dev`
      结束后 `report.json` 里 `chat-model-picker`、`settings-llm-models`、`settings-llm-params`、
      `chat-thinking-level` 四条 `check.pass === true`，进程退出码 0
- [ ] `report.json` 里 `settings-llm-models` 跑完后 `settings-llm-params` 仍能通过（证明探针把配置恢复了）

## 交接

- 给 step 6（窗口拖动）：`chat/App.vue` 的 `.composer-bar` 现在有三个控件的宽度约束，
  拖动条改动不要碰输入区；`settings/App.vue` 仍只由 step 6 改。
- 给 step 7（验收）：capture 新增两条场景；验收表里第 5 行（模型设置 + 对话窗选模型）
  要用 `settings-llm-models` 与 `chat-model-picker` 两条探针作为证据，
  并手工核对「模型页改当前模型 → 对话窗选择器跟着变」这条双向一致性。
- 待确认项：若 `settings:update` 对 `modelList` 的数组写入在 `sanitizeWithDefaults` 下出现
  「整体回退」导致列表丢失，需要在 `docs/08 §1` 注明该字段不受逐字段回退保护，
  并在模型页保存后**回读校验**一次（`syncDrafts()` 已是回读路径，确认它没被绕过即可）。

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**；
  提交：`756f275`（docs）、`2c600d1`（`modelList` 配置层）、`04957b1`（模型页模型设置区）、
  `4ba8d51`（对话窗模型选择器）、`8866abf`（两条探针）。

### 分片与结果（4 路并行 + Lead 探针）

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 子代理 · 共享配置层 | `packages/shared/src/config/{schema,schema.test,migrations,migrations.test,store.test}.ts` | `modelList: z.array(z.string()).default([])`；`migrateV5ToV6` 逐 provider 补 `modelList: []`；describe 三项语义 |
| 子代理 · 模型页 | `LlmPage.vue`（+353/−12） | 「模型设置」区：列表 + 当前使用 radio + 重命名 + 删除 + 手动添加 + 拉取去重合并；空态 `data-empty` |
| 子代理 · 对话窗 | `ModelPickerSelect.vue`（新建）+ `chat/App.vue` | `data-field="chat.model"`；`updateActiveProvider()` 供两个下拉共用 |
| 子代理 · 文档 | `docs/{06,07,08,10}` | 见 `756f275` |
| Lead · 集成与探针 | `capture.ts`、`main/index.ts`、`onboarding/App.vue` | 两条新探针；两处 provider 字面量补必填字段；一条迁移兜底 |

### 关键判断与偏差

1. **`modelList` 是 output 必填字段**（zod `.default([])` 只放宽*输入*类型），而 `SettingsPatch.llm.providers`
   是 `Record<string, LlmProviderConfig>`，所以所有 provider 字面量都必须带它。
   对话窗分片用「把 `@aurora/shared` 指向 src」的临时 tsconfig 扫出 11 处命中，
   其中 2 处无人认领（`main/index.ts` 的 smoke 桩 provider、`onboarding/App.vue` 的 `persistModel()`）由 Lead 补齐。
   ★ 注意：**这类断裂在 `packages/shared/dist` 刷新前看不见**（apps/desktop 解析的是 dist），
   所以本波必须 `pnpm build:packages` 之后再跑 typecheck 才算验证。
2. **非数组 `modelList` 的兜底**（Lead 追加）：`llm.providers.*` 是 `z.record`，逐字段回退管不到它，
   手改成 `modelList: 'x'` 会一路活到 `SettingsSchema.parse` 把整份配置判成损坏（备份 + 重建）。
   按 v4→v5 对 `reasoningEffort` 的先例，在同一迁移里把非数组值归零，并补一条用例。
3. **结构探针的「行」判定改为 provider id 白名单**：新加的
   `data-field="llm.providers.<id>.modelList"` 容器在后半段同样不含点，按旧判定会被误算成一行
   （行数 2 ≠ provider 数 1，探针假 FAIL）。
4. 模型页分片的两处实现取舍（保留）：`+ 手动添加` 加的是**空行**（只改本地 draft，id 由该行「重命名」填，
   保存时静默丢弃空行）；折叠区的「可用模型 chips」保留并改走 `selectModel`（避免动 step 3/4 的既有观感）。
5. 对话窗分片的一处偏差：模型下拉用 `flex: 0 1 110px` + `min-width: 72px`（计划写 `0 0 auto`），
   作为「发送按钮绝不挤出」的兜底；两个标签、思考下拉、发送按钮仍不参与收缩。

### 验收（Lead 亲自复跑）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm lint` / `pnpm format:check` | ✅ 全绿（49 文件 / **720** 用例，比 wave 2 多 4 条） |
| 全量 `AURORA_CAPTURE` | ✅ 退出码 0、**24 张 PNG**、无 `pass:false` |
| `chat-model-picker` | ✅ `{"pass":true,"configModel":"deepseek-reasoner","domValue":"deepseek-reasoner","optionCount":2,"restored":true}` |
| `settings-llm-models` | ✅ `{"pass":true,"sectionExists":true,"rowsBefore":1,"rowsAfterAdd":2,"rowsAfterRestore":1,"emptyState":false}` |
| 回归 | ✅ 其余 15 条探针（含 `settings-llm-params` / `settings-llm-structure` / `chat-drag` / `chat-collapse` / 门控与写盘）全部 `pass:true` |
| 死字段自查 | ✅ `grep -rn 'modelList' packages apps` 命中 Schema 声明 + 迁移 + 模型页 + 对话窗 + capture + smoke 桩 provider（≥ 2 处真实消费方） |
| `read_image chat-model-picker.png` | ✅ 输入区一行内：`模型 [deepseek-reas…]` → `思考 [auto（不指定…)]` → 提示 → 发送按钮；未换行、按钮未出框（提示是 2s 瞬态，挤占的是可省略文本） |
| `read_image settings-llm-models.png` | ✅ 「模型列表」区头 + 拉取/手动添加 两个按钮 + 一行（radio 选中、`.mono` id、「当前使用」badge、重命名/删除） |

### 遗留

- 模型页的「删除当前项不静默换模型」由派生态与代码路径保证，**没有单独的探针**：
  恢复动作只减行、不改 `model`（`rowsAfterRestore === rowsBefore`），配置侧一致性由
  `chat-model-picker`（配置值 === DOM 值）覆盖。
- 对话窗那条探针拍到的 2s 提示会把 `.meta` 挤成省略号（可省略文本优先让位），这是计划允许的降级；
  提示消失后 `.meta` 恢复正常。
- `docs/06 §3` 提到的 `effortByModel` 只是「将来按模型区分等级」的示例名，代码里不存在该字段（文档已注明）。
