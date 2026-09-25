# 任务：修复并优化对话窗口收起行为、AI 自改设置、思考等级与模型选择入口、模型设置页与窗口拖动一致性

- 任务标识：chat-window-ux-fixes
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-22 13:41（同日追加需求 6）
- 基线提交：1781d7d68823f9ad836dfb445bc649149e5874c3（执行阶段开工前 `git rev-parse HEAD`，2026-09-22 会话）
- 归档目录：`step/archive/20260923-132859-chat-window-ux-fixes`
- 归档时间：2026-09-23 13:28

## 用户提出的问题（原文照录，供验收对照）

1. 当对话窗口点击收起后，不应打开快速对话，而是直接消失，快速对话合并去侧边栏中
2. 当我与 Agent 说更改 Agent 自身的设置时，其无法更改（修复后需保证 AI 修改设置不会导致 Agent 崩溃）
3. 对话框中没有显示调节 AI 思考等级的按钮
4. AI 模型供应商界面优化，可上网搜索其他 Agent 软件的 AI 模型设置页
5. 窗口不统一，有些能拖动，有些不行
6. **AI 模型页中应添加模型设置，同时在对话框也要添加选择模型的选项**（拆解当天追加）

## 现状核查结论（拆解时已读代码确认，执行阶段不必重复调研）

- 问题 1 根因：`apps/desktop/src/renderer/chat/App.vue` 的 `close()` 是
  `hide('chat')` + `showMiniChat()`——「收起」被实现成「换小窗」。另外 `mini-chat` 是一个独立窗口
  （`window-manager.ts` 的 `SPECS`、`packages/shared/src/mode/windowState.ts` 的主窗口互斥状态机、
  `IPC.window.showMiniChat` 通道、`smoke.ts` / `capture.ts` 断言全都绑着它）。
- 问题 2 现状：**工具表里根本没有能改配置的工具**（只有 `run_command` / `read_file` / `write_file` /
  `list_dir` / `open_path` + Skill + MCP），所以 AI 回答「改不了」符合现状。
  但 AI 可以通过 `run_command` 直接改 `%APPDATA%\Aurora\config.json`，那才是崩溃来源。
  好消息：`SettingsStore.sanitize()`（`packages/shared/src/config/store.ts:362`）已经用
  `SettingsSchema.safeParse` 校验、非法更新会被拒绝，且 `llm.active` 指向不存在的 provider 时
  会被重置为空串。所以新增工具的安全性有现成地基可站。
- 问题 3 现状：`reasoningEffort` 只在「设置 → AI 模型 → 高级参数」里能改
  （`LlmPage.vue:350-361`），两个对话窗都没有入口。数据链路已经全通：
  `createProviderFactory()`（`apps/desktop/src/main/agent-host.ts:163-187`）把
  `config.reasoningEffort === 'auto'` 映射成 `undefined`，其余原样透传到请求体。
  用户已确认：**不需要**按会话覆盖，思考等级按钮直接读写当前生效 provider 的
  `llm.providers.<active>.reasoningEffort` 即可。
- 问题 4 现状：`LlmPage.vue` 是「一屏平铺所有 provider 卡片 + 每卡折叠高级参数」的长滚动页。
  已调研的参考实现：本机 DSH 的 `@deepseek-ai/dsh-client-ui-settings-models`
  （`C:\Users\22798\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\types\client\`）
  的 IA 是「**provider 目录行列表 + 一次只开一张编辑卡 + 凭据状态点 + 删除二次确认 + 自定义设置折叠区**」。
  其 `ProviderEditor.d.ts` 明确记录了「reasoning effort 属于单模型能力，不放在 provider 卡片上，
  而放在 composer 的模型选择器里」——这正是问题 3 与问题 6 要照搬的方向。
  另参考 [vm0 PR #2469 model provider settings page](https://github.com/vm0-ai/vm0/pull/2469)、
  [hermes-agent PR #38551 dedicated Providers settings](https://github.com/NousResearch/hermes-agent/pull/38551)。
- 问题 5 现状：`-webkit-app-region` 只有 `theme.css:196-202` 两条原子类，
  用了 `drag-region` 的只有 chat / mini-chat / onboarding 的头，以及 settings 侧栏的 `.brand`
  （`apps/desktop/src/renderer/settings/App.vue:102`）。没有拖动 composable，
  「窗口能不能拖」取决于各窗自己有没有记得加类 → 不统一。
- 问题 6 现状：配置里一个 provider 只有单个 `llm.providers.<id>.model: string`
  （`packages/shared/src/config/schema.ts:81`），**没有**候选模型列表，所以模型页只有「模型名」一个输入框；
  对话窗则完全没有模型相关 UI。调研结论（DSH 的 `DeepSeekModelsEditor.d.ts` / `ModelListEditor.d.ts` /
  `ModelRow.d.ts`）：模型设置是「列表 + 每行可选 + 拉取合并」的独立分区，
  而模型选择器在 composer 上。据此建模：新增 `llm.providers.*.modelList: string[]`（候选项），
  `model` 仍是唯一生效值——模型页与对话窗读写同一份数据。

## 用户已确认的两个设计决定

- **彻底删除独立小窗**：侧边栏做成「快速会话 / 会话列表」双栏；
  `IPC.window.showMiniChat` 通道、`mini-chat` 窗口与 `WINDOW_NAMES` 条目一并移除。
- **新增受控 `set_setting` 工具**：走 Schema 校验 + 敏感字段黑名单 + 写入审计。

## 步骤

| # | 文件 | 标题 | 状态 | 依赖 |
|---|------|------|------|------|
| 1 | step-01-remove-mini-chat.md | 删除独立小窗，「收起」改为直接消失，快速会话并入交互窗侧栏 | done | - |
| 2 | step-02-setting-tool.md | 新增 set_setting 工具：Schema 校验 + 敏感黑名单 + 写入审计与回滚 | done | step 1 |
| 3 | step-03-chat-thinking-level.md | 对话窗思考等级选择器（读写当前 provider 的 reasoningEffort） | done | step 1 |
| 4 | step-04-llm-page-redesign.md | AI 模型页重构：provider 行列表 + 单卡编辑 + 删除二次确认 | done | step 3 |
| 5 | step-05-model-list-and-picker.md | 模型列表建模 + 模型页「模型设置」区 + 对话窗模型选择器 | done | step 4 |
| 6 | step-06-window-drag.md | 窗口拖动统一（共享 composable + 四窗覆盖 + 拖动探针） | done | step 1 |
| 7 | step-07-verify.md | 全量验证：typecheck / vitest / build / AURORA_SMOKE / AURORA_CAPTURE | done | step 1..6 |
| 8 | step-08-archive.md | 归档清理 | done | step 1..7 |

## 并行与写范围（供 step-runner 派子代理时用）

- step 2 / 3 / 6 都只依赖 step 1，**文件互不重叠**，可同波并行：
  - step 2：`packages/agent-core/src/tools/settings*.ts`、`apps/desktop/src/main/tools/*`、`main/index.ts`、`main/agent-host.ts`
  - step 3：`chat/App.vue`（输入区）、`shared/components/ThinkingLevelSelect.vue`、`capture.ts`（新增探针）
  - step 6：`shared/composables/useWindowDrag.ts`、`settings/App.vue`、`onboarding/App.vue`、`theme.css`、`capture.ts`（新增探针）
- ⚠️ **step 3、5、6 都要改 `apps/desktop/src/main/capture.ts`**（各自新增探针常量与计划条目）。
  这是本计划里唯一的重叠写点：**不要并行改 capture.ts**。
  执行时按 3 → 5 → 6 串行改 capture.ts，或指定其中一人独占该文件并在完事后通知其余步骤。
- step 4 → step 5 必须串行（都在 `LlmPage.vue` 上工作，step 5 依赖 step 4 的卡片骨架）。

## 完成标准

- 六个问题逐条可观测地解决：
  ① 「收起」后 `window.getState()` 里 `chat` 与 `mini-chat` 均不可见、且 `mini-chat` 在 `WINDOW_NAMES` 中已不存在，
     快速会话从侧栏可进；
  ② 工具表里存在 `set_setting`，且用非法路径 / 非法枚举 / 越权字段调用后配置仍能通过
     `SettingsSchema.safeParse`、`pnpm typecheck` 与 `pnpm test` 全绿、应用不崩；
  ③ `AURORA_CAPTURE` 的 `chat-thinking-level` 场景探针 `pass: true`；
  ④ 模型页仍带全量 `data-field` 且新的 provider 列表 / 结构探针 `pass: true`；
  ⑤ 模型页有「模型设置」区、对话窗有模型选择器，两者读写同一份 `llm.providers.<active>.modelList` / `.model`，
     `settings-llm-models` 与 `chat-model-picker` 两条探针 `pass: true`；
  ⑥ 交互窗、设置窗、引导窗的标题栏拖动命中测试全部通过。
- `pnpm typecheck && pnpm test && pnpm build` 三条全绿（与 CI 同一套检查）。
- `docs/` 与实现一致：`mini-chat` 不再作为窗口出现，`set_setting` 有文档，
  思考等级与模型选择入口位置、`modelList` 字段语义都已更新。

## 环境前置（执行阶段必读）

- 本项目是 pnpm workspace。**当前会话的文件策略是 danger-full-access**；
  若在受限策略下运行，`pnpm` / `vitest` 会因为 esbuild 需要 spawn 子进程并通过管道通信而报
  `spawn EPERM`。此时改用直调方式：

  ```powershell
  node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit
  node node_modules/vitest/vitest.mjs run <测试文件路径>
  ```

  `pnpm typecheck` 用 `pnpm -r --parallel` 会再 spawn 一层；受限环境下按上面逐包直调即可
  （`apps/desktop` 还要分别跑 `tsconfig.node.json` 与 `vue-tsc -p tsconfig.web.json`）。
- 单测必须在**项目根目录**执行（`vitest.config.ts` 在根）。
- `AURORA_SMOKE` / `AURORA_CAPTURE` 需要真实 Electron：`pnpm dev`。
  截图工具会自动隔离 userData，不必手动同开 `AURORA_SMOKE`。

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

### step 1 — 删除独立小窗，「收起」改为直接消失，快速会话并入交互窗侧栏

- 状态：done；执行时间 2026-09-22
- 提交：`37bcb84` refactor(chat): 删除独立小窗，「收起」改为直接隐藏，快速会话并入交互窗侧栏（40 文件）
- 执行方式：5 路并行分片（Lead 共享契约 / 渲染层 / 主进程 / capture / 文档），写范围互不重叠；
  验收由 Lead 亲自复跑。
- 验收：`pnpm typecheck` / `pnpm test`（681 用例）/ `pnpm build` / `pnpm format:check` / `pnpm lint` 全绿；
  `AURORA_CAPTURE`（chat + edge-bar）退出码 0，`chat-collapse` 与 `edge-bar-expanded` 探针 `pass:true`，
  `mini-chat.png` 不再产出；`apps|packages|scripts` 下 `mini-chat|miniChat|showMiniChat` 0 命中。
- ⚠️ 与原计划的偏差：原 §4.15 让 `act` 先点「收起」再截图，实测会让 `capturePage()` 在已隐藏窗口上
  **永不返回**、整轮 `AURORA_CAPTURE` 卡死（无 `report.json`）。已改为「点击写进 check、场景不设 act」，
  `CHAT_COLLAPSE_ACT` 删除，`docs/07 §5.3` 同步说明。详见 step 文件执行记录。
- 详见 `step-01-remove-mini-chat.md` 的「执行记录」。

### wave 2 — step 2 / step 3 / step 6（6 路并行分片，写范围互不重叠）

- 提交（按顺序，均可在对应版本上通过 `pnpm typecheck`）：
  - `26b5aed` docs: 补齐 set_setting / 思考等级 / 窗口拖动规格
  - `0478fed` refactor(ui): 窗口拖动统一走显式清单，四窗接线并加兜底规则
  - `82ce244` feat(chat): 输入区新增思考等级选择器
  - `9036ad4` feat(tool): 新增 set_setting（配置层 + 内核 + 主进程 + crash 矩阵）
  - `6c98e76` test(capture): 新增思考等级与窗口拖动探针，钉死交互窗场景顺序
- 分片划分：step 2 拆成 共享配置层 / 内核 / 主进程 三个互不重叠的白名单；
  step 3 与 step 6 的渲染层分片并行；`docs/**` 与 `apps/desktop/src/main/capture.ts` 各由**单一写者**独占
  （docs 归文档子代理，capture 归 Lead），避开计划里点名的 `capture.ts` 重叠写点。
- 验证：`pnpm typecheck && pnpm test && pnpm build && pnpm lint && pnpm format:check` 全绿（49 文件 / 716 用例）；
  `AURORA_SMOKE=1` → **106 PASS / 0 FAIL**；`AURORA_CAPTURE`（全量）退出码 0、21 张 PNG、无 `pass:false`。
- **验证时发现并修掉的两个既有缺陷**（都写进 step 2 执行记录）：
  ① 回传带空 `apiKeyEnc` 的全量 providers 会清空磁盘凭据（同进程被 memorySecrets 掩盖、重启才暴露）；
  ② `smoke.ts` 把配置版本写死成 5，升到 v6 后必然 FAIL。
- ⚠️ 计划偏差：step-04 里「`apiKeyEnc: ''` 必须保留在 patch 里」这句是**错的**，已按 step 2 确立的语义
  （空串 = 本次不改凭据）执行；`CHAT_COLLAPSE` 探针的点击位置偏差见 step 1 记录。
- 详见 `step-02-setting-tool.md` / `step-03-chat-thinking-level.md` / `step-06-window-drag.md` 的执行记录。

### step 4 — AI 模型页重构

- 状态：done；提交：`91d739c`。
- 分片：页面重写（`LlmPage.vue` 771 行）+ 文档；探针由 Lead 写（`SETTINGS_LLM_STRUCTURE_ACT/CHECK`）。
- 偏差：撤掉子代理为迁就旧探针而在行首加的 chevron，改为让 `SETTINGS_LLM_EFFORT_ACT` 先点开卡再点 `.more`；
  探针的「行」判定改用 provider id 白名单（否则 step 5 的 `modelList` 容器会被误算成一行）。
- 判定口径比计划更严：编辑卡数量从 `≤ 1` 改为「点开编辑后**恰好 1 张**」，堵掉「一张都没开」的假通过。
- 验收：`typecheck / test / build / lint / format` 全绿；全量 `AURORA_CAPTURE` 退出码 0、22 张 PNG、无 `pass:false`；
  `settings-llm-structure` 与 `settings-llm-params` 均 `pass:true`；截图人工核对通过。

### step 5 — 模型列表 + 模型设置区 + 对话窗模型选择器

- 状态：done；提交：`756f275`（docs）、`2c600d1`（`modelList` 配置层）、`04957b1`（模型页）、
  `4ba8d51`（对话窗选择器）、`8866abf`（探针）。
- 分片：共享配置层 / 模型页 / 对话窗 / 文档 四路并行（写范围互不重叠），lead 独占 `capture.ts` 写两条探针。
- 关键判断：`modelList` 是 output **必填**字段（zod `.default` 只放宽输入类型），所有 provider 字面量都要带它；
  这类断裂在 `packages/shared/dist` 刷新前看不见，所以本波按「先 `pnpm build:packages` 再 typecheck」验证，
  并补掉 2 处无人认领的连带缺口（`main/index.ts` / `onboarding/App.vue`）。
  另按 `reasoningEffort` 的先例，在迁移里对**非数组** `modelList` 做归零兜底（否则手改错值会让整份配置被判定损坏）。
- 验收：五条 CI 命令全绿（49 文件 / **720** 用例）；全量 `AURORA_CAPTURE` 退出码 0、**24 张 PNG**、无 `pass:false`；
  `chat-model-picker`（配置值 === DOM 值 === `deepseek-reasoner`，`restored:true`）与
  `settings-llm-models`（`rowsBefore:1 → rowsAfterAdd:2 → rowsAfterRestore:1`）均 `pass:true`；两张截图人工核对通过。

### step 7 — 全量验证

- 状态：done；被验证状态 `8866abf`（本步不产生新提交）。
- `pnpm format:check / lint / build:packages / typecheck / test / build` 六条**全部退出码 0**；
  测试 **49 文件 / 720 用例**（基线 48 / 681，无下降）；`out/renderer` 只剩四个窗口入口。
- `AURORA_SMOKE=1` → **106 PASS / 0 FAIL**（含 5 条 crash 矩阵、「损坏 config.json 恢复」、
  「带空 apiKeyEnc 回传后凭据仍在」、窗口 show/hide 与 `primary` 两条）。
- 全量 `AURORA_CAPTURE` → 退出码 **0**、**24 张 PNG**、`report.json` 里 `pass:false` **0 条**、`ok:false` **0 条**、
  `mini-chat.png` 不存在；9 条关键场景全部 `pass:true`（数值见 `step-07-verify.md`）。
- 六个问题逐条结论（含实际观测值）已写入 `step-07-verify.md` 第 4 节，六条均 ✅。
- 死字段自查、`git status --porcelain`（只剩 `?? step/`）、用户配置合法性检查均已记录。
- ⚠️ 如实说明：本机无可用真实 LLM，「AI 改设置」走的是**真实工具注册表**（计划第 7 条第②种做法），
  不是真模型调用；用户真实配置里的 API Key 在我接手前就已是空串（详见 step 7 遗留第 1 条）。

### 独立代码审查（五路并行，干净上下文）与处置

- 维度：正确性与验收逐条比对 / 安全与边界 / 测试质量 / 仓库约定与范围 / 验收命令独立复跑。
  结论汇总：**功能实现未发现假实现**（六个问题都能在代码里找到对应实现），问题集中在**证据强度与两处真实缺陷**。
- 独立复跑一路（不看实现理由，只跑命令）：六条静态命令全 0、smoke 105/105、capture 24 图 16 探针全绿退出码 0、
  真实配置 SHA256 前后一致（隔离有效）→ 给「可交付」。
- **P0（已修）**：`set_setting` 写不了三层以上路径 —— patch 只带局部子树，而 `applyPatch` 对 `general`/`agent`/`modes`
  是整棵子树覆盖，兄弟字段被抹掉 → Schema 拒绝；而 `list` 还把这些路径列给模型、crash 矩阵用
  `accept-or-reject` 把这次真实失败记成了 PASS。修法：以当前分组值深合并；矩阵改为「必须接受且效果落地」。
- **P1（已修）**：
  ① 「空 apiKeyEnc 不丢凭据」用 `hasSecret`（先读内存缓存）断言 → 不可能失败；改为**读盘**断言密文非空（长度 64）。
  ② 矩阵核心断言 `safeParse(settings.get())` **恒真** → 改为 `flush()` 后读 `config.json` 解析。
  ③ `advanced.confirmSensitiveTools` 可被 AI 写成 `false`（自我提权）→ 加入硬黑名单（默认项 9 → 10）。
  ④ 对话窗两条探针的 `restored` 只上报不判定；`SETTINGS_LLM_EFFORT_ACT` 从不写回原值 → 都纳入 `pass` 并写回。
  ⑤ 「点击竖条呼出交互窗」在删掉 mini-chat 场景后变成空转 → 加 `prepare: hide('chat')` 重新依赖点击。
- **P2/P3（已修）**：`failed` 判定纳入 `ok:false`（探针没跑起来不再静默通过）；早退分支补 `pass:false`；
  黑名单对 `[]`/`*` 路径失效 → 新增「必须是具体路径」校验；两个对话窗 ACT 补水合轮询；
  `ComputerToolsDeps.settingsPort` 死字段删除；文档/注释失真 10 余处按实现改正（readonlyPrefixes 只能加严、
  自愈触发条件、探针口径、窗口数口径、两处注释算术）。
- **提交**：`462f621`（代码/测试）+ `43eaded`（文档/注释）。
- 修完复验：`build:packages / typecheck / test`（49 文件 / **723** 用例）`/ build / lint` 全绿；
  `AURORA_SMOKE` **109 PASS / 0 FAIL**，`agent.tools.enabled` 由 `accepted=no` 变为 `accepted=yes effect=ok disk=ok`。
  ⚠️ 修复批的**全量 capture 复查未跑完**（工作区存在并发写者 → electron-vite 反复重启，已停止）；审查前一刻的
  全量 capture 是 24 图 / 0 `pass:false` / 退出码 0。
- **未修（如实记录）**：`set_setting` 回填「已修改」时 `sanitize` 的规范化发生在 `applyPatch` 返回**之后**，
  因此文案仍偏乐观（但「生效值」与「磁盘」两条断言已覆盖）；`mcp.servers` 的空 `envEnc` 回传会清掉 MCP 凭据
  （与 provider 同类缺陷，本轮未触碰 MCP 编辑链路）；设置页「删除 provider」在 `applyPatch` 语义下其实是 no-op
  （provider 不会被删掉，密文却被清）——两者都是**既有缺陷**，需要单独的契约改动。
- **并发写者干扰（需要用户知晓）**：工作区里有另一路会话/工具在写文件 —— 未跟踪的 `Design/`
  （design 编排产物）与 `integrations/classisland-bridge/obj/`（dotnet 构建产物，被 git 忽略但 prettier 会检查），
  两者会让仓库级 `pnpm format:check` 失败；本轮 60 个改动文件本身 prettier 全过（已单独验证）。
