# Step 01 — 移除 AI 悬浮窗（service-dock）+ 配置迁移到 v4

- Task: frontend-refresh
- Step: 1 / 8
- Status: done
- Depends on: none
- Produces: 不含 service-dock 的窗口集（5 个窗口）、`CONFIG_VERSION = 4` 与 `v3 → v4` 迁移、更新一致的 docs/AGENTS.md

## 目标

彻底删除「AI 悬浮窗」（`service-dock`）这一窗口：渲染层入口、主进程窗口规格与几何、IPC 通道、托盘 / 快捷键 / 启动接线、
配置 Schema 与迁移链、单测与端到端自测断言、全部相关文档。做完这一步，`pnpm typecheck && pnpm test && pnpm build` 全绿，
且 `service-dock` 不再出现在任何可执行代码路径里。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 先读：`docs/README.md`、`docs/02-architecture.md` §2、`docs/07-ui-spec.md` §2.1/§2.4、
  `packages/shared/src/mode/windowState.ts`、`apps/desktop/src/main/window-manager.ts`
- 关键现状（已核实）：
  - `apps/desktop/src/renderer/service-dock/`（`App.vue` / `index.html` / `main.ts`）就是要删的窗口。
  - `window-manager.ts` 中服务窗专属逻辑集中在 `DOCK_SIZES:49-52`、`dockExpanded:122`、`setDockExpanded:302-305`、
    `sizeFor:433-439`、`readGeometry:467-471`、`persistGeometry:483-486`、`computeBounds` 的 `dock` / `anchor-dock`、
    `show:249-251`、`hide:263`、`resizeDock:445-453`。
  - `mini-chat` 通过 `computeBounds('anchor-dock')` 锚定服务窗（`window-manager.ts:397-410`）与
    `anchorToDock()`（421-430），服务窗没了必须重新锚定，否则小窗位置会退化到工作区默认位置。
  - `packages/shared/src/mode/windowState.ts:38-45` 的 `hideWindow` 对 `service-dock` 有特例（隐藏服务窗连带隐藏迷你窗），
    删掉服务窗后该特例必须移除，否则留下永不触发的死分支。
  - `packages/shared/src/config/schema.ts`：`WINDOW_NAMES:20-29`、`CONFIG_VERSION = 3`（第 9 行）。
  - `packages/shared/src/ipc/types.ts:509` 与 `apps/desktop/src/main/contracts.ts:79` 是 preload 桥 / 主进程端口的类型声明，
    删 IPC 时必须一起改，否则 typecheck 报错。

## 操作

### A. 先改文档（docs-first，本仓库硬约定）

1. `docs/02-architecture.md`：窗口表（40-44 行）删掉「AI 服务窗」行；模块树（102 行附近）窗口入口改为
   `edge-bar / chat / mini-chat / settings / onboarding`；降级策略（162 行附近）把「服务窗显示状态提示」改为提示条 / 交互窗。
2. `docs/07-ui-spec.md`：删掉 §2.1「AI 服务窗（Service Dock）」整节；§2.2 提示条改为本文档新语义（悬停展开面板 + 点击呼出交互窗，
   见 step-02）；§2.4 迷你窗的「与服务窗同显同隐 / 锚定服务窗」改为「锚定提示条左侧，提示条可用时贴其左缘垂直居中」；
   §1 设计原则里「默认占用最小（服务窗 + 提示条）」改为「（提示条）」。
3. `docs/08-settings-onboarding.md` §1：`general.windowState` 的 key 集合去掉 `service-dock`；配置版本写为 `4`，
   并补一行 `v3 → v4：移除 general.windowState['service-dock']`。同时把 `general.language` 明确标注为**未生效死字段**（无 i18n）。
4. `docs/06-agent-core.md:38`：快速会话的定义从「服务窗 + 迷你窗共享」改为「迷你窗（快速会话）与完整交互窗分离」。
5. `docs/04-roadmap.md`：**不要改写历史行**（P2 的历史描述保持原样）；在文末「变更记录 / 追加」处加一条本轮说明：
   移除 AI 服务窗，提示条成为唯一常驻入口。
6. `AGENTS.md`：第 7 行定位描述去掉「AI 服务窗 +」；第 16 行「六个窗口入口」改为「五个窗口入口」并去掉 `service-dock`；
   「尚未生效 / 已知限制」小节补一句「AI 悬浮窗（service-dock）已于本轮移除，常驻入口为提示条 + 托盘」。

### B. 契约与配置（先于主进程实现）

7. `packages/shared/src/config/schema.ts`：`WINDOW_NAMES` 去掉 `'service-dock'`；`CONFIG_VERSION` 改为 `4`。
8. `packages/shared/src/config/migrations.ts`：在 `MIGRATIONS` 数组末尾追加 `migrateV3ToV4`（幂等、只删该 key、不动其它字段）：

   ```ts
   const migrateV3ToV4: Migration = {
     from: 3,
     to: 4,
     describe: "v3 → v4：移除 general.windowState['service-dock']（AI 悬浮窗已删除）",
     transform(raw) {
       const next: Record<string, unknown> = { ...raw }
       const general = { ...(asRecord(raw['general']) ?? {}) }
       const windowState = { ...(asRecord(general['windowState']) ?? {}) }
       delete windowState['service-dock']
       general['windowState'] = windowState
       next['general'] = general
       next['version'] = 4
       return next
     },
   }
   ```

9. `packages/shared/src/config/migrations.test.ts`：追加用例——含 `windowState: { 'service-dock': {...}, chat: {...} }` 的 v3 配置
   迁移后 `version === 4`、`service-dock` 键消失、`chat` 键**原样保留**、重复执行结果一致（幂等）。
10. `packages/shared/src/ipc/channels.ts`：删除 `window.setDockExpanded`；改为新增 `setEdgeBarExpanded: 'window:setEdgeBarExpanded'`
    （step-02 会用到，本步先把通道定义好，通道表加完即有编译期双向断言保护）。
11. `packages/shared/src/ipc/types.ts`：preload 桥类型里删除 `setDockExpanded(expanded: boolean): Promise<Result<WindowState>>`，
    新增 `setEdgeBarExpanded(expanded: boolean): Promise<Result<WindowState>>`。
12. `packages/shared/src/mode/windowState.ts`：`hideWindow` 删除 `service-dock` 特例分支；
    顶部注释里「隐藏服务窗时迷你窗一并隐藏」的说明同步更新。
13. `packages/shared/src/mode/windowState.test.ts`：把所有 `'service-dock'` 用例替换为 `'edge-bar'` 或 `'chat'`；
    删除「隐藏服务窗连带隐藏迷你窗」断言（该规则已不存在）。

### C. 主进程

14. `apps/desktop/src/main/window-manager.ts`：
    - `SPECS` 删除 `'service-dock'` 条目；删除 `DOCK_SIZES`、`dockExpanded`、`setDockExpanded()`、`resizeDock()`。
    - `sizeFor()` 删除服务窗分支（`edge-bar` 分支在 step-02 加）。
    - `readGeometry()` / `persistGeometry()` 删除服务窗专属归一化分支。
    - `show()` 删除 `if (name === 'service-dock') this.resizeDock(false)`；`hide()` 删除
      `if (name === 'service-dock') this.applyVisibility('mini-chat', false)`。
    - `computeBounds()` 删除 `case 'dock'`；`case 'anchor-dock'` 改为锚定提示条（`this.windows.get('edge-bar')`）：
      小窗左缘贴提示条左缘、垂直中心与提示条一致；提示条窗口不存在时回落到工作区右下角
      （`x = area.x + area.width - width - 12`、`y = area.y + area.height - height - 12`）。
    - 删除 `anchorToDock()`，改为 `anchorToEdgeBar(win, edge)`（语义同上），`showMiniChat()` 改为 `this.anchorToEdgeBar(...)`。
    - `titleFor()` 删除 `'service-dock'` 条目。
    - 顺带修 `show()` 的真 bug（同一处，step-02 会回归验证）：`show()` 只改状态机不同步真实窗口，
      导致 mini-chat 可见时打开 chat，旧窗口仍盖在上面。改为：先算 `before`，执行 `showInState`，再对
      「`before.visible[name] === true && next.visible[name] === false`」的每个窗口调用 `applyVisibility(name, false)`。
15. `apps/desktop/src/main/contracts.ts`：`WindowManagerPort` 删除 `setDockExpanded`，新增 `setEdgeBarExpanded(expanded: boolean): WindowState`。
16. `apps/desktop/src/main/ipc.ts`：删除 `IPC.window.setDockExpanded` handler，新增 `IPC.window.setEdgeBarExpanded` handler
    （写法与其它 window handler 一致：`withState(() => deps.windows.setEdgeBarExpanded(expanded))`）。
17. `apps/desktop/src/main/tray.ts`：删除「隐藏 / 显示 AI 服务窗」菜单项（70-79 行）与 `tray.on('click')` 里的
    `toggle('service-dock')`（146-149 行）→ 改为 `deps.windows.toggle('chat')`。
18. `apps/desktop/src/main/index.ts`：
    - `second-instance`（159-160 行）：`show('service-dock')` / `focus('service-dock')` → `showChat()` / `focus('chat')`。
    - 全局快捷键 `onTrigger`（541 行）：`windows?.toggle('service-dock')` → `windows?.toggle('chat')`，注释里的「切换服务窗显隐」
      改为「切换交互窗显隐」。
    - 启动分支（698-703 行）：删除 `windows.show('service-dock')`；改为
      「`settings.get().general.edgeBar.enabled` 为真则 `windows.show('edge-bar')`，否则不额外开窗（托盘仍是管理入口）」。
19. `apps/desktop/src/preload/index.ts`：删除 `setDockExpanded` 绑定，新增
    `setEdgeBarExpanded: (expanded) => invoke(IPC.window.setEdgeBarExpanded, expanded)`。
20. `apps/desktop/src/preload/channels.ts`：与 `packages/shared/src/ipc/channels.ts` 同步（删一个、加一个）。
21. 删除整个 `apps/desktop/src/renderer/service-dock/` 目录；`apps/desktop/electron.vite.config.ts` 删除
    `'service-dock': r('src/renderer/service-dock/index.html')` 这一行。
22. 删除 `apps/desktop/src/main/dock-geometry.ts` 与 `dock-geometry.test.ts`（服务窗专属几何；step-02 会新建提示条几何模块）。

### D. 渲染层残留

23. `apps/desktop/src/renderer/shared/window.ts`：`currentWindowName()` 的回落值从 `'service-dock'` 改为 `'chat'`；
    `isTransparentWindow()` 去掉 `name === 'service-dock'`。
24. `apps/desktop/src/renderer/shared/composables/useChat.ts:38`：`sessionIdFor` 的
    `windowName === 'service-dock' || windowName === 'mini-chat'` 改为只判断 `'mini-chat'`。
25. `apps/desktop/src/renderer/shared/stores.ts`：删除 `setDockExpanded` 方法与导出，新增 `setEdgeBarExpanded`（step-02 用）。
26. `apps/desktop/src/renderer/onboarding/App.vue:164`：`window.aurora.window.show('service-dock')` 改为
    「`general.edgeBar.enabled` 为真 → `show('edge-bar')`，否则 `showChat()`」（先读该文件确认可用的 store / 配置读取方式再改）。
27. `grep -rn "origin:" apps/desktop/src/renderer` 确认只有 `useChat.ts:249` 一处传 `origin: windowName`，
    无需硬编码替换；但 `apps/desktop/src/main/smoke.ts` 里的 `origin: 'service-dock'`（308、331 行）必须改为 `'edge-bar'`。

### E. 自测

28. `apps/desktop/src/main/smoke.ts`：删除 285-300 行里所有 `service-dock` / `setDockExpanded` 断言，
    保留并改写窗口状态机断言为：`show('edge-bar')` → `showMiniChat()` → 迷你窗可见且 `primary === 'mini-chat'` →
    `showChat()` → **断言 `visible.chat === true && visible['mini-chat'] === false`**（这条现在同时回归 step-02 修的 `show()` bug）→
    `hide('chat')`。origin 按第 27 条改。

### F. 出口检查

29. 运行 `pnpm typecheck && pnpm test && pnpm build`，再跑 `pnpm verify`（配置层迁移）。
30. `grep -rn "service-dock\|setDockExpanded\|dockExpanded\|DOCK_SIZES" --include=*.ts --include=*.vue --include=*.json .`
    （排除 `node_modules`、`out`、`dist`、`step/`）：应只剩 `docs/` 里的历史说明与迁移 describe 文本。
31. 按「一个功能一个 commit」提交：`refactor(ui): 移除 AI 悬浮窗（service-dock），常驻入口收敛为提示条`。

## 验收标准

- [x] `pnpm typecheck && pnpm test && pnpm build` 全部通过（0 error）。
- [x] `pnpm verify` 通过；`packages/shared/src/config/migrations.test.ts` 新增的 v3→v4 用例通过，
      断言迁移后 `version === 4`、`windowState` 无 `service-dock`、`chat` 的几何原样保留、重复迁移幂等。
- [x] 上述 grep 不再命中任何可执行代码；`apps/desktop/src/renderer/service-dock/` 与
      `apps/desktop/src/main/dock-geometry.ts` 已不存在。
- [x] `AURORA_SMOKE=1 pnpm dev`（PowerShell）跑完，`%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT` 全绿，
      且输出中不再出现 `service-dock` / `setDockExpanded`。
- [x] `pnpm build` 后 `apps/desktop/out/renderer/` 下不再有 `service-dock/` 目录。
- [x] `docs/02`、`docs/06`、`docs/07`、`docs/08` 与 `AGENTS.md` 与新窗口集一致（无 SSOT 滞后）。

## 交接

- 留给 step-02：`window:setEdgeBarExpanded` 通道已在两端通道表、`ipc/types.ts`、`contracts.ts`、`ipc.ts`、preload 打通；
  渲染层 `useWindowStore().setEdgeBarExpanded()` 已可用；`window-manager.ts` 里 `sizeFor()` 的 `edge-bar` 分支与
  `edgeBarExpanded` 状态**尚未实现**（step-02 补），当前 `setEdgeBarExpanded` 是空实现（先 `return this.getState()`）。
- 留给 step-02：`computeBounds` 里提示条锚定小窗的新分支已就位，step-02 只需在窗口加宽后不破坏该锚定。

## 执行记录

### 会话恢复时的实际状态

本次会话开始时，工作区里**已存在一份未提交的 step-01 实现**（31 个文件改动，`Status` 仍是 `pending`、
执行记录为空）——即上一轮会话做完了改动但没提交、没回填。本轮按「只依据 step 文件 + 代码现状 + git 历史」核对
了这份改动是否真的满足验收标准，而不是直接采信：逐条读了 `window-manager.ts` / `smoke.ts` / `tray.ts` /
`index.ts` / `migrations.ts` / 文档的 diff，再实跑全部验收命令。

### 实际改动（与计划的差异）

- 计划 A–E 全部落地，`WINDOW_NAMES` 五窗口、`CONFIG_VERSION = 4`、`v3 → v4` 幂等迁移、
  `window:setEdgeBarExpanded` 两端通道表 + preload + contracts + ipc + store 全打通、
  `setEdgeBarExpanded` 为主线留桩（空实现，step-02 落地）。
- `show()` 的真 bug 已按计划第 14 条修掉：先算 `before`，`showInState` 后对
  「before 可见 → next 不可见」的每个窗口调 `applyVisibility(name, false)`。
- mini-chat 锚定改 `anchorToEdgeBar()`，提示条未创建（`existingWindow` 返回 undefined）时回落
  `bottomRightBounds()`（工作区右下角留 12px）。
- **计划外但阻塞验收的修复（单独一条 `fix:` 提交）**：`apps/desktop/src/main/index.ts` 的
  `seedSmokeClassroom` 用 `getMinutes() + 45` 手算 endTime，分钟 ≥ 15 时溢出成 `HH:60+`，
  被桥接解析器判非法而丢课，造成三条与改动无关的假失败。这是**基线就有的 bug**（`git show HEAD:` 可复现），
  但它直接违反本步「AURORA_SMOKE 全绿」的验收标准，故作为阻塞修复处理，未放宽验收标准。
- 计划外但属于本步范围的修复：`smoke.ts:127` 的 `settings.get.version === 3` 随迁移同步改为 `=== 4`
  （并入本步的 `refactor` 提交）。

### 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm format:check` | All matched files use Prettier code style |
| `pnpm lint` | 0 error |
| `pnpm typecheck` | 4 包全 Done，0 error |
| `pnpm test` | 42 文件 / 587 用例全通过 |
| `pnpm build` | 成功；`out/renderer/` 下只剩 edge-bar / chat / mini-chat / settings / onboarding |
| `pnpm verify` | 26/26 通过；`执行了 v0 → 当前版本的迁移链 — count=4/4`、`version=4` |
| `AURORA_SMOKE=1 pnpm dev` | **86/86 passed**（首轮 82/86，修掉上述两个问题后全绿）；日志中 `service-dock` / `setDockExpanded` 命中数 **0** |
| `grep -rn "service-dock\|setDockExpanded\|dockExpanded\|DOCK_SIZES"`（排除 node_modules/out/step） | 仅命中 `docs/`、`AGENTS.md` 的历史/迁移说明与 `migrations.ts` 的 describe 文本，无可执行代码路径 |

窗口状态机相关 smoke 断言实测输出：

- `迷你窗可见且 primary=mini-chat` → `{"visible":{"edge-bar":true,"mini-chat":true,"chat":false},"primary":"mini-chat"}`
- `交互窗与迷你窗互斥` → `{"visible":{"mini-chat":false,"chat":true},"primary":"chat"}`
- `隐藏交互窗后无主窗口且提示条仍在` → `{"visible":{"edge-bar":true,"chat":false},"primary":null}`

### git 提交

- `9296b56` `refactor(ui): 移除 AI 悬浮窗（service-dock），常驻入口收敛为提示条`（31 文件）
- `0d91eef` `fix(smoke): 课前提醒夹具的 endTime 分钟溢出导致自测假失败`（1 文件）

### 遗留问题

- `step/` 目录仍是未跟踪状态（仓库历史里从未提交过 step 文件），未纳入本次提交。
- `theme.css` 里仍有 `--status-*` 等服务窗时代的语义色，命名无需改，step-03 统一。
- `setEdgeBarExpanded` 目前是空实现（`return this.getState()`），真实两态宽度由 step-02 实现——
  这是计划里的分段交接，不是缺陷。
