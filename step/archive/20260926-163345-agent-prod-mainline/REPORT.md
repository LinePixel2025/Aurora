# REPORT — agent-prod-mainline（项目机制 + 三档权限 + 写前快照 + Task/Job 续跑）

- 任务标识：`agent-prod-mainline`（slug 与 `00-index.md` 逐字符相同）
- 基线提交：`afd23827dee06381e72ca1d21d6371dc1d865dcc` → 归档时 HEAD：`4950c1c`
- 归档目录：`step/archive/20260926-163345-agent-prod-mainline/`（7 个文件 = 00-index + 6 个 step + 本报告）
- 执行模式：全部连续执行（`00-index.md` 的 `执行模式：全部`）
- 规模：**31 条提交**、配置 `CONFIG_VERSION` **12 → 15**（三条迁移 v12→v13→v14→v15）

## 每一步做了什么（一行一条）

| step | 内容 | 结果 |
|---|---|---|
| 1 | 项目机制（`projects` 分组）+ 项目级 `AGENTS.md` 逐层收集与「项目约定」注入（配置 v13） | done |
| 2 | 三档权限 `agent.permissionMode ∈ {readonly, confirm, auto}` + 项目根 realpath 前缀边界 | done |
| 3 | 写前自动快照（`agent.snapshots.*`，v14）+ 一键回滚（回滚本身也留快照） | done |
| 4 | Task/Job 持久化与可续跑（`agent.loop.*`，v15）+ 顺带修掉会话/待办清单的首读竞态 | done |
| 5 | 端到端集成验证（六条跨特性断言 + 两次启动续跑）与文档收口 | done |
| 6 | 归档（本步） | done |

## 验证结果（真实命令与数字）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` | 全部 exit 0（CI 顺序 `format:check → lint → typecheck → test → build` 复跑同样全绿） |
| `pnpm test` | **79 文件 / 1496 用例全绿**（起点 72 文件 / 1307 用例，净增 189 条；**无下降**） |
| `pnpm verify` | **26/26**（`version = 15`、`v0 → 当前版本` 15 条迁移） |
| `AURORA_SMOKE=1 pnpm dev` | **163/163 passed，exit 0**（step 2 的只读档注册集合 / step 3 的快照四条 / step 4 的 Job 四条 / step 5 的六条跨特性断言） |
| 两次启动续跑（`AURORA_SMOKE_WORKSPACE` 固定工作区 + `AURORA_SMOKE_PHASE=resume`） | **3/3 passed**：`status=paused → done`、`stepsDone 2→3`、`cursor 2→3`、会话里那条用户消息 `1→1` |
| `AURORA_CAPTURE=$env:TEMP\aurora-capture-12 pnpm dev` | **53 张 PNG / 53 条 checks / 0 FAIL / exit 0**（含 step 1–4 的四个新场景 + 综合图 `chat-agent-prod-overview.png`：项目卡 / 快照卡 / 任务卡同时在场） |

## 交付能力（用户可见）

- **项目机制**：设置页「项目」区组 + 右栏「当前项目」卡；项目根决定项目级约定注入与安全边界。
- **三档权限**：对话窗下拉 + 设置页单选；`readonly` 档不注册 5 个电脑操控工具与 `todo_write`；`auto` 档项目根内免确认；确认卡新增第三键「本会话都允许」。
- **写前快照与回滚**：`write_file` / `edit_file` 落盘前留底（每文件环形 20 份 + 目录预算 200 MiB），右栏「文件备份」卡两段式回滚。
- **Task/Job 续跑**：右栏「任务」面板（轮次 / token / 步骤 / 待办 / 暂停原因）+ 左栏入口；轮次或预算用尽落 `paused` 并说明原因；**重启后可接着跑**，不重复落盘用户消息；`agent.loop.*` 三个上限可配且热改生效。

## 独立审查结论与处置

共派 **3 个只读审查子代理**（宽口径 8 问 / 三个最高风险问题收窄版 / 单点软链问题版），三份报告均到达。
结论：**端到端证据是真的**（审查者独立核到 `SUMMARY 163/163`、两次启动 `3/3`、capture 53/53/0 fail），
**但有三条 P0 说明"文档承诺 > 实现"**：

1. **自动续轮的 attempt≥2 丢失全部上下文**（`agentHost.ts:478-501` / `:533` / `:720`）：请求体退化成 `[system]`，
   模型看不到提问与上一轮工具结果，可能重跑副作用工具。审查者运行时复现
   （`attempt 1: [system,user]` → `attempt 2/3: [system]`），且当前**零覆盖**（smoke 五处都把
   `autoContinueRounds` 设为 0）。默认 `autoContinueRounds = 2`，影响面不小。
2. **`agent.loop.*` / `agent.snapshots.*` 其实 AI 可写**（`canWriteSettingPath` 七个字段全 `true`），
   而 `AGENTS.md` / `schema.ts` / `docs/08` 四处写"AI 默认改不动" —— 承诺与实现相反。
3. **`effectiveWorkspaceDir()` 从未接线**（step 1/2 都写明"由 step 2 消费"）：配置项目后缺省 cwd / 搜索根
   仍在项目根之外 → auto 档下无 cwd 的 `run_command` 免确认在**用户主目录**执行；confirm 档同类命令一律失败；
   `grep` / `glob` 缺省搜索必然越界报错。

另有 10 条 P1（回滚不过项目根边界、`run_command` 相对跳转不被拦、崩溃后 `running` job 无接管、
readonly 下 `notify_user` 仍会弹通知、续跑在界面多一条用户气泡、根不存在时边界静默 fail-open、
快照无 `pinned` 保护、轮中 abort 整轮重跑、`docs/08` 版本号仍是 13、`enforceWorkspace` 是"不存在的开关"）。

**主代理自查的一条误判已更正**：曾把"根内符号链接可绕过边界"记为真实缺口 —— **不成立**，
`fs.realpath` 会穿透 symlink/junction，仓库里本来就有该用例（`file-port.test.ts:992-1034`，
审查者本机实跑 59 passed 无 skip）。这条在 step-05 记录里保留了撤销痕迹。

**处置**：用户决定「先归档，这些修复另开一轮」。因此**本轮不修**上述任何一条，全部带行号与建议修法
写入 `step-05-verify-integrate.md` 的「独立审查」一节，并在下一轮的 step 计划里按 P0 → P1 排序。

## 遗留问题（下一轮起点）

**P0（优先）**：自动续轮上下文丢失 / 配置可写性与文档承诺相反（二选一：改代码或改文档）/
`effectiveWorkspaceDir` 未接线。

**P1**：回滚补边界校验 + `before.skipped` 判定与"当前内容已变"文案；`containsAbsolutePath` 补相对 `..`；
启动期回收 `running` job；readonly 档把有系统副作用的工具真正摘掉（`notify_user` / `classisland_remind` /
`clipboard_write` / `generate_image` / `set_setting` / MCP）；续跑不再多一条用户气泡；根不可用时 fail-closed；
快照 `pinned` 保护；`docs/08` 版本号 13 → 15。

**P2 / 已知限制（不阻塞）**：`snapshots:prune` 无界面入口、右栏「文件备份」卡不按会话过滤（渲染层拿不到
当前会话 id）、渲染层缺单测（只有 capture 探针覆盖）、`chat-tool-card-open` / `chat-stream-burst`
两条 perf 探针在帧饥饿环境偶发红、`pnpm format:check` 对 Markdown 是空过（`.prettierignore` 里有 `*.md`）。

**计划外的第二批（本计划不做）**：多模态输入 + Responses API、子代理能力对齐 Codex、上下文压缩修正。

## commit 列表（31 条，`git log --oneline afd23827..HEAD`）

- 计划入库：`48f669f`
- step 1（8）：`a12ea47` 配置 v13 · `1ca2912` 项目机制 · `221db99` 项目 IPC · `ff57d80` 渲染层 · `0c7abee` capture 探针 · `5245d87` 文档 · `bd80fac` 回填 · （该步另含 1 条文档补齐）
- step 2（5）：`e9ed4e1` 三档判定 · `12dca39` allowOutside 与子代理收窄 · `cf013ff` 边界与只读门控 · `c274838` 三档界面与文档 · `62bcbd2` 回填
- step 3（6）：`5bf3849` 配置 v14 · `0eb2f1f` 快照端口 · `bd9bad5` 写盘钩子与回滚 · `30ef046` 右栏卡与设置页 · `48e5169` 文档 · `6300b13` 回填
- step 4（6）：`681b705` 首读竞态 · `aad5c06` 配置 v15 · `2e49525` Job 与自动续轮 · `39d10ac` 任务面板与探针 · `ee2196d` 文档 · `fea0470` 回填
- step 5（5）：`484872a` 跨特性断言与两次启动验证 · `cd81b65` 文档收口与陈旧锚点 · `f5744d3` 回填 · `5ebc770` 索引状态补齐 · `4950c1c` 并入独立审查结论
- step 6：归档提交（见 `git log`）

提交信息全部为 Conventional Commits 中文描述，一个功能 / 修复一个 commit。
