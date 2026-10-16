---
date: 2026-10-05
title: 自动化详情改为单例独立窗口，弹层不再受主区层级影响
tags: [UI, automation, window, IPC]
source: 模型自动记录
---

# 自动化详情独立窗口

## 现象

自动化历史和编辑器原本挂在主区 `AutomationPage` 内部，使用 `position: fixed` 的 Modal。
主区存在入场动画 / 层叠上下文时，遮罩只能盖住主内容区，右侧栏仍在上面，用户会看到
「弹窗层级坏了」。窗口较窄或浮层切换时也更容易被误判成 z-index 单点故障。

## 原因

`fixed` 的包含块不一定是 viewport；只要祖先形成 containing block / stacking context，
弹层就会被主区矩形裁住。把 z-index 调大不能从根本上解决这种层级边界。

## 影响

- 历史 / 编辑内容与侧栏争夺层级，用户无法确定当前操作面；
- 继续在主区里叠 Modal 会让 capture 探针和真实窗口行为不一致。

## 结论与做法

- `automation` 加入 `WINDOW_NAMES`，但按 `memory` 窗口先例**仅扩枚举，不推进 `CONFIG_VERSION`**。
  新窗口为单例 `780×720`（min `560×480`）、非置顶、可最小化 / 最大化，关闭 = 隐藏。
- 主界面只保留自动化列表。历史 / 新建 / 编辑经 `automation:openWindow` 打开或复用窗口，
  参数由 `automation:windowRequest` 推送；主进程必须等页面加载完成后再发送并显示窗口。
- 保留 `automation.editor` / `automation.history-panel` / `.run-item` 等锚点
  （**2026-10-16 更正**：`.detail-message` 随「纯文本回放」一起删掉了，新契约是
  `.day-head` / `.run-meta` / `.step-item` + `data-field="automation.replay"` /
  `automation.run-detail`，见 `Memory/2026-10-16-automation-history-detail-layers.md`）；
  新窗口使用独立 renderer entry（`electron.vite.config.ts` 的 `windowEntries.automation`），
  不要把 chat 窗口整页重载来承载详情。
- 验收基线：自动化相关定向截图 4/4、全量截图 85 张 / 0 失败、全量 Electron 冒烟 185/185。
