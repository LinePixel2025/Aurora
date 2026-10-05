---
date: 2026-10-05
title: Windows 游戏模式没有公开运行态 API，需用 Game Bar 进程与独占全屏状态识别
tags: [游戏模式, Windows, 性能, 坑]
source: 模型自动记录
---

# Windows 游戏模式检测

## 现象

- 想直接读取“Windows Game Mode 是否正在生效”时，系统没有公开 API；
  `HKCU\Software\Microsoft\GameBar\AutoGameModeEnabled` 只是用户的 Game Mode 开关，
  不是“当前是否有游戏在运行”。
- 用 `tasklist` / `Get-Process` 反复探测 `GameBarPresenceWriter.exe` 虽然能识别游戏，
  但每轮新建进程在高频轮询下 CPU 开销明显；单条常驻 PowerShell 又会先占约 100MB 工作集。
- `SHQueryUserNotificationState()` 能返回 `QUNS_RUNNING_D3D_FULL_SCREEN`，
  但只覆盖独占全屏 D3D，窗口化 / 无边框游戏需要另一个信号。

## 原因

- Windows 的 Game Mode 是运行时优化策略，不向普通应用暴露“已激活”查询接口；
  注册表只保存策略设置，Game Bar 才在日常生活中承担“这个进程是游戏”的判定。
- 每次启动 PowerShell 都要重新加载宿主与执行 `Add-Type`；常驻宿主的初始工作集也不能代表稳态，
  .NET 运行时会把已编译程序集和托管堆保留在 working set 中。

## 影响

- 误读 `AutoGameModeEnabled` 会把“开了 Game Mode 开关”当成“正在游戏”，在没有游戏时隐藏提示条、
  暂停文件自感知。
- 回退到每 5–10 秒新建 PowerShell / `tasklist` 会把一个后台联动功能变成持续 CPU 税收；
  放任常驻 PowerShell 又会把客户端内存基线抬高约 100MB。
- 只查独占全屏会漏掉大量窗口化 / 无边框游戏；只查 Game Bar 进程又会在 Game Bar 被禁用时失效。

## 结论与做法

- 检测信号固定两道：① `GameBarPresenceWriter.exe` 存在（Game Bar 识别到游戏，覆盖窗口化）；
  ② `SHQueryUserNotificationState() === 3`（独占全屏 D3D，覆盖 Game Bar 禁用场景）。
  两者只需其一命中；PowerPoint 等普通 `QUNS_BUSY` 不参与判定。
- 探针放在**单条常驻 PowerShell 子进程**中，只在 active 翻转时输出
  `AURORA_GAME|0/1|gamebar/fullscreen/none`；不要拆成主进程周期 `execFile`。
- 常驻探针启动后先设置 `BelowNormal` 优先级，再用 `psapi.dll` 的 `EmptyWorkingSet()` 压工作集；
  实测约 100MB → 14MB，稳态 CPU 接近 0。
- 脚本带主进程 PID 自检，Electron 崩溃退出后探针不会变孤儿；正常退出由
  `GameModeController.stop()` 结束子进程。
- 进入游戏 = 提示条当时可见才隐藏 + `FileAwarenessService.suspend()`；
  退出 = `resume()` 后仅在进入前可见且当前总开关 / 勿扰允许时恢复。
- 已知边界：Game Bar 关闭且游戏窗口化 / 无边框时，两道信号都可能不命中，此时不猜、不误伤。
