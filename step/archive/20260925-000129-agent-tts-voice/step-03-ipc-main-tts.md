# Step 03 — IPC 契约 + 主进程 TTS 合成器

- Task: agent-tts-voice
- Step: 3 / 8
- Status: done
- Depends on: step 1（`tts.*` Schema）、step 2（凭据路径可读写）
- Produces: `tts:synthesize` / `tts:testConnection` 两条真实通道；`apps/desktop/src/main/tts.ts` 的 `TtsSynthesizer`；`tts.test.ts` 单测

## 目标

把「文本 → 音频字节」这条链路做通并暴露成 IPC：主进程用解密后的凭据调 TTS 服务的
`POST <baseUrl>/audio/speech`，把音频以 base64 回传渲染层；同时提供一个「试听 / 连接测试」入口给设置页。

## 输入

- `packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`
- `apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`
  （preload 是**自包含**产物：只 `require('electron')` + 字面量通道表，**不得** import `@aurora/shared` 的值）
- `apps/desktop/src/main/llm-tester.ts`（`resolveFetch` 注入、凭据优先取请求草稿、失败不抛到 IPC 边界的写法照抄）
- `apps/desktop/src/main/contracts.ts`（`LlmTesterLike`、`SettingsStoreLike`）
- `apps/desktop/src/main/ipc.ts`（`DesktopDeps`、`handle()`、`redactSettings`）
- `apps/desktop/src/main/index.ts` 第 521-525 行附近（`new LlmTester(...)`）与第 736 行 `registerIpc(deps)`
- `apps/desktop/src/main/net.ts`（`createNetFetch`：出网必须走它，否则 `advanced.proxy` 对该调用无效）

## 本步需冻结的契约（后续步骤按它写）

通道：`tts: { synthesize: 'tts:synthesize', testConnection: 'tts:testConnection' }`

```ts
export interface TtsSynthesizeRequest {
  text: string
  /** 缺省用 tts.active */
  providerId?: string
}
export interface TtsSynthesizeResult {
  audioBase64: string
  mimeType: string        // mp3→audio/mpeg, opus→audio/ogg, aac→audio/aac, flac→audio/flac, wav→audio/wav, pcm→audio/L16
  bytes: number
  latencyMs: number
  chars: number           // 实际送出的字符数
  truncated: boolean      // 是否被 tts.maxChars 截断
}
export interface TtsTestRequest {
  providerId?: string
  baseUrl?: string
  apiKey?: string        // 页面草稿里的明文；为空则回落已保存凭据
  model?: string
  voice?: string
  speed?: number
  format?: TtsFormat
  text?: string          // 缺省用内置样例句「你好，我是 Aurora。」
}
export interface TtsTestResult {
  ok: boolean
  latencyMs: number
  message: string
  bytes?: number
  httpStatus?: number
}
```

`AuroraApi.tts`：

```ts
tts: {
  synthesize(request: TtsSynthesizeRequest): Promise<Result<TtsSynthesizeResult>>
  testConnection(request: TtsTestRequest): Promise<Result<TtsTestResult>>
}
```

## 操作

1. `packages/shared/src/ipc/channels.ts`：加 `tts` 分组（两条通道），并把 `tts` 加进 `IpcChannel` 联合类型。
2. `apps/desktop/src/preload/channels.ts`：同步加同名字面量（两表有**编译期双向断言**，漏改 `pnpm typecheck` 直接报错）。
3. `packages/shared/src/ipc/types.ts`：加上面的 DTO + `AuroraApi.tts`。
4. `apps/desktop/src/preload/index.ts`：加 `tts: { synthesize: (request) => invoke(IPC.tts.synthesize, request), testConnection: (request) => invoke(IPC.tts.testConnection, request) }`。
5. 新建 `apps/desktop/src/main/tts.ts`（**不得 import electron**，否则 vitest 加载不了）：
   - `export class TtsSynthesizer`，选项 `{ settings: SettingsStoreLike; logger: Logger; timeoutMs?: number; resolveFetch?: () => typeof fetch | undefined }`。
   - `synthesize(request)`：
     - 解析 provider：`request.providerId ?? settings.get().tts.active`；为空 → 抛 `Error('尚未配置 TTS 模型')`；
       provider 不存在 → 抛 `Error('TTS 模型「<id>」不存在')`；
     - 校验 `baseUrl` / `model` / `voice` 非空（各自给中文提示，例如「请先填写 baseURL」）；
     - 文本：`text.trim()` 为空 → 抛 `Error('没有可朗读的文本')`；按 `settings.get().tts.maxChars` 截断，记 `truncated`；
     - 拼接端点：`baseUrl` 去掉尾部 `/`，若已以 `/audio/speech` 结尾则不再重复拼；
     - `POST`，头 `Content-Type: application/json` + `Authorization: Bearer <key>`，
       body `{ model, input, voice, speed, response_format: format }`；
     - 凭据优先用**参数里的明文**（设置页草稿），否则 `settings.getSecret('tts.providers.<id>.apiKey')`；
       两者都空 → 抛 `Error('缺少 API Key：请填写密钥')`；
     - 超时用 `AbortController`（默认 30s），超时的 message 固定写「合成超时（<n>s）」；
     - 非 2xx：读 body 前 300 字符拼进 message，并按状态码给中文前缀（401/403 密钥、404 模型或路径、429 限流）；
     - 成功：`Buffer.from(new Uint8Array(buf)).toString('base64')` 填 `audioBase64`，回 `bytes` / `latencyMs` / `chars` / `truncated`；
     - 出网 fetch 一律 `this.netFetch()`（解析失败的回落写法照抄 `llm-tester.ts` 的 `netFetch()`）。
   - `test(request)`：与 `synthesize` 同一解析逻辑，但**不抛**——把错误折成 `{ ok: false, latencyMs, message }`；
     成功回 `{ ok: true, latencyMs, message: '合成成功（<n> 字节）', bytes, httpStatus }`；试听文本默认「你好，我是 Aurora。」，超时短一些（15s）。
6. `apps/desktop/src/main/contracts.ts`：加

   ```ts
   export interface TtsSynthesizerLike {
     synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>
     test(request: TtsTestRequest): Promise<TtsTestResult>
   }
   ```

7. `apps/desktop/src/main/ipc.ts`：
   - `DesktopDeps` 加 `tts: TtsSynthesizerLike`；
   - 在 llm handler 之后加两个 handler：`handle(IPC.tts.synthesize, (request) => deps.tts.synthesize(request).then(ok, (error) => err('E_INVALID_STATE', String(error instanceof Error ? error.message : error))))`，
     `synthesize` 的错误用 `E_INVALID_STATE`（多为未配置 / 校验失败），网络类错误在 `tts.ts` 里已折成中文 message；
     `testConnection` 用 `E_UNKNOWN` 兜底；
   - `redactSettings(settings, source)`：在 llm providers 循环之后加 tts 分支 ——
     `apiKeySet = settings.getSecret('tts.providers.<id>.apiKey') !== ''`，`apiKeyEnc = ''`。
8. `apps/desktop/src/main/index.ts`：
   - 在 `new LlmTester({...})` 之后加
     `const tts = new TtsSynthesizer({ settings, logger: logger.child('tts'), resolveFetch: () => netFetch })`；
   - `deps` 对象里（`llm,` 旁边）加 `tts,`。
9. 新建 `apps/desktop/src/main/tts.test.ts`（不 import electron）：
   - 用假 `SettingsStoreLike`（`get()` 返回带 `tts` 段的配置、`getSecret` 返回明文）+ stub `resolveFetch`
     断言：请求 URL 为 `<baseUrl>/audio/speech`、`Authorization` 头正确、body 的 `response_format` 与 `voice` 原样下发、
     返回的 `audioBase64` 与原始字节一致、`truncated` 与 `maxChars` 行为一致；
   - 400/401 场景断言 `ok: false` 且 message 含状态码；
   - 未配置 provider / 空文本场景断言抛出对应中文 message；
   - 断言 `advanced.proxy` 路径：`resolveFetch` 被调用（即注入的 fetch 真的被用上，而不是走了 `globalThis.fetch`）。

## 验收标准

- [ ] `pnpm typecheck` 通过（preload 与 shared 的双向通道断言是主要护栏）
- [ ] `pnpm vitest run apps/desktop/src/main/tts.test.ts` 全绿
- [ ] `pnpm test` 全绿、`pnpm build` 通过
- [ ] `Select-String -Path apps/desktop/src/preload/channels.ts -Pattern "tts:synthesize"` 有命中
- [ ] `Select-String -Path apps/desktop/src/main/tts.ts -Pattern "electron"` **无**命中（内核约束：main 测试要能被 vitest 收）
- [ ] `git diff --stat` 只出现本步声明的文件（shared 的 2 个 ipc 文件、preload 的 2 个文件、main 的 4 个文件 + 新增 `tts.ts` / `tts.test.ts`）

## 交接

- 通道名与 DTO 字段名已冻结，step-04/05/06 直接按它们写渲染层。
- `synthesize` **不接收** baseUrl / key（渲染层不持有明文密钥）：渲染层只传 `{ text, providerId? }`；
  设置页的「试听」走 `testConnection`，它才接受草稿字段（用户在编辑卡里还没保存时的值）。
- 音频以 base64 过 IPC（体积可控：`maxChars` 上限 4096 字符，单次音频通常几百 KB）；
  **不要**把音频写临时文件再传路径 —— 那会引入新的清理责任。

## 执行记录

（2026-09-24）**Status: done**

### 实际改动（10 files，+847）

- `packages/shared/src/ipc/channels.ts`：加 `tts` 分组（`tts:synthesize` / `tts:testConnection`）并进 `IpcChannel` 联合。
- `packages/shared/src/ipc/types.ts`：加 4 个 DTO（`TtsSynthesizeRequest` / `TtsSynthesizeResult` /
  `TtsTestRequest` / `TtsTestResult`，字段与计划冻结的契约逐字一致）+ `AuroraApi.tts`；
  **顺带**加 `SettingsPatch.tts`（含 `removedProviders?: string[]`）—— step-05 依赖它，
  且它与 `AuroraApi.tts` 同在 IPC 契约文件，一次改完避免两次改动同一处。
- `apps/desktop/src/preload/channels.ts` + `index.ts`：同步字面量通道表与 `tts` 暴露面。
- 新建 `apps/desktop/src/main/tts.ts`（303 行）：`TtsSynthesizer`（`synthesize` 抛错 / `test` 不抛）、
  `MIME_BY_FORMAT` 六种格式、`speechEndpoint()`（去尾斜杠 + 不重复拼 `/audio/speech`）、
  `describeHttpFailure()`（401/403、404、429、5xx 中文前缀 + HTTP 状态码 + body 尾巴 ≤300 字符）、
  `AbortController` 超时（30s / 试听 15s，超时文案 `合成超时（<n>s）`）、
  `netFetch()` 注入解析（照抄 `llm-tester.ts` 的失败回落写法）。
- `apps/desktop/src/main/contracts.ts`：加 `TtsSynthesizerLike` + 4 个 DTO 的 type re-export。
- `apps/desktop/src/main/ipc.ts`：`DesktopDeps.tts`、两条 handler（`synthesize` → `E_INVALID_STATE`、
  `testConnection` → `E_UNKNOWN`）、`redactSettings` 加 tts 分支（补 `apiKeySet`、清空 `apiKeyEnc`）。
- `apps/desktop/src/main/index.ts`：装配 `new TtsSynthesizer({ settings, logger: logger.child('tts'), resolveFetch: () => netFetch })`，`deps` 里加 `tts,`。
- 新建 `apps/desktop/src/main/tts.test.ts`（25 例）。

### 计划外改动（1 处，编译阻塞）

`apps/desktop/src/main/classification.test.ts` 的 `settingsWith()` 是**手写**的 `Settings` 字面量，
step-01 给 Schema 加了必填的 `tts` 段后它缺键 → `pnpm typecheck` 报 TS2741（该文件在 step-01 中未被发现，
因为 step-01 只跑了 `packages/shared` 与全量 `pnpm test`，而 vitest 不做类型检查）。
按其既有注释惯例（「step 2 新增：`Settings` 里是 zod `.default()`，输出类型必填，fixture 必须补上」）
补一行 `tts: { enabled: true, active: '', autoRead: false, maxChars: 2000, providers: {} }`，+2 行，语义为默认空态。

### 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 4 项目全 Done（preload ↔ shared 双向通道断言通过） |
| `pnpm vitest run apps/desktop/src/main/tts.test.ts` | **25 passed**（40ms） |
| `pnpm test` | **783 passed**（51 files） |
| `pnpm build` | 通过（main / preload / renderer 全量产物） |
| `pnpm lint` | 0 问题 |
| `Select-String preload/channels.ts -Pattern "tts:synthesize"` | 命中（第 54 行） |
| `tts.ts` 的 import 行 | 仅 `@aurora/shared`（type-only）与 `./contracts.js`，**无 electron** |
| `pnpm prettier --check`（10 个改动文件） | 全部通过 |

### 遗留

- **`@aurora/shared` 必须先 build**：其 `package.json` 的 `types` 指向 `dist/index.d.ts`，
  改了 `packages/shared/src/**` 后不跑 `pnpm --filter @aurora/shared build`，
  `apps/desktop` 的 typecheck 会看着**旧类型**报「no exported member」。
  本次已执行；step-04/05/06 改 shared 后同样要先 build。这一条 step-07 的收尾里值得记进 AGENTS。
- `synthesize` 的超时用的是实例级 `timeoutMs`（默认 30s），`test` 固定 15s —— 与计划一致。
- 提交：`8b9d244`。

