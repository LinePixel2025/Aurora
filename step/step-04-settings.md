# Step 04 — 设置页与表单密度

- Task: aurora-visual-themes
- Step: 4 / 8
- Status: done
- Depends on: step 3
- Produces: 设置侧栏、八个页面和 ClassRoom 分组一致的卡片与表单样式
- Phase: 集成
- Writes: `apps/desktop/src/renderer/settings/`（该目录内 Vue 与 settings.css；不触及其它目录）
- Risk: 页面 DOM 重排会丢掉 `data-field`/`data-empty` 门控及拖动热区；优先只改样式。

## 目标

使设置页的侧栏、字段、模型目录、MCP/Skill/模式卡片和空状态采用统一令牌与信息密度，保持真实配置门控。

## 输入

- 读 `docs/07-ui-spec.md` §2.5/§5、`docs/08-settings-onboarding.md` §6.1、`apps/desktop/src/renderer/settings/App.vue`、`settings/settings.css`，并列读 `apps/desktop/src/renderer/settings/pages/*.vue`、`components/ClassroomSection.vue`、`components/classroom/*.vue`。
- `docs/07-ui-spec.md:135-161` 列侧栏 8 项与条件 DOM 规则；`.dsh/skills/aurora-design-system/references/window-playbook.md` §3 和 `references/component-recipes.md` §3-6 给卡片/导航/表格配方。
- `settings.css` 只由设置窗加载；模型页 `data-field="llm.providers.<id>"` 行、单编辑卡、`data-action`、语音页及 agent 工具门控必须保留。`general.language` 不可重现。

## 操作

1. 把 settings.css 里的选中、hover、表单焦点与 `.section-card` 静止态改为语义令牌、1px 描边和低阴影；分组头 eyebrow、数值 tabular；保留侧栏品牌指示条。
2. 按已有页面和 ClassRoom 子组件逐一收拢硬编码颜色与圆角/间距；空状态采用留白和一个动作，危险操作保留就地二次确认。只在确有必要时调整模板，不改变 `data-field`/`data-empty`、异步状态与配置写入逻辑。
3. 跑仅设置窗口截图、门控/拖动/模型目录探针，逐张查看八项侧栏对应页面及折叠态；记录每张页面与判断。

## 验收标准

- [ ] `pnpm typecheck` 和 `pnpm build` 退出 0；`settings/settings.css` 的卡片静止态用 `--shadow-hairline`/描边，聚焦环由语义令牌控制。
- [ ] PowerShell：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-settings"; $env:AURORA_CAPTURE_WINDOWS='settings'; pnpm dev` 退出 0；`report.json` 里 `files` 非空，全部 `checks.ok` 为 true、有 `result.pass` 的为 true；特别核对模型目录、`data-field`/`data-empty`、三类工具门控及 `settings-drag`。
- [ ] 设置页 PNG 逐张检查侧栏未截断，常规/模式/AI 模型/语音/Skill/MCP/电脑操控/高级八个入口的卡片与标题观感一致、可见文字易读；记录具体截图名称。

## 交接

把输入/卡片密度与设置页出现的问题交给 Step 05；后续浅色阶段仍需复跑门控探针。

## 执行记录

2026-09-25：三个子代理分别负责设置外壳（`App.vue`、`settings.css`）、八个 `pages/*.vue`、ClassRoom 分组与子组件（四个 Vue），写范围不重叠；三组局部 Prettier 全通过。侧栏使用 40px 导航项与 eyebrow、卡片细描边和 hairline、内联字段 36px 与语义焦点环；页面保持 `data-field`/`data-empty`/`data-action`、模型目录单编辑卡与危险操作二次确认。主代理审查 diff 并亲自运行 `pnpm typecheck`、`pnpm build` 均退出 0、设置目录 Prettier 通过、`git diff --check` 通过。`AURORA_CAPTURE_WINDOWS=settings` 完整执行退出 0，`%TEMP%\aurora-capture-settings` 含 16 图/16 检查 bad=0，拖动区 39px、模型目录、语音/电脑操控门控、ClassRoom 切 Work 后字段消失均 PASS。逐张接触图核对 `settings-general/modes/llm/tts/skills/mcp/agent/advanced.png` 和附加场景，侧栏各项未截断，卡片边界、标题一致；长页在既有滚动容器内继续滚动。提交 `dcdbfaa`。
