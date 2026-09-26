# 归档报告：修复自动续轮丢上下文、set_setting 越权可写、缺省工作目录越过项目根三处问题

- 任务标识：agent-context-boundary-fixes
- 基线提交：`8da7f26d64e398b7f191de61b02e191996dddac3`
- 归档于 2026-09-26 20:28，路径：`step/archive/20260926-202830-agent-context-boundary-fixes/`
- 执行模式：全部连续执行（用户选定）；完成标准四项全部勾销，v0.1.5 发布说明「已知问题」1–3 逐一对应修复（历史披露未改写）

## 三个修复（各一行）

- **① set_setting 越权可写**：`agent.loop` / `agent.snapshots` 进 `SETTINGS_READONLY_PREFIXES`（含中文拒绝原因、settingsHint 与冒烟矩阵两行真端口 expectReject），并把「不进覆盖表 ⇒ AI 改不动」的错误因果在 schema 注释 / docs/06 §11.8、§12.2 / docs/08 / AGENTS.md 全量纠为真实机制。`CONFIG_VERSION` 保持 15，无迁移。
- **② 自动续轮丢上下文**：`KernelAgentHost` 的「重读会话 → compressHistory → buildSystemPrompt」整块移入 attempt `for (;;)` 循环内、每 attempt 重算（续轮 = 自动 resume 同口径）；新用例 + 修复前反证（stash 生产代码必红）。
- **③ 缺省工作目录越项目根**：装配层接上三级回落纯函数 `effectiveWorkspaceDir`（项目根 > workspaceDir > 主目录，此前生产零消费方），`projectRoot` getter 与边界校验同源；`auto` 档「判定↔执行」配对补齐（执行端 5 用例 + 判定端补强用例）；无项目时行为逐字不变。

## 每步验证（要点）

- step 1：schema.test 40→41 绿；全仓 1497 绿；build/verify 26/26；口径 grep 逐条核过。
- step 2：agentHost 60 绿（新用例名在场）；反证失败点即 bug 现场；agentLoop 回归绿；全仓 1498 绿。
- step 3：tools/index.test 38 绿（新 describe 5 用例，断言端口实收 cwd/root）；护栏五件套 118 绿；全仓 1503 绿；AgentPage 仅文案（探针面核对）。
- step 4：CI 同序全链绿；**首轮 AURORA_SMOKE 抓到 step 3 的 TDZ 启动回归**（`projectLogger` 后声明被提前执行）→ 修复 `f86f360` → 复跑 **165/165 PASS**（含两行 reject 与 job 四场景）。

## git 提交清单（8da7f26..HEAD，9 条）

| SHA | 内容 |
|---|---|
| `3d7da16` | fix: set_setting 黑名单 + 文档口径（step 1） |
| `8284226` | fix(agent-core): 每 attempt 重读会话（step 2） |
| `2eac457` | fix(desktop): 三级回落接线（step 3） |
| `f86f360` | fix(main): projectLogger 上移，TDZ 启动失败（step 4 失败项） |
| `7123de0` | docs(step): 回填 step 1–4 记录 |
| `73d83da` | docs: 审查 P1 处置（唯一口径限定执行链、按钮分叉与批准出处披露、TDZ 注释符号锚） |
| `21f4239` | docs(step): 五份审查结论汇总 + step-01 计数自纠 |
| `265ae62` | test: 审查 P2 加固（判定端无-cwd 用例 / 错开根变异验证 / systemPrompt 重算钉住） |
| `700e1ca` | docs: 审查 P2 口径收口（三件事 / docs/07 / 三处陈旧注释 / quick 窗口豁免句） |

## 代码审查（5 个独立子代理、全新上下文，基线 8da7f26..HEAD）

- 判定：⑤可交付，①③④②均为有条件可交付；**P0 = 0，P1 = 3（全部处置），P2 用户选定范围内已清，P3 与范围外项记录在案**。
- P1 处置：④-P1-1 措辞过强（「唯一口径」限定为工具执行链 + AGENTS.md/docs 如实披露 `openPath kind:'workspace'` 按钮分叉）；④-P1-2 TDZ 注释行号错误（改符号锚）；②-P1-1 **既有逃逸链**（`approvedByUser` 不区分出处：auto 机器放行 / allowPatterns / 'always' 同带 `allowOutside` 整段跳过 realpath，配根内 junction 可零弹卡写到根外；非本批引入）→ 短期处置按审查者建议落**如实披露**（docs/06 §11.2 按实现现状改写 + AGENTS.md 残留段），代码级修复独立立项。
- 审查中已核实的关键正向结论：黑名单无任何绕过形态（组/叶/近似段/通配/大小写/父路径夹带全封死）；块移入循环后首 attempt 与基线逐字同构；装配/边界同一 projectRoot 闭包；既有测试零被动刀；反证与变异矩阵均真实致红；冒烟两行 reject 为真端口证据。

## 遗留问题（工单化建议）

1. **批准出处三元化**（②-P1-1 + ②-b `settings:changed` 竞态 + 冒烟 `approvedByUser:true` 条目联动）：仅"用户对本次卡片放行"才带 `allowOutside`，机器放行保留 realpath 兜底。
2. 「打开工作目录」按钮接 `effectiveWorkspaceDir` 或改文案（与执行链不再分叉，产品决定）。
3. `settings-port.ts` 写后校验失败回滚不广播（建议随 1 收口）。
4. P3 抽样（全量见 00-index 执行记录）：`advanced.readonlyPrefixes` 建议进黑名单（防自我 DoS）；sync 内两次 `projectRoot()` 调用重复 warn；index.ts 三份等价 `resolveProject` 闭包复用；冒烟 reject 行补「值逐字未变」断言；`containsAbsolutePath` 不识别 `%VAR%\`；`docs/08 §1` 标题 v13→v15；装配序步骤的验收清单固定加冒烟。

## 执行瑕疵（如实）

- step 3 期间主代理误用 `write` 覆盖 `tools/index.test.ts`，当场 `git checkout` 恢复重做，最终提交无影响。
- step 3 接线引入 TDZ 启动回归（单测盲区），由 step 4 冒烟抓到并修复（`f86f360`），流程结论已并入遗留 4。
