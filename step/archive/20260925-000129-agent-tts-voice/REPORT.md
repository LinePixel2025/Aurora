# 归档报告：agent-tts-voice（为 Agent 添加语音功能 —— TTS 朗读）

- 任务标识：agent-tts-voice
- 归档时间：2026-09-25 00:01
- 基线提交：`887ca4b`（开工前 HEAD）
- 结束提交：`3ba9aab`
- 提交区间：`887ca4b..3ba9aab`，共 **10** 个提交
- 步骤：7 个工作步骤 + 1 个归档步骤，**全部 done**

## 做了什么

给 Aurora 加上完整的 **TTS（文字转语音）朗读**能力：

- 设置页新增 **「语音」页**（侧栏「AI 能力」组第 2 项）：添加 / 编辑 / 删除任意 **OpenAI 兼容**的
  TTS 服务，字段为 baseURL / API Key / 模型 / 音色 / 语速 / 输出格式；支持「设为默认」「连接测试」「保存并试听」。
- 对话窗每条助手消息下方新增 **「朗读」按钮**（播完 / 停止自动复位）；设置页「自动朗读新回复」
  打开后，回复结束自动朗读。
- **凭据安全**：API Key 经 Electron `safeStorage` 加密落盘（`tts.providers.<id>.apiKeyEnc`），
  页面只显示「已保存 / 缺失」，渲染层与日志永远看不到明文。
- 合成在**主进程**完成（`POST <baseUrl>/audio/speech`，走 `main/net.ts` 的 `netFetch` 以受系统代理影响），
  音频以 base64 过 IPC，渲染层转 Blob 播放。
- 配置 Schema 升到 **v7**（新增 `tts.*` 段，`v6 → v7` 迁移幂等补齐、不覆盖用户已写值）。

**明确不在本轮范围**：语音输入（STT）。

## 步骤与验证结���

| # | 步骤 | 关键验证 | 提交 |
| --- | --- | --- | --- |
| 1 | 文档先行 + Schema v7 与迁移 | `pnpm typecheck` 0；`vitest run packages/shared` 106 passed | `c89f59c` `3066660` |
| 2 | `SettingsStore` 支持 tts 密文路径与脱敏 | store.test.ts **34 passed**；`tts.providers` 命中 8 处 | `c69c436` |
| 3 | IPC 契约 + 主进程 `TtsSynthesizer` | tts.test.ts **25 passed**；`pnpm test` 783 passed；build 通过 | `8b9d244` |
| 4 | CSP `media-src` + 渲染层 `useTts` | `media-src` 命中 **2** 处（dev/prod）；build 通过 | `fc16cc6` |
| 5 | 设置页「语音」页 + tts 补丁合并 + 截图探针 | typecheck/build 通过；**AURORA_CAPTURE 退出码 0、12 条探针全 PASS** | `8e8096b` |
| 6 | 对话窗「朗读」按钮与自动朗读 | **AURORA_CAPTURE(chat) 退出码 0、6 条探针全 PASS**；判据 `criterion:"ready"` | `226b7b1` |
| 7 | 全量回归 + 真机核对 + 文档收尾 | 见下「最终验证」；`docs/README.md` + `AGENTS.md` 已更新 | `05a2979` `bc66a2e` |
| 8 | 归档清理 | 本文件 | — |

## 最终验证（主代理亲自复跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | **0 问题** |
| `pnpm typecheck` | **4 个 workspace project 全 Done** |
| `pnpm test` | **791 passed**（51 test files） |
| `pnpm build` | **通过** |
| `AURORA_SMOKE=1 pnpm dev` | **117/117 passed**，退出码 **0** |
| `AURORA_CAPTURE` | 退出码 **0**；`report.json` **无任何 `pass:false`**；三张新截图存在且已逐张肉眼核对 |
| `pnpm format:check` | 整体红，但**清场后 warn 恰好 18 条全在未跟踪的 `Design/`**；本任务 25 个改动文件逐个点名 `prettier --check` **全绿** |

三张新截图：`settings-tts.png`（语音页空状态）、`settings-tts-card.png`（编辑卡六字段）、
`chat-tts.png`（助手消息下的「朗读」按钮）。

## 独立代码审查结论与处置

派了 **4 个独立审查子代理**（干净上下文，均非实现者），按维度拆分：正确性 + 验收比对 /
安全与凭据边界 / 测试质量与项目约定 / 独立复跑全部验收命令。

| 维度 | 结论 |
| --- | --- |
| 正确性 + 验收 | **可交付** —— 验收标准 1/2/3/4 全部独立复现通过 |
| 安全与凭据边界 | **有条件可交付** —— 核心边界全部实测通过；发现 1 个 P1 |
| 测试质量 + 约定 | **有条件可交付** —— 约定全部通过；发现弱断言与覆盖缺口 |
| 验收命令复跑 | **声称全部属实** —— A–G 七项逐条一致 |

### 已处置（提交 `3ba9aab`）

1. **P1（安全）`setSecret` 幽灵明文**：`memorySecrets.set()` 在路径存在性校验**之前**执行，
   而校验失败会抛错、**不回滚** —— 于是「抛了错但 `getSecret` 仍读得出明文」，
   且该路径之后真建出同名条目会**凭空继承**这份明文（磁盘却是空的 → `apiKeySet` 误报）。
   **实测**：修复前 `THREW=true, GETSECRET="sk-ghost"`；修复后 `GETSECRET=""`。
   这是 step-02 那次修复**只修返回值、没修内存**的遗留（同一缺陷的完整闭环），llm/tts/mcp 三条路径全中招。
   已把内存写入移到落盘成功之后，并补三条路径的回归用例。
2. **P2（正确性）capture 收尾清理没真删掉 provider**：`delete providers['capture']` 后未带
   `removedProviders`，而 `tts.providers` 是 record「缺项 ≠ 删除」→ 实测条目仍在，与注释相反。
   已补 `removedProviders: ['capture']` 并修正注释。
3. **P1（测试）`resolveFetch` 用例是无法证伪的弱断言**：原用例只断言「注入的被调用了」，
   审查者用反例证明「把实现改成走 `globalThis.fetch` 它照样通过」。
   已补全局 fetch 哨兵（被调用即抛错）并断言 `trap.calls === 0`，另加对照用例。
   **主代理用变异测试验证新断言有牙**：强制走全局 fetch → **15 个用例失败**。
4. **P2（测试）名不符实的用例**：已改名，使其与实际断言一致。

### 未处置（转交用户判断）

- **`useTts.ts` 零单测 / `ttsReady` 四个反向条件无测**：渲染层无测试框架
  （`vitest.config.ts` 只收 `packages/*` 与 `apps/desktop/src/main/**`，environment 为 `node`），
  补测需先扩配置 + 引入 DOM 环境，超出本任务范围（本任务未新增任何依赖）。
  属**测试强度**而非功能缺陷；建议单开「渲染层测试基建」任务。
- **`tts:testConnection` 的 `baseUrl` 无协议校验**：可构造 `file://` / `javascript:` / 内网地址。
  该通道由用户自己在设置页操作、`tts.providers` 已进只读黑名单，威胁模型内不构成提权；
  但加协议白名单会改变用户可见行为（能否用自建/内网 TTS 端点），属产品决策，未改。
- **`removedProviders` 无类型守卫**：`42`/`{}` 会让整单 `settings:update` 失败；`"a"` 被逐字符迭代。
  llm 路径同样存在（存量），未改。
- 若干 P3（自动朗读在「abort 且本轮无助手消息」时会重读上一轮、`isDecryptable` 空串守卫、
  `redactKeys` 把 `apiKeySet` 置 `***`、`tts.test.ts` 的 `handwritten` fixture 等）。

## 遗留与已知限制

1. **真机试听 6 条一条都没实测** —— `AURORA_TTS_KEY` 未设置，且实测当前环境**无外网**
   （`https://api.openai.com/v1/models` 8s 超时）。按 step 要求**如实标注「未实测」，未写成通过**。
   其中「真的出声」「停止立即停」「自动朗读」恰是本功能的用户可见价值，**必须在有网有 Key 的机器上补做**：
   详见 `step-07-verify-docs.md` 的「4) 真机试听手工核对」。
   已有间接覆盖：「合成请求正确性」由 25 例单测（注入 stub fetch）覆盖；
   「按钮渲染 + 状态复位」由 `chat-tts` 探针的强判据 `criterion:"ready"` 覆盖。
2. **「删除 TTS provider 后凭据被清掉」**只有单测覆盖，建议真机删除一次再查 `config.json`。
3. 未跟踪的 `Design/` 目录会让 CI 的 `format:check` 步骤红（与本任务无关，但会挡流水线）。
4. 语音输入（STT）未开始；MCP HTTP 自定义鉴权头、图片 OCR 等既有未做项不受本次影响。

## 工作区状态（归档时）

- 本任务产物**全部已提交**，无未提交的相关改动。
- 开工前就存在的 5 个 `package.json` 版本改动（`1.0.1-beta.1`）与未跟踪的 `.dsh/`、`Design/`
  **未被本任务触碰**（按 `00-index.md` 的开工前提要求）。
- 审查期间审查者留下的 `__review_tmp*.test.ts` 等临时文件已由主代理清理。
