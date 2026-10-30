---
date: 2026-10-18
title: 双端输入卡：卡内缩略图、五浮层统一锚点与图片粘贴链路
tags: [UI, 布局, 探针, Center, 坑]
source: 模型自动记录
---

# 双端输入卡（2026-10-18）

## 现象

- 输入卡重做时用户点了三件事：所有元素任何情况下都不被遮挡、粘贴图片要显示缩略图、所有浮层对齐权限弹窗。
- 附件行若放在 `.composer-box` 外面（textarea 上方），权限 / 斜杠 / 上下文浮层一开就必然盖住缩略图。
- 五个浮层（斜杠 / 权限 / 模型 / 思考 / 上下文）原先锚点、宽度、横向位置各不相同。
- 工具行被压到主区下限 420px 时，权限钮与来源下拉互相压住（2026-10-11 用户实测）。

## 原因

- 浮层锚在 `.composer-box` 上向上弹；附件在卡外就落在浮层与卡之间。
- 各自写一套定位，同一条工具行的浮层几何必然分叉。
- `min-width: 0` 会让 flex 项被压到**子元素 min-content 以下**：`.perm-btn` 是行内级盒、带 `overflow: visible` 时直接画到邻居身上；`.composer-bar` 的 `overflow: hidden` 只管卡片边缘，管不了行内互相压。
- 原生 `<select>` 的系统弹出层无法定位，固有宽度又等于最宽 option，窄窗只能裁字。

## 影响

- 遮挡属于「看起来没坏但点不到」，只查 DOM 存在性的探针全绿。
- 浮层位置不一致会被当成「弹窗乱跳」；工具行重叠会把档位闸门文案盖掉。
- 粘贴图没有缩略图时，用户以为没贴上而重复粘贴。

## 结论与做法

- **附件条必须在 `.composer-box` 内部、`<textarea>` 之前**：单行横向滚动（`flex-wrap: nowrap` + `overflow-x: auto`），不换行、不把卡片撑高；图片 56×56、非图片 28px chip、移除钮 24×24。锚点 `chat.attachments` / `chat.attachment` / `chat.attachment-thumb` / `chat.attachment-remove`。
- 缩略图来源：`chat:readAttachment` 有 2 MiB 上限，`chat:stageImage` 落盘时用 `nativeImage` 缩一张 **96px** `previewDataUrl` 回传（`ipc.ts:2000`）；失败只画占位图标，绝不渲染空 `src` 的裂图。
- **五个浮层共用 `packages/shared/src/browser/theme.css:642-650` 的 `.composer-flyout`**：宽 `--composer-flyout-width` 320px、gap 6px、层级 `--z-flyout`；组件根保持 `position: static`，定位祖先始终是 `.composer-box`（两端都要 `position: relative`）。判据是**同一 `bottom` + 同一宽度 + `triggerAligned`**（左缘贴住各自触发按钮，靠右时按卡右缘 − 320 回退），不再要求同 `left`。
- 必须有 `max-height: min(320px, 42dvh)` + 内部滚动：窗口最小高度 + 200px textarea + 缩略图条时，没有上限的浮层会被 `.app-shell` 的 `overflow: hidden` 从顶部裁掉。
- 原生 `<select>` 换成自绘芯片 + 菜单：`.composer-bar { container: composer-bar / inline-size }`，容器 ≤430px 时来源 / 模型 / 思考只留图标 + 箭头，**权限档位文案始终完整**；发送键 `flex: 0 0 auto`。Web 端 ≤340px 允许工具行换行。
- **工具行唯一根因**：`min-width: 0` 会把容器压到子元素 min-content 以下（权限钮被盖住）。权限芯片改 `flex: 0 0 auto`、`.perm-btn` 改块级 `display: flex`，模型组不写死 `min-width`；探针下限 51/40/40/40/30（`capture.ts:7379`）。
- **`select option` 反色规则仍在 `theme.css:443-449`**（`background-color: var(--bg-raised)`、`:checked` 用 `--selection-fill`，刻意不声明 `color`）：它现在服务设置页等原生下拉，**不再是输入卡口径**（输入卡已无原生 select）。
- Web 图片随消息上行不是 `file.send`：扩展 `session.input` 的 `attachments?: string[]`，服务器 `fileLookup` 校验后补 name、客户端下载到 `center-attachments/` 再走同一个 `prepareAttachments`；常量 `CENTER_INPUT_ATTACHMENT_LIMIT = 5`、`CENTER_INPUT_IMAGE_MAX_BYTES = 8 MiB`，旧端缺 `ClientCapabilities.inputAttachments` 时直接拒绝，带附件的 `session.input` 回执放宽到 5 分钟。
- 探针：`chat-composer-flyouts` 断言任一时刻最多一个可见、同 bottom 同宽、`triggerAligned`、都在卡上方且不与 `.composer-bar` 相交、发送键命中自己；`chat-composer-narrow` 断言主区 420px 下五枚控件两两不相交、都在卡内、权限文案完整；`chat-composer-paste` 在页面内合成 `ClipboardEvent('paste')` + `File`（不要用 `clipboard.writeImage`，本机 Electron 44 已改异步 `read()` / `write()`）。
- `packages/shared/src/browser/**` 是双端单源：改完桌面 `AURORA_CAPTURE` 与 Center `verify:web` 都要跑。当前基线：全量截图 113（仅范围外 `chat-model-picker` 恒红）、Center 106/106、测试 2928。

> 2026-10-25 合并自 2026-10-11-composer-toolrow-and-native-select.md（原口径：来源 68 / 模型 68 / 思考 56 / 发送 32、`.model-picker-group { min-width: 140px }`、原生 `<select>` 是输入卡控件——均已作废）。
