---
date: 2026-10-05
title: Windows 游戏模式用 Game Bar 进程与独占全屏状态识别
tags: [Windows, 性能, 自感知, 坑]
source: 模型自动记录
---

## 现象

- 系统没有「Game Mode 是否正在生效」的公开 API；`HKCU\Software\Microsoft\GameBar\AutoGameModeEnabled` 只是用户的开关，不是「当前有游戏在跑」。
- 用 `tasklist` / `Get-Process` 每轮新建进程探测 `GameBarPresenceWriter.exe` 有持续 CPU 开销，单条常驻 PowerShell 又会先占约 100MB 工作集；`SHQueryUserNotificationState()` 只覆盖独占全屏 D3D，窗口化 / 无边框游戏需要另一个信号。

## 原因

- Game Mode 是运行时优化策略，不向普通应用暴露激活状态；注册表只存策略，Game Bar 才承担「这个进程是游戏」的判定；每次启动 PowerShell 都要重新加载宿主与 `Add-Type`，常驻宿主的初始工作集也不能代表稳态。

## 影响

- 误读开关 = 把「开了 Game Mode」当成「正在游戏」，没游戏时隐藏提示条、暂停文件自感知；每轮新建进程 = 后台联动变成持续 CPU 税收，放任常驻 = 客户端内存基线抬高约 100MB。

## 结论与做法

- 检测信号固定两道，**命中其一**即可：① `GameBarPresenceWriter.exe` 存在（覆盖窗口化）；② `SHQueryUserNotificationState() === 3`（`QUNS_RUNNING_D3D_FULL_SCREEN`，覆盖 Game Bar 被禁用）。PowerPoint 等普通 `QUNS_BUSY` 不参与判定（`game-mode.ts:72`）。已知边界：Game Bar 关闭且游戏窗口化 / 无边框时两道都不命中，此时不猜、不误伤。
- 探针放在**单条常驻 PowerShell 子进程**，只在 active 翻转时输出 `AURORA_GAME|0/1|gamebar/fullscreen/none`；不要拆成主进程周期 `execFile`。
- 启动后先设 `BelowNormal` 优先级，再用 `psapi.dll` 的 `EmptyWorkingSet()` 压工作集（`game-mode.ts:64-65`）：2026-10-05 时期实测约 100MB → 14MB，稳态 CPU 接近 0。
- 脚本带主进程 PID 自检，Electron 崩溃退出后探针不变孤儿；正常退出由 `GameModeController.stop()` 结束子进程。
- 进入游戏 = 提示条当时可见才隐藏 + `FileAwarenessService.suspend()`；退出 = `resume()` 后仅在进入前可见且当前总开关 / 勿扰允许时恢复。
