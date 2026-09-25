# Step 05 — `run_command` 免确认模式列表（内核匹配器 + 主进程接线 + 设置页 + 审计）

- Task: opencode-parity
- Step: 5 / 7
- Status: done
- Depends on: step 4（`registerComputerTools` 的依赖清单与 `main/index.ts` 的装配点已稳定）
- Produces: `packages/agent-core/src/tools/command-allow.ts`（匹配器 + 校验，复用 step 3 的 glob 编译器）、
  `createConfirmTool` 的免确认分支与审计日志、设置页「免确认命令模式」栏、capture 探针与 smoke 断言
- Phase: 安全与边界
- Writes: `packages/agent-core/src/tools/command-allow.ts`、`packages/agent-core/src/tools/command-allow.test.ts`、`packages/agent-core/src/index.ts`、`packages/shared/src/config/schema.ts`（只补 `allowPatterns` 的 Zod refine）、`packages/shared/src/config/schema.test.ts`、`apps/desktop/src/main/agent-host.ts`、`apps/desktop/src/main/agent-host.test.ts`（新建）、`apps/desktop/src/main/index.ts`（smoke 断言宿主）、`apps/desktop/src/main/smoke-llm.ts`、`apps/desktop/src/main/capture.ts`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`、`docs/06-agent-core.md`（§11.7 订正）、`docs/07-ui-spec.md`（§5.3 探针清单）、`AGENTS.md`（工具计数与只读前缀条目）
- Risk: **这是本任务里唯一直接触碰安全边界的步骤。** 三条必须守住：
  ① 免确认是「减少打扰」不是「安全加固」——文档与 UI 文案都必须这么写，不能让人以为开了它就更安全；
  ② **任何"等于全放行"的模式（`*` / `**` / `?*` / 纯通配组合）一律不匹配**——
     用户手改配置文件塞进一个 `*` 不能变成"全部免确认"，所以匹配器必须**跳过不含字面字符的模式**，
     这是纵深防御，与 Schema 层的拒绝是两件事，两件都要做；
  ③ 该字段在 `SETTINGS_READONLY_PREFIXES` 里（step 1 已加），AI 的 `set_setting` 必须拒绝——
     本步要用测试把这条钉死（否则 AI 能给自己加一条 `git*` 摘掉自己的确认闸门 = 自我提权）。
  退路：若 smoke 的两条断言（命中免确认 / 未命中仍确认）无法稳定构造，**至少**保住内核与
  `createConfirmTool` 的单测覆盖 + 负对照，并在执行记录里如实写明 smoke 未覆盖的原因（不要写"已验证"）。

## 目标

用户在设置页维护一份命令模式白名单（例如 `git status*`、`npm test*`），
命中它的命令**不再弹确认卡片**直接执行；未命中的照旧逐次确认。
AI 改不动这份白名单，也没有任何"一条模式放行全部命令"的口子。

## 输入

- `packages/agent-core/src/tools/globPattern.ts`（step 3）：`matchesGlob` / `isValidGlobPattern`——
  **本步复用，不要另写匹配逻辑**；注意用 `{ pathMode: false }`（命令串里的反斜杠是内容不是分隔符）
- `apps/desktop/src/main/agent-host.ts:255` 的 `createConfirmTool`（现状：`enabled()` 为假直接放行，
  否则调 `proactive.requestSensitiveToolConfirm`，异常按拒绝）。**该文件不 import electron**，
  因此可以加 `agent-host.test.ts` 直接单测（已核实依赖链只到 `@aurora/agent-core` 与 `@aurora/shared`）
- `apps/desktop/src/main/index.ts:638`：`createConfirmTool({ proactive, enabled, logger })` 的装配点
- `apps/desktop/src/renderer/settings/pages/AgentPage.vue`：`save()`（`:95`）/ `saveTerminal()`（`:108`）——
  `settings:update` 只做**顶层浅合并**，改 `terminal` 子树必须在 patch 里带**完整 terminal 对象**，
  否则同级 `timeoutMs` / `maxOutputChars` 会被丢掉；既有 `data-field="agent.tools.terminal.*"` 的写法照抄
- `apps/desktop/src/main/capture.ts:1378` 的 `SETTINGS_AGENT_FIELDS_SCRIPT`：
  `terminalFields` 现在 = 3，加一个字段后 = 4；`pass` 条件要同步
- `apps/desktop/src/main/smoke-llm.ts`：桩 LLM 按**提问里的标记**分流并发出 `tool_calls`
  （`SUBAGENT_TASK_MARKER` 是现成写法）；`apps/desktop/src/main/smoke.ts` 是断言宿主
- `docs/06 §11.7`（step 1 落盘的免确认模式规格）、`docs/06 §12.2`（只读前缀判定先于覆盖表）
- `packages/shared/src/config/schema.ts`（step 1 已加字段与只读前缀；本步**不再改 Schema**，
  只补一条 Zod refine——见「操作 1」末）

## 操作

### 1. `command-allow.ts`：匹配器与校验

```ts
export const MAX_ALLOW_PATTERNS = 100
export const MAX_ALLOW_PATTERN_LENGTH = 200

/** 模式是否可用：非空、未超长、glob 语法合法，且**至少含一个非通配、非空白字符** */
export function describeInvalidPattern(pattern: string): string | undefined

/**
 * 是否命中免确认列表：任一模式全串匹配即命中，返回**被命中的模式**（供审计日志）；
 * 不命中返回 undefined。**语法非法或纯通配的模式一律跳过，绝不匹配。**
 */
export function matchAllowPatterns(command: string, patterns: readonly string[]): string | undefined
```

- 匹配用 `matchesGlob(pattern, command, { pathMode: false, caseInsensitive: true })`。
**`describeInvalidPattern` 必须再加一条硬规则，否则安全边界会被击穿**（已核实的漏洞）：
**含 `{` 或 `}` 的模式一律拒绝**，原因「命令模式不支持花括号交替」。
为什么必须单独堵：step 3 的 glob 编译器把 `{a,b}` 编成 `(?:a|b)`，
于是 `{a,*}` 去掉 `*?{},` 与空白后还剩 `a`，能骗过"至少含一个字面字符"的检查，
但编译出来是 `(?:a|.*)` —— **匹配任意命令**，等于一行就关掉了整个确认闸门。
一句话规则（写进注释）：**命令模式只允许字面字符 + `*` + `?`，出现任何其它元字符（含 `{}`）即视为非法。**
**这条规则同时要补进 `docs/06 §11.7`**（step 1 写的版本只说"不含任何字面字符的模式要被拒绝"，
没堵住花括号这条路，属于规格本身的漏洞，就地订正并在执行记录里写明）。

`describeInvalidPattern` 的规则（返回中文原因；合法返回 `undefined`）：
空串 / 纯空白 → 「模式不能为空」；超 `MAX_ALLOW_PATTERN_LENGTH` → 「模式过长（上限 200 字符）」；
**含 `{` 或 `}`** → 「命令模式不支持花括号交替」；
`isValidGlobPattern` 为假 → 「模式语法不合法」；
去掉 `*?` 与空白后为空 → 「模式必须至少包含一个具体字符，纯通配等于放行全部命令」。
（注意最后一条的字符集里**不再包含 `{},`**——花括号已被上一条整类拒绝。）
- `matchAllowPatterns` 对**每个**模式先跑 `describeInvalidPattern`，非 `undefined` 即 `continue`（跳过）。
  这条必须有单测（构造 `['*']` 断言不命中任何命令）。
- `packages/agent-core/src/index.ts` 导出上述三项与两个常量。

**顺带补一条 Schema refine**（属 step 1 漏掉的一条，本步补齐）：
`packages/shared/src/config/schema.ts` 的 `allowPatterns` 元素加

```ts
.refine(
  (s) => !/[{}]/.test(s) && /[^*?\s]/.test(s),
  '命令模式只允许字面字符与 * / ?（不支持花括号，且必须至少包含一个具体字符）',
)
```

——**两个条件都要**：只判"含字面字符"会被 `{a,*}` 绕过（见上），
所以先整类拒绝 `{}`、再要求存在非通配字符。两处（Zod 与 `describeInvalidPattern`）的中文口径必须一致。
这样设置页保存非法模式时经 `settings:update` 返回「配置校验失败：…」，
而不是静默存下一个"永不生效"或"放行全部"的值。
（本步因此也写 `schema.ts` 与 `packages/shared/src/config/schema.test.ts`。）

### 2. `createConfirmTool`：免确认分支（`agent-host.ts`）

给 `createConfirmTool` 的 options 增加一个依赖：

```ts
/** 每次调用即时判断（改设置无需重启），与 `enabled` 同款 */
allowPatterns?: () => readonly string[]
```

决策函数里在 `if (!options.enabled()) return true` **之后**、请求确认**之前**插入：

```ts
if (info.name === 'run_command') {
  const command = readCommand(info.input)   // 非对象 / 非字符串一律返回 undefined
  if (command !== undefined) {
    const matched = matchAllowPatterns(command, options.allowPatterns?.() ?? [])
    if (matched !== undefined) {
      // 审计留痕：命中免确认模式也要能查（否则"为什么没弹卡片"无从追溯）
      options.logger?.info('命令命中免确认模式，已跳过确认卡片', {
        tool: info.name,
        pattern: matched,
        command: command.slice(0, 200),   // 超长命令只记前 200 字符
      })
      return true
    }
  }
}
```

- 日志函数用既有的 `info` 级（不要 `warn`——这不是异常）。
- `readCommand` 写成模块内的私有小函数：`typeof input === 'object' && input !== null` 时
  取 `(input as Record<string, unknown>)['command']`，仅当其为非空字符串时返回。
  **非字符串 / 缺字段一律返回 `undefined`（走正常确认，不放行）**。
- 不改变既有行为：`enabled()` 为假仍直接放行（那条路径比 allow 列表更宽，是本步之前就有的语义）。

### 3. 装配（`apps/desktop/src/main/index.ts`）

`createConfirmTool({ proactive, enabled, logger })` 增加：

```ts
allowPatterns: () => settings!.get().agent.tools.terminal.allowPatterns,
```

（与 `enabled` 一样是"每次调用即时读设置"的闭包，改完设置立刻生效，无需重启。）

### 4. 设置页（`AgentPage.vue`）

在终端卡片之后加一张「免确认命令模式」小卡，字段全部落在既有的 `saveTerminal` 路径上：

- 容器元素**恰好一个**带 `data-field="agent.tools.terminal.allowPatterns"`（capture 探针按数量断言，
  多个会破坏计数）——列表与输入框放在这个容器**内部**，不要各自再挂同前缀的 `data-field`。
- 列表：每条显示模式 + 删除按钮（`data-action="agent.tools.terminal.allowPatterns.remove.<idx>"` 之类，
  照 AgentPage 既有的增删改按钮写法）。
- 输入框 + 「添加」按钮：**即时只校验"非空"**（去空白后为空就提示并不添加）；
  「是否含具体字符」这类规则交给保存时的 Schema 校验，
  保存失败时把 `settings:update` 返回的「配置校验失败：…」原样回显（既有的错误展示通道）。
- 文案必须包含一句口径说明：**「命中这些模式的命令不再弹出确认卡片；这是减少打扰，不是安全加固。
  该列表只能在这里修改，AI 无法改动。」**
- 空列表时给空状态提示（「暂未添加，所有命令都会逐次确认」）。
- ⚠️ **这个空状态不要用 `data-empty` 属性**（用普通文案元素即可）：
  `capture.ts` 的探针里有 `unexpected = emptyStates.filter(name => name !== 'mcp.servers' && name !== 'skills.disabled')`
  且 `pass` 要求 `unexpected.length === 0`，多加一个 `data-empty` 会让 `settings-agent` 探针直接 FAIL。
  若确实想用 `data-empty`，就必须同时把它加进那两处白名单（step 3 加「文件检索」空状态时同样适用）。

### 5. capture 探针（`capture.ts`）

`SETTINGS_AGENT_FIELDS_SCRIPT` 增加：

```ts
const allowPatternsFields = count('[data-field^="agent.tools.terminal.allowPatterns"]')
const searchFields = count('[data-field^="agent.tools.search"]')
```

并在返回对象里带上这两个计数，`pass` 条件补
`allowPatternsFields === 1 && (enabled !== true || searchFields > 0)`
（总开关关着时搜索栏不渲染，这与既有 `terminalFields` 的门控口径一致，照该文件的既有写法处理）。
`terminalFields` 的期望值从 3 变 4——**同步更新 `docs/07 §5.3` 与 `AGENTS.md` 里记录的探针数值**
（按 `report.json` 实测值写，不要按推算值写）。

### 6. smoke 断言（**宿主是 `apps/desktop/src/main/index.ts` 的 `runSmokeTest`，不是 `smoke.ts`**）

⚠️ 别改错文件：`apps/desktop/src/main/smoke.ts` 导出的是 `smokeScript(...) → string`，
那是**注入渲染层执行**的脚本（跑在渲染进程，拿不到主进程的桩服务句柄）。
主进程侧断言宿主是 `index.ts` 的 `runSmokeTest`，桩服务 `stub` 在它作用域内——
`index.ts` 的 `Writes` 已包含本步，**`smoke.ts` 不在本步写范围内**。

`smoke-llm.ts`：照 `SUBAGENT_TASK_MARKER` 的既有写法加 `RUN_COMMAND_MARKER`——
提问里含该标记时，桩服务返回一个 `run_command` 的 `tool_calls`（命令内容由标记约定，
例如标记后跟的那一行就是命令），随后的第二片返回一句普通文本收尾。

`index.ts` 新增三条断言（**必须有负对照**，否则「没收到卡片」可能只是因为链路根本没走）：

1. 通过 `settings:update` 把 `allowPatterns` 设为一份能命中待执行命令的模式（例如命令是
   `echo AURORA_ALLOW_OK`，模式设 `echo AURORA_ALLOW*`），发一条带 `RUN_COMMAND_MARKER` 的提问 →
   断言 **① 命令真的执行了**（工具卡状态 `success` 且结果含 `AURORA_ALLOW_OK`）、
   **② 没有收到 `proactive:sensitiveTool` 事件**。
2. **负对照**：把 `allowPatterns` 清空（`[]`）后发同样的提问 →
   断言 **收到了** `proactive:sensitiveTool` 事件。
   ⚠️ 两条防坑（不处理会让这条断言挂住 60 秒并污染后续断言）：
   - 用**另开一个会话**（不同 `sessionId`）发这轮提问，不要复用 `quick`；
   - 收到事件后**立即**调 `window.aurora.proactive.resolveSensitiveTool(confirmId, false)` 把卡片结掉
     ——确认超时是 60s（`main/proactive.ts` 的 `DEFAULT_CONFIRM_TIMEOUT_MS`），
     而 smoke 的单轮等待预算远小于它，不主动结掉会让 pending 请求挂到后面的断言上。
3. 断言结束后把 `allowPatterns` 复原为空数组，避免影响后续断言。

## 验收标准

- [ ] `pnpm build:packages && pnpm typecheck` → exit 0
      （**必须先 `build:packages`**：`@aurora/agent-core` 与 `@aurora/shared` 的 `types` 指向 `dist/`
      ——见 `packages/agent-core/package.json:8`，不重建的话下游 typecheck 会对着旧类型报
      「no exported member」）
- [ ] `pnpm vitest run packages/agent-core/src/tools/command-allow.test.ts` 全绿，逐条可指认：
  - [ ] `echo AURORA_ALLOW*` 命中 `echo AURORA_ALLOW_OK`
  - [ ] `git status*` 命中 `git status` 与 `git status --short`，**不命中** `git stash`
  - [ ] 全串锚定：`git *` **不命中** `echo git`
  - [ ] 大小写不敏感：`GIT STATUS` 命中 `git status*`；`rm *` 不命中 `git rm x`
  - [ ] `?` 生效：`np? test` 命中 `npm test`
  - [ ] 返回被命中的模式串（用于审计）；多条模式时返回**第一条**命中的
  - [ ] **纯通配不匹配**：`['*']` / `['**']` / `['?*']` / `['  *  ']` 对任何命令都返回 `undefined`
  - [ ] **花括号绕过被堵死**：`['{a,*}']`、`['{*,x}']`、`['{x}*']` 三条都判非法
        （`describeInvalidPattern` 返回非空原因），且 `matchAllowPatterns` 对它们不匹配任何命令
        ——**这三条是本计划修订过的安全缺口的回归测试，必须逐条出现在输出里**
  - [ ] 空模式列表 → 任何命令都不命中
  - [ ] `describeInvalidPattern` 对各非法形态返回中文原因，对合法模式返回 `undefined`
- [ ] `pnpm vitest run packages/shared` 全绿，含新 refine 的断言：
      保存 `['*']` 与 `['{a,*}']` 时 `SettingsSchema.safeParse` **都**失败，
      且 message 含「具体字符」/「花括号」；保存 `['git status*']` 时通过
- [ ] `pnpm vitest run apps/desktop/src/main/agent-host.test.ts` 全绿（**新建**，不需要 Electron），
      用假的 `proactive` 断言：
  - [ ] `name: 'run_command'` 且命中 allow 模式 → **`requestSensitiveToolConfirm` 未被调用** 且返回 `true`
  - [ ] 未命中 → 调用了它，且返回值原样透传（`true` / `false` 各一条）
  - [ ] `input` 缺 `command` / `command` 非字符串 → **走确认**（不因拿不到命令而放行）
  - [ ] `name` 不是 `run_command`（例如 `write_file`）→ 即便命令内容命中模式也**走确认**
  - [ ] `allowPatterns` 未注入 → 行为与从前完全一致（全走确认）
  - [ ] `enabled()` 为假 → 直接放行且**不调用** scheduler（既有语义未变）
  - [ ] 命中时 `logger.info` 被调用且载荷含 `pattern`（审计留痕）
- [ ] `pnpm vitest run apps/desktop/src/main/tools` 全绿（前几步的断言未被破坏）
- [ ] 自我提权闸门：单测断言 `set_setting` 工具对
      `{ action: 'set', values: [{ path: 'agent.tools.terminal.allowPatterns', value: ['git*'] }] }`
      返回 `isError`（放在 `packages/agent-core/src/tools/settings.test.ts` 或本步的 `command-allow.test.ts` 里均可）
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` 退出码 0、`report.json` 无 FAIL，
      且 `settings-agent` 条目的探针结果含 `allowPatternsFields: 1`、`total` 与 `terminalFields` 的新实测值
- [ ] `$env:AURORA_SMOKE='1'; pnpm dev` 的 `AURORA_SMOKE_RESULT` 无 FAIL，
      且有「命中免确认模式不弹卡片」与「未命中仍然弹卡片」**两条**记录（负对照必须在）
- [ ] `docs/07 §5.3` 与 `AGENTS.md` 的探针计数按实测更新；
      `docs/06 §11.7` 与实现一致（若实现与规格有偏差，就地订正该节并写进执行记录）
- [ ] `pnpm test` 全绿；`pnpm lint` 与 `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过

## 交接

- `createConfirmTool` 的 options 现在有 `enabled` 与 `allowPatterns` 两个「即时读设置」的闭包，
  且都来自 `settings!.get().agent.tools.*` / `advanced.confirmSensitiveTools`——
  step 6 不会碰这两个。
- `smoke-llm.ts` 新增的 `RUN_COMMAND_MARKER` 分流是 step 6 做缓存前缀断言时要复用的**记录请求体**机制：
  step 6 会在同一个桩里加一份"收到的请求体历史"，本步**不要**提前删掉或重构现有的分流结构。
- `SETTINGS_AGENT_FIELDS_SCRIPT` 在 step 3（search 字段）与本步（allowPatterns 字段）各改一次，
  两次都要保证 `pass` 条件与实测数值自洽；**最终数值以 `report.json` 为准**。

## 执行记录

执行时间：2026-09-26（会话内连续执行）

### 分片与结果

主代理先**亲自实现安全核心**（`command-allow.ts` 的匹配器与 `describeInvalidPattern`、`schema.ts` 的元素级
refine、`index.ts` 导出）并用 30 条对抗性脚本自查通过，再派三个写范围不重叠的分片并行。

| 分片 | 负责文件 | 结果 |
| --- | --- | --- |
| 主代理 | `command-allow.ts`、`schema.ts` 的 refine、`index.ts` | 双层拒绝（配置层 + 匹配层）。自查 30 条全 PASS，含 `{a,*}` / `{*,x}` / `{x}*` / `a{,b}` 四条花括号绕过、`*` / `**` / `?*` / `  *  ` 四条纯通配、全串锚定、大小写、`?`、首条命中优先。**实现期自查抓到一个真 bug**：纯通配判定原本写成 `^[^*?\s]*$` 去测「去掉通配符后的串」，那是**恒真**表达式（等于该规则没生效），已改为 `pattern.replace(/[*?\s]/g, '') === ''` |
| 匹配器单测 | `command-allow.test.ts`（33 用例） | 逐条覆盖验收清单；**反向自证**：注释掉花括号那一行后 **7 条变红**（含三条回归），还原后 `git hash-object` 与改前一致。自我提权闸门做了 7 条，含「标量写法」「夹带批量写入」「数组下标路径」「读也拒绝」与**正对照**（同端口下 `timeoutMs` 能写） |
| 确认链路 | `agent-host.ts` + `agent-host.test.ts`（新建，18 用例） | `allowPatterns` 闭包 + `info` 级审计；`readCommand` 对「非对象 / 缺字段 / 非字符串 / 空串与纯空白」一律返回 `undefined` → **走确认**。含纯通配负对照（`*` / `**` / `?*` / `{a,*}` 等六种写法仍走确认）。反向自证：删掉判定后 **5 条变红**，已还原 |
| 设置页 + 探针 | `AgentPage.vue`、`capture.ts` | 「免确认命令模式」卡（**恰好 1 个** `data-field` 容器、**未新增 `data-empty`**、口径文案含「减少打扰，不是安全加固」）；`allowPatternsFields` 纳入 `pass`，`terminalFields` 保持 `> 0` 宽口径 |
| 接线 + 端到端 | `main/index.ts`、`smoke-llm.ts`、`smoke.ts`、`docs/07`、`AGENTS.md` | `allowPatterns` 即时读设置闭包；桩 LLM 加 `RUN_COMMAND_MARKER` 分流；smoke 加 9 条记录（成对断言 + 负对照） |

### 验收命令与真实结果（主代理复跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm build:packages` / `pnpm typecheck` | exit 0 |
| `pnpm test` | **71 文件 / 1277 用例全绿** |
| `pnpm lint` / `pnpm exec prettier --check "**/*.{ts,md,json,vue}"` | 均通过 |
| `$env:AURORA_SMOKE='1'; pnpm dev` | **SUMMARY 143/143 passed**、0 FAIL（实现分片跑了两轮 + **主代理复跑一轮**，三轮一致）。两条关键记录：`命中免确认模式不弹卡片（整轮无 proactive:sensitiveTool 事件） — confirm=[]`、`负对照未命中仍然弹卡片（收到 proactive:sensitiveTool） — {"toolName":"run_command","input":{"command":"echo AURORA_ALLOW_OK"},"sessionId":"smoke-allow-deny",…}` |
| `$env:AURORA_CAPTURE=…; pnpm dev` | 退出码 0、48 张 PNG / 48 条 checks / 0 FAIL；`settings-agent` 实测 `{"total":11,"terminalFields":4,"allowPatternsFields":1,"filesFields":2,"searchFields":2,"openFields":1,"unexpected":[],"pass":true}` |

### 与计划的偏差

1. **三条端到端断言的宿主是 `smoke.ts`（渲染层注入脚本）而不是 `index.ts` 的 `runSmokeTest`**。
   计划「操作 6」指定 `index.ts`，但那三条断言要用 `settings.update` / `chat.send` /
   `proactive.onSensitiveTool` / `resolveSensitiveTool` —— 全是**渲染层暴露面**，而既有的
   chat 流式与 token 用量断言本来就在 `smoke.ts` 里。因此 `smoke.ts` 进了本步写范围
   （计划把它算在 step 6），并在「交接」里已注明。
2. **`expectedChatRequests` 从 `3 + 4` 改为 `3 + 4 + 2 * 2`（= 11）**：两条新断言各消耗 2 次桩请求
   （工具调用轮 + 收尾轮）。这是必然的连带改动（不改这条既有断言会直接 FAIL），不是放松。
3. **桩 LLM 把工具结果的 stdout 段回显进收尾文本**：`tool` 事件只带 `outputSummary`（`退出码 0 · 12ms`）、
   `chat:history` 又过滤掉 `role: 'tool'`，渲染层拿不到命令输出；不回显就没有「命令真的执行了」的
   可断言证据。回显**故意不带命令行头部**（避免「命令里的字符串」造成假阳性），
   负对照同时断言回显里**没有** `AURORA_ALLOW_OK`，两者合起来才能区分「执行了」与「被拒了」。
4. **`readCommand` 对纯空白也返回 `undefined`**（计划只说"非空字符串"）：方向更保守（落回确认而非放行）。

### 已登记、未修

- 设置页那张卡的**非空列表态**（`v-for` 行 + 删除按钮）没有 capture 现场证据 —— capture 的配置里
  `allowPatterns` 为空，只渲染了空状态分支。若要覆盖需新增一个「先种一条模式再截图」的场景，
  会改变 `report.json` 的条目构成，超出本步范围。
- 匹配器不承担条数裁剪（`MAX_ALLOW_PATTERNS = 100` 由 Schema 负责）。
- 命令串**含换行**时 `*` 不跨行（JS 正则无 `s` 标志）：方向保守（不命中 → 照旧弹卡片），不是安全缺口。
- `allowPatterns()` 抛错未在 `createConfirmTool` 内捕获：会冒泡到内核，内核按「拒绝执行」处理（fail-closed），
  但会绕过本分支的审计日志。

### 对后续步骤的影响

- `createConfirmTool` 的 options 现在有 `enabled` 与 `allowPatterns` 两个「即时读设置」闭包 —— step 6 不碰它们。
- `smoke-llm.ts` 的 `RUN_COMMAND_MARKER` 分流与既有的 `FRAME_GAP_MS` / `sendSseDelayed` 是 step 6
  做缓存前缀断言时要复用的基础设施（step 6 还要在同一处加「请求体历史」）。
- `SETTINGS_AGENT_FIELDS_SCRIPT` 的 `pass` 现为 `allowPatternsFields === 1`；
  实测 `total=11` / `terminalFields=4`（step 6 若再改探针需同步这两个数）。
