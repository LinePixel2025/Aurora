# Step 05 — 主进程退出协议与快照回写安全

- Task: bugfix-p0p1p2
- Step: 5 / 12
- Status: done
- Depends on: none
- Produces: 退出不再出现「半关停僵尸」且收尾落盘先于进程退出完成；快照回写过项目根边界并原子写；窗口拖动/缩放不再触发每帧全量配置 mutate
- Phase: 核心链路
- Writes: `apps/desktop/src/main/index.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/window-manager.ts`、`apps/desktop/src/main/window-manager.geometry.test.ts`（新建，仅当抽出可测纯逻辑）、`apps/desktop/src/main/tools/restore-guard.ts`（新建）、`apps/desktop/src/main/tools/restore-guard.test.ts`（新建）
- Size: M
- Risk: P1-12 的退出协议与自动更新 `quitAndInstall` 共用 before-quit——preventDefault 后必须保证 `shutdown().finally(app.quit())` 无条件到达，否则更新安装流程也被卡死；这三个文件都无法进 vitest（import electron），验证靠 typecheck + build + 代码核对

## 目标

托盘退出：先同步挡住退出并置位 `quitting`，收尾落盘全部完成后才真正 `app.quit()`，且该流程不可重入；快照回写跟随符号链接写到根外的路径被堵死；拖动窗口期间不再每秒几十次全量配置广播。

## 输入

- `bug/P1-严重.md` 的 P1-12 与 `bug/P2-一般.md` 的 P2-07、P2-08（每条含 文件:行、触发条件与修复建议）；证据在 `bug/_raw/U2-main-core.md`
- 源码：`apps/desktop/src/main/index.ts`（before-quit 约 452-454 `void shutdown()`；约 3909-3912 先 `await automationStore?.flush()` 后才 `prepareQuit()` 的乱序）；`apps/desktop/src/main/window-manager.ts`（close 守卫约 284-288 依赖 `quitting`；`prepareQuit` 置位约 470-477；`moved`/`resized` 消费约 289-290、655-662）；`apps/desktop/src/main/ipc.ts`（`restoreSnapshot` 约 1072-1108，约 1096 行裸 `nodeFs.writeFile`，函数头注释声称过边界实际没有）
- 主进程安全口径（AGENTS.md）：file-port 写路径的防线是 `resolveWithin`（realpath 前缀校验）+ 原子写——restoreSnapshot 要对齐同一条防线，不另立第二套
- 消费方事实：`index.ts:1358、1709` 与 `ipc.ts:823-825` 监听窗口几何变化触发的配置广播；`packages/shared/src/config/store.ts:265-268` 是广播源头——P2-08 修在 window-manager 的事件源头（去抖/短路），不动消费方

## 操作

1. P1-12：`index.ts` 的 before-quit 改为标准「先挡后退」——同步调 `prepareQuit()`（置 `quitting=true`，让各窗口 close 守卫放行）→ `event.preventDefault()` → `void shutdown().finally(() => app.quit())`；加 `shuttingDown` 模块级标记防重入（重复 before-quit 直接 return）。删除约 3909-3912 处「先 await flush 后才 prepareQuit」的乱序（prepareQuit 已提前同步置位，shutdown 尾段的 flush 顺序保留）。
2. P1-12 兼容核对：自动更新 `quitAndInstall` 与单实例退出等所有触发 `app.quit()` 的路径都走同一 before-quit——确认 preventDefault 对它们同样成立且 finally 一定会补 quit（更新流程若依赖退出时序，核对 updater 模块无额外假设）。
3. P2-07：`ipc.ts` 的 `restoreSnapshot` 写回前做与 file-port 同款的边界校验——lstat 拒绝符号链接、realpath 前缀校验越界即拒绝；把这套守卫抽成可测纯函数（新建 `apps/desktop/src/main/tools/restore-guard.ts`，`ipc.ts` 调用它，不在 ipc.ts 复制第二套口径），并在 `apps/desktop/src/main/tools/restore-guard.test.ts` 补用例：符号链接指向根外 → 拒绝、根内常规路径 → 放行、目标不存在时按最近存在父目录做 realpath 前缀判定；写回改 tmp + rename 原子写；函数头注释与实现保持一致。
4. P2-08：`window-manager.ts` 的 `persistGeometry` 收尾去抖——拖动/缩放停止后 200-300ms 才落盘与广播；bounds 与上次相同则短路。去抖间隔与「是否变化」的判定若可抽纯函数，抽到 `apps/desktop/src/main/window-manager.geometry.test.ts` 可测的纯模块并加用例（vitest 不收 import electron 的模块）。
5. Conventional Commits 中文分组提交（`fix(main): ...`），提交信息尾注覆盖的条目号（如 `...(P1-12, P2-07)`）。

## 验收标准

- [ ] `pnpm typecheck && pnpm build` 通过（这三个文件的主验证；vitest 存量不回归：`pnpm vitest run apps/desktop/src/main` 全绿）
- [ ] 代码核对四项：① before-quit 同步置位 `quitting` 且 `preventDefault`；② `shutdown` 完成后才 `app.quit()` 且有防重入；③ `restoreSnapshot` 写回前有符号链接 / realpath 校验且走 tmp+rename；④ 几何事件去抖收尾、bounds 未变短路
- [ ] 若抽了纯函数：`pnpm vitest run apps/desktop/src/main/window-manager.geometry.test.ts` 绿
- [ ] `pnpm vitest run apps/desktop/src/main/tools/restore-guard.test.ts` 绿（含符号链接越界拒绝用例）
- [ ] 可选（重量级，标注）：`AURORA_SMOKE=1 pnpm dev` 的 `AURORA_SMOKE_RESULT` 为 PASS（端到端确认退出路径无回归）

## 交接

- `apps/desktop/src/main/ipc.ts` 还会被 step-10 改（deleteSession 广播）——本步收尾时保持该文件可编译、测试全绿；两步都改它，但分别在不同波次（step-10 依赖本步）。
- 退出协议的最终形态写进「执行记录」，供代码审查重点复核（见 00-index 审查重点）。

## 执行记录

**提交**：`ef56d85 fix(main): 退出协议先挡后退、快照回写边界守卫、窗口几何去抖`

**分片与结果**：单分片，1 个实现子代理（general-purpose）。主代理复跑验收命令。

**实际改动**
- `index.ts`（P1-12）：新增模块级 `shuttingDown`（收尾进行中）与 `quitAllowed`（收尾完成后的那次 `app.quit()` 放行）；`before-quit` 改为「`quitAllowed` → return 放行 / `shuttingDown` → `preventDefault()` + return（重复退出不打断落盘）/ 首次 → `shuttingDown=true` → **同步 `windows?.prepareQuit()`** → `event.preventDefault()` → `void shutdown().catch(...).finally(() => { quitAllowed = true; app.quit() })`」；删除原 3909-3912「先 `await automationStore.flush()` 后才 `prepareQuit()`」的乱序；`shutdown()` 文档改写为「只管收尾、不管退出」；`snapshotGuard` 依赖注入（`workspaceRoot: (sessionId) => sessionProjects.boundaryRoot(sessionId)`，与 file-port / run_command **同一个取值器**）。
- `ipc.ts`（P2-07）：`restoreSnapshot` 的守卫**放在留底之前** —— `assertRestorablePath`（`lstat` 拒符号链接 / junction + `resolveWithin` realpath 前缀），越界/链接按 `E_INVALID_ARGUMENT` 如实报并 `logger.warn`；`capture` / `rm` / `mkdir` / 写全部用守卫返回的 `absolutePath`；写回改 `writeRestoredFile`（tmp + rename）。函数头注释改成与实现一致。
- `tools/restore-guard.ts`（新建）：`assertRestorablePath`（无根 → 直接返回，与 `resolveWithin` 同款；有根 → lstat 拒符号链接 → `resolveWithin(target, false, guard, sessionId)`）+ `writeRestoredFile`（`<path>.<pid>.<ts>.tmp` + `rename`，失败清 tmp）。不 import electron，纯 Node 可单测。
- `window-manager.ts`（P2-08）：新增 `GEOMETRY_PERSIST_DEBOUNCE_MS = 250`、`sameBounds()`、`geometryTimers` / `geometryBounds`；`moved` / `resized` 改走 `scheduleGeometryPersist`（**先短路** 「bounds 未变 → 连定时器都不排」**再去抖** 250ms）；`closed` 里补 `cancelGeometryTimer` + 清基准；`isPersistableGeometry` 把三条既有口径（提示条 / 已销毁 / 最大化）收成一份，`persistGeometry`（立即路径）与去抖路径共用；`writeGeometry` 是唯一 `settings.mutate` 落点；`prepareQuit` 先按真实窗口现读落盘再清定时器。消费方（`index.ts:1358/1709`、`ipc.ts:823-825`）**一行未动**。

**验证（主代理实跑）**
```
pnpm typecheck → 全部 Done
pnpm build     → apps/desktop 主进程 153 modules / 渲染层 1948 modules，Done
pnpm test      → 115 files / 2028 tests 全绿（含 apps/desktop/src/main 54 files / 854 tests）
pnpm vitest run apps/desktop/src/main/tools/restore-guard.test.ts → 10 tests 绿（含符号链接越界拒绝）
```
子代理另做了一条最小复现（用仓库自带 Electron 33.4.11 跑一次性脚本，脚本写在 `%TEMP%` 未进仓库）钉住退出时序三件事：① `before-quit` 里 `preventDefault()` 确实不会走到 `will-quit`/`quit`；② 重复退出会**再次**进入 `before-quit`（所以必须有第二个分支继续挡）；③ 补发的那次 `app.quit()` 会再进一次 `before-quit`（所以必须有 `quitAllowed` 放行，否则进程永远不退）。

**`finally(app.quit())` 无条件到达的三道保险**：① `shutdown()` 内部每一段（`automationStore` / `sessions` / `todoPort` / `snapshotPort` / `jobStore` / `mcp` / `settings`）都已 `.catch()`，本身不 reject；② 外层再加 `.catch()`；③ `.finally()` 在任何 then/catch 结果下都执行，且回调里只有两个不可失败的语句。自动更新兼容性也核过：`electron-updater@6.8.9` 的 `quitAndInstall` 是「先同步 spawn 安装器 → `setImmediate(() => app.quit())`」，只要求"应用最终退出"，无单次 `app.quit()` 必须立即终结进程的假设；`updater-port.ts` 把 `autoInstallOnAppQuit` 设为 `false`，`addQuitHandler()` 直接 return 不注册。

**验收标准第 5 条（可选重量级 `AURORA_SMOKE` PASS）未能达成 —— 存量问题，非本步引入**
子代理与主代理都跑了真实 Electron 自测，结果 `SUMMARY 162/176 passed`，14 条 FAIL **全部是改动前就存在的存量失败**，族别统一，且**没有一条能归因到本步改动的文件**：
- 失败文案分两类：① 边界族「该路径在项目根之外（目标：`%TEMP%\aurora-smoke-*`；项目根：`C:\Users\...\Desktop\Aurora`）」，连带 `write_file` 被拒 → 快照 `listed=0` → 写前快照 / 一键回滚 / 集成①②⑤ / run_command 回读 / list_dir / glob / grep 全挂；② 过期断言「组件目录含全部触发器（7 类）与操作组件（**3** 类）」实得 `{conditions:7, actions:5}` —— 自动化操作组件早已是**五件**（AGENTS.md 与 docs/13 §5 v0.2.9 均已文档化），断言没跟着更新。
- 根因：`tools/session-project.ts:108-136` 的 `boundaryRoot = projectRootOf ?? spaceDirOf ?? globalProjectRoot ?? activeModeDir`，而 `spaceDirOf('agent')` 对未绑定项目的会话**恒**返回 `%USERPROFILE%\Desktop\Aurora`；冒烟夹具的会话（`sessionId: 'smoke'`）写的全是 `%TEMP%\aurora-smoke-*`，必然越界。该链是 **2026-09-30 会话三分轮**引入的，早于本任务基线 `52ed64c`；`session-project.ts` 不在本次任何 step 的 Writes 内、字节未变。
- 归属判定：14 条里没有一条经过本步改动的代码路径（本步只动退出协议、`restoreSnapshot`、窗口几何；`write_file` 的边界来自未改动的 file-port / session-project）。step-11 的基线对照复跑见 `step-11-full-verify.md` 执行记录。
- 处置：**不在本步范围**。要修得动冒烟夹具（把 `smoke-*` 会话 `setProject(...)` 绑到临时项目根）或改 `spaceDirOf` 对 `projects.root` 的遮蔽口径，两者都超出本步操作清单；连同过期断言一起，作为独立问题上报用户。

**遗留 / 注意**
- **`window-manager.geometry.test.ts` 未建**：白名单只给了这个**测试**文件、没给对应的纯模块（`window-manager.ts` 本身 import electron，vitest 收不了）。要单测就得新建一个不在白名单里的 `window-manager.geometry.ts`，子代理按「一个字都不要动别的」未创建。P2-08 的判据目前是 typecheck + build + 代码核对。去抖逻辑集中在 `window-manager.ts` 的三个私有方法里，口径只有一份。
- **P1-12 的"收尾卡住"面**：新协议把"退出被截断"换成"等收尾跑完"。各段都有 `.catch()`，实测未见挂起；但**没有**给整个 `shutdown()` 加硬超时（加了就等于把"截断落盘"重新引入）。若日后 `shutdown()` 永久悬挂，退出会变成"点了没反应"，需另立带超时的兜底（属 P3）。
- **P2-08 的行为变化**：`moved`/`resized` 落盘从"立即"变为"停手后 250ms"，硬杀进程若落在最后 250ms 内会丢最后一帧几何；`setPosition`（渲染层拖拽结束）与退出前仍是**立即**落盘。

