---
date: 2026-10-11
title: 提示条恢复原生 Acrylic：材质按窗口区域裁剪、圆角用 1px 阶梯区域、只在展开态挂
tags: [UI, edge-bar, 毛玻璃, Electron, Windows, 取证, 坑]
source: 模型自动记录
---

# 提示条恢复原生 Acrylic（2026-10-11）

用户报「edge-bar 背景不是毛玻璃效果」。2026-10-04 曾因「矩形材质 / 阴影从圆角外露出」退出原生材质
（见 [2026-10-04-window-native-acrylic.md](2026-10-04-window-native-acrylic.md)），本轮把它改回来。

## 结论

- `NATIVE_GLASS_WINDOWS` **加入 `edge-bar`**（五窗名单：chat / settings / memory / automation / edge-bar）；
  窗口选项维持 `transparent: true` + `hasShadow: false` + `thickFrame: false`。
- **DWM 的系统材质按窗口区域裁剪**（`setWindowRgn` / Electron `win.setShape()` 生效）。
  实测方式：收起态 shape 只有 8×200 时，材质也只画在那 8×200 里 —— 用 `desktopCapturer` 抓屏后
  逐像素比对「挂材质 vs 不挂材质」两个版本，**窗口矩形内其余位置的像素完全一致**。
  所以「圆角 + 真毛玻璃」可以兼得：把窗口区域也切成圆弧即可（见下一条）。
- 圆角用 **1px 阶梯区域近似**：`main/edge-bar-geometry.ts` 的 `roundLeftCorners(rect, radius)`
  逐行取圆方程的左内缩量、把连续相同内缩量的行合并成矩形（28px 半径约 20 块/角。
  展开态 = 面板列（客户区宽 − 8px，左圆角 28）+ 竖条（8×200，左圆角 6）；收起态 = 竖条一块）。
  **面板的 CSS 圆角与这里的阶梯是同一条弧，改一处必须同时改**（`--radius-xl` / 6px）。
- 材质**只在展开态挂**（`WindowManager.syncEdgeBarMaterial()`）：收起态页面只有 8px 竖条，
  挂着材质没有意义；建窗时的 `backgroundMaterial` 构造参数**必须与它同口径** ——
  否则建窗挂上、内部 `nativeGlassWindows` 却记成「没挂」，之后收起永远不会摘
  （实测踩过：收起态 `DWMWA_SYSTEMBACKDROP_TYPE` 仍是 3 = Acrylic）。
- 面板布局回到「`left: 0; right: 8px` + 左圆角」：面板要盖住「除竖条列以外」的整个客户区，
  材质才不会从面板边缘露出；实测客户区约 334px（`EDGE_BAR_WIDTHS.expanded = 328` 只是**建窗请求宽**，
  Electron 会给透明窗口补一圈不可见 inset，多出来的几 px 归面板）。

## 取证通道（这轮最大的坑）

- **`Graphics.CopyFromScreen`（PowerShell BitBlt）拍不到提示条窗口**：它带
  `WS_EX_NOREDIRECTIONBITMAP`（DirectComposition），内容只在 DWM/GPU 合成里。
  用它取证会得出「窗口根本没渲染」的**假结论**，我这轮因此在 A/B 上白绕了一大圈。
  可用通道：① Electron `desktopCapturer.getSources({types:['screen']})` 抓整屏（DXGI，含 DWM 合成结果）；
  ② 系统截图工具 Win+Shift+S（Windows.Graphics.Capture）；③ 只看窗口内容用 `PrintWindow(hwnd, dc, 2)`
  （flag 2 = PW_RENDERFULLCONTENT；flag 0 会全黑）。临时脚本模板见当时的 `%TEMP%\aurora-ui-fix\shot.js`。
- **watcher 重启后 edge-bar 的渲染进程可能是死的**：`electron-vite dev --watch` 因主进程改动重启后，
  窗口与原生 shape 都在、但页面 0% 非黑（PrintWindow）且**悬停不展开、点击无反应**。
  这会伪装成「材质导致鼠标事件失效」。规则：**任何输入 / 视觉 A/B 之前先干净重启**
  （杀 electron + 重新 `pnpm dev`），并等热态（30s+）再测；重启后 15s 内的悬停不展开是假阴性。

## 验证基线（2026-10-11 最终态）

- 定向截图 12/12（含 `edge-bar-expanded`：`coversWindow=true`、`panelAlpha=0.62`、`nativeGlass=true`）。
- 全量截图暗 / 亮各 **94 项 / 92 pass**，唯二失败是既存红 `chat-model-picker.png` 与本机固有抖动 `chat.png`。
- 冒烟 **199/199**；`pnpm test` 171 文件 / 2549 用例；`pnpm build`、`pnpm lint`、
  Center `verify:web` 88/88 全绿。
- OS 级观感：面板后是**被模糊的桌面**，圆角外**无矩形材质**（`desktopCapturer` 3× 放大圆角核对）。
