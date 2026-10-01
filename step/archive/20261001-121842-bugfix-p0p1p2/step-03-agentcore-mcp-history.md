# Step 03 — agent-core MCP 传输/注册与历史窗口

- Task: bugfix-p0p1p2
- Step: 3 / 12
- Status: done
- Depends on: none
- Produces: quick 会话时间窗过滤不再产生孤儿 tool 消息；MCP HTTP 传输增量解析响应、回传 Mcp-Session-Id；MCP 工具断开不再注销被覆盖的内置工具；配套单测
- Phase: 核心链路
- Writes: `packages/agent-core/src/session/history.ts`、`packages/agent-core/src/session/history.test.ts`、`packages/agent-core/src/mcp/transports.ts`、`packages/agent-core/src/mcp/transports.test.ts`、`packages/agent-core/src/mcp/hub.ts`、`packages/agent-core/src/mcp/hub.test.ts`、`packages/agent-core/src/tools/registry.ts`、`packages/agent-core/src/tools/registry.test.ts`
- Size: M
- Risk: HTTP 传输改增量解析是本步最重的改动——现有 transports.test.ts 的桩服务端都是「响应后关流」形状，改完要补「保持开流」的桩；历史过滤口径改动影响所有长会话，回归以 history.test.ts 全量绿为准

## 目标

窗口边界落在工具配对中间时，下一次请求不再被 provider 400 拒绝；规范 MCP 服务端（响应后保持 SSE 流开、下发 Mcp-Session-Id）能正常工作；MCP 同名工具断开/出错后内置工具恢复。

## 输入

- `bug/P1-严重.md` 的 P1-11 与 `bug/P2-一般.md` 的 P2-04、P2-05、P2-06（每条含 文件:行、触发条件与修复建议）；证据细节在 `bug/_raw/U1-agent-core.md`
- 源码：`packages/agent-core/src/session/history.ts`（`filterMessagesWithinWindow` 约 121-132，纯按 createdAt 过滤不保工具配对）；消费点 `packages/agent-core/src/host/agentHost.ts` 约 563-565（本步不改它，过滤口径修在 history.ts 内）；`packages/agent-core/src/mcp/transports.ts`（readSse 全量读完约 299-317、send 未回传 session id 约 241-292）；`packages/agent-core/src/tools/registry.ts`（register/unregister 约 105-121）；`packages/agent-core/src/mcp/hub.ts`（覆盖与注销调用点约 296-299、340-344、434-441）
- 同文件 `truncateHistory` 已有孤儿防御（只处理保留窗口起点）——窗口过滤的配对清理要与它口径一致

## 操作

1. P1-11：`history.ts` 的 `filterMessagesWithinWindow` 过滤后补配对清理——tool 结果的宿主 assistant 不在窗内时，连同该 tool 结果一起丢弃（或把窗口边界上的宿主 assistant 强制保留；二选一，与 `truncateHistory` 既有孤儿防御口径一致者优先）。
2. P2-04：`transports.ts` 的 HTTP 传输响应读取改增量——边读边解析 SSE，出现匹配当前请求 id 的 JSON-RPC 响应即返回，不等流关闭；读完即清理。
3. P2-05：initialize 响应捕获 `Mcp-Session-Id` 响应头，后续每次 send / notify 回传该头。
4. P2-06：`registry.ts` 的 register 覆盖同名工具时记录被替换的旧定义；unregister 时若当前定义来自 MCP 则恢复旧定义（MCP 工具走独立命名空间层的方案更大，不采用）；`hub.ts` 的断开/出错注销路径（约 296-299、340-344、434-441）接线恢复逻辑。
5. 补单测（见验收标准）；Conventional Commits 中文分组提交（`fix(agent-core): ...`），提交信息尾注覆盖的条目号（如 `...(P1-11, P2-04)`）。

## 验收标准

- [ ] `pnpm vitest run packages/agent-core/src/session packages/agent-core/src/mcp packages/agent-core/src/tools` 全绿，且新增用例覆盖：① 窗口边界落在 assistant(toolCalls) 与 tool 结果之间 → 过滤结果不含孤儿 `role:'tool'` 消息；② 服务端返回响应后保持 SSE 流打开 → 请求在超时窗口内正常返回；③ 服务端 initialize 下发 Mcp-Session-Id → 后续请求头携带它；④ MCP 工具覆盖内置同名工具后断开 → 内置工具恢复可调用
- [ ] `pnpm typecheck` 通过（如下游报类型缺失，先 `pnpm --filter @aurora/agent-core build` 再查）

## 交接

- 窗口过滤的最终口径（丢 tool 结果还是强制保留宿主 assistant）写进本文件「执行记录」，供代码审查与 docs/06 如需回填规格时引用。
- `host/agentHost.ts` 本次不改；若实现中发现必须改它，停下核对该文件是否与其他 step 的写范围冲突（它不在任何 step 的白名单里，需先回主会话调整计划）。

## 执行记录

**提交**：`8ab8acb fix(agent-core): 历史窗口工具配对、MCP 增量解析与会话 id、工具遮蔽恢复`

**分片与结果**：单分片，1 个实现子代理（general-purpose）。主代理复跑全套验收命令。

**实际改动**
- `session/history.ts`（P1-11）：`filterMessagesWithinWindow` 从「逐条按 createdAt 过筛」改为**工具组原子判定** —— 先用既有 `toolCallOwner` 算出每条消息的组头（tool 结果归宿主 assistant，其余各自成组，`null` = 真孤儿），组内任一条在窗内即整组保留，整组在窗外才整组丢弃，真孤儿无条件丢弃。`windowMs<=0` 短路与「返回新数组不改入参」语义保持原样。
- `mcp/transports.ts`（P2-04 + P2-05）：新增 `sessionId` 字段与 `buildHeaders()`（默认头 → 用户头 → **服务端分配的会话 id 最后覆盖**）；`send` 中 `response.ok` 后捕获 `mcp-session-id` 响应头并持久，此后 `send` / `notify` 都带上，`close()` 清空。`readSse` 改增量：`response.body.getReader()` 逐 chunk 用**复用**的 `TextDecoder` 解码，按空行（兼容 `\n` / `\r\n` / `\r`）切出完整事件，命中即 `return` 并在 `finally` 里 `reader.cancel()`；另加「尾部残缺块」兜底。`response.body === null` 时回落全量文本解析。
- `tools/registry.ts`（P2-06）：新增 `shadowed: Map<string, ToolDefinition>`，MCP 覆盖同名工具时**只记最早那一份**旧定义；`unregister` 删除后若有遮蔽记录则恢复并清掉遮蔽（只恢复一次）；`unregisterByPrefix` 改走 `unregister` 以继承同一语义。非 MCP 来源的同名注册仍被拒绝。
- `mcp/hub.ts`（P2-06 接线）：抽 `unregisterEntryTools(entry)`，**四个清理点全部改走它**（`registerTools` 重建 L298、`markError` L355、`handleTransportExit` 意外退出 L382、`teardown` L450）。

**窗口过滤的最终口径（本文件第 38 行要求留档）**：选择「**强制保留宿主 assistant**」，且做成**组级原子**（不是"逐条丢弃孤儿"）——
- 口径：`assistant(toolCalls)` + 其**全部** `tool` 结果是一个原子组；组内任一条落在窗内 → **整组保留**（宿主被向前回拉，允许出现一条早于 cutoff 的 assistant）；整组在窗外 → 整组丢弃；找不到宿主的**真孤儿 tool 一律丢弃**。
- 理由：① 与 `truncateHistory` 既有孤儿防御**同向**（它把保留区起点 `groupHead(...)` 回拉到宿主，只有 `groupHead === 自身` 才丢弃），本实现逐字对齐；② 逐条丢弃会漏掉**同组兄弟结果被边界切两侧**的情形（assistant 带 c1/c2，只留 c2 的结果 → provider 仍 400），组级判定一并堵死；③ 代价有界：现实里最多回拉一条 assistant（宿主与其结果时间上相邻），对 5 分钟窗口的上下文预算影响可忽略，随后 `truncateHistory` 仍会把超预算的整组一起裁掉；④ 真孤儿保留只会 400，丢弃是唯一合法处置。
- 影响面：与旧行为的差异只有三类 —— 宿主窗外/结果窗内（原来 400，现在整组保留）、兄弟结果被切（原来 400，现在整组保留）、真孤儿在窗内（原来 400，现在丢弃）；其余输入逐字不变。

**验证（主代理实跑）**
```
pnpm vitest run packages/agent-core/src/session packages/agent-core/src/mcp packages/agent-core/src/tools
  → 23 files / 426 tests 全绿
pnpm test      → 115 files / 2028 tests 全绿
pnpm typecheck → 全部 Done
```
新增 14 条用例（history +5 / transports +3 / registry +6 / hub +3）。子代理另做了 P2-04 的反向自证（用 `node -e` 内联复现，避免干扰同仓另一子代理）：旧实现 `response.text()` 在「响应后保持开流」的桩下永不 resolve，增量读取立刻命中。

**遗留 / 注意**
- P2-06 的**原始触发场景在当前代码下不可达**（别误判为"修了个假 bug"）：hub 注册工具一律经 `mcpToolName()` → `mcp.<server>.<tool>`（全仓唯一注册点 `hub.ts:331`），而内置名不以 `mcp.` 开头，所以「官方 filesystem server 的 `read_file` 撞内置 `read_file`」在当前命名空间层下发生不了。registry 这层修的是**覆盖/注销契约的正确性**（对任何未加前缀的注册方、或将来撤掉前缀层都成立），属纵深防御；测试在 registry 层直测，hub 层用「预先注册一个字面叫 `mcp.fake.echo` 的工具」模拟同名碰撞跑三条断开/出错路径。
- `readSse` 的尾部残缺块兜底：对「省略末尾空行且持续持有连接」的服务端做了额外兼容；若认为过度宽容，可去掉 `parseSseResponse` 最后一行（标准 framing 下无影响）。
- `hub.ts:321` 的 `callTool` 仍未透传 `options.timeoutMs`（属 P3，无对应 step），与 P2-04 是同一段代码的邻接缺陷。
- `host/agentHost.ts` 按约定未改。

