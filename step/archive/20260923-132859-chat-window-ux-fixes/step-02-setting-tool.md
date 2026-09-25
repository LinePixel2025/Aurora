# Step 02 — 新增 set_setting 工具：Schema 校验 + 敏感黑名单 + 写入审计与回滚

- Task: chat-window-ux-fixes
- Step: 2 / 8
- Status: done
- Depends on: step 1
- Produces: 内核侧纯逻辑 `settings` 工具（`packages/agent-core/src/tools/settings.ts`，可单测）+ 主进程真实读写与审计 + `settings.readonlyPrefixes` 配置项 + smoke 断言

## 目标

用户问题 2 落地：Agent 真的能改自己的配置，且**任何**写入路径（含 AI 手改配置文件）都不会让配置溢出 Schema、
不会让应用启动崩、不会泄露凭据。

## 背景事实（拆解时已核实，不要重新调研）

- 全仓目前**没有**任何能改配置的工具。AI 说「改不了」符合现状。
- 危险路径是 AI 用 `run_command` 直接改 `%APPDATA%/Aurora/config.json`——那会绕过一切校验。
  本步的收尾断言要把这条也兜住（见「操作」第 8 条的 crash 矩阵）。
- `SettingsStore.sanitize()`（`packages/shared/src/config/store.ts:362-376`）已经做了两件关键保护：
  用 `SettingsSchema.safeParse` 校验（不合法就让本次更新整体失败并记 warn），
  以及 `llm.active` 指向不存在的 provider 时重置为空串。**本工具必须复用这条路径，不要自己写盘。**
- 写配置已有唯一正确入口：`apps/desktop/src/main/ipc.ts` 的 `applyPatch(deps, patch)`（536-614 行）。
  它负责局部合并语义、凭据抽取（`apiKey` / `env` → `setSecret`）、以及 `onSettingsChanged` 广播。
  **不要绕过 `applyPatch` 自己去 `settings.mutate()`**，否则会丢掉凭据保留与广播这两件事。
- `AgentHostDeps.provider` 是 `AgentProviderFactory`，只暴露 `create()`。
  本步要给它加一个可选的 `override` 参数，用于**启动自愈**：配置被写坏导致 `create()` 拿不到
  provider 时，自动回退到默认（或最近可用）provider，而不是让 AI 彻底失能（见第 6 条）。

## 输入

- `packages/agent-core/src/tools/registry.ts`（`ToolDefinition` / `ToolResult` / `sensitivity`）
- `packages/agent-core/src/tools/terminal.ts`、`tools/files.ts`（照抄它们的「纯逻辑 + 端口注入」写法与参数 schema 风格）
- `packages/agent-core/src/index.ts`（导出清单）
- `apps/desktop/src/main/tools/index.ts`（90 行的装配器，`sync()` 是唯一开关落地点）
- `apps/desktop/src/main/ipc.ts:536-614`（`applyPatch`）
- `apps/desktop/src/main/index.ts:410-434`（工具装配位置）、`:1043-1093`（smoke 里的工具断言先例）
- `packages/shared/src/config/schema.ts`（`SettingsSchema` / `fieldAccepts` / `isDynamicPath` / `debugSchemaSpecs`）
- `docs/06-agent-core.md` §5（工具约定）、§11（电脑操控工具）

## 操作

### 1. 配置项：敏感字段黑名单可配置（`packages/shared`）

1. `packages/shared/src/config/schema.ts`
   - 新增导出：

     ```ts
     /** AI 改配置（settings 工具）一律禁止触碰的路径前缀（docs/06 §12）。 */
     export const SETTINGS_READONLY_PREFIXES = [
       // 凭据与密文：绝不让 AI 读回或改写（凭据只经 safeStorage / setSecret 落库）
       'llm.providers',
       'mcp.servers',
       // Schema 版本与窗口几何：改坏会让配置迁移 / 窗口位置出现难以复现的怪状
       'version',
       'general.windowState',
       // 代理：写错会让所有出网立刻失效，AI 连不上自己就没法改回来
       'advanced.proxy',
       // 引导与首次运行标记、开机自启、全局快捷键：改它会改变启动路径或抢占系统热键
       'general.onboarded',
       'general.firstRun',
       'general.launchAtLogin',
       'general.hotkey',
     ] as const
     ```
   - 新增：

     ```ts
     /**
      * AI 改配置的路径是否可写（docs/06 §12）。
      * 规则：① 命中 `SETTINGS_READONLY_PREFIXES` → 拒绝；
      *      ② 路径必须能被 Schema 识别（`fieldAccepts` 或 `isDynamicPath`）→ 否则拒绝（防拼错字段悄悄写进配置）。
      */
     export function canWriteSettingPath(path: string): boolean
     export function settingsReadonlyReason(path: string): string | undefined
     ```

     `settingsReadonlyReason` 返回人类可读的中文原因（如「凭据字段不允许通过工具修改」「未知配置路径」），
     供工具回填给模型与写审计日志。
   - `AdvancedSchema`（`schema.ts:208`）新增 `readonlyPrefixes: z.array(z.string()).default([...SETTINGS_READONLY_PREFIXES])`。
   - **必须同步** `packages/shared/src/config/migrations.ts`：把 `migrateV5ToV6` 的 `describe` 改为
     「v5 → v6：移除 general.windowState['mini-chat']（独立小窗已删除）；补齐 advanced.readonlyPrefixes」，
     并在该迁移里用既有的 `fillMissing` 给 `advanced` 补上 `readonlyPrefixes`。
   - `packages/shared/src/config/schema.test.ts` 补三条：
     `canWriteSettingPath('agent.tools.terminal.enabled') === true`、
     `canWriteSettingPath('llm.providers.deepseek.apiKeyEnc') === false`、
     `canWriteSettingPath('modes.classrom.typo') === false`（拼错路径必须拒）。

### 2. 内核侧工具（`packages/agent-core`，纯 Node，不 import electron）

2. 新建 `packages/agent-core/src/tools/settings.ts`
   - 定义一个**端口**（不依赖 `@aurora/shared`，保持内核零工作区依赖）：

     ```ts
     export interface SettingsToolPort {
       /** 当前配置的可序列化快照（调用方负责脱敏：密文必须已被替换为空串） */
       snapshot(): Record<string, unknown>
       /** 读取一个路径的当前值；路径不可读时返回 undefined */
       read(path: string): unknown
       /** 路径是否可写；不可写时给出中文原因 */
       writable(path: string): { ok: true } | { ok: false; reason: string }
       /** 把多个路径的改动写回；返回实际生效的路径与人类可读摘要 */
       write(paths: Array<{ path: string; value: unknown }>): Promise<SettingsWriteOutcome>
     }

     export interface SettingsWriteOutcome {
       ok: boolean
       /** 失败原因（ok=false 时必填） */
       message: string
       /** 实际被改动的路径（ok=true 时用于回填与审计） */
       applied: string[]
     }
     ```

   - `createSettingsTool(options: { port: SettingsToolPort; logger?: Logger }): ToolDefinition`
     - `name: 'set_setting'`
     - `description`：中文，必须写明三件事：能改什么（`list` 先查）、改完立即生效、敏感字段会被拒。
       例：`「读取或修改 Aurora 自身配置。先用 action=list 查可写字段与当前值，再 set 写入。凭据、代理、
       窗口位置、Schema 版本与编程接口开关不可修改。修改立即生效，无需重启。」`
     - `sensitivity: 'confirm'`（改配置属于敏感操作，复用 docs/06 §5 的确认卡片链路；
       `advanced.confirmSensitiveTools` 关闭时自动放行，那是用户的选择）。
     - `parameters`：三个 action
       - `{ action: 'get', path: string }`
       - `{ action: 'list', group?: string }`（`group` 例如 `agent.tools`；不传则返回全部可写路径的
         `path` + `currentValue`，**单条 value 超过 200 字符截断**，整体超过 4000 字符要截断并提示用 `group` 收窄）
       - `{ action: 'set', values: Array<{ path: string; value: string | number | boolean }> }`
     - `execute` 的实现要求：
       - `get` / `list` 也要走 `port.writable(path)`：不可读的路径（凭据）返回 `{ content: '该路径不可读', isError: true }`。
       - `set` 先对**每个** path 调 `port.writable`，有一个不行就整体拒绝（不要写一半）；
         然后一次 `port.write(all)`。成功回填 `已修改：<path> = <新值>（旧值：<旧值>）`，失败回填 `message`。
       - **绝不在返回值里回显疑似密钥**：`content` 里的值统一经过一个 `redactValue(path, value)`：
         路径命中 `apiKey|Enc|env|secret|token|key` 一律替换成 `***`。
       - 捕获 `port.write` 抛出的异常，转成 `{ isError: true, content: '写入失败：' + String(error) }`，
         **不允许异常冒泡进工具循环**（那会中断整轮对话——这正是「AI 改设置导致崩溃」的表现之一）。
   - `packages/agent-core/src/index.ts` 追加 `export * from './tools/settings.js'`。
3. 新建 `packages/agent-core/src/tools/settings.test.ts`（Node 环境纯单测，用内存假端口）
   - 覆盖：`list` 不含不可写路径；`set` 含一个不可写路径时**一个字段都没写**（假端口记录调用次数为 1 且 applied 为空）；
     `set` 成功回填新旧值；路径含 `apiKey` 时回填值被 `***` 覆盖；
     `port.write` 抛异常时返回 `isError: true` 而不是抛穿；`list` 超长截断。
4. `packages/agent-core/src/host/agentHost.ts`
   - `AgentProviderFactory.create()` 改为 `create(options?: { allowFallback?: boolean }): ProviderConfig | undefined`。
   - `KernelAgentHost.send()` 里调用处（123 行）改为 `this.deps.provider.create()`（行为不变），
     新增的 `allowFallback` 只由装配层在**自愈**场景使用。
   - `packages/agent-core/src/testing/fakeProvider.ts` 的 `create` 签名同步放宽（漏改会 `pnpm typecheck` 报错）。

### 3. 主进程真实写入与自愈（`apps/desktop/src/main`）

5. 新建 `apps/desktop/src/main/tools/settings-port.ts`（主进程侧端口实现）：
   - 导出 `createSettingsPort(deps: { settings: SettingsStoreLike; applyPatch: (patch) => Result<Settings>; logger: Logger }): SettingsToolPort`。
   - `snapshot()`：`redactSettingsForRenderer` 同款脱敏（把 `apiKeyEnc` / `envEnc` 换成空串）。
     复用不了 `ipc.ts` 里的私有函数就把那两行逻辑抽成一个共享的内部函数，别复制两份。
   - `read(path)`：按 `.` 分段走 snapshot；`llm.providers.<id>.apiKey` 这类直读返回 `undefined`。
   - `writable(path)`：先查 `settings.get().advanced.readonlyPrefixes`，再调 `canWriteSettingPath(path)`。
   - `write(paths)`：
     - 按配置**顶层分组**（`general` / `llm` / `modes` / `skills` / `mcp` / `advanced` / `agent`）聚合成
       一个 `SettingsPatch`；同一分组内的多个 path 要按**深合并**逐层写进该分组对象
       （`settings:update` 只有顶层浅合并语义，见 `ipc.ts:563-568` 的注释——聚合时必须自己补齐嵌套层级）。
     - 写之前取 `before = settings.get()`，调用 `applyPatch`。
     - 失败 → 返回 `{ ok: false, message: '配置校验失败：...' }` 且**不做任何回滚动作**（`applyPatch` 失败时
       `SettingsStore` 根本没改内存态，回滚反而会写脏）。
     - 成功 → 立刻二次校验：`SettingsSchema.safeParse(settings.get())` 必须成功；
       若失败（理论上不该发生）→ 用 `settings.mutate` 把 `before` 整体写回并返回 `{ ok: false }`。
     - 审计：`logger.info('AI 修改配置', { applied, before: pick(before, applied), after: pick(after, applied) })`，
       值经脱敏函数；**不要把整份配置写进日志**。
     - 动态路径（`llm.providers.*`、`mcp.servers.*`）本来就在黑名单里，聚合逻辑遇到它们直接返回失败。
6. `apps/desktop/src/main/agent-host.ts`
   - `createProviderFactory` 支持自愈：`create({ allowFallback: true })` 时，
     若 `llm.active` 为空或指向不存在的 provider，且 `llm.providers` 里存在至少一个「有 baseUrl + model + 可用 Key」
     的条目，就临时用那个条目建 provider，并 `logger.warn('默认模型配置不可用，已回退到可用条目', { active, fallback })`。
     回退**只影响本次请求构造**，不写配置（写配置由用户或设置页决定）。
   - `KernelAgentHost` 构造处的 `provider` 选项包一层：正常调用 `create()`，捕获异常后 `create({ allowFallback: true })`。
   - 目的：即使 AI 把 `llm.active` 写空、或用户手改配置文件写错，Agent 也不会「彻底不可用」。
7. `apps/desktop/src/main/tools/index.ts`
   - `ComputerToolsDeps` 加 `settingsPort: SettingsToolPort`（新名字，别和已有的 `getSettings` 混）。
   - 新增导出 `registerSettingsTool(deps: { tools; port; logger }): { sync(): string[] }`，
     语义与 `registerComputerTools` 一致：`sync()` 先 `unregister('set_setting')` 再注册，
     **不受 `agent.tools.enabled` 影响**（`set_setting` 不属于 `COMPUTER_TOOL_NAMES`，
     且 `registerComputerTools.sync()` 只按那 5 个名字摘除，两者天然互不干扰）。
   - 若 `advanced.readonlyPrefixes` 为空数组，仍然注册（黑名单为空 = 全部可写？**不是**：
     `canWriteSettingPath` 的「Schema 必须识别该路径」这条兜底永远生效）。
8. `apps/desktop/src/main/index.ts`
   - 在 `computerTools.sync()` 之后加 `settingsTool = registerSettingsTool({...})` 并 `settingsTool.sync()`，
     紧邻第 425-434 行那段，务必在 `KernelAgentHost` 构造之前。
   - 抽一个 `syncToolRegistries()` 小函数，把 `computerTools.sync()` + `settingsTool.sync()` 一起调；
     把 425-434、696、1052、1059、1080、1085 六处 `computerTools?.sync()` 都换成它
     （漏改不会挂，但会让 `set_setting` 的注册时机与电脑操控工具不一致）。
   - `onSettingsChanged` 里新增 **crash 矩阵断言**（只在 `AURORA_SMOKE=1` 下跑，与既有 smoke 断言同一套路）：
     依次写入下列「AI 可能写出的坏值」，每次都断言 `SettingsSchema.safeParse(settings.get())` 成功、
     且 `tools.get('set_setting') !== undefined`（工具没有被写没）：

     ```
     { path: 'agent.tools.enabled', value: false }        // 关总开关
     { path: 'advanced.logLevel', value: 'verbose' }      // 非法枚举
     { path: 'llm.active', value: 'nope' }                // 指向不存在的 provider
     { path: 'modes.classroom.typo', value: 1 }           // 拼错路径
     { path: 'llm.providers.x.apiKeyEnc', value: 'leak' } // 黑名单
     ```

     前四条里 1、2、4、5 应当被工具拒绝（`ok: false`），第 3 条 `llm.active` 若被允许也要被
     `SettingsStore.sanitize` 重置为空串。逐条 `record('配置写入不会写坏（<path>）', ...)`。
   - 另加一条 crash 断言：直接用 `writeFs` 把 `config.json` 写成非法 JSON，
     等 `SettingsStore` 的监听/读取路径处理后，`settings.get()` 仍能返回一份合法配置
     （损坏文件走「备份后重建」，见 `store.ts:113-196`）。这条钉的是「AI 用 run_command 手改配置文件」这条路径。

### 4. 文档

9. `docs/06-agent-core.md` 新增 §12「AI 修改自身配置（`set_setting`）」，写清：
   - 工具签名与三个 action；
   - 黑名单（`advanced.readonlyPrefixes` 的默认值）与「未知路径一律拒绝」这条兜底；
   - `sensitivity: 'confirm'` 的确认链路；
   - 审计日志字段（`applied` / `before` / `after`，值已脱敏）；
   - 写入必须经 `applyPatch`，以及启动自愈（provider 回退）的存在理由。
   - 同步更新 §5 工具表与文件头的目录清单（`tools/settings.ts`）。
10. `docs/08-settings-onboarding.md` §1 配置表新增 `advanced.readonlyPrefixes` 一行，
    并注明「改它等于改 AI 可写范围，属于高级用户的逃生阀」。

## 验收标准

- [ ] `node node_modules/vitest/vitest.mjs run packages/agent-core/src/tools/settings.test.ts apps/desktop/src/main/tools/index.test.ts` 全绿
- [ ] `node node_modules/vitest/vitest.mjs run packages/shared/src/config/schema.test.ts packages/shared/src/config/migrations.test.ts` 全绿
- [ ] `node node_modules/typescript/bin/tsc -p packages/agent-core/tsconfig.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit` 退出码 0
- [ ] `Select-String -Path apps/desktop/src/main/ipc.ts -Pattern 'applyPatch'` 仍是配置写入的唯一落地点：
      `grep 'settings.mutate(' apps/desktop/src/main/tools/settings-port.ts` 只在**回滚**分支命中
- [ ] `AURORA_SMOKE=1 pnpm dev` 结束后 `%TEMP%\aurora-smoke-logs` 里
      `AURORA_SMOKE_RESULT` 无 FAIL，且能看到「配置写入不会写坏（...）」与「损坏 config.json 仍能恢复」两组 PASS
- [ ] `docs/06-agent-core.md` 里存在 `set_setting` 字样（`Select-String` 确认）

## 交接

- 给后续步骤：`settings` 工具已注册且名字固定为 `set_setting`；
  `AgentHostDeps.provider.create()` 多了可选 `{ allowFallback?: boolean }` 参数（改它的调用方要注意）。
- 给 step 3 的口径：**不要**把 `llm.providers.*` 加进白名单/移出黑名单；
  思考等级按钮走的是渲染层 `settingsStore.update`，与 `set_setting` 是两条独立路径。
- 待确认项：`agent.tools.enabled = false` 会把 `run_command` 等 5 个工具摘掉，AI 之后无法再自行改回来
  （`set_setting` 仍在，所以还能改回 `agent.tools.*`，但改不回来别的）。这是有意的边界，写进 docs/06 §12 即可。

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**；提交：`9036ad4`（+ 文档在 `26b5aed`、探针在 `6c98e76`）。

### 分片与结果

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 子代理 · 共享配置层 | `packages/shared/src/config/{schema,schema.test,migrations,migrations.test,defaults}.ts` | `SETTINGS_READONLY_PREFIXES`（9 项）+ `settingsReadonlyReason()` / `canWriteSettingPath()`；`advanced.readonlyPrefixes`（`.default([...])`）；`migrateV5ToV6` 用 `fillMissing` 补该字段 |
| 子代理 · 内核 | `packages/agent-core/src/tools/settings.ts`（新建，394 行）+ `settings.test.ts`（25 用例）、`index.ts`、`host/agentHost.ts` | `set_setting` 三 action / `confirm` / 200-4000 截断 / `redactValue` / 异常不冒泡；`create({ allowFallback })` |
| 子代理 · 主进程 | `main/tools/settings-port.ts`（新建）、`tools/index.ts`、`main/{index,agent-host,ipc}.ts`、`tools/index.test.ts` | 端口聚合 + 深合并 + `applyPatch` + 二次校验 + 审计；`registerSettingsTool` + `syncToolRegistries()`；crash 矩阵 |
| 子代理 · 文档 | `docs/06 §12`、`docs/08 §1`、`docs/10` | 见 `26b5aed` |
| Lead · 集成与验证 | SmokE 实跑、两处既有缺陷修复 | 见下 |

### 与原计划的三处偏差（都记明理由）

1. **`applyPatch` 不能原样导出**（它是 `ipc.ts` 的私有 `function`，且 `settings:update` 与工具都要用它）。
   改为从 `ipc.ts` 额外导出 `createSettingsWriter(deps)` / `redactSettings`，`applyPatch` 本体仍是唯一实现。
   因此端口的 `applyPatch` 参数是 **getter**（`() => (patch) => Result`）：端口必须在 `KernelAgentHost` 之前就位，
   而绑定它所需的 `DesktopDeps` 在那之后才装配完成。
2. **crash 矩阵第 1 条 `agent.tools.enabled` 不硬断言 `ok:false`**：计划第 3 节自己与「交接」矛盾
   （§2.1 明确要求 `canWriteSettingPath('agent.tools.enabled') === true`，且它不在黑名单里）。
   按「配置仍过 `SettingsSchema` + `set_setting` 仍在 + 跑完复位为 `true`」判定；其余 4 条硬断言被拒。
   这同时与 §12.6「总开关不是让模型彻底失能」的有意边界一致。
3. **crash 矩阵放在 `runSmokeTest` 的断言块里**（不是 `onSettingsChanged`）：那里的 `record` 不可见，
   且写入会重入 broadcast。断言走**真实工具** `tools.get('set_setting').execute(...)`。

### 验证时发现并修掉的两个既有缺陷（都在本步验收路径上）

- **空 `apiKeyEnc` 回传会清空磁盘凭据**：`settings:get` 给渲染层的 `apiKeyEnc` 恒为空串，
  而 `applyPatch` 的 provider 合并是「patch 覆盖已有」→ 设置页 `saveProvider` 回传全量 providers
  就会清掉已存密文；同进程被 `memorySecrets` 掩盖，**重启后才表现为「API Key 没了」**。
  `smoke.ts:229` 的既有注释已经警告过这个坑，但真实设置页正好踩中。
  修法：已有 provider 收到空串视为「本次不改凭据」（新建 provider 仍保留空串，Schema 要求该字段）。
  并新增端到端断言「带空 `apiKeyEnc` 回传后凭据仍在」。
  ⚠️ 这直接推翻了 step-04 计划里「`apiKeyEnc: ''` 必须保留在 patch 里」那句话 —— 那句话是错的，step 4 按本步语义执行。
- **`smoke.ts` 把配置版本写死成 5**：`settings.get.version === 5` 在 Schema 升到 v6 后必然 FAIL（实测 1 条 FAIL）。
  改为由主进程注入 `CONFIG_VERSION`。
- 相关同类问题（**未修，仅记录**）：`applyPatch` 的 `mcp.servers` 合并同样会让空 `envEnc: {}` 覆盖已存 MCP 凭据，
  本轮没有步骤触碰 MCP 编辑，留给后续单独处理。

### 验收（Lead 亲自复跑）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm lint` / `pnpm format:check` | ✅ 全绿（49 文件 / 716 用例） |
| `node ... vitest run packages/agent-core/src/tools/settings.test.ts` | ✅ 25 用例（内核分片实跑） |
| `AURORA_SMOKE=1 pnpm dev` | ✅ **106 PASS / 0 FAIL**（首轮 104/1，修掉版本断言后归零） |
| 其中 crash 矩阵 5 条 | ✅ `agent.tools.enabled` 可写但配置仍合法；`advanced.logLevel` / `modes.classroom.typo` / `llm.providers.x.apiKeyEnc` 被拒；`llm.active='nope'` 写入成功但被 `sanitize` 重置 |
| 「损坏 config.json 仍能恢复为合法配置」 | ✅ 备份文件已生成、`settings.get()` 仍合法 |
| 「带空 apiKeyEnc 回传后凭据仍在」 | ✅ `model=renamed-model` 且 `hasSecret` 为 true |
| `grep 'settings.mutate(' apps/desktop/src/main/tools/settings-port.ts` | ✅ 只在回滚分支命中 |

### 遗留

- `settings-port.ts` 没有独立单测（它 import `../ipc.js`，会拉 Electron，vitest 的 include 收不了）；
  真实覆盖靠 smoke 的 crash 矩阵 + `packages/agent-core` 的 25 条端口单测。
- `set` 的 `value` 只接受 `string | number | boolean`，因此 AI **无法**把 `advanced.readonlyPrefixes`（数组）
  清空来自我放宽权限 —— 已写进 `docs/06 §12.2`。
- `list` 完全依赖端口 `snapshot()` 的完整性（漏字段即不显示），已在两处注释里写明契约。
