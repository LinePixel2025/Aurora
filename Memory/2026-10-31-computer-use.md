# Computer Use（v39）：授权、PowerShell 宿主与浮层口径

**标签**：Computer Use, agent-core, 工具, 权限, PowerShell, 窗口, 浮层, 过程面板, RustDesk, 远程桌面, 截图, IPC, 探针, 坑, 口径

## 结论

- 八工具 = 6 动作（`computer_screenshot` / `mouse` / `keyboard` / `window` / `ui` / `wait`）
  + `computer_stop`（退出）+ `computer_start`（Agent 入口）。**三层门控**：
  注册（win32 + `computerUse.enabled` + 模型 vision + 非只读档）、请求级
  （`computerUseRunProfile`：未授权只留 `computer_start`，已授权留 7 个，非视觉 / 不合格会话
  整组摘掉）、执行级（`service.start()` 重查资格、端口 `ensureCallAllowed`）。任何一层漏掉
  都会让「没授权的会话看到工具」。
- `computerUse` 整组在 `SETTINGS_READONLY_PREFIXES`；授权只在内存、按会话、同时一个。
  **用户入口 = 输入框斜杠命令 `/computer`**（可用 `/computer <任务>` 一次完成授权 + 发送）；
  **Agent 入口 = `computer_start`**（2026-10-31 优化，sensitivity `confirm`：默认 auto 档静默，
  confirm 档弹确认卡）。2026-10-31 起输入框工具行的「操作电脑」开关与「开始操作」确认步骤已删除。
  `/computer` 还会把「请使用 Computer Use 工具操作电脑，完成：」放进用户消息，运行档也要求模型
  优先调 `computer_*`，否则模型会「有权限但不用」。
- **授权 ≠ 开始操作**：`computerUseService.start()` 只建立授权、不发 `started` 以外的副作用；
  浮层与光标动画由**第一次工具调用**（截图 / 读窗口 / 动作）经 `ensureCallAllowed → ensureOperating`
  懒启动。`stop()` 只在 `overlayShown` 时收起浮层，授权后未操作时屏幕上什么都没有。
  `computer_start` 走的也是 `service.start()`，所以 Agent 自行进入同样不会立刻弹浮层。
- **Agent 可主动退出，且退出即回前台**：`computer_stop`（sensitivity `safe`，无参数）→ 端口
  `service.stop('agent', sessionId)`，与用户点停止走同一条撤销路径；未授权时幂等返回「未在操作模式」。
  停止原因新增 `'agent'`；`onStopped(sessionId, reason)` 只在 `reason === 'agent'` 时调
  `WindowManager.bringToFront('chat')`（显示 + 最小化恢复 + 焦点）并推 `chat:remoteActivate`
  切回该会话。用户手动停止 / 设置页 / 锁屏 / 退出都不抢焦点。
- **会话资格唯一口径**：`main/computer-use/session-policy.ts` 的 `canHoldComputerUseSession`
  （空串 / `auto-` / `awareness-` / `-sub` 不合格；`center-` 合格），service 与 run profile 共用。
- Windows 输入走**常驻 PowerShell NDJSON 宿主**：脚本写 `<userData>/computer-use/win-host.ps1`
  用 `-File` 启动（`-EncodedCommand` 会超 32K 命令行）；`-Sta` 跑 UIAutomation；
  启动时 `Add-Type` + per-monitor DPI awareness。脚本只含 ASCII，用户文字只走 JSON。
- 坐标以**最近截图图片像素**为准：`physical = origin + image / scale`；没有截图 / 显示器变化
  要拒绝。点击前 `WindowFromPoint` 命中测试、移动后 `GetCursorPos` 回执、`SendInput` 返回 0
  必须报错，绝不静默在错误位置点击。
- **虚拟光标不跟随用户鼠标（2026-10-31 修订）**：光环的位置只由 `service.moveCursor()`
  （显示器内 DIP，约 60fps 插值 + easeOutCubic）写入，**原来那个 30fps 轮询
  `screen.getCursorScreenPoint()` 的 `startCursorLoop()` 已删除** —— 用户晃鼠标时它必须停在原地。
  进入操作态时用真实指针**播一次种子**（否则第一段滑动从屏幕左上角飞出来），仅此一次。
  目标点用 `screen.screenToDipPoint` 换算（`screenshots.ts` 的 `physicalToDip`），
  125% / 150% 缩放下不对齐就是在这一步算错的。
- **先移动光标、再点击（2026-10-31 修订）**：点击 / 双击 / 右键 / 拖拽 / 滚轮在 `SendInput` 之前
  先**只滑虚拟光标**（`moveDurationMs`），**这段滑行里系统指针原地不动**——第一版让它俩同步平滑
  移动，用户当场反馈「我的鼠标被拽着走」，那是错的。光环到位后停 `CURSOR_SETTLE_MS = 60ms`，
  才 `movePointer(start, 0)` 把系统指针**瞬移**到落点并立刻点击，最后 `noteClick()` 画涟漪。
  **这一下瞬移省不掉**：Windows 的点击 / 滚轮只发生在指针所在位置（`SetCursorPos` +
  `SendInput`；`PostMessage` 直投窗口对 Chromium / UWP 无效，不能当替代）。拖拽例外：按住拖动
  本身要让指针走完轨迹 —— 先滑到起点 → 指针瞬移到位 → 拖，虚拟光标再按宿主同一时长跟到终点。
  关闭 `showVirtualCursor` 时不播动画、也不等那 60ms；跨显示器不跨屏滑，直接在新屏落点。
- **涟漪坐标必须是显示器内 DIP**：`noteClick()` 以前直接把模型给的**图片像素**发出去，
  高 DPI / 缩放屏上涟漪会偏离落点。现在统一用 `dipOf(physical)` 算出的 DIP 点。
- 浮层每显示器一扇 + **顶部操作过程面板**：`focusable:false`、鼠标穿透、`showInactive()`；
  **绝不用 `setContentProtection(true)`**：WDA_EXCLUDEFROMCAPTURE 会让 RustDesk / 远程桌面 /
  屏幕共享里完全看不到浮层（本机实测就是这样，用户看到「没有流光、没有过程面板、没有虚拟光标」）。
  **进入操作模式后持续在场、每个动作实时更新**：不要为截图隐藏（用户明确要求「一直在场」；
  代价是模型截图会带上浮层）。面板只显示「这一步在干什么」与最近 3 步，
  **不显示运行时长 / 坐标 / 矩形 / 尺寸 / 输入文字**（2026-10-31 删除计时）。
  `ComputerUseStatus.recentActions` 是 `{ action, summary, count }[]`（新→旧，最多 6 条），
  面板挂载时据此补齐漏掉的前几步；`lastActionKind` 给对话状态条选图标。
- **步骤图标与历史分组（2026-10-31）**：`action` → 图标映射唯一一份在
  `apps/desktop/src/renderer/shared/computer-use-steps.ts`（截图 Scan、点击 MousePointerClick、
  移动 MousePointer2、键盘 Keyboard、窗口 AppWindow、UI 控件图标、等待 Timer、未知 Wrench）；
  图标全部在 `packages/shared/src/browser/icons.ts` 登记。历史逻辑：**连续**同一
  `action + summary` 合并成一条并把 `count` 累加（面板显示 `×N`），中间隔了别的步骤就保留为新
  一条 —— 旧实现是全局去重，会把旧位置抹掉、也不反映重复次数。
- 过程面板底色必须用 `--bg-overlay`（浅档白 / 深档 #2c2c2e）。**不能用 `--bg-elevated`**：
  这个令牌不存在，`var(--bg-elevated, #1c1c1e)` 会永远落到深色 fallback，浅色主题下就是
  「黑色提示框看不清」。窗口本身已跑 `applyAppearance`，但明暗是 `prefers-color-scheme`。
- 流光视觉 = **与「流光提醒」同款**的顶部光谱光带（rose / violet / accent / cyan / amber，
  `cu-glow-bloom` 呼吸 + `cu-glow-halo` / `cu-glow-line` 流转），不再是四边细线；
  关键帧 `computer-use-glow-breathe` / `computer-use-glow-spectrum`，类名仍用 `cu-glow-*` 防探针互撞。
- 过程描述由 `policy.ts` 的 `describe*Action` 生成，一律「正在 …」现在进行时；截图 / 读窗口 /
  等控件是**只读步骤**，走 `service.noteStep()`：进过程面板与状态条，**不计动作限额**。
- 受保护目标硬编码：Aurora 自身 pid、终端 / shell、任务管理器、UAC / 锁屏；`allowedApps` 空
  = 除禁止项与保护目标外允许，deny 优先；`launch` 只接受 `.exe` / `.com`。

## 实测坑

- **worktree 里跑 electron-vite 要用 `ELECTRON_EXEC_PATH`**（不是 `ELECTRON_OVERRIDE_DIST_PATH`）：
  electron-vite 自己拼 `node_modules/electron/dist/<path.txt>` 且**不读** electron 官方那个覆盖变量。
  worktree 安装缺 `dist/` 与 `path.txt` 时先补 `path.txt`（内容 `electron.exe`，只改 node_modules），
  再 `$env:ELECTRON_EXEC_PATH='<主仓库>\\node_modules\\.pnpm\\electron@…\\node_modules\\electron\\dist\\electron.exe'`。
- **内容保护 + 远程桌面 = 全部视觉消失（2026-10-31 实测）**：`setContentProtection(true)`
  （WDA_EXCLUDEFROMCAPTURE）会让浮层在 RustDesk / 远程桌面 / 屏幕共享的画面里完全不可见，
  但 Win32 侧 `isVisible()` / `isAlwaysOnTop()` / DWM `cloaked=0` 全部正常，日志也照常打印
  「浮层已显示」——非常像「窗口没建」。判据：用 GDI `CopyFromScreen` 截整屏，保护开启时顶部
  没有过程面板、关闭时同一位置出现；Agent 自己的 `capturePage` 两种情况都能拍到（**不能**用它判断）。
- **不要为截图隐藏浮层（2026-10-31 用户口径）**：曾用 `withVisualsHidden` 在 `captureDisplay()`
  前后隐藏 / 恢复，结果用户看到浮层频繁闪断，明确要求「所有特效、提示框一直在场」。
  现在截屏不隐藏，模型图片会带上 HUD / 光标 / 光带；如果将来要排除，只能另找不闪断的方案，
  别再回到「隐藏 → 截图 → 恢复」。
- **不要给 `overlay.applyConfig()` 接授权路径**：WindowManager 的 `applyComputerUseConfig()` 会直接
  `showComputerUseOverlays()`。所以 `start()` 里不调它、`reconfigure()` 只在 `overlayShown` 时调；
  否则「刚输入 `/computer` 就满屏流光」。
- **过程面板几何（2026-10-31）**：窗口 560×116、`y = display.bounds.y + 20`（顶部居中，**不是底部**）；
  探针 `nativeCheck` 用 `screen.getDisplayMatching(hud.bounds)` 断言 `hud.bounds.y - display.y <= 200`。
  面板设计走「安静的状态仪器」：状态行 + 当前步骤 + 最近 2 步，唯一装饰是贴顶 1px 光谱细线；
  不再用色块/分隔线/时间；600×128 旧尺寸已废弃。
- **探针口径**：`chat-computer-use.png` 现在是「输入 `/computer` 后斜杠候选出现且旧开关不存在」；
  `computer-use-overlay.png` 断言顶部光带的 `computer-use-glow-breathe` / `computer-use-glow-spectrum`
  动画名与光标 / 光环；`computer-use-hud.png` 断言 `.hud-title` 含「正在操作」、`.hud-text` 含「正在」
  且不含 `(`、至少 2 条 `.hud-step`、当前 / 历史图标（`.hud-current-icon` / `.hud-history-icon`）、
  至少 1 个 `×N`（`.hud-repeat`）、心跳 `computer-use-hud-heartbeat`、无 `.hud-time`；
  两个 nativeCheck 都要求 `contentProtected === false`（防有人把内容保护加回来）。
- **`win-host-script.ts` 里不能出现反引号**：PS 按键表里的反引号会提前结束 TS 模板字符串，
  报一长串「',' expected」。用字符码或删除该键。
- **脚本字符集**：PS 5.1 读 UTF-8 无 BOM 的中文会乱码；脚本保持 ASCII，中文提示全部在 TS 侧。
- **`Add-Type` + `-File`**：`-EncodedCommand` 传 50KB 脚本会超命令行上限；落盘启动才可靠。
- **UIA 递归计数要用 `$script:`**：PowerShell 子函数里 `$visited++` 是局部变量，递归上限失效；
  写成 `$script:UiaFindVisited`。
- **截图探针是透明窗口**：`capturePage()` 会把透明底合成成白色；看流光 / 光标时不要以为「背景白 =
  坏了」，真实桌面是透明叠加。
- **`useCaptureStub` 要 await `settings.update`**：否则紧接着的 `prepare` 读到旧 provider，
  `/computer` 因 vision=false 不进候选（`chat-computer-use` 探针假红）。
- **浮层飞层是玻璃背景**：截图里后面的图表会透出来，不是 z-index 问题；要更实可换
  `--bg-elevated`，但会偏离既有 composer flyout 的观感。

## 已知限制

- UIPI 下无法驱动管理员窗口；UAC 安全桌面 / 锁屏不可见；独占全屏可能遮住浮层。
- 多屏不同 DPI 跨屏移动窗口后要重新截图；原生系统指针保留（虚拟光标是光环 + 拖尾）。
- 截图会发送给模型，可能包含敏感屏幕内容；过程面板不含坐标 / 输入文字，日志只记动作类型。

> 2026-10-31 修订：入口改为 `/computer` 并带显式指令、授权与操作分离、底部 HUD 改为顶部过程面板、
> 流光改为「流光提醒」同款顶部光带；修复「RustDesk 下看不到浮层」——去掉内容保护；再按用户要求
> 去掉计时、改为操作期间持续在场（不为截图隐藏）、加 `computer_stop` 让 Agent 主动退出，
> 并把过程面板底色从不存在的 `--bg-elevated` 换回 `--bg-overlay`（浅色主题白卡可读）。
> 面板再精简为 560×116「安静的状态仪器」：状态行 / 当前步骤 / 最近 2 步，唯一装饰是贴顶
> 1px 光谱细线；每一步带语义图标，连续相同操作合并 `×N`。实测：外部 GDI 截屏能看到
> HUD / 光带 / 光标；capture 4/4 全绿。
> 2026-10-31 二次修订（本分支）：新增 `computer_start` 让 Agent 自行进入（只授权、不建浮层），
> 保留 `/computer` 作为用户入口；`computer_stop` 退出时把 Aurora 带回前台并切回该会话，
> 只有 `agent` 结束原因抢焦点。
> 2026-10-31 三次修订（虚拟光标解耦）：删掉「30fps 轮询真实指针」的 `startCursorLoop()`，
> 虚拟光标改为只由 `service.moveCursor()` 驱动（60fps 插值 + easeOutCubic，显示器内 DIP），
> 进入操作态时用真实指针播一次种子；点击类动作改为「先滑光标到位 → 停 60ms → `SendInput` →
> 涟漪」，并把涟漪坐标从图片像素改成 DIP。测试口径：`service.test.ts` 断言
> 「没有动作就不再发 `cursor` 事件」「滑动中途帧单调」「新滑动取消旧滑动 / `stop()` 取消在途滑动」。
> 2026-10-31 四次修订（滑行时不要拖走用户的鼠标）：三次修订里系统指针跟着虚拟光标**一起平滑移动**，
> 用户实测立刻指出「虚拟光标移动时我的鼠标也在动」。改成滑行阶段系统指针原地不动，等光环到位 +
> 停 60ms 后才瞬移并点击。**别再把两者做成同步动画**；也别忘了这一下瞬移无法避免（点击只能在
> 指针处发生），否则会误以为「可以让真实指针完全不动」。
