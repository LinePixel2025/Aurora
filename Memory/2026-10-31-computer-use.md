# Computer Use（v39）：授权、PowerShell 宿主与浮层口径

**标签**：Computer Use, agent-core, 工具, 权限, PowerShell, 窗口, 浮层, IPC, 探针, 坑, 口径

## 结论

- 六工具（`computer_screenshot` / `mouse` / `keyboard` / `window` / `ui` / `wait`）**三层门控**：
  注册（win32 + `computerUse.enabled` + 模型 vision + 非只读档）、请求级
  （`computerUseRunProfile` 对未授权 / 非视觉会话 `hiddenTools`）、执行级
  （端口 `ensureCallAllowed`）。任何一层漏掉都会让「没授权的会话看到工具」。
- `computerUse` 整组在 `SETTINGS_READONLY_PREFIXES`；授权只在内存、按会话、同时一个。
  输入框 `chat.computer-use` 是唯一开启入口（Agent 没有开启工具）。
- Windows 输入走**常驻 PowerShell NDJSON 宿主**：脚本写 `<userData>/computer-use/win-host.ps1`
  用 `-File` 启动（`-EncodedCommand` 会超 32K 命令行）；`-Sta` 跑 UIAutomation；
  启动时 `Add-Type` + per-monitor DPI awareness。脚本只含 ASCII，用户文字只走 JSON。
- 坐标以**最近截图图片像素**为准：`physical = origin + image / scale`；没有截图 / 显示器变化
  要拒绝。点击前 `WindowFromPoint` 命中测试、移动后 `GetCursorPos` 回执、`SendInput` 返回 0
  必须报错，绝不静默在错误位置点击。
- 浮层每显示器一扇 + HUD：`focusable:false`、鼠标穿透、`showInactive()`、
  `setContentProtection(true)`（不进截图）；流光持续，用户手动输入**不自动停止**。
- 受保护目标硬编码：Aurora 自身 pid、终端 / shell、任务管理器、UAC / 锁屏；`allowedApps` 空
  = 除禁止项与保护目标外允许，deny 优先；`launch` 只接受 `.exe` / `.com`。

## 实测坑

- **`win-host-script.ts` 里不能出现反引号**：PS 按键表里的反引号会提前结束 TS 模板字符串，
  报一长串「',' expected」。用字符码或删除该键。
- **脚本字符集**：PS 5.1 读 UTF-8 无 BOM 的中文会乱码；脚本保持 ASCII，中文提示全部在 TS 侧。
- **`Add-Type` + `-File`**：`-EncodedCommand` 传 50KB 脚本会超命令行上限；落盘启动才可靠。
- **UIA 递归计数要用 `$script:`**：PowerShell 子函数里 `$visited++` 是局部变量，递归上限失效；
  写成 `$script:UiaFindVisited`。
- **Electron 二进制在 worktree 下可能无法执行**（本机实测：从 `.agents/worktrees/...` 直接跑
  electron.exe 静默失败，复制到 `%TEMP%` 再跑正常）；跑 smoke / capture 可用
  `ELECTRON_OVERRIDE_DIST_PATH` 指向临时 electron 目录，或直接 `& "$tmp\electron.exe" apps/desktop`。
- **截图探针是透明窗口**：`capturePage()` 会把透明底合成成白色；看流光 / 光标时不要以为「背景白 =
  坏了」，真实桌面是透明叠加。
- **`useCaptureStub` 要 await `settings.update`**：否则紧接着的 `prepare` 读到旧 provider，
  Computer Use 输入框入口因 vision=false 不渲染（`chat-computer-use` 探针假红）。
- **浮层飞层是玻璃背景**：截图里后面的图表会透出来，不是 z-index 问题；要更实可换
  `--bg-elevated`，但会偏离既有 composer flyout 的观感。

## 已知限制

- UIPI 下无法驱动管理员窗口；UAC 安全桌面 / 锁屏不可见；独占全屏可能遮住浮层。
- 多屏不同 DPI 跨屏移动窗口后要重新截图；原生系统指针保留（虚拟光标是光环 + 拖尾）。
- 截图会发送给模型，可能包含敏感屏幕内容；日志 / HUD 不含输入文字。
