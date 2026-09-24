# Step 07 — 全量回归与逐图复核

- Task: aurora-visual-themes
- Step: 7 / 8
- Status: done
- Depends on: step 6
- Produces: 完整的明暗截图、探针/自动化结果和逐窗视觉记录
- Phase: 测试与文档
- Writes: 只读（截图写入 `%TEMP%`；执行器只回填本步和索引的执行记录；发现缺陷退回对应已编号步骤修复）
- Risk: 视觉探针只能判结构与命中，不能代替逐张检查；浅色/深色都必须人工核对实际 PNG。

## 目标

用自动检查、真实 Electron 截图及逐窗目视确认四窗双主题完成标准，并记录仍存在的风险。

## 输入

- 读 `docs/07-ui-spec.md` §5.3、`.dsh/skills/aurora-design-system/references/verification.md`、`apps/desktop/src/main/index.ts` 的 `runCapture()`、Step 01-06 的执行记录和截图产物。
- 本计划根目录 `D:\AICOP\Projects\Aurora`；命令在根目录运行，`AURORA_CAPTURE` userData 自动隔离；`report.json` 为 `{ dir, files, checks }`，每条 `ok` 应为 true，`result.pass` 出现时应为 true；不假设固定 PNG 张数。
- 根目录 `package.json` 的 typecheck/test/build/lint/format:check 命令真实存在；`.dsh/skills/aurora-design-system/references/verification.md:86-96` 记载未追踪 `Design/` 可能使全仓 format:check 失败，失败时逐项区分本轮文件与外部素材，不自动改写 Design。

## 操作

1. 在项目根目录逐条运行 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm lint`；运行 `pnpm format:check`，若只因未追踪 `Design/` 失败，记录文件名并用 `pnpm exec prettier --check "apps/desktop/src/renderer/**/*.{vue,css}" "apps/desktop/src/main/{window-manager,index,capture}.ts"` 验本轮源码，按实际 Prettier glob 支持情况拆成具体路径；不能把失败说成全仓通过。
2. 在分别指定 `AURORA_CAPTURE_THEME=dark` 和 `light` 时完整运行 `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-verify-dark"; pnpm dev` / `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-verify-light"; pnpm dev`（每次在对应 PowerShell 命令里先设置 `$env:AURORA_CAPTURE_THEME`）；读两份 `report.json` 的全部 `checks`，逐条核对 `ok` 和可用的 `result.pass`、截图实际张数。
3. 用图片阅读工具逐张打开深/浅 PNG：提示条 8px 竖条与展开面板/按钮、交互窗 420px 的长消息/代码/工具/发送按钮、设置八项页面的门控与拖动、引导四阶段独立截图的对比度与裁切。记录截图文件名、观察结果和发现的不足；人工检查 `prefers-reduced-motion` 下状态灯及转场停用、系统明暗实时切换结果。
4. `git diff --check` 并查看全部代码 diff，确认只有计划列出的文档/渲染层/窗口主题与 capture 改动；用户事先已有 `package.json` 修改不得归因于本任务。任何失败退回负责的 Step 01-06 修复、重跑有关窗口及本步全量门禁，不能直接放行。

## 验收标准

- [x] `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm lint`、`git diff --check` 退出 0；`pnpm format:check` 的结论与任何既有 `Design/` 阻断逐文件记录。
- [x] 两份完整截图命令均退出 0；两份 `report.json` 的 `files` 非空、全部 `checks.ok === true` 且所有存在的 `result.pass === true`，两主题探针实际返回预期模式；完整截图条目以报告为准。
- [x] 执行记录逐窗列出深浅各一张以上实际 PNG 文件名、对比度/裁切/命中结果；Windows 实时主题切换与 reduced-motion 的观测步骤和结果记录完整，若有缺陷不能将状态标为 done。

## 交接

门禁与视觉都通过后再执行 Step 08；按一个功能或修复一个 commit 记录所有提交，执行阶段安排独立代码审查并回填处置结论。

## 执行记录

2026-09-25：全量门禁 + 双主题完整捕获 + 逐图复核完成。**本轮修掉 3 个由独立审查发现的缺陷**，新增 3 个提交：`5597a0e fix(ui): 浅色档链接与拖放提示改用可读强调色`、`119e709 fix(capture): 记录截图档位并识别静默失效的探针`、`a274f30 fix(capture): 收紧探针失败判定并给链接色补截图证据`。

**门禁（主代理实跑，最终代码 = 提交 `a274f30`）**
- `pnpm typecheck` 0、`pnpm test` 0（51 文件 / 791 用例）、`pnpm build` 0、`pnpm lint` 0、`git diff --check` 无输出。
- `pnpm format:check` **失败**，但逐文件核对后 **18 个文件全部是未跟踪的用户素材 `Design/Apple Copy/**`**（colors_and_type.css、components.css、components/*.json ×6、library-consumption.json、preview/*.html ×6、ui_kits/website/index.html、ui_kits/website/quality-report.json），本轮源码零命中；因此按 step 要求改用范围检查：`pnpm exec prettier --check "apps/desktop/src/renderer/**/*.{vue,css,ts,html}" apps/desktop/src/main/{window-manager,index,capture}.ts docs/07-ui-spec.md step/*.md` → 全部通过。**结论：全仓 format:check 不能算通过，但失败与本任务无关，且未改动 `Design/`。**

**两份完整捕获（`AURORA_CAPTURE_THEME` 分别 dark / light，目录 `%TEMP%\aurora-capture-verify-dark` / `-light`）**
- 两次均退出 0；各 **35 图 / 35 检查**；`checks.ok` 全 true；28 条带 `result` 的 `pass` 全 true；`checked===true && result==null` 的 **0 条**；`checked===false` 的 7 条正是设计上不挂探针的纯截图场景（`edge-bar.png`、`edge-bar-collapsed-final.png`、`settings-{modes,llm,skills,mcp,advanced}.png`）。
- `requestedTheme` / `theme`：dark 目录 = dark / dark，light 目录 = light / light（新增字段让报告可自证档位）。
- 主题探针（四条，两档取值）：dark → `mediaDark=true`、`colorScheme=dark`、`--bg-base=rgb(11,12,15)`、对比度 17.96、`native.observed=#0B0C0F`；light → `mediaLight=true`、`colorScheme=light`、`--bg-base=rgb(245,245,247)`、对比度 15.46、`native.observed=#F5F5F7`；`theme-edge-bar` 两档都断言 `body` 背景 alpha=0（提示条整窗透明），故无 `native` 字段。
- 场景集合：把改动前 `HEAD`（`%TEMP%\aurora-cap-base`，31 图）与两份新报告逐名对比 —— **旧场景缺失 0 条**，新增恰好 4 条 `theme-*.png`；深/浅两份报告的场景集合与顺序完全一致。

**逐图复核（70 张 PNG 全部经过程序化量化 + 逐张目视分工复核）**
- 程序化扫描 70 张：尺寸与各窗 CSS 尺寸 × DPR 1.5 吻合（提示条 17×303、交互窗 635×963、设置窗 1353×963、引导窗 1083×843），无空图（min/max 跨度均非零），平均亮度与档位一致（深色 20–44、浅色 233–250）。
- 浅色主题令牌对比度（自算，供核对）：`#1d1d1f` 15.46、`#4a4a50` 8.08、`#62626a` 5.55、`#3157bb` 6.01、`#315ac6` 5.66、`#955600` 5.34、`#b32631` 5.96、`#126843` 6.25、`#895000` 6.01、`#a51f2b` 6.81（对 `#f5f5f7`，全部 ≥4.5:1）；深色档 `--text-muted #6e6e73` 仍为 3.86:1（step 01 既有口径，未改）。
- 深色回归（独立子代理逐张，16 张，全部 PASS）：`theme-edge-bar`/`edge-bar-expanded`（面板区外 alpha 0–10，整窗透明；3 个按钮 top/bottom 均在窗内、`elementFromPoint` 命中）、`theme-chat`/`chat-thinking-level`/`chat-tts`/`chat.png`、`theme-onboarding` + 五段、`theme-settings`/`settings-general`/`settings-llm-params`/`settings-agent`。渲染层 `*.vue` 内 `#fff/#000/white/black/rgba(...)` 零命中，两档只见 token 反转。
- 浅色设置窗 / 引导窗（独立子代理逐张，18 张）：`theme-settings`（≈15.5:1 正文、卡片 1px 边框、当前项药丸 + 品牌渐变指示条）、`settings-general`/`modes`/`llm`/`tts`/`mcp`/`agent`/`advanced`（含 warn 提示 4.9–5.6:1、空状态虚线卡）、`settings-llm-params`/`llm-structure`/`tts-card`、`settings-modes-classroom-gating`、`onboarding-welcome`/`llm`/`modes`/`guide`/`done`（进度点、页脚 CTA 完整、无裁切）。**发现 2 处 P2 布局问题在「Skill」页（见遗留）**。
- 浅色提示条 / 交互窗（独立子代理逐张，12 张）：`theme-edge-bar`（整窗透明，竖排 AURORA 深字 4.66–5.09:1）、`edge-bar-expanded`（面板玻璃 alpha≈92%，卡间距/内边距正常，主按钮为**深字**压渐变 5.7–9.2:1，无白字压白底）、`theme-chat`/`chat-thinking-level`/`chat-model-picker`/`chat-tts`/`chat-drag`/`chat-collapse`/`chat.png`（正文 15.6:1、导航 8.2:1、chip 与徽标 5.4–7.4:1、无元素溢出）。**发现输入区控件行压缩与 disabled 取值偏灰（见遗留）**。
- 链接色修复的像素级证据（本轮补的）：种进会话的助手消息带裸 URL（`markdown.ts` 只认裸 URL）后，`theme-chat.png` 里链接文字最深像素 light = `rgb(57,86,180)` 对 `#f5f5f7` = **6.1:1**、dark = `rgb(95,130,247)` = **5.61:1**，两档均 ≥4.5:1。

**系统外观实时切换（步骤与结果，系统设置已还原）**
- 步骤：先读 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme` 原值（=1）→ 置 0 → 起 `pnpm dev`（**不设** `AURORA_CAPTURE_THEME`，`themeSource=system`）→ 运行中置 1、再置 0，每次 `Set-ItemProperty` 后广播 `WM_SETTINGCHANGE`/`ImmersiveColorSet` → 结束还原为 1。
- 结果（三轮实验跑均退出 0）：主进程日志两次/四次记录 `系统外观已切换，同步窗口底色`（`dark:false,#f5f5f7` 与 `dark:true,#0b0c0f`）；PNG 平均亮度显示**同一个已打开窗口**跟随切换 —— chat：`theme-chat`=26.6 → `chat-model-picker`…`chat.png`=247.3；settings：`theme-settings`=26.1 → `settings-general`…`settings-llm-models`≈233–238 →（切回暗）`settings-llm-params`=31、`settings-tts-card`=26.1；onboarding 五段同窗不 reload：`-welcome`=28、`-llm`=27.9 → `-modes`=244.3、`-guide`=248、`-done`=250.1。提示条两档 `bodyOk`（alpha=0）均 true，保持透明；未改动任何配置文件。

**reduced-motion**
- 机制（`theme.css:552-577`，step 01 起就有、本轮未改）：`prefers-reduced-motion: reduce` 把 `--dur-*` 压到 1ms，并对所有元素强制 `transition-duration/animation-duration: 1ms !important`、`animation-iteration-count: 1 !important`，同时关掉 `.interactive` 位移与 `.anim-*` 动画 → 状态灯呼吸（animation）与全部转场停用。
- 实测：用 `SystemParametersInfo(SPI_SETCLIENTAREAANIMATION=0)`（Chromium 在 Windows 上据此映射 `prefers-reduced-motion`）关掉系统动画后跑 `AURORA_CAPTURE_WINDOWS=chat,settings` → 退出 0、**24 图 / 24 检查全 PASS**（说明降动效档下所有等待/命中探针仍成立）；跑完用 `SPI_SETCLIENTAREAANIMATION=1` 还原（实测 `current=1`）。
- 局限（如实记录）：截图计划里**没有**渲染层 `matchMedia('(prefers-reduced-motion: reduce)')` 断言，所以这一步是「机制代码核对 + 真实 reduce 档整轮跑」，不是自动化断言；要自动化需给主题探针加一条条件断言（会改动已验收的报告口径），留在遗留项由用户决定。

**代码审查与处置**
- 独立对抗性复核（干净上下文）逐条查了报告机械核对、探针可失败性、nativeCheck 同源问题、`failed` 谓词、`AURORA_CAPTURE_THEME` 是否会影响普通启动、浅色令牌覆盖、旧断言是否被替换（31→35，removed=∅）、主题场景插入位置的顺序副作用。结论 P0 无、P1 无，提出 5 条应修 + 若干 P3。
- 处置：**P1 真缺陷已修**（`.md-link` / `.drop-hint` 浅色仅 3.14:1 → 改 `--accent-text`，6.01:1）；`failed` 静默失效判定、report 档位落盘、docs 退出码口径与顺序清单已修；`theme.css` 浅色块未覆盖的 14 条令牌里只有 3 条品牌色（`--aurora-blue` 的正文用法即上述 P1，已修）会坏，11 条 `--neutral-*` 无组件直接消费。
- 修复后再派一轮独立复核（干净上下文）：结论 **「有条件可交付」，P0/P1 均无**，确认两处改色正确、`failed` 谓词无误判（35 条里 7 条 `checked=false` 均为纯截图场景）、两份报告字段齐全、范围无越界；其列出的 P2/P3 中属于本轮新增代码的部分已在 `a274f30` 一并收紧（`null`、日志带文件名、trim 口径、docs 措辞）。
- 修复后的最终代码重新跑了两份完整捕获（即上面那两份报告），保证「验收过的代码 = 提交的代码」。

**遗留（均为既有问题或流程缺口，未擅自扩大范围）**
1. P2 `settings-skills.png`：用户技能目录的长路径硬裁切且与输入框间隙≈0；已发现技能表格列宽不足导致中文逐字折行（表头「脚本/启用」竖排）。属 step 04 的页面布局，非主题回归。
2. P2 交互窗输入区控件行：`.meta` / `.picker-hint` 在 423px 视口被压成「会…/未…/思…/模…」，末尾省略号距发送按钮约 0.7 CSS px 且无容器背景；源码注释表明这是**既定收缩顺序**，深色档同样如此。
3. P2 验收证据缺口：`chat-drag.png` / `chat-collapse.png` / `chat.png` 三张同帧（拖动与收起在画面上无变化，探针才是判据，属既有设计）；`chat.png` 只有种子消息，没有长消息/代码块/工具卡片。
4. P3 未配置/disabled 下拉取值浅色 ≈2.4:1、disabled 发送箭头 1.93:1（两档同源，disabled 有 WCAG 豁免）；引导未激活进度点在明暗两档都极弱（≈1.1:1，token 设计而非硬编码）；提示条面板卡片仅靠 9/255 明度差区分（1.07:1）；静止竖条实测 14–17 device 宽的小幅差异（几何代码未改）；`ClassificationLedger` 的 `.badge.run` 深色叠底 4.33:1（存疑）。
5. P3 自动化缺口：`nativeTheme updated → syncWindowBackgrounds` 只有本轮的真实系统切换实验为证，没有自动化用例（vitest 不加载 Electron）；主题场景只断言根令牌，提示条的玻璃/遮罩色没有专门断言；reduced-motion 无断言（见上）。

**工作区**：仅保留用户原有的 5 份 `package.json` 版本号改动与未跟踪 `.dsh/`、`Design/`、`step/archive/`；本轮未触碰 `edge-bar-geometry.ts`、`packages/shared`、`preload`、窗口尺寸与 `focusable`。
