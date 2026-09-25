# Step 02 — SettingsStore 支持 `tts.providers.<id>.apiKey` 密文路径与脱敏

- Task: agent-tts-voice
- Step: 2 / 8
- Status: done
- Depends on: step 1（需要 `tts.providers.<id>.apiKeyEnc` 这个 Schema 字段存在）
- Produces: `packages/shared/src/config/store.ts` 的 TTS 凭据读写 / 加密 / 导出脱敏 / 日志脱敏；`store.test.ts` 的覆盖用例

## 目标

`SettingsStore` 的凭据机制此前**只认两条**硬编码路径（`llm.providers.<id>.apiKey`、`mcp.servers.<name>.env.<KEY>`）。
本步让 `tts.providers.<id>.apiKey` 走**同一套**加密落盘 / 读回 / 清理 / 脱敏，TTS 模型页才能像 AI 模型页一样存 Key。

## 输入

- `packages/shared/src/config/store.ts`（重点：`canonicalSecretPath`、`matchProviderKey`、`matchMcpEnvKey`、
  `readSecretField`、`writeSecretField`、`toPersisted`、`exportRedacted`、`encryptStoredSecrets`、`SENSITIVE_KEY_PATTERN`）
- `packages/shared/src/config/store.test.ts`（凭据用例的写法与 `MemoryFileSystem` 用法）
- `packages/shared/src/testing/memoryFs.ts`
- step 1 已落地的 `tts.*` Schema（`get().tts.providers`）

## 操作

1. `canonicalSecretPath(path)`：新增分支 —— `^tts\.providers\.([^.]+)\.apiKey(Enc)?$` → `tts.providers.<id>.apiKey`
   （与现有 llm 分支同样接受 `apiKeyEnc` 后缀写法）。放在 llm 分支之后、mcp 分支之前。
2. 新增 `function matchTtsProviderKey(key: string): string | undefined`，正则 `^tts\.providers\.([^.]+)\.apiKey$`。
3. `readSecretField`：加 tts 分支 → `this.current.tts.providers[providerId]?.apiKeyEnc`。
4. `writeSecretField`：加 tts 分支 ——
   用 `this.mutate((draft) => { const p = draft.tts.providers[id]; if (p === undefined) return; p.apiKeyEnc = cipher })`
   （与 llm 分支同形：密文为 `''` 时写空串即等于清除）。条目不存在时保持返回 `false`，
   让 `setSecret` 抛 `SettingsSecretError('无法识别的凭据路径：…')` —— **不要**静默成功。
5. `encryptStoredSecrets()`：追加一段遍历 `this.current.tts.providers`，用同一个 `encryptIfPlain` 补加密
   （手改配置文件 / 存量明文场景）。
6. `toPersisted(settings)`：加密不可用时，除现有 llm / mcp 之外，把 `tts.providers.*.apiKeyEnc` 也清空
   ——「宁可不存，也不落盘不可加密的凭据」。
7. `exportRedacted()`：`tts.providers.*.apiKeyEnc` 非空时置 `'***'`。
8. `SENSITIVE_KEY_PATTERN`：现有正则的 `api[-_]?key` 分支是**整体锚定**的，`apiKeyEnc` / `apiKeySet` 都不命中，
   密文字段会随日志落盘。给它加一个 `.*api[-_]?key.*` 分支（`apiKeySet` 是布尔标记，被判为敏感后置 `***` 无害）。
   改完先跑 `redactKeys` 的现有用例确认没被误伤（`keywords` 这类业务字段不能被命中）。
9. 补测试（`store.test.ts`）：
   - 写入 → 读回：`setSecret('tts.providers.sf.apiKey', 'sk-plain')` 后
     `getSecret('tts.providers.sf.apiKey') === 'sk-plain'`，且落盘 JSON 里 `tts.providers.sf.apiKeyEnc` 非空且 **不等于明文**；
   - `canonicalSecretPath('tts.providers.sf.apiKeyEnc') === 'tts.providers.sf.apiKey'`；
   - `clearSecret('tts.providers.sf.apiKey')` 后 `getSecret` 返回 `''` 且落盘 `apiKeyEnc === ''`；
   - `exportRedacted().tts.providers.sf.apiKeyEnc === '***'`；
   - crypto 不可用（`identityCrypto` 之外的桩，照现有「不落盘明文」用例的做法）时 `apiKeyEnc` 落盘为空串；
   - `redactKeys({ tts: { providers: { sf: { apiKeyEnc: 'cipher' } } } })` 里 `apiKeyEnc === '***'`；
   - 条目不存在时 `setSecret` 抛 `SettingsSecretError`。

## 验收标准

- [ ] `pnpm vitest run packages/shared/src/config/store.test.ts` 全绿（含新增用例）
- [ ] `pnpm --filter @aurora/shared test` 全绿
- [ ] `pnpm typecheck`
- [ ] `Select-String -Path packages/shared/src/config/store.ts -Pattern 'tts\.providers'` 至少命中 6 处
      （canonical / match / read / write / toPersisted / exportRedacted / encryptStoredSecrets 各一处）
- [ ] `git diff --stat` 只出现 `packages/shared/src/config/store.ts` 与 `store.test.ts`

## 交接

- 渲染层与主进程**永远看不到密文**：`settings:get` / `settings:changed` 回传的 `apiKeyEnc` 恒为空串，
  页面靠主进程补的 `apiKeySet` 只读标记判断「已保存」。本步只做 shared 层的脱敏；
  **主进程 `redactSettings` 的 tts 分支在 step-03**（`apps/desktop/src/main/ipc.ts`），别在本步改主进程文件。
- 设置页的保存顺序与 AI 模型页一致：**先** `settings:update` 落 provider 条目，**再** `settings:setSecrets`
  写 `tts.providers.<id>.apiKey`（条目必须先存在，否则 `setSecret` 抛错）。

## 执行记录

（2026-09-24）**Status: done**

### 实际改动

`packages/shared/src/config/store.ts`（+47/-8）：
1. `canonicalSecretPath`：新增 `^tts\.providers\.([^.]+)\.apiKey(Enc)?$` → `tts.providers.<id>.apiKey`
   （置于 llm 分支之后、mcp 分支之前），doc 注释同步补上 tts 写法。
2. 新增 `matchTtsProviderKey(key)`（正则 `^tts\.providers\.([^.]+)\.apiKey$`）。
3. `readSecretField`：tts 分支 → `this.current.tts.providers[id]?.apiKeyEnc`（置于 llm 与 mcp 之间）。
4. `writeSecretField`：tts 分支用 `mutate` 写 `apiKeyEnc`（`''` 即清除），与 llm 分支同形。
5. `encryptStoredSecrets()`：llm 循环之后追加 tts 循环，复用 `encryptIfPlain`，日志 `已为存量 TTS API Key 补加密`。
6. `toPersisted()`：加密不可用时把 `tts.providers.*.apiKeyEnc` 一并清空。
7. `exportRedacted()`：`tts.providers.*.apiKeyEnc` 非空时置 `'***'`。
8. `SENSITIVE_KEY_PATTERN`：新增 `.*api[-_]?key.*` 分支（覆盖 `apiKeyEnc` / `apiKeySet`）。

`packages/shared/src/config/store.test.ts`（+160）：新增 `SettingsStore · TTS 凭据` describe（6 例）
+ `canonicalSecretPath` 两条 tts 断言 + `redactKeys` 两条新用例（`apiKeyEnc`/`apiKeySet` 命中、
`monolingual`/`keywordCount`/`keywords`/`hotkeys` **不**被误伤）+ `seedTtsProvider` 测试辅助函数。

### 计划外修复（发现即阻塞验收，已在范围内修）

计划第 4 条要求「条目不存在时保持返回 `false`，让 `setSecret` 抛错 —— **不要**静默成功」。
实现时发现 `writeSecretField` 的判定是 `this.mutate(...) !== undefined`，而 `mutate` 内部的
`if (provider === undefined) return` 是**空操作**、`mutate` 本身仍成功返回 → 该分支**恒为 true**，
`setSecret` 从不抛错。这是**存量缺陷**，llm / mcp 两条路径都中招（实测：
`setSecret('llm.providers.ghost.apiKey', 'sk-x')` 同样不抛），且后果严重 ——
调用方以为凭据已落盘，实际只留在内存 `memorySecrets`，重启即丢。
按计划「TTL 不静默成功」的意图，在 llm / tts / mcp 三个分支各加一条存在性前置检查
（`this.current.*` 里查不到目标条目即 `return false`），并补了一条回归用例
（`路径可识别但条目不存在时同样抛错，不静默成功`，覆盖 llm 与 mcp 两条路径）。

### 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm vitest run packages/shared/src/config/store.test.ts` | **34 passed**（原 27 + 新 7） |
| `pnpm vitest run packages/shared` | **115 passed**（5 files） |
| `pnpm typecheck` | 4 个 workspace 全 Done，退出码 0 |
| `pnpm lint` | `eslint .` 无输出（0 问题） |
| `Select-String store.ts -Pattern 'tts\.providers'` | **8** 处命中（要求 ≥ 6） |
| `git diff --stat` | 仅 `store.ts`(+47/-8) 与 `store.test.ts`(+160) |
| `redactKeys` 既有用例 | 未误伤（`keywords` 仍是业务字段） |

### 遗留

- `pnpm --filter @aurora/shared test` 在本仓库恒失败（根 vitest 配置作用域，step-01 已记录），
  改用 `pnpm vitest run packages/shared`。
- 主进程 `redactSettings` 的 tts 分支按计划留到 step-03（`apps/desktop/src/main/ipc.ts`），本步未动主进程。
- 提交：见下（主代理独占提交）。

