# 任务：优化 Aurora 前端（提示条呼出交互窗 / 删除 AI 悬浮窗 / Apple 风格重构 / 设置页整理）

- 任务标识：`frontend-refresh`
- 项目根目录：`D:/AICOP/Projects/Aurora`
- 创建时间：2026-09-19 09:56
- 基线提交：`22e2718`（`22e271806929ec8905c0af85f5a0eda27804339c`，任务期间不变）
- 归档目录：`step/archive/20260920-140927-frontend-refresh`
- 归档时间：2026-09-20 14:09

## 原始任务（用户原话）

1. 侧边栏点击后无法呼出交互窗，同时删除 AI 悬浮窗
2. 项目的前端展示太丑了，请你重构前端展示，对齐 Apple 风格，添加一些必要的交互动画
3. 项目的设置页面太杂乱，整理优化，将用户无法设置的内容（如当用户没有选择 classroom mode 时不显示相关设置项）

## 已核实的现状（规划阶段读代码得到的事实，执行时可直接采信）

**提示条点击失效的真实根因**（不是 IPC 缺失）：

- `apps/desktop/src/renderer/edge-bar/App.vue:58-67` 的 `.edge` 有 `overflow: hidden`，`.panel` 宽 200px，
  而 `apps/desktop/src/main/window-manager.ts:64-73` 里 `edge-bar` 窗口固定 `width: 8`、`resizable: false`，
  `overflow:hidden` 下 200px 面板只有最右 8px 落在窗口内（且那 8px 是面板 padding，无事件）。
- `edge-bar/App.vue:61` `@mouseenter="expanded = true"` 配合 `App.vue:139-141` `.edge.expanded .strip { width: 0 }`，
  悬停时把唯一的点击目标（8px 按钮）动画收缩到 0 → 用户点击时根本不落在 `.strip` 上，`openChat()` 不会被调用。
- 主进程**没有**提示条展开 / 改宽的 IPC（`window:setDockExpanded` 只服务 service-dock，`resizeDock` 是唯一 `setBounds` 调用方）。
  因此需要新增 `window:setEdgeBarExpanded`。

**另一个会让「点了没反应」显得更严重的真 bug**：

- `window-manager.ts:248-257` `show()` 只在状态机里把另一个主对话窗口置为 `visible: false`，
  **没有同步调用 `applyVisibility`**；而 `hide()`（259-270）有同步。结果是 mini-chat 已在屏上时打开 chat，
  mini-chat 的 BrowserWindow 仍然可见并盖住新窗口。此 bug 在 step-02 修。

**删除 service-dock 的完整依赖面**（step-01 逐一处理）：

- 渲染层：`apps/desktop/src/renderer/service-dock/`（`App.vue` / `index.html` / `main.ts`）、
  `apps/desktop/electron.vite.config.ts:9` 入口、`renderer/shared/window.ts:9,13`、
  `renderer/shared/composables/useChat.ts:38`、`renderer/onboarding/App.vue:164`、
  `renderer/shared/stores.ts:192-203`。
- 主进程：`window-manager.ts`（SPECS / DOCK_SIZES:49-52 / dockExpanded:122 / setDockExpanded:302-305 /
  sizeFor:433-439 / readGeometry:467-471 / persistGeometry:483-486 / computeBounds 的 `dock` 与 `anchor-dock`:376-410 /
  show:249-251 / hide:263 / resizeDock:445-453）、`dock-geometry.ts` + `dock-geometry.test.ts`（整文件删除）、
  `ipc.ts:293-295`、`contracts.ts:79`、`preload/index.ts:83`、`preload/channels.ts:60`、
  `tray.ts:70-79,146-149`、`index.ts:159-160,541,700`、`smoke.ts:285-300,308,331`。
- 契约：`packages/shared/src/ipc/channels.ts:45`、`packages/shared/src/ipc/types.ts:509`、
  `packages/shared/src/mode/windowState.ts:38-45`、`windowState.test.ts`。
- 配置：`packages/shared/src/config/schema.ts`（`WINDOW_NAMES:20-29`、`CONFIG_VERSION = 3`）、
  `packages/shared/src/config/migrations.ts`、`migrations.test.ts`。
- 文档：`AGENTS.md`、`docs/02-architecture.md:40-44,102,162`、`docs/04-roadmap.md`（历史记录**不要改写**，只追加变更说明）、
  `docs/06-agent-core.md:38`、`docs/07-ui-spec.md:20-42`、`docs/08-settings-onboarding.md`。

**设置页的「无法设置的内容」**：

- `general.language` 是**死字段**（`settings/pages/GeneralPage.vue:62,113,127,154` 提供选择器，但无 i18n 消费方；
  `AGENTS.md` 已标注）。它是最典型的「用户设了不生效」项，step-06 移出 UI。
- `modes.classroom.*` 已经由 `ModesPage.vue:19,113-114`（`classroomActive`）门控，但 Work / Code 选中时该页只剩空卡片，
  没有「该模式暂无可配置项」的解释；`ClassroomSection.vue` 有 682 行、单文件平铺，是「杂乱」的主要来源。
- 样式基线：无组件库，全部手写 CSS；令牌与原子类在 `apps/desktop/src/renderer/shared/theme.css`（181 行），
  各页面各自 `scoped` 重复声明 `.page` / `header h2`。

## 已锁定的设计决策（执行时不要重新讨论，按此实现）

1. **删掉的是「AI 悬浮窗」= `service-dock`（56×56 圆形浮球 / 320×56 输入条）**。
   保留 `mini-chat`（小 AI 交互窗口）：它仍有入口（提示条展开面板的「小窗对话」），只是不再锚定服务窗，
   改为锚定提示条左侧（提示条窗口未创建时回落到工作区右下角）。
2. 提示条展开靠**新增 IPC + 主进程改窗口宽度**：收起 8px、展开 228px；**右边缘固定、高度与垂直中心不变**。
   不做 `setIgnoreMouseEvents` 穿透（docs/07 已标注未实现，本轮不引入）。
3. 提示条点击 = 打开完整交互窗（`window:showChat`），保留 docs/07 §2.2 的交互语义。
4. 托盘左键 / 全局快捷键 `Alt+Space` 的触发动作从「切换服务窗」改为「切换交互窗」（`toggle('chat')`）。
5. `WINDOW_NAMES` 去掉 `service-dock` ⇒ `CONFIG_VERSION` 3 → 4，新增 `v3 → v4` 迁移：删除
   `general.windowState['service-dock']`（幂等，只删不改别的字段）。
6. `general.language` 字段**保留在 Schema**（避免再动一次配置版本），只从设置页 UI 移除，并在 `AGENTS.md` 与
   `docs/08` 明确标注为未生效死字段。
7. Apple 风格的具体取向：字体栈 `-apple-system, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI'`；
   大圆角（10/14/20/28）；亚克力毛玻璃层次 + 柔和阴影；缓动统一走 `--ease-spring`；全局支持 `prefers-reduced-motion` 降级。
8. **不升版本号**（用户没要求）。提交信息按 Conventional Commits + 中文，用 `feat(ui):` / `fix(ui):` / `refactor(ui):` / `docs:` 前缀。

## 步骤

| # | 文件 | 标题 | 状态 | 依赖 |
|---|------|------|------|------|
| 1 | step-01-remove-dock.md | 移除 AI 悬浮窗（service-dock）+ 配置迁移到 v4 | done | - |
| 2 | step-02-edge-bar-expand.md | 修复提示条：可展开面板 + 点击呼出交互窗 | done | step 1 |
| 3 | step-03-design-system.md | Apple 风格设计系统 + 共享组件 + 截图核对工具 | done | step 2 |
| 4 | step-04-chat-windows.md | 交互窗与小窗的视觉重构与动效 | done | step 3 |
| 5 | step-05-edgebar-onboarding.md | 提示条与首次引导的视觉重构与动效 | done | step 3 |
| 6 | step-06-settings-reorg.md | 设置页信息架构整理 + 无效项清理 | done | step 3 |
| 7 | step-07-verify.md | 全量验收与视觉核对 | done | step 1..6 |
| 8 | step-08-archive.md | 归档清理 | done | step 1..7 |

## 完成标准

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；`pnpm verify` 通过（配置层 v4 迁移）。
- `AURORA_SMOKE=1 pnpm dev` 的端到端自测全绿，且断言里不再出现 `service-dock` / `setDockExpanded`。
- 全仓 `grep -rn "service-dock"` 只命中归档与「历史记录/迁移说明」文本，不再命中任何可执行代码路径。
- 提示条在真实 Electron 下：悬停能展开出可点击面板，点击能拉起交互窗（截图 + 自测双重证据）。
- 五个窗口（edge-bar / chat / mini-chat / settings / onboarding）截图统一为同一套 Apple 风格令牌，无手写重复样式。
- 未选择 ClassRoom 模式时，设置页 DOM 中不出现任何 `modes.classroom.*` 相关控件。
- `docs/` 与 `AGENTS.md` 与代码一致（SSOT 不滞后）。

## 执行记录

（执行阶段追加：每步实际改动与验证结果、git 提交清单、代码审查结论与处置）

### step-01 移除 AI 悬浮窗（service-dock）+ 配置迁移到 v4 — done

- 会话恢复时工作区已有一份**未提交且未回填状态**的 step-01 实现；本轮先逐条核对（读 diff + 实跑全部验收）
  再提交，而不是直接采信。
- 提交：
  - `9296b56` `refactor(ui): 移除 AI 悬浮窗（service-dock），常驻入口收敛为提示条`
  - `0d91eef` `fix(smoke): 课前提醒夹具的 endTime 分钟溢出导致自测假失败`（基线已有的阻塞性 bug，计划外修复）
- 验证：`format:check` / `lint` / `typecheck` / `test`（587 用例）/ `build` / `verify`（26/26，迁移链 4/4）全绿；
  `AURORA_SMOKE` **86/86 passed**，日志中 `service-dock` 命中 0；`out/renderer/` 无 `service-dock/`。
- 详见 `step-01-remove-dock.md` 的「执行记录」。

### step-02 提示条展开面板 + 点击呼出交互窗 — done

- 提交：`b4e6d08` `fix(ui): 提示条点击无法呼出交互窗，改为可展开面板并新增 setEdgeBarExpanded`
- 新增 `main/edge-bar-geometry.ts`（纯函数 + 6 个单测）、`WindowManager.getBounds()`；
  `setEdgeBarExpanded()` 真实实现（收起 8 / 展开 228、右缘固定）；渲染层 120ms 展开 / 220ms 收起、删除 `.strip { width: 0 }`。
- 验证：`format:check` / `lint` / `typecheck` / `test`（593 用例）/ `build` 全绿；`AURORA_SMOKE` **92/92 passed**，
  含 4 条真实 BrowserWindow 几何断言（8→228、右缘与 y 不变、往返幂等）。
- 遗留：计划 E 节的「四条人工核对 + PNG 截图」当时按计划交接给 **step-03 的 `AURORA_CAPTURE`**，
  **已于 step-03 用 DOM 探针 + PNG 补齐并勾选**。
- 一处偏离计划的实现选择：`readGeometry('edge-bar')` 沿用 y 但水平位置一律重算贴右缘（理由见 step-02 执行记录）。
- 追加修复 `8aeba60`（由 step-03 的探针发现）：展开态只加宽不增高，4 个操作按钮被挤出可视区（详见 step-03 执行记录）。

### step-03 Apple 风格设计令牌与动效体系 + 截图核对工具 — done

- 提交：`7a280db` `feat(ui): 建立 Apple 风格设计令牌与动效体系，新增窗口截图核对工具`
- `theme.css` 重写（既有令牌名全保留 + 分层填充 / 阴影 / 缓动 / 字号阶梯 / reduced-motion 全局兜底）；
  7 个共享组件换新令牌（props/emits 零改动）；新增 `main/capture.ts` 与 `AURORA_CAPTURE` 工作流、
  设置页 `?page=` 深链、`WindowManager.ensure(query)` / `reload()` / `whenLoaded()`。
- 验证：`format:check` / `lint` / `typecheck` / `test`（595 用例）/ `build` 全绿；
  `AURORA_CAPTURE` 13/13 张 PNG 非空、`AURORA_CAPTURE_WINDOWS=settings` 6/6；
  DOM 探针 4/4 按钮可点、点击竖条呼出交互窗。
- 探针发现并已修复的隐患：提示条展开态不增高导致按钮不可点（`8aeba60`）。
- 详见 `step-03-design-system.md` 的「执行记录」。

### step-04 / step-05 / step-06 — done（并行执行，写入范围互不重叠）

三个 step 都只依赖 step-03，按「写入范围不重叠」并行分派给三个子代理（各自只改自己窗口目录），
Lead 负责中央验收（门禁 + 真实 Electron 自测 + 截图读图）、文档同步与分步提交。

- step-04（交互窗 / 小窗）：`38d395f`；4 个文件；`chat.png` / `mini-chat.png` 读图通过。
- step-05（提示条 / 引导）：`cf903f5`；2 个文件；探针 `allClickable: true`，全高面板排版成立。
- step-06（设置页）：`485bea7` + 阻塞修复 `9cec91d` + 探针 `18547fb`；15 个文件。
- 文档与工具：`8d03e23`（DOM 探针）、`45b9161`（docs/07 §2.3–§2.6、docs/08 §6.1、AGENTS.md）。
- 中央验收：`format:check` / `lint` / `typecheck` / `test`（595 用例）/ `build` / `verify`（26/26）全绿；
  `AURORA_SMOKE` **93/93**；`AURORA_CAPTURE` **16/16 张 PNG 非空 + 5 条探针全 `pass`**。

### 本轮揪出的两个真 bug（都由探针发现，均已单独提交修复）

1. `8aeba60`：提示条展开态只加宽不增高 → 面板按钮落在可视区之外，`elementFromPoint` 全部落空
   （「看得到面板却点不到按钮」）。
2. `9cec91d`：**基线就存在**的设置保存静默失败 —— `ipcRenderer.invoke` 的结构化克隆不能传
   Vue `reactive` 产的 Proxy，设置页 patch 的嵌套子对象都是 Proxy，整次保存以 unhandled rejection 失败，
   既不写盘也不报错。修复后「改一个 classroom 字段不丢其它字段」才真正成立。
3. `e443a9e`（独立审查发现，同为基线既有）：`chat:send` 的附件数组仍是 Proxy → 拖入附件发送必失败，
   且输入区永久卡在「流式中」。与上一条同根，属于「同类缺陷只修了一半」。
4. `90e1486` / `4a4a0f3` / `02551db`：审查提出的写入放大、退出丢垂直居中、截图探针会改真实用户配置、
   退出码不反映探针结论、以及 `docs/01`/`02`/`10`/`11`/`README` 里把已删除的服务窗写成现存能力。

### step-07 全量验收 — done

- 门禁：`format:check` / `lint` / `typecheck` / `test`（**597 用例**）/ `build` / `verify`（26/26）全绿。
- 真实 Electron：`AURORA_SMOKE` **93/93**；`AURORA_CAPTURE`（不带 SMOKE，验证自动隔离）
  **16/16 张 PNG 非空 + 5 条 DOM 探针全 `pass`**，退出码 0。
- 残留扫描（**已把 markdown 纳入**，这是审查抓出的盲区）：只剩迁移本体与历史/需求文档文本。
- 逐张读了 9 张关键截图并给结论（chat / mini-chat / edge-bar 两态 / onboarding / settings 四页 + 门控页）。
- 文档 SSOT 五份 + `AGENTS.md` 逐份核对，滞后之处已补（`02551db`）。
- **独立只读审查：结论「有条件可交付」，P0 无；列出的 3 条 P1 与本轮 2 条 P2 全部已修并复验**
  （`02551db` / `4a4a0f3` / `e443a9e` / `90e1486`）；其余 P2/P3 作为已记录残留列在 `step-07` 末尾。
- 未闭合项（如实记录）：真机手感与「流式只有末尾光标在动」只能人眼确认；小窗非透明窗（浮卡圆角不生效）；
  提示条全高面板空态偏空；`/`、`@` 补全浮层本就不存在；提示条关闭后缺短路径入口；若干 P3 清理项。
- 详见 `step-07-verify.md`（含审查结论表、证据表、残留问题清单与 16 条提交清单）。
