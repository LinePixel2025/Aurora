# REPORT — bugfix-p0p1p2（全仓审查报告 P0+P1+P2 修复）

- 归档于 2026-10-01 12:18:42
- 最终归档路径：`step/archive/20261001-121842-bugfix-p0p1p2`
- 项目根：`D:\AICOP\Projects\Aurora`
- 基线提交：`52ed64cb19500b1bca288b537442b1e971fbcc2c`
- 执行模式：全部连续执行（用户在第 0.5 步选择）

## 做了什么

修复 `bug/` 报告的全部 **39 条**条目（P0-01、P1-01～P1-12、P2-01～P2-26），随后按 4 路独立代码审查的结论修复 P1 与本次改动引入的回归，共 **16 条提交**。

## 验收结果（step 11 实跑，四条退出码全 0）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0 —— 5 个包 + apps/desktop（tsc + vue-tsc）全部 Done |
| `pnpm test` | 0 —— 115 文件 / **2050 用例**全绿（基线 111 / 1921） |
| `pnpm build` | 0 —— 三个包 + Electron 主进程与渲染层产物 |
| `pnpm verify` | 0 —— 26/26 项通过（含 CONFIG_VERSION=21 与 v0→当前版本迁移链 21/21） |

39 条条目提交覆盖：按提交信息尾注逐条核验 → **39/39**。

## 提交清单（16 条）

工作步骤（每条尾注 `覆盖条目：(...)`）：
`dfe64be`(P0-01,P1-02,P1-03,P2-14,P2-18) · `7e62dfb`(P1-08,P1-09,P1-10,P2-01,P2-02,P2-03) · `8ab8acb`(P1-11,P2-04,P2-05,P2-06) · `ba737e0`(P1-01,P1-06,P2-26) · `ef56d85`(P1-12,P2-07,P2-08) · `33ecede`(P1-04,P1-05,P2-09,P2-10,P2-11) · `c785313`(P2-12,P2-13,P2-15,P2-16,P2-17) · `01e9172`(P1-07) · `8649b76`(P2-23,P2-24,P2-25) · `e83f414`(P2-19,P2-20,P2-21,P2-22)

审查后修复（6 条）：
`9776ed1` 流式重试重置超时预算 · `c13da84` daily 跨进程幂等 · `cd03045` 免确认补齐分段符与语句构造 · `d323709` 会话摘要逐条隔离等四处 · `00e2ddc` MCP 凭据路径候选择优 · `dad4b38` chat 回落跳过 quick + 文档口径

## 代码审查结论与处置

4 路独立审查（正确性/测试质量、安全与边界、并发与资源生命周期、约定与文档一致性），结论均为「**有条件可交付**」，报 4 条 P1 + 6 条 P2 + 若干 P3。

**P1 与本次引入的回归已全部修复并重新验收**（含反向复核）：
1. [P1] 流式重试复用已中止的 `RequestScope` → 每次 attempt `arm()` 一份新预算。
2. [P1] daily 错过补偿跨重启不幂等（本次回归）→ 启动时从运行历史重建当日键。
3. [P1] 免确认模式只封 `;` 与换行 → 补齐 `&&`/`||`/`|` + 含语句构造整体不生效。
4. [P2] `summaries()` 无逐条隔离（本次引入的失败放大）→ 逐条 try/catch。
5. [P2] `writeNow` 失败无条件复亮脏标记 + 读盘在途删除复活 → 两处判据。
6. [P2] 工具循环 abort 检查点留下 `running` 的 tool_call → `settleUnexecutedCalls`。
7. [P2] MCP 凭据路径「名称不含点、键含标记词」误拆（P1-07 回归）→ 候选择优。
8. [P2] 文档与实现三处不符（docs/06 §4、docs/06 §11.7、docs/07 §2.3）→ 已改准；`quick` 不作为回落目标同时落了代码。

## 遗留问题（未修，交用户决定是否另开任务）

1. [P2] `sync()` 与 MCP 遮蔽恢复的交互让工具暂时消失（`apps/desktop/src/main/tools/index.ts` + `agent-core/src/tools/registry.ts`；终态与修复前相同，非本次引入）。
2. [P2] Center 限速表 `hits` 无全局上界（`packages/center/src/server.ts`）。
3. [P2] 越界写入留下的快照无法回滚（`apps/desktop/src/main/tools/restore-guard.ts`）。
4. [P3] `writeRestoredFile` 的 `.tmp` 残留；`before-quit` 无逃生口；`finishJob({status:'error'})` 可覆盖 `aborted`；MCP SSE 增量解析 O(n²)；Center `streamFile` 客户端中断不销毁源流。
5. [独立存量问题] `AURORA_SMOKE` 端到端自测**基线即红**（162/176）：14 条 FAIL 全部是 2026-09-30 会话三分轮引入的边界族（13 条）+ 一条过期断言（操作组件「3 类」实为 5 类）。同基线三次运行 `163/162/162`（`集成②` 一 PASS 两 FAIL）证明 `集成②` 本身不稳定；本任务 HEAD 的分布与基线多数次一致，**未引入 smoke 回归**。
6. [存量] `pnpm format:check`（`main/skills.ts` 的 CRLF）与 `pnpm lint`（`main/skills.test.ts` 的 `import type`）各一处基线失败，不在 bug 报告条目内。
7. [留痕] AGENTS.md 两处描述滞后未改（「`SettingsStore.mutate` 的 draft 是活对象」实为深拷贝；自动化 Normal Mode 操作组件「三件」实为五件）。

## 行为变化（发版时需写进 release notes）

1. **免确认命令模式收紧**：`git *` 从「放行任意拼接整串」变为「每一段都命中才放行」，且含 `$( )` / 反引号 / `&&` / `|` 等语句构造时**整体不免确认**（退回弹卡）。
2. `modes.work.workspaceDir` 对 AI 转只读（用户设置页不受影响）；`tts` / `stt` / `imagegen` 三组对 AI 放行（凭据子路径仍拒绝）。
3. 设置页关闭 Center 改为可逆暂停，再启用立即重连；仅轮换 MCP env / header 的值也会触发该服务器重连。
4. daily 自动化改为「当天 at 已过且当日键未触发即补触发一次」，并做到跨进程幂等。
5. Center 认证端点加按源 IP 限速（login 5 次/60s、register 10、deviceStart 30，超限 429）；CLI 的 `users add/passwd/remove` 需先停服（锁文件判定），**CLI 与服务器必须同版本上线**。
6. MCP 服务器名 / provider id 新增长度外字符集约束 `/^[A-Za-z0-9_-]+$/`（禁 `.`）；存量含点 MCP 名在 `init()` 被规整（改名不丢数据）。
7. 写前快照的回滚同样过项目根边界；窗口几何落盘改为停手后 250ms 去抖。
8. 会话删除新增跨窗口推送 `chat:sessionDeleted`（载荷 `{ sessionId }`）。
