# Step 08 — 凭据名称校验与密文路径匹配

- Task: bugfix-p0p1p2
- Step: 8 / 12
- Status: done
- Depends on: step 4（同改 `packages/shared/src/config/schema.ts`、`schema.test.ts` 与设置分册文档，串行避免冲突）
- Produces: 存量含点名称的 provider/MCP 凭据恢复可存取（贪婪匹配）；新名称含点在 schema 与五个设置页入口被明确拒绝；命名约定写入 docs/08
- Phase: 安全与边界
- Writes: `packages/shared/src/config/store.ts`、`packages/shared/src/config/store.test.ts`、`packages/shared/src/config/schema.ts`、`packages/shared/src/config/schema.test.ts`、`apps/desktop/src/renderer/settings/pages/LlmPage.vue`、`apps/desktop/src/renderer/settings/components/TtsSection.vue`、`apps/desktop/src/renderer/settings/components/SttSection.vue`、`apps/desktop/src/renderer/settings/components/ImageGenSection.vue`、`apps/desktop/src/renderer/settings/components/McpSection.vue`、`docs/08-settings-onboarding.md`
- Size: M
- Risk: 贪婪匹配改变密文路径解析语义——必须确认「env 键不含 `.`」在仓内是硬约定（如不成立，改用「从右往左按已知后缀拆分」等价方案）；五个设置页输入校验要同一正则与同一提示文案，别写五份漂移的实现

## 目标

名称含 `.` 的存量 provider（`api.deepseek`）与 MCP 服务器（`my.server`）凭据能正常存取，MCP 添加流程不再「服务器落库成功、env 明文丢失」；新名称在入口即被拦截并给出明确提示。

## 输入

- `bug/P1-严重.md` 的 P1-07（三处发现合并：输入侧无校验 × 解析层正则不可回环 × schema 仅 min(1)，含 MCP 流程丢 env 明文的加重后果）；证据在 `bug/_raw/U7-settings-onboarding-edgebar.md`、`bug/_raw/U4-config-classify-media-center.md`、`bug/_raw/U8-shared-preload-modes-scripts.md`
- 源码：`packages/shared/src/config/store.ts`（`matchMcpEnvKey` / `canonicalSecretPath` 约 725-758，`[^.]+` 段正则）；`packages/shared/src/config/schema.ts`（`McpServerSchema.name` 约 384 仅 min(1)）；五个设置页输入校验：`apps/desktop/src/renderer/settings/pages/LlmPage.vue` 约 421-427、`components/TtsSection.vue` 约 200-206、`SttSection.vue` 约 136-142、`ImageGenSection.vue` 约 145-151、`McpSection.vue` 约 157-166（均只查空串与重名）
- 命名正则口径：`/^[A-Za-z0-9_-]+$/`（禁 `.`；本计划假设采纳报告方案①+②双管齐下）
- 凭据链五处同步口径（AGENTS.md）：canonicalSecretPath / readSecretField / writeSecretField / toPersisted / redactSettings——本步改的是第一处的**匹配语义**，后四处实现不动，但改完要过一遍凭据读写回归

## 操作

1. 文档先行：`docs/08-settings-onboarding.md` 写明 provider / MCP 名称命名约定（`/^[A-Za-z0-9_-]+$/`、禁 `.` 及原因：凭据路径以 `.` 分段，含点名称无法被密文路径正则匹配）、存量含点名称的兼容口径（读取侧贪婪匹配，仍可继续使用但不建议新增）。
2. 兼容修复：`store.ts` 的 `canonicalSecretPath` / `matchMcpEnvKey` 等密文路径匹配改贪婪段——前提核实「env 键 / header 名不含 `.`」在仓内是硬约定（查 schema 校验与文档；不成立则改用「按已知后缀从右往左拆分」的等价方案，同样救存量）。
3. 入口校验：`schema.ts` 的 `McpServerSchema.name` 加 pattern 校验（同款正则）；五个设置页输入加同款校验与明确错误提示（名称只能含字母、数字、下划线、连字符）——五处用同一正则常量口径，不写五份漂移实现（渲染层拿不到 shared 常量就在各文件顶部本地同值常量并注释同源）。
4. 测试：`store.test.ts` 加「含点 provider id 的密文路径可匹配」用例（如 `llm.providers.api.deepseek.apiKeyEnc` 能定位 provider `api.deepseek`；`mcp.servers.my.server.env.KEY` 能定位服务器 `my.server` 的 env 键 `KEY`）；`schema.test.ts` 加「MCP 名称含点被拒 / 合法名称通过」用例。
5. Conventional Commits 中文分组提交（`fix(config): ...` / `fix(settings): ...`），提交信息尾注覆盖的条目号（如 `...(P1-07)`）。

## 验收标准

- [ ] `pnpm vitest run packages/shared/src` 全绿，且含上述新用例（含点 id 匹配、schema 拒点）
- [ ] `pnpm typecheck` 通过（改了 shared 后先 `pnpm --filter @aurora/shared build` 再查下游）
- [ ] `docs/08-settings-onboarding.md` 有命名约定与存量兼容口径记载
- [ ] 代码核对：凭据链回归——设置页改一个既有 provider 的 key、保存、重进设置页能读回 `apiKeySet: true`（走 writeSecretField → readSecretField 全链），五个输入框的校验正则与提示一致

## 交接

- 五个设置页组件本步只动「名称输入校验」一处；step-09 会继续改同批文件的编辑态与试听——本步收尾保持组件可编译。
- 贪婪匹配的最终方案（正则贪婪 or 右往左拆分）写进「执行记录」。

## 执行记录

**提交**：`01e9172 fix(config): 含点名称的凭据路径匹配修复与资源名称校验`

**分片与结果**：单分片，1 个实现子代理（general-purpose）在 step-04 提交之上继续改。主代理复跑验收命令。

**「env 键 / header 名不含 `.`」前提核实 → 结论：不成立**（所以没用贪婪段方案）
1. **Schema 校验**：`McpServerSchema.envEnc` / `headersEnc` 都是 `z.record(z.string(), z.string())` —— 键名**无任何字符集约束**。
2. **文档**：`docs/08` §1 只写「env 变量名由 `envEnc` 的键表达」，全仓 grep 不到「键名不含点」的约定。
3. **输入侧**：`McpSection.add()` 按 `KEY=value` 逐行取键，**不做字符集校验** —— 含点键可被用户造出，且旧实现本来就支持含点键。
4. **协议层**：HTTP header 名按 RFC 7230 的 token 定义**允许** `.`。
5. **反证**：若按「名称 `(.+)` + 键段 `[^.]+$`」的贪婪方案，会把**今天能用的含点键**（`mcp.servers.foo.env.A.B`）弄坏——那是新增回归。

**最终匹配方案（本文件第 42 行要求留档）**
- **provider 路径**：id 段由 `([^.]+)` 改**贪婪 `(.+)`** —— 后缀 `.apiKey(Enc)?` 固定，贪婪只会吃掉 id 里多出来的点，无歧义。
- **MCP 路径**：改用**「按已知标记从右往左拆分」**（方案②的等价形式）—— 新增 `splitMcpSecretPath` + `MCP_SECRET_MARKERS`，取**最后一个**受控标记（`.env.` / `.envEnc.` / `.headers.` / `.headersEnc.`）用 `lastIndexOf` 从右往左拆，不依赖正则回溯。`matchMcpEnvKey` / `matchMcpHeaderKey` / `canonicalSecretPath` 的 MCP 分支统一走它。
- 凭据链后四处（`readSecretField` / `writeSecretField` / `toPersisted` / `redactSettings`）**实现零改动**，只是它们调用的匹配函数换了实现。

**额外一处（在白名单内但不在 step 字面里，子代理主动报告、主代理确认必需）**：`store.ts` 新增 `normalizeLegacyMcpServerNames(raw, logger)`，在 `init()` 里紧跟 `pruneUnknownWindowState` 调用（`repaired` 一并置位，立刻落盘）。理由：`McpServerSchema.name` 一旦禁点，`mcp.servers` 是**数组**（`sanitizeWithDefaults` 对数组整体保留、不逐项回退），存量含点名称会一路活到 `SettingsSchema.parse` 硬抛 → 走「备份 + 重建出厂配置」，**用户所有 provider / 课表 / 项目一起消失**。`migrations.ts` 不在白名单内，无法用版本迁移承接，故仿 `pruneUnknownWindowState` 只修这一处（`.`→`-`，冲突追加 `-2`…，改名不丢数据、密文在条目内部随条目搬走）。

**其余改动**：`schema.ts` 新增 `RESOURCE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/` 与统一文案常量 `RESOURCE_NAME_RULE`，`McpServerSchema.name` 加 `.regex(...)`；五个设置页（LlmPage / TtsSection / SttSection / ImageGenSection / McpSection）在各自唯一的新增入口插入同一条判定，正则与文案都从 `@aurora/shared/browser` 取（**没有第五份副本**）；`docs/08` 新增 `### 1.3 资源名称约定与凭据路径（P1-07）`，条目编号稳定（`§1.1` / `§1.2` 原样未动，docs/02 与 `classification-history.ts` 对「08 §1.2」的引用不受影响）。

**验证（主代理实跑）**
```
pnpm vitest run packages/shared/src → 7 files / 187 tests 全绿（新增 5 条：schema 1 + store 4）
pnpm typecheck                      → 全部 Done（先 pnpm --filter @aurora/shared build）
pnpm test                           → 115 files / 2028 tests 全绿
```
新增用例：`mcp.servers.my.server.envEnc.KEY → mcp.servers.my.server.env.KEY` 归一化；含点 provider id 的 `setSecret→getSecret→clearSecret` 全链与磁盘无明文；存量含点 MCP 名 init 规整且密文可用、不判 `corrupted`；规整避让既有合法名（追加 `-2`）；`my.server` / `api.deepseek` / 空串被 schema 拒，`my-server` / `my_server` / `smoke-mcp-123` / `deepseek` 通过。

**遗留 / 注意**
- 验收里「`mcp.servers.my.server.env.KEY` 能定位服务器 `my.server`」是在 `canonicalSecretPath` 层覆盖的，**不是在活的 `SettingsStore` 上**：加了 schema 禁点后，解析后的 Settings 里不可能存在含点 MCP 名（存量在 init 被规整），无法走完整 store 往返。含点 provider id 则有完整 store 往返用例。
- **已知歧义**（已写进 docs/08 §1.3 与代码注释）：「最后一个标记为准」意味着**键名自身含标记词**时会误判（键名写作 `env.KEY` 时名称会把键的前半段吃掉）。这是取舍，不是疏漏。
- 验收第 4 条后半段（真实设置页改 key → 重进读回 `apiKeySet: true`）**未跑 Electron**；store 层等价证据充分（`writeSecretField → readSecretField` 往返、`clearSecret`、既有「重启后仍能解密读回」用例），`settings-redact.ts` 拼 `${prefix}.providers.${id}.apiKey` 并走 `getSecret`（含点 id 也走贪婪匹配）。

