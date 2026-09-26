# REPORT — approval-boundary-hardening

- 归档于 2026-09-27 00:33，归档路径 `step/archive/20260927-003313-approval-boundary-hardening/`
- 基线提交 `009fa09f21251f76206d9242f56a70fc1e2b4275`，工作提交 4 条（见下），22 文件 +589/−128
- 执行模式：全部连续执行；step 1 片 C（docs）派子代理并行，其余主代理亲历；验收均由主代理实跑

## 修复结论（一行一条）

- **逃逸链封堵**：`ConfirmDecision` 扩为四态（`false/true/'always'/'machine'`），三条机器放行路径（allowPatterns / auto 无项目 / auto 根内）与会话级 `'always'` 短路改返 `'machine'`，`agentLoop` 仅 `true|'always'` 置 `ctx.approvedByUser`——「根内 junction 指向根外零弹卡写出根外」的逃逸链封死，工具层与 registry 零改动（df9a05c）。
- **按钮接线**：设置页「打开工作目录」（`openPath kind:'workspace'`）接 `effectiveWorkspaceDir` 三级回落（解析抽纯函数 `resolveWorkspaceOpenTarget` + 4 单测），配了项目时与命令缺省 `cwd` 同目录，分叉消除（7e6adfd）。
- **加固收口**：settings-port 回滚分支补 `notifyChanged` 广播；`advanced.readonlyPrefixes` 进只读黑名单（防 AI 自我 DoS）；sync 内 `projectRoot()` 双调合并 + index.ts 两份等价闭包去重；`redactSettings` 搬到 electron-free 的 `settings-redact.ts`（拆掉 settings-port 测试的 electron 地雷）；docs/08 §1 标题 v13→v15（184762d）。
- **行为级回归**：command-runner 切项目竞态 fail-closed 用例（反证翻红后复绿）；冒烟 ② 去手工批准头衔（无 UX 回归证据）+ 新增 ②b junction 逃逸场景 + crash 矩阵两条 reject 行补「值逐字未变」断言（08d5ad4）。

## 验证结果

- `pnpm format:check / lint / typecheck / build` 全绿；`pnpm test` **1515 passed / 81 文件**（基线 1504，+11 新增用例）
- `pnpm verify` **26/26**（version === 15，迁移断言全过）；`AURORA_SMOKE` **166/166** 零 FAIL，②b 端到端 `machine:true noCard:true blocked:true`（junction 真建出、无 SKIP）
- 反证：step 1 三条 auto 根内断言改回 `true` 即红；step 2 竞态用例带 `allowOutside` 即红——回归护栏有效

## 提交清单

- `df9a05c` fix(agent-core): ConfirmDecision 增加 'machine' 出处，approvedByUser 仅当用户当次批准置位
- `08d5ad4` test(smoke): 逃逸链行为级回归 —— 切项目竞态 fail-closed 用例 + 冒烟 junction 逃逸场景
- `7e6adfd` feat(settings): 「打开工作目录」按钮接 effectiveWorkspaceDir，与执行链同目录
- `184762d` fix(security): settings-port 回滚补广播；readonlyPrefixes 进黑名单；redactSettings 拆出 ipc；装配去重

## 代码审查结论与处置（3 个独立 Reviewer，2026-09-27）

- **① 正确性与测试质量：可交付**——逐路径核对成立；测试无削弱（'machine' 断言为语义更新、竞态时序差真实、假 applyPatch 手法合理）。
- **② 安全边界与项目约定：可交付**——redactSettings 逐字比对 `VERBATIM_IDENTICAL`；无第 5 条机器放行路径；fail-closed 成立；回滚补广播无二次写盘/丢凭据。
- **③ 验收独立复跑：5/5 PASS**——定向 123+64 全绿、对抗性检查（confirmTool 链无 `return true`、工具层 diff 为空等）全过。
- **P0/P1/P2：无。P3 共 5 条，处置 = 留档不阻塞**：
  1. settings-port.ts 回滚分支注释不准确（`mutate` 实际会经 store `onChange` 触发渲染层广播；不触发的只是 `onSettingsChanged` 副作用回调，且该分支生产不可达）。
  2. 冒烟 detail 硬编码 `noWaiver:true` 标签非计算值（真实证据在 execute ctx 形态）。
  3. 冒烟 ②b 的 SKIP 兜底把「建不出链接」记 PASS（该环境下端到端护栏缺失，另有 3 处单测兜底）。
  4. docs/08:220 存量句「CONFIG_VERSION 已是 12」滞后（基线就有）。
  5. ipc.ts openPath 自建一次 `resolveProject` 调用未复用装配 getter（无行为分叉，结构限制，建议不改）。

## 遗留问题

- 「按钮实际打开哪个目录」无端到端点击自动化（shell.openPath 无法断言），按计划以纯函数单测 + 代码审查双轨覆盖。
- 会话授权表 `sessionApprovals` 无上限增长属改动前既有行为，范围外未处理。
