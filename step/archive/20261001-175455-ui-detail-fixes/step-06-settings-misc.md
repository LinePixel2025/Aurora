# Step 06 — 设置页杂项：通用页删说明句 + 生图模型空态入口

- Task: ui-detail-fixes
- Step: 6 / 8
- Status: done
- Depends on: none
- Produces: 设置页两处文案/入口修正：通用页不再有「会话管理」说明句；生图模型空状态有可点的添加入口
- Phase: 界面
- Writes: `apps/desktop/src/renderer/settings/pages/GeneralPage.vue`、`apps/desktop/src/renderer/settings/components/ImageGenSection.vue`
- Size: S
- Risk: 生图空态的 `data-empty="imagegen.providers"` 元素被 `capture.ts` 的 `SETTINGS_LLM_FIELDS_SCRIPT` 断言依赖（空态与行容器二选一）—— 加按钮时**保留**这个元素，不要用按钮替换它。

## 目标

「通用」页里那块只有一句说明的空壳卡片消失；生图模型在没有任何 provider 时，用户能直接看到并点到「添加生图模型」按钮，而不是看到一句「先在下面『添加生图模型』」却找不到入口。

## 输入

- `apps/desktop/src/renderer/settings/pages/GeneralPage.vue:309-317`：一段注释 + 一个只有 `<p class="section-desc">项目登记与会话列表已移至「会话管理」页（主界面左栏「项目对话」也可直接添加项目）。</p>` 的 `section-card`（无 `data-field` / `data-empty` 锚点）；文件头 `:13-14` 的注释也在讲同一件事。该页探针 `SETTINGS_FIELDS_SCRIPT`（`apps/desktop/src/main/capture.ts:5089-5154`）在本页只数 `data-field` 与断言 `projects.* === 0`，删这段不影响它。
- 会话管理页仍在（`apps/desktop/src/renderer/settings/pages/SessionsPage.vue`，侧栏入口 `apps/desktop/src/renderer/settings/App.vue:54`），删句后用户仍能找到它。
- `apps/desktop/src/renderer/settings/components/ImageGenSection.vue`：空态文字在 `:376-378`（「还没有可选的模型：先在下面「添加生图模型」。」）与 `:381-383`（`<p class="empty-inline" data-empty="imagegen.providers">`）；工具行连「+ 添加生图模型」按钮在 `:386-392`，被 `v-if="drafts.length > 0 || mode === 'add'"` 门控 —— 这就是空状态下没有按钮的根因；添加态区块（`v-if="mode === 'add'"`，含 `IMAGEGEN_PRESETS` chips）在 `:394-420`；`startAdd()` 在 `:146-152`。
- 正确样板：`apps/desktop/src/renderer/settings/pages/LlmPage.vue:669-677`（空态卡里给主按钮「添加 AI 模型」，`@click="startAdd"`）。

## 操作

1. `GeneralPage.vue`：删掉 `:309-317` 整块（注释 + `section-card`）；同时把文件头 `:13-14` 那句「本页保留一条指引占位」的注释改掉（它描述的东西已经不存在）。页面的 `data-field` 锚点、`appearance.accent` 区块、提示条区块一律不动。
2. `ImageGenSection.vue`：把「+ 添加生图模型」主按钮放进空状态，让空配置下也有入口 —— 在 `:381-383` 那个 `data-empty="imagegen.providers"` 的空态块里（或紧随其后）加一枚 `variant="primary"` 的 `AppButton`，文案「+ 添加生图模型」，`@click="startAdd"`；`:376-378` 那句「先在下面『添加生图模型』」随之改成不指向「下面」（例如「还没有可选的模型：先添加一个生图模型」）。**保留** `data-empty="imagegen.providers"` 元素本身，`capture.ts:5464-5482` 的空态/行容器二选一判据依赖它。
3. 工具行（`:386-392`）的门控改成「有 provider 或处于添加态时显示」，与现在一致即可 —— 空态已经由第 2 条的按钮兜住，两处不要重复渲染两个同名按钮（空态下工具行不显示）。

## 验收标准

- [ ] `pnpm typecheck` 全绿。
- [ ] `pnpm prettier --check apps/desktop/src/renderer/settings/pages/GeneralPage.vue apps/desktop/src/renderer/settings/components/ImageGenSection.vue` 退出码 0。
- [ ] `grep -n "会话管理" apps/desktop/src/renderer/settings/pages/GeneralPage.vue` 无命中。
- [ ] `grep -n "data-empty=\"imagegen.providers\"" apps/desktop/src/renderer/settings/components/ImageGenSection.vue` 仍命中一次。
- [ ] 截图核对（隔离 userData 下生图默认就是未配置）：PowerShell 下 `Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`，`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-misc"; $env:AURORA_CAPTURE_WINDOWS='settings'; $env:AURORA_CAPTURE_ONLY='settings-general,settings-llm'; pnpm dev`，结束后：
      - `report.json` 里 `settings-general` 与 `settings-llm` 两条 PASS（前者跑 `SETTINGS_FIELDS_SCRIPT`，含「`projects.*` 必须为 0」的回归护栏；后者跑 `SETTINGS_LLM_FIELDS_SCRIPT`，含生图空态与行容器二选一的判据）；
      - 打开这两张 PNG 人工核对：`settings-general.png` 里没有那句关于会话管理的说明；`settings-llm.png` 的生图模型区能看到可点的「+ 添加生图模型」按钮。

## 交接

- 生图空态现在自带主按钮（`startAdd`），工具行仍只在「有 provider 或添加态」出现；`data-empty="imagegen.providers"` 锚点保留。
- 通用页没有新增/删除任何 `data-field` 锚点。

## 执行记录

**提交：`61ebdbe`（两处 UI 修正）+ `8791873`（capture 滚动前置）**

### 实现分片
- 子代理 → `GeneralPage.vue` + `ImageGenSection.vue`（操作 1、2）
- 主代理 → `capture.ts` 的滚动前置（见下「偏离」）

### 实际改动
- `GeneralPage.vue`：删掉那块只有一句 `section-desc`（「项目登记与会话列表已移至「会话管理」页…」）的空壳 `section-card` 与配套注释，并把文件头那句「本页保留一条指引占位」的注释一并改掉（它描述的东西已不存在）。`data-field` 锚点、外观区块、提示条区块一字未动。
- `ImageGenSection.vue`：空状态里新增 `variant="primary"` 的「+ 添加生图模型」按钮（`@click="startAdd"`），空态文案从「先在**下面**『添加生图模型』」改成「先添加一个生图模型」（不再指向不存在的下方入口）；`data-empty="imagegen.providers"` 元素本身保留（`SETTINGS_LLM_FIELDS_SCRIPT` 的空态/行容器二选一判据依赖它）；工具行门控保持原样。子代理给新按钮的 `v-if` 加了 `mode !== 'add'` 守卫 —— 点空态按钮会进添加态而 `drafts.length` 仍为 0，不加守卫工具行会同时渲染一枚同名按钮，正是计划要避免的「重复渲染两个同名按钮」。

### 偏离
**新增 `SETTINGS_LLM_SCROLL_ACT` 并接到 `SETTINGS_PAGE_IDS` 循环的 `act` 上**（`capture.ts`，不在本步 Writes 里）。理由与本步的验收直接相关：`settings-llm.png` 固定在页头拍图，而生图模型区组在该页**最底部**（设置窗固定高度 + 内部滚动），不滚的话这轮新加的按钮**永远拍不到**，「能看到可点的『+ 添加生图模型』按钮」这条人工核对项就无法成立 —— 而它正是本步唯一的视觉验收。只滚 DOM、不改配置，同一场景的 `SETTINGS_LLM_FIELDS_SCRIPT` 判据不受影响（实跑仍 PASS）。

### 验证（主代理复跑）
- `npx prettier --check` 两文件 → 全绿；`pnpm --filter @aurora/desktop typecheck:web` → **0 错**；`pnpm typecheck` 全仓 0 错。
- `grep -n "会话管理" GeneralPage.vue` → **无命中**；`grep -c 'data-empty="imagegen.providers"' ImageGenSection.vue` → **1**。
- 截图探针：`AURORA_CAPTURE_WINDOWS='settings'` + `AURORA_CAPTURE_ONLY='settings-general,settings-llm'` → 两场景 PASS：
  - `settings-general`：`projectsFields:0`、`projectsRows:0`、`unexpected:[]`（回归护栏）；
  - `settings-llm`：`imagegenEmpty:true`、`imagegenEnabledFields:1`、`imagegenActiveFields:1`、`emptyStates:["llm.providers","imagegen.providers"]`。
- **人工核对两张 PNG**（Read 工具逐张看）：
  - `settings-general.png`：「启动」卡（开机自启 / 以管理员身份运行 / 唤出快捷键）下面**直接**是「外观」卡 —— 那句会话管理说明与空壳卡已消失，页面无残留空段。
  - `settings-llm.png`：生图模型区组完整可见 —— 「还没有可选的模型：先添加一个生图模型。」+ 带虚线的空状态卡「还没有生图模型：添加一个并设为默认后，Agent 才能生成图片。」（`data-empty` 锚点）+ **可点的蓝色主按钮「+ 添加生图模型」**。

### 遗留问题
- 空态点按钮进入添加态后，空态按钮消失、工具行出现一枚同名（disabled）按钮，位置相邻 —— 这是「避免重复渲染」的必然取舍（消除这点位移需要改工具行门控，本步明确不允许）。
