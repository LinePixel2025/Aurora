# 任务：统一 Aurora 四窗视觉设计系统并增加跟随系统的浅色主题

- 任务标识：aurora-visual-themes
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-25 00:38
- 执行模式：单个
- 基线提交：3ba9aaba0567d2ab6604bdee532fc7be036f53c0
- 归档目录：（完成后填写：`step/archive/<YYYYMMDD-HHMMSS>-aurora-visual-themes`）
- 归档时间：（完成后填写）

## 完成标准

- 深色与跟随 Windows 外观切换的浅色状态下，提示条、交互窗、设置和引导窗共用语义令牌、胶囊动作和一致的卡片、字段、状态色；系统主题切换后，已打开窗口的页面与原生窗口底色同步，不闪出深色底；引导四个阶段均有可复跑的截图/探针证据。
- `pnpm typecheck`、`pnpm test`、`pnpm build` 均退出 0；在深色和浅色条件下分别运行完整 `AURORA_CAPTURE`，两份 `report.json` 中全部 `checks` 均 `ok: true` 且带 `pass` 的结果为 `true`，PNG 逐张人工复核无溢出、糊字、丢失按钮；不按固定截图数量判定。
- `docs/07-ui-spec.md` §5.1/§5.2/§5.3 记录令牌、动效和双主题截图口径；明暗切换不修改窗口几何与用户配置。

## 现状与关键结论

- 文档入口 `docs/README.md:3-6` 确认 docs 为 SSOT；`docs/07-ui-spec.md:204-241` 固定深色令牌与降动效规则，`docs/07-ui-spec.md:21-50` 固定提示条 8↔228px 几何和 220px 面板。
- `apps/desktop/src/renderer/shared/theme.css:14-102` 是唯一公共令牌层，`:root` 当前 `color-scheme: dark`；`:focus-visible`、徽标及玻璃回退仍有颜色字面量；`theme.css:436-462` 已全局兜底减少动态效果。
- `apps/desktop/src/renderer/shared/components/AppButton.vue:66-102`、`SettingField.vue:92-116`、`AppToast.vue:31-45` 与 `StatusDot.vue:40` 存在字面量颜色/聚焦环；各窗口还分散有类似写法。`settings/settings.css:92` 亦有硬编码聚焦色。
- `apps/desktop/src/main/window-manager.ts:51-92,173-195` 设定四窗尺寸、透明性与固定 `backgroundColor`；当前没有 `nativeTheme` 消费方，`packages/shared/src/config/schema.ts:53-60` 无主题配置。浅色需要同步原生窗口底色和 CSS，保持提示条透明与既有几何。
- `apps/desktop/src/main/capture.ts:108-159` 的截图检查返回 `checks`，`apps/desktop/src/main/index.ts:820-871` 把结果写入 `report.json`，失败码为 1/2；`docs/07-ui-spec.md:245-376` 记录门控、拖动、滚动与点击探针。全量截图隔离 userData。
- `apps/desktop/package.json:33` 声明 Electron `^33.2.1`；Electron 官方文档说明 `nativeTheme` 的 `updated` 事件、`shouldUseDarkColors` 和默认 `themeSource = system`，以及 `BrowserWindow.setBackgroundColor()` 可更新已有窗口底色：[nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)（访问 2026-09-25；官方网页为 latest，执行时先核验本地 Electron 33 类型/API）。
- 近期 `git log --oneline -20` 以中文 Conventional Commits 分阶段提交；当前工作树已有用户对多个 `package.json` 的修改，`Design/` 与 `.dsh/` 未追踪，本计划不得覆盖或清理它们；`step/` 顶层无未归档任务，只有历史归档。

## 假设与待确认

- 假设：用户选择“加入浅色主题”且文档 `docs/07-ui-spec.md:9` 写“跟随系统”，故明暗随 Windows 外观自动切换；本轮不增手动主题设置。若用户希望手动切换，执行浅色步骤前调整计划。
- 假设：沿用 Aurora 极光品牌色和系统字体，允许调整既有阴影、灰阶、时长及补充新令牌；保持窗口业务逻辑与拖动/命中结构。
- 待确认：无。

## 范围之外（明确不做）

- 不搬 `Design/Apple Copy` 的商标、产品文案和网络字体，不增 UI 框架或依赖。
- 不改 `edge-bar-geometry.ts` 的尺寸算术、各窗尺寸及 `focusable`；不改 Agent、TTS、MCP、配置 Schema、引导流程与交互功能。
- 不格式化或删除现有 `Design/`、`.dsh/`、用户已修改的 `package.json`；不将截图环境开关注入正式设置页。

## 步骤

> 同波可并行（写范围互不重叠）：无。按提示条 → 交互窗 → 设置 → 引导顺序定密度；双主题整合在四窗深色基线之后。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-tokens.md | 深色令牌层与视觉规范 | done | - | `docs/07-ui-spec.md`、`apps/desktop/src/renderer/shared/theme.css` |
| 2 | step-02-components-edge.md | 共享组件和提示条 | done | step 1 | `apps/desktop/src/renderer/shared/components/{AppButton,SettingField,StatusDot,AppToast}.vue`、`apps/desktop/src/renderer/edge-bar/App.vue` |
| 3 | step-03-chat.md | 交互窗和内容组件 | pending | step 2 | `apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/shared/components/{MessageList,SensitiveToolCard,ClassificationLedger,ModelPickerSelect,ThinkingLevelSelect}.vue` |
| 4 | step-04-settings.md | 设置页与表单密度 | pending | step 3 | `apps/desktop/src/renderer/settings/` |
| 5 | step-05-onboarding.md | 引导页与完成状态 | pending | step 4 | `apps/desktop/src/renderer/onboarding/App.vue`、`apps/desktop/src/main/capture.ts`、`docs/07-ui-spec.md` |
| 6 | step-06-light-theme.md | 系统浅色主题与双主题截图 | pending | step 5 | `docs/07-ui-spec.md`、`apps/desktop/src/renderer/`、`apps/desktop/src/main/{window-manager,index,capture}.ts` |
| 7 | step-07-verify.md | 全量回归与逐图复核 | pending | step 6 | 只读（执行记录回填由执行器管理） |
| 8 | step-08-archive.md | 归档清理 | pending | step 1..7 | `step/` |

## 执行记录

- Step 02：`819dbde feat(ui): 统一共享控件与提示条视觉`。两个不交叠分片分别由子代理实现共享组件和提示条，主代理复核并运行 typecheck/build、4 张提示条截图与 4 条 PASS 检查；详见 `step-02-components-edge.md`。
- Step 01：`0dcbcf6 feat(ui): 建立深色语义令牌与视觉规范`。`pnpm build`、Prettier 检查、完整深色捕获第二次执行通过（27 图/27 检查）；第一次完整捕获的交互窗自动滚底探针间歇失败，详见 `step-01-tokens.md` 执行记录。子代理只读核查捕获机制与用户既有改动，主代理实现并复跑验收。保留既有五份 `package.json` 修改和未跟踪 `.dsh/`、`Design/`。
