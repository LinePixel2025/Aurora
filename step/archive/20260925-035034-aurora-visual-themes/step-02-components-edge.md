# Step 02 — 共享组件和提示条

- Task: aurora-visual-themes
- Step: 2 / 8
- Status: done
- Depends on: step 1
- Produces: 胶囊按钮、统一字段/Toast/状态灯，以及保留 8↔228px 交互的提示条
- Phase: 核心链路
- Writes: `apps/desktop/src/renderer/shared/components/AppButton.vue`；`apps/desktop/src/renderer/shared/components/SettingField.vue`；`apps/desktop/src/renderer/shared/components/StatusDot.vue`；`apps/desktop/src/renderer/shared/components/AppToast.vue`；`apps/desktop/src/renderer/edge-bar/App.vue`
- Risk: 控件高度增大可能把提示条面板 3 个按钮挤出可点击区域；优先调内容密度，不动主进程几何。

## 目标

在最窄窗口验证组件尺寸、语义状态和按钮点击区，形成后续三窗可复用的视觉基线。

## 输入

- 读 `docs/07-ui-spec.md` §2.2/§5、Step 01 已落地的 `apps/desktop/src/renderer/shared/theme.css` 与 `docs/07-ui-spec.md`，以及本步 Writes 的五个文件。
- 读 `.dsh/skills/aurora-design-system/references/component-recipes.md` §1/§2 和 `references/window-playbook.md` §1、`references/verification.md` §3。
- 提示条窗口收起 8×200，展开宽 228，面板 220px 且 `right: 8px`；悬停展开等待 `EXPAND_DELAY_MS=120`、移开防误触等待 `COLLAPSE_DELAY_MS=220` 不变。`edge-bar/App.vue:35-36,83-96` 的 `PANEL_EXIT_MS=220` 另用于退出动画后收窄窗口；Step 01 把 `--dur-base` 调到 250ms 后必须把该退出等待与 CSS 实际退出时长对齐，不能让窗口提前裁掉面板。状态灯 1.8s 低频呼吸保持，`prefers-reduced-motion` 下停止。
- `AppButton` 新增 `lg` 时核对现有 props/size 类型，保留已有调用兼容；组件样式只使用 Step 01 建立的语义令牌，不新增裸色值。

## 操作

1. 在 `AppButton.vue` 统一 pill、sm/md/lg 控件高度及禁用样式；`SettingField.vue` 统一输入高度/圆角与 1px 聚焦环；`StatusDot.vue`、`AppToast.vue` 改用状态/警告语义变量。保持 SFC props、事件和现有业务门控。
2. `edge-bar/App.vue` 的分组标题、状态数值、按钮密度改为设计系统规范；将 `PANEL_EXIT_MS` 与实际 `.sheet-leave-active` 时长对齐（通常从 220 改为 250ms），保留独立的悬停 120ms、移开防误触 220ms；保留 5 组卡片、最近消息 flex、`.glass`、220px 面板与 8px 竖条点击目标。
3. 跑构建和仅提示条截图，核查三个按钮 `elementFromPoint`、竖条展开/收起及宽度，逐张看 PNG；失败时修复本步文件。

## 验收标准

- [ ] `pnpm typecheck` 和 `pnpm build` 均退出 0；`AppButton.vue` 的三个 size 分支可在源码定位，按钮圆角统一使用 `--radius-pill`；四个共享组件样式没有新加 `#hex` / `rgba()` 颜色字面量。
- [ ] PowerShell：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-edge"; $env:AURORA_CAPTURE_WINDOWS='edge-bar'; pnpm dev` 退出 0；其 `report.json` 的 `files` 非空，全部 `checks` 为 `ok:true` 且有 `pass` 的为 true，面板命中、点击竖条与折叠态检查通过；用 `edge-bar/App.vue` 的退出时长与 `theme.css` 的 `--dur-base` 比对，移出后的窗口缩回发生于面板退出结束之后。
- [ ] 查看该目录提示条 PNG：展开态 3 个按钮可见未被裁切，状态文字能读，竖条仍裸露可点；将截图目录与判定记录到本步执行记录。

## 交接

共享组件尺寸及令牌稳定后，Step 03 调整交互窗输入区时须重查 420px 宽度。

## 执行记录

2026-09-25：共享组件分片由独立子代理完成：`AppButton` 增加 sm/md/lg 的 32/40/48px 高度与 pill、语义色；`SettingField` 统一 36px 输入和 1px 聚焦环；`StatusDot` 使用状态光圈变量并修正 tone 响应；`AppToast` 使用状态语义色。提示条分片由另一子代理完成：`PANEL_EXIT_MS=250` 与 `--dur-base` 对齐，卡片密度、分组标题和状态数值语义化，保留 120/220ms 两个悬停时序及 220+8px 几何。两分片写范围无交叠，均通过局部 Prettier 检查；主代理审阅 diff 并亲自运行 `pnpm typecheck`、`pnpm build`（均退出 0）、`git diff --check`。设置 `AURORA_CAPTURE_WINDOWS=edge-bar` 的截图退出 0：`%TEMP%\aurora-capture-edge` 有 4 图、4 检查，bad=0；逐张核对提示条收起/展开，展开态 3 个按钮可见、命中且竖条裸露，探针确认宽 228px/面板 220px、点击竖条进入 chat。提交 `819dbde`。后续在 Step 03 继续核对 420px 输入行。
