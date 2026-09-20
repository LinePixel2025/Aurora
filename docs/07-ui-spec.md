# 07 · 窗口与交互设计规格

状态：`已定稿`（v1 基线）

## 1. 设计原则

- **轻**：默认占用最小（提示条），完整窗口按需展开。
- **顺**：所有展开 / 收起带过渡动画，不突兀。
- **聚**：视觉统一（深色主题为主、跟随系统）、状态指示一致（AI 状态灯全局同色语义）。
- **隐**：业务窗口无任务栏图标，托盘为唯一管理入口；所有窗口可一键隐藏。

## 2. 窗口规格

### 2.2 右侧提示条（Edge Bar）

- **形态**：贴屏幕右缘竖条（**收起态 8×200px**），悬停展开为面板（**展开态窗口 228px 宽 × 工作区高 - 48px**），置顶。
- **内容**：AI 状态灯 + 当前模式 + 最近消息 + 今日课程 + 系统状态（展开态）。
- **行为**：
  - 悬停 → 展开面板；面板含「打开对话窗口 / 小窗对话 / 设置 / 隐藏提示条」入口；
  - 点击竖条 → 从右侧滑出完整 AI 交互窗口（桌面层，可覆盖任意应用）；这是提示条的主操作，**展开态下竖条仍是有效点击目标**；
  - 移开鼠标 → 面板收起，窗口尺寸收回竖条尺寸（8×200），不留不可见的遮挡区域。
  - 实现状态（前端刷新轮）：
    - 两态由 IPC **`window:setEdgeBarExpanded`** 驱动（渲染层 → preload → `WindowManager.setEdgeBarExpanded`），
      主进程执行 `setBounds`：**右缘固定 + 垂直中心固定**，宽度 8 ↔ 228px、高度 200px ↔ 工作区高 - 48px；
      几何算术在 `main/edge-bar-geometry.ts`（纯函数 + 单测）。
    - **展开态必须跟着长高**：面板内容（状态 / 模式 / 最近消息 / 今日课程 / 系统状态 + 4 个操作按钮）
      在 200px 里装不下，只加宽会得到「看得到面板却点不到按钮」——实测按钮落在 y=278~410、窗口仅 202px 高，
      `elementFromPoint` 全部落空。`AURORA_CAPTURE` 的 DOM 探针会把这条钉住（见 §5.3）。
    - 渲染层悬停延迟 120ms 展开（先加宽窗口再显示面板，避免面板被 8px 窗口裁掉）、
      移开延迟 220ms 收起（等面板退出动画结束再收窗口）；窗口隐藏时主进程会把尺寸复位，
      避免下次显示残留展开态尺寸。
    - **面板内容区 220px，`right: 8px`**：面板不能贴到窗口最右缘（否则会盖住 8px 竖条，
      「展开态竖条仍可点」就不成立、竖条的悬停反馈也看不见）。228 = 220 面板 + 8 竖条。
      面板内是 5 个 `--fill-1` 分组卡片（统一用卡片不用分隔线）+ 底部 4 个 `AppButton`；
      「最近消息」列表 `flex: 1 1 auto` 吸收剩余高度，中部不留大片空白。
    - 提示条**只持久化 y**：宽高由折叠态决定、水平位置恒定贴右缘，跨启动不复用持久化宽高
      （否则收起态会继承展开态的 228px 宽）。
  - 未实现：`可穿透性可配`（尚未接入 `setIgnoreMouseEvents`）——提示条仍然整块接收鼠标事件。
- **可配置**：显示 / 隐藏、透明度、静默时段。
  - 实现状态（v0.6.0）：`general.edgeBar.opacity` 保存后即时应用（`setOpacity`，范围 0.2–1.0）；
    `general.edgeBar.quietHours` 由 `main/edge-bar-scheduler.ts` 每 30s 判定，**仅控制提示条自身显隐**，
    与 `advanced.quietHours`（控制主动打扰：课前提醒 / 敏感工具确认）职责分离、互不影响。
    可见性只在状态翻转时切换，避免反复 show 把用户刚手动隐藏的提示条拉回来。
    设置页里这两项跟着 `general.edgeBar.enabled` 显示（见 docs/08 §6.1）。

### 2.3 AI 交互窗口（Chat Window）

- **完整对话**：Markdown、代码高亮、流式渲染、工具执行卡片（可展开查看细节）、附件与文件拖拽发送。
  - 实现状态（v0.6.0）：**附件拖拽已落地** —— 路径解析在 preload（`webUtils.getPathForFile`，Electron 32+ 已移除 `File.path`），
    文本提取复用分类管线的 utilityProcess 提取器（单文件上限 8000 字、单条消息最多 5 个）；提取失败的附件会在上下文里**如实标注「未读取」**，不假装已读。
    小窗（2.4）同样支持拖拽。
- **尺寸**：约 420×640，可调、位置记忆；会话历史列表。
  - 实现状态（v0.6.0）：**多会话列表已落地**（`chat:sessions` 列表 + `chat:newSession` 新建 + 切换）。
    标题取首条用户消息前 24 字（不额外调用模型生成标题），按最后消息时间倒序；
    空会话显示为「新会话」且不落空文件（首条消息才创建）。窗口默认会话仍为 `main`，老数据继续可读。
- **联动**：由提示条拉出（贴右缘滑出）；失焦默认不自动隐藏（可配置），可一键收起回提示条。
- **视觉（前端刷新轮）**：容器 `.glass` + `--radius-lg`；标题栏两行（状态点 / 模式 badge / 会话标题 + 操作行）；
  用户消息右对齐胶囊气泡、助手消息左对齐纯文本块；代码块独立卡片 + hover 显隐「复制」
  （在 `markdown.ts` 已转义的白名单 HTML 上补结构，不改其输出契约）。
  工具卡片是「折叠头行（工具名 + `StatusDot` + 状态 + 耗时）+ `.collapse-*` 展开体」；
  耗时是**渲染层观察到的本次调用耗时**，历史水合出来的卡片不伪造耗时。
  流式追加只在末尾加光标（父级 `::after`），不对每条 `delta` 重放进场动画。
- **消息区跟随最新（v0.6.0 修复「对话不会自动拉到底」）**：滚动容器是窗口自己的 `.thread`，
  跟随逻辑在 `MessageList.vue` + `composables/useStickToBottom.ts`：
  - **默认跟随**：新消息 / 流式增量 / 历史水合导致内容变高时自动滚到底。
    信号有两条、合并到"每帧最多滚一次"：`MutationObserver` 看消息 DOM 的增删与文本变更
    （流式是原地改 `content`，工具卡片是插节点），`ResizeObserver` 看内容根与滚动容器的尺寸
    （窗口从隐藏到显示、用户缩放）；
  - **用户接管**：用户主动上滚、离底部超过 24px 即**暂停跟随**（否则回看历史时会被流式输出拽走），
    此时右下角浮出「↓ 回到最新」胶囊；点它或**自己发一条消息**（发完必然想看到回复）恢复跟随。
  - 判定与滚动都只读 `scrollHeight / scrollTop / clientHeight`，不引入新依赖，也不改 props / 插槽契约。
  - **为什么不只用 `ResizeObserver`**：交互窗的 `.thread` 是定高 flex 列，`MessageList` 根节点带
    `min-height: 100%`，内容超过一屏后根节点的盒子被钉在一屏高、多出来的部分按**溢出**渲染 ——
    元素尺寸不再变化，只监听尺寸会漏掉每一次流式增量（小窗的 `.thread` 是普通块级容器，根节点会跟着长高，
    所以只有交互窗复现）。`AURORA_CAPTURE` 的自动滚底探针正是靠"内容确实比窗口高"这条守卫把这个坑钉住的。
- **未实现**：输入框的 `/`、`@` 补全浮层 —— 代码里从来没有对应功能（composer 只有 textarea + Enter 发送），
  做它需要新开一步（渲染层要能拿到 Skill / MCP 工具清单）。

### 2.4 小 AI 交互窗口（Mini Chat）

- **精简对话**：气泡 + 流式文本 + 工具状态点（无完整执行卡片）。
- **尺寸**：约 320×480；锚定提示条左侧，提示条可用时贴其左缘垂直居中；提示条窗口不存在时回落工作区右下角。
- **会话**：快速会话（`quick`，与交互窗的 `main` 分离）；提供“展开到完整窗口”（会话迁移到交互窗）。
- **视觉（前端刷新轮）**：与交互窗同一套视觉语言但更紧凑 —— 内容圆角 `--radius-lg`、头部两个图标按钮
  （展开到完整窗口 / 隐藏，带 `title` 提示）、细圆角滚动条、同款输入区（`--fill-1` + 聚焦光晕 + 渐变圆形发送）。
- **滚动**：与交互窗共用 `MessageList.vue`，因此「消息区跟随最新 + 用户上滚暂停 + 回到最新胶囊」的行为一致
  （见 §2.3）。
- **已知限制**：该窗口是 `transparent: false`（只有提示条是透明窗），所以内容层的圆角与 `--shadow-2`
  在桌面上**不会真正呈现为浮动卡片**，四角仍是窗口底色的直角。要真正做到需要把该窗口改成透明窗
  并在渲染层铺 `body.transparent`，属主进程改动，本轮未做。

> **新增（v0.4.0 / v0.5.0）**：
> - **分类流水**（`ClassificationLedger.vue`）：可折叠区块，默认收起，展示
>   时间 / 文件 / 状态 / 科目 · 来源 · 置信 · 依据，支持「改到其他科目」「打开所在文件夹」「清空流水」；
>   交互窗与设置页共用同一组件（分别给 20 / 50 条）。
> - **敏感工具确认卡片**（`SensitiveToolCard.vue`）：挂在交互窗顶部，展示工具名与参数摘要、
>   到 `expiresAt` 的倒计时与进度条（≤15s 变红），「拒绝 / 允许一次」回执。
>   主进程在推送确认请求时会**主动显示并聚焦交互窗**，避免交互窗未打开时确认不可见而静默超时。

### 2.5 设置窗口

- 单窗口分栏：侧栏 7 项按三组排列 —— **基础**（常规 / 模式）／**AI 能力**（AI 模型 / Skill / MCP / 电脑操控）／
  **系统**（高级：日志、代理、静默时段）；当前项用分层填充 + 左侧品牌渐变指示条。
- **关闭入口（v0.5.1 起）**：本窗无系统标题栏（`frame: false`），因此侧栏品牌区自担标题栏职责——
  整行可拖动（`drag-region`），右侧提供「✕ 隐藏」按钮；按 `Esc` 等效。
  按 docs/02 §2.2 约定，此处「关闭」= **隐藏窗口**（不退出应用，退出只走托盘菜单）。
- 模式页：三模式卡片选择 + 引导状态；**只渲染当前模式的配置内容**，Work / Code 显示「暂无可配置项」空状态。
- **视觉（前端刷新轮）**：页面骨架统一用 theme.css 的 `.page` / `.page-title` / `.page-sub`，
  分组卡片用 `settings/settings.css` 的 `.section-card` / `.section-title` / `.section-desc`
  （该样式表只被设置窗 import，不影响其它窗口）；空状态用 `.empty-state`。
- **条件显示（v0.6.0）**：每个控件带 `data-field="<配置路径>"`，条件不成立时**控件不在 DOM 里**
  （不是 `disabled`、也不是 CSS 隐藏），原位置改为 `data-empty="<路径>"` 说明块。
  完整门控矩阵见 docs/08 §6.1；`general.language` 是死字段，**任何页面都不显示**。
- **实现说明（v0.4.0 / v0.5.0 / 前端刷新轮）**：ClassRoom 的完整配置由
  `settings/components/ClassroomSection.vue` 渲染。该文件现在只作**容器**（读配置 / 唯一浅合并
  `patch()` / 折叠分组），四块拆到 `settings/components/classroom/`：
  `PerceptionFolderField`（感知文件夹 + 打开文件夹）/ `SubjectsEditor`（科目增删改 + 关键词）/
  `ScheduleEditor`（课表 provider / 节次 / ClassIsland 连接测试 / 课前提醒）/
  `ClassificationBehavior`（自动移动 / 置信阈值 / 兜底文件夹 + 分类流水）。
  「感知文件夹」「科目」默认展开，「课表」「分类行为」默认折叠并在折叠头显示状态摘要。
  高级页分「网络 / 日志 / 勿扰 / 安全 / 危险操作」五卡，「重置为默认配置」需就地二次确认
  （不再用原生 `confirm`）。MCP 状态灯用 `StatusDot`，`lazyConnect` 收进「高级」折叠。

### 2.6 首次安装引导窗口

- 向导式：欢迎 → AI 模型（baseURL / API key / 模型名 + 测试连接）→ 模式选择 → 完成；完成后进入托盘常驻并显示提示条（流程详见 08 §3）。
- **视觉（前端刷新轮）**：三段式布局 —— 顶部「圆点进度 + 可拖动标题栏」、中部单步内容、
  底部「上一步 / 下一步·完成」。步骤切换用**方向正确**的两套动画（`sheet-next` 下一页从右滑入、
  `sheet-prev` 反向），表单统一走 `SettingField`，错误统一 `AppToast tone="error"`，
  模型连接测试 / 目录选择等异步动作有进行中态，完成页「一切就绪」渐进入场。
- 第一步不再有「界面语言」选择器（`general.language` 是死字段，选它不生效）。

## 3. 窗口间状态机

```
托盘 ──▶ 提示条 / 交互窗 / 设置 / 引导
提示条 ──点击──▶ 交互窗（贴右缘滑出）
提示条 ──面板──▶ 小窗对话 ──展开──▶ 交互窗（会话迁移）
```

- **规则**：迷你窗与交互窗同屏互斥（同一会话同一时间只在一个窗口）。
- **全局快捷键**：唤出 / 隐藏交互窗 `Alt+Space`（可在设置中改）。
  - 实现状态（v0.6.0）：**已落地**（`main/hotkey.ts`）—— 启动时注册、退出前注销、
    设置改绑即时生效（幂等：值未变不重复注册，避免闪断窗口）、注册失败会把真实原因回传设置页。
  - **冲突是预期路径**：`Alt+Space` 是 Windows 的系统窗口菜单键，常被系统占用。
    此时设置页显示「被占用」并给出可操作建议，用户改绑即可 —— 不静默失败，也不报成 bug。
  - 格式校验拒绝**不含修饰键的裸按键**（如 `F5`）：那会吞掉全局按键，属于用户误操作。

## 4. 通知与反馈

- **系统通知**：分类完成（点击打开对应文件夹）、课前提醒、引导提醒。
- **窗口内 Toast**：错误提示（LLM 失败、MCP 断开、分类失败）与可恢复操作入口。

## 5. 视觉方向与设计令牌（SSOT）

方向：**Apple 风格深色玻璃** —— 分层填充 + 大圆角 + 柔和阴影 + 弹性缓动，品牌极光渐变作唯一点缀。

### 5.1 设计令牌

全部定义在 `apps/desktop/src/renderer/shared/theme.css`，五个窗口共用（各自 `main.ts` 里 import）。

| 类别 | 令牌 | 值 / 说明 |
|---|---|---|
| 品牌 | `--aurora-green` / `--aurora-blue` / `--aurora-gradient` | `#38d196` / `#5684ff`，渐变呼应 Aurora；**全局唯一点缀色** |
| 底色 | `--bg-base` / `--bg-raised` / `--bg-overlay` / `--bg-glass` | `#0b0c0f` / `#141519` / `rgba(20,21,25,.78)` / `.72` |
| 分层填充 | `--fill-1` / `--fill-2` / `--fill-3` | 悬浮层 → 卡片 → 悬停/选中，逐层变亮 |
| 分隔线 | `--border-subtle` / `--border-strong` | `rgba(255,255,255,.07)` / `.14` |
| 文本 | `--text-primary` / `--text-secondary` / `--text-muted` | `#f5f5f7` / `#a1a1aa` / `#6e6e73` |
| 状态 | `--status-idle` / `-running` / `-unread` / `-error` / `-ok` | 灰 / 蓝 / 橙 / 红 / 绿，**五个窗口语义一致** |
| 字体 | `--font-ui` / `--font-display` / `--font-mono` | 系统 UI 栈（`SF Pro Text` → `Segoe UI Variable` → 雅黑）；标题用 display 字体 + `-0.01em` |
| 字号 | `--text-xs(11)` / `sm(12.5)` / `base(13.5)` / `lg(15)` / `xl(20)` / `2xl(26)` | 正文基准 `--text-base`；`--leading-tight(1.25)` / `normal(1.5)` |
| 字重 | `--weight-regular(400)` / `medium(500)` / `semibold(600)` | |
| 圆角 | `--radius-xs(6)` / `sm(10)` / `md(14)` / `lg(20)` / `xl(28)` / `pill(999)` | |
| 间距 | `--space-1..6`（4/8/12/16/24/32） | 8px 栅格 |
| 材质 | `--blur-thin(12)` / `--blur(24)` / `--blur-thick(40)` | `.glass` = 模糊 + `saturate(180%)` + 1px 内描边 + `--shadow-2`；不支持 `backdrop-filter` 时回落实色 |
| 阴影 | `--shadow-1` / `-2` / `-3` | 越靠上层越散越深 |
| 缓动 | `--ease-standard` / `--ease-spring` | 颜色/透明度用 standard；出现/展开用 spring（快起慢收、不回弹） |
| 时长 | `--dur-fast(140)` / `base(220)` / `slow(340)`；`--transition-fast|base` | 后者是前者的组合别名 |

**硬约束**：既有令牌名（`--bg-*`、`--border-*`、`--text-*`、`--status-*`、`--radius-sm|md|lg`、
`--space-1..6`、`--transition-fast|base`、`--font-ui|mono`、`--aurora-gradient`）**只增不删**——
它们散落在各窗口的 scoped 样式里，删名字不会报错，只会静默掉样式。

### 5.2 动效规范

- 工具类（`theme.css` 全局）：`.interactive`（悬停上浮 1px + `--shadow-2`，按下 `scale(.98)`）、
  `.anim-rise`（`translateY(6px)` 淡入）、`.anim-pop`（`scale(.96)` 弹入）。
- Vue `<Transition>` 预设：`.sheet-*`（右侧滑入，提示条面板 / 抽屉）、`.rise-*`（气泡与列表项）、
  `.fade-*`（内容切换）、`.collapse-*`（`max-height` 展开，工具卡片 / 折叠区块）。
- **硬约定**：所有过渡/动画必须走 `--transition-*` 或 `--dur-*` + `--ease-*`，不写死时长；
  `prefers-reduced-motion: reduce` 下把三个时长压到 1ms 并让位移动画立刻落位（theme.css 里已全局兜底）。
- 页面骨架统一用 `.page` / `.page-title` / `.page-sub`；页面需要不同内边距时在自己的 scoped 样式里覆盖
  （scoped 选择器优先级更高，覆盖安全）。

### 5.3 截图核对工具（AURORA_CAPTURE）

- `AURORA_CAPTURE=<目录> pnpm dev`：把五个窗口、提示条两态、设置页 7 页、思考等级参数面板、
  3 条 DOM 探针场景（常规页字段门控 / 模式页 ClassRoom / 切换模式后门控）+ 1 条真实写盘场景
  与 2 张提示条收尾图共 **18 张 PNG**（构成以 `report.json` 的实际条目为准）后退出；
  （交互窗与小窗的截图还各带一条自动滚底探针；设置页另有「AI 模型 - 思考等级」一条探针场景
  ——它**会**额外出 `settings-llm-params.png`——以及「电脑操控」页的门控探针，后者不额外出图）；
  `AURORA_CAPTURE_WINDOWS=edge-bar,settings` 只截指定窗口（逗号分隔）。
  仅开发态生效；与 `AURORA_SMOKE` 同时设置时**截图优先**（自测不会执行）。
  进程退出码：0 = 全部成功，1 = 一张图都没写出，2 = 有探针 `pass === false`。
- **userData 会自动隔离（必须，不是可选）**：探针里有两条会**写真实配置**（切到 Work 模式、
  翻 `classification.autoMove`），所以 `AURORA_CAPTURE` 存在时应用就把 userData 指向临时目录并在退出时删除
  —— 与 `AURORA_SMOKE` 走同一条隔离路径（`index.ts` 的 `isolatedRun`）。
  也就是说截图跑在**全新默认配置**上，不会碰用户自己的 `%APPDATA%/Aurora`。
- 产物：`<目录>/<窗口或场景>.png` 与 `report.json`（每张图的渲染层探针结果）。
- 三类动作（`main/capture.ts` 的 `CaptureTarget`）：`prepare`（主进程侧准备）、
  `act`（在渲染层派发真实 `mouseenter` / `click`）、`check`（截图后取一份可判定结果）。
  面板是渲染层 hover 驱动的，**只从主进程改窗口尺寸会拍到空面板**，所以提示条展开态走 `act`。
- 探针返回 `pass: boolean` 时按 `PASS` / `FAIL` 写日志（前缀与 `AURORA_SMOKE_RESULT` 一致）：
  - 提示条面板：`elementFromPoint` 命中测试 4 个按钮 + 是否落在窗口宽度内 + 窗口宽 ≤ 228px
    （面板自身的 220px 只作为信息回报 `styled`）；
  - 点击竖条后的窗口状态（`chat` 可见、`mini-chat` 不可见、`primary === 'chat'`）；
  - **对话自动滚底 + 回到最新胶囊**（`CHAT_AUTO_SCROLL_SCRIPT`，交互窗与小窗各一条）：向 `.messages`
    追加一个 1600px、`flex-shrink: 0` 的探针节点（等价于「内容变高」），断言 `.thread` 的
    `scrollHeight - scrollTop - clientHeight ≤ 4`；同时要求「内容确实比窗口高」（`maxScroll ≥ 200`）——
    否则探针没撑开内容时 `distance === 0` 会假 PASS（空 div 会被 flex 压扁，必须禁掉收缩）。
    随后把 `scrollTop` 归零模拟用户上滚，断言「↓ 回到最新」胶囊出现且**落在容器可视区内**
    （`position: sticky` 在"内容按溢出渲染"的交互窗里是否真吸得住，只有真实 DOM 能回答）。
    探针放在 `check`（截图**之后**执行），不污染 PNG，执行完移除节点、归位滚动；注：探针节点是
    **合成内容**，只验证滚动机制本身，不需要配置模型；
  - 设置页门控：`data-field` / `data-empty` 计数（死字段 `general.language` 必须为 0、
    非 ClassRoom 模式下 `modes.classroom.*` 必须为 0、提示条详情跟随开关）；
  - **电脑操控页门控**（`SETTINGS_AGENT_FIELDS_SCRIPT`）：读 `agent.tools.enabled` 复选框的**实际状态**，
    开着时要求终端 / 文件 / 打开三栏的详情字段都在（`terminalFields/filesFields/openFields > 0`
    且 `data-empty` 为空），关着时只要求总开关本身仍在 —— 否则用户再也开不回来；
  - **思考等级**（`SETTINGS_LLM_EFFORT_CHECK`）：造一个 provider → 展开「高级参数与连接测试」→
    断言 `[data-field$=".reasoningEffort"]` 与 `[data-field$=".temperature"]` 都在、且下拉的
    `select.value` 等于配置里写的 `'high'`（覆盖「写盘 → 回读 → 渲染」整条链路）。
- 截图前会等 `WindowManager.whenLoaded()`（`ensure()` 的加载是 fire-and-forget，
  不等会截到 0 字节空图），并对空图重试；连续空图直接判失败，不产出空文件。
- 设置页深链：`main/window-manager.ts` 的 `ensure(name, query)` / `reload(name, query)`
  给 URL / `loadFile` 传 query，仅截图场景使用，正常启动不带 query。
