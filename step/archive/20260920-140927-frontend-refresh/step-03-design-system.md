# Step 03 — Apple 风格设计系统 + 共享组件 + 截图核对工具

- Task: frontend-refresh
- Step: 3 / 8
- Status: done
- Depends on: step 2
- Produces: 重写的 `theme.css` 令牌与动效体系、统一的共享组件外观、`AURORA_CAPTURE` 截图核对工具

## 目标

建立一套「一处定义、五窗共用」的 Apple 风格视觉与动效基线：设计令牌（颜色 / 字体 / 圆角 / 材质 / 阴影 / 缓动 / 时长）、
动效工具类与 `prefers-reduced-motion` 降级、共享组件统一外观；同时建好可复用的窗口截图工具，
让后续几步（04/05/06）能用 PNG 而不是靠肉眼猜来验收视觉。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 先读：`apps/desktop/src/renderer/shared/theme.css`（181 行，当前令牌全貌）、
  `ls apps/desktop/src/renderer/shared/components/`（共享组件清单）、
  `apps/desktop/src/renderer/shared/components/AppButton.vue`、`SettingField.vue`、`AppToast.vue`、`StatusDot.vue`、
  `apps/desktop/src/main/index.ts`（启动流程，找挂钩截图的位置）、`docs/07-ui-spec.md` §1/§5。
- 建议先加载 `frontend-design` skill（本仓库 `AGENTS.md` 明确「视觉设计另见 ui-ux-pro-max / frontend-design skill」），
  用它的取向定调，但**最终必须落成 theme.css 里的具体令牌值**，不要停留在描述。
- 关键约束：
  - 五个窗口都 import `renderer/shared/theme.css`（各 `main.ts` 里），所以令牌改名会同时影响全部窗口 —— 见下方兼容要求。
  - `agent-core` / `modes` / `shared` 包不得依赖 DOM；本步只改 `apps/desktop/src/renderer/**` 与主进程截图工具。
  - Prettier：无分号、单引号、`printWidth: 100`、尾逗号 all、LF。

## 操作

### A. 设计令牌（重写 `apps/desktop/src/renderer/shared/theme.css`）

1. **向后兼容是硬要求**：现有页面大量使用 `--bg-base` / `--bg-raised` / `--bg-glass` / `--border-subtle` / `--border-strong` /
   `--text-primary` / `--text-secondary` / `--text-muted` / `--status-*` / `--radius-sm|md|lg` / `--space-1..6` /
   `--transition-fast|base` / `--font-ui` / `--font-mono` / `--aurora-gradient`。这些名字**全部保留**（值可以改成新的），
   新增令牌用新名字。这样 step-04/05/06 可以逐窗迁移，不会一次炸掉五个窗口。
2. 字体（Windows 上没有真 SF，用系统栈近似 + 明确回退）：

   ```css
   --font-ui: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
     'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', '微软雅黑', system-ui, sans-serif;
   --font-display: 'SF Pro Display', 'Segoe UI Variable Display', var(--font-ui);
   ```
   并新增字号阶梯 `--text-xs: 11px` / `--text-sm: 12.5px` / `--text-base: 13.5px` / `--text-lg: 15px` /
   `--text-xl: 20px` / `--text-2xl: 26px`，配套 `--leading-tight: 1.25` / `--leading-normal: 1.5`，
   以及字重 `--weight-regular: 400` / `--weight-medium: 500` / `--weight-semibold: 600`。
   正文基准从 14px 改为 `--text-base`，`letter-spacing` 微调（正文 0，大标题 `-0.01em`）。
3. 颜色（暗色为主，Apple 灰阶 + 保留极光品牌色）：
   `--bg-base: #0b0c0f`、`--bg-raised: #141519`、`--bg-overlay: rgba(20, 21, 25, 0.78)`；
   分层填充 `--fill-1: rgba(255,255,255,0.045)` / `--fill-2: rgba(255,255,255,0.075)` / `--fill-3: rgba(255,255,255,0.11)`；
   文本 `--text-primary: #f5f5f7` / `--text-secondary: #a1a1aa` / `--text-muted: #6e6e73`；
   分隔线 `--border-subtle: rgba(255,255,255,0.07)` / `--border-strong: rgba(255,255,255,0.14)`；
   品牌渐变保留 `--aurora-green: #38d196` / `--aurora-blue: #5684ff` / `--aurora-gradient`（其余窗口依赖它）；
   状态色保留 `--status-idle|running|unread|error` 语义不变。
4. 圆角与材质：`--radius-xs: 6px` / `--radius-sm: 10px` / `--radius-md: 14px` / `--radius-lg: 20px` / `--radius-xl: 28px` /
   `--radius-pill: 999px`；材质 `--blur-thin: 12px` / `--blur: 24px` / `--blur-thick: 40px`，
   `.glass` 升级为「`backdrop-filter: blur(var(--blur)) saturate(180%)` + 1px 内描边 + `--shadow-2`」三层，
   并加 `@supports not (backdrop-filter: blur(1px))` 的实色回退。
5. 阴影与缓动：`--shadow-1: 0 1px 2px rgba(0,0,0,.24)` / `--shadow-2: 0 8px 24px rgba(0,0,0,.32)` /
   `--shadow-3: 0 24px 64px rgba(0,0,0,.44)`；
   `--ease-standard: cubic-bezier(.2,.8,.2,1)` / `--ease-spring: cubic-bezier(.22,1,.36,1)`；
   `--dur-fast: 140ms` / `--dur-base: 220ms` / `--dur-slow: 340ms`；`--transition-fast` / `--transition-base` 映射到新的时长与缓动。
6. 可访问性与系统偏好：
   - `:root` 里加 `@media (prefers-reduced-motion: reduce)`，把 `--dur-fast|base|slow` 压到 `1ms` 且禁用位移类动画；
   - 全局 `:focus-visible { outline: 2px solid rgba(86,132,255,.7); outline-offset: 2px; border-radius: inherit }`，
     并移除默认 `outline` 的粗暴重置；
   - `::selection` 用品牌蓝半透明；滚动条改为细圆角、悬停加深（沿用现有写法但用新令牌）。
7. 动效工具类（供五个窗口复用，替换各页手写的 transition）：
   - 交互反馈：`.interactive`（hover 上浮 1px + `--shadow-2`；active 缩到 `scale(.98)`）；
   - 进场：`.anim-rise`（`opacity 0→1` + `translateY(6px)→0`，`--ease-spring`）、`.anim-pop`（`scale(.96)→1`）；
   - Vue `<Transition>` 预设按 name 定义：`.sheet-*`（面板从右滑出 + 淡入）、`.rise-*`、`.fade-*`、`.collapse-*`（高展开）。
8. `docs/07-ui-spec.md` 加一小节（§5 内追加即可）把上表的**令牌语义与动效规范**写成文档（SSOT 要求）；
   同时写明「动效必须响应 `prefers-reduced-motion`」这一硬约定。

### B. 共享组件统一外观

9. `ls apps/desktop/src/renderer/shared/components/` 拿到全部组件，逐个用新令牌重写 `scoped` 样式，
   **不改变组件的 props / emits / 使用方式**（调用方在 step-04/05/06 才动），重点：
   - `AppButton.vue`：`primary|secondary|ghost|danger` 四变体 + `sm|md`，圆角 `--radius-pill` 或 `--radius-sm`，
     加 `.interactive` 的 hover/active 反馈与 focus ring；
   - `SettingField.vue`：label/hint/control 三行栅格，控件（input/select/textarea）统一高度、圆角、聚焦光晕；
   - `AppToast.vue`：`info|warn|error|ok` 四色用 `--fill-*` + 语义色，进场用 `.anim-rise`；
   - `StatusDot.vue`：running 态加低频呼吸动画（`animation: breathe 1.8s ease-in-out infinite`），
     在 `prefers-reduced-motion` 下退化为静态色；
   - `MessageList.vue` / `SensitiveToolCard.vue` / `ClassificationLedger.vue`：只统一令牌与圆角阴影，结构留到 step-04/06。
10. 抽掉重复的页面级样式：把各页 `header h2 { margin:0; font-size:16px }`、`.page { display:flex; ... max-width }`
    这类重复声明，收敛为 `theme.css` 里的 `.page` / `.page-title` / `.page-sub` 全局类（step-04/05/06 逐页改用）。

### C. 截图核对工具（本步必须建好，后续几步靠它验收）

11. 新建 `apps/desktop/src/main/capture.ts`，导出 `captureWindows(options)`：
    - 输入：`{ dir: string; windows: CaptureTarget[]; delayMs: number }`，`CaptureTarget` 形如
      `{ name: WindowName; file?: string; prepare?: () => Promise<void> | void }`；
    - 行为：`ensure(name)` → `show(name)` → 等 `delayMs`（默认 700ms，让过渡动画结束）→ `webContents.capturePage()`
      → `toPNG()` 写 `${dir}/${file ?? name}.png`；单窗失败只记日志、不中断整批；
    - 不 import 任何渲染层代码，只用 electron 的 `BrowserWindow` 能力。
12. 在 `apps/desktop/src/main/index.ts` 启动流程末尾（`logger.info('Aurora 就绪')` 附近）挂钩：
    当 `process.env['AURORA_CAPTURE']` 有值时，在 `windows` 与 `settings` 都就绪后调用 `captureWindows`，
    目录取环境变量值（默认 `%TEMP%/aurora-capture`，用 `node:os` 的 `tmpdir()` 拼）；
    窗口清单取 `process.env['AURORA_CAPTURE_WINDOWS']`（逗号分隔，缺省为全部窗口），
    并内置两个特殊场景：`edge-bar` 先截收起态、再 `setEdgeBarExpanded(true)` 后截 `edge-bar-expanded.png`；
    `settings` 通过 `?page=<id>` 逐个页面截图（见第 13 条）。仅 dev 生效（与 `AURORA_SMOKE` / `AURORA_DEVTOOLS` 同一套路），
    截图完成后正常退出，不常驻。
13. 让设置窗口支持深链：`apps/desktop/src/renderer/settings/App.vue` 的 `active` 初值改为读取
    `new URLSearchParams(window.location.search).get('page')`，命中 `PageId` 时用它，否则回落到 `'general'`。
    （`main` 进程的 `load()` 需要支持附加 query：给 `WindowManager.load()` 的 URL / `loadFile` 传入 `query` 选项即可，
    仅在截图场景使用，正常启动不带 query。）
14. `AGENTS.md` 的「常用命令」小节补一行：`AURORA_CAPTURE=<目录> pnpm dev` 会把各窗口截图落盘，用于前端视觉核对。

### D. 出口

15. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build` 全绿；跑一次 `AURORA_CAPTURE` 产出
    `edge-bar.png` / `chat.png` / `mini-chat.png` / `settings.png` 等 PNG，确认工具可用（本步不评价美观，只确认能出图）。
16. 提交 `feat(ui): 建立 Apple 风格设计令牌与动效体系，新增窗口截图核对工具`。

## 验收标准

- [x] `pnpm typecheck && pnpm test && pnpm build` 通过；五个窗口都能正常渲染（截图非空白，无样式丢失）。
- [x] `theme.css` 里既有令牌名**一个都没删**（`grep -n "\-\-transition-base\|--radius-md\|--bg-raised" theme.css` 有命中），
      新增令牌有中文注释说明用途。
- [x] `@media (prefers-reduced-motion: reduce)` 生效路径存在且覆盖位移类动画；`:focus-visible` 全局可见。
- [x] `ls apps/desktop/src/renderer/shared/components/` 下所有组件都改用新令牌，且 props/emits 未变
      （`git diff --stat` 里这些组件的 template 部分改动仅为类名/样式）。
- [x] `AURORA_CAPTURE=<临时目录> pnpm dev` 能在该目录产出至少 4 张非空 PNG（实测 **13 张全非空**）；
      `AURORA_CAPTURE_WINDOWS=settings` 可只截设置窗（实测 6 张）。
- [x] `settings?page=llm` 能直接把设置窗打开在 AI 模型页（截图文件名可区分各页）。
- [x] `docs/07-ui-spec.md` 已包含令牌与动效规范；`AGENTS.md` 已包含 `AURORA_CAPTURE` 用法。

## 交接

- 留给 step-04/05/06：新令牌与 `.interactive` / `.anim-*` / `.page` 全局类可直接用；既有令牌名保留，可增量迁移。
- 留给 step-04/05/06/07：截图命令为 `AURORA_CAPTURE=<目录> pnpm dev`（可加 `AURORA_CAPTURE_WINDOWS=` 限定窗口）；
  设置页深链为 `settings?page=<general|modes|llm|skills|mcp|advanced>`。
- 留给 step-07：截图目录约定 `<目录>/<window>.png`，提示条展开态为 `edge-bar-expanded.png`。

## 执行记录

### 实际改动

- **A. theme.css 重写**：既有令牌名全部保留（值改为 Apple 灰阶 + 分层填充 `--fill-1|2|3`）；
  新增字号阶梯 / 字重 / `--radius-xs|xl|pill` / `--blur-*` / `--shadow-1|2|3` /
  `--dur-*` / `--ease-standard|spring` / `--font-display`；`.glass` 三层（模糊 + 180% 饱和 + 内描边 + shadow）
  并带 `@supports not (backdrop-filter)` 实色回落；动效工具类 `.interactive` / `.anim-rise` / `.anim-pop`
  与 Vue Transition 预设 `.sheet-*` / `.rise-*` / `.fade-*` / `.collapse-*`；全局 `.page` / `.page-title` /
  `.page-sub`；`:focus-visible` / `::selection` / 细圆角滚动条；`prefers-reduced-motion` 全局兜底。
- **B. 共享组件**：7 个组件全部改新令牌，props / emits / 插槽用法**零改动**（调用方无需改）。
- **C. 截图工具**：新增 `main/capture.ts`（`prepare` / `act` / `check` 三段式 + `report.json`），
  `index.ts` 挂 `AURORA_CAPTURE` 分支（与 `AURORA_SMOKE` 互斥），`settings/App.vue` 支持 `?page=` 深链，
  `WindowManager` 补 `ensure(name, query)` / `reload()` / `whenLoaded()`。
- **D. 文档**：`docs/07` §5 重写为「视觉方向与设计令牌（SSOT）」+ 动效规范 + 截图工具说明；
  `AGENTS.md` 常用命令补 `AURORA_CAPTURE`。

### 探针发现（本步最有价值的一条）

第一次截图核对时 `edge-bar-expanded.png` 是**一张几乎全空的图**：主进程只加宽了窗口，而面板是**渲染层 hover 驱动**的。
由此给截图工具加了 `act`（在渲染层派发真实 `mouseenter` / `click`）与 `check`（`elementFromPoint` 命中测试），
探针随即发现**更严重的问题**：

```
展开态窗口 228×202，4 个按钮 top=278~410 → elementFromPoint 全部返回 null
```

即「面板存在但按钮点不到」——step-02 只加宽、没增高的真实后果。已作为独立 `fix:` 提交修复（`8aeba60`），
现在探针输出 `allClickable: true`、`windowHeight: 972`。

### 过程中修掉的工具自身缺陷

- 首轮全量截图里 `settings-general.png` 是 **0 字节**：`ensure()` 的加载是 fire-and-forget，
  调用方返回时页面还没开始加载，`webContents.isLoading()` 仍是 false，于是直接截到空图。
  → 新增 `WindowManager.whenLoaded()` 等待登记过的加载 promise；`captureWindows` 改为
  「先 ensure + whenLoaded → 再 reload 带 query」，顺带消掉了 `ERR_ABORTED` 噪音。
- 曾尝试用 `isLoading()` 兜底，结果 dev 下设置窗的 `isLoading` 长期为 true，每页白等 10s；
  改为 `captureNonEmpty()`（最多 4 次重试）+ 显式拒绝 0 字节文件，单页恢复到 ~0.8s。
- 反例留档：探针脚本里写 `${...}` 会被外层模板字符串当成插值 → esbuild 直接构建失败
  （`pnpm dev` 报 `No electron app entry file found`）。已改成字符串拼接并写进注释。

### 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | 全绿 |
| `pnpm test` | 43 文件 / 595 用例通过 |
| `pnpm build` | 成功 |
| `AURORA_CAPTURE=<tmp> pnpm dev` | **13/13 张 PNG 非空** |
| `AURORA_CAPTURE_WINDOWS=settings pnpm dev` | 6/6 张非空，单页 ~0.8s |
| 渲染层探针 | 4/4 按钮 `hit=true`、`allClickable=true`；点击竖条 → `chatVisible=true, miniChatVisible=false, primary=chat` |
| 人工读图 | `chat.png` / `settings-general.png` / `edge-bar-expanded.png` 正常渲染，无样式丢失 |

### git 提交

- `7a280db` `feat(ui): 建立 Apple 风格设计令牌与动效体系，新增窗口截图核对工具`（14 文件）

### 遗留 / 交接

- 展开态面板现在是「228 × 工作区高-48」（约 972px），内容只占上部与底部 → **step-05 需要把中部撑起来**
  （例如最近消息列表 / 分类流水摘要），否则会显得空。
- 截图工具覆盖「窗口长什么样 + 关键 DOM 能点」，不覆盖真机手感（悬停延迟是否自然）。
- transparent 窗口（edge-bar）的 PNG 透明区域在预览里显示为深色，属预期。
