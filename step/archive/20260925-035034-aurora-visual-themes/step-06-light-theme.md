# Step 06 — 系统浅色主题与双主题截图

- Task: aurora-visual-themes
- Step: 6 / 8
- Status: done
- Depends on: step 5
- Produces: 跟随 Windows 明暗外观的四窗浅色主题、窗口底色联动和可重复双主题截图入口
- Phase: 集成
- Writes: `docs/07-ui-spec.md`；`apps/desktop/src/renderer/`（仅修改已有主题与确需浅色适配的 Vue/CSS 文件）；`apps/desktop/src/main/window-manager.ts`；`apps/desktop/src/main/index.ts`；`apps/desktop/src/main/capture.ts`
- Risk: 跨主进程与渲染层切换会闪底或浅底白字；优先用同一系统主题信号和成对令牌，失败时回退本步跨进程变更，保留前五步深色成果。
- Sources: Electron 官方 [nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)（访问 2026-09-25；页面为 latest；项目 `apps/desktop/package.json` 声明 `electron ^33.2.1`，先核验本地 33 类型/API 再实现）。

## 目标

Windows 系统外观变化后四窗已打开页面和原生窗口底色同步变明/变暗，透明提示条仍透明，并可在隔离截图中分别强制明暗以验收。

## 输入

- 读 `docs/07-ui-spec.md` §1/§2/§5、`apps/desktop/src/renderer/shared/theme.css`、`apps/desktop/src/main/window-manager.ts`、`apps/desktop/src/main/index.ts`（app ready、窗口实例创建和 capture 入口）、`apps/desktop/src/main/capture.ts`、四窗 App.vue 与 `settings/settings.css`。
- 项目 `apps/desktop/package.json:33` 声明 `electron ^33.2.1`；官方 `nativeTheme` 提供 `shouldUseDarkColors`、`updated` 和默认 `themeSource='system'`，Electron 窗口可 `setBackgroundColor()`，但官方链接指向 latest：**第一项先查本地 `apps/desktop/node_modules/electron/electron.d.ts` 的相应 API 并确认运行时 Electron 版本**；若不存在，先记录可复现的失败与兼容方案，调整执行步骤后继续。
- `window-manager.ts:51-92,173-195` 提示条 `transparent:true` + `#00000000`、其它三窗 `transparent:false` + 固定 `#12141a`；几何、透明配置与 `focusable:false` 不可动。`theme.css:15` 是单一暗色 `color-scheme`。官方文档（上述链接，访问 2026-09-25）要求订阅 `updated` 后重新读取暗色状态。
- 截图管线：`capture.ts:108-159` 顺序生成 PNG+checks，`index.ts:820-871` 写 `report.json`；全量 userData 自动隔离。浅色源库只借结构与比例，不复制 Apple 文案、logo、强调蓝。

## 操作

1. 先更新 `docs/07-ui-spec.md` §5.1/§5.2/§5.3 与窗口底色说明：定义暗色与浅色语义角色、系统自动切换、透明提示条策略、双主题截图验证方式、减少动态效果口径；不引入手动主题配置或迁移。
2. 在 `shared/theme.css` 以默认暗色 + `@media (prefers-color-scheme: light)` 覆盖**语义令牌**（包含文字、背景、边框、glass、状态、危险色、焦点环与选择色），同步 `color-scheme`；保持品牌极光色及旧令牌名字。消除各窗剩余硬编码深色值和暗色阴影，让四窗浅色可读。不得仅靠 CSS 调整原生窗口底色。
3. `window-manager.ts` 创建三种非透明窗口时按 `nativeTheme.shouldUseDarkColors` 设底色；监听 `nativeTheme` 的 `updated`，对当前存活非透明窗 `setBackgroundColor()` 更新底色。提示条始终透明，不碰 `SPECS` 的几何/透明/焦点字段。接线与监听清理以 `index.ts` 的 app 生命周期为准，避免重复订阅。
4. 在仅有 `AURORA_CAPTURE` 的开发截图路径引入 `AURORA_CAPTURE_THEME=dark|light`，在创建窗口前设置 `nativeTheme.themeSource`，供两次截图稳定复跑；`capture.ts` 的 `CaptureTarget` 只有一个 `check` 字段，**不可替换原有交互检查**。优先给每窗加独立主题截图 target 与 `check`（或在原 `check` 中组合并保留原断言），其中 chat 主题场景必须排在 `chat-collapse.png` 之前；四阶段引导场景亦须完整保留。主题探针至少验证 `matchMedia('(prefers-color-scheme: light)')`、文档根 `color-scheme` 和正文/窗口可见背景一致、无相反主题的白字或深色闪底。常规运行仍用 `themeSource='system'`。把新增断言同步写进 docs/07 §5.3。
5. 明暗各跑一次完整 capture、构建和窗口实际切换测试；两种主题逐张检查背景、状态、输入、气泡、设置页门控与引导完成页。

## 验收标准

- [x] 本地 Electron 33 的 `.d.ts` 或实际运行 API 证实 `nativeTheme.shouldUseDarkColors`、`updated`、`BrowserWindow.setBackgroundColor` 可用；记录安装版本与核验位置；`pnpm typecheck`、`pnpm build` 退出 0。
- [x] `$env:AURORA_CAPTURE_THEME='dark'; $env:AURORA_CAPTURE="$env:TEMP\aurora-capture-dark"; pnpm dev` 与 `$env:AURORA_CAPTURE_THEME='light'; $env:AURORA_CAPTURE="$env:TEMP\aurora-capture-light"; pnpm dev` 均退出 0，两份 `report.json` 均有 `files` 且全部 `checks.ok` 为 true、有 `result.pass` 的为 true；新增主题探针分别判定匹配 dark/light。
- [x] 用系统外观在应用运行中从暗切浅再切暗，已打开的 chat/settings/onboarding 底色和正文颜色跟随改变、edge-bar 仍透明；在执行记录中写下测试步骤与每窗观察结果，不修改配置文件。
- [x] `docs/07-ui-spec.md` §5.1/§5.3 记录两主题与截图参数；原先的聊天收起/滚动、提示条命中、设置门控和引导四阶段检查在两份报告中仍出现且通过，新增主题检查不覆盖旧 `check`；`window-manager.ts` 的 8↔228px 几何来源未变，提示条不变为可拖动。

## 交接

交给 Step 07 两份完整 PNG+`report.json`、主题探针结果及系统切换记录；若本地 Electron API 不符，先解决并回填证据后才继续。

## 执行记录

2026-09-25：主代理实现并复跑全部验收；两个提交 `88014c3 feat(ui): 四窗跟随系统明暗与双主题截图探针`、`31b189c fix(capture): 思考等级探针按生效 provider 定位编辑卡`（后者是跑全量捕获时暴露的**既有**探针缺陷，与主题无关、可独立回滚）。

**改动**
- `apps/desktop/src/renderer/shared/theme.css:154-208,227-231`：新增 `@media (prefers-color-scheme: light)` 只覆盖语义层（bg / fill / border / text / status / 焦点 / 危险 / 选区 / 玻璃回退 / 阴影成对覆盖）与 `--accent-text`（深 `--aurora-blue`、浅 `#3157bb`），两档同步 `color-scheme`；补 `html:has(body.transparent)` 让提示条根画布也透明。
- `apps/desktop/src/renderer/edge-bar/App.vue`、`shared/components/MessageList.vue`：渐变上的前景与「朗读中」描边改用 `--on-accent` / `--accent-text`，去掉浅色下不可读的写死深色。
- `apps/desktop/src/main/window-manager.ts`：`DARK_BACKGROUND`/`LIGHT_BACKGROUND` + `windowBackgroundColor()`；建窗底色取当前档位；构造时订阅 `nativeTheme.on('updated')` 对存活非透明窗 `setBackgroundColor()`，`prepareQuit()`/`destroyAll()` 注销，切换时按 info 记录档位与色值；`getBackgroundColor()` 供截图核对读真实原生底色。提示条 `transparent: true` + `#00000000`、几何与 `focusable` 一字未动。
- `apps/desktop/src/main/index.ts:221-228`：`bootstrap()` 最前面按 `AURORA_CAPTURE` + `AURORA_CAPTURE_THEME` 设 `nativeTheme.themeSource`，否则 `system`（早于任何建窗）。
- `apps/desktop/src/main/capture.ts`：`CaptureTarget.nativeCheck`（主进程侧断言，与 `check` 合并进同一条记录、`pass` 相与，不替换旧断言）；`themeProbeScript` / `themeNativeCheck` / `activeTheme`；每窗一张 `theme-*.png`（chat 在最前、仍早于 `chat-collapse.png`；引导那张排在五段之前且不点页脚按钮）。
- `docs/07-ui-spec.md`：§5 方向、§5.1「系统明暗双档」、§5.2 实时切换与降动效、§5.3 双主题截图口径（参数、场景名、四条断言、原生底色由主进程断言）。

**子代理**：派出 3 个只读分片（渲染层浅色隐患 / 主进程主题接线 / 文档与实现一致性），本次会话未收到回传（`subagent` 句柄不可寻址、`send_message` 报 not found），因此以下结论全部由主代理自行复核：`apps/desktop/node_modules/electron/package.json` = `33.4.11`；`electron.d.ts:9135`(`shouldUseDarkColors`)、`:9187`(`themeSource`)、`:5570`(`setBackgroundColor`)、`:5094`(`getBackgroundColor`)、`:9106-9132`(`updated` 事件说明)；`WindowManager` 全仓只有 `index.ts:342` 一处构造；渲染层已无颜色字面量（仅 `theme.css` 的原始阶/语义声明）。

**验收（主代理实跑）**
- `pnpm typecheck`（node + web）、`pnpm build` 退出 0；`prettier --check` 通过。
- 深色全量：`AURORA_CAPTURE_THEME='dark'` `AURORA_CAPTURE=%TEMP%\aurora-capture-dark` → 退出 0，35 图 / 35 检查，`checks.ok` 全 true、无 `pass:false`；主题探针 `theme-edge-bar`（`bodyBackground=rgba(0,0,0,0)`，无原生断言）、`theme-chat`、`theme-onboarding`、`theme-settings` 均 `mediaDark=true / colorScheme=dark / --bg-base=rgb(11,12,15)`、对比度 17.96、`native.observed=#0B0C0F`。
- 浅色全量：`AURORA_CAPTURE_THEME='light'` `AURORA_CAPTURE=%TEMP%\aurora-capture-light` → 退出 0，35 图 / 35 检查全 PASS；四个主题探针 `mediaLight=true / colorScheme=light / --bg-base=rgb(245,245,247)`、对比度 15.46、`native.observed=#F5F5F7`。
- 系统外观实时切换（不设 `AURORA_CAPTURE_THEME`，只改 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme` 并广播 `WM_SETTINGCHANGE`/`ImmersiveColorSet`，实验结束还原成原值 1）。步骤：先读原值 → 置 0 → 起 `pnpm dev` → 运行中置 1、再置 0 → 读 `report.json` / 主进程日志 / PNG 平均亮度（0-255）；日志两次记录 `系统外观已切换，同步窗口底色`（`dark:false,#f5f5f7` 与 `dark:true,#0b0c0f`）。每窗观察结果（同一已打开窗口、同一次运行）：
  - chat（`%TEMP%\aurora-cap-live-chat`，7/7 PASS）：`theme-chat`=26.6 → 切换后 `chat-model-picker`=247.3、`chat-tts`=247.2、`chat-drag`=247.3、`chat-collapse`=247.3、`chat.png`=247.3。
  - settings（`%TEMP%\aurora-cap-live-settings` 17/17 PASS 与 `%TEMP%\aurora-cap-live-round` 17/17 PASS）：`theme-settings`=26.1 → `settings-general`=237.9…`settings-llm-models`=233.5 →（切回暗）`settings-llm-params`=31、`settings-tts-card`=26.1、`settings-modes-work-gating`=28.6。
  - onboarding（`%TEMP%\aurora-capture-live`，五段同窗不 reload）：`onboarding-welcome`=28、`-llm`=27.9 → `-modes`=244.3、`-guide`=248、`-done`=250.1。
  - edge-bar：两档 `bodyOk` 均为 true（`bodyBackground=rgba(0,0,0,0)`），整窗保持透明；未修改任何配置文件（实验只动系统外观，且已还原）。
- 全量捕获顺带定位到一个**既有**缺陷并修复：`settings-llm-params` 在改动前 `HEAD`（`%TEMP%\aurora-cap-base`，31 图）同样 FAIL（`value:"auto"`），根因是行列表里 onboarding 先种的 `local` provider 与 `llm.active` 不一致、而探针按"第一个"取值；`31b189c` 按 `data-field="llm.providers.<active>"` 限定到生效 provider 那一行。

**遗留**：`chat.png` 的自动滚底探针仍偶发失败（step-01 已记录；本轮 live 诊断跑复现一次 `distance=1439`，两次验收全量跑均 PASS），交 step-07 继续观察。未改 `edge-bar-geometry.ts`、窗口尺寸 / `focusable`、配置 Schema 与业务逻辑。
