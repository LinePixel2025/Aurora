# Step 02 — 模型思考等级全链路（内核 → 主进程 → 设置页）

- Task: computer-control
- Step: 2 / 7
- Status: done
- Depends on: step 1（`llm.providers.<id>.reasoningEffort` 已在 Schema / 默认值 / 迁移里存在）
- Produces: `ChatRequest.reasoningEffort` 端到端生效 + `LlmPage.vue` 的「思考等级」下拉 + capture 探针

## 目标

设置页里选的「思考等级」真的出现在发给模型的 HTTP 请求体里（`reasoning_effort`），
并且 `auto` 时**完全不下发**该字段（否则不认这个参数的厂商会直接报 400）。

## 输入

- `packages/agent-core/src/llm/types.ts`（`ChatRequest`）
- `packages/agent-core/src/llm/openai-compat.ts` 的 `buildBody`（约 215–236 行）
- `packages/agent-core/src/loop/agentLoop.ts`（`LoopProvider` 形状 + `options.temperature` 透传点）
- `packages/agent-core/src/host/agentHost.ts`（`ProviderConfig` → `runAgentLoop`）
- `apps/desktop/src/main/agent-host.ts` 的 `createProviderFactory`
- `packages/agent-core/src/testing/fakeProvider.ts`（`RecordedCall`）
- `apps/desktop/src/renderer/settings/pages/LlmPage.vue`
- `apps/desktop/src/main/capture.ts`（`SETTINGS_FIELDS_SCRIPT` 与 `defaultCapturePlan`）

## 操作

### 1. 内核类型与请求体

1. `packages/agent-core/src/llm/types.ts`：
   - `import type { ReasoningEffort } from '@aurora/shared'`
   - `export type ReasoningEffortLevel = Exclude<ReasoningEffort, 'auto'>`
   - `ChatRequest` 增加 `reasoningEffort?: ReasoningEffortLevel`（注释写明：`auto` 由装配层映射成
     `undefined`，内核**永远**收不到 `'auto'`）。
2. `packages/agent-core/src/llm/openai-compat.ts` `buildBody`：在 `temperature` 之后加
   `...(req.reasoningEffort === undefined ? {} : { reasoning_effort: req.reasoningEffort })`。

### 2. 循环与 host 透传

3. `packages/agent-core/src/loop/agentLoop.ts`：
   - `LoopProvider.chat` 的请求对象类型加 `reasoningEffort?: ReasoningEffortLevel`；
   - `AgentLoopOptions` 加 `reasoningEffort?: ReasoningEffortLevel`；
   - 调 `provider.chat` 处按既有风格加
     `...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort })`。
4. `packages/agent-core/src/host/agentHost.ts`：
   - `ProviderConfig` 加 `reasoningEffort?: ReasoningEffortLevel`；
   - `runAgentLoop({...})` 里按同样风格透传（与 `temperature` 相邻，注释一句「思考等级」）。
5. `apps/desktop/src/main/agent-host.ts` `createProviderFactory`：
   ```ts
   const reasoningEffort = config.reasoningEffort === 'auto' ? undefined : config.reasoningEffort
   return { provider, model: config.model, temperature: config.temperature,
     ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
   ```
6. `packages/agent-core/src/testing/fakeProvider.ts`：`RecordedCall` 加 `reasoningEffort?`，
   `calls.push` 里按同一风格记录（后续 host 测试要断言它真的传到了 provider）。

### 3. 设置页

7. `apps/desktop/src/renderer/settings/pages/LlmPage.vue`：
   - `addPreset` 新建草稿时补 `reasoningEffort: 'auto'`；
   - `saveProvider` 写回时必须带上 `reasoningEffort: draft.reasoningEffort`
     （**这是本步最容易漏的一处**：`settings:update` 之后会做字段级 sanitize，漏带该字段会静默
     把用户设置重置回默认 `auto`）；
   - 「高级参数与连接测试」折叠区里，`temperature` 之后加一个
     `<SettingField :data-field="`llm.providers.${draft.id}.reasoningEffort`" label="思考等级" ...>`
     内含 `<select v-model="draft.reasoningEffort">`，选项文案：`auto`（不指定，兼容性最好）/
     `low`（更快）/ `medium` / `high`（更深入）。

### 4. 单测与截图探针

8. `packages/agent-core/src/llm/openai-compat.test.ts`：在既有「请求体包含 tools / temperature / json 模式」
   用例旁新增两条：
   - `reasoningEffort: 'high'` → `body['reasoning_effort'] === 'high'`；
   - 不传 `reasoningEffort` → `'reasoning_effort' in body === false`。
9. `packages/agent-core/src/host/agentHost.test.ts`：`provider.create()` 返回带
   `reasoningEffort: 'medium'` 时，`fake.calls[0]?.reasoningEffort === 'medium'`。
10. `apps/desktop/src/main/capture.ts`：
    - 新增 `SETTINGS_LLM_EFFORT_ACT`：若无 provider，先通过
      `window.aurora.settings.update({ llm: { active: 'capture', providers: { capture: {...含 temperature 0.7
      与 reasoningEffort 'high' } } } })` 造一个；等 600ms；点第一张 provider 卡上的 `.more`
      （「高级参数与连接测试」）按钮；再等 600ms。
    - 新增 `SETTINGS_LLM_EFFORT_CHECK`：统计 `[data-field$=".reasoningEffort"]` 与
      `[data-field$=".temperature"]` 计数、读取前者的 `select.value`，
      `pass = 两者计数均 > 0 && value === 'high'`（同时验证「写盘 → 回读 → 渲染」链路）。
    - 在 `defaultCapturePlan()` 的 `SETTINGS_PAGE_IDS` 循环之后追加一个
      `{ name: 'settings', file: 'settings-llm-params.png', query: { page: 'llm' },
        act: SETTINGS_LLM_EFFORT_ACT, check: SETTINGS_LLM_EFFORT_CHECK }`
      （不要塞进循环里，否则每个页面都会多点一次）。
    - 注意 capture 使用**隔离 userData**（`index.ts` 约 100–110 行），这次写盘不会污染开发者本机配置。

## 验收标准

- [x] `pnpm vitest run packages/agent-core` 全绿（新增两条请求体断言 + host 透传断言）
- [x] `pnpm typecheck` 通过
- [x] `grep -rn "reasoning_effort" packages/agent-core/src` 只命中 `openai-compat.ts` 与测试
- [x] `$env:AURORA_CAPTURE="$env:TEMP\aurora-cap-step2"; pnpm dev` 结束后：
      `$env:TEMP\aurora-cap-step2\report.json` 里 `settings-llm-params` 一条 `pass === true`，
      进程退出码为 0，且目录里存在 `settings-llm-params.png`
      （实测 `{"effortFields":1,"temperatureFields":1,"value":"high","pass":true}`，17 张 PNG，退出码 0）
- [x] 在设置页手工改一次思考等级 → 保存 → 重新打开该页，下拉仍显示刚选的值（非 `auto`），
      且 `%APPDATA%` 隔离目录下的 `config.json` 里该 provider 的 `reasoningEffort` 已持久化
      —— **注意这是替代性覆盖，不是原动作**：capture 探针走 IPC 直写，**没有经过
      `LlmPage.saveProvider()`**；`saveProvider` 带字段这件事只由主代理静态复核过。
      审查已把这一点登记为「替代性自述」（见 00-index 的审查结论）。

## 交接

- 内核侧新增的公开类型：`ReasoningEffortLevel`（`@aurora/agent-core` 导出，
  在 `packages/agent-core/src/index.ts` 里补 `export type`）。
- 主进程约定：`'auto'` 在 `createProviderFactory` 内映射为「不下发」，其它层不许再判断 `'auto'`。
- capture 里新增的 act/check 命名与 `defaultCapturePlan` 的插入位置，step 5 会再加一个 agent 页探针，
  两者并列追加即可（不要改这一条的语义）。

## 执行记录

**状态：done（2026-09-20）· 提交 `2ce1bf7`**

### 子代理分片
单一实现分片（子代理 `c8c911b2`），白名单 10 个文件；主代理负责集成、复跑验收与提交。

### 实际改动
- 内核：`llm/types.ts`（`ReasoningEffortLevel` + `ChatRequest.reasoningEffort`）、
  `llm/openai-compat.ts`（`buildBody` 写 `reasoning_effort`）、`loop/agentLoop.ts`、
  `host/agentHost.ts`（`ProviderConfig`）、`testing/fakeProvider.ts`（`RecordedCall`）。
- 主进程：`apps/desktop/src/main/agent-host.ts` 的 `createProviderFactory` 把 `'auto'` 映射成 `undefined`。
- 设置页：`LlmPage.vue` 在高级参数折叠区新增「思考等级」`SettingField` + `<select>`（4 档）。
- capture：`SETTINGS_LLM_EFFORT_ACT` / `SETTINGS_LLM_EFFORT_CHECK` + `settings-llm-params.png`
  （追加在 `SETTINGS_PAGE_IDS` 循环**之外**）。

### 验证（主代理实跑）
- 子代理侧：`pnpm vitest run packages/agent-core/src/llm/openai-compat.test.ts packages/agent-core/src/host/agentHost.test.ts` → 39 通过；
  集成后全仓 `pnpm test` → 48 文件 / 678 用例全过。
- `pnpm typecheck` → 0；`pnpm lint` → 0；`pnpm exec prettier --check` → 通过。
- `$env:AURORA_CAPTURE=%TEMP%\aurora-cap-step2; pnpm dev` → **退出码 0**，17 张 PNG，
  `report.json` 无 FAIL，`settings-llm-params` 探针 `pass: true`（`value: "high"`）。

### 遗留 / 说明
- 辅助 LLM 调用（历史摘要 `index.ts` 的 summarizer、文件分类 `classify/llm.ts`）**不带** `reasoningEffort`，
  等价 `auto`（不下发）。符合「摘要 / 分类要便宜快」的取向，本轮不改；要让它们跟随用户等级需另开一步。
- 交接里提到的「`index.ts` 补 `export type ReasoningEffortLevel`」实际无需改动：
  `export * from './llm/types.js'` 已经导出该类型。
