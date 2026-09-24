# Step 01 — 深色令牌层与视觉规范

- Task: aurora-visual-themes
- Step: 1 / 8
- Status: done
- Depends on: none
- Produces: 完成文档先行的双层令牌规范、深色基础令牌和可复跑的深色基线截图
- Phase: 基础与配置
- Writes: `docs/07-ui-spec.md`；`apps/desktop/src/renderer/shared/theme.css`
- Risk: 公共令牌影响四窗；保留旧令牌名，若截图有回归只回退改值部分，新增语义名不与旧名冲突。

## 目标

让四窗先消费同一份克制的深色设计令牌，保住所有旧 CSS 变量名、命中结构与 reduced-motion 兜底。

## 输入

- 先读 `docs/README.md`、`AGENTS.md`、`docs/07-ui-spec.md` §1/§2.2/§5，以及 `apps/desktop/src/renderer/shared/theme.css`。
- 读 `.dsh/skills/aurora-design-system/references/design-language.md`、`references/token-map.md`、`assets/theme.patch.css`；色板与品牌的取舍按这些文件，勿把源库品牌复制进 Aurora。
- 现有四窗单一深色 `:root`；既有 `--bg-*`、`--border-*`、`--text-*`、`--status-*`、`--space-1..6`、`--radius-sm|md|lg`、`--transition-fast|base`、`--font-ui|mono`、`--aurora-gradient` 名字只增不删；`theme.css:436-462` 必须保留。
- 项目命令见根目录 `package.json` 与 `AGENTS.md`：`pnpm typecheck`、`pnpm test`、`pnpm build`；截图命令 PowerShell：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-dark-token"; pnpm dev`。`report.json` 的实际结构为 `{ files, checks }`，每条 `check.ok` 与存在时的 `check.result.pass` 决定结果。

## 操作

1. 先改 `docs/07-ui-spec.md` §5.1/§5.2：写出原始中性阶与语义层、现有品牌不变、pill 动作/字段/卡片规则、150/250/350ms 和降动效策略；保留旧窗口交互规格。
2. 将 `.dsh/skills/aurora-design-system/assets/theme.patch.css` A/B 段**合并**至 `apps/desktop/src/renderer/shared/theme.css` 现有 `:root`（不要在文件末尾堆重复声明）；保留 `--bg-raised` 原值，候选灰阶仅在核对 PNG 后决定。补 `--space-7..10`、控制高度、描边/状态/聚焦语义令牌和静止卡片原子类，收拢 theme.css 自身非原始层的颜色字面量。
3. 不改变窗口几何或业务 DOM。运行 `pnpm build` 和完整深色 `AURORA_CAPTURE`，读实际 `report.json`，逐张查看 PNG，发现对比度/命中问题先改文档再微调令牌；记录令牌名增量和截图目录。

## 验收标准

- [ ] `pnpm build` 退出 0；`docs/07-ui-spec.md` §5.1/§5.2 写明新令牌与动效值，`theme.css` 含全部旧令牌声明及 `--neutral-*`、`--tracking-display`、`--shadow-hairline`、`--control-h-md`、`prefers-reduced-motion: reduce`。
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-dark-token"; pnpm dev` 退出 0；`report.json` 中 `files` 非空、所有 `checks` 的 `ok === true`、有 `result.pass` 的均为 `true`；逐张核对暗色文本、按钮、卡片无透明度导致的糊字，记录有证据的待修项。
- [ ] `theme.css` 的颜色字面量仅在原始色板/语义令牌声明或明确的阴影构造中；分组状态徽标与焦点用语义变量。

## 交接

提供新增令牌名字、含义与截图目录给 Step 02；深色基线完成后再动共享组件。

## 执行记录

2026-09-25：更新 `docs/07-ui-spec.md` §5.1/§5.2 的双层色板、语义角色、卡片和控件规则、150/250/350ms 动效；在 `theme.css` 原有 `:root` 中加入中性阶、状态与焦点语义色、排版/间距/控件尺寸令牌，保留旧变量名与 `--bg-raised` 值，将本文件焦点、选区、徽标、玻璃回退颜色收至语义层，加入 `.surface-card` 并保留降动效兜底。提交：`0dcbcf6`。

子代理：1 个只读探查分片核对 Git 既有改动、捕获链路和当前深色固定主题，确认五份 `package.json` 和未跟踪设计素材均属于原有用户工作；无代理写代码。主代理审阅 diff 并执行验收：`pnpm build` 退出 0；`pnpm exec prettier --check docs/07-ui-spec.md apps/desktop/src/renderer/shared/theme.css` 通过；`git diff --check` 通过。首次捕获因为环境变量 `ELECTRON_RUN_AS_NODE=1` 启动失败；移除此变量后首次完整捕获写出 27 张，但 `chat` 自动滚底探针偶发失败（distance 1309），其余通过；再次在独立临时目录运行完整捕获退出 0，`report.json` 为 files=27、checks=27、bad=0、missing=0，逐张接触图复核并检查 `settings-general.png` 原尺寸，未见深色文字、按钮、卡片模糊或明显溢出。通过目录：`%TEMP%\aurora-capture-dark-token-retry`；首次探针失败应在后续回归继续观察。

交接 Step 02：新增 `--neutral-900..50`、`--on-accent`、`--accent-ring`、`--focus-ring`、`--status-running-ring`、`--danger-*`、`--error-*`、`--warning-*`、`--ok-*`、`--space-7..10`、`--control-h-*`、`--hit-target`、`--tracking-display/eyebrow`、`--leading-relaxed`、`--num-tabular`、`--shadow-hairline`；优先让共享组件消费语义色。
