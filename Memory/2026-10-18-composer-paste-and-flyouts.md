---
date: 2026-10-18
title: 双端输入卡：缩略图必须在卡内、五浮层统一锚点、粘贴图片双端链路与探针口径
tags: [UI, composer, 粘贴, 缩略图, 浮层, Center, 协议, 探针, 坑]
source: 模型自动记录
---

# 双端输入卡（2026-10-18）

用户在同一个需求里点了三件事：**所有元素任何情况下都不要被遮挡**、**粘贴图片并显示缩略图**、
**所有浮层对齐选择权限的弹窗**。两条口径是这次改动的地基，后续改输入卡别绕开。

## 一、缩略图必须放在输入卡**内部**顶端

- 现象（如果放卡外）：附件行在 `.composer-box` 外面、input 上方；权限/斜杠/上下文浮层锚在
  `.composer-box` 上向上弹，底边只在卡片上方 6px —— 只要附件在卡外，浮层一开就必然盖住缩略图。
- 结论：附件条移进 `.composer-box`、`<textarea>` 之前；**单行横向滚动**（`flex-wrap: nowrap` +
  `overflow-x: auto`），不换行、不把卡片撑高。图片 56×56、非图片 28px chip、移除按钮命中区 24×24。
- 锚点：`chat.attachments` / `chat.attachment` / `chat.attachment-thumb` / `chat.attachment-remove`。
- 缩略图来源：`chat:readAttachment` 有 2 MiB 上限；粘贴图可能更大，所以 `chat:stageImage` 落盘时
  **顺手用 nativeImage 缩一张 96px `previewDataUrl` 随结果回传**，渲染层预置进 `attachmentPreviews`。
  非图片 / 超大 / 读失败只画占位图标，绝不渲染空 `src` 的裂图。
- **上下文详解卡不能用两列 dt/dd**（2026-10-18 用户截图）：320px 卡里两列各 ~140px，
  「1,000,000 tokens」「qwen · qwen3.8-flash」「模型未回传缓存字段」会把 label 与 value 挤到
  互相重叠。改成**单列 `grid-template-columns: 96px minmax(0, 1fr)`**，label 允许换行、
  value `overflow-wrap: anywhere`；卡片高度靠 `max-height` 内部滚动兜底。

## 二、五个浮层同一锚点/宽度/外观

- 共享原子类在 `packages/shared/src/browser/theme.css`：`.composer-flyout` +
  `--composer-flyout-width: 320px` / `--composer-flyout-gap: 6px`。
- 斜杠 / 权限 / 模型 / 思考 / 上下文**五个**都挂这个类；组件根节点保持 `position: static`，
  浮层 `position: absolute; bottom: calc(100% + gap); z-index: var(--z-flyout)`，
  因此包含块始终是 `.composer-box`（两端都要 `position: relative`）。
  **横向 2026-10-18 二次修订**：不再固定 `left: 0`，改为贴住触发它的按钮 ——
  `useComposerFlyoutLeft()` 读触发按钮 + 卡片矩形，`clampComposerFlyoutLeft()` 夹在卡内
  （靠右时按「卡右缘 − 320」回退）；窗口 resize 重算。斜杠没有按钮，保持左缘。
- **必须 `max-height: min(320px, 42dvh)` + 内部滚动**：窗口最小高度 + 200px textarea + 缩略图条时，
  没有上限的浮层会被 `.app-shell` 的 `overflow: hidden` 从顶部裁掉。
- 原生 `<select>` 换成了自绘芯片 + 菜单。旧实现的两个死结：系统弹出层无法定位（对齐不了权限弹窗），
  且固有宽度 = 最宽 option，窄窗只能裁字。自绘后 `.composer-bar { container: composer-bar / inline-size }`，
  容器 ≤430px 隐藏来源/模型/思考的文字标签（只留图标+箭头），**权限档位文案始终完整**；发送键
  `flex: 0 0 auto`。Web 端 ≤340px 容器允许工具行换行，发送/麦克风换行右对齐。
- 新锚点：`chat.model-menu` / `chat.model-source-center|local` / `chat.model-option`
  （`data-model-key` / `data-provider-id` / `data-model`）、`chat.effort-menu` / `chat.effort-<level>`
  （`data-level`）；触发器 `chat.reasoningEffort` 带 `data-value`，来源/模型触发器带
  `data-source-id` / `data-model-key`（探针不再读原生 select 的 `.value`）。
- 互斥由 `chat/App.vue` 的 `openFlyout: 'permission'|'model'|'effort'|'context'|null` 单点持有；
  Web 由 `openMenu` 单点持有。**点击外部 / Esc 都必须能关**，且 Web 菜单关闭不要留 250ms 离场动画
  —— 新旧两层会在离场里叠着，几何断言直接假红。

## 三、Web 图片随消息上行不是 `file.send`

- `file.send` 是「把文件推到客户端下载目录」，模型看不到；网页 composer 的图片必须扩展
  `session.input`：`attachments?: string[]`（fileId）→ 服务器 `fileLookup` 校验后补 name 下发
  `{ fileId, name }[]` → 客户端用自身令牌下载到 `<userData>/center-attachments/<ts>-<rand>/`
  → 走与 `chat:send` **同一个** `prepareAttachments`（`main/attachment-prepare.ts`）。
- 常量在 `packages/shared/src/center/protocol.ts`：`CENTER_INPUT_ATTACHMENT_LIMIT = 5`、
  `CENTER_INPUT_IMAGE_MAX_BYTES = 8 MiB`。服务器校验：未知 fileId `E_NOT_FOUND`、来源不是目标
  客户端 `E_FORBIDDEN`、超大小/超数量 `E_INVALID_ARGUMENT`。
- 旧客户端靠能力位降级：`ClientCapabilities.inputAttachments?`（hello）→
  `ClientStatus.center.inputAttachments?`；缺省 false。Web 不提供粘贴并提示升级，Hub 也拒绝带附件
  的命令，避免“图片被静默丢掉”。
- 带附件的 `session.input` 待回执超时放宽到 **5 分钟**（客户端要下载最多 5×8MiB）；沿用
  `pendingTimeoutMs(cmd)` 的分级方式，不要退回默认 15s。
- 网页上传仍复用 `/api/uploads` 的 24h 临时文件；发送成功不删（客户端还要下载），
  移除 / 切会话 / 卸载时才 best-effort `DELETE /api/files/:fileId`。

## 四、探针口径

- `chat-composer-flyouts`：五个浮层依次打开，断言任一时刻最多一个可见、五次快照的
  `left/bottom/width` 全部一致、都在 `.composer-box` 上方、与 `.composer-bar` 不相交、发送键命中自己。
  **2026-10-18 二次修订后**：不再要求同 `left`，改为 `triggerAligned` —— 每个浮层左缘贴住
  自己的触发按钮（靠右按卡右缘回退）；同 `bottom` + 同宽仍然保留。
  无 provider 时模型/思考触发器 disabled，如实跳过，但其余几何仍量。
- `chat-composer-narrow`：主区 420px 下五枚控件两两不相交、都在卡内、权限文案完整、
  四枚触发器 `scrollWidth <= clientWidth`；下限更新为 51/40/40/40/30。
- `chat-composer-paste`：**不要用 `clipboard.writeImage`** —— 本机 Electron 44 的 `clipboard` 已改成
  异步 `read()/write(ClipboardItem[])`，没有 `writeImage`。capture 里改为在页面内合成
  `ClipboardEvent('paste', { clipboardData: DataTransfer })` + `File`，同样真实走到
  `onComposerPaste` → `chat:stageImage` → 缩略图回填；断言缩略图在 textarea 上方且卡内、
  `src` 是 `data:image/…`、移除钮命中自己且移除后附件归零。
- **自动滚底四条（`chat.png` / `chat-follow-burst` / `chat-follow-wheel-up` / `chat-trace-wheel`）
  必须排在 `chat-subagent-page` / `chat-automation` 之前**：后两者会把主区 `view` 切到子代理 /
  自动化页，`.thread` 整个不渲染，探针只会得到 `no .thread/.messages`；也必须排在
  `chat-collapse` / `chat-drag` 之前（窗口一 hide 就没了）。本次全量跑就是按这个顺序修绿的。
- Center Web 端 Edge 实测支持 `new ClipboardEvent('paste', { clipboardData })`；`defineProperty`
  兜底只留给不支持构造参数的浏览器，但两条都进同一个 `@paste` 处理器。

## 五、验收基线（本次实测）

- 全仓 `pnpm typecheck` / `pnpm test`（176 文件、2635 用例）/ `pnpm build` 全绿。
- 桌面定向 capture：`chat-composer-flyouts`（flyoutCount 7、sameAnchor/sameWidth 全真）、
  `chat-composer-narrow`、`chat-composer-slash`、`chat-composer-permission`、`chat-hit-targets`、
  `chat-thinking-level`、`chat-composer-paste` 全 PASS；`chat-model-picker` 为既有恒红
  （离线无 Center 目录，两个来源只出现 local）。
- Center Web `verify:web` 全量 **96/96**（48 场景 × 暗浅），新增 `composer-pickers` /
  `composer-paste`，扩展 `mobile-single-column`。
