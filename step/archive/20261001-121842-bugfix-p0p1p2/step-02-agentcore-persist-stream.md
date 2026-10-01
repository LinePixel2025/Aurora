# Step 02 — agent-core 持久层与流式可靠性

- Task: bugfix-p0p1p2
- Step: 2 / 12
- Status: done
- Depends on: none
- Produces: 流式生成全程可中止、TextDecoder 复用、中断轮 tool_call 收敛为 error；SessionStore 读盘两态区分与删除竞态修复；JobStore origin 白名单补齐；配套单测
- Phase: 核心链路
- Writes: `packages/agent-core/src/llm/openai-compat.ts`、`packages/agent-core/src/llm/openai-compat.test.ts`、`packages/agent-core/src/session/store.ts`、`packages/agent-core/src/session/store.test.ts`、`packages/agent-core/src/jobs/store.ts`、`packages/agent-core/src/jobs/store.test.ts`、`packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/loop/agentLoop.test.ts`
- Size: M
- Risk: abort 语义影响所有 LLM 调用方——改错会把正常完成也取消；先读懂 `chat()` 现有 finally 时序与 `agentLoop` 的 job 终态写点再动手，回归以 openai-compat.test.ts 与 agentLoop.test.ts 全量绿为准

## 目标

用户点「停止」能真正取消流式生成（连接关闭、job 终态保持 aborted）；中文长回复跨 chunk 不再乱码落库；流中断后未执行的 tool_call 不再永久 running；瞬时读盘错误与删除竞态不再冲掉会话历史；center / automation 来源的 job 重启后可见、可续跑。

## 输入

- `bug/P1-严重.md` 的 P1-08、P1-09、P1-10 与 `bug/P2-一般.md` 的 P2-01、P2-02、P2-03（每条含 文件:行、触发条件与修复建议）；证据细节在 `bug/_raw/U1-agent-core.md`
- 源码：`packages/agent-core/src/llm/openai-compat.ts`（读流循环约 133-193，`new TextDecoder()` 在约 148 行循环体内；abort 转发监听在拿到响应头的 finally 即被移除，约 350-353）；`packages/agent-core/src/session/store.ts`（读盘异常当「不存在」约 618-623；remove 与在途写竞态约 254-267）；`packages/agent-core/src/jobs/store.ts`（ORIGINS 约 632 行 = `['chat','edge-bar','resume']`，toAgentJob 的 isOrigin 校验约 644）；`packages/agent-core/src/loop/agentLoop.ts`（failed 分支约 274-300）
- origin 的五值类型定义在 `packages/shared/src/ipc/types.ts`（约 1076 行，含 `center` / `automation`）
- 同目录 `jobs/store.ts` 已用 `isAbsent` 正确区分「文件不存在」与读错误——SessionStore 修复时对照它

## 操作

1. P1-09（一行级）：`openai-compat.ts` 把 `TextDecoder` 提到读流 `while` 循环外创建一次、全程复用，保留 `{ stream: true }`。
2. P1-08：外部 signal → 内部 controller 的 abort 转发监听保持到**流读取结束**（不在拿到响应头后就移除）；读流循环感知 abort 后 `reader.cancel()` 并结束生成器；单请求超时计时覆盖整个流而非首字节；提前返回 / 异常路径都执行 `reader.cancel()`。
3. P2-03：`agentLoop.ts` 流中途失败分支，落盘前把本轮已产出但未执行的 tool_call 全部置 `state: 'error'`（summary 注明「流中断未执行」）。
4. P2-01：`session/store.ts` 读盘按 `error.code === 'ENOENT'` 判两态——非缺失错误不置 `loaded`、不返回空快照（下次重试口径），杜绝「空快照冲盘」。
5. P2-02：`session/store.ts` 的 `remove()` 先 await（并吞掉）该 id 的在途写盘 promise，再清态、删文件（对照同文件 `setArchived` 的既有做法）。
6. P1-10：`jobs/store.ts` 的 `ORIGINS` 补 `'center'` 与 `'automation'`；加同步护栏测试断言白名单与 `packages/shared/src/ipc/types.ts` 的 origin 联合类型五值一致（agent-core 若不便引 shared 类型，则在测试里硬编码五值断言）。
7. 补单测（见验收标准）；Conventional Commits 中文分组提交（`fix(agent-core): ...`），提交信息尾注覆盖的条目号（如 `...(P1-08, P2-01)`）。

## 验收标准

- [ ] `pnpm vitest run packages/agent-core/src` 全绿，且新增用例覆盖：① 多字节字符跨 chunk 不产生 U+FFFD（如把「中」的 3 字节拆进两个 chunk）；② 流中途 abort 时生成器及时结束且底层 reader 被取消；③ 工具调用增量已产出后流断开，落盘 tool_call 为 `error` 态；④ 读盘抛非 ENOENT 错误（如模拟 EPERM）不置 `loaded`、不覆盖盘上数据；⑤ 在途写期间 remove 后文件保持已删除；⑥ origin 为 `center` / `automation` 的 job 落盘重启后 `get` / `list` 可见
- [ ] `pnpm typecheck` 通过（改了 agent-core 源码后若下游报类型缺失，先 `pnpm --filter @aurora/agent-core build` 再查）

## 交接

- P1-10 补齐后，主进程 `apps/desktop/src/main/agent-host.ts` 写侧的 `as` 强转（约 498 行）值得收紧类型——但该文件**不在任何 step 的写范围白名单内**，本步不动它也不改它，仅在「执行记录」留一句备注供后续任务处理。
- job 终态语义（abort 保持 aborted）是 step-11 全量回归的关注点之一。

## 执行记录

**提交**：`7e62dfb fix(agent-core): 流式中止与解码可靠性、会话读盘两态、job origin 补齐`

**分片与结果**：单分片，1 个实现子代理（general-purpose）。主代理复跑全套验收命令。

**实际改动**
- `llm/openai-compat.ts`：P1-09 `TextDecoder` 提到读流 `while` 外创建一次、全程复用（`decode(value, { stream: true })` 不变）。P1-08 新增 `RequestScope`（`controller` / `rearm()` / `release()`）与 `createScope()`：`chat()` 自己持有作用域到流读完，`fetchOnce` 只释放自有作用域（`listModels` / `probeChat` 行为不变）；读流改为 `await Promise.race([reader.read(), aborted])`；`finally` 里 `await reader?.cancel()` + `scope.release()`，覆盖正常读完 / `[DONE]` 提前收尾 / 异常 / 生成器提前 return 四条路径；`openStream` / `postStream` / `fetchWithPolicy` / `fetchOnce` 增加可选 `scope` 透传。
- `session/store.ts`：P2-01 `readFromDisk` 的 catch 由「一律返回空快照」改为 `if (await this.isAbsent(path, error)) return {messages:[],meta:{}}; throw error`；新增私有 `isAbsent`（三层：`error.code === 'ENOENT'` → 报文点名 ENOENT → `fs.exists` 探测，探测抛错按「不是缺失」处理）。`loaded` 不置位、`loading` 在 `finally` 清掉，下次访问重试。P2-02 `remove()` 在清掉定时器/脏标记之后、清内存态之前插入 `await (this.writing.get(id) ?? Promise.resolve()).catch(() => undefined)`。
- `jobs/store.ts`：P1-10 `ORIGINS` 补齐 `'center'` / `'automation'`（五值），注释改为「必须与 `AgentJob['origin']` 逐字对齐」。
- `loop/agentLoop.ts`：P2-03 `failed` 分支落盘前 `for (const call of calls) { call.state = 'error'; call.outputSummary ??= '流中断未执行' }`；同一分支在落盘之后若 `options.signal?.aborted === true` → `yield { type:'done', pending:true, pendingReason:'aborted', round, usedTokens }` 并 return。

**超时口径（唯一一处自主判断，风险行警告的就是它）**：操作 2 原文「单请求超时计时覆盖整个流」，实现为**整个流期间保持武装 + 每收到一片数据 `rearm()` 重新计时**（= 停滞 60s 超时），**不是**「响应总时长 60s 硬上限」。理由：`timeoutMs` 默认 60s 且 `main/agent-host.ts:175` 不传，总时长上限会掐断正常长回复，正是本步 Risk 行警告的「把正常完成也取消」。用例「正常传输的长回复不会被『总时长』掐断」钉住了该选择（总时长 240ms > 超时 150ms 且每片 40ms）。若要字面口径，需同时改该用例并抬高默认 `timeoutMs`。

**额外一处（在 `agentLoop.ts` 白名单内，超出 7 条操作）**：修好 abort 后流中途被取消会以 provider 的 `error` 事件（E_ABORTED）结束，而内核装配层 `host/agentHost.ts:805-808` 对**任何** error 事件执行 `finishJob({ status: 'error' })`，会把 `agent.abort()` 乐观落的 `aborted` 反手改成 `error` —— 与「abort 后 job 终态必须保持 aborted」冲突。`host/agentHost.ts` **不在任何 step 的白名单里**，故在循环层收敛（`signal.aborted` → `done + pendingReason:'aborted'`，host 第 845 行映射为 `finishJob({status:'aborted'})`）。

**验证（主代理实跑）**
```
pnpm vitest run packages/agent-core/src   → 37 files / 735 tests 全绿
pnpm test                                 → 115 files / 2028 tests 全绿
pnpm typecheck                            → 全部 Done
```
子代理另做反向复核（逐条还原修复，10 条新用例 + 1 条整体 FAIL，143 条旧用例保持绿，随后从备份逐字节还原并复跑全绿）。

**遗留 / 注意**
- **行为变化需下游知晓**：`SessionStore.get / summaries / append` 在非 ENOENT 读错误上现在**上抛**（不再静默给空会话）。消费点：`ipc.ts` 的 `chat:history`/`chat:sessions`、`index.ts:2632/2645/3492/3515`。渲染层此前会看到「空历史」，现在会看到一次 IPC 失败并在下次访问自愈——语义更正确，但若要给用户友好文案，属 step-06/step-10 范围。
- **P1-10 交接（留档）**：`apps/desktop/src/main/agent-host.ts:498` 的 `as AgentJob['origin']` 强转现在可以收紧为真实联合类型；本步按约定未动。
- job 终态语义（abort 保持 aborted）的最终端到端确认在 step-11 的 smoke `cancelOk`。

