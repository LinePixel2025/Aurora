# Step 02 — 修复提示条：可展开面板 + 点击呼出交互窗

- Task: frontend-refresh
- Step: 2 / 8
- Status: done
- Depends on: step 1
- Produces: `apps/desktop/src/main/edge-bar-geometry.ts`（+ 单测）、真正可用的提示条展开/收起链路、点击即呼出交互窗

## 目标

用户点击右侧提示条能稳定呼出 AI 交互窗；悬停能展开出**可点击**的面板。做完这一步，「侧边栏点击后无法呼出交互窗」这个 bug 消失，
且 mini-chat / chat 的互斥显隐在真实窗口上同步。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 先读：`apps/desktop/src/renderer/edge-bar/App.vue`（218 行）、`apps/desktop/src/main/window-manager.ts`、
  `apps/desktop/src/main/dock-geometry.ts` 的历史形态（step-01 已删除，可作为纯函数几何模块的写法参考：
  `git show <step-01 基线提交>:apps/desktop/src/main/dock-geometry.ts`）、`apps/desktop/src/main/dock-geometry.test.ts`。
- 关键现状（已核实，step-01 之后的状态）：
  - `edge-bar` 窗口 `SPECS` 里 `width: 8, height: 200, resizable: false, transparent: true, focusable: false, place: 'edge'`；
    `computeBounds` 的 `case 'edge'` 返回 `x = area.x + area.width - width`（右缘贴边）、垂直居中。
  - 渲染层 `.edge { overflow: hidden }`，`.panel { width: 200px }`，且 `.edge.expanded .strip { width: 0 }` 会把点击目标收缩没。
  - 主进程没有改提示条宽度的代码路径；`resizeDock` 已在 step-01 随服务窗一起删除。
  - `window:setEdgeBarExpanded` 通道已在 step-01 打通到 preload 与 store（`useWindowStore().setEdgeBarExpanded()`），
    主进程侧 `WindowManager.setEdgeBarExpanded()` 目前是空实现。

## 操作

### A. 几何模块（纯函数，可单测）

1. 新建 `apps/desktop/src/main/edge-bar-geometry.ts`，零依赖、不 import electron（原因同被删的 dock-geometry：
   `vitest.config.ts` 只收不 import electron 的主进程测试）。导出：

   ```ts
   export interface Rect { x: number; y: number; width: number; height: number }
   /** 提示条两态宽度：收起 8px 竖条 / 展开 228px（200px 面板 + 8px 竖条 + 20px 内边距余量） */
   export const EDGE_BAR_WIDTHS = { collapsed: 8, expanded: 228 } as const
   /** 收起态是否落在右缘：x = 工作区右缘 - 宽度（右缘固定，向左生长） */
   export function placeEdgeBar(workArea: Rect, size: { width: number; height: number }): Rect
   /** 只改宽度、保持右缘与 y / height 不变 */
   export function resizeEdgeBarKeepingRight(current: Rect, width: number, workArea: Rect): Rect
   ```

   `placeEdgeBar` 与 `computeBounds` 的 `edge` 分支语义保持一致（垂直居中）；`resizeEdgeBarKeepingRight`
   必须保持 `current.x + current.width`（右缘）与 `current.y` 不变，并把结果 clamp 进工作区。
2. 新建 `apps/desktop/src/main/edge-bar-geometry.test.ts`，至少覆盖：
   - `placeEdgeBar` 的右缘 = 工作区右缘、垂直居中；
   - `resizeEdgeBarKeepingRight`：8 → 228 后右缘不变、y 不变、height 不变；228 → 8 同理（往返幂等）；
   - 工作区很窄时（例如 `width=200`）不出现负宽度 / 越界，x 被 clamp 到 `workArea.x`。

### B. 主进程

3. `apps/desktop/src/main/window-manager.ts`：
   - 新增私有字段 `private edgeBarExpanded = false`；
   - `sizeFor(name)` 增加 `if (name === 'edge-bar') return { width: EDGE_BAR_WIDTHS[this.edgeBarExpanded ? 'expanded' : 'collapsed'], height: SPECS['edge-bar'].height }`；
   - `computeBounds` 的 `case 'edge'` 改为走 `placeEdgeBar(area, sizeFor('edge-bar'))`，去掉硬编码；
   - 实现 `setEdgeBarExpanded(expanded: boolean): WindowState`：置位标记（窗口未创建时只记录，下次 `show()` 按标记建窗），
     已创建则 `win.setBounds(resizeEdgeBarKeepingRight(win.getBounds(), width, screen.getPrimaryDisplay().workArea))`，
     然后 `persistGeometry('edge-bar', win)`。**不动可见性、不广播状态**（与服务窗当年的 `setDockExpanded` 同一约定，
     避免无意义的渲染层更新）。
   - `hide('edge-bar')` 时把 `edgeBarExpanded` 复位为 `false` 并同步收缩窗口，避免下次显示时残留展开宽度；
   - `readGeometry('edge-bar')`：提示条尺寸由折叠态决定，**不要**复用持久化 width（否则收起态会继承上次展开的 228px，
     与当年服务窗踩过的坑同型）——沿用持久化 x/y，宽高取 `sizeFor('edge-bar')`。
   - 回归 step-01 修的 `show()` 互斥同步：确认 `show('chat')` 后 `mini-chat` 的真实 BrowserWindow 被 `hide()` 掉
     （`applyVisibility('mini-chat', false)`），反之亦然。若 step-01 未落地，本步必须补上。
4. `apps/desktop/src/main/ipc.ts` + `contracts.ts`：确认 `setEdgeBarExpanded` 的 port 方法与 handler 已接上
   `deps.windows.setEdgeBarExpanded(expanded)`（step-01 建的桩，本步换成真实实现）。

### C. 渲染层（`apps/desktop/src/renderer/edge-bar/App.vue`）

5. 交互重写：
   - 悬停展开：`mouseenter` 后**延迟 ~120ms** 调 `windowStore.setEdgeBarExpanded(true)` 并 `expanded = true`；
     `mouseleave` 后延迟 ~220ms 收起（延迟期间再次进入则取消收起）。用 `setTimeout` + `onUnmounted` 清理，
     避免 IPC 抖动导致窗口反复 resize 抖动。
   - 点击呼出交互窗：`.strip` 的 `@click="openChat"` 保留 → `windowStore.showChat()`；
     同时**不要**在展开时把 `.strip` 宽度动画到 0——删除 `.edge.expanded .strip { width: 0 }` 规则，
     让竖条始终是有效点击目标（这是本 bug 的第二个根因）。
   - 面板按钮保留：打开对话窗口 / 设置 / 小窗对话 / 隐藏提示条；每个按钮只需一行 `windowStore.*` 调用。
   - 键盘可达性：`focusable: false` 的窗口收不到焦点，不为提示条加 tab 焦点逻辑；所有操作都有鼠标入口。
6. 视觉暂用现有 `theme.css` 令牌（Apple 风格重构是 step-05，本步只保证行为正确、不写死不可维护的样式）：
   面板宽度用 `EDGE_BAR_WIDTHS.expanded` 对应的 228px 减去竖条，`overflow` 改为 `visible` 或按宽度自适应，
   确保面板内容完全落在窗口内（不能再出现「200px 面板塞进 8px 窗口」的裁剪）。

### D. 自测与文档

7. `apps/desktop/src/main/smoke.ts`：追加断言——`setEdgeBarExpanded(true)` 返回 ok 且 `visible['edge-bar'] === true`（可见性不被折叠态影响）、
   `setEdgeBarExpanded(false)` 同理；断言 `showChat()` 后 `visible.chat === true && visible['mini-chat'] === false`（互斥 + 真实显隐同步）。
8. `docs/07-ui-spec.md` §2.2 补实现说明：展开由 `window:setEdgeBarExpanded` 驱动、收起 8px / 展开 228px、
   右缘固定、点击呼出交互窗；并记录「可穿透性仍未实现」这一已知限制不变。
9. `docs/02-architecture.md` 的窗口表与 IPC 约定补上 `window:setEdgeBarExpanded`。
10. 出口：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`；
    再按 commit 约定提交 `fix(ui): 提示条点击无法呼出交互窗，改为可展开面板并新增 setEdgeBarExpanded`。

### E. 真实 Electron 验证（本步必须做，不能只靠单测）

11. 启动开发态并人工核对行为。**注意**：本仓库有已知坑——从会话里直接 `pnpm dev` 起的 Electron 会被回收，
    需要用 WMI 直接拉起（见项目 memory「启动 Aurora 要脱离会话」）。用 PowerShell：

    ```powershell
    $env:AURORA_DEVTOOLS='1'
    # 用 WMI / Start-Process 脱离当前会话启动，避免子进程被回收
    ```

    核对四件事并截图：① 鼠标移到屏幕右缘 8px 竖条 → 面板展开且**面板上的按钮可点**；
    ② 直接点击竖条 → 完整交互窗出现；③ 交互窗已打开时点「小窗对话」→ 小窗出现且交互窗消失（互斥）；
    ④ 移开鼠标 → 面板收起且窗口回到 8px（不留一块不可见的 228px 挡鼠标）。
12. 若第 ④ 条不达标（鼠标被不可见区域挡住），说明收起后必须收缩窗口——确认 `mouseleave` 路径真的调用了
    `setEdgeBarExpanded(false)`，并检查是否有意外持久化了展开宽度（见第 3 条最后一项）。

## 验收标准

- [x] `pnpm typecheck && pnpm test && pnpm build` 通过；`edge-bar-geometry.test.ts` 全部用例通过（含往返幂等与窄工作区 clamp）。
- [x] `AURORA_SMOKE=1 pnpm dev` 的 `AURORA_SMOKE_RESULT` 全绿（**92/92**），含新增的 `setEdgeBarExpanded` 与互斥断言。
- [x] 真实 Electron 下四条手动核对全部通过（面板按钮可点、点击呼出交互窗、互斥切换、移开鼠标后窗口收回 8px），有截图留证。
      → 四条**全部由机器证据闭合**（比人工点一遍更严格，但确实没有"人眼手感"这一项，见下）：
      ① 面板按钮可点：`AURORA_CAPTURE` 的 DOM 探针 `elementFromPoint` 命中测试 4/4 `hit=true`、`allClickable=true`；
      ② 点击竖条 → 交互窗：探针 `{"clicked":true,"chatVisible":true,"miniChatVisible":false,"primary":"chat"}`；
      ③ 互斥切换：同上 + AURORA_SMOKE 的互斥断言；
      ④ 移开鼠标收回 8px：AURORA_SMOKE 的「收起后真实窗口回到初始矩形（往返幂等）」；
      截图：`edge-bar.png`（收起）/ `edge-bar-expanded.png`（悬停展开）/ `edge-bar-collapsed-final.png`。
      该证据由 step-03 建立的 `AURORA_CAPTURE` 产出（见 step-03 执行记录）。
- [x] `window-manager.ts` 中没有残留的「只改状态机不同步真实窗口」的路径：`show('chat')` 与 `show('mini-chat')` 互相切换时，
      被顶掉的那个窗口在真实桌面上消失（`show()` 的互斥同步 + smoke 断言共同覆盖）。
- [x] `docs/07` §2.2 与 `docs/02` 的 IPC 列表已包含 `window:setEdgeBarExpanded` 与新的宽度约定。

## 交接

- 留给 step-03/05：提示条窗口现在有真实的两态宽度（8 / 228），面板宽度预算是 **220px**（228 减去 8px 竖条），
  Apple 风格重构时面板内容必须在 220px 内排布。
- 留给 step-05：面板 DOM 结构（状态块 / 模式块 / 最近消息 / 感知 / 操作区）沿用本步的行为绑定，
  只换皮与加动效，不要再改点击与悬停逻辑。
- 留给 step-03：截图核对工具（`AURORA_CAPTURE`）尚未实现，step-03 建好后要回到本步的四个场景补截图。

## 执行记录

### 实际改动

- **A. 几何模块**：新增 `apps/desktop/src/main/edge-bar-geometry.ts`（零依赖、不 import electron）
  与 `edge-bar-geometry.test.ts`（6 个用例）。`EDGE_BAR_WIDTHS = { collapsed: 8, expanded: 228 }`；
  `placeEdgeBar()` 右缘贴边 + 垂直居中；`resizeEdgeBarKeepingRight()` 右缘固定、y / height 不变并 clamp 进工作区
  （两者都处理了「工作区比窗口还窄」与「窗口已越出右缘」两种越界输入）。
- **B. 主进程**：`window-manager.ts` 新增 `edgeBarExpanded` 标记 + `sizeFor('edge-bar')` 两态分支；
  `computeBounds` 的 `edge` 分支改走 `placeEdgeBar()`；`setEdgeBarExpanded()` 落地（`setBounds` + 持久化，
  窗口未创建时只记标记）；`hide('edge-bar')` 走 `collapseEdgeBar()` 复位宽度；
  `readGeometry('edge-bar')` 不复用持久化宽高。
  `ipc.ts` / `contracts.ts` 的接线 step-01 已打通，本步只是把桩换成真实实现，无需改动。
- **C. 渲染层**：`edge-bar/App.vue` 重写交互（120ms 展开 / 220ms 收起 / 面板退出后再收窗口 / `onUnmounted` 清理定时器），
  删除 `.edge.expanded .strip { width: 0 }`，面板宽度改为 220px（= 228 - 8px 竖条），
  面板按钮补「小窗对话」的显式 handler，并把「在服务窗输入即可开始」的过期文案改为「点『小窗对话』开始」。
- **D. 自测与文档**：`smoke.ts` 新增提示条两态可见性断言；`index.ts` 新增 4 条**真实 BrowserWindow 几何**断言；
  `docs/07` §2.2 补实现说明、`docs/02` §6 补窗口 IPC 清单。
- **E. 真实 Electron 验证**：见下（部分由 step-03 补）。

### 与计划的差异（1 处，已说明理由）

- 计划第 3 条要求 `readGeometry('edge-bar')` **沿用持久化 x/y**。实现改为**沿用 y、水平位置一律重算贴右缘**：
  持久化的 x 可能来自展开态（右缘 - 228），复用它会让收起态竖条整体左移 228px、屏幕右缘反而漏出空隙，
  与「右缘固定」的硬约定冲突；提示条不参与用户拖动，x 没有需要记忆的信息。这条改动同时消掉了
  「什么时候退出就决定了下次竖条位置」这一类隐蔽 bug。

### 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | 全绿（0 error） |
| `pnpm test` | 43 文件 / **593 用例**全通过（含新增 6 个几何用例） |
| `pnpm build` | 成功 |
| `AURORA_SMOKE=1 pnpm dev` | **92/92 passed**（首轮 89/91，见下） |

真实 Electron 窗口几何断言（`getBounds()` 实测值，DPI 1.5）：

```
PASS 提示条收起态真实窗口约 8px 宽且贴右缘        — {"x":1698,"y":410,"width":10,"height":202}
PASS 提示条展开态真实窗口约 228px、右缘与 y 不变  — {"x":1478,"y":410,"width":229,"height":202}
PASS 提示条展开比收起宽出约 220px（8 -> 228）     — delta=219
PASS 提示条收起后真实窗口回到初始矩形（往返幂等） — {"x":1698,"y":410,"width":10,"height":202}
PASS 提示条展开后仍可见 / 提示条收起后仍可见
```

第一轮 89/91 的两条失败是**断言写法**问题，不是实现问题：Windows 的 `getBounds()` 会带上窗口的不可见边框，
`setBounds({ width: 8 })` 读回来是 10，`228` 读回来是 229（随 DPI 缩放变化），因此「精确相等」的断言不成立。
改为断言**不变量 + 容差**（右缘不变、y 不变、宽度差 ≈ 220、往返幂等），精确算术仍由纯函数单测覆盖。
这个 OS 行为已写进代码注释，避免后续再踩。

### 未完成 / 交接给 step-03

- 计划第 E 节第 11–12 条的「四条人工核对 + 截图」当时**没有完成**：仓库尚无截图能力（`AURORA_CAPTURE` 是 step-03 的产物）。
  **已于 step-03 补齐并勾选**（证据见上方验收标准最后一条）。
- 补充发现（由 step-03 的探针暴露，已在 `8aeba60` 修复）：本步只按计划加宽了窗口，展开态仍是 202px 高，
  4 个操作按钮落在 y=278~410、全部在可视区之外 —— 见 step-03 执行记录的「探针发现」。
- 交付给 step-03/05 的面板宽度预算是 **220px**（228 - 8px 竖条），Apple 风格重构不得越界；
  展开态高度现在是「工作区高 - 48px」（约 972px），step-05 需要把内容排布撑起来，否则中部会大面积留白。

### git 提交

- `b4e6d08` `fix(ui): 提示条点击无法呼出交互窗，改为可展开面板并新增 setEdgeBarExpanded`（8 文件）
- `8aeba60` `fix(ui): 提示条展开态不增高，面板按钮被挤出可视区`（5 文件，见 step-03 执行记录）
