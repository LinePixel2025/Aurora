# Step 06 — prompt caching：系统提示词前缀稳定化 + 工具顺序稳定 + 缓存命中观测，并收口全量文档

- Task: opencode-parity
- Step: 6 / 7
- Status: done
- Depends on: step 5（工具面与设置页均已定稿，工具清单固定为 8 个电脑操控工具）
- Produces: 系统提示词「静态在前、易变在后」的渲染顺序与回归测试；`toLlmTools()` 的确定性排序；
  `TokenUsage.cachedTokens` 的解析与端到端展示；本轮全部文档收口与全量验收
- Phase: 测试与文档
- Writes: `packages/agent-core/src/context/systemPrompt.ts`、`packages/agent-core/src/context/systemPrompt.test.ts`、`packages/agent-core/src/tools/registry.ts`、`packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/skills/registry.test.ts`、`packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/llm/openai-compat.ts`、`packages/agent-core/src/llm/openai-compat.test.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`apps/desktop/src/renderer/chat/components/ComposerContextBar.vue`、`apps/desktop/src/main/index.ts`（**smoke 断言宿主**）、`apps/desktop/src/main/smoke-llm.ts`、`apps/desktop/src/main/capture.ts`、`AGENTS.md`、`docs/04-roadmap.md`、`docs/06-agent-core.md`（§21 订正）、`docs/07-ui-spec.md`、`docs/10-user-guide.md`、`docs/11-privacy.md`、`docs/README.md`
- Risk: 三处。① **改小节顺序会打红一批既有断言**——`systemPrompt.test.ts` 与任何按固定顺序拼字符串的测试都要同步更新；
  退路是把"顺序"本身写成一条断言（静态段与易变段的边界），以后改顺序只改一处。
  ② **`toLlmTools()` 排序会改变发给模型的 `tools` 数组顺序**——语义上无害（工具顺序不参与语义），
  但**已知会打红 `packages/agent-core/src/skills/registry.test.ts:148`**（它断言注册序），
  改断言口径为"已按字典序"，不要改被测代码去迁就旧顺序。
  ③ **排序的生效点在 `agentLoop.ts` 而不是 `registry.ts`**（见「操作 2」的告警）——
  改错地方会让本步的验收看起来"过了"（单测绿）但请求体毫无变化，是**假 PASS**，
  所以 smoke 那条"两轮 tools 数组相同且已排序"必须真的跑起来看。
  ④ 本步同时承担「全量验收 + 文档收口」，范围最容易失控——**只做上面 `Writes` 列出的文件**，
  不收尾任何与本任务无关的既有缺口（发现新问题记进执行记录的「已登记、未修」）。

## 目标

同一会话连续两轮请求，服务端收到的**系统提示词静态前缀逐字节相同**、**`tools` 数组顺序也相同**，
因此网关的自动前缀缓存能真正命中；缓存命中量能被解析出来并在「上下文详解」条上看到，
让「缓存生效」这件事可观测、可复跑，而不是只能靠推理。

## 输入

- `packages/agent-core/src/context/systemPrompt.ts`：`buildSystemPrompt`（`:59`）当前的
  `sections.push` 顺序（人设 → 模式 → 感知 → 任务清单 → 历史摘要 → Skill → 工具 → 规范 → 设置 → 安全规则）；
  `SAFETY_RULES`（`:16`）；`describeTools`（`:152`）
- `packages/agent-core/src/tools/registry.ts:88` 的 `toLlmTools()`（当前按 Map 插入序）
- `packages/agent-core/src/host/agentHost.ts:301`：`describeTools(this.deps.tools.list())`
- `packages/agent-core/src/loop/agentLoop.ts:119`：`messages = [system, ...history, user, extraContext]`
  ——**这一处不改**，它已经是缓存友好的形状，本步要为它补一条回归测试
- `packages/agent-core/src/llm/openai-compat.ts:424` 的 `extractUsage`（**注意函数名是 `extractUsage`，
  不是 `parseUsage`**；当前只取 `prompt_tokens` / `completion_tokens` / `total_tokens` 三个字段）；
  同目录的 `openai-compat.test.ts`（既有 usage 解析测试）
- ⚠️ 计划里其余位置的工程行号（`agentLoop.ts` / `main/index.ts` / `capture.ts`）都可能有偏移，
  **执行时用 `grep -n` 重取一次再动手**，不要照抄计划里的行号
- `packages/shared/src/ipc/types.ts` 的 `TokenUsage`（agent-core 的 `llm/types.ts:8` 只做重导出）
- `apps/desktop/src/renderer/shared/composables/useChat.ts:230`（`usage` 事件累加）与 `:396`（重置）；
  `apps/desktop/src/renderer/chat/components/ComposerContextBar.vue`
  （`props.latest.promptTokens` 的展示位，`data-field="chat.context-usage"`）
- `apps/desktop/src/main/smoke-llm.ts`（桩 LLM 的 usage 片与按标记分流的结构）与
  `apps/desktop/src/main/smoke.ts:456` 附近的 token 用量断言
- `docs/06 §21`（step 1 落盘的 prompt caching 规格：新顺序、排序要求、`cachedTokens` 解析口径、明确不做的事）

## 操作

### 1. `buildSystemPrompt`：静态在前、易变在后

把 `sections.push` 的调用顺序改为（**字段集合一个不加不减**）：

```
基础人设（persona / BASE_PERSONA）
→ 当前模式（modePrompt）
→ 可用 Skill（skillCatalog）
→ 可用工具（toolCatalog）
→ 工具使用规范（toolGuidance）
→ Agent 可修改的设置（settingsHint）
→ 安全规则（SAFETY_RULES）
── 以上为静态/半静态段，以下为易变段 ──
→ 更早对话的摘要（historySummary）
→ 当前任务清单（todoSummary）
→ 系统状态（perceptionSummary）
```

- 在各小节前面加一段**显眼的注释块**说明为什么易变段必须留在最后：
  「OpenAI 兼容网关的前缀缓存按最长公共前缀命中；`## 系统状态` 每轮都带时间与前台窗口，
  把它排在中间会让其后所有静态文本（本文件里约三千字符）每轮重新计费。不要把易变小节往前挪。」
- 各小节的**正文与附加说明行完全不变**（例如任务清单节尾那句「完成一项立即用 todo_write 更新状态」、
  历史摘要节尾那句「与当前系统状态冲突时以系统状态为准」都照旧）。
- 导出一个小常量供测试用，例如
  `export const VOLATILE_SECTION_TITLES = ['## 更早对话的摘要', '## 当前任务清单', '## 系统状态'] as const`。

### 2. 工具数组排序：**生效点在 `agentLoop.ts`，不是 `registry.ts`**（已核实，别改错地方）

⚠️ 这条是本计划修订过的地方，务必按修订后的写法做。已核实的现状：
`packages/agent-core/src/loop/agentLoop.ts:132` 调的是**同文件内私有的** helper
`toLlmTools(options.tools)`（`:353`），它内部用的是 `tools.list()`（Map 插入序）。
而 `packages/agent-core/src/tools/registry.ts:92` 的 `ToolRegistry.toLlmTools()`
**在整条请求链路上没有被调用**——它唯一的消费者是 `packages/agent-core/src/skills/registry.test.ts:148`。
所以只改 `registry.ts` 的排序**对发给 provider 的 tools 数组零影响**。

两处都要改：

- `loop/agentLoop.ts`：**删掉 `:353` 的私有 helper**，把 `:132` 改成
  `const llmTools = options.tools.toLlmTools()`（走 registry 的唯一实现，避免两份实现漂移）。
- `tools/registry.ts:92` 的 `toLlmTools()` 加确定性排序：

```ts
toLlmTools(): LlmToolDefinition[] {
  return this.list()
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    // 按名字排序（**不用 localeCompare**：它是 locale 相关的，跨机器可能给不同结果）。
    // 顺序稳定 = tools 数组成为可缓存前缀的一部分；先摘除再重建的 sync() 不会再打乱它。
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
```

- `agentHost.ts:301` 的 `describeTools(this.deps.tools.list())` 改成
  `describeTools(this.deps.tools.toLlmTools())`，保证系统提示词里的工具清单与请求体的
  `tools` 数组**同序**（否则两处顺序不一致，缓存与展示都会拧）。
- **`skills/registry.test.ts:148` 会红**：它断言的是注册序。改成断言**排序后**的顺序
  （或断言 `toLlmTools()` 的 `name` 数组已按字典序），**不要**改断言对象去迁就旧顺序。

### 3. 缓存命中解析（`openai-compat.ts` + `shared/ipc/types.ts`）

- `packages/shared/src/ipc/types.ts` 的 `TokenUsage` 增加
  `/** 命中服务端前缀缓存的 prompt token 数；provider 未回传时缺省 */ cachedTokens?: number`。
- `extractUsage` 在原有三个字段之后追加解析（**两种厂商形态都要认**）：
  `prompt_tokens_details.cached_tokens`（OpenAI 形态）优先，
  否则 `prompt_cache_hit_tokens`（DeepSeek 形态）；
  取值必须经 `Number.isFinite` 且 `>= 0` 检查，否则**整条省略**（不是填 0）——
  0 与"没回传"在界面上必须可区分，不能拿别的数字冒充。
- 不改 `buildBody`（不新增任何请求字段——显式 `cache_control` 属明确不做项，见 §21）。

### 4. 渲染层展示

- `useChat.ts`：`usage.totals` 增加 `cachedTokens`，在 `usage` 事件分支里累加
  （`(usage.value.totals.cachedTokens ?? 0) + (event.usage.cachedTokens ?? 0)`）；
  `:396` 的重置对象补 `cachedTokens: 0`。
- `ComposerContextBar.vue`：「上下文详解」条里增加一段
  `data-field="chat.context-cache"` 的文案——`cachedTokens` 有值时显示
  `缓存命中 1.2k（62%）`；百分比必须 **`Math.min(100, Math.round(cached / promptTokens * 100))`**
  ——`cached` 是**服务端报的命中数**，正常不会超过 `promptTokens`，但桩服务/异常网关可能给出
  不一致的数据，界面不能显示「缓存命中 512（400%）」这种荒谬值；`promptTokens` 为 0 或缺失时
  **不显示百分比**（只显示绝对数）。
  **`cachedTokens` 缺省时整段不渲染**（不要显示 `缓存命中 0`，那会与"没回传"混淆）。

### 5. 回归测试（本步的重点，验收依赖它）

`systemPrompt.test.ts` 新增：

- **最长公共前缀断言**（本步的核心判据）：
  ```ts
  const stat = buildSystemPrompt({ persona, modePrompt, skillCatalog, toolCatalog, toolGuidance, settingsHint })
  const a = buildSystemPrompt({ ...同 stat 的全部字段, perceptionSummary: 'A', todoSummary: 'T1', historySummary: 'H1' })
  const b = buildSystemPrompt({ ...同 stat 的全部字段, perceptionSummary: 'B', todoSummary: 'T2', historySummary: 'H2' })
  expect(a === b).toBe(false)                            // 防恒真：易变段确实不同
  expect(commonPrefix(a, b)).toBe(stat + '\n\n')         // 静态前缀逐字节相同，到静态段末尾 + 一个接缝
  // 接缝之后必须直接是第一个易变小节——把「前缀长度」变成「语义」断言
  expect(a.slice(commonPrefix(a, b).length).startsWith('## 更早对话的摘要')).toBe(true)
  ```
  **`+ '\n\n'` 是必须的，不是"按实测确认"**：`buildSystemPrompt` 用 `sections.join('\n\n')`
  拼接（`systemPrompt.ts:111`），`stat` 的最后一段是 `SAFETY_RULES`，因此公共前缀必然包含那个接缝。
  写成 `toBe(stat)` 会**稳定失败**。
  `commonPrefix` 自己实现（逐字符比较，`systemPrompt.test.ts` 内私有即可，不要为测试放宽导出面）。
- **顺序断言**：`VOLATILE_SECTION_TITLES` 里三个标题的 `indexOf` 都**大于** `'## 安全规则'` 的 `indexOf`；
  且三者之间的相对顺序是 历史摘要 → 任务清单 → 系统状态。
- **缺省省略不受影响**：只传易变字段时，静态段照常渲染且易变段在末尾。
- `buildToolGuidance` 的既有断言全绿（step 2 加的三条仍在）。

`openai-compat.test.ts` 新增 `extractUsage` 断言（若它未导出则通过 `OpenAIChat` 的流式
fixture 间接断言，**不要**为了测试而放宽导出面）：

- `prompt_tokens_details: { cached_tokens: 512 }` → `cachedTokens === 512`
- 只有 `prompt_cache_hit_tokens: 300` → `cachedTokens === 300`
- 两者都缺 → `cachedTokens === undefined`（**不是 0**）
- 两者同时存在 → 以 `prompt_tokens_details.cached_tokens` 为准
- `cached_tokens: 'abc'` 与 `cached_tokens: -5` → `undefined`

`registry.test.ts`（若无则新建 `packages/agent-core/src/tools/registry.test.ts`）新增：

- 两种不同的注册顺序注册同一组工具 → `toLlmTools()` 返回的 `name` 数组**完全相同**且按字典序
- 先注册全部、再对其中一个 `unregister` + `register`（模拟 `sync()` 的摘除重建）
  → 顺序**不变**（这是修复"设置一改缓存全失效"的直接证据）

`agentHost` 或 `agentLoop` 的消息顺序回归（放在 `agentLoop.test.ts`，用既有的 fake provider）：

- 断言 provider 收到的 `messages[0].role === 'system'` 且 `messages[0].content` 就是传入的 `systemPrompt`
- 有历史时，`messages[1..n-1]` 依次是历史，最后一条是 `userInput`
- 给了 `extraContext` 时它是**最后一条**（易变内容在尾部——这条钉住 step 6 的前提）

### 6. smoke 断言（**宿主是 `apps/desktop/src/main/index.ts`，不是 `smoke.ts`**）

⚠️ 这条也是修订过的，别改错文件：
- `apps/desktop/src/main/smoke.ts` 导出的是 `smokeScript(stubBaseUrl, stubModel, watchDir) → string`
  ——它是**注入渲染层执行**的脚本，跑在渲染进程里，**拿不到主进程的桩服务句柄**。
- 真正的主进程断言宿主是 `apps/desktop/src/main/index.ts` 的 `runSmokeTest`（桩服务 `stub` 在它作用域内），
  既有「9.1 正文流式」与「token 用量」断言都在那里，`record(...)` 也在那里。

因此：

- `smoke-llm.ts`：给桩服务加一份**请求体历史**（每次处理 `/chat/completions` 时把 `messages` 与 `tools`
  存进数组，随句柄导出读取函数，例如 `getRecordedRequests()`），
  **并把该片 usage 里的 `prompt_tokens` 提到 ≥ 512**（当前是 128），
  再补 `prompt_tokens_details: { cached_tokens: 512 }`——
  否则 `cached > prompt`，界面会算出大于 100% 的百分比（见「操作 4」的 `Math.min`）。
- `index.ts` 的 `runSmokeTest` 新增三条断言（写在既有的 token 用量断言附近）：
  1. **静态前缀逐字节相同**：同一会话连续两轮的请求体里，`messages[0].content`（系统提示词）的
     **最长公共前缀长度 = 第一个易变小节的 `indexOf`**（即
     `['## 更早对话的摘要', '## 当前任务清单', '## 系统状态']` 中第一个出现的位置），
     且该长度 ≥ `'## 安全规则'` 的位置 + `'## 安全规则'.length`；
     并断言两轮都含 `## 系统状态`（证明易变段确实渲染了）。
     断言里同时打印公共前缀长度与两轮长度，便于人工复核。
     **不要**断言"两轮系统提示词不完全相同"——`## 系统状态` 里的时间只到分钟，
     两轮隔几秒时可能完全一致，那会变成随机失败（假 FAIL 比假 PASS 更坏）。
     防恒真由「操作 5」那对确定性构造的 `a` / `b` 承担，不靠 smoke。
  2. **工具顺序稳定**：两轮请求的 `tools.map(t => t.function.name)` 数组**逐个相同**，
     且已按字典序排列（这条在修订后的 `agentLoop.ts` 生效路径上才成立）。
  3. **缓存命中可观测**：收到的 `usage` 事件里 `cachedTokens === 512`（桩服务固定回 512）。
- `smoke.ts` 本步**不改**（除非你发现渲染层确实需要新断言——那要走既有 `window.aurora` 暴露面，
  不要为此新开 IPC 通道：新增通道要同时改 `packages/shared/src/ipc/channels.ts` 与
  `apps/desktop/src/preload/channels.ts`，两边有编译期双向断言，属于本任务范围之外）。

### 7. capture 探针

`capture.ts`：若有现成场景能驱动出「一轮带 usage 的回复」（既有的 `chat.context-usage` 字段说明有），
则补一条 DOM 探针断言 `[data-field="chat.context-cache"]` 的文案含「缓存命中」；
**若驱动不出来**（例如桩服务在该场景下不回 usage），不要硬造场景——
在 `docs/07 §5.3` 与执行记录里如实写明「缓存展示只由 smoke 覆盖，capture 未覆盖」。
两种情况都必须更新 `docs/07 §5.3` 与 `AGENTS.md` 里记录的探针/截图计数为**实测值**。

### 8. 文档收口（本步的下半场）

- `docs/06-agent-core.md`：§21 与实现逐条对齐（顺序、排序、解析口径、不做项）；
  §5 的顺序表若与最终实现有出入就地订正；§11 的工具表补上 `edit_file` / `grep` / `glob` 的
  最终上限常量值（`MAX_EDIT_BYTES`、`DEFAULT_READ_LINES`、`MAX_FILE_SCAN_BYTES`、
  `SEARCH_BUDGET`、`DEFAULT_SEARCH_IGNORE` 等**按实现的实际取值写**）。
- `docs/04-roadmap.md`：变更记录追加本轮条目（三条新工具 + 免确认模式 + prompt caching），
  并更新顶部状态段。
- `docs/README.md`：状态段记录本轮新增能力。
- `docs/10-user-guide.md`：新增一节「让 AI 改代码」——`read_file` 的行号与 `offset`、
  `edit_file` 的读前置与唯一性、`grep` / `glob` 的用法；以及「免确认命令模式」怎么配、为什么它不是安全加固。
- `docs/11-privacy.md`：权限/隐私表补 `edit_file`（写文件，逐次确认）、`grep` / `glob`（只读，
  但**扫描范围覆盖整棵搜索根**，要如实披露）、`allowPatterns`（只在本地保存、不改任何出网行为）。
- `AGENTS.md`：更新工具计数与「BetaV2 新能力的注册口径」一段
  （三个新工具**受 `agent.tools.enabled` 门控**，与五件套的"不受门控"口径不同，必须写明区别），
  并补 `allowPatterns` 属只读前缀这一条。

## 验收标准

- [ ] `pnpm build:packages && pnpm typecheck && pnpm build` → 全部 exit 0
      （**必须先 `build:packages`**：agent-core 与 shared 的 `types` 都指向 `dist/`，
      不重建的话下游 typecheck 会对着旧类型报「no exported member」）
- [ ] `pnpm test` 全绿，且下列断言可逐条指认：
  - [ ] 最长公共前缀断言：`commonPrefix(a, b) === stat + '\n\n'`（**带接缝**），
        且接缝之后直接是 `## 更早对话的摘要`
  - [ ] `a !== b`（防恒真断言）
  - [ ] 三个易变小节的 `indexOf` 都大于 `## 安全规则`
  - [ ] `toLlmTools()` 在两种注册顺序下返回相同的有序 `name` 数组
  - [ ] 摘除重建后顺序不变
  - [ ] `extractUsage` 的五条（两种字段名 / 都缺 → `undefined` / 优先级 / 非法值 → `undefined`）
  - [ ] `agentLoop` 的消息顺序：system 首位、`extraContext` 末位
- [ ] `$env:AURORA_SMOKE='1'; pnpm dev` 的 `AURORA_SMOKE_RESULT` 无 FAIL，且三条新记录都在：
      「两轮系统提示词静态前缀逐字节相同」「两轮 tools 顺序相同且已排序」「usage 事件带 cachedTokens=512」
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` 退出码 0、`report.json` 无 FAIL；
      `docs/07 §5.3` 与 `AGENTS.md` 的计数为本次实测值（**不按推算写**）
- [ ] `docs/06 §21` 与实现一致；`docs/04` / `docs/README.md` / `docs/10` / `docs/11` / `AGENTS.md`
      均已更新（`grep -n "edit_file" docs/10-user-guide.md docs/11-privacy.md AGENTS.md` 三处都命中）
- [ ] `pnpm lint` 与 `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过
- [ ] `pnpm verify`（真实磁盘配置层验收）通过——本轮改了 Schema 与迁移链，这条必须复跑

## 交接

- 本步完成后，`00-index.md` 的完成标准应全部可勾选；剩余工作只有 step 7 归档。
- 若发现任何**本任务范围之外**的既有缺口（例如确认链路 `rejectAll()` 未接 `chat:abort`、
  `read_text` 的扫描上限对超大文件的取舍等），**只登记不修**，写进「执行记录 → 已登记、未修」
  并在给用户的收尾说明里列出来。
- 归档前请主代理复跑一遍完整验收命令（`typecheck` / `test` / `build` / `verify` / `smoke` / `capture`）
  并把结果写进 `00-index.md` 的执行记录——step 7 的前置检查会读它。

## 执行记录

执行时间：2026-09-26（会话内连续执行）

### 分片与结果

三个写范围不重叠的分片并行：

| 分片 | 负责文件 | 结果 |
| --- | --- | --- |
| 前缀稳定化 | `context/systemPrompt.ts` + `.test.ts`、`tools/registry.ts` + `registry.test.ts`、`loop/agentLoop.ts` + `.test.ts`、`skills/registry.test.ts`、`host/agentHost.ts` | 小节顺序改成「静态在前、易变在后」；`toLlmTools()` 按**名字**排序（不用 `localeCompare`）；**生效点修好**（删掉 `agentLoop.ts` 的私有 helper、改走 `registry.toLlmTools()`）；`agentHost` 的工具清单改用同一有序列表；`skills/registry.test.ts` 的注册序断言改成字典序（改断言、没改被测代码） |
| 命中观测 | `shared/ipc/types.ts`、`llm/openai-compat.ts` + `.test.ts`、`renderer/.../useChat.ts`、`ComposerContextBar.vue` | `TokenUsage.cachedTokens`；优先 `prompt_tokens_details.cached_tokens`、其次 `prompt_cache_hit_tokens`，都缺则**整条省略**（不是 0）；`data-field="chat.context-cache"`，百分比 `Math.min(100, …)` 夹取，`promptTokens` 为 0 时不给百分比，缺省整段不渲染。`buildBody` 未动（无新增请求字段） |
| 端到端 | `main/smoke-llm.ts`、`main/index.ts`、`main/capture.ts`、`docs/07` | 桩服务加**请求体历史**（`getRecordedRequests()`）、`prompt_tokens` 128 → 512 并回传 `cached_tokens: 512`；三条 smoke 断言；capture 的 `chat-stream` 探针补 `cacheText` |
| 文档收口 | `docs/04` / `06` / `10` / `11` / `README`、`AGENTS.md` | §11 新增 13 个内核常量的实测值表；§21 判据就地订正；`docs/10` 新增 §10「让 AI 改代码」；README 的 `128 / 128k` → 实测 `512 / 128k · 缓存命中 512（100%）` |

### 验收命令与真实结果（主代理复跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm build:packages` / `pnpm typecheck` / `pnpm build` | 全部 exit 0 |
| `pnpm test` | **72 文件 / 1292 用例全绿** |
| `pnpm verify` | **26/26 项通过**，含 `执行了 v0 → 当前版本的迁移链 — count=12/12` |
| `pnpm lint` / `pnpm exec prettier --check "**/*.{ts,md,json,vue}"` | 均通过 |
| `$env:AURORA_SMOKE='1'; pnpm dev` | **SUMMARY 146/146 passed**、0 FAIL。三条新记录原样：`两轮系统提示词静态前缀逐字节相同 — commonPrefix=6944 aLen=6944 bLen=6944 firstVolatile@6738 safetyEnd@6615 identical=true`；`两轮 tools 顺序相同且已排序 — a=[classisland_remind,clipboard_read,clipboard_write,edit_file,generate_image,glob,grep,list_dir,notify_user,open_path,read_file,run_command,set_setting,task,todo_read,todo_write,use_skill,web_fetch,write_file] b=[同一串]`；`usage 事件带 cachedTokens=512 — events=5 cached=[512,512,512,512,512]` |
| `$env:AURORA_CAPTURE=…; pnpm dev` | 退出码 0、**48 张 PNG / 48 条 checks（45 条带探针）/ 0 FAIL**；`chat-stream` 探针 `usageText="512 / 128k  · 缓存命中 512（100%）"`、`cacheText="缓存命中 512（100%）"`、`totals="累计 528"` |

### 与计划的偏差

1. **计划「操作 5」的最长公共前缀断言字面值不可满足，已订正**：
   计划写 `expect(commonPrefix(a, b)).toBe(stat + '\n\n')`，但它下一行又要求
   `a.slice(commonPrefix(a,b).length).startsWith('## 更早对话的摘要')` —— 两者矛盾：
   **第一个易变小节的标题行在两轮里逐字节相同**，因此必然也在公共前缀里。
   实测 `commonPrefix.length = 276`、`stat.length = 263`、`stat + '\n\n' = 265`，差额正是
   `'## 更早对话的摘要' + '\n'` 的长度。已改成精确边界
   `expect(commonPrefix(a, b)).toBe(\`${stat}\n\n## 更早对话的摘要\n\`)`（**更严、不是放宽**），
   并保留 `a !== b` 的防恒真断言；`docs/06 §21.1` 的措辞同步订正。
   另：计划示例给的 `historySummary: 'H1' / 'H2'` 共用首字符，公共前缀会合理地越进易变正文 ——
   测试改用首字符即不同的取值，否则那条断言测不到边界。
2. **smoke 的公共前缀判据用「≥ 首个易变小节的 `indexOf`」而不是「=」**：
   实测两轮系统提示词**一字不差**（`identical=true`，6944 = 6944 —— `## 系统状态` 里的时间只到分钟，
   两轮相隔约 1 秒），严格相等会**稳定失败**，正好撞上计划自己禁止的「断言两轮不同」。
   现判据 = 「首个易变小节之前的字节全同」：静态段若真漂移一个字节，公共前缀会截在静态段中间而被抓住；
   另外两条（两轮都含 `## 系统状态`、`volatileAt >= 安全规则位置 + 其长度`）照旧。
3. **`smoke.ts` 本步未改**：三条断言写在 `main/index.ts` 的 `runSmokeTest`（订一份 `agent.onEvent`
   收集 `usage` 事件），符合计划的宿主指定。
4. **桩 LLM 的 `prompt_tokens` 128 → 512、`total_tokens` 144 → 528**：连带把文档里
   `128 / 128k` / `累计 144` 同步成实测值（`docs/07` / `docs/README`）。代码侧**没有**既有断言因此需要改
   （`smoke.ts` 那条 token 断言是相对判据 `> 0`，实测仍 PASS）。
5. **capture 的 `chat-stream` 探针比规格更严**：额外要求文案含 `512` 与 `100%`（只判「含缓存命中」
   会放过「命中量丢了也能过」的情况）。

### 已登记、未修

- `packages/agent-core/src/tools/task.ts` 子代理的工具清单仍用 `describeTools(subTools.list())`
  （注册序）。子代理另建请求、不进主请求体的 `tools`，对主前缀缓存无影响；
  「提示词清单与请求体同序」的口径在子代理路径上不成立，建议后续统一。
- `agentHost.ts` 里 `buildToolGuidance(this.deps.tools.list().map(...))` 仍是 `list()`：
  该函数输出顺序由代码固定、只用 `includes` 判存在，顺序无影响，未做无谓改动。
- `docs/README.md` 的 v0.1.2 历史块里「`AURORA_SMOKE`（130 条断言）」保留为那一轮的历史计数
  （本轮 146/146 已写进新块）。
- 设置页「免确认命令模式」卡的**非空列表态**仍无 capture 现场证据（见 step 5 记录）。

### 交接

- `00-index.md` 的完成标准已全部可勾选；剩余工作只有 step 7 归档。
- 归档前主代理已复跑：`typecheck` / `test` / `build` / `verify` / `lint` / `prettier` / `smoke` / `capture`
  全部通过，结果见上表。
