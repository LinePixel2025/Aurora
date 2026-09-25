# Step 01 — 文档先行 + 配置 Schema v7（`tts` 段）与迁移

- Task: agent-tts-voice
- Step: 1 / 8
- Status: done
- Depends on: none
- Produces: `docs/08`/`docs/07`/`docs/06`/`docs/11` 的语音相关章节；`packages/shared/src/config/{schema,defaults,migrations}.ts` 的 `tts` 段与 `CONFIG_VERSION = 7`；对应单测

## 目标

把「TTS 朗读」这件事在 SSOT 文档里定稿，并让配置 Schema 具备 `tts` 段（可用下述字段名读完整个后续任务）；旧配置能被迁移补齐。

## 输入

- 文档（先读，改之前必须知道锚点）：
  - `docs/08-settings-onboarding.md` §1（配置 Schema，现为 v6）、§2（迁移链）、§6（其他设置页）、§6.1（门控矩阵）
  - `docs/07-ui-spec.md` §2.3（AI 交互窗）、§2.5（设置窗口）
  - `docs/06-agent-core.md`（现最后一节是 §12，新节接 §13）
  - `docs/11-privacy.md` §4（什么情况下会联网）
  - `AGENTS.md`（「文档先行」「配置改动必须走版本迁移链」）
- 代码：
  - `packages/shared/src/config/schema.ts`（`CONFIG_VERSION`、`LlmSchema`、`SETTINGS_READONLY_PREFIXES`、`READONLY_PREFIX_REASONS`、`SettingsSchema`）
  - `packages/shared/src/config/defaults.ts`（`DEFAULT_TOOLCHAIN_CONFIG`、`PROVIDER_PRESETS` 的写法照抄）
  - `packages/shared/src/config/migrations.ts`（`migrateV5ToV6` 的 `fillMissing` 写法照抄）
  - `packages/shared/src/config/schema.test.ts`、`migrations.test.ts`

## 本步需冻结的接口（后续步骤全部按它写，不得改名）

```ts
export const CONFIG_VERSION = 7 as const

export const TTS_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const
export type TtsFormat = (typeof TTS_FORMATS)[number]

export const TtsProviderSchema = z.object({
  type: z.enum(['openai-compat']),
  baseUrl: z.string(),
  apiKeyEnc: z.string(),   // safeStorage 密文；明文只走 settings:setSecrets
  model: z.string(),
  voice: z.string(),       // 音色 id，如 alloy / FunAudioLLM/CosyVoice2-0.5B:alex
  speed: z.number().min(0.25).max(4),
  format: z.enum(TTS_FORMATS),
})

export const TtsSchema = z.object({
  enabled: z.boolean(),      // 语音功能总开关
  active: z.string(),        // 默认 TTS provider id；'' = 未配置
  autoRead: z.boolean(),     // 回复结束后自动朗读
  maxChars: z.number().int().min(50).max(4096),  // 单次朗读的文本上限（超出截断）
  providers: z.record(z.string(), TtsProviderSchema),
})
```

`defaults.ts`：

```ts
export const TTS_PRESETS = [
  { id: 'openai', label: 'OpenAI TTS', baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
  { id: 'siliconflow', label: 'SiliconFlow 语音', baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'alex' },
] as const

export const DEFAULT_TTS = {
  enabled: true,
  active: '',
  autoRead: false,
  maxChars: 2000,
  providers: {},
} as const
```

## 操作

1. **先改文档**（AGENTS.md 硬约定：改配置 Schema / IPC 契约 / 窗口交互前先改文档）。
   - `docs/08-settings-onboarding.md`：
     - §1 标题 `## 1. 配置 Schema（config.json，v6）` → `v7`；代码块里 `"version": 6` → `7`；
       在 `llm` 块之后插入 `tts` 块（字段与上面的 Schema 一一对应，含中文注释）；
     - §1 字段说明追加 bullet，至少写明：`tts.enabled` 是总开关；`tts.active` 为空 = 未配置（此时对话窗的朗读按钮不出现）；
       `tts.providers.<id>` 与 `llm.providers.<id>` 同构但**独立**；`tts.maxChars` 是单次朗读的截断上限；
       **本轮不含语音输入（STT）**；
     - §1 里 `advanced.readonlyPrefixes` 的示例数组（现在写着 `"llm.providers", "mcp.servers", ...`）追加 `"tts.providers"`，
       并补一句：`tts.providers` 含凭据密文，AI 的 `set_setting` 一律拒绝；
     - §2 迁移链列表追加 `v6 → v7`（补齐 `tts.*`）；
     - §6「其他设置页」在**「电脑操控」bullet 之后、「高级」bullet 之前**新增「语音」bullet：
       侧栏「AI 能力」组第 2 项（该组依序为 `llm` / `tts` / `skills` / `mcp` / `agent`）；页面提供总开关、
       默认 TTS 模型、自动朗读、截断上限，以及 provider 列表的增 / 改 / 删 + 「试听」；
     - §6.1 门控矩阵（表尾）追加行：
       | `tts.enabled` | 常显（否则无法重新启用） |
       | `tts.providers.*` | `tts.providers` 至少一项，否则整块换成 `data-empty="tts.providers"` |
       | `tts.autoRead` / `tts.maxChars` | `tts.providers` 至少一项（没有 provider 时朗读无从发生） |
   - `docs/07-ui-spec.md`：
     - §2.3（AI 交互窗）补一段：每条**助手**消息正文下方有「朗读 / 停止」按钮（无 TTS 配置时整个按钮不出现）；
       朗读状态与文本同行展示；自动朗读由 `tts.autoRead` 控制；
     - §2.5（设置窗口）把侧栏项从 7 项改为 8 项，并在「AI 能力」组列出 `语音`。
   - `docs/06-agent-core.md`：新增末节 `## 13. 语音输出（TTS，v0.8.0）`，写清：请求协议（`POST <baseUrl>/audio/speech`，
     body `{ model, input, voice, speed, response_format }`，`Authorization: Bearer`）、凭据来源、
     `maxChars` 截断语义、失败降级（合成失败只提示，不影响对话）、**不做 STT** 的边界。
   - `docs/11-privacy.md` §4「什么情况下会联网」追加：**开启朗读后，被朗读的回复文本会发送到用户配置的 TTS 服务**；
     未配置 / 未朗读时不出网。

2. **再改代码**（`packages/shared/src/config/`）。
   - `schema.ts`：`CONFIG_VERSION = 7`；在 `LlmSchema` 之后按上面的「冻结接口」加 TTS 常量与两个 Schema；
     `SETTINGS_READONLY_PREFIXES` 追加 `'tts.providers'`，并在 `READONLY_PREFIX_REASONS` 补中文原因
     —— 该常量的类型是 `Record<(typeof SETTINGS_READONLY_PREFIXES)[number], string>`，**漏写会直接编译报错**，这是内置护栏；
     `SettingsSchema` 加 `tts: TtsSchema`。
   - `defaults.ts`：加 `TTS_PRESETS` / `DEFAULT_TTS`；`DEFAULT_TOOLCHAIN_CONFIG` 加 `tts: { ...DEFAULT_TTS }`。
   - `migrations.ts`：新增 `migrateV6ToV7`（照 `migrateV5ToV6` 对 `agent` 的写法）：
     `next['tts'] = fillMissing(asRecord(raw['tts']) ?? {}, DEFAULT_TTS as unknown as Record<string, unknown>)`，
     `next['version'] = 7`；追加进 `MIGRATIONS`。`fillMissing` 对**已存在**的值一律保留，因此天然幂等。

3. 补测试：
   - `schema.test.ts`：默认配置 `SettingsSchema.safeParse` 通过且 `version === CONFIG_VERSION`；
     `createDefaultSettings().tts` 等于 `DEFAULT_TTS` 的语义值（含 `providers: {}`、`maxChars: 2000`）；
     `canWriteSettingPath('tts.providers.x.apiKeyEnc') === false` 且 `settingsReadonlyReason(...)` 非空（凭据不可由 AI 写）。
   - `migrations.test.ts`：造一份 `{ version: 6, ... }` 原始配置（含用户已写值，如 `advanced.readonlyPrefixes: ['custom.path']`），
     迁移后 `tts.providers` 存在、`version === 7`、`advanced.readonlyPrefixes` 原样保留；**再跑一次迁移结果不变**（幂等）。

## 验收标准

- [x] `pnpm typecheck` 通过（重点是新增只读前缀必须补 `READONLY_PREFIX_REASONS`，漏写会报错）
- [x] `pnpm vitest run packages/shared/src/config/schema.test.ts packages/shared/src/config/migrations.test.ts` 全绿（33 + 33 = 66 passed）
- [~] `pnpm --filter @aurora/shared test` 全绿 —— **该命令在本仓库不成立**：`packages/shared` 没有自己的
      vitest 配置，根 `vitest.config.ts` 的 include 是仓库根相对路径（`packages/*/src/**/*.test.ts`），
      从包目录执行会 "No test files found" 并退出 1（与本步改动无关，是既有仓库口径）。
      **等价替代**：`pnpm vitest run packages/shared` → 5 files / 106 tests 全绿。
- [x] `Select-String -Path docs/08-settings-onboarding.md -Pattern '"version": 7'` 有命中（L9），
      且 `tts.maxChars` 命中 3 处（L148 / L338 / L387）
- [x] `Select-String -Path packages/shared/src/config/schema.ts -Pattern "tts.providers"` 命中 3 处
      （L258 注释 / L259 黑名单 / L362 中文原因）
- [x] `git diff --stat` 里只出现本步声明的文件（文档 4 份 + `packages/shared/src/config/` 下 5 个）；
      工作区里那 5 个 `package.json` 版本改动是**开工前既有**、未由本步提交

## 交接

- 后续所有步骤使用本步冻结的字段名与常量名：`tts.enabled` / `tts.active` / `tts.autoRead` / `tts.maxChars` /
  `tts.providers.<id>.{type,baseUrl,apiKeyEnc,model,voice,speed,format}`、`TTS_PRESETS`、`DEFAULT_TTS`、`TTS_FORMATS`。
- 本步**只**改 `packages/shared/src/config/*` 与文档；`tts.providers.<id>.apiKey` 的**密文读写**在 step-02，
  **主进程脱敏与 IPC** 在 step-03。别在本步顺手改 `store.ts` / `ipc.ts`（会和后续步骤的写范围撞车）。
- 交付给 step-02 的事实：密文路径的 Schema 字段是 `tts.providers.<id>.apiKeyEnc`，明文路径约定为 `tts.providers.<id>.apiKey`。

## 执行记录

**执行时间**：2026-09-24 14:00–14:05　**执行模式**：逐个执行（用户选定）

### 分片与结果

| 分片 | 执行者 | 写范围 | 结果 |
|---|---|---|---|
| docs/08（§1/§2/§6/§6.1） | 子代理 `48f0342c` | `docs/08-settings-onboarding.md` | 完成（+50/-4）；报回 2 处本步引入的自相矛盾，由主代理修 |
| docs/07 + docs/06 + docs/11 | 子代理 `7003520c` | 上述 3 文件 | 完成（+75 / +18-3 / +9-1）；报回 docs/04 与 docs/README 的旧侧栏项数（留给 step-07） |
| shared/config 代码 + 测试 | 主代理 | `packages/shared/src/config/{schema,defaults,migrations}.ts` + 两个 `.test.ts` | 完成 |

### 实际改动

- **文档（4 份）**：docs/08 §1 标题与 `"version"` → v7、插入 `tts` 块、`readonlyPrefixes` 示例加
  `tts.providers`、新增 `tts` 字段说明 bullet、§2 迁移链加 `v6 → v7`、§6 新增「语音」bullet、
  §6.1 门控矩阵加 3 行、**§1.1 `apiKeySet` 行补 `tts.providers.<id>`**（step-03 才实现该标记，
  按「文档先行」先写在这里）；docs/07 §2.3 加「朗读 / 停止」bullet、§2.5 侧栏 7 → 8 项 + 语音页 bullet；
  docs/06 新增 `## 13. 语音输出（TTS，v0.8.0）`（13.1–13.5）；docs/11 §4 加「朗读（TTS）」行 + TTS 边界段。
- **主代理对文档分片的修正（3 类，均属本步改动直接导致的矛盾）**：
  1. docs/08 §2 `CONFIG_VERSION = 6` → `7`、`六条迁移` → `七条迁移`（同一 bullet 的迁移列表已是 7 条）；
  2. docs/08 §6「电脑操控」`第 4 项` → `第 5 项` 且组内顺序补 `tts`（与同文件新增的「语音 = 第 2 项」对齐）；
  3. docs/08 §1 两处「`CONFIG_VERSION` 仍为 6」改为「当时未另起新版本号」；
     docs/06 §13 **删掉两条计划里不存在的能力承诺**——「先剥 Markdown 再截断」改为「不剥离 Markdown（已知取舍）」、
     「渲染层以 AbortSignal 取消在途合成」改为「停止只停播放 + 丢弃过期回包，主进程只有超时取消」
     （step-03/04 的冻结接口里没有这两项，写成承诺就是死字段）。
- **代码**：`CONFIG_VERSION = 7`；`TTS_FORMATS` / `TtsFormat` / `TtsProviderSchema` / `TtsSchema`
  （+`TtsProviderConfig` / `TtsSettings` 类型）；`SETTINGS_READONLY_PREFIXES` 加 `'tts.providers'`
  并在 `READONLY_PREFIX_REASONS` 补中文原因；`SettingsSchema` 加 `tts: TtsSchema`；
  `defaults.ts` 加 `TTS_PRESETS` / `DEFAULT_TTS` 与 `DEFAULT_TOOLCHAIN_CONFIG.tts`；
  `migrations.ts` 加 `migrateV6ToV7`（`fillMissing` 补齐、幂等）并追加进 `MIGRATIONS`。
- **测试**：schema.test.ts +5 条（默认段、预设完整性、字段类型与枚举按值校验、越界拒绝、
  tts 与 llm 解耦、`tts.providers` 只读黑名单）；migrations.test.ts 新增 v6 → v7 describe（4 条），
  并把受 v7 影响的既有断言同步更新（v1/v2/v3/v4/v5 的 `applied` 计数 +1、多处 `version` 6 → 7）。

### 验证（主代理实跑，非子代理转述）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 退出码 0（4 个包 + node/web 两套 tsc 全 Done） |
| `pnpm vitest run packages/shared/src/config/schema.test.ts packages/shared/src/config/migrations.test.ts` | 2 files / 66 tests passed |
| `pnpm vitest run packages/shared` | 5 files / 106 tests passed（替代上面不成立的 `--filter` 命令） |
| `pnpm lint` | 退出码 0（eslint 无输出） |
| `pnpm exec prettier --check` 本步 5 个 .ts | All matched files use Prettier code style（`migrations.ts` 先被 `--write` 修过一次长行） |
| `Select-String docs/08 -Pattern '"version": 7'` / `tts.maxChars` | L9 / L148·L338·L387 命中 |
| `Select-String schema.ts -Pattern 'tts.providers'` | L258 / L259 / L362 命中 |

### 提交

- `c89f59c` docs: 补齐语音（TTS）规格 —— 06 §13、07 §2.3/§2.5、08 §1/§2/§6.1、11 §4（4 files, +155/-15）
- `3066660` feat(config): 新增 tts 配置段与 CONFIG_VERSION 7（v6→v7 迁移补齐 tts.*）（5 files, +329/-18）

### 遗留问题 / 交接口径

1. `pnpm --filter @aurora/shared test` 这条验收命令在本仓库恒为「No test files found」（根 vitest 配置作用域所致）。
   后续步骤凡引用它，一律改用 `pnpm vitest run packages/shared`；step-07 的全量回归用 `pnpm test`（根配置）不受影响。
2. `Design/` 是用户未跟踪目录且未被 `.prettierignore` 排除，`pnpm format:check` 因此**必然**失败 18 个文件（与本任务无关）。
   step-07 跑 CI 序列时按「排除 `Design/` 后全绿」记录，不擅自改用户的目录或 ignore 规则。
3. step-03 需补主进程 `redactSettings` 的 `apiKeySet`（文档已在 §1.1 先写好）；
   step-07 需统一 `docs/04-roadmap.md:289` 与 `docs/README.md:43` 的「侧栏第 7 项」旧口径。
4. 冻结接口与计划一致，未改名；`TTS_PRESETS` 只保留 id/label/baseUrl/model/voice 五个字段，
   语速与输出格式由设置页新建流程自己给默认值（step-05）。
