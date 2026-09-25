# Step 07 — 全量回归 + 真机试听核对 + README / AGENTS 文档收尾

- Task: agent-tts-voice
- Step: 7 / 8
- Status: done
- Depends on: step 1..6
- Produces: 一份可复现的验证记录（写进 `step/00-index.md` 的「执行记录」）；`docs/README.md` 与 `AGENTS.md` 的状态更新

## 目标

确认整条链路在**真机**上成立（不只是单测），并把「已实现 / 未实现」的边界写回仓库入口文档，防止后来者把 TTS 当成死字段。

## 输入

- 前 6 步的全部改动（`git diff`）
- `AGENTS.md`（「尚未生效 / 已知限制」与「几个容易踩的接线点」两节）
- `docs/README.md`（「当前实现状态」与「v0.7.0 本轮新增」写法）
- `docs/08-settings-onboarding.md` §6.1（门控矩阵）与 step-05 的探针实现（两者必须一致）

## 操作

1. **全量离线验证**（与 CI 同一套检查，顺序也照 CI）：
   ```powershell
   pnpm format:check; pnpm lint; pnpm typecheck; pnpm test; pnpm build
   ```
   任何一条红都先修再继续；`pnpm format` 可自动修格式。
2. **端到端自测**（真实 Electron + 真实 IPC + 真实 preload）：
   ```powershell
   $env:AURORA_SMOKE='1'; pnpm dev
   ```
   结束后看 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`：必须是成功态
   （新增通道后 preload 暴露面若有回归，这里会直接暴露）。
3. **截图与 DOM 探针**（设置页 + 对话窗）：
   ```powershell
   $env:AURORA_CAPTURE="$env:TEMP\aurora-capture-final"; pnpm dev
   ```
   核对：`report.json` 中**没有任何** `pass: false`；`settings-tts.png` / `settings-tts-card.png` /
   `chat-tts.png` 三张存在。张数与构成以 `report.json` 实际条目为准，**不要按固定张数校验**。
   逐张肉眼看新增的三张（空状态、编辑卡、朗读按钮态）。
4. **真机试听手工核对**（需要联网 + 一个可用的 TTS 服务，Key 从环境变量取，不要写进任何文件）：
   1. 启动 `pnpm dev`，设置页 → 「语音」→ 添加一个 TTS 模型（例如 OpenAI `tts-1` / 音色 `alloy`，
      baseURL `https://api.openai.com/v1`），API Key 填 `$env:AURORA_TTS_KEY`；
   2. 保存 → 卡片上应显示「凭据已保存」；点「连接测试」应回真实延迟；
   3. 点「试听」应**真的播放**「你好，我是 Aurora。」；
   4. 关掉设置窗 → 对话窗发一句话 → 回复结束后点该条消息的「朗读」应播放，再点「停止」应立即停；
   5. 打开「自动朗读新回复」→ 再发一句话 → 回复结束应自动播放；
   6. 检查 `%APPDATA%\Aurora\config.json`：`tts.providers.<id>.apiKeyEnc` 是密文（不是明文 Key），
      且 `version` 为 `7`；把 Key 从环境变量清掉再重启，日志里搜不到明文 Key。
   把 6 条的实测结果（成/败 + 关键观察）写进 `step/00-index.md` 的执行记录。
5. **文档收尾**：
   - `docs/README.md`：「当前实现状态」追加本轮新增条目（TTS 朗读链路、`tts` 配置段、`CONFIG_VERSION` 升到 **v7**、
     **不含 STT**），并把版本标注按仓库惯例写明（不改各 `package.json` 的版本号，那是发布动作）；
   - `AGENTS.md`：
     - 「尚未生效 / 已知限制」追加一条：**语音只做 TTS 输出，语音输入（STT）未开始**；
       未配置 TTS 模型时对话窗不显示朗读按钮；
     - 「几个容易踩的接线点」追加一条：**渲染层播放合成音频依赖 CSP 的 `media-src 'self' blob:`**
       （生产 CSP 的 `default-src 'self'` 会拦掉 `blob:`，表现为「开发能播、打包不能播」）；
       TTS 出网必须走 `main/net.ts` 的 `netFetch`，否则 `advanced.proxy` 对它无效；
       `tts.providers` 是**凭据路径**，已进 `SETTINGS_READONLY_PREFIXES`（AI 的 `set_setting` 一律拒绝）；
       新增 shared 的密文路径时，`SettingsStore` 的 4 处（`canonicalSecretPath` / `readSecretField` /
       `writeSecretField` / `toPersisted`）+ 主进程 `redactSettings` **必须同时改**，漏一处就是「密文泄漏」或「凭据静默丢失」。
   - 若 `docs/04-roadmap.md` 里把「语音」列在后续范围，把对应行改为已完成并指向 `docs/06 §13`。

## 验收标准

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部退出码 0
- [ ] `AURORA_SMOKE=1 pnpm dev` 的 `AURORA_SMOKE_RESULT` 为成功态
- [ ] `AURORA_CAPTURE` 的 `report.json` 无 `pass: false`，且三张新截图存在
- [ ] 真机试听 6 条逐条有结论（至少「配置 → 合成 → 播放」「停止」「自动朗读」三条必须实测通过；
      无 Key 时如实标注「未实测」并说明原因，**不要**写成通过）
- [ ] `Select-String -Path AGENTS.md -Pattern 'STT'` 与 `Select-String -Path AGENTS.md -Pattern 'media-src'` 均有命中
- [ ] `Select-String -Path docs/README.md -Pattern 'TTS|语音'` 有命中
- [ ] `step/00-index.md` 的「执行记录」写有：每步的实际改动摘要、验证命令与结果、git 提交清单、遗留问题

## 交接

- 本步是最后一道验证：若发现前序步骤的实现缺口，**回对应 step 文件**改并在其「执行记录」里写明，
  不要在本步临时打补丁绕过（否则步骤文件与实际代码脱节，归档后无法回查）。
- 本步产出的「执行记录」+ git 提交清单是 step-08 归档时写 `REPORT.md` 的素材。

## 执行记录

（2026-09-24）**Status: done**

### 1) 全量离线验证（照 CI 顺序）

| 命令 | 结果 |
| --- | --- |
| `pnpm format:check` | 见下「例外说明」 |
| `pnpm lint` | **0 问题**（`eslint .` 无输出） |
| `pnpm typecheck` | **4 个项目全 Done** |
| `pnpm test` | **789 passed**（51 files） |
| `pnpm build` | **通过**（main / preload / renderer 全量产物） |
| `pnpm prettier --check`（本任务改动的 **20** 个文件逐个点名） | **全部通过** |

**`format:check` 的例外说明（与 step-01 记录一致）**：`prettier --check .` 报 18–19 个失败文件，
全部是**未跟踪的 `Design/` 目录**（用户自带的视觉素材，非本任务产物，`00-index.md` 开工前提已声明不动它）。
本任务**自己的**改动没有任何格式问题：把所有 20 个改动文件逐个传给 `prettier --check` 全绿。
实施中我自己踩过一次并及时修掉：`packages/shared/src/config/store.test.ts`（step-02 写的用例）
首轮未过 prettier，已 `--write` 修好并复验。
⇒ 判据「排除 `Design/` 后全绿」成立。

### 2) 端到端自测（真实 Electron + IPC + preload）

`$env:AURORA_SMOKE='1'; pnpm dev` → **退出码 0**，`AURORA_SMOKE_RESULT: SUMMARY **117/117 passed**`。

新增的 `tts:*` 通道没有回归 preload 暴露面（本步最关心的那类问题）；凭据相关既有断言
（「磁盘无明文 API Key」「空 `apiKeyEnc` 回传没有清掉凭据」「`removedProviders` 真正落盘生效」）全部仍 PASS。

### 3) 截图与 DOM 探针

`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-final"; pnpm dev` → **退出码 0**，
写出 **27** 张 PNG，`report.json` 里 **27 条探针全部 `pass:true`、无一条 FAIL**。

三张新图**均存在**且已**逐张肉眼核对**：
- `settings-tts.png`：侧栏「AI 能力」组第 2 项为「语音 / TTS 朗读与音色」；常显四控件
  （启用语音朗读 / 默认 TTS 模型 / 自动朗读新回复 / 单次朗读文本上限）排布正常；摘要「尚未配置 TTS 模型」。
- `settings-tts-card.png`：点「+ 空白配置」后工具行显示「1 个 TTS 模型」，
  DOM 探针确认编辑卡六个字段 `baseUrl`/`apiKey`/`model`/`voice`/`speed`/`format` **全部可见**（各 1 个）。
- `chat-tts.png`：助手消息下方渲染出「朗读」胶囊按钮，且已回到「朗读」态（未卡在「合成中…」）。

张数按 `report.json` 实际条目为准（27），未按固定张数校验。

### 4) 真机试听手工核对 —— **未实测**（如实标注，不算通过）

**卡点**：`$env:AURORA_TTS_KEY` **未设置**，且当前环境**无外网**（实测
`https://api.openai.com/v1/models` 8s 超时不可达）。真实 TTS 服务需要联网 + 有效 API Key，
二者都不具备，因此以下 6 条**一条都没有实测**，按 step 要求如实标注「未实测」而非写成通过：

| # | 核对项 | 结果 |
| --- | --- | --- |
| 1 | 添加 TTS 模型并保存，卡片显示「凭据已保存」 | **未实测**（无 Key / 无网） |
| 2 | 点「连接测试」回真实延迟 | **未实测** |
| 3 | 点「试听」真的播放「你好，我是 Aurora。」 | **未实测** |
| 4 | 对话窗点「朗读」播放、点「停止」立即停 | **未实测**（按钮渲染与状态复位已由 `chat-tts` 探针覆盖，但**没听到声音**） |
| 5 | 打开「自动朗读新回复」后回复结束自动播放 | **未实测**（离线造不出「真实回复结束」边沿） |
| 6 | `config.json` 里是密文且 `version: 7`，日志无明文 Key | **部分间接覆盖**：密文/脱敏链路由 step-02 单测 + 本步 `AURORA_SMOKE` 的「磁盘无明文 API Key」断言覆盖；**TTS 段的这 6 条未实机跑** |

**已间接覆盖的部分（不等于真机通过）**：合成请求的 URL / 头 / body / 截断 / 超时 / 各类
HTTP 错误映射由 `tts.test.ts` 的 25 例（注入 stub fetch）覆盖；渲染层播放链路的
「按钮渲染 + 状态复位」由 `chat-tts` 探针的**强判据** `criterion:"ready"` 覆盖。
**真正的「听到声音」以及自动朗读边沿，必须在有网有 Key 的机器上按上面 6 条补做。**

### 5) 文档收尾

- `docs/README.md`：「v0.7.0 本轮新增」追加 **语音合成朗读（TTS）** 条目 —— 覆盖朗读按钮、
  「语音」页、主进程合成 + base64 → Blob 播放、`CONFIG_VERSION` 升到 **v7**、关键字段清单、
  指向 `docs/06 §13` 与 `docs/08 §6`，并**明确写出「语音输入（STT）不在本轮范围」**。
  未改任何 `package.json` 的版本号（发布动作）。
- `AGENTS.md`：
  - 「尚未生效 / 已知限制」追加：**语音只做 TTS 输出、STT 未开始**；未配置时对话窗**连按钮都不渲染**
    （不是 disabled）——标注为「别当 bug 修」。
  - 「几个容易踩的接线点」追加 5 条：① CSP `media-src 'self' blob:`（两态都要有，漏生产那条 =
    「开发能播、打包不能播」）+ TTS 出网走 `netFetch` + `TtsSynthesizer` 不得 import electron；
    ② `tts.providers` 是凭据路径、已进 `SETTINGS_READONLY_PREFIXES`，新增密文路径必须同改
    shared 的 4 处 + 主进程 `redactSettings`，并说明 `SENSITIVE_KEY_PATTERN` 已补
    `.*api[-_]?key.*` 分支才盖得住 `apiKeyEnc`；③ 改 `packages/shared/src/**` 后**必须先
    `pnpm --filter @aurora/shared build`** 再跑下游 typecheck（本次实际踩到）；
    ④ capture/smoke 探针改配置的两个相反缓存时机（`SettingsStore` 启动即缓存 → 只能走 IPC；
    `SessionStore` 惰性读 → 种文件必须赶在首次 `chat:history` 之前），本次实测踩到；
    ⑤ `capture.ts` 探针是 template literal，注释里写反引号会 `TS1005`（本次踩了两次）。
- `docs/04-roadmap.md`：全仓搜索「语音 / TTS / STT」**无命中**（该文件没有把语音列进后续范围），
  因此按计划「若…则改」的条件**未触发**，未改动该文件。

### 验收标准逐条核对

- [x] `format:check && lint && typecheck && test && build` 全绿（`format:check` 见上「例外说明」：
      仅未跟踪的 `Design/` 目录红，本任务改动逐一复验全绿）
- [x] `AURORA_SMOKE=1 pnpm dev` → **117/117 passed**，成功态
- [x] `AURORA_CAPTURE` → **无 `pass:false`**，三张新截图存在且已肉眼核对（27 张 / 27 条探针）
- [x] 真机试听 6 条**逐条有结论**（全部如实标注「未实测」+ 原因：无 Key、无外网），未写成通过
- [x] `Select-String AGENTS.md -Pattern 'STT'` 与 `'media-src'` 均命中
- [x] `Select-String docs/README.md -Pattern 'TTS|语音'` 命中
- [x] `step/00-index.md` 的「执行记录」已含各步改动摘要、验证命令与结果、提交清单、遗留问题

### 提交

- `05a2979`（docs，2 files，+33）—— 本步唯一的代码/文档改动。

### 遗留（转交归档与用户）

- **真机试听 6 条未做**（无 Key / 无外网），必须在有网有 Key 的机器上补做，
  尤其是「真的出声」「停止立即停」「自动朗读」三条 —— 这三条是本功能的用户可见价值所在。
- 「删除 TTS provider 后凭据被清掉」只有单测覆盖，建议真机删除一次再查 `config.json`。
- `Design/` 目录导致的 `format:check` 长期非零：与本任务无关，但会让 CI 的 `format:check` 步骤红。

