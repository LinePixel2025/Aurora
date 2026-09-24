# Step 03 — 交互窗和内容组件

- Task: aurora-visual-themes
- Step: 3 / 8
- Status: done
- Depends on: step 2
- Produces: 消息气泡、工具/分类卡片、模型选择和输入区一致的深色视觉
- Phase: 核心链路
- Writes: `apps/desktop/src/renderer/chat/App.vue`；`apps/desktop/src/renderer/shared/components/MessageList.vue`；`apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue`；`apps/desktop/src/renderer/shared/components/ClassificationLedger.vue`；`apps/desktop/src/renderer/shared/components/ModelPickerSelect.vue`；`apps/desktop/src/renderer/shared/components/ThinkingLevelSelect.vue`
- Risk: `.thread`、`.messages` 和 `MessageList` 根节点布局会影响滚动；只改视觉规则，不动已有吸底逻辑。

## 目标

在 420px 窗口中让对话、代码、工具卡片和输入区共享圆角、边界与排版，保持发送、滚动和模型控件可用。

## 输入

- 读 `docs/07-ui-spec.md` §2.3/§5、`apps/desktop/src/renderer/shared/theme.css`、本步六个文件以及 `.dsh/skills/aurora-design-system/references/window-playbook.md` §2 和 `references/verification.md` §3。
- `.composer-bar` 顺序为 meta → 模型 `data-field="chat.model"` → 思考 `data-field="chat.reasoningEffort"` → 停止/发送；`.thread` 定高 flex，`MessageList` 根 `min-height:100%` 不变；标题栏保留 `useWindowDrag('chat')` 和「收起」文案。
- 字面量色值现存于 `chat/App.vue:930`、`ClassificationLedger.vue:297-362`、`ModelPickerSelect.vue:148`、`ThinkingLevelSelect.vue:105`；按 Step 01 的语义变量收编，若缺必要语义令牌，先记录需求并串行回到 Step 01 更新文档和主题。

## 操作

1. 调整对话正文为 `--leading-relaxed`、用户气泡/代码块/工具卡片为 1px 边界与统一圆角；状态/耗时/置信/时间用全局语义状态与 tabular 数字，不改变流式更新与折叠事件。
2. 使敏感操作确认与回到最新按钮遵守 pill 规则；输入区模型/思考控件与发送按钮同高，窄窗下让 meta 退让。保留滚动结构、拖动锚点和 data-field。
3. 跑针对 chat 的截图与构建，查看消息过长、工具展开、输入区操作行、自动滚底/收起探针结果。

## 验收标准

- [ ] `pnpm typecheck` 和 `pnpm build` 均退出 0；源码中的 `.thread` / `.messages` 滚动结构、`MessageList` 根 `min-height: 100%`、两个 `data-field` 与「收起」文案仍在。
- [ ] PowerShell：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-chat"; $env:AURORA_CAPTURE_WINDOWS='chat'; pnpm dev` 退出 0；`report.json` 有 PNG，全部 `checks` 为 `ok:true`，有 `pass` 的为 true，特别是自动滚底、回到最新、收起、两个下拉和拖动检查。
- [ ] 逐张检查 chat PNG，420px 下发送按钮未被挤出，消息/代码/工具卡片层级清楚，无横向溢出；记录截图与结论。

## 交接

将共享内容组件的最新视觉形态交给 Step 04（设置页也会使用分类流水）。

## 执行记录

2026-09-25：三个独立子代理按不重叠写范围分别实现交互窗 `App.vue`、消息与敏感卡片、分类流水与两个选择器；主代理复核 diff，移除交互窗父级与 `MessageList` 重复的样式规则。正文行高 1.55，气泡/代码/工具卡统一细边界和圆角，状态与数字使用语义令牌；模型/思考/发送控件统一 40px，高度与 420px 输入行兼容。保留 `.thread` flex/overflow、`.messages` 根 `min-height:100%`、拖动和 `data-field`。子代理分别执行局部 Prettier（交互窗另执行 ESLint）通过；主代理实际运行 `pnpm typecheck`、`pnpm build` 退出 0，六个改动文件 Prettier 通过；`AURORA_CAPTURE_WINDOWS=chat` 退出 0，`%TEMP%\aurora-capture-chat` 中 6 图/6 检查 bad=0，自动滚底 distance=0、收起/拖动/模型/思考探针 PASS。逐张查看交互窗截图，发送按钮未越界，输入行左侧 meta 正常省略；截图没有覆盖长模型名与真实流式工具展开的全部状态，后续全量复核继续关注。提交：`04c4051`。
