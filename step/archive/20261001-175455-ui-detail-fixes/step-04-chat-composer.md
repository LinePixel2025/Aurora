# Step 04 — 对话窗输入区：权限下拉换行、去键位提示、上下文详解精简、窗口按模型

- Task: ui-detail-fixes
- Step: 4 / 8
- Status: done
- Depends on: step 2
- Produces: 对话窗输入卡的四处修正：权限菜单不再横向溢出、工具行右侧常驻键位提示移除且模型/思考下拉不被挤压、上下文详解卡精简为三行、上下文窗口分母按当前模型取
- Phase: 界面
- Writes: `apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`、`apps/desktop/src/renderer/chat/components/ComposerContextBar.vue`、`apps/desktop/src/main/capture.ts`
- Size: L
- Risk: ① 删 `.composer-hint` 那支 span 时，与它成对 `v-if / v-else` 的 `.picker-hint`（`App.vue:1341`）必须一起摘掉 `v-else`，否则模板编译失败；同时 `shortcutHint` 常量（`:1063`）会变成未使用变量被 ESLint 拦下；② `chat.context` / `chat.context-usage` / `chat.context-cache` / `chat.context-detail` 四个锚点与 `.ctx-total` 类被探针硬依赖，精简卡片时**一个都不能删**（`capture.ts:2530 / 2570-2582 / 2724-2790 / 3662-3701 / 4223`）；③ 权限菜单是**继承**了 `.composer-bar { white-space: nowrap }` 才不换行，只改文案不修 CSS 等于没修。
- 与 step 5 的次序：两步都写 `apps/desktop/src/main/capture.ts`，必须排在 step 5 之前（同波并行会互相覆盖）。
- 探针有两处**必然**要改（不改就是红灯）：`CHAT_THINKING_LEVEL_ACT/CHECK` 仍按 provider 级 `reasoningEffort` 读写（provider 级字段已被 step 2 删除，CHECK 恒读到 `undefined` → 假 FAIL，且写回分支会把 `high` 永久留在配置里）；`CHAT_PERMISSION_CHECK` 要加溢出断言。

## 目标

权限下拉的说明文字在卡片内正常折行；工具行右侧不再有常驻的「Enter 发送 · Shift + Enter 换行」；上下文详解卡只呈现本轮输入 / 上下文窗口 / 模型三行；上下文占用比例的分母来自**当前生效模型**的参数。

## 输入

- `apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`：`.perm-menu`（`:348-359`，`width: 320px`、**没有** `overflow`）；`.perm-item` / `.perm-item-body` / `.perm-item-title`（`:361-425`，`body` 有 `min-width: 0` 但无换行规则）；完全权限档的说明文案在 `:231-237`（含 `pendingDanger ? '再点一次确认：项目根内的敏感操作不再询问' : '有项目时项目根内免确认、越界仍问；未登记项目时不再逐次询问'`）。
- 溢出根因：`apps/desktop/src/renderer/chat/App.vue:1809` 的 `.composer-bar { white-space: nowrap }` 是**继承**属性，DOM 祖先链 `.composer-bar > .perm > .perm-menu` 一路继承到菜单内文字。
- 工具行：`App.vue:1310-1374`（子项顺序：权限 / 模型 / 思考 / `.grow` / 提示 / 麦克风 / 停止 / 发送）、`:1063`（`const shortcutHint = 'Enter 发送 · Shift + Enter 换行'`）、`:1335`（`.grow`）、`:1341-1342`（`.picker-hint` 与 `.composer-hint` 的 `v-if / v-else`）、`:1813-1819`（两枚提示共用 `flex: 0 1 auto`）、`:1822-1825`（`.composer-hint { opacity: 0.75 }`）、`:1827-1829`（`.send-slot` 不收缩）；`ModelPickerSelect.vue:129-133`（`flex: 0 1 110px`）与 `ThinkingLevelSelect.vue:83-87`（`min-width: 62px`）决定了两枚下拉的收缩区间。
- 上下文详解：`apps/desktop/src/renderer/chat/components/ComposerContextBar.vue` 的 props 在 `:28-48`（`messageCount` / `charCount` / `model` / `streaming` / `totals` / `latest` / `contextWindow` / `open`），详情卡模板在 `:145-207`（七行 + 一句 `ctx-note`），折叠条在 `:210-244`（`chat.context` / `chat.context-usage` / `chat.context-cache` / `.ctx-total` / 百分比 / 进度条）。
- 对话窗数据：`App.vue:1043-1048`（`contentChars` 计算与 `currentContextWindow`）、`:433-436`（`effort` / `effortValue`）、`:491-519`（`updateActiveProvider` / `setEffort`）、`:1378-1388`（`ComposerContextBar` 的传参）。
- 取值口径（step 2 产出）：`import { resolveModelParams } from '@aurora/shared/browser'`；未命中键回落 `{ reasoningEffort: 'auto', contextWindow: 0, vision: false }`。
- 探针事实：`composer-hint` 没有任何探针引用；`chat-composer-permission` / `chat-permission-readonly` 只按 `textContent` 子串断言「只读」「变更前确认」「完全权限」「再点一次确认」；`CHAT_COMPOSER_CHECK`（`capture.ts:2514`）读 `[data-field="chat.permission"]` 文案与 `chat.context-usage` 的「暂无用量数据」；`chatStreamCheck`（`capture.ts:2710-2790`）读 `chat.context-usage` / `chat.context-cache` / `.ctx-total`；浮层几何检查（`capture.ts:3388 / 3550`）只看 `chat.context-detail` 的外接矩形。

## 操作

1. `ComposerPermissionSelect.vue`
   - CSS：给 `.perm-item-body` 加 `white-space: normal`（它是长文案的实际容器），给 `.perm-menu` 加 `overflow: hidden` 与 `word-break: break-word`（兜住极端窄窗 / 高 DPI），`.perm-item` 保持 `align-items: flex-start`；`.perm-menu` 的宽度与 `left/bottom/z-index` 不动（三个浮层共用锚点契约）。
   - 文案：完全权限档的非确认态压短成两句、两句之间用一个空格或 `<br>` 之外的普通分隔（**不要**用 `·` 拼成一长行），必须同时保留两种项目状态的语义，例如「有项目：根内免确认，越界仍询问」「无项目：不再逐次询问」（两行由换行自然产生，或在同一个 `<span>` 里用一个换行符分隔）。`pendingDanger` 那支「再点一次确认：项目根内的敏感操作不再询问」**保持原样**（探针子串）。触发器 `title`（`:91-96`）与档位 label（`:78-81`）不动。
2. `App.vue` — 去掉键位提示
   - 删 `:1342` 的 `<span v-else class="tiny muted composer-hint">{{ shortcutHint }}</span>`，并把 `:1341` 的 `.picker-hint` 那支改成独立渲染（摘掉 `v-else`，仍是 `v-if="pickerHint"`）。
   - 删 `:1063` 的 `shortcutHint` 常量与 `:1822-1825` 的 `.composer-hint` 样式块；`:1813-1819` 的选择器列表去掉 `.composer-hint`（`.picker-hint` 的规则保留）。
   - `composerTitle`（`:1066-1071`）保留（键位说明随之只出现在 textarea 的悬浮提示里），但把文案里的「可直接拖入文件」这类与键位无关的能力说明保持不变、只保留 Enter / Shift+Enter 的说明。
   - 不要改三枚控件的尺寸与状态样式：权限 / 模型 / 思考仍是 `--control-h-xs` + pill + 静止态零边框；`.grow` 与 `.send-slot` 的 flex 声明不动。删掉提示后窄窗下两枚下拉仍可能被压缩到 `min-width` —— 若实测仍挤字，优先放宽 `ModelPickerSelect` / `ThinkingLevelSelect` 的 `min-width`，**不要**去动输入卡的三控件口径。
3. `App.vue` — 上下文窗口与思考等级改读模型级参数
   - 新增 `const currentModelParams = computed(() => { const provider = activeProvider.value; return provider === null ? null : resolveModelParams(provider) })`。
   - `currentContextWindow`（`:1047-1048`）改成 `currentModelParams.value?.contextWindow ?? 0`。
   - `effort`（`:433`）改成 `currentModelParams.value?.reasoningEffort ?? null`；`effortValue` / `effortTitle` / `missingProviderTitle` 不动。
   - `setEffort`（`:513-519`）：比较对象改成 `resolveModelParams(provider).reasoningEffort`；写入时 `const modelId = provider.model`（为空则直接返回，不写盘），用 `updateActiveProvider({ modelParams: { ...provider.modelParams, [modelId]: { ...resolveModelParams(provider), reasoningEffort: next } } })` 整体替换该键的对象（**不要**原地改 `provider.modelParams[modelId].xxx`）。
   - `ComposerContextBar` 的传参（`:1378-1388`）：删掉 `:message-count` 与 `:char-count` 两行；`contentChars` 计算属性（`:1043-1046`）随之删除（否则是未使用变量）。`usage` / `latest` / `totals` / `model` / `streaming` 照旧传。
4. `ComposerContextBar.vue` — 精简详情卡
   - 详情卡只留三行：`输入（最近一轮）`（保留 `latest === null ? '—' : formatExact(latest.promptTokens)` 的写法与 `tokens` 后缀）、`上下文窗口`（`> 0` 显示精确值，否则显示「未设置（设置 → AI 模型 → 模型参数）」这类修复路径）、`模型`（`mono`，空串显示「未配置」）。
   - 删掉 `输出（最近一轮）`、`缓存命中（最近一轮）`、`本会话累计`、`本会话内容` 四行的**模板**。`cachedTokens` / `cachedPercent` / `cachedText` 三个计算属性**全部保留** —— `cachedText` 内部就是调前两者算出来的，删掉它们会让折叠条上的 `chat.context-cache` 拿不到文案、且 vue-tsc 直接报未定义标识符（`ComposerContextBar.vue:113 / 122-128 / 133-137`）。
   - `ctx-note` 压成一句：`latest === null` 时「模型服务未回传 token 用量（部分兼容网关不支持）」；否则「「输入」就是这一轮真正送进模型的上下文长度」。删掉原句里「这里只统计消息条数与字符数」那半句（统计项已移除）。
   - props：删 `messageCount` / `charCount`（连同 `withDefaults` 里的默认值）；`latest` / `totals` / `contextWindow` / `open` / `model` / `streaming` 全部保留。`.ctx-grid` 的两列网格与折叠条**一字不动**。
5. `capture.ts` — 三处探针同步
   - **溢出护栏**：在 `CHAT_PERMISSION_CHECK`（`capture.ts:3287` 起）里、菜单还开着的时候加测量：取 `[data-field="chat.permission-menu"]` 的外接矩形与它内部每个 `.perm-item` 的矩形，断言每项的 `right <= menu.right + 0.5` 且 `left >= menu.left - 0.5`；把 `menuOverflow: <违规项数>` 与布尔 `noOverflow` 放进返回值并纳入 `pass`。这样「文字跑出卡片」以后会被自动抓住，而不是只靠人眼看截图。
   - **`CHAT_THINKING_LEVEL_ACT` 与 `CHAT_THINKING_LEVEL_CHECK`（`capture.ts:5947-6060`）**：ACT 的种子 provider 改成 `modelParams: { [modelId]: { reasoningEffort: 'auto', contextWindow: 0, vision: false } }` 并把 `before` 记成「该模型的原值（缺省 `'auto'`）」（**不能**记成 `undefined`，否则 CHECK 的 `target.reasoningEffort === probe.before` 会因两边都是 `undefined` 而误判 `restored = true`，把 `high` 永久留在配置里）；CHECK 的 `configValue` 改成 `resolveModelParams(provider).reasoningEffort`，写回改成写 `modelParams[modelId].reasoningEffort`。注意 ACT 与 CHECK 里若用到 `resolveModelParams`，它是探针字符串内的渲染层代码，必须从 `window` 侧可用（渲染层已通过 `@aurora/shared/browser` 拿到该函数即可直接调用；取不到就等价地写 `provider.modelParams[provider.model]?.reasoningEffort ?? 'auto'`）。
   - **上下文详解卡的形状断言**：capture 的顺序是「先拍 PNG、后跑 check」(`capture.ts:258-261`)，所以**没有任何 PNG 能拍到展开的详解卡**（`chat-composer-flyouts.png` 拍的是权限浮层，展开详解卡的代码在 check 里）。因此在 `CHAT_COMPOSER_FLYOUTS_CHECK` 打开详解卡之后补一组 DOM 断言：`.ctx-grid` 里 `dt` 的文案集合恰为 `['输入（最近一轮）', '上下文窗口', '模型']`、`ctx-note` 不含「消息条数」，并把 `detailRows`（行数）与 `detailLabels` 放进返回值并纳入 `pass`。这是第 3 条「只留 2 项」的唯一客观判据。
   - `chat.context*` 四个锚点与 `.ctx-total` 的定位不动；改完必须跑 `apps/desktop/src/main/capture.probe-strings.test.ts` 的护栏用例（探针字符串里不能出现反引号，注释用「」或单引号）。

## 分片建议

- 片 A：`ComposerPermissionSelect.vue`（操作 1）+ `capture.ts` 的溢出断言（操作 5）。
- 片 B：`App.vue`（操作 2、3）。
- 片 C：`ComposerContextBar.vue`（操作 4）。
- 片 B 与片 C 有接口耦合（props 增删），建议同一人顺序做或先定好 props 表；片 A 可并行。

## 验收标准

- [ ] `pnpm typecheck` 全绿。
- [ ] `pnpm vitest run apps/desktop/src/main` 全绿（含 `capture.probe-strings.test.ts`）。
- [ ] `grep -n "composer-hint\|shortcutHint" apps/desktop/src/renderer/chat/App.vue` 无命中。
- [ ] `grep -n "messageCount\|charCount" apps/desktop/src/renderer/chat/components/ComposerContextBar.vue apps/desktop/src/renderer/chat/App.vue` 无命中。
- [ ] `grep -n "data-field=\"chat.context" apps/desktop/src/renderer/chat/components/ComposerContextBar.vue` 四个锚点（`chat.context` / `chat.context-usage` / `chat.context-detail` / `chat.context-cache`）都还在。
- [ ] 截图探针（PowerShell 先 `Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`）：
      `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-chat"; $env:AURORA_CAPTURE_WINDOWS='chat'; $env:AURORA_CAPTURE_ONLY='chat-composer,chat-permission,chat-model-picker,chat-thinking-level,chat-sidebar'; pnpm dev`
      读 `report.json`：上述场景全 PASS（其中 `chat-composer-permission` 必须包含本步新增的 `noOverflow === true`）。若 `chat-composer-slash`（`CHAT_COMPOSER_CHECK` 所在场景）未在本次范围内跑到，补跑一次把它纳入。
- [ ] 打开 `chat-composer-permission.png` 人工核对：菜单第三项的说明文字在卡片内折行、没有画出右边框；输入卡工具行右侧只有权限 / 模型 / 思考 / 发送等控件，没有「Enter 发送」字样；模型下拉与思考下拉的宽度未被压到看不见文字。
- [ ] `chat-composer-flyouts` 场景的 `report.json` 返回值里 `detailRows === 3` 且 `detailLabels` 恰为 `输入（最近一轮）` / `上下文窗口` / `模型`（**不要**指望靠看 PNG 核对展开态：capture 是先写 PNG 后跑 check，没有截图会拍到展开的详解卡）。
- [ ] 人工核对 `chat-composer-slash.png`（`CHAT_COMPOSER_CHECK` 所在场景）与 `chat.png`：折叠条仍显示「上下文 <已用>/<窗口>」「累计 …」「缓存命中 …」，与改动前一致。

## 交接

- 权限菜单：说明文字允许换行（`.perm-item-body` 的 `white-space: normal` 是根治点），文案为「有项目 / 无项目」两短句；探针新增 `noOverflow` 断言。
- 输入卡工具行：`.composer-hint` 与 `shortcutHint` 已删除；`.picker-hint` 独立 `v-if`；键位说明只剩 textarea 的 `title`。
- 上下文详解卡：三行 + 一句说明；props 为 `latest / totals / contextWindow / open / model / streaming`。
- 对话窗读模型级参数的口径：`resolveModelParams(activeProvider)`；思考等级写回 `modelParams[当前模型]`。

## 执行记录

**提交：`6468715`（权限下拉换行）+ `306aee9`（输入区三处）+ `8252fb6`（截图探针同步）** —— 按「一个修复一个 commit」拆成三条：前两条各自是可独立回滚的用户可见修复，第三条是它们的探针护栏（`capture.ts` 一个文件里同时含三处探针，无法在不做交互式分块的前提下再细分）。

### 实现分片
- 子代理（片 A）→ `ComposerPermissionSelect.vue` + `capture.ts`（操作 1 与操作 5）
- 主代理（片 B + 片 C）→ `App.vue` + `ComposerContextBar.vue`（操作 2/3/4）—— 计划明说这两片有 props 增删耦合，要同一人顺序做

### 实际改动
- **权限下拉**：根因是**继承**了祖先 `.composer-bar` 的 `white-space: nowrap`，所以给长文案的实际容器 `.perm-item-body` 加 `white-space: normal`（根治点），`.perm-menu` 加 `overflow: hidden` + `word-break: break-word`（兜底）。文案拆成两短句「有项目：根内免确认，越界仍询问」「无项目：不再逐次询问」（两个 `span` 各自成行，不拼 `·`）；`pendingDanger` 那支「再点一次确认：项目根内的敏感操作不再询问」逐字保留，子串「完全权限」「再点一次确认」均在。
- **去键位提示**：删掉模板里 `v-else` 的 `.composer-hint` 分支（`.picker-hint` 摘掉 `v-else`、仍是独立 `v-if`）、`shortcutHint` 常量与两处 `.composer-hint` 样式；键位说明现在只留在 textarea 的 `title`（`composerTitle` 原样未动）。三枚控件的尺寸/状态样式、`.grow`、`.send-slot` 一律未动。
- **详解卡精简**：只留 `输入（最近一轮）` / `上下文窗口` / `模型` 三行；删掉输出、缓存命中、本会话累计、本会话内容四行**模板**；`cachedTokens` / `cachedPercent` / `cachedText` 三个计算属性**全部保留**（折叠条上的 `chat.context-cache` 靠它们出文案）；`ctx-note` 压成一句，删掉「这里只统计消息条数与字符数」那半句；props 删 `messageCount` / `charCount`（连 `withDefaults` 默认值），App.vue 的传参与 `contentChars` 计算属性一并清掉。`.ctx-grid` 两列网格与折叠条**一字未动**。
- **窗口与思考按模型**：新增 `currentModelParams = computed(() => activeProvider === null ? null : resolveModelParams(activeProvider))`；`currentContextWindow` / `effort` 改读它；`setEffort` 写 `modelParams[provider.model]` 且**整份替换**该键对象（`{ ...resolveModelParams(provider), reasoningEffort: next }`），`model` 为空串时直接不写。
- **探针同步**：`CHAT_PERMISSION_CHECK` 增加溢出测量（`menuOverflow` / `noOverflow` / `menuBoxes`）并把判据收成一张 `conditions` 表（`pass` 取该表乘积，避免 `pass` 与条件表漂移）；`CHAT_THINKING_LEVEL_ACT/CHECK` 改按模型级读写（`probe.before` 记「该模型原值，缺省 `'auto'`」而**不是** `undefined` —— 否则 `restored` 会因两边都是 `undefined` 而假真、把 `high` 永久留在配置里；写回时三项写全）；`CHAT_COMPOSER_FLYOUTS_CHECK` 增加 `.ctx-grid dt` 文案集合与 `ctx-note` 断言（`detailRows` / `detailLabels` / `detailNoteClean`）。

### 子代理的一处实测发现（值得记）
计划给的溢出判据（`.perm-item` 的 `getBoundingClientRect()` 是否越出菜单矩形）**恒真**：`.perm-item` 是 `width: 100%` + 全局 `box-sizing: border-box`，文字溢出的其实是**行盒**，`getBoundingClientRect()` 也读不到。子代理用最小 Electron 复现（同款 Chromium）验证：
- 带旧长文案、无换行复位 → `item 393/311`、`body 363/273`（violation）；
- 加上 `.perm-item-body { white-space: normal }` → `311/311`、`273/273`（干净）；
- 给卡片加 `overflow: hidden` **不会**掩盖该读数（仍 `393/311`）。
所以它保留了规格要求的矩形断言，同时把 `scrollWidth > clientWidth + 1` 作为真实判据纳入 `menuOverflow`；实测修复态 `noOverflow === true`、`menuOverflow === 0`。

### 验证（主代理复跑）
- 截图探针（PowerShell 先清 `ELECTRON_RUN_AS_NODE`）：`AURORA_CAPTURE_WINDOWS='chat'` + `AURORA_CAPTURE_ONLY='chat-composer,chat-permission,chat-model-picker,chat-thinking-level,chat-sidebar'` → **7 张图全 PASS**，`report.json` 里 `"pass": false` 出现 **0** 次。关键读数：
  - `chat-composer-permission`：`noOverflow:true`、`menuOverflow:0`、`permissionUnchanged:true`、`permissionCommitted:true`、`triggerAfter:"完全权限"`；
  - `chat-composer-flyouts`：`detailRows:3`、`detailLabels:["输入（最近一轮）","上下文窗口","模型"]`、`detailNoteClean:true`、`mutual:true`、`barClear:true`、`sendClickable:true`；
  - `chat-thinking-level`：`configValue:"high"`、`domValue:"high"`、`optionCount:4`、`restored:true`；
  - `chat-model-picker`：`restored:true`；`chat-composer-slash`（`CHAT_COMPOSER_CHECK` 所在场景）：`pass:true`（`contextBar:1`、`contextUsage:"暂无用量数据"`）。
- **视觉核对 `chat-composer-permission.png`**（我用 Read 工具逐张看）：权限菜单三项完整落在卡片内，第三项「完全权限」的说明**折成两行**（「有项目：根内免确认，越界仍询问」/「无项目：不再逐次询问」），没有任何文字画出右边框；工具行右侧只有「变更前确认 / deepseek-ch… / auto / 发送」，**没有「Enter 发送」字样**；两枚下拉未被压扁（模型名按设计省略号截断，且与发送按钮之间有明显的 `.grow` 空隙，说明没有被压缩）。折叠条「上下文 暂无用量数据」「累计 0」正常。
- `pnpm --filter @aurora/desktop typecheck:web` → 本步三个 .vue **零错误**（全仓余下 13 条全部在 `LlmPage.vue`，即 step 5 的清单）。
- `npx prettier --check` 四个改动文件 → 全绿；`pnpm vitest run apps/desktop/src/main` → 58 文件 / 902 用例全绿（含 `capture.probe-strings.test.ts` 的探针语法护栏 —— 子代理首跑就是被它抓到自己在探针注释里写了反引号）。

### 遗留问题
无阻塞项。`chat-stream` 场景（带真实 token 用量的折叠条，含「缓存命中 512（100%）」）不在本次 `CAPTURE_ONLY` 内，它的读数是 step 7 全量截图与 `chatStreamCheck` 探针的覆盖范围。
