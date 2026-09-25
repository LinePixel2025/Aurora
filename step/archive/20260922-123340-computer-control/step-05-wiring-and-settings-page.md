# Step 05 — 装配、开关热生效、设置页与截图探针

- Task: computer-control
- Step: 5 / 7
- Status: done
- Depends on: step 2（设置页新增字段的写法）、step 3、step 4（工具工厂与端口）
- Produces: `apps/desktop/src/main/tools/index.ts` 装配器、主进程接线、`AgentPage.vue` + 侧栏入口、capture 探针与计数文档

## 目标

工具真的进了 Agent 的工具表（模型能看到并调用），设置页能开/关它们且**改完立即生效**（无需重启），
并且「有哪些开关、当前生效哪些工具」都有自动化证据，而不是靠看代码。

## 输入

- `apps/desktop/src/main/index.ts` 第 402–470 行（`new ToolRegistry()` → `skillBridge.registerInto(tools)` → MCP → 内核装配）
  与第 658–673 行（`onSettingsChanged`）
- `packages/shared/src/ipc/types.ts` 第 37 行附近（`OpenPathRequest.kind` 联合类型）
- `apps/desktop/src/main/ipc.ts` 第 639–670 行（`openPath()` 的 `switch (request.kind)`）
- `apps/desktop/src/renderer/settings/pages/AdvancedPage.vue`（页面骨架与 `save()` 的浅合并写法，照抄风格）
- `apps/desktop/src/renderer/settings/App.vue`（`nav` / `navGroups` / 渲染分支）
- `apps/desktop/src/main/capture.ts`（`SETTINGS_PAGE_IDS`、`SETTINGS_FIELDS_SCRIPT`、`defaultCapturePlan`）
- `packages/shared/src/config/schema.ts` 的 `COMPUTER_TOOL_NAMES`（step 1 建立）
- `AGENTS.md`、`docs/07-ui-spec.md` §5.3（截图与页面数量的描述）

## 操作

### 1. 装配器（不 import electron，保证可单测）

新建 `apps/desktop/src/main/tools/index.ts`：

```ts
export interface ComputerToolsDeps {
  tools: ToolRegistry
  getSettings: () => Settings
  logger: Logger
  homeDir: () => string
  run: CommandRunner
  files: FilePort
  open: OpenPort
}
export function registerComputerTools(deps: ComputerToolsDeps): { sync(): string[] }
```

`sync()` 语义（**幂等**，且每次都用当前配置重建工具实例——构造很便宜，这样 cwd / 超时 / 上限
改完立即生效）：

1. 先把 `COMPUTER_TOOL_NAMES` 里的 5 个名字全部 `tools.unregister(name)`（不存在的返回 false，忽略）；
2. `const cfg = deps.getSettings().agent.tools`，`if (!cfg.enabled) return []`；
3. `const workspaceDir = cfg.workspaceDir.trim() === '' ? deps.homeDir() : cfg.workspaceDir.trim()`；
4. `cfg.terminal.enabled` → `tools.register(createTerminalTool({ run: deps.run, timeoutMs: cfg.terminal.timeoutMs,
   maxOutputChars: cfg.terminal.maxOutputChars, defaultCwd: workspaceDir }))`；
5. `cfg.files.enabled` → `createFileTools({ files: deps.files, open: deps.open,
   maxReadBytes: cfg.files.maxReadBytes })` 里取 `read_file` / `write_file` / `list_dir` 注册；
6. `cfg.open.enabled` → `tools.register(createOpenTool({ open: deps.open }))`；
7. 返回当前注册的名字数组；`deps.logger.info('已同步电脑操控工具', { names, workspaceDir })`。

补单测 `apps/desktop/src/main/tools/index.test.ts`（无 electron；假 runner / 假 FilePort / 假 OpenPort，
`getSettings` 返回一个由对象字面量拼出的 `Settings`，用 `structuredClone(createDefaultSettings())` 再改字段）：

- 全开 → `sync()` 返回的名字集合等于 `[...COMPUTER_TOOL_NAMES]`；
- `agent.tools.enabled = false` → 空数组，且 `tools.list()` 里 5 个名字一个都不剩
  （`use_skill` 之类的其它工具不受影响：测试里先注册一个 `use_skill` 占位，断言它还在）；
- `terminal.enabled = false` → 只剩 4 个（`run_command` 消失）；
- `files.enabled = false` → `read_file/write_file/list_dir` 消失但 `open_path` 还在；
- `open.enabled = false` → `open_path` 消失；
- 连续两次 `sync()` 结果一致、`tools.list().length` 不变（幂等，不重复注册）；
- 改 `terminal.maxOutputChars` 后再 `sync()`：用假 runner 返回 5000 字符输出，
  断言 `run_command.execute(...)` 的结果里出现截断标记（证明重建确实换了新上限）。

### 2. 主进程接线

`apps/desktop/src/main/index.ts`：

- 在 `skillBridge.registerInto(tools)` **之后**、`mcp.start()` 之前（或之后均可，只要在内核构造前）装配：
  ```ts
  const computerTools = registerComputerTools({
    tools,
    getSettings: () => settings!.get(),
    logger: logger.child('tools'),
    homeDir: () => app.getPath('home'),
    run: createCommandRunner({ maxOutputBytes: 1024 * 1024 }),
    files: createNodeFilePort(),
    open: createShellOpenPort(),
  })
  computerTools.sync()
  ```
  注意 `createCommandRunner` 的 `defaultCwd` 兜底传 `process.cwd()`，**真正的工作目录由工具层每次传入**
  （step 3 的 `CommandRequest.cwd`），这样 `agent.tools.workspaceDir` 改了不用重建 runner。
- `onSettingsChanged(next)` 里追加一行 `computerTools.sync()`（与既有 `skillsService.reconfigure` 并列），
  并在注释里写清「开关/上限改完立即生效，工具表变化会进下一次请求的系统提示词」。
- 若 `index.ts` 中已有同名局部变量 `tools`，不要改动它的名字（装配片段直接引用它）。

### 3. `openPath` 支持工作目录

- `packages/shared/src/ipc/types.ts`：`OpenPathRequest.kind` 联合类型追加 `'workspace'`。
- `apps/desktop/src/main/ipc.ts` 的 `openPath()`：在 `case 'watchDir'` 附近加
  `case 'workspace':` → 取 `settings.agent.tools.workspaceDir.trim()`，空串回落 `app.getPath('home')`。
- 不需要动 `preload`（通道名没变，payload 是字面量）。

### 4. 设置页

新建 `apps/desktop/src/renderer/settings/pages/AgentPage.vue`（骨架照 `AdvancedPage.vue`：`.page` +
`AppToast` + 若干 `.section-card`），分组与 `data-field` 必须与 step 1 的门控矩阵一致：

- 「总开关」卡：`agent.tools.enabled`（复选框，常显，文案说明关闭后模型完全看不到这 5 个工具）；
  卡里再给一句警示：「若在高级页关闭了『敏感工具确认』，命令与文件写入将不经确认直接执行」。
- 「工作目录」卡：`agent.tools.workspaceDir` 输入框（提示：留空 = 用户主目录）+ 「打开工作目录」按钮，
  按钮走 `window.aurora.app.openPath({ kind: 'workspace' })`，成功时把返回路径显示出来。
- 「终端」卡（仅 `agent.tools.enabled === true` 时渲染，否则原位置放
  `<p class="tiny muted" data-empty="agent.tools.terminal">` 说明块）：
  `agent.tools.terminal.enabled`、`.timeoutMs`（数字输入，1000–300000）、
  `.maxOutputChars`（数字输入，500–100000）。
- 「文件」卡（同上门控）：`agent.tools.files.enabled`、`.maxReadBytes`（1024–4194304）。
- 「打开」卡（同上门控）：`agent.tools.open.enabled`。
- 「当前生效工具」卡：按当前配置用 `COMPUTER_TOOL_NAMES` 计算并列出会注册的工具名
  （从 `@aurora/shared/browser` import，**不要**从 `@aurora/shared` 主入口 import）。
- 保存一律走 `settingsStore.update({ agent: { tools: { ...完整 tree } } })`：
  `settings:update` 只做**顶层浅合并**，只传 `{ terminal: {...} }` 会把 `files` / `open` 静默丢掉
  （capture 里已有同类回归探针，别重犯）。

`apps/desktop/src/renderer/settings/App.vue`：

- `PageId` 联合类型加 `'agent'`；`nav` 加
  `{ id: 'agent', label: '电脑操控', hint: '终端与文件操控' }`；
- `navGroups` 的「AI 能力」组改成 `['llm', 'skills', 'mcp', 'agent']`；
- `<main>` 里加 `<AgentPage v-else-if="active === 'agent'" />` 分支（放在 `AdvancedPage` 之前，
  保持 `v-else` 兜底仍是高级页）。

### 5. 截图探针与计数文档

`apps/desktop/src/main/capture.ts`：

- `SETTINGS_PAGE_IDS` 追加 `'agent'`（数组顺序决定出图顺序，放在 `'advanced'` 前）；
- 新增 `SETTINGS_AGENT_FIELDS_SCRIPT`：统计 `[data-field^="agent.tools"]` 总数、
  `[data-field="agent.tools.enabled"]` 是否存在、终端/文件/打开三个详情字段的数量，
  以及 `data-empty` 列表；`pass = 总开关存在 && (总开关为开 → 详情字段 > 0)`；
  与 `SETTINGS_FIELDS_SCRIPT` 一样用 try/catch 包住并返回 `{ pass: false, reason }`；
- `defaultCapturePlan()`：给 `page === 'agent'` 的条目挂上这个 check
  （沿用现有 `check: page === 'general' ? … : undefined` 的写法，改成 `general` / `agent` 两分支）。

文档同步（**这是本步的一部分，不是可选项**）：

- `AGENTS.md` 的 AURORA_CAPTURE 段落：设置页 6 页 → 7 页、PNG 张数按实际 `report.json` 条目数更新
  （本任务新增 `settings-agent.png` 与 step 2 的 `settings-llm-params.png`，即 16 → 18；若实际不符以
  `report.json` 为准，不要照抄这个数字）；
- `docs/07-ui-spec.md` §5.3 同步同样的数字；
- `docs/08-settings-onboarding.md` §6.1 若 step 1 写的门控描述与本步实现不一致，以实现为准修正。

## 验收标准

- [x] `pnpm vitest run apps/desktop/src/main/tools` 全绿（`index.test.ts` 的 6 组断言）
      —— 实跑 3 文件 / 28 用例；`index.test.ts` 落了 8 条（比要求多两条：默认工作目录来自 `homeDir()`、
      上限改完再 `sync()` 立即生效）
- [x] `pnpm typecheck` 通过
- [x] `pnpm build` 通过
- [x] `$env:AURORA_CAPTURE="$env:TEMP\aurora-cap-step5"; pnpm dev` 退出码 0，
      `report.json` 里 `settings-agent` 的 `pass === true`，目录中含 `settings-agent.png`，
      且 PNG 总数与 `AGENTS.md` 里写的数字一致
      —— 实测 **18 张 PNG**、退出码 0、FAIL 数 0；
      `settings-agent`：`{"togglePresent":true,"enabled":true,"total":8,"terminalFields":3,"filesFields":2,"openFields":1,"emptyStates":[],"pass":true}`
- [x] `grep -rn "agent.tools" apps/desktop/src/renderer/settings/pages/AgentPage.vue` 覆盖 5 个开关 +
      3 个上限字段，路径与 `packages/shared/src/config/schema.ts` 完全一致
      （实际 8 个 `data-field`：enabled / workspaceDir / terminal.enabled / terminal.timeoutMs /
      terminal.maxOutputChars / files.enabled / files.maxReadBytes / open.enabled）
- [x] `grep -n "computerTools.sync()" apps/desktop/src/main/index.ts` 至少命中 2 处（L430 启动、L692 设置变更）
- [x] 手工回归：设置页关掉「终端」→ 保存 → 重新打开仍是关闭；`agent.tools.files` 的值没有被连带丢掉
      —— **替代性覆盖**：由 `index.test.ts`（关终端只剩 4 个工具、关文件时 `open_path` 仍在）与
      step 6 的 smoke 断言等价覆盖；capture 走隔离 userData，手工点击验的是本机配置，
      两者冲突，故以自动化断言为准（未经 `.vue` 保存路径的真实点击验证，审查已登记）

## 执行记录

**状态：done（2026-09-20）· 提交 `fe142c4`**

### 子代理分片（同波 4 个，写范围互不重叠）

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 主代理（核心装配） | `main/tools/index.ts` + `index.test.ts`、`main/index.ts` 接线、`ipc.ts` 的 `openPath({kind:'workspace'})`、`shared/ipc/types.ts`（`OpenPathRequest` / `SettingsPatch.agent`）、`settings/App.vue` 侧栏 | 完成 |
| 子代理 `b958e158` | `settings/pages/AgentPage.vue`（新建） | 完成；用 SSR 渲染 + 隔离 `tsc` 探针自查了门控与保存形状 |
| 主代理（capture 探针） | `capture.ts`：`SETTINGS_PAGE_IDS` + `SETTINGS_AGENT_FIELDS_SCRIPT` + plan 挂 check | 完成，实跑通过 |
| 主代理（文档计数） | `AGENTS.md`、`docs/07 §5.3`、`docs/08 §6.1` | 完成 |

### 实际改动
- 见提交信息；要点：`sync()` 幂等且每次按当前配置**重建**工具实例（cwd / 超时 / 上限热改），
  总开关关闭时把 5 个名字全部摘掉；`onSettingsChanged` 里再 `sync()` 一次即为「热生效」的全部实现。
- `AgentPage.vue` 保存一律回传**完整** `agent.tools` 子树（`settings:update` 顶层浅合并 + agent 整棵覆盖，
  只传 `{ terminal }` 会静默丢掉 `files` / `open`）；「当前生效工具」卡按 `COMPUTER_TOOL_NAMES` 过滤计算。

### 验证（主代理实跑）
- `pnpm vitest run apps/desktop/src/main/tools` → 3 文件 / 28 用例全过。
- `pnpm typecheck` → 0；`pnpm build` → 0；`pnpm lint` → 0；`prettier --check` → 通过。
- `$env:AURORA_CAPTURE=%TEMP%\aurora-cap-step5; pnpm dev` → **退出码 0**，18 张 PNG，`report.json` 无 FAIL；
  启动日志出现 `[tools] 已同步电脑操控工具 {"names":["run_command","read_file","write_file","list_dir","open_path"],"workspaceDir":"C:\\Users\\22798"}`。

### 遗留
- 手工点击回归改由自动化断言覆盖（原因见验收标准最后一条）。
- `integrations/classisland-bridge` 与本步无关，未动。
