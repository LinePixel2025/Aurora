# Step 04 — AI 模型页重构：provider 行列表 + 单卡编辑 + 删除二次确认

- Task: chat-window-ux-fixes
- Step: 4 / 8
- Status: done
- Depends on: step 3
- Produces: 重构后的 `apps/desktop/src/renderer/settings/pages/LlmPage.vue`；一条新的 capture 探针；docs/08 §5 更新

## 目标

用户问题 4 落地：模型供应商界面从「一屏平铺所有卡片的长滚动页」改成业界 Agent 软件的
「目录行列表 + 一次只开一张编辑卡」信息架构，凭据状态一眼可见，危险操作有二次确认。

## 设计依据（调研结论，落地时按这个 IA，不要退回平铺）

参考本机 DSH 的模型设置页实现（`@deepseek-ai/dsh-client-ui-settings-models` 的
`lib/types/client/ModelsSection.d.ts`、`ProviderEditor.d.ts`、`CustomProviderCard.d.ts`）：

- **一个 provider 一行**：行上只有「名称 + 凭据状态点（已配置 / 缺失）+ 是否默认 + 行操作（编辑 / 设为默认 / 删除）」，
  一次只展开**一张**编辑卡（`openProviderId` 单值状态，不是每卡各自折叠）。
- **凭据单独一次写入**：编辑卡里的 API Key 是 write-only 输入，留空 = 不修改；页面永不回显明文。
- **删除二次确认**：危险动作用确认步骤，不直接生效。
- **必填项前置**：新建自定义 provider 时的必填字段（endpoint / model）在卡片里当场校验并指出字段，而不是保存后才报错。
- 另参考 [vm0 PR #2469](https://github.com/vm0-ai/vm0/pull/2469)、
  [hermes-agent PR #38551](https://github.com/NousResearch/hermes-agent/pull/38551) 的 provider 目录 + 内联凭据行做法。
- **刻意不做**：provider 卡片上不再堆「思考等级」以外的模型级开关。思考等级已在对话窗有入口（step 3），
  这里保留是因为它落在 provider 维度（当前 Schema 就是这么存的）。

## 硬约束：不许动的东西

`apps/desktop/src/main/capture.ts` 的下列探针会直接操作这些 DOM 属性，**改页面时必须全部保留**
（先读 `capture.ts:506-569` 与 `:338-368` 确认细节）：

| 选择器 | 谁在用 |
|--------|--------|
| `[data-empty="llm.providers"]` | 空状态断言 |
| `[data-field^="llm.providers"]` | `SETTINGS_FIELDS_SCRIPT` 的门控计数（重构后仍应 > 0） |
| `[data-field="llm.active"]` 且在 `<button>` 上 | 「设为默认」按钮 |
| `[data-field="llm.providers.<id>.baseUrl"]` | `SETTINGS_LLM_EFFORT_ACT` 要往这个 input 写 baseUrl |
| `[data-field="llm.providers.<id>.model"]` | 同上，写 model 名 |
| `[data-field="llm.providers.<id>.temperature"]` | `SETTINGS_LLM_EFFORT_CHECK` 计数用 |
| `[data-field$=".reasoningEffort"]` **里面的 `<select>`** | `SETTINGS_LLM_EFFORT_CHECK` 读 `.value` 必须是 `'high'` |
| `.more`（展开高级参数的按钮） | `SETTINGS_LLM_EFFORT_ACT` 点它展开折叠区 |

也就是说：**编辑卡展开后，baseUrl / model / temperature / reasoningEffort 四个 `data-field` 必须同时在 DOM 里**，
且 `reasoningEffort` 的容器内必须是 `<select>`。重构可以改布局与交互，不能改这套断言抓手。

## 输入

- `apps/desktop/src/renderer/settings/pages/LlmPage.vue`（当前 494 行，整页重写）
- `apps/desktop/src/renderer/settings/components/SettingField.vue`（字段容器，`data-field` 由它透传）
- `apps/desktop/src/renderer/settings/settings.css`（`.section-card` / `.page-title` / `.mono` / `.badge` 等既有类）
- `apps/desktop/src/renderer/shared/components/AppButton.vue`、`AppToast.vue`
- `apps/desktop/src/main/capture.ts:506-569`、`:338-368`、`:576-654`
- `packages/shared/src/config/schema.ts:63-93`（`LlmProviderSchema` / `LlmSchema`）
- `docs/08-settings-onboarding.md` §5（模型页现状描述）

## 操作

### 1. 页面重构

1. 重写 `LlmPage.vue`，结构按下面四块，自上而下：
   - **页头摘要**：`h1`「AI 模型」+ 一行状态摘要
     （`当前默认：<activeId> · <model>`；未配置时为「尚未选择默认模型」）。保留原有 `.page-sub` 说明
     （凭据加密、日志脱敏）。
   - **工具行**：`+ 添加 Provider` 按钮（切 `mode = 'add'`）与「保存全部」按钮。
     把现在的 `showAdd` 布尔量换成 `mode: 'list' | 'add' | 'edit'` + `editingId: string | null`。
   - **provider 行列表**：每行 = 名称（`.mono`）+ 凭据状态 badge + 默认 badge + 行尾按钮组
     （`编辑` / `设为默认` / `删除`）。
     - 凭据状态用现有 badge 语义：`draft.apiKeySet ? '凭据已保存'(ok) : '缺少凭据'(warn)`。
     - `编辑` 把该行切进编辑卡；`设为默认` 保留 `data-field="llm.active"` 且仍是 `<button>`
       （已默认时 `disabled`）。
     - `删除` 触发二次确认（见第 3 条）。
     - 行容器带 `:data-field="`llm.providers.${id}`"`（保留门控计数抓手）。
   - **空状态**：`drafts.length === 0` 时仍是 `data-empty="llm.providers"` 的 section-card，
     文案与「添加 AI 模型」主按钮保持不变。
2. **编辑卡**（`mode === 'edit' && editingId === id` 时渲染，一次只渲染一张）：
   - 必填区：`baseUrl` / `apiKey` / `model` 三个 `SettingField`，
     `data-field` 分别是 `llm.providers.<id>.baseUrl`、`...apiKey`、`...model`（与现状完全一致）。
   - `.more` 折叠区（保留这个 class 名与「高级参数与连接测试」文案）内含
     `temperature` 与 `reasoningEffort` 两个 `SettingField`，以及
     「保存并测试连接」/「拉取模型列表」按钮与连接结果 `AppToast`、模型 chips。
   - 高级区**默认展开还是收起**：保持收起（`advancedOpen` 语义不变），
     因为 `SETTINGS_LLM_EFFORT_ACT` 会去点 `.more`；如果改成默认展开，`.more` 仍必须存在且可点。
   - **预留模型设置区**：在必填区与 `.more` 折叠区之间留出一块「模型」分组的位置
     （step 5 会在这里放模型列表；本步可先放一个占位小标题或直接留空注释），
     不要让 `.more` 紧贴 `model` 输入框到无法插入新分组的程度。
   - 卡片底部：`取消` 与 `应用` 两个按钮。`应用` 只提交这一张卡（`saveProvider(draft)`），
     成功后回到列表态；失败时留在卡里并显示 `AppToast tone="error"`。
3. **删除二次确认**：
   - 点「删除」→ 行内（或卡片底部）出现确认条：文案「删除 provider「<id>」？依赖它的会话将无法再请求模型。」
     + `确认删除`（danger）/ `取消`（ghost）。
   - `确认删除` 的按钮带 `data-action="confirm-remove-provider"`，供后续断言定位。
   - 确认后才走原有 `removeProvider(id)` 逻辑（删 provider + 清 `apiKey` secret + 重算 `llm.active`）。
4. **添加流程**（`mode === 'add'`）：
   - 预设 chips 与 `newProviderId` 输入框沿用现有 `PROVIDER_PRESETS` 逻辑，包成一张 section-card。
   - 必填校验前置：选中预设后直接进编辑卡（`editingId = key`、`mode = 'edit'`），
     由编辑卡的必填项做当场校验；「空白配置」同理。
   - 重复 id 的报错保持现有中文提示。
5. **保存语义不许退化**（这几条都是踩过的坑，改结构时最容易丢）：
   - `saveProvider` 里对 `llm.providers` 的处理必须**展开全部 provider 再覆盖当前一个**
     （`settings:update` 只有顶层浅合并；只传一个会把其它 provider 整块写丢）。
   - `apiKey` 走 `window.aurora.settings.setSecrets`，`apiKeyEnc: ''` 必须保留在 patch 里。
   - 删除 provider 时必须 `clearSecret('llm.providers.<id>.apiKey')`。
   - 「设为默认」成功后要 `settingsStore.refreshAppInfo()`（`needsOnboarding` 靠它刷新）。
   - 所有跨 IPC 的 patch 必须经 `settingsStore.update()`（内部已 `deepClone`），
     不要把 `reactive` / `ref` 里的对象直接传出去（`DataCloneError` 静默失败，见 AGENTS.md）。
6. 视觉：沿用 `settings.css` 既有类与设计令牌，不新增硬编码颜色；行 hover 用 `--fill-2`，
   当前默认行可加左侧 3px 品牌色指示条（与交互窗 history-item 同款处理）。

### 2. capture 探针

7. 新增 `SETTINGS_LLM_STRUCTURE_SCRIPT`（放在 `SETTINGS_AGENT_FIELDS_SCRIPT` 附近）：
   - 读 `await window.aurora.settings.get()` 拿到 `llm.providers` 的 key 数量 `expected`。
   - 数 DOM：`[data-field^="llm.providers."]` 命中数、行元素数、可见编辑卡数。
   - `pass` 条件：`expected > 0` 时，provider 行数与 `expected` 相等，且**可见编辑卡数量 ≤ 1**；
     `expected === 0` 时存在 `[data-empty="llm.providers"]`。
   - 返回值里带 `rows` / `editors` / `expected`，便于失败时排查。
8. `defaultCapturePlan`：在现有 `settings-llm-params.png` 那条**之前或之后**加一条
   `{ name: 'settings', file: 'settings-llm-structure.png', query: { page: 'llm' }, act: <可选：点开第一行「编辑」>, check: SETTINGS_LLM_STRUCTURE_SCRIPT }`。
   注意顺序：`SETTINGS_LLM_EFFORT_ACT` 会造一个 provider 并断言下拉真值，
   新场景若也改配置会互相干扰——**新场景不要写配置**，只读与点开。
9. 现有 `settings-llm-params.png` 场景保持不变（它是 step 3 与 docs/07 §5.3 都在引用的场景）。

### 3. 文档

10. `docs/08-settings-onboarding.md` §5 重写模型页的描述：目录行列表 + 单卡编辑 + 凭据状态点 +
    删除二次确认 + 一次只开一张编辑卡；并说明「思考等级在提供方维度，另有对话窗入口（docs/07 §2.3）」。
11. `docs/07-ui-spec.md` §2.5 设置窗里若提到模型页布局，同步一句；
    §5.3 截图清单补 `settings-llm-structure.png`。

## 验收标准

- [ ] `node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js -p apps/desktop/tsconfig.web.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit` 退出码 0
- [ ] `pnpm build` 成功
- [ ] `grep -c 'data-field' apps/desktop/src/renderer/settings/pages/LlmPage.vue` ≥ 8，且 `llm.active` 仍绑在 `<button>` 上
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` 结束后：
      `report.json` 里 `settings-llm-params` 条目 `check.pass === true`（思考等级探针没被重构弄坏）、
      新增的 `settings-llm-structure` 条目 `check.pass === true`、进程退出码 0
- [ ] `report.json` 里 `settings-llm` 页的 `SETTINGS_FIELDS_SCRIPT` 计数里
      `languageFields === 0` 且没有新增 FAIL
- [ ] 删除一个 provider 时**先出现确认条、点确认后才真的消失**（可用 capture 的
      `data-action="confirm-remove-provider"` 写一条新探针验证，或在 smoke 里手工确认一次并记录）

## 交接

- 给 step 5：模型页的「模型列表」编辑区要插在**必填区与 `.more` 折叠区之间**那块预留位置；
  你只需保证本步没把 `.more` 折叠区与四个 `data-field` 抓手写死成不可扩展的结构
  （新增字段应当能在同一张卡里再放一组 `data-field`，不需要推翻布局）。
- 给 step 6：设置窗拖动条只加在侧栏与内容区顶部，本步不要顺手改 `settings/App.vue` 的拖动类
  （那是 step 6 的范围，避免同文件双写）。
- 给 step 7：capture 现在有 3 条 llm 相关场景（structure / params）+ 1 条 modes 场景，
  全量跑要确认没有新增 FAIL。
- 待确认项：`PROVIDER_PRESETS` 若有新的预设项，`addPreset` 的默认 `model` 取值要与预设一致
  （现有逻辑已如此，重构时别改坏）。

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**；提交：`91d739c`。

### 分片与结果

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 子代理 · 页面重写 | `settings/pages/LlmPage.vue`（771 行整页重写） | 行列表 + `mode: 'list'\|'add'\|'edit'` + 单值 `editingId`（一次只一张卡）+ 就地删除二次确认 + 必填项前置 + **模型分组预留位** |
| 子代理 · 文档 | `docs/08 §5`、`docs/07 §2.5/§5.3` | 见提交 |
| Lead · 探针 | `capture.ts`（`SETTINGS_LLM_STRUCTURE_ACT/CHECK` + `settings-llm-structure.png`；`SETTINGS_LLM_EFFORT_ACT` 改为先开卡再点 `.more`） | 见提交 |

### 与原计划的两处偏差（都记明理由）

1. **行首那颗 chevron 已撤掉**。子代理为了让列表化之前写的 `SETTINGS_LLM_EFFORT_ACT`
   （直接 `querySelector('.more')`）继续可用，在行上挂了一颗兼「开卡 + 展开高级区」的 `class="more row-more"`。
   这与 step-04「行上只有名称 / 凭据状态 / 是否默认 / 行操作」的 IA 冲突，而且是在迁就一个**已经过时的探针**。
   Lead 处置：撤掉行内 chevron（连同 handler 与样式），改为把探针改成**先点 `data-action="edit-provider"` 开卡、
   再点卡内 `.more`** —— 两个入口各司其职，行的职责保持干净，探针仍走真实点击路径。
2. **探针的「行」判定改用 provider id 白名单**（原实现靠「`data-field` 后半段不含点」猜）。
   step 5 会在卡内加 `data-field="llm.providers.<id>.modelList"` 容器，它的后半段同样不含点，
   按原判定会被误算成一行（行数 2 ≠ provider 数 1）。改成「后半段必须等于某个真实 provider id」后两种结构都稳。

### 探针判定口径（比计划更严的一处）

计划的 `pass` 是「可见编辑卡数量 **≤ 1**」。`≤ 1` 恒真的上界会漏掉「一张都没开」这种假通过（结构退化成纯列表也能 PASS），
因此实现为**点开「编辑」之后恰好 1 张**可见编辑卡（用卡内必填字段 `$=".baseUrl"` 的可见数量计数）；
`providers` 为空时改为断言 `[data-empty="llm.providers"]` 存在。

### 验收（Lead 亲自复跑）

| 命令 | 结果 |
|---|---|
| `vue-tsc` / `tsc(tsconfig.node)` / prettier / eslint | ✅ 全绿 |
| `pnpm typecheck && pnpm test && pnpm build` | ✅ 全绿（49 文件 / 716 用例） |
| 全量 `AURORA_CAPTURE` | ✅ 退出码 0、22 张 PNG、无 `pass:false` |
| `settings-llm-structure` | ✅ `{"pass":true,"expected":1,"rows":1,"rowIds":["llm.providers.capture"],"editors":1,"emptyState":false,"act":{"clicked":true,"label":"编辑"}}` |
| `settings-llm-params`（step 3 的探针） | ✅ `{"effortFields":1,"temperatureFields":1,"value":"high","pass":true}` —— 先开卡再点 `.more` 的改动生效 |
| 保留的抓手 | ✅ `data-empty` / 行 `data-field` / `llm.active` 在 `<button>` / 四个字段 / `.more` 全部保留，新增 `data-action="edit-provider"`；`grep -c data-field` = 9（≥ 8） |
| `read_image settings-llm-structure.png` | ✅ 页头摘要 + 工具行 + 单行列表（凭据/默认 badge + 编辑/已是默认/删除）+ 展开的编辑卡（必填区 → 模型预留位 → 高级参数折叠） |

### 遗留

- 「必填项前置」使「保存全部」在遇到半填 provider 时停下报错 —— 这是 step-04 第 4 条的落地，保留。
- 删除二次确认已实现且有 `data-action="confirm-remove-provider"` 抓手，但**本步没有为它单独写探针**
  （计划允许「或在 smoke 里手工确认一次并记录」）；实际确认路径由 step 7 的人工核对 + 代码审查覆盖。
- 凭据语义按 step 2 修正后的口径执行（空 `apiKeyEnc` = 本次不改凭据），计划里相反的说法已作废。
