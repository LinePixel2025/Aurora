# Step 02 — 自动续轮每轮重读会话组装历史（修「第二轮丢上下文」）

- Task: agent-context-boundary-fixes
- Step: 2 / 5
- Status: done
- Depends on: step 1
- Produces: `KernelAgentHost` 的 attempt 循环内每轮重新读取会话并组装历史与系统提示；`agentHost.test.ts` 新增「续轮请求带本轮提问与上一轮工具结果」用例；docs/06 §4.1 与 AGENTS.md 补上这条不变量
- Phase: 核心链路
- Writes: `packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`docs/06-agent-core.md`（§4.1 自动续轮条目）、`AGENTS.md`（可在「几个容易踩的接线点」补一条）、`step/step-02-auto-continue-context.md` 与 `step/00-index.md`（执行记录回填）
- Risk: 把用户消息重复 push 或重复落盘（续跑最经典的坑）；退法 = 回滚 commit。判定基准：既有「自动续轮：maxRounds=1 + 额度 2 → 跑满 3 轮」「续跑不重复落盘用户消息」等用例必须继续全绿

## 目标

轮次用尽后的**自动续轮**（`agent.loop.autoContinueRounds`，默认 2）发出的请求，与手动点「继续」一样带上「本轮提问 + 已执行过的工具及结果」，模型不再盲目重复已做过的写 / 命令操作。

## 输入

- 根因（已实测核对，2026-09-26）：`packages/agent-core/src/host/agentHost.ts` 中「读会话 + 压缩」块（约 468–501 行：`quickWindowMs → sessions.get → filterMessagesWithinWindow → compressHistory → const history = compression.messages`）与系统提示组装块（约 503–528 行：`readSettingsHint / readTodoSummary / readProjectInstructions / buildSystemPrompt`）都在 `for (;;)` attempt 循环（537 行起）**之外**执行一次；自动续轮分支（约 728–756 行，命中即 `continue`）复用同一份旧 `history` / `systemPrompt` 新建 `runAgentLoop`。
- `packages/agent-core/src/loop/agentLoop.ts` 的前提：186–205 行 `messages = [system, ...toMessages(history)]`，且 `appendUserMessage === false` 时**既不落盘也不 push** 用户消息——其注释假设「那条用户消息已经在 history 里」。首 attempt 的 `history` 是**请求前**快照（不含本轮提问，靠 push 补上）；续轮 attempt 的 `appendUserMessage` 已被置 false（720 行），于是旧快照 + 不 push = **既无提问也无 attempt 1 的助手/工具消息**。这就是报障的「第二轮没有本轮提问、也没有上一轮工具结果」。
- 手动续跑为什么安全：`apps/desktop/src/main/ipc.ts` 的 `resumeJob`（约 949 行）走一次全新 `send`，会话在请求开头重读，用户消息与历史都在 `history` 里。
- 修复不变量：**续轮 attempt 的 history 必须来自重读会话**（含 attempt 1 落盘的用户消息与全部助手/工具消息），语义与手动 resume 完全对齐；`appendUserMessage` 的判定不动。
- 可注入性依据：`sessions.get(sessionId)` 返回该会话内存态消息（`append` 即时进内存），attempt 循环里重读拿到的一定包含上一 attempt 落盘的全部内容。
- 测试基建：`packages/agent-core/src/testing/fakeProvider.ts:31-55` 的 `createFakeProvider` 把每次 `chat()` 的 `messages` **拷贝快照**进 `calls`（能观察每个 attempt 的请求内容）；`packages/agent-core/src/host/agentHost.test.ts` 的 job 生命周期 describe（1048 行起）已有 `maxRounds` / `autoContinueRounds` getter 注入点（61–66 行）与「自动续轮：maxRounds=1 + 额度 2 → 跑满 3 轮才 paused」用例（1464 行起）可参照。harness 注册了 `echo` 工具，其结果文本形如 `echo:<arguments.text>`。
- 验证命令（仓库根）：`pnpm --filter @aurora/agent-core build`（改了 agent-core 必须重建再跑下游 typecheck，AGENTS.md 坑位）、`pnpm vitest run packages/agent-core/src/host/agentHost.test.ts`、`pnpm vitest run packages/agent-core/src/loop/agentLoop.test.ts`（循环本身不改，回归确认）。
- docs/06 §4.1 的「自动续轮」条目在约 150–154 行。

## 操作

1. **先改文档**：`docs/06-agent-core.md` §4.1「自动续轮」条目补一句：续轮等价于一次自动 resume——**每个 attempt 开始前重新读取会话并按 `compressHistory` 组装历史**（与手动续跑同一口径），因此续轮请求必须带本轮提问与已回填的工具结果；否则模型会重复已执行的写 / 命令操作。
2. 改 `packages/agent-core/src/host/agentHost.ts`：把「读会话 + 压缩 + buildSystemPrompt」两段（468–528 行范围，即从 `const quickWindowMs` 到 `const systemPrompt = buildSystemPrompt({...})` 结束）整体移入 `for (;;)` 循环体**开头**，每 attempt 重算一次：
   - `storedMessages` / `scopedMessages` / `compression` / `history` / `systemPrompt` 改为循环内 `const`（原来引用它们的位置——`runAgentLoop({ history, systemPrompt, ... })` 与滚动摘要 `this.summaries.set(sessionId, ...)`——都在循环内，直接可用）；
   - 循环外的 `userInput` / `extraContext` / `job 建档` / `maxRoundsLimit` / `maxTotalTokens` / `autoContinueLimit` 等保持不动；
   - `attemptUsedTokens` 与游标读取（540–545 行）原本就在循环内，不动；
   - **每 attempt 重算滚动摘要是本修复的既定行为**（续轮等价于一次自动 resume，与手动续跑同口径）：超预算时每个 attempt 会多一次 summarize 调用、`已完成历史摘要压缩` 日志可能多条——不算回归，不要为此加去重逻辑。
3. 在 `agentHost.test.ts` 的 job 生命周期 describe 新增用例「自动续轮的请求带本轮提问与上一轮工具结果」：
   - 参数：`maxRounds: () => 1`、`autoContinueRounds: () => 2`（额度 2 → 恰共 3 个 attempt、每 attempt 1 轮 = 3 次 provider 调用；与既有用例「maxRounds=1 + 额度 2 → 跑满 3 轮」同参）；
   - `rounds` 脚本 = 第 1 轮 `toolCalls:[{id:'c1',name:'echo',arguments:'{"text":"q"}'}]`、第 2 轮 `toolCalls:[{id:'c2',name:'echo',arguments:'{"text":"r"}'}]`、第 3 轮 `{text:'完成'}`；`send('问题X')`；
   - 断言 `provider.calls` 共 **3** 次；**`calls[1]`（attempt 2 的首请求 = bug 现场）**的 `messages`：含内容带 `问题X` 的 user 消息、且含 attempt 1 的工具结果 `echo:q`（序列化整段 messages 后 `toContain(...)` 即可）；**`calls[2]`** 含 `echo:r`；
   - 断言三次请求中 `问题X` 作为 user 消息各出现**一次**（`messages.filter(m => m.role === 'user' && JSON.stringify(m).includes('问题X')).length === 1`），防「重读后重复 push」；
   - 会话侧 `sessions.get` 的 user 消息恰为 1 条（沿用既有用例的写法）。
4. `AGENTS.md`「几个容易踩的接线点」补一条：attempt 循环（自动续轮）内**必须重读会话组装 history**——`agentLoop` 在 `appendUserMessage=false` 时不补用户消息，快照外置于循环 = 续轮丢上下文（本仓库修复记录，防回退）。

## 验收标准

- [ ] `pnpm vitest run packages/agent-core/src/host/agentHost.test.ts --reporter=verbose` 全绿，输出中逐字出现新用例名；其四个断言（`calls[1]` 含 `问题X` 与 `echo:q`、`calls[2]` 含 `echo:r`、每次请求 user 消息计数 1、会话落盘 user 消息 1 条）都在。
- [ ] 修复前的反证（必做）：**只回退生产代码、保留测试**——`git stash push -- packages/agent-core/src/host/agentHost.ts` 后跑同一命令，新用例必须**失败**（贴出失败断言名），随后 `git stash pop` 恢复再跑绿。禁止裸 `git stash`（会连带收走测试与上一步未提交改动，反证变成空跑）。
- [ ] `pnpm --filter @aurora/agent-core build` 成功；`pnpm vitest run packages/agent-core/src/loop/agentLoop.test.ts` 全绿（循环层未动）；`pnpm typecheck && pnpm test` 全仓绿。
- [ ] `grep -n "重新读取会话" docs/06-agent-core.md` 在 §4.1 自动续轮条目命中（文档先行落地）。

## 交接

- 给 step 4：新用例名与所在文件（用于全量回归对照）；若 quick 会话滑动窗口 / 滚动摘要因每 attempt 重算出现断言抖动，记录为遗留问题交 step 4 复核，不自行放宽断言。

## 执行记录

**提交**：`8284226 fix(agent-core): 自动续轮每个 attempt 重读会话组装历史，修第二轮丢上下文`（4 文件，+122/−62）

**分片**：本步改动集中于 `agentHost.ts` 同一段逻辑（整块移动 + 测试配对），按并行原则判定为**假并行禁区**，主代理独立完成；无子代理。

**实际改动**：

- `docs/06-agent-core.md` §4.1「自动续轮」条目（docs-first）：补「续轮等价于自动 resume，每个 attempt 开始前**重新读取会话并按 `compressHistory` 组装历史**（系统提示同步重算），否则 `appendUserMessage = false` 的语义前提不成立、模型重复已执行操作」。
- `packages/agent-core/src/host/agentHost.ts`：「读会话 + 压缩 + buildSystemPrompt」整块（原 468–528 行）移入 `for (;;)` 循环体开头，每 attempt 重算；块首新注释写明不变量与「每 attempt 重算滚动摘要（压缩日志可能多条）是既定行为、不是回归」。循环外的 `appendUserMessage` / `pendingReason` / `errorMessage` 与游标读取保持原位；`history` / `systemPrompt` 改循环内 `const`，唯一消费点（`runAgentLoop` 入参）本就在循环内，grep 复核无循环外引用。
- `packages/agent-core/src/host/agentHost.test.ts`：新增用例「自动续轮的请求带本轮提问与上一轮工具结果（每 attempt 重读会话组装历史）」——`maxRounds:1` + 额度 2、rounds 脚本 c1(echo q)/c2(echo r)/文本收尾；断言 `provider.calls` 恰 3 次、`calls[1]` 序列化含「问题X」与「echo:q」、`calls[2]` 含「echo:r」、**每次请求**带提问的 user 消息恰 1 条（防重复 push）、会话落盘 user 提问恰 1 条；job 收敛 `done`。
- `AGENTS.md`「几个容易踩的接线点」新增承重 bullet（含回归护栏用例名）。

**验收（主代理实跑）**：

1. `pnpm --filter @aurora/agent-core build` ✅。
2. `pnpm vitest run packages/agent-core/src/host/agentHost.test.ts --reporter=verbose`：**60 passed**，新用例名逐字出现 ✅。
3. **修复前反证**：`git stash push -- packages/agent-core/src/host/agentHost.ts`（仅生产代码，测试与 step-01 未提交改动不受影响）后跑同一用例 → **失败**，失败断言即 bug 现场：`FAIL … 自动续轮的请求带本轮提问与上一轮工具结果 — AssertionError: expected '[{"role":"system",…' to contain '问题X'`；`git stash pop` 恢复后复跑绿 ✅。
4. `pnpm vitest run agentHost.test.ts agentLoop.test.ts` 合计 **95 passed**（循环层未动，回归确认）✅。
5. `pnpm typecheck` ✅；`pnpm test` 全仓 **1498 passed**（较 step 1 后 +1）✅；`pnpm format:check`（两处新改动经 prettier --write 归一后复绿）✅；`pnpm lint` ✅；`pnpm build` ✅。
6. `grep "重新读取会话" docs/06-agent-core.md` 命中 §4.1 条目（154 行）✅。

**遗留**：无断言抖动（quick 滑动窗口 / 滚动摘要的既有用例全部原样通过）；step 3 依赖的「手动继续仍安全」未在本步触碰（`ipc.ts` 零改动）。
