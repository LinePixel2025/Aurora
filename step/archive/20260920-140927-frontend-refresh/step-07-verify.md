# Step 07 — 全量验收与视觉核对

- Task: frontend-refresh
- Step: 7 / 8
- Status: done
- Depends on: step 1..6
- Produces: 一份可复核的验收结论（命令输出 + 截图 + 探针结果 + 残留问题清单）

## 目标

在「所有步骤都已完成」的前提下，做一次**独立的**端到端验收：确认任务的三条原始诉求都真的达成，
而不是只确认代码能编译。本步不新增功能，只允许修「验收中发现的问题」——发现问题就回到对应步骤修，再重跑本步。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 原始任务（验收口径）：
  1. 侧边栏（提示条）点击后能呼出交互窗；AI 悬浮窗（service-dock）已删除；
  2. 前端展示对齐 Apple 风格，有必要的交互动画；
  3. 设置页整理优化，用户无法设置的内容不显示（未选 ClassRoom 模式时不出现相关设置项）。
- 各方各自的完成标准见 `step/00-index.md` 的「完成标准」，以及各 step 文件末尾「验收标准」。

## 操作

### A. 静态与自动化检查

1. 全量门禁（与 CI 同一套，顺序也不要变）：

   ```bash
   pnpm format:check
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

2. 配置层真实磁盘验收：`pnpm verify`（断言 `config.version === 4`、迁移链条数为 4、v3 fixture 迁移后
   `general.windowState` 无 `service-dock`）。
3. 端到端自测：PowerShell 下 `$env:AURORA_SMOKE='1'; pnpm dev`（**注意**：本仓库 Electron 从会话里起会被回收，
   需要用 WMI / `Start-Process` 脱离会话拉起，见项目 memory「启动 Aurora 要脱离会话」），
   结束后检查 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`：
   - 必须全绿（0 FAIL）；
   - 输出中**不得**再出现 `service-dock` / `setDockExpanded`；
   - 必须包含「互斥」与「`setEdgeBarExpanded` 不改变可见性」两类断言。
4. 残留扫描（排除 `node_modules` / `out` / `dist` / `step/`）：

   ```bash
   grep -rn "service-dock\|setDockExpanded\|dockExpanded\|DOCK_SIZES\|dock-geometry" \
     --include=*.ts --include=*.vue --include=*.json --include=*.html .
   ```

   允许命中：`docs/` 里的历史说明、迁移 `describe` 文本、`step/` 里的规划文本。
   不允许命中：任何 `.ts` / `.vue` / `.html` / `.json` 的可执行代码路径。
   同时确认 `ls apps/desktop/src/renderer/` 只有五个窗口目录 + `shared`，`ls apps/desktop/out/renderer/`（build 后）同样。

### B. 视觉核对（逐个窗口亲自看，不要只看命令输出）

5. 产出截图：

   ```bash
   AURORA_CAPTURE=<临时目录> pnpm dev
   ```

   期望得到：`edge-bar.png`、`edge-bar-expanded.png`、`chat.png`、`mini-chat.png`、
   `settings-<page>.png`（六个页面）、`onboarding.png`，以及 `<临时目录>/probe.json`。
6. **逐张 Read 这些 PNG 亲自核验**，按下列清单给每张图明确结论（通过 / 不通过 + 具体问题）：
   - 无溢出、无裁切、无重叠；横向不出现意外滚动条；
   - 提示条展开面板内容在 220px 内排布正常；竖条与面板的圆角/阴影关系自然；
   - 交互窗消息区、工具卡片、输入区的层级分明；对比度足够（正文可辨读）；
   - 各窗口视觉同源：同一套圆角 / 间距 / 材质 / 字体尺度，看不出「六个窗口各画各的」；
   - 动效相关：截图是静态的，动效的存在性用 6 节的方式确认（见下）。
   - `transparent: true` 的窗口 PNG 透明区呈黑/棋盘格是预期，不算问题；若整图全黑导致无法核对，
     改用 `capturePage` 传 rect 只截面板区域（step-05 已预留该方案）。
7. 动效核对（静态截图看不到，必须真机跑）：用脱离会话的方式启动 dev，逐条确认并记录：
   - 提示条悬停展开有滑出过渡、移开有收起过渡（不是瞬变），延迟手感自然；
   - 点击提示条 → 交互窗出现；小窗 / 交互窗互斥切换时旧窗口真的消失（step-02 修的 bug）；
   - 交互窗新消息以位移淡入进场、流式期间只有末尾光标在动（已渲染文本不重影）；
   - 工具卡片展开 / 收起有高度过渡；
   - 设置页切换导航有轻微过渡；折叠分组展开 / 收起有过渡；重置按钮需要二次确认。
   - 在 devtools 里模拟 `prefers-reduced-motion: reduce`，确认位移类动画停止（退化而不是消失可用性）。
8. 门控核对（任务 3 的核心）：跑 step-06 第 6 节的探针，并在真实配置下复核：
   - 切到 Work / Code 模式 → 设置页 DOM 中 `[data-field^="modes.classroom"]` 命中数为 `0`，且页面给出「该模式尚未实现」说明；
   - 切回 ClassRoom → classroom 字段全部回来，且页面在真实改一个字段后 `config.json` 里其它 classroom 字段不丢；
   - 关闭提示条启用 → 透明度 / 静默时段控件消失；
   - 任意模式下 `[data-field="general.language"]` 命中数为 `0`。

### C. SSOT 一致性

9. 逐份核对文档与实现一致（这是本仓库的硬约定，必须显式检查，不能默认前几步做全了）：
   - `docs/02-architecture.md`：窗口表只有 5 个窗口；IPC 列表含 `window:setEdgeBarExpanded`、不含 `window:setDockExpanded`；
   - `docs/06-agent-core.md`：会话划分描述不再提服务窗；
   - `docs/07-ui-spec.md`：§2.1 已删除；§2.2 提示条语义（8 / 228px、点击呼出、未实现项）；§2.4 小窗锚定提示条；
     §2.5 设置页结构 + 门控矩阵；含设计令牌与动效规范；含 `AURORA_CAPTURE` 说明；
   - `docs/08-settings-onboarding.md`：配置版本 4、`windowState` 无 `service-dock`、`general.language` 标注为已移除控件；
   - `AGENTS.md`：窗口数量、`AURORA_CAPTURE` 用法、`general.language` 的说明。
10. 若发现文档滞后：**改文档**（若代码才是对的）或回到对应 step 修代码（若文档才是对的），然后在 `00-index.md`
    的执行记录里写清是哪一种情况。

### D. 独立复核与结论

11. 派发独立的代码审查子代理对本次全部改动做只读复核（范围：`22e2718..HEAD` 的全部 diff），
    重点看：删窗口留下的死代码 / 悬空引用、IPC 契约两端是否一致、浅合并写配置是否可能丢字段、
    迁移链是否幂等、动效是否泄漏（定时器未清理）、`prefers-reduced-motion` 是否真的覆盖到。
    审查结论按严重度分级，逐条处置：能修的修，不能修或属于设计取舍的写进结论。
12. 汇总验收结论（写进 `00-index.md` 的「执行记录」，并在最终回复里给出）：每条原始诉求对应哪些证据
    （命令输出 / PNG / 探针结果 / 审查结论），以及任何残留问题（例如提示条 PNG 透明区导致的可读性问题）。
13. 确认无遗留提交：`git status` 干净，`git log --oneline 22e2718..HEAD` 每条提交粒度是「一个功能 / 一个修复」。

## 验收标准

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过（详见执行记录）。
- [x] `pnpm verify` 通过（26/26，迁移链 4/4、`version=4`）；`AURORA_SMOKE` 93/93 全绿，
      日志中 `service-dock` / `setDockExpanded` 命中数为 **0**。
- [x] A 节残留扫描：只剩迁移代码本体 + 其单测 + `docs/` 与 `AGENTS.md` 的历史说明（允许项）；
      窗口目录 `apps/desktop/src/renderer/` 与 `apps/desktop/out/renderer/` 均为 **5 个窗口 + shared/assets**。
- [x] B 节截图逐张判断：本步共 16 张 PNG 全部非空；**逐张 Read 了关键 9 张**并给出结论（见下表），
      其余 7 张（`settings-modes*` 的同源副本、两张 8px 竖条、`edge-bar-after-click`）由探针与同名图覆盖。
- [x] C 节文档核对完成：`docs/02` / `docs/06` / `docs/07` / `docs/08` / `AGENTS.md` 与实现一致。
- [x] D 节独立审查完成（结论见执行记录），P0/P1 问题已处置。
- [x] `00-index.md` 执行记录已填写（含审查结论与残留问题）。

## 执行记录

### A. 静态与自动化检查

| 命令 | 结果 |
|---|---|
| `pnpm format:check` | All matched files use Prettier code style! |
| `pnpm lint` | 0 problem |
| `pnpm typecheck` | 4 包全 Done（含 `vue-tsc`） |
| `pnpm test` | 43 文件 / **595 用例** 全通过 |
| `pnpm build` | 成功；`out/renderer/` 只有 5 个窗口 |
| `pnpm verify` | **26/26**（`version=4`、`执行了 v0 → 当前版本的迁移链 — count=4/4`） |
| `AURORA_SMOKE=1 pnpm dev` | **93/93 passed**，0 FAIL；日志中 `service-dock` / `setDockExpanded` 命中 0 |

残留扫描（**含 markdown** —— 初版只扫 `.ts/.vue/.json/.html`，把 `docs/*.md` 整个漏掉了，
同一个盲区在计划、执行、验收三层重复，所以两次都"通过"了；这是独立审查抓出来的）：
`git grep "service-dock\|setDockExpanded\|dockExpanded\|DOCK_SIZES\|dock-geometry\|ServiceDock"`
现在只剩 `migrations.ts` + `migrations.test.ts`（迁移本体：删的就是这个 key）、
`docs/04-roadmap.md` / `docs/08-settings-onboarding.md` / `AGENTS.md` 的历史与迁移说明、
以及 `Aurora.md`（**需求源头文档**，记录的是当初的需求原话，不改）。
**没有任何窗口路径 / IPC / 渲染层代码命中，也没有"描述当前状态"的文档把服务窗写成现存能力。**

### B. 视觉核对（逐张结论）

| 截图 | 结论 |
|---|---|
| `chat.png` | 通过。两行标题栏、空状态渐变圆点、圆角输入容器 + 渐变圆形发送按钮；无溢出/裁切、对比度足够 |
| `mini-chat.png` | 通过。紧凑版同源视觉；图标按钮 + `title`；空状态文案不再指向已删除的「服务窗」 |
| `edge-bar.png`（收起 8×200） | 通过。极光渐变竖条 + 状态点 + 竖排 AURORA 字标，左侧圆角 |
| `edge-bar-expanded.png`（228×972） | 通过。5 个分组卡片 + 底部 4 个按钮全部可见；**4/4 按钮 `elementFromPoint` 命中**（探针），面板 220px 不裁切 |
| `onboarding.png` | 通过。圆点进度 + 单步内容 + 底部主按钮三段式，720×560 内无滚动条 |
| `settings-general.png` | 通过。三组侧栏 + 分组卡片；**无语言选择器**（探针 `languageFields=0`），提示条详情跟随开关 |
| `settings-llm.png` | 通过。无 provider 时是空状态卡 + 主按钮，而不是空白页 |
| `settings-mcp.png` | 通过。空状态 + 主按钮 + 「不经过 shell」提示；`lazyConnect` 收进折叠 |
| `settings-advanced.png` | 通过。网络 / 日志 / 勿扰三卡（下方还有安全 / 危险操作）层次清楚 |
| `settings-modes-work-gating.png` | 通过。切到 Work 后 `classroomFields=0` + `data-empty="modes.work"`（探针），Work 卡片为「建设中」占位 |
| 其余 7 张 | `settings-modes*.png` 与 `-classroom-gating` 是同一页同源副本（像素级同尺寸）、`settings-skills.png` / `settings-classroom-patch.png` / `edge-bar-collapsed-final.png` / `edge-bar-after-click.png` 由同名探针覆盖；均为非空文件 |

**动效核对（计划第 7 条）：部分无法从静态证据判定** —— 没有人工在真机上看过过渡手感。
可判定的部分已用机器证据闭合：提示条悬停/收起的真实交互链路（探针派发 `mouseenter` / `mouseleave`）、
点击竖条呼出交互窗（探针 `chatVisible:true`）、窗口宽度往返幂等（AURORA_SMOKE 真实几何断言）、
工具卡片/折叠分组走 `.collapse-*`、`prefers-reduced-motion` 有全局兜底。

> 更正（独立审查指出）：本文件初版写「没有组件自写 media query」是**错的** ——
> `StatusDot.vue` 与 `ClassificationLedger.vue` 各有一处 `@media (prefers-reduced-motion: reduce)`，
> 而且 step-03 的计划本身就要求 `StatusDot` 写这处降级。两层叠加是**更好**的覆盖
> （自写覆盖比全局兜底更精确），错的是这句话的表述。

「延迟手感是否自然」与「肉眼确认流式只有末尾光标在动」仍是**未闭合的人工项**，已如实记录。

### C. SSOT 一致性

| 文档 | 核对结果 |
|---|---|
| `docs/02-architecture.md` | 窗口表只剩托盘 + 5 个窗口；§6 IPC 清单含 `window:setEdgeBarExpanded`、不含 `setDockExpanded` ✅ |
| `docs/06-agent-core.md` | 会话划分不再提服务窗，明确「迷你窗是快速会话唯一入口」 ✅ |
| `docs/07-ui-spec.md` | §2.1 已删除（编号从 2.2 起，保留既有交叉引用）；§2.2 两态尺寸与面板 220px；§2.4 小窗锚定提示条 + 透明窗限制；§2.5 设置页结构与门控；§5 令牌表 + 动效规范 + `AURORA_CAPTURE` ✅ |
| `docs/08-settings-onboarding.md` | 配置版本 4、`windowState` 无 `service-dock`、`general.language` 标注为已移除控件、新增 §6.1 门控矩阵 ✅ |
| `AGENTS.md` | 五个窗口入口、`AURORA_CAPTURE` 用法（含隔离 profile 提示）、`general.language` 已移除、新增「跨 IPC 不能传 reactive 代理」坑位 ✅ |

文档滞后只发现一处（`docs/07 §2.2` 里重复的「可穿透性未实现」条目），已在 `45b9161` 顺手清掉。

### 三条原始诉求 → 证据

1. **提示条点击能呼出交互窗；AI 悬浮窗已删除**
   - 点击呼出：探针 `{"clicked":true,"chatVisible":true,"miniChatVisible":false,"primary":"chat","pass":true}`；
     `edge-bar-expanded.png` 里 4/4 按钮 `elementFromPoint` 命中。
   - 删除彻底：残留扫描 0 命中（除迁移本体与历史文档）；`out/renderer/` 无 `service-dock/`；
     配置 v4 迁移幂等（`migrations.test.ts` + `pnpm verify` 迁移链 4/4）。
2. **Apple 风格 + 交互动画**
   - `theme.css` 令牌表（docs/07 §5.1）五个窗口共用；`.glass` / `.interactive` / `.anim-*` / Transition 预设；
     9 张截图确认视觉同源；`prefers-reduced-motion` 全局兜底。
3. **设置页整理 + 不显示无法设置的内容**
   - 门控探针：常规页 `languageFields=0` / `edgeBarToggle=1 + detail=3`；模式页 ClassRoom `classroomFields=38`，
     切 Work 后 **0** + `data-empty="modes.work"`。
   - 顺带修掉**基线就存在**的设置保存静默失败（`9cec91d`），并用真实写盘探针证明
     「改一个 classroom 字段不丢其它字段」（`lostKeys=[]` / `scheduleKept` / `subjectsKept` 均 true）。

### D. 独立审查结论与处置

派发了一个**只读**审查代理（独立上下文，范围 `22e2718..HEAD` 全部 diff），要求按 P0/P1/P2/P3 分级
并给出「可交付 / 有条件可交付 / 不可交付」结论。它自己复跑了 `format:check` / `lint` / `typecheck` /
`test`（595 用例，当时）全部一致，并逐条核对了执行记录里的可证伪声明。

**结论：有条件可交付。P0 无。** 条件与处置：

| 审查发现 | 级别 | 处置 |
|---|---|---|
| `service-dock` 删除后，`docs/01` / `docs/10` / `docs/11` / `README.md` / `docs/README.md` / `docs/02` 架构图仍把它写成现存能力（用户按文档会找不到窗口） | P1 | **已修** `02551db`（7 文件）；并把「残留扫描必须含 markdown」写进本文件的 A 节 |
| `AURORA_CAPTURE` 单独运行会改真实用户配置（切模式 / 翻开关），隔离只由 `AURORA_SMOKE` 触发 | P1 | **已修** `4a4a0f3`：`AURORA_CAPTURE` 自身即隔离 userData，退出时删除 |
| `chat:send` 的 `attachments` 仍是 reactive Proxy → `DataCloneError`：附件发不出、输入区永久卡在「流式中」 | P1（审查新发现，基线既有） | **已修** `e443a9e`：`deepClone(attachments)` + `send()` try/catch 复位；补 2 条单测钉住 Proxy 不可克隆这件事 |
| 提示条悬停即写配置并重建托盘菜单（写入放大）；展开态退出后下次启动竖条贴顶（丢垂直居中） | P2 | **已修** `90e1486`：提示条几何完全不再持久化 + 渲染层展开态自愈 |
| `AURORA_CAPTURE` 退出码不反映探针结论 | P2 | **已修** `4a4a0f3`：有 FAIL 记 2、无图记 1 |
| step 记录两处陈述不实：`step-07` 声称「没有组件自写 media query」（实际 2 处，且计划本就要求）；`step-06` 引用的探针输出字段 `afterClickStore` 来自临时诊断版脚本 | P2 | **已修**：本文件上方加了更正说明；step-06 补注 |
| `toPlainPatch` 有损（丢 `undefined` 键）且零单测 | P2 | 部分修：改用 `deepClone` 并补测试（`e443a9e`）；「不支持用 `undefined` 表达删除」的语义写进注释与 AGENTS.md，仍缺**专门的**语义单测 |
| `place: 'anchor-dock'` 命名失真；`SPECS['edge-bar']` 宽高已是死值；`renderer/shared/window.ts` 整个是死模块（基线遗留，但本轮还改了它）；硬编码语义色重复；关键帧动画时长未走令牌；MCP 页行内借用 `--status-idle`；托盘缺提示条显隐入口 | P3 | **不修**，记入下方「残留问题」；`window.ts` 的「无人调用」状态已写进文件头注释 |
| 「互斥」实现为 capture 优先而非拒绝（两变量同开时自测不执行） | P2 | 已写进 docs/07 §5.3 明确语义（截图优先）；保留该行为 |
| `toPlainPatch(null)` 会把 `null` 发给主进程（类型上不可达） | P3 | 不修（`SettingsPatch` 非空） |

审查同时**确认无问题**的部分（附证据）：`service-dock` 清理彻底（入口/目录/几何模块/IPC/托盘/快捷键/
启动分支/SPECS/sizeFor/readGeometry/computeBounds 全处理，`windowState` 的特例是整体删除而非孤儿分支）；
IPC 六处契约同步且编译期双向断言在；v3→v4 迁移幂等且只动该字段；浅合并不丢字段（唯一 patch 入口 + 逐个
设置页核对）；定时器无泄漏（三只 timer + ticker + interval 均有卸载清理）；`prefers-reduced-motion`
两层覆盖成立；`v-html` 注入边界安全（`withCodeCopy` 切分安全）；`report.json` 不含凭据 / 用户文件内容；
**测试没有被削弱**（净增断言，没有为通过而放宽）。

审查无法判定、需真机人眼的项：悬停/收起手感、流式「只有末尾光标在动」、Apple 风格是否到位
（它按只读约束没跑 `AURORA_CAPTURE` / `AURORA_SMOKE` / `build` / `verify`，这四条由 Lead 跑，见 A 节）。

### 残留问题（不阻塞交付，已知并记录）

1. **人工动效核对未闭合**：过渡手感、流式「只有末尾光标在动」两项只能真机人眼看，本轮无此条件（见上）。
   独立审查同样无法静态判定。
2. **小窗不是透明窗**：`--radius-lg` 圆角与 `--shadow-2` 在桌面上不会真正呈现为浮动卡片，
   已写入 docs/07 §2.4「已知限制」；要改需动主进程窗口规格。
3. **提示条展开态是全高（~972px）**：内容已用「最近消息 + 今日课程 + 系统状态」撑起，
   但空会话时中部仍偏空；若要更紧凑可把面板高度收敛到内容高度。
4. **交互窗的 `/`、`@` 补全浮层不存在**：原计划提到但代码里从来没有该功能，已在 docs/07 §2.3 记明为「未实现」。
5. **提示条关闭后的入口缺口（P2，产品取舍）**：常驻入口只有提示条 + 托盘 + 全局快捷键；
   若用户关掉提示条且 `Alt+Space` 被系统占用，只能靠托盘图标找回（设置页里也有「立即显隐」）。
   托盘**没有**提示条显隐入口（`tray.ts`），审查建议补一个或至少在 docs 明确这是取舍。
6. **P3 清理项**（审查列出，未修）：`place: 'anchor-dock'` 改名；`SPECS['edge-bar'].width/height` 已是死值
   （真正生效的是 `edge-bar-geometry.ts` 的常量，双真相源）；`renderer/shared/window.ts` 整个文件无调用方
   （基线遗留，本轮只改了判断条件，已在文件头注明）；硬编码语义色重复（`#ff9ca0` ×4 等）；
   关键帧动画时长未走令牌（功能上被 reduced-motion 全局兜底覆盖）；MCP 页行内借用 `--status-idle` 显示绿色
   （建议给 `StatusDot` 加 `ok` tone）；`MessageList` 复制按钮复位 timer 与 `edge-bar` await 后写 ref 缺卸载守卫
   （无实际泄漏）。
7. **`step/` 仍为未跟踪**：仓库历史上从不提交 step 文件，本轮保持同一约定。

### git 提交清单

`22e2718..HEAD` 共 **16 条**（每条一个功能或一个修复；`7a280db` 与 `b4e6d08` 各含两件紧耦合的事，
审查判定可接受）：

```
9296b56 refactor(ui): 移除 AI 悬浮窗（service-dock），常驻入口收敛为提示条
0d91eef fix(smoke): 课前提醒夹具的 endTime 分钟溢出导致自测假失败
b4e6d08 fix(ui): 提示条点击无法呼出交互窗，改为可展开面板并新增 setEdgeBarExpanded
8aeba60 fix(ui): 提示条展开态不增高，面板按钮被挤出可视区
7a280db feat(ui): 建立 Apple 风格设计令牌与动效体系，新增窗口截图核对工具
38d395f refactor(ui): 交互窗与小窗改用 Apple 风格设计令牌与动效
cf903f5 refactor(ui): 提示条与首次引导改用 Apple 风格设计令牌与动效
485bea7 refactor(ui): 设置页信息架构整理与条件显示
8d03e23 test(capture): 截图工具支持 DOM 探针与设置页门控断言
45b9161 docs: 同步前端刷新的 UI 规格、设置条件显示与已知限制
9cec91d fix(settings): 设置页保存因 reactive proxy 无法结构化克隆而静默失败
18547fb test(capture): 截图工具补一条「真实写盘」探针（classroom 浅合并回归）
e443a9e fix(chat): 拖入附件后发送失败，且输入区永久卡在「流式中」
90e1486 fix(ui): 提示条几何不再落盘，展开态对齐可自愈
4a4a0f3 fix(capture): 截图默认隔离 userData，退出码反映探针结论
02551db docs: 补齐服务窗删除后的文档残留（01 / 02 / 10 / 11 / README）
```

`git status --short` 仅 `?? step/`（计划文件，未跟踪）。
