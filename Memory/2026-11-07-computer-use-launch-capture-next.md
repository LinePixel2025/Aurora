# Computer Use 三处修复：launch 的 null / 截屏坐标 / 下一步提示

**标签**：Computer Use, 工具, 窗口, 启动, 截图, 坐标, DPI, 前台, 提示词, Electron, 坑, 口径

## 结论

- **launch 的 `Cannot read properties of null (reading 'title')`**：`app_launch` 在没检测到窗口时
  返回 `window: $null`（PowerShell `ConvertTo-Json` 会保留 `"window":null`），端口用
  `result?.window === undefined` 判断，`null !== undefined` 成立后访问 `.title` 抛 TypeError。
  模型收到「失败」就换 `open_path` / `run_command` 再开一次 → 重复打开同一应用、反复确认。
  **口径**：宿主/端口的可空窗口一律按 `== null` 处理；launch 启动前先查同 exe 已运行窗口
  （无 args 直接 activate/restore，不起新进程）；有 args（新窗口 / URL）才走启动；宿主 5s 内
  按「新出现的 HWND + 同 pid 或同 exe」检测（只看 `MainWindowHandle` 会漏掉单实例交接）；
  没检测到窗口不是失败，返回「先截图确认，不要重复 launch」；同 command+args 8s 冷却。
- **截屏坐标**：Electron 官方明确 `DesktopCapturerSource.thumbnail` 的尺寸**不保证**等于
  `thumbnailSize`（depends on the scale of the screen）。旧代码把窗口的**物理偏移**直接当
  缩略图像素 `crop()`，端口又始终写显示器物理尺寸，窗口裁剪时图片内容与换算可能错位。
  现在 `planScreenCapture` 用**实际源图尺寸**反算：1:1 时用源图宽高（顺手修正 Electron 1px
  取整差），被缩放时用显示器物理尺寸；窗口裁剪先在源图像素里裁，`physicalRect` 由实际裁剪反算；
  结果文本给出「本次图像覆盖的物理区域 + 1 图片像素对应的物理像素数」。
- **同一应用 ≠ 同一 pid**：微信 / 浏览器多进程，截图目标是 pid A、点击落在 pid B 的窗口；
  旧校验按 pid 直接拒绝（会话实录「目标点当前属于「微信」...与最近截图的目标不一致」）。
  现在同一 `windowId` / 同一 pid / **同一 exe** 都算同一目标；换别的应用才报
  `E_CU_TARGET_CHANGED`。目标窗口在截图后移动 / 缩放 / 最小化 → `E_CU_TARGET_MOVED`；
  显示器几何变化 → `E_CU_VIEW_STALE`（`viewMatchesDisplay` 以前根本没被调用）。
- **DIP / 物理混用**：`pickDisplay` 用物理窗口中心去比 DIP `display.bounds`；无坐标 `scroll`
  用 `screen.getCursorScreenPoint()`（DIP）给 `WindowFromPoint`（物理）。两处都改为物理口径
  （`displayAtPhysicalPoint` / 宿主 `cursor_get`）。
- **窗口激活**：`SetForegroundWindow` 受前台锁限制，旧实现直接失败、宿主 message 为 null，
  模型只看到 `Computer Use 执行失败：window_activate`。现在 `BringWindowToTop` +
  `AttachThreadInput` + `SetForegroundWindow` + `SetFocus`，失败再 `SwitchToThisWindow`，
  PowerShell 侧兜底 `WScript.Shell.AppActivate(pid)`；返回 `{activated}`，失败给可读
  `FOCUS_REFUSED`。实测：后台 Edge 激活成功，再从 Edge 激活回 Notepad 也成功。
- **下一步提示**：六个动作工具的 `next` 改为**必填**；模型漏填时内核用同一轮**紧邻下一条**
  工具调用的 `ToolDefinition.nextStepLabel` 填 `ToolContext.nextStepHint`（只展示、不执行），
  两层都没有才清空。HUD / 状态条渲染不改。
- **UIA 弹出窗**：`computer_ui` 传了 `windowId` 仍要求它在 `window_list` 里，快速设置等弹出窗
  （ShellHost 的 `ControlCenterWindow`）不在 EnumWindows 列表 → 误报「读取前台窗口失败」。
  新增宿主 `window_info`，`ui()` / 截图 / 窗口动作都可用 HWND 直取；实测快速设置
  `window_info` 成功、`ui_find` 不再报读取失败。
- **无新增依赖 / 无配置迁移**：评估了 node-screenshots / nut.js，都需要原生依赖与 Electron
  asar/ABI 处理（node-screenshots README 还有 `copyOutputData` 的 Electron 崩溃坑），本次
  用现有 Win32 宿主 + 实际源图尺寸解决；`computerUse` Schema / `CONFIG_VERSION` / IPC 均未动。

## 实测证据（2026-11-07）

- 本机会话 `%APPDATA%/Aurora/sessions/chat-mw56k3a2-32.json`：
  `computer_window launch` → `Cannot read properties of null (reading 'title')`（微信 / Edge 多次）。
- 同一会话：`computer_mouse` → 「目标点当前属于「微信」...与最近截图的目标不一致」，重截后才成功。
- Electron 探针（本机 150%）：`display.bounds 1707×1067`、请求 `2561×1601`，实际缩略图
  **2561×1601** —— 这台机器是 1:1，但窗口裁剪仍需按实际源图尺寸换算（其它 DPI/低分辨率场景会错）。
- 宿主脚本（`pwsh -File`）实测：`app_launch notepad.exe` → 5s 内返回窗口「记事本」；
  `window_info` / `window_activate` / `window_close` 成功；从后台 Edge 激活成功、再激活回
  Notepad 成功；快速设置 `window_info` 成功。
- `buildNextHints` / `planScreenCapture` / `planLaunch` / `describeLaunchResult` 均有单测；
  `pnpm vitest run packages/agent-core/src` 953 条全绿（2026-11-07）。

## 长期口径

- **launch**：无 args + 同 exe 已运行 → 复用；有 args → 启动；5s 等窗；8s 同 command+args
  冷却；没检测到窗口是**成功**结果，不是错误。`window_activate` 失败不冒充成功。
- **截图**：任何窗口裁剪都必须以源图实际尺寸换算；结果文本必须写「本次图像覆盖的物理区域」；
  显示器几何 / 目标窗口 bounds 变化后拒绝旧坐标。
- **目标**：同一 exe 的其他窗口允许；不同应用拒绝；受保护窗口策略不变。
- **下一步**：`next` 必填；漏填走 `nextStepHint`；HUD 不显示旧计划。
- **UIA**：`windowId` 可直接用 `active` / 弹出窗 HWND，不要求出现在 `window_list`。
