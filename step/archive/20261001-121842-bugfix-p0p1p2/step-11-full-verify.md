# Step 11 — 全量验证收尾

- Task: bugfix-p0p1p2
- Step: 11 / 12
- Status: done
- Depends on: step 1..10
- Produces: 全套验收命令全绿的最终证据 + 39 条条目的提交覆盖清单
- Phase: 测试与文档
- Writes: 只读（验收 FAIL 时仅允许回对应 step 的 Writes 白名单内文件修复，并在执行记录注明归属）
- Size: S
- Risk: 并行波次里的各步只跑过各自范围的测试——本步是唯一一次全套检查；若有跨步集成问题，回对应 step 的文件修复并重跑

## 目标

全部 10 个工作步骤合入后，仓库整体处于全绿状态，且每条目标问题都有对应提交可追溯。

## 输入

- `step/00-index.md` 的「完成标准」三条与基线记录（typecheck 通过、111 文件 1921 用例全绿 @ 52ed64c）
- `step/step-01` 至 `step-10` 各文件头部的 Status 与「执行记录」（应全部为 done 且已填）
- 仓库根的 package.json scripts（typecheck / test / build / verify 的实际定义）

## 操作

1. 在仓库根顺序执行（每条退出码必须为 0）：
   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm verify
   ```
   注意：`pnpm verify` 依赖 build 产物，必须在 build 之后；CONFIG_VERSION 本计划未动，其版本与迁移条数断言应照旧通过。
2. 任何 FAIL：定位归属 step 的文件范围修复（改动属于哪个 step 的 Writes 就改哪里的文件），在本文件「执行记录」注明改动与归属，然后从第 1 条重跑。
3. 用 `git log --oneline` 汇总提交清单，**依据提交信息尾注的条目号**（见 `step/00-index.md` 的提交约定）逐条对照 39 个条目编号（P0-01、P1-01～P1-12、P2-01～P2-26），确认每条都有对应提交；发现无尾注或缺编号的提交，回对应 step 补正后重核。
4. 留痕项（非验收，不修改任何文件）：把审查报告顺带发现的两处 AGENTS.md 描述滞后（「SettingsStore.mutate 的 draft 是活对象」实为已是深拷贝；自动化 Normal Mode 操作组件「三件」实为已是五件）记入本文件「执行记录」——AGENTS.md 不在任何 step 的写范围内，由用户另行处理。

## 验收标准

- [ ] `pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全部退出码 0
- [ ] `git log --oneline` 的清单覆盖全部 39 个条目编号，与 00-index「完成标准」第二条一致
- [ ] `step/00-index.md` 的「完成标准」三条可逐条勾选

## 交接

- 本步全绿后，任务满足归档前置条件，进入 step-12 归档。
- 发版与 Center 服务器重新部署不在本计划内——如需发版，另起任务并基于「执行记录」里的行为变化清单（如 P2-10 免确认模式收紧）写 release notes。

## 执行记录

### 1. 四条验收命令（主代理实跑，仓库根顺序执行）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | **0** | 5 个包 + apps/desktop（tsc + vue-tsc）全部 Done |
| `pnpm test` | **0** | **115 文件 / 2050 用例全绿**（基线 111 文件 / 1921 用例） |
| `pnpm build` | **0** | 三个包 + Electron 主进程 / 渲染层产物构建成功 |
| `pnpm verify` | **0** | **26/26 项通过**（含 `config.version = 21` 与 `v0 → 当前版本` 迁移链 21/21） |

`CONFIG_VERSION` 未动，`verify` 的版本与迁移条数断言照旧通过。

### 2. 39 条条目覆盖（依提交信息尾注独立核验）

脚本按 `P0-01`、`P1-01..12`、`P2-01..26` 逐条 grep `52ed64c..HEAD` 的全部提交信息 → **39/39 全部有对应提交**；10 条工作步骤提交各带一行 `覆盖条目：(...)` 尾注。

### 3. 提交清单（16 条 = 10 条工作步骤 + 6 条审查修复）

工作步骤（每条尾注覆盖条目）：
`dfe64be`(P0-01,P1-02,P1-03,P2-14,P2-18) / `7e62dfb`(P1-08,P1-09,P1-10,P2-01,P2-02,P2-03) / `8ab8acb`(P1-11,P2-04,P2-05,P2-06) / `ba737e0`(P1-01,P1-06,P2-26) / `ef56d85`(P1-12,P2-07,P2-08) / `33ecede`(P1-04,P1-05,P2-09,P2-10,P2-11) / `c785313`(P2-12,P2-13,P2-15,P2-16,P2-17) / `01e9172`(P1-07) / `8649b76`(P2-23,P2-24,P2-25) / `e83f414`(P2-19,P2-20,P2-21,P2-22)

代码审查后的修复（6 条，见下）：
`9776ed1` 流式重试重置超时预算 / `c13da84` daily 跨进程幂等 / `cd03045` 免确认补齐分段符与语句构造 / `d323709` 会话摘要逐条隔离等四处 / `00e2ddc` MCP 凭据路径候选择优 / `dad4b38` chat 回落跳过 quick + 文档两处口径

### 4. 代码审查（4 路独立审查子代理，干净上下文，均只读）

按 diff 规模（71 文件 / +4778−298）分 4 个维度派出：① 正确性与验收逐条比对 + 测试质量；② 安全与边界；③ 并发 / 竞态 / 资源生命周期；④ 与项目约定一致性 + 文档同步。四路结论均为「**有条件可交付**」，共报 **4 条 P1 + 6 条 P2 + 若干 P3**。

**P1 与「本次改动引入的回归」已全部修掉并重新验收**（上面 6 条提交）：

1. **[P1] 流式重试复用已中止的 `RequestScope`** → 首次超时后所有重试都是死重试、还白睡 1.5s 退避。修法：外部 abort 转发与超时计时拆开，每 attempt `arm()` 一份新预算（`9776ed1`）。
2. **[P1] daily 错过补偿跨重启不幂等**（本次改动引入的回归：`>=` 取代 `===` 后，重启会让当天已跑过的 daily 再跑一次，Agent 模式重复消耗 token）→ 启动时从运行历史重建当日键（`c13da84`）。
3. **[P1] 免确认模式只封了 `;` 与换行**，`&&` / `||` / `|` / `$( )` / 反引号仍可整串命中 → 补齐分段符 + 含语句构造整体不生效（`cd03045`）。
4. **[P2→已修] `summaries()` 无逐条隔离**（P2-01 引入的失败放大：一个文件瞬时读错让整张会话列表失败）→ 逐条 try/catch（`d323709`）。
5. **[P2→已修] `writeNow` 失败无条件复亮脏标记 + 读盘在途删除复活**（「删了又回来」家族的另一半）→ 两处判据（`d323709`）。
6. **[P2→已修] 工具循环 abort 检查点留下 `running` 的 tool_call**（与 P2-03 同症状、入口不同）→ `settleUnexecutedCalls`（`d323709`）。
7. **[P2→已修] MCP 凭据路径「名称不含点、键含标记词」误拆**（P1-07 引入的回归）→ 候选拆法 + 按真实服务器名择优（`00e2ddc`）。
8. **[P2→已修] 文档与实现三处不符**：`docs/06 §4` 去重口径、`docs/06 §11.7` 免确认语义、`docs/07 §2.3` 折叠入口与 `quick` 口径（`cd03045`、`dad4b38`；`quick` 不作为回落目标同时落了代码）。

**未修的 P2/P3 已上报用户**（见 00-index「执行记录」的「遗留」一节）：`sync()` 与 MCP 遮蔽恢复的交互（P2-06 的补丁不完整）、限速表键无全局上界、越界写入的快照无法回滚、`writeRestoredFile` 的 `.tmp` 残留、`before-quit` 无逃生口、`finishJob({status:'error'})` 可覆盖 `aborted`、MCP SSE 增量解析的 O(n²)、中心 `streamFile` 客户端中断不销毁源流。

### 5. `AURORA_SMOKE` 端到端自测：**基线即红，与本任务无关**（已做基线对照复跑）

子代理与主代理都跑了真实 Electron 自测（`AURORA_SMOKE=1`，built 产物）：本任务树 `SUMMARY 162/176`，14 条 FAIL。**做了基线对照实验**（把 71 个改动文件切回 `52ed64c`、重建、跑同一套自测），结论：

| 运行 | 提交 | SUMMARY | `集成②` |
|---|---|---|---|
| A | `52ed64c`（基线） | 163/176 | PASS |
| B | `52ed64c`（基线复跑） | 162/176 | **FAIL** |
| C | `52ed64c`（基线复跑 2） | 162/176 | **FAIL** |
| D | `665f0b4`（step 2 后） | 164/176 | PASS |
| E | `4b483f5`（step 4 后） | 164/176 | PASS |
| F | `fe2cd47`（step 5 后） | 162/176 | FAIL |
| G | HEAD（本任务） | 162/176 | FAIL |

**同一个基线提交三次运行 163/162/162、`集成②` 一次 PASS 两次 FAIL** —— 该用例在基线就是**不稳定**的，因此 D→F 的「回归」是噪声而非真实退化：本任务 HEAD 的分布（162 + `集成②` FAIL）与基线多数次运行一致，**未引入 smoke 回归**。

14 条 FAIL 全部是存量问题，两个族别：
- **边界族（13 条，2026-09-30 会话三分轮引入，早于本任务基线）**：`tools/session-project.ts:108-136` 的 `boundaryRoot = projectRootOf ?? spaceDirOf ?? globalProjectRoot ?? activeModeDir` 里，`spaceDirOf('agent')` 对未绑定项目的会话恒返回 `%USERPROFILE%\Desktop\Aurora`，而冒烟夹具写的全是 `%TEMP%\aurora-smoke-*` → 必然越界（`E_PATH_OUTSIDE_WORKSPACE`）。连带 `write_file` 被拒 → 快照 `listed=0` → 写前快照 / 一键回滚 / 集成①②⑤ / run_command 回读 / list_dir / glob / grep 全挂。`session-project.ts` 不在本次任何 step 的 Writes 内、字节未变。
- **过期断言（1 条）**：「组件目录含全部触发器（7 类）与操作组件（**3** 类）」实得 `{conditions:7, actions:5}` —— 自动化操作组件早已是**五件**（AGENTS.md 与 docs/13 §5 v0.2.9 均已文档化），断言没跟着更新。

处置：**不在本任务范围**（要修得动冒烟夹具或改 `spaceDirOf` 对全局当前项目的遮蔽口径，两者都超出本计划），作为独立问题上报用户。

### 6. 留痕项（按计划要求只记录、不修改任何文件）

审查报告顺带发现的两处 **AGENTS.md 描述滞后**，本任务**未改** AGENTS.md，交由用户处理：
1. AGENTS.md 说 `SettingsStore.mutate` 的 draft 是「活对象」—— 当前实现已是深拷贝（`structuredClone` 副本上演练远程补丁的那条注释同样基于旧认知）。
2. AGENTS.md 说自动化 Normal Mode 的操作组件是「三件」—— 实际已是**五件**（docs/13 §5 在 v0.2.9 已文档化）。

### 7. 顺带发现（与本任务无关的存量问题，未修）

- **`pnpm format:check` 在 `apps/desktop/src/main/skills.ts` 失败**：工作区该文件是 CRLF、`HEAD` 里的 blob 是 LF。根因是本机 `core.autocrlf=true` 且仓库无 `.gitattributes` —— git 在 checkout 时写 CRLF，而 Prettier 读的是磁盘原样。仓库内容本身合规（审查者把 `HEAD` 的 blob 导到临时目录复跑 prettier 全绿）。该文件不在本任务任何 step 的写范围内。
- **`pnpm lint` 在 `apps/desktop/src/main/skills.test.ts:10` 失败**：`import { watch } from 'node:fs'` 只用作类型（`typeof watch`），`consistent-type-imports` 要求 `import type`。同属基线存量（该文件不在本次改动内）。
- 两者都在 `52ed64c` 上就存在，且**不在 bug 报告的条目内**（报告明确排除了纯风格问题），未纳入本任务。

### 8. 完成标准逐条勾选

- [x] `pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿（基线：typecheck 通过、111 文件 1921 用例；现状 115 文件 2050 用例）。
- [x] 39 条条目每条都有对应代码修复与提交，`bug/README.md` 的「最优先修复清单（Top 10）」全部落地。
- [x] 每条修复至少有一条可复跑验证（新增/修改的单测、类型检查、构建或文档对照），记录在各 step 的验收标准与执行记录。

