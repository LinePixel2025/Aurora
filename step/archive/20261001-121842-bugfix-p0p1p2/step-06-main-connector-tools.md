# Step 06 — 主进程连接器、MCP 凭据、工具与自动化

- Task: bugfix-p0p1p2
- Step: 6 / 12
- Status: done
- Depends on: none
- Produces: Center 连接器关闭再启用可重连；MCP 凭据仅轮换值即触发重连；web_fetch 超时覆盖 body 且限量读取；免确认命令模式堵住「尾部裸 *」口子；daily 触发器错过补偿；配套单测
- Phase: 核心链路
- Writes: `apps/desktop/src/main/center/connector.ts`、`apps/desktop/src/main/center/connector.test.ts`、`apps/desktop/src/main/mcp.ts`、`apps/desktop/src/main/mcp.test.ts`（新建）、`apps/desktop/src/main/tools/web-fetch.ts`、`apps/desktop/src/main/tools/web-fetch.test.ts`（既有文件，扩展超时/限量用例）、`packages/agent-core/src/tools/command-allow.ts`、`packages/agent-core/src/tools/command-allow.test.ts`、`apps/desktop/src/main/automation/conditions.ts`、`apps/desktop/src/main/automation/conditions.test.ts`、`docs/13-automation.md`
- Size: M
- Risk: signatureOf 改含值序列化时注意它可能落日志——只能比较、不得输出密文；免确认匹配收紧可能让用户既有模式失效（`git *` 从「放行任意拼接」变成「只放行单段」）——这是修复目标本身，但提交信息里写清楚行为变化

## 目标

设置页关掉再打开 Aurora Center 后连接器能重建；轮换泄漏的 MCP token 立即生效于运行中的连接；web_fetch 不再被慢速 body 挂起数分钟；`git *` 类免确认模式不再放行 `;` 拼接的任意命令；daily 触发器错过触发分钟后当天仍补触发一次。

## 输入

- `bug/P1-严重.md` 的 P1-04、P1-05 与 `bug/P2-一般.md` 的 P2-09、P2-10、P2-11（每条含 文件:行、触发条件与修复建议）；证据在 `bug/_raw/U4-config-classify-media-center.md`（P1-04/P1-05）与 `bug/_raw/U3-tools-automation.md`（P2-09/P2-10/P2-11）
- 源码：`apps/desktop/src/main/center/connector.ts`（`onConfigChanged` 的 stopped 守卫约 218-224、`stop()` 置位约 201-210）；`apps/desktop/src/main/mcp.ts`（`signatureOf` 约 110-124 只取键名、`apply()` 短路约 52-56）；`apps/desktop/src/main/tools/web-fetch.ts`（约 41-59，clearTimeout 在拿到响应头即执行）；`packages/agent-core/src/tools/command-allow.ts`（文本匹配约 57-67，`*` 编译为 `.*` 含空格分号）；`apps/desktop/src/main/automation/conditions.ts`（daily 精确匹配约 66-67）
- 语义口径（AGENTS.md / docs/13）：免确认匹配是「减少打扰」而非安全加固，但文件头自述「任何『一条模式放行全部命令』的口子都必须堵死」；daily 与 interval 的「错过」语义要一致
- 消费点：免确认匹配的调用方 `apps/desktop/src/main/agent-host.ts` 约 310-326（本步预计不改它；若必须改，先核对写范围——它不在任何 step 白名单，需回主会话调整计划）

## 操作

1. P1-04：`connector.ts` 拆开 `stop()` 的两种语义——`onConfigChanged` 的关闭分支只做「拆 socket + 清定时器 + 置 disabled」（可逆），`stopped = true` 保留给 `dispose()`（不可逆停机）；再启用时走既有重建路径。
2. P1-05：`mcp.ts` 的 `signatureOf` 的 env / headers 部分改含值的稳定序列化（按键排序后 `JSON.stringify` 整个密文对象）——签名仅用于比较，不落日志明文；键名集合不变、值变 → 签名变 → `apply()` 不再提前返回。
3. P2-09：`web-fetch.ts` 超时计时覆盖到 body 读完（拿到响应头不再 clearTimeout）；body 改限量流式读取——读满 `maxChars` 对应字节即 abort，不再 `response.text()` 整体读入。
4. P2-10：`command-allow.ts` 免确认文本匹配改为按 `;` 与换行拆段、**每一段**都命中模式才放行（`X *` 尾部裸通配因此只放行单段命令）；既有纯通配与花括号语义不回退。
5. P2-11（文档先行）：`docs/13-automation.md` §4 写明 daily 错过补偿语义；`conditions.ts` 的 daily 改「今天的 at 已过且当日键未触发」即匹配（键已含日期、天然幂等，与 interval 桶语义一致）。
6. 测试：`connector.test.ts` 加「disable → enable → 重新建连」用例（真实类可测，报告 U4 复现过）；新建 `apps/desktop/src/main/mcp.test.ts` 断言 `signatureOf`——仅轮换值签名变、键值均未变签名不变；`command-allow.test.ts` 加「`git *` 不放行 `git status; <任意语句>`、单段纯命令仍放行」；`conditions.test.ts` 加「错过 1 分钟补触发一次、同日不重复触发」；`web-fetch.test.ts`（可选）用 node:http 起本地挂起服务验证 body 超时与限量。
7. Conventional Commits 中文分组提交（`fix(center): ...` / `fix(mcp): ...` / `fix(tools): ...` / `fix(automation): ...`），提交信息尾注覆盖的条目号（如 `...(P1-04, P2-09)`）。

## 验收标准

- [ ] `pnpm vitest run apps/desktop/src/main packages/agent-core/src/tools` 全绿，且含上述新用例（连接器重连、签名含值、拆段匹配、daily 补偿；若写了 web-fetch 用例则一并在内）
- [ ] `pnpm typecheck` 通过
- [ ] `docs/13-automation.md` §4 有 daily 补偿语义记载
- [ ] 代码核对：`signatureOf` 的序列化结果没有进入任何日志输出；`connector.ts` 的 `dispose()` 仍置 `stopped` 且应用退出路径不受影响

## 交接

- `mcp.test.ts` 的 `signatureOf` 断言口径供 step-11 全量回归与代码审查引用。
- P2-10 的行为变化（既有 `X *` 模式含义收紧）写进「执行记录」——若用户设置里已有此类模式，release notes 需提及（发版不在本计划内，仅留痕）。

## 执行记录

**提交**：`33ecede fix(main): Center 连接器可逆停机、MCP 签名含值、web_fetch 限时限量、免确认拆段、daily 补偿`

**分片与结果**：单分片，1 个实现子代理（general-purpose）。主代理复跑全套验收命令。

**实际改动**
- `center/connector.ts`（P1-04）：新增 `private halt()`（拆 socket + 清定时器 + `setState('disabled')` + `attempt=0`）**不置 `stopped`**；`stop()` = `stopped = true` + `halt()`；`dispose()` 仍 = `disposed = true` + `stop()`；`onConfigChanged` 的 `!config.enabled` 分支由 `this.stop()` 改 `this.halt()` → 再启用时落到既有重建路径。
- `mcp.ts`（P1-05）：`signatureOf` 的 `envEnc` / `headersEnc` 由 `Object.keys().sort()` 改为 `stableEntries()`（按键排序的 `[键, 密文]` 二元组）；导出该纯函数并把入参收窄为 `Pick<Settings,'mcp'>` 以便单测。
- `tools/web-fetch.ts`（P2-09）：`clearTimeout` 只在最外层 `finally`（新增 `timedOut` 标志）；body 由 `response.text()` 改 `readBodyLimited()`（按 chunk 解码、累计到 `maxChars × 4`（`BODY_READ_HEADROOM`）即 `controller.abort()`、复用 `TextDecoder`、`truncated` 标志）；因限量中断时截断文案只报「已截断」而不报错误的原文总长。
- `agent-core/src/tools/command-allow.ts`（P2-10）：`matchAllowPatterns` 改为按 `/;|\r\n|\n|\r/` 拆段（`splitCommand`，忽略空白段），**每一段**都要命中某个模式才放行；返回第一段命中的模式（审计留痕口径不变）；原单串匹配逻辑搬进 `matchSegment`。
- `automation/conditions.ts`（P2-11）：`evaluateDaily` 的 `nowMinutes !== at` 改为 `nowMinutes < at` 不匹配（键 `daily-<ymd>-<at>` 含日期，天然幂等）。
- `docs/13-automation.md`（文档先行）§4.1：daily 行语义改「当天 `at` 已过且当日键未触发即补触发」，并加「missed 补偿」说明。

**验证（主代理实跑）**
```
pnpm vitest run apps/desktop/src/main packages/agent-core/src/tools
  → 71 files / 1165 tests 全绿（connector 33 / mcp 7 / web-fetch 7 / conditions 30 / command-allow 42）
pnpm typecheck → 全部 Done
pnpm test      → 115 files / 2028 tests 全绿
```
代码核对（验收第 4 条）：`signatureOf` 全仓仅 2 个非测试调用点（`mcp.ts:54-56` 与 `connector.ts` 的同名私有方法、语义无关）；`mcp.ts` 唯一日志是 `75: this.logger.error('MCP 配置应用失败', { error: String(error) })`，不含签名 —— 签名里序列化的是**密文**，只比较、不落盘。`dispose()` 仍置 `stopped`（`connector.ts:213-216`），应用退出路径 `index.ts:3974 centerConnector?.dispose()` 不变，并有「dispose() 不可逆：之后 onConfigChanged 不再重连」用例。

**行为变化清单（发版时需写进 release notes）**
1. **P2-10（用户可感知）**：`X *` 类免确认模式从「放行任意拼接整串」变为「**每一段都命中才放行**」。例：`git *` 不再放行 `git status; <任意语句>`（含换行拼接）；单段 `git status` 照常放行；尾部分号 / 空白段被忽略。存量含 `;` 拼接习惯的免确认模式会开始弹确认卡 —— 这是修复目标本身。
2. **P1-04**：设置页关闭 Center 改为**可逆暂停**，再启用会立即重连（此前必须重启应用）。
3. **P1-05**：仅轮换 MCP env / header **值**（键名不变）现在会触发该服务器 teardown + 重连（此前静默用旧凭据）。
4. **P2-09**：`web_fetch` 超时覆盖 body（响应头秒回但 body 停滞不再挂数分钟）；body 限量流式读取（约 4×`MAX_WEB_FETCH_CHARS` 字符即 abort）。
5. **P2-11**：daily 错过触发分钟后当天补触发一次（同日不重复，靠键 + firedKeys 去重）。

**遗留 / 注意**
- **P2-10 只按 `;` 与换行拆段**（严格照 step 操作 4 与 bug/U3 的修复建议）：`&&`、`||`、`|` 仍是未拆的分隔符，`git *` 依旧会放行 `git status && rm -rf /`、`git status | <命令>` —— 属同一类「一条模式放行全部命令」的口子，但**不在本步白名单语义内**，上报用户决定是否追加。
- **web-fetch 的 `readLimit = maxChars × 4` 是实现选择**（step 文字是「读满 `maxChars` 对应字节即 abort」）：卡死在 `maxChars` 会让 HTML 剥完标签的正文明显短于上限（既有测试「超长文本按 MAX_WEB_FETCH_CHARS 截断」也会因剥标签后长度恰好等于上限而丢标记）。内存上界仍是常数级 4×上限。
- `agent-host.ts`（免确认匹配消费点）**未改**，无需改。

