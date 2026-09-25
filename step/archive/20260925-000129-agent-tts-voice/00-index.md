# 任务：为 Agent 添加语音功能（AI 回复 TTS 朗读 + 设置页可添加 TTS 模型）

- 任务标识：agent-tts-voice
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-24 13:56
- 基线提交：887ca4b（开工前 `git rev-parse HEAD` = `887ca4b3fa52b3d7030930ffc7b008ec681db2f1`；工作区另有 5 个 `package.json` 未提交改动与 `.dsh/`、`Design/`、`step/` 未跟踪，均不属于本任务）
- 归档目录：step/archive/20260925-000129-agent-tts-voice
- 归档时间：2026-09-25 00:01

## 开工前提（拆解时实测，执行时先复查）

- `git status --porcelain` 显示 5 个 `package.json` 已被改成 `1.0.1-beta.1`（未提交），另有未跟踪的 `.dsh/`、`Design/`、`step/`。
  这些**不是本任务的产物**：不要提交、不要清理、不要回退。
- 环境：node v24.15.0、pnpm 11.15.1。若 `node_modules` 不存在先 `pnpm install`。
- **本轮范围**（已与用户确认）：
  1. 只做 **TTS（文字转语音）朗读**，**不做语音输入（STT）**；
  2. TTS 使用**独立 provider**（自己填 baseURL / API Key / 模型 / 音色 / 语速 / 格式），与聊天用的 `llm.providers` 解耦；
  3. 触发方式 = 助手消息上的「朗读」按钮 + 设置页「自动朗读新回复」开关。
- 真实 TTS 服务需要联网与 API Key，**离线跑不了**：自动化验收靠注入 stub fetch 的单测 + `AURORA_CAPTURE` 的 DOM 探针；
  真机试听是 step-07 的手工核对清单，Key 一律从环境变量取，不写进 step 文件。

## 步骤

| # | 文件 | 标题 | 状态 | 依赖 |
|---|------|------|------|------|
| 1 | step-01-schema-docs.md | 文档先行 + 配置 Schema v7（`tts` 段）与迁移 | done | - |
| 2 | step-02-secret-paths.md | SettingsStore 支持 `tts.providers.<id>.apiKey` 密文路径与脱敏 | done | step 1 |
| 3 | step-03-ipc-main-tts.md | IPC 契约 + 主进程 TTS 合成器（`tts:synthesize` / `tts:testConnection`） | done | step 1、step 2 |
| 4 | step-04-renderer-playback.md | CSP `media-src` + 渲染层 `useTts` 播放链路 | done | step 3 |
| 5 | step-05-settings-tts-page.md | 设置页「语音」页（添加/编辑 TTS 模型）+ 侧栏 + 截图探针 | done | step 3、step 4 |
| 6 | step-06-chat-speak.md | 对话窗「朗读」按钮与自动朗读 | done | step 4、step 5 |
| 7 | step-07-verify-docs.md | 全量回归 + 真机试听核对 + README/AGENTS 文档收尾 | done | step 1..6 |
| 8 | step-08-archive.md | 归档清理 | done | step 1..7 |

## 完成标准

1. 设置页出现「语音」页（侧栏「AI 能力」组第 2 项），能添加 / 编辑 / 删除 TTS 模型
   （baseURL、API Key、模型、音色、语速、输出格式）；API Key 经 safeStorage 加密落盘，页面只显示「已保存 / 缺失」。
2. 配置写进 `config.json` 的 `tts` 段且 `version: 7`；旧配置（v6 及以下）启动时被迁移链补齐、**不丢用户已写值**。
3. 对话窗每条助手消息带「朗读」按钮，点击后用配置的 TTS 模型合成并播放；设置页「自动朗读新回复」打开后回复结束自动朗读。
4. `pnpm typecheck && pnpm test && pnpm build` 全绿；`AURORA_CAPTURE` 设置页与对话窗场景的 `report.json` 无 FAIL（进程退出码 0）。

## 执行记录

### step-01 文档先行 + 配置 Schema v7（`tts` 段）与迁移 —— done（2026-09-24 14:05）

- **改动**：docs/08（§1 v7 + `tts` 块 + §1.1 `apiKeySet` 加 tts + §2 迁移链 + §6 语音页 + §6.1 三行）、
  docs/07（§2.3 朗读按钮、§2.5 侧栏 8 项）、docs/06（新 §13 TTS，13.1–13.5）、docs/11（§4 TTS 联网边界）；
  `packages/shared/src/config/`：`CONFIG_VERSION = 7`、`TtsSchema`/`TtsProviderSchema`/`TTS_FORMATS`、
  `tts.providers` 进只读黑名单、`TTS_PRESETS`/`DEFAULT_TTS`、`migrateV6ToV7` + 两个测试文件。
- **验证**：`pnpm typecheck` 0；`pnpm vitest run packages/shared` 106 passed；
  `pnpm vitest run …/schema.test.ts …/migrations.test.ts` 66 passed；`pnpm lint` 0；
  本步 5 个 .ts `prettier --check` 通过；`Select-String` 断言（docs/08 `"version": 7`、`tts.maxChars`、
  schema.ts `tts.providers`）全部命中。
- **提交**：`c89f59c`（docs，4 files）、`3066660`（feat(config)，5 files）。
- **遗留**：① `pnpm --filter @aurora/shared test` 在本仓库恒失败（根 vitest 配置作用域），改用
  `pnpm vitest run packages/shared`；② `Design/` 未跟踪目录让 `pnpm format:check` 必然红 18 个文件（与本任务无关，
  step-07 按「排除 Design/ 后全绿」记录）；③ step-03 补主进程 `apiKeySet`（文档已先行写入 §1.1）、
  step-07 统一 `docs/04-roadmap.md:289` 与 `docs/README.md:43` 的旧侧栏项数。
- **详细记录**：见 `step/step-01-schema-docs.md` 的「执行记录」。

### step-02 SettingsStore 支持 `tts.providers.<id>.apiKey` 密文路径与脱敏 —— done（2026-09-24 19:47）

- **改动**：`store.ts`（canonicalSecretPath 加 tts 分支、新增 `matchTtsProviderKey`、
  read/write/encryptStoredSecrets/toPersisted/exportRedacted 各加 tts 处理、
  `SENSITIVE_KEY_PATTERN` 加 `.*api[-_]?key.*` 分支）；`store.test.ts` 新增 TTS 凭据 6 例 + redactKeys 2 例。
- **计划外修复**：`writeSecretField` 判定用 `mutate(...) !== undefined`，而 provider 缺失时
  守卫是空操作、`mutate` 仍成功 → 该分支**恒真**，`setSecret` 从不抛「无法识别」。
  这是**存量缺陷**（llm / mcp 同样中招，实测 `llm.providers.ghost.apiKey` 也不抛），
  后果是调用方以为凭据已落盘、实际只在内存，重启即丢。三个分支各加存在性前置检查 + 回归用例。
- **验证**：`pnpm vitest run store.test.ts` **34 passed**；`pnpm vitest run packages/shared` 115 passed；
  `pnpm typecheck` 4 项目全绿；`pnpm lint` 0；`store.ts` 中 `tts.providers` 命中 **8** 处（要求 ≥6）；
  `git diff --stat` 仅 2 个文件。
- **提交**：`c69c436`（feat(config)，2 files）。

### step-03 IPC 契约 + 主进程 TTS 合成器 —— done（2026-09-24 19:55）

- **改动**：shared 的 `ipc/channels.ts`（tts 分组）、`ipc/types.ts`（4 个 DTO + `AuroraApi.tts` + `SettingsPatch.tts`）、
  preload 两文件；新增 `main/tts.ts`（`TtsSynthesizer`）与 `main/tts.test.ts`（25 例）；
  `main/contracts.ts`（`TtsSynthesizerLike`）、`main/ipc.ts`（两条 handler + `redactSettings` tts 分支）、
  `main/index.ts`（装配 + `deps.tts`）。
- **计划外**：`main/classification.test.ts` 的手写 `Settings` fixture 缺 step-01 新增的必填 `tts` 段
  （TS2741，vitest 不做类型检查所以 step-01 没暴露），补一行默认空态（+2 行）。
- **验证**：`pnpm typecheck` 4 项目全绿；`tts.test.ts` 25 passed；`pnpm test` **783 passed**；
  `pnpm build` 通过；`pnpm lint` 0；preload 有 `tts:synthesize`；`tts.ts` 无 electron import；
  10 个文件 prettier 全过。
- **教训（step-07 要记进 AGENTS）**：`@aurora/shared` 的 `types` 指向 `dist/`，
  改 shared 源码后必须 `pnpm --filter @aurora/shared build`，否则下游 typecheck 看旧类型。
- **提交**：`8b9d244`（feat(tts)，10 files，+847）。

### step-04 CSP `media-src` + 渲染层 `useTts` —— done（2026-09-24 20:00）

- **改动**：`main/index.ts` CSP 两态各加 `media-src`（+4 行）；新增 `shared/composables/useTts.ts`（134 行）。
- **验收偏差（已知，非静默放过）**：计划要求 `revokeObjectURL` grep ≥3 处，实际 2 处。
  实现把「ended / error / stop 三条路径各写一次 revoke」收敛为单一 `release()` 函数（三条路径都调它），
  等效性更强但判据原文未满足；`media-src` 起初因注释含字面量 grep 得 3，已改写注释使其恰为 2（两条真指令）。
  详见 `step-04-renderer-playback.md` 的「验收标准的偏差」。
- **验证**：`pnpm typecheck` 全绿；`media-src` 命中 2；dev `default-src` 未被改坏；`pnpm build` 通过；`pnpm lint` 0。
- **提交**：`fc16cc6`（feat(tts)，2 files，+139）。

### step-05 设置页「语音」页 + tts 补丁合并 + 截图探针 —— done（2026-09-24 20:04）

- **并行分片**（3 个子代理，写范围互不重叠）：5a `settings-patch`（tts 合并/删除/抽明文 + 6 例测试）、
  5b `TtsPage.vue`（新，897 行）+ `settings/App.vue` 接入、5c `capture.ts` 探针与两张截图场景。
- **主代理修正的探针缺陷（首跑 2 条场景均 FAIL，均为探针 bug 而非页面 bug）**：
  ① `SETTINGS_TTS_FIELDS_SCRIPT` 把 `autoRead`/`maxChars` 写进「空列表→必须为 0」的二选一，
  与 step 要求的**常显区**自相矛盾，空列表下 `pass` 永远 false；
  ② `SETTINGS_TTS_ADD_ACT` 未先进添加态（`+ 空白配置` 在 `v-if="mode === 'add'"` 里），
  且把按钮节点**预先缓存**成数组 → 进添加态后的新节点永远找不到。两处均已修并写进注释。
- **验证**：`pnpm typecheck` 全绿；`pnpm test` **789 passed**；`pnpm build` 通过；`pnpm lint` 0；
  `AURORA_CAPTURE_WINDOWS=settings` **退出码 0、12 条探针全 PASS 无 FAIL**；
  `report.json` 两张 tts 图 `pass:true`；两张图已肉眼核对。
- **提交**：`8e8096b`（feat(settings)，5 files，+1265/-8）。

### step-06 对话窗「朗读」按钮与自动朗读 —— done（2026-09-24 20:10）

- **改动**：`MessageList.vue`（可选 props/emits + 朗读按钮三态 + 样式）、`chat/App.vue`
  （`useTts`、`ttsReady` 四条件、autoRead 边沿 watch + `lastReadId` 去重、错误 toast、切会话停止）、
  `capture.ts`（`CHAT_TTS_SPEAK_ACT` / `CHECK` + `seedChatTtsHistory`）、`index.ts`（跑计划前种现场）。
- **首跑 `pass:false`，逐层查出 4 个原因并全部修掉**：① capture 计划无助手消息；
  ② 会话 id 种成 `capture-tts` 而交互窗读 `main`；③ `SessionStore` 首次读即缓存，种数据须在
  `captureWindows` 之前；④ `SettingsStore` 启动即缓存 config，TTS 配置必须走 `settings:update` IPC
  （不能写文件）。修完判据从退化的 `presence` 升级为**强判据 `criterion:"ready"`**。
- **验证**：`pnpm typecheck` / `pnpm test`（789 passed）/ `pnpm build` / `pnpm lint` 全绿；
  `AURORA_CAPTURE_WINDOWS=chat` **退出码 0、6 条探针全 PASS**；
  `chat-tts` = `criterion:"ready"`, `assistantMessages:1`, `speakButtons:1`, `reviveMs:0`，
  即真的断言了「点击后回到「朗读」态」（`loading` 有复位）；截图肉眼核对通过。
- **遗留**：自动朗读与「停止真的停音」需真机验证（离线造不出「真实回复结束」边沿），并入 step-07。
- **提交**：`226b7b1`（feat(chat)，4 files，+462/-7）。

### step-07 全量回归 + 真机核对 + 文档收尾 —— done（2026-09-24 20:26）

- **全量离线**：`lint` 0 / `typecheck` 4 项目全绿 / `test` **789 passed** / `build` 通过；
  本任务 20 个改动文件单独 `prettier --check` **全绿**（`format:check` 整体红仅因未跟踪的 `Design/`，与 step-01 记录一致）。
- **端到端**：`AURORA_SMOKE=1 pnpm dev` → 退出码 0、**117/117 passed**（`tts:*` 通道未回归 preload 暴露面）。
- **截图探针**：`AURORA_CAPTURE` → 退出码 0、写出 **27** 张、**27 条探针全 PASS 无 FAIL**；
  三张新图（`settings-tts` / `settings-tts-card` / `chat-tts`）均已肉眼核对。
- **真机试听 6 条：全部「未实测」**（`AURORA_TTS_KEY` 未设置 + 实测无外网），按 step 要求如实标注、**未写成通过**；
  其中「合成请求正确性」由 25 例单测、「按钮渲染与状态复位」由 `chat-tts` 强判据间接覆盖。
- **文档**：`docs/README.md`（v0.7.0 追加 TTS 条目 + v7 + 明确不含 STT）、`AGENTS.md`
  （「已知限制」加 STT/门控一条；「接线点」加 5 条，含本次实际踩到的 shared 需先 build、
  两个相反的缓存时机、探针字符串反引号坑）。`docs/04-roadmap.md` 无语音条目，条件未触发、未改。
- **提交**：`05a2979`（docs，2 files，+33）。

### 遗留（转交归档与用户）

1. **真机试听 6 条未做**（无 Key / 无外网）—— 尤其是「真的出声」「停止立即停」「自动朗读」三条，是本功能的用户可见价值所在。
2. 「删除 TTS provider 后凭据被清掉」仅有单测覆盖，建议真机删除一次再查 `config.json`。
3. 未跟踪的 `Design/` 目录会让 CI 的 `format:check` 步骤红（与本任务无关，但会挡流水线）。

## 执行阶段代码审查（2026-09-24 20:30 ~ 21:00）

按 skill 要求派了 **4 个独立审查子代理**（干净上下文、均非实现者），按维度拆分：
① 正确性 + 验收逐条比对；② 安全与凭据边界；③ 测试质量 + 项目约定一致性；④ 独立复跑全部验收命令。

### 审查结论

| 维度 | 结论 | 要点 |
| --- | --- | --- |
| 正确性 + 验收 | **可交付** | 验收标准 1/2/3/4 **全部独立复现通过**；迁移不丢值、`useTts` 资源与竞态（含反例）、`TtsSynthesizer` 边界均实测无问题 |
| 安全与凭据边界 | **有条件可交付** | 「密文不进渲染层（4 条通道全覆盖）」「日志/导出脱敏且无误伤」「明文不落盘」「只读前缀生效」「删除清理链」「CSP 两态」全部实测通过；发现 **P1** 见下 |
| 测试质量 + 约定 | **有条件可交付** | 提交信息、lint、25 文件 prettier、渲染层 import 合规、无超范围改动全部通过；发现弱断言与覆盖缺口 |
| 验收命令复跑 | **声称全部属实** | A–G 七项**逐条独立复跑一致**；CAPTURE 27 图/27 探针 `pass:false` **0 条** |

### 已处置（P0/P1 与高价值 P2）—— 提交 `3ba9aab`

1. **P1（安全）`setSecret` 幽灵明文**：`memorySecrets.set()` 在**路径存在性校验之前**执行，
   而校验失败会抛错、**不回滚**——于是「抛了错但 `getSecret` 仍读得出明文」，
   且该路径之后真的建出同名条目会**凭空继承**这份明文（磁盘却是空的 → `apiKeySet` 误报）。
   **主代理独立复现确认**：修复前 `THREW=true, GETSECRET="sk-ghost"`；修复后 `GETSECRET=""`。
   这是我 step-02 那次修复**只修了返回值、没修内存**的遗留，属同一缺陷的完整闭环。
   改法：把 `memorySecrets.set` 移到 `writeSecretField` 成功**之后**（两个 early-return 分支的
   「仅内存」语义保持不变）。补回归用例断言 llm/tts/mcp 三条路径抛错后 `getSecret` 均为空、
   且重建同名条目不继承幽灵明文。
2. **P2（正确性）capture 收尾清理没真删掉 provider**：`delete providers['capture']` 后调
   `settings:update` **未带 `removedProviders`**，而 `tts.providers` 是 record「缺项 ≠ 删除」——
   实测 `cleared=[]` 且条目仍在，与注释声称的相反。已补 `removedProviders: ['capture']`
   并修正注释（capture 恒在隔离 userData 下跑，此处属纵深防御）。
3. **P1（测试）`resolveFetch` 用例是无法证伪的弱断言**：原用例只断言「注入的被调用了」，
   漏了「全局的没被调用」——审查者用反例证明：把实现改成走 `globalThis.fetch` 它**照样通过**。
   已补 `withGlobalFetchTrap()` 哨兵（全局 fetch 一旦被调用即抛错）并断言 `trap.calls === 0`，
   另加一条对照用例锁住「`resolveFetch` 返回 undefined 时才回落」。
   **主代理用变异测试验证新断言有牙**：强制走全局 fetch 路径 → **15 个用例失败**（修复后 26 全绿）。
4. **P2（测试）名不符实的用例**：`参数里的明文 Key 优先于已保存凭据` 实际根本没传 `apiKey`，
   与另一条重复。已改名为「`synthesize` 不接受 `apiKey` 参数，始终用已保存凭据」。

### 未处置（记录在案，转交用户判断）

- **P1（覆盖）`useTts.ts` 零单测**、**P1（覆盖）`ttsReady` 四个反向条件无测**：
  渲染层无测试框架（`vitest.config.ts` 只收 `packages/*` 与 `apps/desktop/src/main/**`，
  且 environment 为 `node` 无 DOM），补测需先扩 vitest 配置 + 引入 DOM 环境——
  超出本任务范围（本任务未新增任何依赖）。审查者已用**临时测试**证明这些逻辑**可测**，
  建议后续单开一条「渲染层测试基建」任务。属**测试强度**而非功能缺陷。
- **P2（安全）`tts:testConnection` 的 `baseUrl` 无协议校验**：可构造 `file://` / `javascript:` /
  `http://169.254.169.254/...`。该通道由**用户自己在设置页**操作、且 `tts.providers` 已进只读黑名单、
  渲染层本就持有明文 Key（威胁模型内不构成提权）；但「允许任意 URL 与任意头的 POST」确实过宽。
  **未改**：加协议白名单会改变用户可见行为（是否允许内网/自建 TTS 端点），属产品决策，留给用户定夺。
- **P2（安全）`removedProviders` 无类型守卫**：`42`/`{}` → TypeError 让整单 `settings:update` 失败；
  `"a"` → 被逐字符迭代。llm 路径同样存在（存量）。**未改**：需同时评估 llm 侧既有行为，
  且当前渲染层不会发出这类畸形值。
- **P3** 若干（自动朗读在「abort 且本轮无助手消息」时会重读上一轮、`isDecryptable` 空串守卫、
  `redactKeys` 把 `apiKeySet` 置 `***`、`tts.test.ts` 的 `fakeSettings` 手写 fixture 等），详见各审查回报。

### 处置后的复验（主代理亲自跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | 0 问题 / 4 项目全 Done |
| `pnpm test` | **791 passed**（51 files；789 → +2 条新回归用例） |
| `pnpm vitest run apps/desktop/src/main/tts.test.ts` | **26 passed**（25 → +1） |
| `pnpm --filter @aurora/shared build` | 通过（改 shared 后必须重建，见 AGENTS） |
| `AURORA_CAPTURE`（settings,chat） | **退出码 0、22 条探针全 PASS、无 FAIL** |
| `AURORA_SMOKE=1 pnpm dev` | **117/117 passed**、退出码 0 |
| 变异测试（强制走全局 fetch） | **15 个用例失败** → 证明新断言真的能证伪 |

审查期间审查者留下的 `__review_tmp*.test.ts` 等临时文件已由主代理清理，工作区恢复干净。

（供执行阶段继续追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）
