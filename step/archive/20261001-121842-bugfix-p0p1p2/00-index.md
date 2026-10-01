# 任务：修复全仓审查报告的 P0+P1+P2 问题（39 条条目）

- 任务标识：bugfix-p0p1p2
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-10-01 10:18
- 执行模式：全部连续执行
- 基线提交：52ed64cb19500b1bca288b537442b1e971fbcc2c
- 归档目录：`step/archive/20261001-121842-bugfix-p0p1p2`
- 归档时间：2026-10-01 12:18:42

## 完成标准

- `pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿（对照基线：typecheck 通过、111 个测试文件 1921 用例全绿，2026-10-01 实跑于基线 52ed64c）。
- `bug/` 报告的 P0-01、P1-01～P1-12、P2-01～P2-26 共 39 条条目每条都有对应代码修复与提交，`bug/README.md` 的「最优先修复清单（Top 10）」全部落地。
- 每条修复至少有一条可复跑验证（新增/修改的单测、类型检查、构建或文档对照），记录在各 step 的验收标准。

## 现状与关键结论

- 基线 52ed64c（与审查报告同基线，未漂移）。改动前实跑：`pnpm typecheck` 通过；`pnpm test` 111 文件 1921 用例全绿（2026-10-01）。
- 报告可信度抽查 4 处全部属实：`packages/center/src/hub.ts:158`（`checkPatch(message.patch)` 实参先行求值）、`packages/agent-core/src/jobs/store.ts:632`（ORIGINS 白名单确缺 `center`/`automation`）、`packages/agent-core/src/llm/openai-compat.ts:148`（每 chunk 新建 TextDecoder）、`apps/desktop/src/main/tools/settings-port.ts:50-59`（TOP_LEVEL_GROUPS 确缺 tts/stt/imagegen）。
- 测试基建齐全：受影响模块均有现成 `*.test.ts`（center：hub/server/auth/device/store；agent-core：llm/session/jobs/loop/mcp/tools；shared：config/utils；main：tools/settings-port、tools/web-fetch、center/connector、automation/*）。渲染层纯逻辑可单测（根 `vitest.config.ts` include `apps/desktop/src/renderer/**/*.test.ts`，条件：不 import electron、不依赖 DOM）。
- 本计划不新增配置字段、不需要 CONFIG_VERSION 迁移：P1-01 只改可写/只读表常量，P1-07 改匹配逻辑 + 名称校验，P2-26 改 sanitize 行为。`pnpm verify` 的版本与迁移条数断言应照旧通过。
- 渲染层 IPC 契约改动（P2-22 新增推送）必须**同时**改 `packages/shared/src/ipc/channels.ts` 与 `apps/desktop/src/preload/channels.ts`（编译期双向断言），并遵守「文档先行」（docs/07 先写契约）。
- P1-12 / P2-07 / P2-08 等 Electron 生命周期与窗口几何改动无法进 vitest（`apps/desktop/src/main/**/*.test.ts` 只收不 import electron 的纯逻辑），验收以 typecheck + build + 代码路径核对为主，可抽出的纯判定逻辑补单测。
- P2-21 属文档与实现冲突：AGENTS.md 与 docs/07 §2.3 的门控口径均不含 apiKey 条件，而 `apps/desktop/src/renderer/chat/App.vue:605-615` 的实现多查了 `apiKeySet === true`（且代码注释自称"唯一口径"含密钥）——按 SSOT 原则以 docs/07 为准改代码。
- 本次未联网（无需外部事实：全部修复基于仓内代码与既有依赖行为，ws 8.x 的 maxPayload 行为已由审查报告核实过源码）。

## 假设与待确认

- 假设（P2-21）：以 docs/07 §2.3 与 AGENTS.md 口径为准，去掉实现里多出的 `apiKeySet === true` 条件（本地 whisper 类无密钥 provider 恢复渲染按钮），并改掉自相矛盾的代码注释。
- 假设（P2-11）：daily 触发器按「今天的 at 已过且当日键未触发」补触发一次（与 interval 的桶语义对齐，lessonKey 含日期天然幂等），并在 docs/13 §4 写明该语义。
- 假设（P1-07）：双管齐下——密文路径匹配改贪婪段（救存量含点名称）+ 名称输入与 schema 校验 `[A-Za-z0-9_-]+`（防新增），docs/08 写明命名约定。
- 假设（P2-17）：取报告的最小修法——CLI 检测到服务器运行中时警告并拒绝执行 users 写命令（数据目录锁文件），docs/12 §9 标注；「管理命令走服务器 API」不做。
- 假设：修复合入后的发版与阿里云 Center 服务器（120.24.223.65:8787）重新部署不在本计划内。
- 假设：`bug/` 目录保持未跟踪、内容不改（条目修复状态以 git 提交与各 step 执行记录为准）。
- 待确认：无。

## 范围之外（明确不做）

- P3 全部 29 条建议级问题（用户已拍板本次只修到 P2；P3 另开任务）。
- 发版（版本号、release notes、安装包）与 Center 服务器重新部署。
- `integrations/classisland-bridge`（.NET，CI 不编译，报告未覆盖）。
- AGENTS.md「尚未生效 / 已知限制」声明的已知项（报告已排除，不再处理）。
- 审查报告顺带发现的文档不符（AGENTS.md 两处描述滞后）——不在本任务内修改任何文件，由 step-11 执行记录留痕，供用户另行处理。

## 步骤

> 同波可并行（写范围互不重叠）：第 1 波：1、2、3、4、5、6；第 2 波：7、8、10；第 3 波：9；第 4 波：11；最后：12（归档）。
> 提交约定：Conventional Commits 中文描述，按「一个修复一个 commit」或合理小分组提交（如 `fix(center): ...`）；**每条提交信息必须尾注本次覆盖的条目号**（如 `...(P0-01, P2-14)`）——step-11 凭 `git log` 依尾注独立核验 39 条覆盖，无尾注即视为未覆盖。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-center-ws-robustness.md | Center 服务器 WS 健壮性与回执完整性 | done | - | `packages/center/src/hub.ts`、`server.ts`、`web/src/store.ts` 及配套测试 |
| 2 | step-02-agentcore-persist-stream.md | agent-core 持久层与流式可靠性 | done | - | `packages/agent-core/src/{llm,session/store,jobs/store,loop}` 及配套测试 |
| 3 | step-03-agentcore-mcp-history.md | agent-core MCP 传输/注册与历史窗口 | done | - | `packages/agent-core/src/{session/history,mcp,tools/registry}` 及配套测试 |
| 4 | step-04-settings-write-scope.md | 设置写入口径与配置 sanitize | done | - | `packages/shared/src/{config/schema,utils/object}`、`apps/desktop/src/main/tools`、agent-core 设置文案、docs/08 |
| 5 | step-05-main-lifecycle-snapshot.md | 主进程退出协议与快照回写安全 | done | - | `apps/desktop/src/main/{index,ipc,window-manager}.ts` 及新纯逻辑测试 |
| 6 | step-06-main-connector-tools.md | 主进程连接器、MCP 凭据、工具与自动化 | done | - | `apps/desktop/src/main/{center/connector,mcp,tools/web-fetch,automation/conditions}`、agent-core command-allow、docs/13 |
| 7 | step-07-center-auth-hardening.md | Center 认证限速与资源防护 | done | step 1 | `packages/center/src/{auth,device,server,cli}.ts` 及配套测试、docs/12 |
| 8 | step-08-secret-name-paths.md | 凭据名称校验与密文路径匹配 | done | step 4 | `packages/shared/src/config/{store,schema}.ts`、五个设置页组件、docs/08 |
| 9 | step-09-settings-ui-editstate.md | 渲染层设置页编辑态与试听 | done | step 8 | 五个设置页组件、`shared/composables/useTts.ts` |
| 10 | step-10-renderer-chat-session.md | 渲染层 chat 会话同步与流收尾 | done | step 5 | `useChat.ts`、`MessageList.vue`、chat `App.vue`、`main/ipc.ts`、双通道表、docs/07 |
| 11 | step-11-full-verify.md | 全量验证收尾 | done | step 1..10 | 只读 |
| 12 | step-12-archive.md | 归档清理 | done | step 1..11 | `step/` |

## 审查重点（供执行阶段派代码审查子代理时抄进派发消息）

- Step 1 / 7（Center）：入站形状校验是否覆盖全部 case 分支（不止 config.update / confirm.request）；限速键取 IP 的方式（`x-forwarded-for` 可伪造时是否回落 socket 地址）；锁文件的生命周期（崩溃残留是否会永久挡住 CLI）。
- Step 2：abort 后 job 终态必须保持 aborted、不得被 finishJob 改写 done；SessionStore 非 ENOENT 分支不得破坏首次装载与 in-flight 语义（AGENTS.md 记载本仓库已两次修过「空快照冲盘」）。
- Step 4：只读前缀追加后，set_setting 的工具 description、systemPrompt settingsHint、主进程文案三处口径一致；`modes.work` 其余字段仍可写。
- Step 5：退出协议改造与自动更新 `quitAndInstall` 路径兼容（before-quit 也会被更新流程触发）；preventDefault 后必须保证 `shutdown().finally(app.quit)` 无条件到达。
- Step 8 / 9：贪婪匹配不把「env 键含点」的新形状误匹配；双列表改造不得破坏保存链路。
- Step 10：preload 与 shared 通道表双向断言；去重修正不得破坏临时气泡（无 seq）的正常对账。

## 执行记录

### 提交清单（16 条 = 10 条工作步骤 + 6 条审查修复）

**工作步骤**（每条提交信息尾注 `覆盖条目：(...)`，41 行式核验 39/39 全部覆盖）：
`dfe64be`(P0-01,P1-02,P1-03,P2-14,P2-18) / `7e62dfb`(P1-08,P1-09,P1-10,P2-01,P2-02,P2-03) / `8ab8acb`(P1-11,P2-04,P2-05,P2-06) / `ba737e0`(P1-01,P1-06,P2-26) / `ef56d85`(P1-12,P2-07,P2-08) / `33ecede`(P1-04,P1-05,P2-09,P2-10,P2-11) / `c785313`(P2-12,P2-13,P2-15,P2-16,P2-17) / `01e9172`(P1-07) / `8649b76`(P2-23,P2-24,P2-25) / `e83f414`(P2-19,P2-20,P2-21,P2-22)

**审查后修复**：`9776ed1` 流式重试重置超时预算 / `c13da84` daily 跨进程幂等 / `cd03045` 免确认补齐分段符与语句构造 / `d323709` 会话摘要逐条隔离等四处 / `00e2ddc` MCP 凭据路径候选择优 / `dad4b38` chat 回落跳过 quick + 文档口径

### 验收结果（step 11 实跑）

`pnpm typecheck` / `pnpm test`（115 文件 **2050 用例**）/ `pnpm build` / `pnpm verify`（26/26）**四条退出码全 0**。

### 代码审查结论与处置

4 路独立审查（正确性/测试质量、安全与边界、并发与生命周期、约定与文档一致性）结论均为「有条件可交付」，报 4 条 P1 + 6 条 P2 + 若干 P3。**P1 与本次改动引入的回归全部已修并重新验收**（见上面 6 条审查修复提交与 `step-11-full-verify.md` §4）。

### 遗留（未修的 P2/P3，交由用户决定是否另开任务）

1. **[P2] `sync()` 与 MCP 遮蔽恢复的交互**：任一设置变更后，`tools/index.ts` 的 `sync()` 会无差别 `unregister` 8 个电脑操控工具名 → 消费掉遮蔽记录并恢复内置实现 → 之后 MCP 断开时 `unregister` 会把内置实现一起删掉，工具从注册表消失直到下次设置变更或重启（P2-06 的补丁在「中途发生过设置变更」这条路径上不完整；终态与修复前相同，非本次引入）。
2. **[P2] Center 限速表 `hits` 无全局上界**：只在同键再次访问时回收，多源 IP（`deviceStart` 公开端点）每个新 IP 留一条永不回收的记录。建议随 `pruneTimer` 全表清扫。
3. **[P2] 越界写入的快照无法回滚**：用户已批准过的根外 `write_file`（`allowOutside=true`）留下的快照，回滚时被 `restore-guard` 的边界校验拒绝 —— 需产品口径（回滚也走一次显式确认，或明确「越界写入不提供回滚」并写进 docs/06 §11.8）。
4. **[P3] `writeRestoredFile` 的 `.tmp` 残留**：rename 前进程被杀会留下 `<name>.<pid>.<ts>.tmp`（异常路径已清理，崩溃窗口无法单测）。
5. **[P3] `before-quit` 无逃生口**：`shutdown()` 若永久悬挂，退出被永久挡住且无法再退（需 `Promise.race` 超时兜底）。
6. **[P3] `finishJob({status:'error'})` 可覆盖乐观落下的 `aborted`**（`host/agentHost.ts:805`，该文件不在任何 step 白名单内）。
7. **[P3] MCP SSE 增量解析缓冲区只增不减 / 每片从头重扫**（O(n²)，10MB 级响应会卡主进程）。
8. **[P3] Center `streamFile` 客户端中断不销毁源流**（既有行为，正解是 `pipeline()`）。
9. **[存量/独立问题] `AURORA_SMOKE` 端到端自测基线即红**：`SUMMARY 162/176`，14 条 FAIL 全部是「2026-09-30 会话三分轮」引入的边界族（13 条）+ 一条过期断言（操作组件「3 类」实为 5 类）。**已做基线对照复跑证明与本任务无关**，详见 `step-11-full-verify.md` §5。
10. **[存量] `pnpm format:check` / `pnpm lint` 各有一处基线失败**（`main/skills.ts` 的 CRLF、`main/skills.test.ts` 的 `import type`），不在 bug 报告条目内，详见 `step-11-full-verify.md` §7。
