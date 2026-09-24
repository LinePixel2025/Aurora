# 归档报告：aurora-visual-themes（统一四窗视觉设计系统并增加跟随系统的浅色主题）

- 任务标识：aurora-visual-themes
- 归档路径：`step/archive/20260925-035034-aurora-visual-themes`
- 归档时间：2026-09-25 03:50:34（时间戳 `20260925-035034` 只取一次，目录名 / 索引 / 本报告三处一致）
- 基线提交：`3ba9aaba0567d2ab6604bdee532fc7be036f53c0`（开工前 HEAD）
- 结束提交：`1847207`（工作步骤最后一次提交；本目录的归档提交紧随其后）
- 提交区间：`3ba9aab..1847207`，共 **17** 个提交（9 个功能/修复 + 8 个 `docs(step)`）
- 步骤：7 个工作步骤 + 1 个归档步骤，**全部 done**
- 执行模式：单个（计划内标注；实际由执行器连续完成剩余 step 6、7）

## 做了什么

把 Aurora 四个窗口（右侧提示条 edge-bar / 交互窗 chat / 设置 settings / 首次引导 onboarding）统一到
一套克制的 Apple 风语义令牌，并让主题**跟随 Windows 明暗外观**自动切换：

- **令牌层**（`renderer/shared/theme.css`）：原始中性阶 + 语义层（底色 / 分层填充 / 描边 / 文本 /
  状态 / 焦点 / 危险与警告 / 选区 / 玻璃与阴影），默认深色，`@media (prefers-color-scheme: light)`
  只覆盖语义层并同步 `color-scheme`；新增 `--accent-text`（浅色 `#3157bb`）供正文类强调色使用，
  旧令牌名**只增不删**。
- **四窗视觉统一**：共享组件（`AppButton` / `SettingField` / `StatusDot` / `AppToast` / `MessageList` /
  `ModelPickerSelect` / `ThinkingLevelSelect` / `SensitiveToolCard` / `ClassificationLedger`）与
  提示条、交互窗、设置页八页、引导五段全部改为消费语义令牌；渲染层已无颜色字面量（只在令牌声明里出现）。
- **原生窗口底色跟随**：`main/window-manager.ts` 按 `nativeTheme.shouldUseDarkColors` 设非透明窗底色，
  订阅 `updated` 后对存活窗口 `setBackgroundColor()`，退出时注销；提示条保持 `transparent: true` +
  `#00000000`，几何 / `focusable` / 透明配置一字未动。
- **双主题截图验收**：`AURORA_CAPTURE_THEME=dark|light` 只在开发截图运行里强制 `nativeTheme.themeSource`；
  每窗新增一张 `theme-*.png` 场景，断言 `matchMedia` 档位、文档根 `color-scheme`、`--bg-base` 基座色、
  正文背景（非透明窗不透明且同色 / 提示条 alpha 0）与正文对比度 ≥4.5:1；**原生底色**由主进程侧
  `nativeCheck` 读 `BrowserWindow.getBackgroundColor()` 断言，与渲染层结果合并进同一条记录。
- **文档先行**：`docs/07-ui-spec.md` §5 方向、§5.1「系统明暗双档」、§5.2 实时切换与降动效、§5.3 双主题
  截图口径（含 `report.json` 字段与失败判定）全部同步；本轮不引入手动主题开关、不改配置 Schema。

## 步骤与验证结果

| # | 步骤 | 关键验证 | 提交 |
| --- | --- | --- | --- |
| 1 | 深色令牌层与视觉规范 | `pnpm build` 0；完整深色捕获 27 图 / 27 检查（第二次执行通过，首次自动滚底探针偶发失败已记录） | `0dcbcf6` `4fb4724` |
| 2 | 共享组件与提示条 | typecheck/build 0；提示条 4 图 / 4 检查全 PASS | `819dbde` `e9a0787` |
| 3 | 交互窗与内容组件 | typecheck/build 0；交互窗 6 图 / 6 检查全 PASS | `04c4051` `56ed94a` |
| 4 | 设置页与表单密度 | typecheck/build 0；设置窗 16 图 / 16 检查全 PASS | `dcdbfaa` `d424516` |
| 5 | 引导页与完成状态 | typecheck/build 0；引导 5 图 / 5 检查全 PASS（实际五段，已按代码校正计划） | `f67bb9d` `ec18829` |
| 6 | 系统浅色主题与双主题截图 | typecheck/build 0；深 / 浅完整捕获各 **35 图 / 35 检查全 PASS、退出 0**；系统外观运行中实时切换（chat / settings / onboarding 三窗）有日志 + PNG 亮度证据；顺带修掉一个在旧 `HEAD` 即可复现的既有探针缺陷 | `88014c3` `31b189c` `7efbbc6` |
| 7 | 全量回归与逐图复核 | 门禁全绿 + 两份完整捕获全 PASS + 70 张 PNG 量化与逐图复核 + 独立对抗审查；修掉 3 个缺陷（见下） | `5597a0e` `119e709` `a274f30` `1847207` |
| 8 | 归档清理 | 本文件；`step/` 顶层无残留 | — |

## 最终验证（主代理亲自复跑，最终代码 = `a274f30`）

| 命令 / 产物 | 结果 |
| --- | --- |
| `pnpm typecheck` | **0**（node + web 两个 project 全 Done） |
| `pnpm test` | **791 passed**（51 test files） |
| `pnpm build` | **0** |
| `pnpm lint` | **0 问题** |
| `git diff --check` | **无输出** |
| `pnpm format:check` | **失败：18 个文件全是未跟踪的用户素材 `Design/Apple Copy/**`**（组件 JSON / 预览 HTML / CSS），本轮源码 0 命中；改用范围检查 `prettier --check` 渲染层 + 三个主进程文件 + docs/07 + step/*.md → 全部通过 |
| 深色完整捕获 `%TEMP%\aurora-capture-verify-dark` | 退出 **0**，35 图 / 35 检查；`ok` 全 true、28 条 `result.pass` 全 true；主题探针 `mediaDark=true` / `color-scheme=dark` / `--bg-base=rgb(11,12,15)` / 对比度 **17.96** / `native.observed=#0B0C0F` |
| 浅色完整捕获 `%TEMP%\aurora-capture-verify-light` | 退出 **0**，35 图 / 35 检查；主题探针 `mediaLight=true` / `color-scheme=light` / `--bg-base=rgb(245,245,247)` / 对比度 **15.46** / `native.observed=#F5F5F7`；提示条两档均断言 `body` 背景 alpha = 0（整窗透明） |
| 场景完整性 | 改动前 `HEAD` 的 31 个场景在新报告中**缺失 0 条**，新增恰好 4 条 `theme-*.png`；深 / 浅场景集合与顺序一致 |
| 逐图复核 | 70 张 PNG 程序化量化（尺寸 / 非空 / 档位亮度一致）+ 三路子代理逐张目视（深色回归 16/16 PASS；设置 § 引导 18 张；提示条 § 交互窗 12 张） |
| 系统外观实时切换 | 运行中改 `AppsUseLightTheme` 并广播 `ImmersiveColorSet`：主进程日志记录 `系统外观已切换，同步窗口底色`（`#f5f5f7` / `#0b0c0f`）；PNG 亮度显示同一已打开窗口跟随（chat 26.6→247.3；settings 26.1→≈235→切回 31/26.1；onboarding 五段同窗 28→244/248/250）。**系统设置已还原为原值 1** |
| reduced-motion | `SPI_SETCLIENTAREAANIMATION=0` 后跑 `chat,settings` → 退出 0、**24 图 / 24 检查全 PASS**；跑完还原为 1；机制为 `theme.css:552-577` 全局 1ms 覆盖（无渲染层断言，见遗留） |

## 独立审查与处置

- **对抗性复核（干净上下文子代理）**：逐条核对两份报告、探针可失败性、`nativeCheck` 与建窗颜色是否同源、
  `failed` 谓词、`AURORA_CAPTURE_THEME` 是否可能影响普通启动、浅色令牌覆盖、旧断言是否被替换、
  主题场景插入位置的顺序副作用。结论 **P0 无**，指出 1 条真实缺陷与若干口径问题。
- **实际修掉的缺陷**（3 条，均由主代理复跑验证）：
  1. **P1 浅色可读性**：`MessageList.vue` 的 `.md-link` 与 `chat/App.vue` 的 `.drop-hint` 把品牌蓝
     `--aurora-blue` 当正文色，浅色基座上只有 **3.14:1**（文档自定 ≥4.5:1）→ 改 `--accent-text`；
     像素实测浅色链接 `rgb(57,86,180)` = **6.1:1**、深色 **5.61:1**。
  2. **验收漏洞**：配了探针却返回空值时原先算通过（退出码 0）。现在 `CaptureCheck` 带 `checked`，
     `failed` 把 `checked && result == null` 判失败并打 FAIL 日志（含文件名）；用临时探针实测过负例
     （退出码 2），改后现有两份报告仍全绿。
  3. **报告不可自证档位**：`report.json` 新增 `requestedTheme` / `theme`，并统一 trim 口径，
     避免 `AURORA_CAPTURE_THEME='dark '` 静默回落 system 时两边打架。
- **修复后再派一轮独立复核**（干净上下文）：结论 **「有条件可交付」，P0 / P1 均无**；确认两处改色正确、
  `failed` 谓词无误判（35 条里 7 条 `checked=false` 均为纯截图场景）、报告字段齐全、范围无越界；
  其列出的 P2/P3 中属于本轮新增代码的部分已在 `a274f30` 一并收紧。
- **视觉复核发现但未修**（既有问题，未擅自扩大范围）：见下面「遗留」。

## 遗留问题

1. **P2 `settings-skills.png`**：用户技能目录长路径被硬裁切且与输入框间隙≈0；已发现技能表格列宽不足，
   表头「脚本 / 启用」竖排、单元格中文逐字折行。属 step 04 的页面布局，非主题回归。
2. **P2 交互窗输入区控件行**：`.meta` / `.picker-hint` 在 423px 视口被压成「会…/未…/思…/模…」，
   末尾省略号距发送按钮约 0.7 CSS px 且无容器背景；源码注释表明这是**既定收缩顺序**（深色档同样如此）。
3. **P2 截图证据缺口**：`chat-drag.png` / `chat-collapse.png` / `chat.png` 三张同帧（拖动与收起草在画面上
   无变化，判据是探针，属既有设计）；`chat.png` 只有一条种子消息，没有长消息 / 代码块 / 工具卡片。
4. **P3 对比度**：未配置 / disabled 下拉取值浅色 ≈2.4:1、disabled 发送箭头 1.93:1（disabled 有 WCAG 豁免）；
   引导未激活进度点在明暗两档都极弱（≈1.1:1，token 设计而非硬编码）；提示条面板卡片仅靠 9/255 明度差
   区分（1.07:1）；静止竖条实测宽 14–17 device 的小幅差异（几何代码未改）。
5. **P3 存疑**：`ClassificationLedger` 的 `.badge.run` 用 `--status-running` 作文字色叠状态底，深色下约
   4.33:1（无法在不跑渲染的情况下确定实际叠底）。
6. **P3 自动化缺口**：`nativeTheme updated → syncWindowBackgrounds` 只有本轮真实系统切换实验为证，
   没有自动化用例（vitest 不加载 Electron）；`theme-edge-bar` 只断言根令牌，提示条玻璃 / 遮罩色无专门断言；
   `prefers-reduced-motion` 无渲染层断言（要自动化需给主题探针加条件断言，会改动已验收的报告口径）。

## 工作区与副作用

- 未提交：用户原有的 5 份 `package.json` 版本号改动（1.0.0-beta.1 → 1.0.1-beta.1）与未跟踪
  `.dsh/`、`Design/`、`step/archive/`（历史归档）；本轮未触碰 `edge-bar-geometry.ts`、`packages/shared`、
  `preload`、窗口尺寸与 `focusable`、配置 Schema。
- 环境副作用均已还原：系统应用外观 `AppsUseLightTheme` = **1**（原值）、动画开关
  `SPI_SETCLIENTAREAANIMATION` = **1**（原值）；截图 userData 全程自动隔离到临时目录并在退出时删除。
