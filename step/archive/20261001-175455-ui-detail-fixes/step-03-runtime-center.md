# Step 03 — 运行时、引导页与 Center 接线到模型级参数

- Task: ui-detail-fixes
- Step: 3 / 8
- Status: done
- Depends on: step 1、step 2
- Produces: 主进程、引导页与 Center 两端都按「当前生效模型」读取 / 写入 `modelParams`；请求体不再下发 `temperature`；`settingsHint` 与内核工具描述与可写面同口径
- Phase: 接口与集成
- Writes: `apps/desktop/src/renderer/onboarding/App.vue`、`apps/desktop/src/main/agent-host.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/settings-patch.test.ts`、`apps/desktop/src/main/center/remote-control.ts`、`apps/desktop/src/main/center/connector.ts`、`apps/desktop/src/main/center/remote-control.test.ts`、`apps/desktop/src/main/center/connector.test.ts`、`packages/center/web/src/store.ts`、`packages/center/web/src/components/SessionListPanel.vue`、`packages/center/web/src/components/SessionView.vue`、`packages/agent-core/src/tools/settings.ts`
- Size: L
- Risk: ① 「删一半」—— 例如 Schema 删了 temperature 但 `agent-host.ts:200` 还读它、或 `index.ts:1387` 的 `switchLlm` 还写 provider 级 `reasoningEffort`（后者的症状是 Center 远程切思考等级**静默无效**，因为写进去的键会被 Schema strip 掉）；② Center 网页端读的是脱敏配置的 `llm.providers.<id>` 切片，字段搬走而网页端不改 → 占比条与思考等级显示退回默认值，看起来像「功能没了」。两处都用 `pnpm typecheck` 兜不全（Center 网页端是宽松解析），必须逐处按本文清单改。

## 目标

模型能力与思考等级在**运行时**也按模型解析：请求装配、图片能力判定、Center 远程切换与状态快照四处读到的都是「当前生效模型」的参数；`temperature` 不再出现在任何请求体里，引导页也不再渲染它。

## 输入

- `apps/desktop/src/main/agent-host.ts:150-230`：`build()` 里 `const reasoningEffort = config.reasoningEffort === 'auto' ? undefined : config.reasoningEffort`（`:175-177`）、`temperature: config.temperature`（`:200`）、`vision: config.vision === true`（`:203`）。
- `apps/desktop/src/main/ipc.ts:1000-1071`：`prepareAttachments` 用 `visionEnabled(deps)` 决定「图片分片下发」还是「降级成一行说明」（`imageFallbackBlock`，文案在 `apps/desktop/src/main/attachments.ts:159-161`）。
- `apps/desktop/src/main/index.ts`：stub provider 字面量在 `:1932-1938`、`:2159-2168`、`:3810-3814`；多模态 smoke 段的 `setVision` 在 `:3620-3635`、收尾复原在 `:3704`；`switchLlm` 的 handler 在 `:1387-1430`（写 `provider.reasoningEffort`）。
- `apps/desktop/src/main/smoke.ts:145 / 174 / 196 / 214 / 291 / 339`：IPC 级 smoke 的 provider 字面量。
- `apps/desktop/src/main/center/remote-control.ts:79-84`：ClientStatus 的 `llm` 快照（`activeProvider?.reasoningEffort ?? 'auto'`）。
- `packages/center/web/src/store.ts:110-120`（`RemoteLlmConfig` 类型：`{ model, modelList, contextWindow, reasoningEffort }`）、`:829-845`（`extractRemoteLlm` 从脱敏配置解析）、`:778-800`（`switchLlm` 的乐观更新）；`packages/center/web/src/components/SessionListPanel.vue:58`（模型选项来自 `modelList`）、`:186-188` / `:245`（思考等级读写）；`packages/center/web/src/components/SessionView.vue:77`（占比分母 `contextWindow`）。
- `apps/desktop/src/main/center/remote-control.test.ts:76-121`、`apps/desktop/src/main/center/connector.test.ts:88 / 682-687`：断言快照与 `llm.switch` 落值的夹具。
- `apps/desktop/src/main/settings-patch.test.ts:39-43`：provider 夹具（含 `temperature` / `contextWindow`）。
- `apps/desktop/src/main/settings-hint.ts` 第 18 行与 `packages/agent-core/src/tools/settings.ts` 第 67-70 行：两处可写面文案（必须与 step 2 的 `WRITABLE_PATH_OVERRIDES` 同口径）。
- `apps/desktop/src/renderer/onboarding/App.vue`：引导页「AI 模型」步的 provider 写盘（`:104-118`，字面量里带 provider 级 `temperature` / `reasoningEffort` / `contextWindow` / `vision`，且 `modelList: []`）、表单字段 `form.temperature`（`:47`）与「temperature」输入框（`:343-344`）。step 2 删字段后这里的**多余属性检查**会直接编译报错（`settingsStore.update` 的补丁类型是强类型的），必须在本步一起改掉 —— 这也是用户第 6 条「删除 temperature 设置字样」的闭合点之一。
- `packages/agent-core/src/host/agentHost.ts:34-43`（`ProviderConfig` 含可选 `temperature`）、`:635-668`（`resolveImages` 的二次判定用 `config.vision`）、`:719-721`（temperature 透传）：内核**保持**这些能力，本步只改桌面装配层喂什么值。
- 取值口径（来自 step 2）：`import { resolveModelParams } from '@aurora/shared'`，`resolveModelParams(provider)` 缺省按 `provider.model` 取，未命中回落 `{ reasoningEffort: 'auto', contextWindow: 0, vision: false }`。

## 操作

1. `apps/desktop/src/main/agent-host.ts`：在 `build()` 里加 `const params = resolveModelParams(config)`；删掉 `temperature: config.temperature` 这一行（**不是**改成 `undefined`，是整行删除 —— 装配层不再喂值）；`vision: params.vision === true`；`reasoningEffort` 的 `'auto' → undefined` 映射改成读 `params.reasoningEffort`，其余逻辑（含 `...(reasoningEffort === undefined ? {} : { reasoningEffort })`）不动。
2. `apps/desktop/src/main/ipc.ts`：`visionEnabled(deps)` 改成「取 `llm.providers[llm.active]`，用 `resolveModelParams(provider).vision === true` 判定」；读不到 provider 时仍按**关**处理（注释里的口径不变：绝不因配置异常把图片发出去）。
3. `apps/desktop/src/main/index.ts`
   - `:1387-1430` 的 `switchLlm`：`request.reasoningEffort !== undefined` 时写 `provider.modelParams[provider.model] = { ...resolveModelParams(provider), reasoningEffort: request.reasoningEffort }`（用 `settings.mutate` 的 draft；`modelParams` 里没有当前模型的条目时**就地建一条**，值从 `resolveModelParams` 取默认再覆盖 `reasoningEffort`）；`request.model !== undefined` 时仍只写 `provider.model`（模型级参数随模型 id 走，不需要搬 key）。日志字段不变。
   - stub provider 字面量（`:1932-1938` / `:2159-2168` / `:3810-3814`）：删 `temperature`，把 `contextWindow` / `vision` / `reasoningEffort` 收进 `modelParams: { [STUB_MODEL]: { reasoningEffort: 'auto', contextWindow: …, vision: … } }`。
   - 多模态 smoke 段的 `setVision`（`:3620-3635`）：写 `modelParams: { [STUB_MODEL]: { …resolveModelParams(…), vision } }`；`:3704` 的收尾复原同理改成把该模型的 `vision` 置回 `false`。这一段的三条注释（①拉回 active ②整体写回 provider ③重写 API Key）语义不变，别删。
4. `apps/desktop/src/main/smoke.ts` 与 `apps/desktop/src/main/settings-patch.test.ts`：provider 字面量同步（删 `temperature`，按钮字段搬进 `modelParams`）。
5. `apps/desktop/src/main/settings-hint.ts`：把第 18 行改成 `- llm.providers.<id>.model / modelParams.<modelId>.reasoningEffort（模型与思考等级；baseUrl / API Key 等凭据一律只读）`。
6. `packages/agent-core/src/tools/settings.ts`：第 67-70 行的工具描述里的可写范围同步成 `模型 provider 的 model / modelParams.<modelId>.reasoningEffort`，删掉 temperature。
7. `apps/desktop/src/renderer/onboarding/App.vue`：删掉 `temperature` 的输入框、`form.temperature` 字段与写盘字面量里的 `temperature`；把 `reasoningEffort`（引导页固定写 `'auto'`）与 `contextWindow: 0` / `vision: false` 收进 `modelParams: { [model]: { … } }`（`model` 为空时不写条目，与 step 2 的迁移语义一致）；`modelList: []` 保持原样（空列表的模型行由 step 5 的 `adoptCurrentModel` 兜住）。引导页的文案与步骤顺序不动。
8. Center 平价
   - `apps/desktop/src/main/center/remote-control.ts:79-84`：快照里的 `reasoningEffort` 改成 `activeProvider === undefined ? 'auto' : resolveModelParams(activeProvider).reasoningEffort`（形状不变，Center 网页端与服务器协议都不用改）。
   - `packages/center/web/src/store.ts`：`RemoteLlmConfig.providers[id]` 的切片改成按「该 provider 的 `model`」在 `modelParams` 里取值（保留 `model` / `modelList` 原样；`contextWindow` 取 `modelParams[model]?.contextWindow ?? 0`、`reasoningEffort` 取 `modelParams[model]?.reasoningEffort ?? 'auto'`，取值前照旧做类型收窄）；`switchLlm`（`:778-800`）的乐观更新逻辑不变（它只是把远端回传的状态写进快照）。
   - `packages/center/web/src/components/SessionListPanel.vue`（第 186-188 行与第 245 行）与 `packages/center/web/src/components/SessionView.vue`（第 77 行）的结构保持不变（它们读的是上面的切片），但要确认切片调整后两处仍拿得到值（占比重算逻辑依赖 `contextWindow > 0`）。
   - **切模型后占比分母会失效**：`llm.switch` 成功只推 `client.status`（快照只有 `activeProviderId / model / reasoningEffort`，**不含** `contextWindow`），而 `entry.remoteLlm` 只在选中客户端时由 `fetchRemoteConfig` 拉一次（全仓唯一调用点在 `packages/center/web/src/components/SessionListPanel.vue:82`）—— 下沉到模型级之后，切模型会让 `SessionView.vue:77` 的占比分母停在**上一个模型**的窗口值。修法：在 `packages/center/web/src/store.ts` 的 `switchLlm` 成功之后补一次 `await fetchRemoteConfig(clientId)`（同文件内的现成函数），别去改 `ClientStatus` 的形状（那会连带改服务器端）。
   - 两份测试夹具同步：`apps/desktop/src/main/center/remote-control.test.ts:84-121`（provider 夹具改成 `modelParams`，快照断言形状不变）、`apps/desktop/src/main/center/connector.test.ts:88 / 682-687`（`llm.switch` 后断言的落值位置改到 `modelParams[model].reasoningEffort`）。
9. 不要改 `packages/agent-core` 的 `ProviderConfig`（`temperature?: number` 保留，`fakeProvider` / 子任务 `task.ts` / 单测仍在用），也不要改 `packages/center/src`（服务器端只透传 `reasoningEffort`）。

## 分片建议

- 片 A：`agent-host.ts` + `ipc.ts` + `settings-hint.ts` + `packages/agent-core/src/tools/settings.ts`（请求装配与可写面文案）。
- 片 B：`index.ts` + `smoke.ts` + `settings-patch.test.ts`（夹具与 `switchLlm`）。
- 片 C：`apps/desktop/src/main/center/*` + `packages/center/web/src/*`（Center 平价）。
- 三片写不同文件可并行；片 B、C 依赖片 A 引用的 `resolveModelParams`（来自 step 2，已 build）。

## 验收标准

- [ ] `pnpm typecheck` 全绿 —— 这一步把它当**清单**用：任何还按 provider 级读 `temperature` / `vision` / `contextWindow` / `reasoningEffort` 的地方都会在这里报错，逐个消掉。
- [ ] `grep -rn "temperature" apps/desktop/src/main apps/desktop/src/renderer packages/agent-core/src --include=*.ts --include=*.vue` 的命中只剩这些**允许**的类别：内核自身的能力与透传（`agent-core/src/host/agentHost.ts` 的 `ProviderConfig.temperature`、`llm/openai-compat.ts` / `llm/responses.ts` 的请求体可选字段、`tools/task.ts`、`testing/fakeProvider.ts`）、分类管线自己的 `classify/llm.ts`（不在范围）、以及 `capture.ts` 里解释「temperature 已删除」的注释/断言。`agent-host.ts`、`index.ts`、`onboarding/App.vue` 里**不得**再出现读取或写入配置 temperature 的行。
- [ ] `pnpm vitest run apps/desktop/src/main packages/center` 全绿（含改过的 `remote-control.test.ts` / `connector.test.ts` / `settings-patch.test.ts`）。
- [ ] `pnpm build` 后跑 `$env:AURORA_SMOKE='1'; $env:AURORA_SMOKE_ONLY='2.8'; pnpm dev`，`%TEMP%\aurora-smoke-logs` 里 `AURORA_SMOKE_RESULT` 的 2.8 段（多模态：开 `vision` 时图片进请求体为 `image_url` 分片、关时降级成一行说明）全绿。
- [ ] 新增/改写的 Center 断言里能看到「`llm.switch` 把 reasoningEffort 落到 `modelParams[model]` 上」这条（例如 `connector.test.ts` 的用例名或断言指到该路径）。

## 交接

- 运行时读取口径统一为 `resolveModelParams(provider)`（缺省按 `provider.model`）；Center 远程切换写的是 `modelParams[当前模型].reasoningEffort`。
- 请求体不再有 `temperature` 字段（内核能力保留，但桌面装配层不喂值）—— step 7 的端到端断言与文档口径以此为准。
- `packages/center/src`（服务器与 hub）未改：`llm.switch` 仍是透传。

## 执行记录

**提交：`54f4cf9`（主进程 / 引导页 / 冒烟夹具）+ `101be7f`（Center 平价）** —— 分两条是因为 Center 网页端与主进程运行时是两件可独立回滚的事。

### 实现分片
- 子代理 A（片 A）→ `agent-host.ts` + `ipc.ts` + `settings-hint.ts` + `packages/agent-core/src/tools/settings.ts`
- 子代理 C（片 C）→ `apps/desktop/src/main/center/**` + `packages/center/web/src/**`
- 主代理（片 B）→ `index.ts` + `smoke.ts` + `settings-patch.test.ts` + `renderer/onboarding/App.vue`（操作 7 计划未分片，归主代理）

### 实际改动
- 请求装配（`agent-host.ts`）：`build()` 里加 `const params = resolveModelParams(config)`；**整行删除** `temperature: config.temperature`（内核 `ProviderConfig.temperature?` 能力保留，只是桌面装配层不再喂值）；`vision` / `reasoningEffort` 改读 `params`（`'auto' → undefined` 的映射与 spread 写法一字未动）。
- 图片能力判定（`ipc.ts`）：`visionEnabled` 改成 `resolveModelParams(provider).vision === true`，provider 取不到仍按**关**。
- 远程切换（`index.ts` 的 `switchLlm`）：先落 `model` 再写参数（等级落在**新模型**名下），写的时候**整份替换**该模型条目（`withModelParams`）而不是只改一项。
- 夹具同步：`index.ts` 三处桩 provider 字面量（capture-stub / smoke / resume）、多模态段的 `setVision`、段尾复原、`smoke.ts` 六处（渲染层脚本里的 provider 字面量，String.raw 模板内、注释未用反引号）、`settings-patch.test.ts` 的 provider 夹具，全部改成 `modelParams: { [模型]: { 三项 } }`。
- 可写面文案三处对齐：`settings-hint.ts` 与内核 `tools/settings.ts` 的工具描述，与 step 2 的 `WRITABLE_PATH_OVERRIDES` 同口径。
- 引导页（`onboarding/App.vue`）：删掉 `form.temperature`、temperature 输入框与写盘字面量里的 temperature；`reasoningEffort` / `contextWindow` / `vision` 收进 `modelParams[model]`（`model` 为空串时写 `{}`，与迁移语义一致）；`modelList: []` 保持原样。
- Center 平价：`remote-control.ts` 快照的 `reasoningEffort` 改走 `resolveModelParams`（**形状不变**，服务器协议不用改）；`packages/center/web/src/store.ts` 的 `extractRemoteLlm` 切片改从 `modelParams[model]` 取值（网页端仍只 `import type`，手写等价收窄，不引入运行时依赖），`switchLlm` 成功后补一次 `await fetchRemoteConfig(clientId)`（否则切模型后占比分母停在上一个模型）；`SessionListPanel.vue` / `SessionView.vue` 结构未动（已核对数据源一路到主进程的 `redactSettings`，`modelParams` 原样到达网页端）。

### 与计划的偏离
1. **新增文件 `apps/desktop/src/main/llm-params.ts` + `llm-params.test.ts`**（计划 Writes 里没有）。理由：步骤的「验收标准」要求有一条能指到「`llm.switch` 把 reasoningEffort 落到 `modelParams[model]`」的断言，但**真正的写入点不在 `connector.ts`**（该文件只透传，计划给的行号已漂移；落值在 `index.ts` 的 `switchLlm`，而 `index.ts` import electron、vitest 收不了它）。把这段写口径抽成纯函数并单测，既让「写一半」这个本步头号风险有了可执行的护栏，也让 `index.ts` 三处调用点（`switchLlm` / `setVision` / 段尾复原）共用一份实现。`llm-params.ts` 与 `main/tools/workspace-target.ts` 等既有纯模块同款。
2. 计划的操作 7（引导页）未出现在「分片建议」的三片里，归主代理做。

### 验证（主代理复跑）
- `pnpm --filter @aurora/agent-core build` → 成功（改了 agent-core，必须先重建供下游 typecheck）。
- `pnpm typecheck` → 本步涉及的 11 个文件**零错误**；全仓余下 **17 条全部**落在 step 4（`renderer/chat/App.vue` ×4）与 step 5（`renderer/settings/pages/LlmPage.vue` ×13）的写范围内 —— 即这两个文件正是下一步的施工清单，符合计划预期。
- `grep temperature` 于 `agent-host.ts` / `index.ts` / `onboarding/App.vue` → **无命中**；全仓余下命中只剩计划允许的四类（内核能力与透传、`classify/llm.ts`、`capture.ts` 的探针夹具与注释、`LlmPage.vue`）—— 后两者分别归 step 4/5。
- `pnpm vitest run apps/desktop/src/main packages/center` → `Test Files 65 passed (65)` / `Tests 1004 passed (1004)`。
- 多模态冒烟段：`Remove-Item env:ELECTRON_RUN_AS_NODE; $env:AURORA_SMOKE='1'; $env:AURORA_SMOKE_ONLY='2.8'; pnpm dev` → `SUMMARY 133/133 passed`、**0 FAIL**；关键那条读到
  `PASS 多模态输入：开启时图片作为 image_url 分片下发且历史只存路径；关闭时不下发图片分片 — on=true(done,array:text+image_url) off=true(done,string(5)) storedPath=true req=1+1`。
- `pnpm --filter @aurora/center build`（子代理跑）→ `tsc && vite build` 成功；网页端 `tsc --noEmit` 干净。

### 遗留问题
- 无阻塞项。`packages/center/src`（服务器与 hub 协议）**未改**：`llm.switch` 仍是透传。
- 新增的 `withModelParams` 只覆盖「当前生效模型」；设置页（step 5）写的是**任意模型行**，那一步自己有一套 `normalizedModelParams`，两者不冲突（一个在主进程、一个在渲染层）。
