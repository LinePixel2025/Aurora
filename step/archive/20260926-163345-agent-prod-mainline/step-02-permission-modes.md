# Step 02 — 三档权限（只读 / 需确认编辑 / 自动）+ 项目根路径边界

- Task: agent-prod-mainline
- Step: 2 / 6
- Status: done
- Depends on: step 1
- Produces: 三档权限生效（只读档不注册写/执行类工具）、项目根 + realpath 前缀校验、确认卡"本会话允许此工具"、设置页与对话窗权限控件、探针与文档
- Phase: 安全与边界
- Writes: `apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/tools/index.test.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/tools/command-runner.ts`、`apps/desktop/src/main/tools/command-runner.test.ts`、`apps/desktop/src/main/agent-host.ts`、`apps/desktop/src/main/agent-host.test.ts`、`apps/desktop/src/main/proactive.ts`、`apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/index.ts`（仅 `createConfirmTool` 装配闭包、`:648-656`）、`packages/agent-core/src/loop/agentLoop.ts`（**仅** `AgentLoopOptions.confirmTool` 的返回类型与方法签名、`:488-510` 的判定行，**不动轮次/预算/事件**）、`packages/agent-core/src/loop/agentLoop.test.ts`（仅 confirmTool 相关 describe）、`packages/agent-core/src/host/agentHost.ts`（仅 `AgentHostDeps.confirmTool` 的签名与转发，`:73-78`）、`packages/agent-core/src/tools/registry.ts`、`packages/agent-core/src/tools/registry.test.ts`、`packages/agent-core/src/tools/files.ts`、`packages/agent-core/src/tools/files.test.ts`、`packages/agent-core/src/tools/edit.ts`、`packages/agent-core/src/tools/edit.test.ts`、`packages/agent-core/src/tools/search.ts`、`packages/agent-core/src/tools/search.test.ts`、`packages/agent-core/src/tools/terminal.ts`、`packages/agent-core/src/tools/terminal.test.ts`、`packages/agent-core/src/tools/task.ts`、`packages/agent-core/src/tools/task.test.ts`、`apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`、`apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue`、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/settings/pages/AdvancedPage.vue`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/10-user-guide.md`、`docs/11-privacy.md`
- Risk: ①只读档若只做"注册后拒绝"，模型会先承诺再被拒（`docs/06:350` 的既有口径是"不在清单里"）——必须真的不注册（含 `todo_write`）。②路径校验用 `relative()` 比较时 Windows 大小写不敏感（`C:\Work` vs `c:\work`）与 UNC/网络盘 realpath 行为未验证，**先写一个 spike 用例实测再定实现**；③`file-port.ts` 是本步与 step 3 的共享文件：**本步负责 `resolveWithin` + 6 个调用点的 `allowOutside` 参数 + 为 `snapshot` 留出透传位，不实现快照逻辑**；step 3 在 step 2 之上插快照，不要反过来。④`capture.ts` 的权限探针现在断言的是布尔字段，改三档后**必 FAIL**，必须同一步改判据（见操作第 9 条）。出错回滚：本步是独立 commit，`git revert` 即可（`agent.permissionMode` 字段留在 Schema 里不影响功能）。
- Sources: [Claude Code permission-modes](https://code.claude.com/docs/en/permission-modes)（访问 2026-09-26）——6 档权限 + Protected paths，本项目取其三档子集；[openai/codex `codex-rs/core/src/tools/sandboxing.rs`](https://github.com/openai/codex)（访问 2026-09-26，rust-v0.157.1）——审批与沙箱是两层正交机制，本步只做"应用层分级"（OS 沙箱属第二批）。

## 目标

`agent.permissionMode` 真正改变 Agent 能做什么：`readonly` 档模型的行内工具清单里**没有任何**写/执行类工具；`confirm` 档与今天完全一致（逐次确认）；`auto` 档只在项目根之内免确认、越界照旧弹卡。同时所有文件类工具与 `run_command.cwd` 都经过 realpath 归一后的项目根前缀校验，`..` 穿越与符号链接逃逸在单测里被证明拒绝。

## 输入

- step 1 已落地：`agent.permissionMode ∈ {readonly, confirm, auto}`（Schema/defaults/迁移 v13/只读前缀）、`resolveProject()`（`packages/agent-core/src/config/project.ts`）、`effectiveWorkspaceDir()`（`packages/agent-core/src/config/effectiveWorkspace.ts`）。
- 权限判定收口点（**只需改这里就能覆盖全部工具**）：
  - `apps/desktop/src/main/agent-host.ts:261-305` 的 `createConfirmTool`：`271-272` 是唯一总放行分支（`enabled()` 假 → `return true`）；`276-289` 是 `run_command` 免确认特例（`allowPatterns` + 必写 info 审计日志）；`323-330` 是"解析不出命令就走正常确认"的 fail-safe。
  - `apps/desktop/src/main/index.ts:648-656` 是注入点（`enabled: () => settings.get().advanced.confirmSensitiveTools`、`allowPatterns: () => ...`，两者都是每次调用即时读的闭包）；同一实例注入内核（`:678`）与 `DesktopAgentHost`（`:686`）。
  - 内核侧闸门 `packages/agent-core/src/loop/agentLoop.ts:488-510`：**本步只改这里的返回类型与方法签名（为"本会话都允许"腾出 `'always'` 值），不改轮次/预算/事件相关代码**（那些归 step 4）。
- ⚠️ **`confirmTool` 的契约跨两个文件、两处都要改**：`ConfirmToolDecision` 是**主进程**类型（`apps/desktop/src/main/agent-host.ts:44-49`）；内核的入参形状由 `AgentHostDeps.confirmTool` **独立声明**（`packages/agent-core/src/host/agentHost.ts:73-78`，返回 `Promise<boolean>`）。内核里**没有** `ConfirmToolDecision` 这个类型。本步把两处同时扩成 `boolean | 'always'`（建议内核侧起一个自己的别名 `ConfirmDecision` 并让主进程的 `ConfirmToolDecision` 与之对齐），并同步 `agentLoop.ts:497-509` 的判定与 `agentHost.ts` 的转发。
- 工具注册门控：`apps/desktop/src/main/tools/index.ts` —— `registerComputerTools:72-169`，读记录守卫闭包在 `sync()` 之外（`:84-101`，**禁止挪进 sync()**，`docs/06 §11.6` 与 AGENTS.md 都有明写）；`sync():104-167` 的分支为 `107`（按 `COMPUTER_TOOL_NAMES` 全量注销）、`109-115`（总开关）、`117`（workspaceDir 解析，空串回落 `homeDir()`）、`119-128`（terminal）、`130-146`（files，`140` 已跳过 `open_path`）、`148-158`（search，`defaultRoot: workspaceDir`）、`160-162`（open）；`COMPUTER_TOOL_NAMES` 在 `packages/shared/src/config/schema.ts:429-438`（**新门控必须仍落在这个常量内**，否则 `sync()` 摘不掉旧实例）。兄弟装配器（`registerSettingsTool:198-209`、`registerExtensionTools:247-269`、`registerAgentCoreTools:298-316`、`registerClassIslandTools:345-361`）在独立注册表里。
- 路径处理现状：`apps/desktop/src/main/tools/file-port.ts` 的 `resolve()` 有 6 个调用点（`113`/`172`/`207`/`223`/`268`/`317`），全部裸 `resolve(path)`；`writeText:206-220` 先 `mkdir(recursive)` 再 `writeFileAtomic`（`:653-662`）。`command-runner.ts:54-75` 的 `cwd` 来自模型（`:62-65` 只在路径不存在时回落 `options.defaultCwd`）。**可照抄的路径包含判定**：`apps/desktop/src/main/imagegen.ts:166-172`（`relative()` + `rel.startsWith('..') || isAbsolute(rel)`）。
- 请求契约（内核 → port 的签名，改它会连带改测试）：`packages/agent-core/src/tools/files.ts` 的 `FilePort` 接口（`grep -n "export interface FilePort" packages/agent-core/src/tools/files.ts`）与 `createFileTools`/`createEditTool` 的装配参数（`apps/desktop/src/main/tools/index.ts:130-146`）；`terminal.ts` 的 `run_command` 参数（`{command, cwd?, timeoutMs?}`，`docs/06:293`）；`search.ts` 的 `grep`/`glob`（`docs/06:299-300`）。
- 确认卡现状：`apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue`（**注意在 `renderer/shared/components/` 下，不在 `chat/components/`**；props 带 `confirmId`，倒计时 ≤15s 转错误色，`111-117` 是"允许一次 / 拒绝"两个按钮）；主进程调度 `apps/desktop/src/main/proactive.ts:81-137`（勿扰拒 `90-93`、60s 超时拒 `105-113`，`DEFAULT_CONFIRM_TIMEOUT_MS = 60_000` 在 `:23`）。
- 权限 UI 现状：`apps/desktop/src/renderer/chat/components/ComposerPermissionSelect.vue`（锚点 `chat.permission:122` / `chat.permission-menu:136` / `chat.permission-confirm:142` / `chat.permission-full:160`；props `confirm/open/disabled:27-37`；两段式危险确认 `82-89`）；父层写盘 `apps/desktop/src/renderer/chat/App.vue:643-655`；设置页 `<input type=checkbox>` 单击即存 `settings/pages/AdvancedPage.vue:138-151`；工具门控摘要表 `settings/pages/AgentPage.vue:74-91`（**与主进程注册必须一一对应**）。
- 探针写法：`apps/desktop/src/main/capture.ts` 的 `CHAT_PERMISSION_ACT:1385-1403` / `CHAT_PERMISSION_CHECK:1405-1453`（含"点一次不写配置"用 `window.aurora.settings.get()` 复验 `1422-1423`、收尾收起下拉并轮询 `1429-1433`），注册在 `4680-4685`（**必须在 `chat-collapse` 之前**，见 `4690` 注释）；settings 页字段探针 `SETTINGS_AGENT_FIELDS_SCRIPT:2647-2717`（`count('[data-field^="..."]')` + `unexpected` 白名单 + `pass` 组合，**不要写死具体计数**）。⚠️ 探针是 template literal 字符串，**字符串内部注释不能用反引号**。
- 文档锚点：`docs/06-agent-core.md:278-353`（§11 头 + 常量表 + 配置字段与开关分派；注意 `:323-324` 明写这些上限"刻意不做成配置字段"—— 改 `maxRounds` 的表述归 step 4）、`:355-393`（§11.1 安全边界）、`:394-402`（§11.2 `confirmSensitiveTools=false` 的语义，本节要改成三档口径）、`:404-412`（§11.3 非目标）、`:592`（§12 开头）/ `:617-668`（§12.2 三道闸门与只读前缀清单）、`:1097-1119`（§17 settingsHint）；`docs/07-ui-spec.md:279-311`（工具行顺序与权限模式两档 → 三档）、`:337-363`（三浮层锚点与 `data-field` 清单）；`docs/10-user-guide.md`（用户侧的权限说明章节）；`docs/11-privacy.md:120-140`（`-ExecutionPolicy Bypass` 与"读取与检索免确认"的既有披露）。

## 操作

1. **先改文档**：`docs/06` 把 §11.2 从"`confirmSensitiveTools=false` 的语义"扩成"三档权限语义"（新增 `agent.permissionMode` 的取值表：每档允许什么、只读档如何影响工具注册、`confirmSensitiveTools` 与它的优先级）；在 §11 的常量表后补一节「项目根边界」写清校验层级（工具层传根 → port 层 realpath 校验 → 越界行为）；§12.2 的只读前缀清单加 `agent.permissionMode`；§17 settingsHint 同步。`docs/07` 把 `:302-311` 的权限模式改成三档并补锚点 `chat.permission-mode-readonly`；`docs/10` 增加"权限模式怎么选"的用户侧说明；`docs/11` 更新"读取与检索免确认"的披露（readonly/auto 档下的差异）。
2. **权限解析（纯函数，放 `apps/desktop/src/main/agent-host.ts` 的同目录新文件 `permission.ts`，或直接在 `agent-host.ts` 内导出）**：
   ```ts
   export type PermissionMode = 'readonly' | 'confirm' | 'auto'
   /** 双开关优先级（假设 1）：readonly 优先；confirmSensitiveTools=false 时非 readonly 强制 auto */
   export function resolvePermissionMode(settings: {
     agent: { permissionMode: PermissionMode }
     advanced: { confirmSensitiveTools: boolean }
   }): PermissionMode
   ```
   规则：`agent.permissionMode === 'readonly'` → `'readonly'`；否则若 `advanced.confirmSensitiveTools === false` → `'auto'`；否则 → `'confirm'`。写单测覆盖三条 + 组合（`readonly` + `false` → `readonly`）。
3. **权限判定（`apps/desktop/src/main/agent-host.ts`）**：把 `createConfirmTool` 的 `enabled(): boolean` 换成 `mode(): PermissionMode`（装配处同步改 `index.ts:648-656`）。判定顺序：
   - `readonly` → **直接拒绝**（返回 `false`，走既有的"用户拒绝执行"回填路径；只读档下正常情况根本不会调用到写工具，这里是双保险）。
   - `auto` → 先做**越界判定**：`run_command` 解析出的命令若命中 `allowPatterns` 仍跳过（保留特例与审计日志）；否则若该工具的**目标路径/命令 cwd 落在项目根内**（`resolveProject().root`，无项目时回落 `effectiveWorkspaceDir()`）→ `return true`；越界 → 走正常确认。
   - `confirm` → 完全保持今天的行为（`allowPatterns` 特例 + 正常确认）。
   - `auto` 的"目标路径"取值：`write_file`/`edit_file`/`read_file`/`list_dir` 取 `input.path`；`grep`/`glob` 取 `input.path`（缺省即搜索根）；`open_path` 取 `input.target`（非文件系统目标一律按越界处理 → 确认）；`run_command` 取 `input.cwd`（缺省用项目根）**并且**命令串里出现绝对路径时不做解析、一律按越界处理（保守，宁可多问）。
   - **审计不可少**：`auto` 档下每一次"因落在项目根内而放行"的调用都要写 `info` 级日志（沿用 `:281-287` 免确认模式的日志口径：工具名 + 路径 + 判定原因）。
4. **"本会话允许此工具"**：内核与渲染层都要扩一个决定值。做法：
   - 类型：`ConfirmToolDecision` 是**主进程**类型（`apps/desktop/src/main/agent-host.ts:44-49`）；内核入参由 `AgentHostDeps.confirmTool` 独立声明（`packages/agent-core/src/host/agentHost.ts:73-78`，返回 `Promise<boolean>`）。**两处都要从 `boolean` 扩成 `boolean | 'always'`**（内核侧建议起别名 `ConfirmDecision`，主进程的 `ConfirmToolDecision` 与之对齐），并同步 `packages/agent-core/src/loop/agentLoop.ts:488-510` 的判定与 `agentHost.ts` 的转发。`'always'` 语义 = 本次放行 + 本会话内同名工具不再询问。
   - 会话级授权表放**主进程**（不落盘、进程内 `Map<sessionId, Set<toolName>>`，`newSession` / `clear` / 归档时清空；**job 续跑不重建它**，授权随会话存在）。放在主进程的理由与 `docs/06 §12` 一致：授权面不给 AI、也不给渲染层。
   - 渲染层 `apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue` 加第三个按钮「本会话都允许」（`data-action="chat.confirm-always"`），倒计时与拒绝路径不变。
5. **工具注册门控（`apps/desktop/src/main/tools/index.ts`）**：`sync()` 内新增 `const permission = resolvePermissionMode(settings)`：
   - `readonly`：**整个 terminal 分支（`119-128`）跳过**；`files` 分支只注册 `read_file` / `list_dir` —— 注意 `createFileTools`（`:131` 的注释明写"恰好 4 个"）一次产出 4 个工具，需要在循环里按 `tool.name` 过滤掉 `write_file`（照 `:140` 跳过 `open_path` 的写法）；**`edit_file` 是另一行 `createEditTool`（`:145`）单独产出的，也要整行跳过**；`search` 分支**保留**（只读）；`open` 分支（`:160-162`）跳过。
   - **`registerAgentCoreTools`（`:298-316`）在只读档下要摘掉 `todo_write`、保留 `todo_read`**：`todo_write` 的 `sensitivity` 是 `safe`（`packages/agent-core/src/tools/todo.ts:69`），它会往 `<userData>/todos/<sid>.json` 落盘 —— 不摘掉的话"只读 = 无系统副作用"这个档位语义就是假的（工具名不在清单里这句字面成立，但副作用在）。保留 `todo_read` 与 systemPrompt 里既有的任务清单小节，读侧语义不变。
   - `confirm` / `auto`：与今天一致（受各自子开关约束）。
   - `readonly` 下 `agent.tools.enabled=false` 仍然优先（先看总开关）。
   - **其余兄弟装配器不动**：`registerSettingsTool`（`set_setting` 仍注册，但 `advanced.confirmSensitiveTools` / `agent.permissionMode` 都在只读前缀里，AI 改不动）、`registerExtensionTools`、`registerClassIslandTools`。
   - `AgentPage.vue:74-91` 的 `TOOL_GATES` / `activeToolNames` 同步：只读档下摘要必须显示"只读模式：仅注册只读工具（不含写入与命令）"，与实际注册一一对应。
6. **路径边界校验（`file-port.ts`）**：
   - 给 `createNodeFilePort(options)`（options 在 `:59-68`）加 `workspaceRoot?: () => string | undefined` 与 `enforceWorkspace?: () => boolean`（live getter，改配置即时生效）。
   - 新增内部函数 `resolveWithin(path)`：`target = resolve(path)` → 对**已存在的最近父目录**做 `fs.realpath`（目标文件可能不存在，`writeText` 的新文件场景）→ 对 `workspaceRoot()` 也做 realpath → 判定 `relative(root, target)` 不以 `..` 开头且不是绝对路径（照 `imagegen.ts:166-172`）。Windows 大小写：**先写一个 spike 用例**在 `file-port.test.ts` 里用 `mkdtemp` 造两个大小写变体测 `fs.realpath` 的实际返回，再决定是否 `toLowerCase()` 比较（结论写进 `docs/06 §11.1`，否则以后必被当 bug）。
   - `workspaceRoot()` 为空 / `enforceWorkspace()` 为假时**行为与今天完全一致**（向后兼容，也是单测的负例基线）。
   - 越界策略：**port 层负责如实拒绝**，抛一个可识别的错误 `E_PATH_OUTSIDE_WORKSPACE`（`code` 属性），由工具层转成 `isError` 结果 + 文案"该路径在项目根之外；如需操作请改用项目内路径，或在确认卡片确认后由工具层显式放行"。**"越界仍确认"由第 3 步的权限判定负责**，确认放行必须走一条**显式**通道：`readText` / `writeText` / `readWholeText` / `list` / `findFiles` / `searchText` 各加一个可选 `allowOutside?: boolean`（由工具层在"用户已确认 / auto 档已放行"时传 `true`）。这样"越界必须被确认后才可写"是可测的。
   - 6 个 `resolve()` 调用点全部改走 `resolveWithin`：`readText:113`、`readWholeText:172`、`writeText:207`、`list:223`、`findFiles:268`、`searchText:317`（**这 6 个签名同时改动，是本步最大的机械改动面**）。
   - **本步只做边界 + 为 `snapshot` 参数留出透传位**（见第 3 步的接口约定），**不实现快照逻辑**。
7. **`run_command` 的 cwd 校验（`command-runner.ts:54-75`）**：`request.cwd` 同样走 realpath 前缀校验；越界且未显式放行时**不执行**、回带"cwd 在项目根之外"的 isError。`cwd` 缺省时仍回落 `options.defaultCwd`（不视为越界）。
8. **内核工具的根与放行透传**：
   - `createFileTools` / `createEditTool` 加 `workspaceRoot` / `allowOutside` 相关参数（`apps/desktop/src/main/tools/index.ts:130-146` 装配处传）。
   - `packages/agent-core/src/tools/files.ts` / `edit.ts` / `search.ts` / `terminal.ts` 把 `allowOutside` 透传给 `FilePort`；**参数缺省时保持旧行为**（单测直接调工具时不传根就不拦截，沿用既有"未注入端口不拦截"的可测试性口径）。
   - `task.ts:136-145` 的子工具表过滤条件加一条：`readonly` 档下子代理也只拿只读工具（避免"主表只读、子代理全表"的绕过）。
9. **探针与 smoke（这里有一处必须一起改，否则必 FAIL）**：
   - `capture.ts` 的 `CHAT_PERMISSION_ACT:1385-1403` / `CHAT_PERMISSION_CHECK:1405-1453` **现状断言的是布尔字段** `advanced.confirmSensitiveTools`（`:1422-1423` 用 `state.value.advanced.confirmSensitiveTools === true` 复验"点一次不写配置"；`:1437-1447` 的 `pass` 断言"变更前确认 / 完全权限 / 再点一次确认"三处文案）。改成三档后**这三处会直接 FAIL** → 必须同步改：复验改成 `state.value.agent.permissionMode`，文案断言改成三档（只读 / 变更前确认 / 完全权限），并新增 `chat.permission-mode-readonly` 锚点的存在性断言。**这三处改动是 step 2 的验收项，不是可选的收尾**。
   - 新增场景 `chat-permission-readonly.png`（切到只读档 → 工具行/下拉文案断言 + `settings.get()` 复验 `agent.permissionMode === 'readonly'` + 该档下写类工具在设置页"电脑操控"摘要里不可见）。注册顺序遵守 `:4680-4690` 的既有约束（必须排在 `chat-collapse` 之前）。
   - `smoke.ts`：新增三组断言 —— ①`readonly` 档下 `send` 一个"请写入文件"的请求，模型即使发出 `write_file` 调用，事件里也**不会**出现该工具名（工具不在清单），且磁盘文件未被改动；②`auto` 档下项目根内的 `write_file` **不弹确认卡**且真的写成功（用 smoke 专用写入通道校验磁盘）；③`auto` 档下项目根**外**的 `write_file` 仍弹确认卡（与既有 `:610-700` 免确认模式正负对照同款手法）。smoke 改配置必须走 `settings:update`。
10. **验证并提交**：按验收标准逐条跑；提交信息建议 `feat(v0.1.5): 三档权限模式与项目根路径边界（工具门控 + realpath 校验 + 会话级授权）`。

## 验收标准

- [ ] `pnpm vitest run apps/desktop/src/main/agent-host.test.ts` 全绿，含 `resolvePermissionMode` 的 3 条 + 组合 1 条断言（`readonly` + `confirmSensitiveTools=false` → 仍是 `readonly`）。
- [ ] `pnpm vitest run apps/desktop/src/main/tools/index.test.ts` 全绿，且存在断言：`readonly` 档下注册的工具名集合**不含** `run_command` / `write_file` / `edit_file` / `open_path`，且**含** `read_file` / `list_dir` / `grep` / `glob`；**同一集合里不含 `todo_write` 但含 `todo_read`**；`readonly` + `agent.tools.enabled=false` 时集合为空。
- [ ] `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` 全绿，且新增用例覆盖：①`mkdtemp` 真磁盘下 `..` 穿越被拒（返回 `E_PATH_OUTSIDE_WORKSPACE`）；②符号链接指向根外被拒；③`allowOutside: true` 时同一路径可写；④`workspaceRoot` 未配置时行为与改动前一致（同一用例改动前断言值不变）；⑤大小写变体（`C:\...` 与 `c:\...`）的实际判定结果被写进用例注释。
- [ ] `pnpm vitest run apps/desktop/src/main/tools/command-runner.test.ts` 全绿，含 cwd 越界不执行 + 越界显式放行可执行的成对断言。
- [ ] `pnpm vitest run packages/agent-core/src/tools` 全绿；`registry.test.ts` 或 `agentLoop.test.ts` 含 `confirmTool` 返回 `'always'` 时"同会话同名工具第二次不再询问"的断言。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 退出码 0；`pnpm test` 全量退出码 0。
- [ ] `AURORA_SMOKE=1 pnpm dev` 结束后 `AURORA_SMOKE_RESULT` 全通过，且三项新增断言（readonly 不注册写工具 / auto 根内免确认 / auto 根外仍确认）都出现在日志里。
- [ ] `AURORA_CAPTURE="$env:TEMP\aurora-capture-02" pnpm dev` 退出码 0，`report.json` 无 FAIL，含 `chat-permission-readonly.png`；**且 `chat-composer-permission.png` / `chat-composer-flyouts.png` 的判据已按三档改写后通过**（不要保留旧的布尔文案断言，那会必 FAIL）。
- [ ] 只读档不会自我提权（**运行时断言，不是 grep 文本断言**）：`pnpm vitest run packages/shared/src/config` 通过，且 `schema.test.ts` 里存在 `canWriteSettingPath('projects.current') === false` 与 `canWriteSettingPath('agent.permissionMode') === false` 两条运行时断言（照该文件既有的只读前缀用例写法）。
- [ ] 只读档下设置页摘要与真实注册一致：`capture.ts` 的 `chat-permission-readonly` 场景里有"只读模式：仅注册只读工具（不含写入与命令）"的文案断言（这条是"摘要不骗人"的运行时证据）。

## 交接

- 给 step 3：`apps/desktop/src/main/tools/file-port.ts` 已具备 `resolveWithin` 与 `allowOutside`（`workspaceRoot()` / `enforceWorkspace()` 两个 live getter 也在 `createNodeFilePort` 的 options 里）；**快照只需要在 `writeText` 内、`resolveWithin` 之后、真正写盘之前插一刀**，并给 `writeText` / `readWholeText` 加一个可选 `snapshot?: { sessionId: string; toolCallId?: string; origin: 'write_file' | 'edit_file' }` 参数由工具层传入。`FilePort` 接口在 `packages/agent-core/src/tools/files.ts`（`grep -n "export interface FilePort"` 定位），加参数会连带改 `files.ts` / `edit.ts` 的调用处与 `files.test.ts` / `edit.test.ts` / `file-port.test.ts`。
- 给 step 4：`apps/desktop/src/main/agent-host.ts` 的 `createConfirmTool` 现已带三档判定与会话级授权 `Map`，job 续跑时**必须复用同一个实例**（授权表随会话存在，job 恢复不该丢授权）。
- 给 step 5：三档的端到端证据由 step 2 的 smoke/capture 断言提供；step 5 只做跨特性的整合断言与文档收口。

## 执行记录

执行时间：2026-09-26（本会话）。执行模式：全部连续执行。依赖 step 1（done）。

### 提交清单

| SHA | 提交 |
|---|---|
| `e9ed4e1` | `feat(agent-core): 三档权限判定与确认值「本会话都允许」` |
| `12dca39` | `feat(agent-core): allowOutside 透传 + 只读档下子代理工具面收窄` |
| `cf013ff` | `feat(settings): 项目根 realpath 边界校验 + 只读档工具门控与端到端断言` |
| `c274838` | `feat(settings): 三档权限界面（下拉/设置页/确认卡第三键）与文档落笔` |

### 实际改动

- **纯判定（新文件 `packages/shared/src/config/permission.ts`）**：`PermissionMode`、`resolvePermissionMode`
  （readonly 优先 → 显式 auto → 老开关 `confirmSensitiveTools === false` → confirm）、`permissionTargetOf`
  （按工具名取目标路径，解析不出返回 `undefined`）、`isWithinRoot`（字符串级粗判，含 `..` 段一律按越界）。
  主入口与 `browser` 子路径都导出，**主进程与渲染层读同一份**。
- **确认判定（`apps/desktop/src/main/agent-host.ts`）**：`createConfirmTool` 的 `enabled()` → `mode()`；
  只读档直接拒绝（warn）、`auto` 档按项目根内/外分流并对根内放行写 `info` 审计日志、
  `confirm` 档与从前一字不差；无项目时 `auto` 保持"关掉确认总开关 = 不再逐次询问"的老语义。
  另加 `containsAbsolutePath`：`run_command` 的命令串里出现绝对路径时**一律回到确认卡片**（保守）。
- **确认值三态**：`ConfirmDecision = boolean | 'always'`（agent-core）+ `ConfirmResolution`（主进程 proactive）；
  渲染层确认卡加第三颗按钮 `data-action="chat.confirm-always"`；IPC `proactive:resolveSensitiveTool`
  扩第三个参数 `always?: boolean`。**会话级授权表在 `KernelAgentHost`**（进程内 `Map`，不落盘、
  不给渲染层也不给 AI；`clearSessionApprovals()` 供会话清理）。
- **路径边界**：`file-port.ts` 的 `resolveWithin`（对已存在最近父目录做 `realpath`，越界抛带
  `code = 'E_PATH_OUTSIDE_WORKSPACE'` 的错误）+ 六个入口的 `allowOutside`；`command-runner.ts` 的
  `cwd` 走同一套判定。装配层 `projectRoot` getter 同时喂给两者，**只在配置了当前项目时启用**
  （`workspaceRoot()` 返回 undefined = 行为与 v13 之前一字不差）。
- **工具门控**：`registerComputerTools.sync()` 按生效档位注册（只读档跳过 terminal / edit_file /
  open_path / write_file，保留 read_file / list_dir / grep / glob）；
  `registerAgentCoreTools` 只读档摘 `todo_write`、留 `todo_read`（它有 `safe` 级但仍会写
  `<userData>/todos/`）。`task` 保留（子代理工具面从已收窄的父表过滤）。
- **界面**：对话窗下拉三档 + 放宽两段式、收紧单击生效；设置页 `AdvancedPage` 三档单选；
  `AgentPage` 摘要按生效档位写（只读档固定文案，capture 断言原文）。
- **探针/自测**：capture 新增 `chat-permission-readonly.png` 场景、`chat-composer-permission` 探针改三档、
  settings-agent 探针加"临时切只读档断言摘要与生效工具名单再还原"；smoke 新增两条端到端断言。
- **文档**：docs/06 §11.2（新增三档语义表：只读档语义、auto 档保守方向、两层边界分工、老开关承接）、
  §11 配置字段与 §11.1 边界口径；docs/07 权限模式/确认卡/锚点/探针条目；docs/10 用户侧说明；docs/11 披露。

### 与计划的偏差

1. **权限判定纯函数放在 `packages/shared`** 而不是主进程：主进程与渲染层必须看到同一个"生效档位"，
   各写一份必然漂移（"界面说只读、实际还能写"）。计划写的是"放 `apps/desktop/src/main/agent-host.ts`
   同目录的新文件"。
2. **会话级授权表放在内核 `KernelAgentHost`** 而不是主进程：循环一趟请求一个实例，记忆放循环等于没记住；
   放内核既不暴露给 AI 也不暴露给渲染层（安全属性与放主进程相同），且验收标准要的
   "同会话第二次不再询问"能在内核单测里证明。
3. **"越界仍确认"的通道**：由内核在确认放行时置 `ToolExecuteContext.approvedByUser`，工具层据此
   透传 `allowOutside` —— 计划只写了"由工具层在用户已确认时传 true"，没说这条信息怎么到工具层。
4. **边界启用条件按"有没有当前项目"**（不是 `workspaceDir` 非空）：`workspaceDir` 一直是"默认 cwd"，
   把它变成硬边界会让老用户突然读不了自己的文档；step 1 的完成标准也明写"无项目时行为不变"。
5. **`isWithinRoot` 对含 `..` 的路径直接判越界**：字符串级判定只决定"要不要问用户"，保守方向永远是问。
6. **`command-runner` 的 cwd 校验复用 `file-port` 导出的 `resolveWithin`**（不复制两份判定）。
7. **`tasks` 的子代理过滤做成可注入白名单**（`subagentToolNames`），而不是在 `task.ts` 里硬编码档位判断
   —— 档位解析只在主进程。

### 验证结果（全部由主代理亲自复跑）

| 验收项 | 结果 |
|---|---|
| `pnpm vitest run apps/desktop/src/main/agent-host.test.ts` | 25 passed（含三档判定 5 条：readonly 拒绝不弹卡、auto 根内放行+info 日志、auto 根外弹卡、run_command 绝对路径保守、confirm 不变） |
| `pnpm vitest run apps/desktop/src/main/tools/index.test.ts` | 33 passed（只读档完整名单、readonly+总开关=false → 空、confirm/auto 回归基线、只读优先压过老开关、切档立即生效；含 `todo_write` 摘除与 `todo_read` 保留） |
| `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` | 55 passed（含 `..` 穿越被拒 / 符号链接 / `allowOutside` 放行 / 未配置根时行为不变 / Windows 大小写实测结论） |
| `pnpm vitest run apps/desktop/src/main/tools/command-runner.test.ts` | 14 passed（新增成对断言：cwd 越界不执行且副作用文件不出现 + `allowOutside` 放行时真的执行 + 未配置根时与从前一致） |
| `pnpm vitest run packages/agent-core/src` | 全绿（含 `confirmTool` 返回 `'always'` 时执行 + 同会话第二次不再询问的计数断言） |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | 均 exit 0 |
| `pnpm test` | **77 文件 / 1420 用例全绿**（step 1 后为 1373） |
| `AURORA_SMOKE=1 pnpm dev` | **149/149 passed，exit 0**；新增两条：`只读档：写 / 执行类工具不进注册表（含 todo_write），只读工具保留 — readonlyKept=[read_file,list_dir,grep,glob,todo_read]`、`auto 档：项目根内免确认且真的写成功；根外仍弹确认卡且未放行时写不进去 — autoInside=approve:true noCard:true written:true autoOutside=card:true blocked:true` |
| `AURORA_CAPTURE=$env:TEMP\aurora-capture-08 pnpm dev` | **50 张 PNG / 50 条 checks / 0 FAIL / exit 0**，含 `chat-permission-readonly.png`（`permissionMode: readonly` + 文案「只读」+ 收尾还原成「变更前确认」）与 `settings-agent.png` 的 `readonlySummary/readonlyTools/readonlyRestored` 三条全 true；`chat-composer-permission.png` 三档与两段式全部通过 |

### 过程中的问题与处置

1. **三个子代理中途失败**（agent-core 管道 / file-port / 渲染层 各一个），主代理接手收尾：
   - file-port 的 `createPathOutsideError` 类型错误（`Object.assign` 把字面量推成 `string`）→ 改 `as` + 赋值；
   - `command-runner.test.ts` 的边界用例**没写完**（子代理死在最后一步）→ 补 4 条成对断言；
   - 主进程装配缺口：`registerAgentCoreTools` 没传 `getSettings`（只读档摘不掉 `todo_write`）、
     `createNodeFilePort` / `createCommandRunner` 没接 `workspaceRoot` → 主代理补线。
2. **`resolvePermissionMode` 初版漏了"显式 auto 分支"**（只判 readonly 与老开关），被自己写的单测抓到 → 修正。
3. **capture 只读摘要断言初版过粗**（拿整页文本判"不含写类工具名"，而页面上别处的工具箱标题本来就会提到）
   → 改成只在「当前生效工具」块内读 `code` 名单。

### 遗留问题

1. `read_file` / `list_dir` / `grep` / `glob` 是 `safe` 级、不走确认卡片，因此**在项目根之外会被直接拒绝**
   （没有"确认后越界读"的通道）。这是刻意取舍（只读工具没有确认载体），已写进 docs/06 §11.2 与 docs/11。
2. `task`（子代理）在只读档下仍注册：它本身不碰系统，子代理工具面从已收窄的父表过滤；
   但如果将来给 `task` 加了"子代理可写"能力，需要重新评估。
3. `open_path` 在 `auto` 档下的目标判定用 `input.target`；非文件系统目标（HTTP 链接等）解析不出 → 走确认。
   与"打开路径本身有副作用"一致，未额外放宽。
4. capture 的 `chat-tool-card-open` / `chat-stream-burst` 两条 perf·时序探针仍存在**帧饥饿环境**下的偶发失败
   （step 1 已记录，本步未动）。本步的验收用的是 `aurora-capture-08` 这次干净全量跑。
