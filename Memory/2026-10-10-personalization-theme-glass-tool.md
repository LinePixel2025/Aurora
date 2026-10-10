---
date: 2026-10-10
title: 个性化三件套（明暗档位 / 毛玻璃开关 / set_appearance）的接线口径，以及本机沙箱跑不了 vitest 的边界
tags: [UI, 主题, 毛玻璃, 配置, 工具, 沙箱, 坑]
source: 模型自动记录
---

# 个性化三件套的接线口径（v32）

## 现象

1. 用户要「可选亮色 / 暗色」「可关毛玻璃」「给 Agent 对应的工具」。动手前容易误判为「渲染层加个 `data-theme` 属性就行」——
   实际主题链是**主进程 `nativeTheme.themeSource` → 渲染层 `prefers-color-scheme`**，全仓没有任何 `data-theme`。
2. 关掉毛玻璃时若只关一半（例如只卸原生 Acrylic、页面 `.glass-*` 仍半透明），观感是「窗口变实色、面板还透」，
   且 `--glass-fallback` 被提示条面板以 `color-mix(… 94%, transparent)` 消费 —— **不压它那条圆角浮层仍是 ~90% 半透明**。
3. 截图工具的执行顺序是 `act → mainAct → 截图 → check → nativeCheck`：把「关掉毛玻璃后原生材质已摘」的断言放进
   `nativeCheck`，会在 `check` 的**还原动作之后**才跑，读到的是「已经改回来」的假结果（探针照样绿）。
4. 本机沙箱（workspace-write）下 `packages/shared/dist`、`apps/desktop/out`、`packages/*/src` 这些**已存在**的目录
   对子进程是只读的（PowerShell `Set-Content` / `tsc` 写盘一律 EPERM），但仓库根与被工具新建的目录可写 ——
   于是 `pnpm typecheck/test/build/verify` 全部跑不起来；而且 `node` 无法以管道 stdio 派生子进程（`spawn EPERM`），
   `pnpm`、`vitest`（esbuild service）、`electron-vite` 都踩这条，**只有 `node <脚本>` 这种单进程调用能跑**。

## 原因

- 主题：Electron 的档位只有一个真值来源（`nativeTheme.themeSource`），渲染层拿不到也不该拿第二套；
  `AURORA_CAPTURE_THEME` 是**运行期独占**标记（两档截图基线不能被用户设置顶掉），因此主进程要留一个
  `captureThemeOverride` 并让每次同步都先看它一眼。
- 毛玻璃：原生材质在 DWM，页面玻璃在 CSS，两处必须是**同一份配置驱动的两条腿**：
  主进程 `WindowManager.applyGlass()`（`setBackgroundMaterial('none')` + 不透明底色）与
  渲染层 `:root[data-glass='off']` 令牌降级。渲染层那份与既有的 `prefers-reduced-transparency` **同口径**，
  手写两份必然漂移 → 用一条测试钉住「应用内开关的令牌 ⊇ 系统降级那块」。
- 探针顺序：`capture.ts` 的 `check` 是渲染层脚本（含收尾还原），`nativeCheck` 在它之后跑；
  想断言「还原之前」的主进程状态，只能用 `mainAct`。
- 沙箱：DSH 的工作区授权只落在根（及运行期新建的目录），已有子目录没有当前会话的写入 ACE。

## 影响

- 把主题写成 `data-theme` 会导致「设置改了但窗口不跟随」；只关一半毛玻璃用户会当成 bug 报回来。
- 顺序弄错的探针是**静默失效**：它绿着，却什么都没证明（同类坑还有「只查存在不查矩形」）。
- 不清楚沙箱边界时，会把 EPERM 当成代码错误反复改代码；也会误信「pnpm test 没跑=改动没验证」。

## 结论与做法

- **主题**：`appearance.theme`（`system` 默认 / `light` / `dark`）→ 主进程 `syncThemeSource()` 写 `nativeTheme.themeSource`；
  调用点与 `applyEdgeBarOpacity` 对齐（启动一次 + `onSettingsChanged` 一次）；`captureThemeOverride` 非空时整个跳过。
  渲染层**不要**新增 `data-theme`。
- **毛玻璃**：`appearance.glass`（默认 `true`）→ 主进程 `WindowManager.applyGlass()`（幂等：目标态与
  `nativeGlassWindows` 一致就什么都不做）+ 渲染层 `data-glass="off"`。降级令牌写在 `theme.css`，
  与 `prefers-reduced-transparency` 同口径并**多压一条 `--glass-fallback: var(--bg-base)`**；
  覆盖关系的护栏是 `packages/shared/src/browser/theme-css.test.ts`。
- **Agent 侧**：外观三件套进 `WRITABLE_PATH_OVERRIDES`（可写面清单三处同口径：覆盖表 / `settings-hint.ts` /
  `set_setting` 描述）+ 新工具 `set_appearance`（复用**同一个** `SettingsToolPort`，参数是三个固定字段没有路径，
  `sensitivity: 'safe'`，与 `set_setting` 同处 `registerSettingsTool` 的 sync）。加工具要同步
  `toolIcons.ts`（`Palette`，需先在 `icons.ts` 登记）与 `toolLabels.ts`，并改 `tools/index.test.ts` 的多处工具清单期望。
- **截图探针**：要断言「还原之前」的主进程状态就用 `mainAct`，别用 `nativeCheck`；
  会改配置的场景排在 `SETTINGS_PAGE_IDS` 循环之后，check 收尾必须还原。
- **沙箱内怎么验证**（本机实测可用的一套）：`node node_modules/typescript/lib/tsc.js -p <tsconfig>`（可 `--outDir` 到仓库根下的临时目录）、
  `node node_modules/eslint/bin/eslint.js …`、`node node_modules/prettier/bin/prettier.cjs --check …`、
  以及**把产物编译到临时 outDir 后 `node` 直接跑真实断言脚本**（`scripts/verify-p1.mjs` 只改一行 import 路径即可复用）。
  在 **workspace-write** 档下 vitest / electron-vite / `pnpm <script>` / 截图 / 冒烟**跑不了**（详见下条）；
  切到**完全权限**后全部可跑，正常按 `pnpm typecheck / test / build / verify` + 冒烟 + 截图 走即可。
- **冒烟基线数字会骗人**：`AGENTS.md` 里长期写的 `183` 是 v0.4.0 时代的数，本次改动前实测已是 **192**，
  加 7 条外观断言后是 **199**。**先跑一轮量出真实基线，再拿它当参照**，别照抄文档里的数字
  （否则要么把"本来就不够 183"当成回归，要么把噪声当基线）。

## 修订（2026-10-10 同日，会话切到完全权限后实测）

- 上面「沙箱内跑不了」的清单只在 **workspace-write** 档成立：那个档下
  `packages/*/dist`、`apps/desktop/out`、`packages/*/src` 这些**已存在**目录对子进程只读，
  且 `node` 不能以管道 stdio 派生子进程（`spawn EPERM`）→ `pnpm` / `vitest`(esbuild service) / `electron-vite` 全部起不来。
  切到**完全权限**后：`pnpm typecheck` / `pnpm test`（2540 全绿）/ `pnpm build` / `node scripts/verify-p1.mjs`（26/26）
  / `AURORA_SMOKE`（199/199）/ `AURORA_CAPTURE` / Center `verify:web` 全部正常。
- **更正一条误判**：早期我用**根目录的** `node node_modules/typescript/lib/tsc.js -p apps/desktop/tsconfig.node.json`
  跑 desktop 类型检查，得到两条 `office-cli.ts` 的 `Buffer<ArrayBufferLike>` 错误，一度当成「基线本来就红」。
  改用仓库脚本（`pnpm typecheck` → 各包自己的 `tsc`）后**全绿** —— pnpm 严格链接下，用错版本的工具链会给假结论。
  跑单包检查要么走 `pnpm --filter <pkg> <script>`，要么用该包自己 `node_modules` 里的二进制。
- 仓库根 `prettier --check .` 报的 38 个文件是**工作区副本 CRLF**（`endOfLine: lf`）造成的，与改动无关；
  改动的文件都是 LF，`prettier --check <改动文件>` 全绿。
- **⚠️ 别在本机直接 `pnpm format`**：`core.autocrlf=true` 下工作区副本是 CRLF，`prettier --write .`
  会把 **38 个没动过的文件**改成 LF，`git status` 从 33 行涨到 71 行 —— 那是纯行尾噪声，**不许进提交**。
  本次已用 `git checkout --` 逐个还原干净（`git diff --name-only` 回到 29）。要在本机让 `format:check`
  变绿就单独跑改动文件，别全仓 `--write`。

## 实测记录（2026-10-10，完全权限下的一轮完整验收）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck`（5 个项目） | 全绿 |
| `pnpm test` | **169 文件 / 2540 用例全绿**（含本次新增的 `appearance.test.ts` / `theme-css.test.ts` / 迁移与可写面用例） |
| `pnpm build` | 成功（shared / agent-core / modes / center / desktop 产物） |
| `node scripts/verify-p1.mjs` | **26/26**，`version=32`、迁移 `32/32` |
| `AURORA_SMOKE=1` 全量冒烟 | **199/199**（新增 7 条外观断言全 PASS） |
| `AURORA_CAPTURE`（dark） | 93 产物 / 93 探针；新场景 `settings-appearance-glass-off.png` PASS（`marked=off`、`filter/thick=none`、`content===base`、原生材质 `nativeGlass=false`、收尾还原 `on`） |
| `AURORA_CAPTURE`（light） | 93 产物；同上场景在亮档也 PASS（`content="#f5f5f7" === base`），主题探针 `light` 正确 |
| Center `verify:web` | **88 场景 / 0 失败**（两端同源改动未影响网页端） |

**`chat-model-picker.png` 是既存红项，不是本次改动引入的**：把改动 `git stash -u` 掉、按原码重建后跑同一轮
全量截图，得到 **92 产物 / 唯一失败项就是它**，payload 与改动后逐字相同
（`sessionProvider:null`、`domValue:["capture-source","deepseek-chat"]`、`optionCount:3`、`overriddenAfterSeed:false`）。
即「ACT 用 DOM `change` 事件驱动模型选择器 → 最后一次选模型没有落成会话覆盖」这条在改动前就存在。
同类**本机固有抖动**（历史 report 里同一份代码 3 分钟内先 6 红后 0 红，10-05 起反复出现）：
`chat.png`（自动滚底）、`chat-archive.png`、`chat-sidebar.png`、`chat-stream-burst.png`（最坏帧间隔阈值 110ms，
实测在 63–141ms 之间摆）。**判断「是不是我搞红的」用同码基线跑，别用一次全量的红灯数**。
