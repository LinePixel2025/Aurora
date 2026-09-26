# Step 05 — 端到端集成验证与文档收口

- Task: agent-prod-mainline
- Step: 5 / 6
- Status: done
- Depends on: step 1, step 2, step 3, step 4
- Produces: 全量验证结果（typecheck / test / lint / build / smoke / capture）、跨特性端到端综合断言、文档收口（README / roadmap / AGENTS.md）、陈旧文档锚点修正、独立审查结论
- Phase: 测试与文档
- Writes: `apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/capture.ts`、`docs/README.md`、`docs/04-roadmap.md`、`AGENTS.md`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`apps/desktop/src/renderer/chat/components/SubagentPage.vue`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`packages/shared/src/ipc/types.ts`
- Risk: ①本步只做"整合 + 收口"，**不要顺手改功能** —— 发现功能缺陷要回到对应 step 修（或在本步记成遗留问题并说明），否则验收对象就变了；②smoke/capture 的断言容易写成"自证"（只断言自己刚写入的东西）—— 每条断言都必须能回答"如果这个特性坏了，它会失败吗"；③`docs/04-roadmap.md` 的变更记录本轮只有一条（防止四条并行条目改乱），只写一次。
- Sources: 本轮所有外部结论的汇总出处见 `step/00-index.md` 的「现状与关键结论」第 13 条与各 step 的 `Sources` 字段（Codex Windows 沙箱实现、Claude Code 权限模式、Codex 配置参考；访问日期 2026-09-26）。本步不引入新外部事实。

## 目标

在真实 Electron 环境里证明四件事串起来是通的：**选项目 → 设三档权限 → Agent 写文件（留快照）→ 长任务被暂停 → 重启后续跑完 → 一键回滚**。同时把文档与仓库约定更新到与实现一致，并清理本仓库已知的陈旧锚点。

## 输入

- 前四步的产出与各自的 smoke/capture 断言（step 2：权限三档；step 3：快照与回滚；step 4：job 与续跑）。
- 全量验证命令（本轮实测口径）：`pnpm typecheck`（4 个项目）、`pnpm test`（改动前 72 文件 / 1307 用例）、`pnpm lint`、`pnpm build`；端到端 `AURORA_SMOKE=1 pnpm dev`（结果看 `%TEMP%\aurora-smoke-logs` 的 `AURORA_SMOKE_RESULT`）、`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-05"; pnpm dev`（结果看 `report.json`，张数与场景以实测条目为准，**不要按固定张数校验**）。
- 文档收口位置：`docs/README.md`（当前实现状态段落，`v0.1.4` 那一段之后要新增本轮；`docs/README.md:8-14` 是状态行、`:16-31` 是 v0.6.0 段、`~:275-320` 是最近几轮的段落与"仍待做"清单）、`docs/04-roadmap.md`（变更记录追加在文件末尾，当前最后一条在 `:357-395`）、`AGENTS.md`（"尚未生效 / 已知限制"与"几个容易踩的接线点"两节）。
- 陈旧锚点（本仓库已知文档债，多个源文件与文档写 `docs/07 §2.4`，但 `docs/07-ui-spec.md` 在 `:73` §2.3 之后的下一个标题是 `:286` 的「输入框规格」，`:391` 才是 §2.5）：**实测的 5 处**是 `apps/desktop/src/renderer/chat/components/SubagentPage.vue:3`、`apps/desktop/src/main/capture.ts:593`、`apps/desktop/src/renderer/chat/App.vue:88`、`apps/desktop/src/renderer/chat/App.vue:1107`、`packages/shared/src/ipc/types.ts:628`（`useChat.ts` **不含** §2.4，不要把它列进去）。本步把子代理页并入 `§2.3` 的子节编号（或补建 `§2.4`），并同步这 5 处引用。
- smoke/capture 的既有口径：事件类型白名单 `smoke.ts:552`（本轮新增了 job 事件 → 白名单要同步，否则会直接 FAIL）；capture 场景注册顺序约束（`chat-collapse` 必须最后，`capture.ts:4690` 注释）；探针是 template literal，**字符串内部注释不能用反引号**。

## 操作

1. **跑一遍完整门禁并记录原始输出**（不改代码）：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm build`；四条命令的退出码、用例数、耗时都写进「执行记录」。任何一条失败 → 停下，回到对应 step 修，修完从本步开头重跑。
2. **跨特性端到端断言（写进 `apps/desktop/src/main/smoke.ts` 的新 describe）**，依次：
   - ① 建一个临时项目目录并在里面放一份 `AGENTS.md`，把它设为当前项目（`settings:update`）→ 发一轮对话 → 断言桩服务收到的请求体里有该项目 `AGENTS.md` 的内容，且**另一份只放在项目外的 `AGENTS.md` 内容没有出现**。
   - ② 切到 `auto` 档 → 让 Agent 在项目根内写一个文件 → 断言：**没有**弹确认卡片、文件真的落盘、`backups/<sid>/` 下有对应快照。
   - ③ 切到 `readonly` 档 → 发"请写文件"→ 断言事件里**不出现** `write_file` / `run_command`（工具不在清单），且磁盘文件未被改动。
   - ④ `maxRounds=2` + `autoContinueRounds=0` 触发 job `paused` → 「重启」（smoke 的两次启动机制）→ `chat:resumeJob` → 断言 job 终态 `done`、`stepsDone` 数量增加、会话里那条用户消息**只有一条**、`cursor.nextRound` 单调递增。
   - ⑤ 对 ②里写过的文件调 `snapshots:restore` → 断言磁盘内容回到写入前，且新增一条 `origin:'rollback'` 的快照。
   - ⑥ 断言 `smoke.ts:552` 的事件白名单已含本轮新增的事件类型（`job`），且未放宽到"任意类型"。
3. **capture 场景收口**：确认 step 1–4 新增的场景（`chat-project-card` / `chat-permission-readonly` / `chat-snapshot-card` / `chat-job-panel`）都在 `report.json` 里出现且 `ok: true`；新增一张综合图 `chat-agent-prod-overview.png`（右栏同时有"当前项目 + 文件备份 + 任务"三张卡，用于人工核对布局不冲突）；settings 页的 `projects.*` / `agent.permissionMode` / `agent.snapshots.*` / `agent.loop.*` 字段探针全部通过。**不要写死张数**。
   - ⚠️ **`SETTINGS_AGENT_FIELDS_SCRIPT`（`capture.ts:2647-2717`）的 `unexpected` 是白名单式的 `data-empty` 过滤器**：新增配置分组若在默认态渲染出 `data-empty`，而且名字不在白名单里，探针会**直接 FAIL**。本步要核对四个新分组（`projects.*` / `agent.permissionMode` / `agent.snapshots.*` / `agent.loop.*`）实际产生了哪些 `data-empty`，把它们按需加进白名单或让控件常显（字段探针的既有口径是"条件不成立时控件不在 DOM、原位换 `data-empty`"，见 `docs/08:572-573`）。
4. **文档收口**：
   - `docs/06-agent-core.md`：确认 §4.1 / §5 / §5.1 / §11.2 / §11.8 / §12.2 / §17 / §18 各处口径一致（尤其"权限三档与 `confirmSensitiveTools` 的优先级"与"job 续跑不重复落用户消息"必须两处一致：§4.1 与 §5）。
   - `docs/07-ui-spec.md`：补齐新增锚点清单（`chat.permission-mode-readonly`、`chat.snapshot-card`、`chat.jobs`、`chat.project-card`），修正 `§2.4` 陈旧引用（含第 5 步输入里列的 5 处源文件）。
   - `docs/README.md`：新增本轮段落（四项能力 + 配置版本 v15 + 验证结论），并把"仍待做"清单同步（去掉已完成的项，保留 Code Mode / 多模态 / 子代理加强 / 上下文压缩 / OS 沙箱）。
   - `docs/04-roadmap.md`：在末尾追加**一条**变更记录（包含四项能力、配置 v13→v15、验证数字、明确未做的部分）。
   - `AGENTS.md`：更新"尚未生效 / 已知限制"（`workspaceDir 不是沙箱` 那条要改成"三档权限 + 项目根前缀校验已落地，但仍无 OS 级沙箱"）、补"几个容易踩的接线点"里的新坑（快照钩子在 `writeText` 内、`ensureLoaded` 竞态已修、`agent.permissionMode` 是只读前缀、`agent.loop.maxRounds` 以 getter 注入才能热改）。
5. **独立审查（推荐做，不做要说明原因）**：派一个**只读**子代理，只给它「用户原话 + 本计划 + 最终 diff（`git diff <基线>..HEAD`）」，让它对抗性挑毛病：哪些验收是自证、哪条要求没兑现、有没有把"注册后拒绝"当成"不注册"、快照淘汰是否有漏洞、续跑是否会重复副作用、文档与代码是否仍不一致。把结论与处置写进「执行记录」；**审查者不改代码**。
6. **交付清单**：把本轮的 commit 列表（`git log --oneline <基线>..HEAD`）与每条对应的 step 写进「执行记录」，并确认每个 commit 是"一个功能一个 commit"、提交信息是 Conventional Commits 中文。

## 验收标准

- [ ] `pnpm typecheck` 退出码 0，输出显示 4 个项目全 Done。
- [ ] `pnpm test` 退出码 0，且报告的用例数 ≥ 1307 + 本轮新增（新增用例数写进执行记录；**不允许用例数下降**，下降说明有测试被删或没被收集）。
- [ ] `pnpm format:check`、`pnpm lint`、`pnpm build` 退出码 0（**CI 的顺序是 `format:check → lint → typecheck → test → build`**，见 `.github/workflows/ci.yml:51-66`）；`pnpm verify` 退出码 0（它断言 `fresh.version === CONFIG_VERSION` 与 `appliedMigrations.length === CONFIG_VERSION`，本轮把 `CONFIG_VERSION` 从 12 推到 15，必须复跑）。
- [ ] `AURORA_SMOKE=1 pnpm dev` 结束后 `%TEMP%\aurora-smoke-logs` 的 `AURORA_SMOKE_RESULT` 全通过，且六条跨特性断言（①–⑥）都在日志里逐条可见。
- [ ] 两次启动的续跑证据齐备：第一次启动后 `%APPDATA%\Aurora\jobs\<sid>.json` 的 `status === 'paused'`；第二次启动并 `chat:resumeJob` 后同一文件 `status === 'done'` 且 `stepsDone.length` 增加；会话文件里该用户消息出现次数为 1（用 `Select-String -Path <sessions>\<sid>.json -Pattern <文本> -AllMatches` 数出现次数）。
- [ ] `AURORA_CAPTURE="$env:TEMP\aurora-capture-05" pnpm dev` 退出码 0，`report.json` 的 `checks` 全部 `ok: true`（0 FAIL），且含 step 1–4 的四个新场景 + `chat-agent-prod-overview.png`。
- [ ] 回滚证据：对同一文件 `snapshots:restore` 后文件内容与快照一致，且 `backups/<sid>/index.json` 里新增一条 `origin: 'rollback'`（用 `Get-Content` + `Select-String` 复核）。
- [ ] `grep -rn "docs/07 §2.4\|docs/07-ui-spec.md §2.4" --include=*.ts --include=*.vue --include=*.md .` 在 `apps/`、`packages/`、`docs/`、`AGENTS.md` 里**零命中**（陈旧锚点已清）。
- [ ] `docs/README.md` / `docs/04-roadmap.md` / `AGENTS.md` 三处都已更新：`git diff --stat <基线>..HEAD -- docs/README.md docs/04-roadmap.md AGENTS.md` 显示三个文件都有改动。
- [ ] 独立审查结论已写进「执行记录」（若未做，写明原因）。

## 交接

- 归档步骤（step 6）会在全部 Status=done 后把 `step/*.md` 整体移入 `step/archive/<YYYYMMDD-HHMMSS>-agent-prod-mainline/`。
- 第二批（多模态 + Responses API、子代理对齐 Codex、上下文压缩修正）**不在本计划内**：本步结束时若还有余力，只在 `docs/04-roadmap.md` 的"仍待做"里登记，**不要**顺手改代码。

## 执行记录

执行时间：2026-09-26（本会话）。执行模式：全部连续执行。依赖 step 1–4（均 done）。

### 1. 全量门禁的原始结论（未改代码，先跑门禁）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0，4 个项目全 Done（shared / agent-core / modes / desktop） |
| `pnpm test` | exit 0，**79 文件 / 1496 用例全绿**（改动前的基线是 72 文件 / 1307 用例 → 净增 189 条） |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | exit 0（⚠️ 见下方"过程问题 5"：`.prettierignore` 里有 `*.md`，这条对文档是**空过**） |
| `pnpm build` | exit 0（三个包 + Electron 产物） |
| `pnpm verify` | exit 0，**26/26 项通过**（`version = 15`、`v0 → 当前版本` 15 条迁移） |

按 CI 顺序（`format:check → lint → typecheck → test → build`）复跑同样全绿。

### 2. 六条跨特性端到端断言（`AURORA_SMOKE=1 pnpm dev` → **163/163 passed，exit 0**）

写在 `apps/desktop/src/main/index.ts` 的 `runSmokeTest` 2.6/2.7 块（**计划说写进 `smoke.ts` 的新 describe，
但 `smoke.ts` 是渲染层脚本字符串模块、拿不到桩请求体与 job 存储，实际写在主进程断言块里**，见「与计划的偏差」1）。

| # | 断言 | 结果 |
|---|---|---|
| ① | 项目根的 `AGENTS.md` 进了请求体、**项目根父目录**的没进（收集边界） | PASS，`scope=true` |
| ② | `auto` 档根内写文件：**不弹确认卡** + 内容真的落盘 + 留下快照 | PASS，`auto=true` |
| ③ | `readonly` 档同一条提问写不动文件（工具不在清单，内容一字未变） | PASS，`readonly=true` |
| ④ | job `paused` → 重启 → 续跑（见下节） | PASS（第二次启动 3/3） |
| ⑤ | 一键回滚把内容还原，且新增一条 `origin:'rollback'` 的快照 | PASS，`rollback=true` |
| ⑥ | 事件类型白名单含本轮新增的 `job`，且没放宽到"任意类型" | PASS，`events=[queued,user-message,job,tool,text,usage,done] unknown=[]` |

**"如果这个特性坏了它会失败吗"自查**：①的负对照是"父目录标记必须**不**出现"（收集范围一破就红）；
②是"没弹卡"+"内容真的写进去了"+"快照条数增加"三条合取（任何一条假成都过不了）；
③是"内容一字未变"（只读档若漏注册写工具，文件会被改写）；⑤是"内容还原"+"新增 rollback 快照"；
⑥断言的是 `seenTypes ⊆ 白名单` 且 `job ∈ seenTypes`（白名单放宽成"任意类型"时第一条恒真，所以补了 `job ∈ seenTypes` 这一半）。

### 3. 两次启动的续跑证据（本步新增的能力）

计划里假设 smoke 有"两次启动机制"，**实际没有**（每次运行都是全新临时 userData 且退出即删）。
本步补上两个**仅自测用**的开关（不影响用户路径）：

- `AURORA_SMOKE_WORKSPACE=<目录>`：把自测工作区固定到指定目录，且**退出时不删**；
- `AURORA_SMOKE_PHASE=resume`：第二次启动只跑"重启续跑"那一段（其余断言的对象是"首次启动的全新现场"，
  在同一工作区上重跑必然红 —— 那不是缺陷，是断言写错了对象）。

两步的命令与观测（PowerShell）：

```powershell
$ws = Join-Path $env:TEMP 'aurora-two-launch-4'
$env:AURORA_SMOKE='1'; $env:AURORA_SMOKE_WORKSPACE=$ws; $env:AURORA_SMOKE_PHASE=''
pnpm dev        # 第一次：163/163；2.7 块留下一条 paused 的 job（带落盘自检 file=yes）
Get-ChildItem "$ws\jobs"        # → 10 个 job 文件，含 smoke-job-restart.json（paused、cursor=2、steps=2）
$env:AURORA_SMOKE_PHASE='resume'
pnpm dev        # 第二次：3/3 passed，exit 0
```

第二次启动的原始输出：

```
PASS 重启①：上一次启动留下的 paused job 仍能读回（游标与已完成步骤都在）
     — found=1 status=paused → status=done steps=2→3 cursor=2→3 users=1→1
PASS 重启②：chat:resumeJob 之后这条 job 跑到 done，且已完成步骤增加
PASS 重启③：游标单调不减，且会话文件里那条用户消息**仍然只有一条**
SUMMARY 3/3 passed
```

`status=paused → done`、`stepsDone 2→3`、`cursor 2→3`、用户消息 `1→1` —— 计划要求的四个观测点齐全。

### 4. capture 场景收口（`AURORA_CAPTURE=$env:TEMP\aurora-capture-12 pnpm dev`）

**53 张 PNG / 53 条 checks / 0 FAIL / exit 0**（不写死张数，以 `report.json` 条目为准）。step 1–4 的四个新场景全部在列且 `pass=true`：

| 场景 | 关键探针值 |
|---|---|
| `chat-project-card.png` | 项目卡恰好一张、含项目名与根目录、非警示态 |
| `chat-permission-readonly.png` | `permissionMode: readonly` + 文案「只读」+ 收尾还原「变更前确认」 |
| `chat-snapshot-card.png` | `card:1, rows:1`、来源「写文件」、按钮停在「确认回滚？」 |
| `chat-job-panel.png` | `panel:1, items:1, resumeLabel:"继续"`、文本含「已暂停」「轮次上限」「token 1284 / 不限」 |
| `chat-agent-prod-overview.png`（本步新增） | 项目卡 / 快照卡 / 任务卡**同时**各 1 张、任务卡显示真内容（`pass:true`） |
| `settings-agent.png` | `snapshotFields:4`、`loopFields:3`、`unexpected:[]` |

`data-empty` 白名单核对：四个新分组的默认态**都没有**产生 `data-empty`（`projects.list` / `agent.snapshots`
只在空态 / 关掉开关时出现，且都已进白名单），`unexpected` 为空数组 —— 计划里担心的"新分组撞 FAIL"没有发生。

### 5. 文档收口

| 文件 | 改动 |
|---|---|
| `docs/README.md` | 状态行（当前版本 + 四项能力总览）、新增本轮段落、重写「仍待做」清单（保留原措辞，去掉已完成项，加入 OS 级沙箱 / 多模态与 Responses API / 子代理加强 / 上下文压缩修正） |
| `docs/04-roadmap.md` | 末尾**追加唯一一条**变更记录（含四项能力、配置 v12→v15、验证数字、明确未做的部分）；顶部概览补一句指向它 |
| `AGENTS.md` | 「配置改动」补 `CONFIG_VERSION = 15`；已知限制加"三档权限已落地但仍无 OS 级沙箱"与"`workspaceDir` 不是安全边界"；接线点加四条（快照钩子顺序 / `ensureLoaded` 三处 in-flight / `permissionMode` 只读前缀 / `agent.loop` getter 注入）；目录树分册数 01–09 → 01–11 |
| `docs/06` / `docs/07` | 口径一致性核对（§4.1 / §5 / §5.1 / §11.2 / §11.8 / §12.2）与 `..` 判定的**两层**写法（`auto` 档字符串级判定 vs `resolveFilePath` realpath 判定） |

**陈旧锚点**：`docs/07 §2.4`（编号随"小 AI 交互窗"删除而移除）在**源码与文档里共 9 处**（计划只列了 5 处，
且 `useChat.ts` 那处本来就不存在）—— 统一改指 `§2.3`（子代理页面实际记在主界面小节）。
`grep -rn "docs/07 §2.4"` 在 `apps/`（排除 node_modules）、`packages/`、`docs/`、`AGENTS.md` 里**零命中**。

### 6. 交付清单（`git log --oneline afd23827..HEAD`，共 **27 条**）

| step | 提交 |
|---|---|
| 1 | `48f669f` 计划入库 → `a12ea47` 配置 v13 → `1ca2912` agent-core 项目机制 → `221db99` 项目 IPC 与装配 → `ff57d80` 渲染层项目 UI → `0c7abee` capture 探针 → `5245d87` 文档 → `bd80fac` 回填 |
| 2 | `e9ed4e1` 三档判定与「本会话都允许」 → `12dca39` allowOutside 与子代理收窄 → `cf013ff` 边界校验与只读门控 → `c274838` 三档界面与文档 → `62bcbd2` 回填 |
| 3 | `5bf3849` 配置 v14 → `0eb2f1f` 快照端口与工具透传 → `bd9bad5` 写盘钩子与回滚链路 → `30ef046` 右栏卡与设置页 → `48e5169` 文档 → `6300b13` 回填 |
| 4 | `681b705` 首读竞态修复 → `aad5c06` 配置 v15 → `2e49525` Job 持久化与自动续轮 → `39d10ac` 任务面板与探针 → `ee2196d` 文档 → `fea0470` 回填 |
| 5 | `484872a` 跨特性端到端断言与两次启动验证 → `cd81b65` 文档收口与陈旧锚点修正 →（本条回填） |

全部为 Conventional Commits 中文描述，一个功能/修复一个 commit；提交与 `step/` 文件的对应关系即上表。

### 独立审查结论与处置

**独立审查做了，而且是三份**（本步共派了 3 个只读审查子代理：宽口径 8 问、三个最高风险问题收窄版、
单点软链问题版）。三份回报都**迟到**——主代理在归档前先等到 1 份、另 2 份在之后才到，
期间曾一度按"失联即未完成"记录，此处以**三份全部到达后的实际结论**为准。

三份结论一致的部分（各自独立复核）：**四步能力的端到端证据是真的**（审查者在
`%TEMP%\aurora-smoke-logs\aurora-2026-09-26.log` 里独立核到 `SUMMARY 163/163`、两次启动续跑
`status=paused → done steps=2→3 cursor=2→3 users=1→1`；`aurora-capture-12\report.json` 53/53/0 fail），
**但有三条 P0 说明"文档承诺 > 实现"**。

#### P0-1 自动续轮的第二次 attempt **丢失全部上下文**（最严重，实机复现）

- `packages/agent-core/src/host/agentHost.ts:478-501`：`history`（`compression.messages`）在
  `for(;;)` 循环**之外**只取一次；`:533` 首次判断 `appendUserMessage = input.resumeJob === undefined`，
  `:720` 自动续轮时置 `false`。于是第二轮 attempt：**既不 append、也不 push 用户消息**（
  `agentLoop.ts:194-201`），拿到的又是请求开始时的旧 history —— 请求体退化成 `[system]`。
- 审查者的运行时复现（内存 FileSystemPort + 假 provider，`maxRounds=1` / `autoContinueRounds=2`）：
  `attempt 1: count=2 roles=[system,user]` / `attempt 2: count=1 roles=[system]` / `attempt 3: 同上`。
- 影响：默认 `autoContinueRounds = 2`，**任何跑满轮次的任务都会再发两次"没有提问、没有工具结果"的请求**；
  模型看不到自己上一轮干了什么，最可能把写文件 / 跑命令**再做一遍**（重复副作用）。
  `docs/06 §4.1` 却写它"等价于一次自动 resume"，属于承诺不实。
- **当前零覆盖**：`agentHost.test.ts` 的自动续轮用例只断言计数 / 游标 / 落盘消息数；
  本步 smoke 的五个块都把 `autoContinueRounds` 设为 0 —— 所以 163/163 全绿也照不到这条。
- 建议修法：每个 attempt 重新取 history（或在 attempt 之间把已产生的助手 / 工具消息并进下一次的 messages），
  并补一条"第二次 attempt 的请求体含用户消息与上一轮工具结果"的断言。

#### P0-2 `agent.loop.*` / `agent.snapshots.*` **其实 AI 改得动**（"AI 不可写"是假的）

- 审查者用 `canWriteSettingPath` 实测：`agent.loop.maxRounds|maxTotalTokens|autoContinueRounds` 与
  `agent.snapshots.enabled|keepPerFile|maxSnapshotBytes|totalBudgetBytes` **七个字段全部 `true`**
  （对照：`agent.permissionMode` / `projects.*` 为 `false`，这两个是对的）。
- 机制：`packages/shared/src/config/schema.ts:766-791` 的判定顺序是「可写覆盖表放行 → 只读前缀拒绝 →
  否则只要 Schema 认识就放行」，而这两个分组既不在 `SETTINGS_READONLY_PREFIXES` 也不在
  `WRITABLE_PATH_OVERRIDES`。
- 影响：AI 能给自己放大轮次 / token 预算（正是本轮要防的"绕过该停下来问用户"），
  也能在写文件前把 `agent.snapshots.enabled` 关掉、拆掉回滚兜底。虽然 `set_setting` 是 confirm 级
  （不是静默），但 `AGENTS.md` / `schema.ts` / `docs/08` **四处**都写着"AI 默认改不动" —— 承诺不成立。
- 建议修法：把两组加进 `SETTINGS_READONLY_PREFIXES` + `READONLY_PREFIX_REASONS`（与
  `agent.permissionMode` 同款），或改文档承认可写。**二者必须选一个，不能让文档与代码相反。**

#### P0-3 `effectiveWorkspaceDir()` 从未接线 → 缺省 cwd / 搜索根在项目根之外

- 生产代码里零消费（只有 `index.ts` 再导出 + 自测）：`apps/desktop/src/main/tools/index.ts:153` 仍是
  `workspaceDir || homeDir`；`agent-host.ts:365-375` 把"没给 cwd"当成根内；`terminal.ts:108` 的
  `defaultCwd` 由装配层给了 `process.cwd()`（`index.ts:679`）。
- 后果（默认配置：有项目 + `workspaceDir` 为空 + 不给 cwd）：(a) auto 档把"没有 cwd"判成根内 →
  免确认 → `approvedByUser` → `allowOutside: true` → 命令**在用户主目录里无确认执行**；
  (b) confirm 档下同类命令一律回"cwd 在项目根之外，本次命令未执行"（功能不可用）；
  (c) `grep` / `glob` 缺省搜索根同为主目录且是 `safe` 级（永远拿不到放行位）→ **缺省搜索必然越界报错**；
  (d) 模型侧拿不到项目根的绝对路径，补不出根内路径 —— 全新会话里四件能力难以串起来
  （smoke 全绿是因为自测直接喂绝对路径）。
- 这是 **step 1 / step 2 的接线缺口**（`step-01` 与 `step-02` 都写明"由 step 2 消费"），不是 step 5 引入的。
- 建议修法：接线 `effectiveWorkspaceDir`（缺省 cwd / 搜索根）并在系统提示词的「项目约定」里带上项目根绝对路径。

#### 对主代理自查结论的**更正**（重要）

- 主代理在"独立审查未完成"阶段自查出的 **P1-1「项目根内的符号链接可绕过边界」不成立**：
  `canonicalize`（`file-port.ts:217-233`）对"第一个真实存在的祖先"做 `fs.realpath`，而 Windows 的
  realpath **会穿透 symlink 与 junction**，再把不存在的尾部拼回去判定 —— 所以"目标自身是链接"与
  "目标在联接目录里"两种情形都会被判越界。仓库里本来就有这条用例
  （`file-port.test.ts:992-1034`，junction 兜底），审查者本机实跑该文件 **59 passed、无 skip**。
  **本条按误记撤销**（执行记录里保留撤销痕迹，避免后来者当成真缺口去"修"）。
- 主代理自查出的 **P1-2（`exists:false` 回滚会无条件删除该路径）成立**，但两位审查者都指出
  缓解比自查描述的更多：回滚前会先 `capture` 一份 `origin:'rollback'`（`ipc.ts:900-904`，内容可再撤回）
  + 两段式确认 + 行内标注「当时不存在」。**严重度下调为 P2**，真缺口是"当前内容已变"的判定与文案。

#### 其余 P1（三份报告的并集，去重后）

| # | 结论 | 位置 |
|---|---|---|
| P1-1 | `restoreSnapshot` **完全没过项目根边界**（直接 `rm` / `writeFile`），而该函数注释与 `docs/06 §11.8` 都写"回滚路径同样过边界校验" | `main/ipc.ts:887` vs `:899-914` |
| P1-2 | `run_command` 命令串里的**相对跳转**（`cd ..\..`）两层都不拦：`containsAbsolutePath` 只认盘符 / `\\` / 前导分隔符 | `main/agent-host.ts:384-390`、`tools/command-runner.ts:91-116` |
| P1-3 | 崩溃 / 强杀后 job 永久停在 `running`：`send({resumeJobId})` 只接受 `paused`，**没有启动期回收**，`docs/06 §4.1` 承诺的"最坏只重跑最后一轮"无实现路径 | `agentHost.ts:275`、`main/index.ts` |
| P1-4 | readonly 档仍是"注册后拒绝"的一批：`set_setting` / 全部 `mcp.*` / `clipboard_write` / `generate_image`；而 `notify_user` / `classisland_remind` 是 `safe` 级 → **readonly 下仍会弹系统通知** | `main/tools/index.ts:158-209`、`registry.ts:73` 的 5 个注册入口 |
| P1-5 | 续跑会在聊天界面**多出一条用户气泡**（内核每次 run 都广播 `user-message`，渲染层只按"30 秒内同文本"去重；暂停任务几乎必然超 30 秒） | `agentHost.ts:411-417`、`useChat.ts:269-301` |
| P1-6 | 根"配了但目录不存在"时硬边界**静默 fail-open**（只记 warn，界面仍显示项目已配置） | `file-port.ts:190-205` |
| P1-7 | 快照**没有任何"保护某一份"的机制**（无 `pinned` 字段），回滚自身产生的快照也参与淘汰 | `snapshot-port.ts:556-611` |
| P1-8 | 轮中 abort → 续跑**整轮重跑**（`onRoundComplete` 未执行，游标停在本轮），已成功执行的工具会再跑一遍 | `agentLoop.ts:307-311` vs `:350-357` |
| P1-9 | `docs/08` 的 SSOT 示例仍写 `"version": 13` 与 `## 1. 配置 Schema（config.json，v13）` | `docs/08:5,9` |
| P1-10 | `enforceWorkspace` 生产从未接线（"限制在项目内"这个开关**不存在**），但注释里写它会生效 | `file-port.ts:102,113` |

#### P2 / 观察（择要）

`jobs/store.ts` 的 `listResumable()` 生产零消费；"未保存快照：…"只在工具 `content` 而不在 `summary`
（卡片第一眼看不到降级）；手动续跑的 token 预算每次都从 0 重新起算（`maxTotalTokens` 对**手动**续跑
不构成硬上限，文档未写这条差异）；强杀在工具轮中途会留下"带 toolCalls 但无 tool 结果"的 assistant 消息
（既有问题）；本步验收⑥按字面未兑现（`smoke.ts:552` 是 round 事件过滤，真正的白名单是
`index.ts` 里的局部字面量，主代理已在「与计划的偏差 7」如实纠正）。

#### 处置（按用户决定）

用户已决定：**先归档，这些修复另开一轮**。因此本步**不修**以上任何一条，
它们全部作为**带行号与建议修法的遗留项**写进本记录与归档里的 `REPORT.md`，
并在下一轮的 step 计划里按 P0 → P1 排序。三份审查报告的可重跑方式：
`pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts`（59 passed）、
`node --input-type=module -e "import {canWriteSettingPath} from './packages/shared/dist/index.js'; console.log(canWriteSettingPath('agent.loop.maxRounds'))"`（`true` 即复现 P0-2）、
以及用内存 `FileSystemPort` + 假 provider 记录 `req.messages` 复现自动续轮（P0-1）。

### 过程中的问题与处置

1. **第二次启动读不到 job（本步最大的坑，已修）**：`runSmokeTest` 的收尾无条件 `rm -rf` 自测工作区，
   而固定工作区正是第二次启动要读的 —— 症状是"第一次明明 `file=yes`，第二次 `found=0`"，
   而且因为是 `rm -rf` 与收尾写入抢时序，偶尔还能剩下几个文件（看起来像随机丢数据）。
   修法：两处删除（capture 与 smoke）都加 `pinnedSmokeWorkspace === undefined` 守卫，
   并在 2.7 块加**落盘自检**（`existsSync` 直接判文件在不在），让"没落盘"当场暴露而不是留到下一次启动。
2. **第二次启动没有可用模型（已修）**：第二次启动只跑续跑段，而起桩服务在第一次启动的准备段里
   —— 配置里指向的是上一个进程的死端口，续跑回 `E_NO_MODEL`，表现为"点了继续但什么都没发生"。
   修法：`runResumePhase` 自己起一个桩并把 `llm.providers.smoke` 重新指过去。
3. **"预算形同虚设"（step 4 发现、本步复验）**：桩服务只在最后一段纯文本回 `usage`，
   而预算判定发生在**工具轮结束**时 → 让桩在工具轮也带 `usage`（真实 provider 在 `include_usage` 下每轮都报）。
4. **capture 夹具时序**：任务面板挂载时就会读一次 `chat:jobs`，而 job 存储首读即缓存 ——
   夹具必须赶在**面板首读之前**（与 `seedChatTtsHistory` 同批），放进场景 `prepare` 里会显示「暂无任务」。
5. **`pnpm format:check` 对 Markdown 是空过**：`.prettierignore` 里有 `*.md`，prettier 连显式传入的 md
   也跳过（用故意写坏的临时 md 验证过）。本步的替代证据：`AGENTS.md` 与"默认 markdown prettier 输出"
   逐字节相同；README / roadmap 未追求这点（既有内容本就不是该风格，改动会制造大片无关 diff）。
   **这是本步如实记录的验证口径缺口**，不代表文档格式被检验过。
6. **一个 "paused job" 的两次观测不一致**（第一次跑出来的工作区里少几个 job 文件）：根因即第 1 条，
   已由守卫 + 自检钉死；现在两次运行都能稳定看到全部 10 个 job 文件。
7. **计划里的三处引用已过时**（`smoke.ts:552` 的"事件白名单"其实是 `round` 事件过滤；
   `docs/07 §2.4` 实测 9 处而非 5 处；"smoke 两次启动机制"并不存在）——
   本步按**实际情况**实现并在「与计划的偏差」里列明。

### 与计划的偏差

1. **六条跨特性断言写在 `apps/desktop/src/main/index.ts` 的 `runSmokeTest` 里**，而不是
   `apps/desktop/src/main/smoke.ts` 的"新 describe"：后者是**渲染层脚本字符串**模块
   （`smokeScript(stubBaseUrl, stubModel, watchDir)`），既拿不到桩服务记录的请求体，也拿不到
   job 存储与快照端口；写成渲染层脚本只能靠 IPC 间接断言，反而更弱。
2. **新增两个自测专用环境变量**（`AURORA_SMOKE_WORKSPACE` / `AURORA_SMOKE_PHASE`）与
   `smoke-llm.ts` 的 `AURORA_WRITE_FILE` 分流：计划假定的"两次启动机制"不存在，这是补上它的最小实现；
   两者都只在 `AURORA_SMOKE=1` + 开发态生效，不影响用户路径。
3. **`CapturePlanHooks.setProject` 钩子**（`capture.ts` 新增可选第三参）：综合概览场景需要"当前项目"在场，
   而 `capture.ts` 不碰 `SettingsStore` —— 由 `index.ts` 注入动作，保持分层。
4. **`docs/07 §2.4` 的处理选了"改引用"而不是"补建 §2.4"**：该编号是随窗口删除被移除的历史编号，
   文档开头明确写了"小节编号只增不重排"，重新启用一个已废弃编号会让读者以为小 AI 交互窗又回来了。
5. **`docs/README.md` 与 `docs/04-roadmap.md` 的顶部状态数字**（原写"配置 Schema → v12"）
   本步顺带更正为 v15 并指向新记录 —— 计划说"只追加不动上面"针对的是**变更记录**，状态摘要不属于变更记录，
   留着会与新增记录自相矛盾。

### 遗留问题

1. **自测专用开关未写进用户文档**（`AURORA_SMOKE_WORKSPACE` / `AURORA_SMOKE_PHASE` /
   `AURORA_WRITE_FILE`）：它们属测试基础设施，只在开发态生效；本轮在 `AGENTS.md` 的常用命令一节
   未展开（避免让"用户怎么用"的文档混进自测细节），但**代码注释里写清了**。下一轮若要给 CI 用，
   建议补进 `docs/09` 或 `AGENTS.md` 的自测小节。
2. **渲染层没有单测**（`apps/desktop/src/renderer` 下只有 `useChatDeltaBuffer` 一个测试文件）：
   本轮新增的 `JobPanel.vue` / `useSnapshots()` / 三档权限下拉都只有 capture 探针覆盖。
   整机探针能证明"渲染出来了、点了会变"，但证明不了边界分支（例如 `resumeJob` 失败路径）。
3. **step 3 的遗留仍在**：`snapshots:prune` 没有界面入口、右栏「文件备份」卡不按会话过滤
   （渲染层拿不到"当前会话 id"，它是 `useChat()` 里的局部 ref）。
4. **`chat-tool-card-open.png` / `chat-stream-burst` 两条 perf·时序探针**在帧饥饿环境下仍偶发红
   （step 1 起就记录在案，本轮未动）。本步验收用的是 `aurora-capture-12` 这次干净全量跑。
5. **`grep`/`glob` 的搜索根**在"无项目"时仍回落 `agent.tools.workspaceDir` 或用户主目录 ——
   这是 step 2 就确认过的既有口径（边界只在配置了项目时启用），不是本步引入的。
