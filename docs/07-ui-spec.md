# 07 · 窗口与交互设计规格

状态：`已定稿`（v1 基线；**BetaV2** 起设计语言与窗口口径更新，见 §2.3 / §2.5 / §5）

## 1. 设计原则

- **轻**：默认占用最小（提示条），完整窗口按需展开。
- **顺**：所有展开 / 收起带过渡动画，不突兀。
- **聚**：视觉统一（深色主题为主、跟随系统）、状态指示一致（AI 状态灯全局同色语义）。
- **隐**：提示条与引导窗口无任务栏图标；**主界面与设置窗口显示任务栏图标**（可最小化，
  2026-09 前端重构起对齐主流 Agent Desktop），托盘仍是统一管理入口；所有窗口可一键隐藏
  （「关闭」= 隐藏，仅托盘「退出」真正退出）。
- **拖**：能拖的窗口由**显式清单**决定（`DRAGGABLE_WINDOWS = ['chat', 'settings', 'onboarding']`，
  `useWindowDrag` composable），模板统一用 `:class="dragClass"` 挂 `drag-region`，
  不靠各窗自己记得加 class；拖动条**可见高度 ≥ 32px**（够用户抓住）。
  右侧提示条**刻意不可拖**——它 `focusable: false`，几何完全由主进程推导（见 §2.2）。

## 2. 窗口规格

> 小节编号**只增不重排**：§2.1（AI 服务窗）与 §2.4（小 AI 交互窗 / Mini Chat）两节已随窗口删除移除，
> 其余编号保持稳定，避免打断既有交叉引用。

### 2.2 右侧提示条（Edge Bar）

- **形态**：贴屏幕右缘竖条（**收起态 8×200px**），悬停展开为面板（**展开态窗口 228px 宽 × 工作区高 - 48px**），置顶。
- **内容**：AI 状态灯 + 当前模式 + 最近消息 + 今日课程 + 系统状态（展开态）。
- **行为**：
  - 悬停 → 展开面板；面板含「打开主界面 / 设置 / 隐藏提示条」**三个**入口（**BetaV2**：「打开对话窗口」更名「打开主界面」）；
  - 点击竖条 → 打开 / 聚焦主界面（**BetaV2**：chat 已是居中主界面，不再「贴右缘滑出」，见 §2.3）；这是提示条的主操作，**展开态下竖条仍是有效点击目标**；
  - 移开鼠标 → 面板收起，窗口尺寸收回竖条尺寸（8×200），不留不可见的遮挡区域。
  - 实现状态（前端刷新轮）：
    - 两态由 IPC **`window:setEdgeBarExpanded`** 驱动（渲染层 → preload → `WindowManager.setEdgeBarExpanded`），
      主进程执行 `setBounds`：**右缘固定 + 垂直中心固定**，宽度 8 ↔ 228px、高度 200px ↔ 工作区高 - 48px；
      几何算术在 `main/edge-bar-geometry.ts`（纯函数 + 单测）。
    - **展开态必须跟着长高**：面板内容（状态 / 模式 / 最近消息 / 今日课程 / 系统状态 + 3 个操作按钮）
      在 200px 里装不下，只加宽会得到「看得到面板却点不到按钮」——实测按钮落在 y=278~410、窗口仅 202px 高，
      `elementFromPoint` 全部落空。`AURORA_CAPTURE` 的 DOM 探针会把这条钉住（见 §5.3）。
    - 渲染层悬停延迟 120ms 展开（先加宽窗口再显示面板，避免面板被 8px 窗口裁掉）、
      移开延迟 220ms 收起（等面板退出动画结束再收窗口）；窗口隐藏时主进程会把尺寸复位，
      避免下次显示残留展开态尺寸。
    - **面板内容区 220px，`right: 8px`**：面板不能贴到窗口最右缘（否则会盖住 8px 竖条，
      「展开态竖条仍可点」就不成立、竖条的悬停反馈也看不见）。228 = 220 面板 + 8 竖条。
      面板内是 5 个 `--fill-1` 分组卡片（统一用卡片不用分隔线）+ 底部 3 个 `AppButton`；
      「快速对话」卡 `flex: 1 1 auto` 吸收剩余高度，中部不留大片空白。
    - **快速对话（2026-09 起，取代只读的「最近消息」卡）**：面板里直接输入、与 Aurora 对话
      （数据仍是 `sessionId = 'quick'`，独立 `useChat('edge-bar','quick')` 实例）。
      - **可聚焦跟随展开**：本窗创建时 `focusable: false`（悬停不抢焦点），但那样输入框
        拿不到键盘焦点——主进程 `setEdgeBarExpanded` 在**展开时 `setFocusable(true)`、
        收起时 `setFocusable(false)` + blur**（`window-manager.ts`；setFocusable 不主动取焦，
        只有用户真点输入框才激活窗口）。
      - **输入框聚焦期间移开鼠标不收起**（正在打字）：`onPointerLeave` 查 `quickFocused`，
        失焦时若鼠标已离开窗口则补走收起链（`watch(quickFocused)`）。
      - 消息列表正序贴底、流式三点动画；空态提示「直接输入，与 Aurora 快速对话」。
      - **实时刷新（2026-09 起）**：面板展开时强制重拉快速会话**最近 20 条**并贴底；
        展开期间每 5 分钟自动刷新一次（流式响应中跳过，避免搅乱正在输出的回复）。
        窗口常驻，只在挂载时水合一次的话主界面侧的新消息永远进不来；上下文侧由内核的
        quick 会话滑动窗口兜底（docs/06 §4），旧消息不进 LLM、只留在界面历史。
    - 提示条**只持久化 y**：宽高由折叠态决定、水平位置恒定贴右缘，跨启动不复用持久化宽高
      （否则收起态会继承展开态的 228px 宽）。
  - 未实现：`可穿透性可配`（尚未接入 `setIgnoreMouseEvents`）——提示条仍然整块接收鼠标事件。
  - **刻意不可拖动（本轮明确）**：提示条的 `BrowserWindow` 是 `focusable: false`
    （`window-manager.ts`），宽高与位置完全由「工作区右缘 + 垂直居中 + 折叠态」推导
    （`window-manager.ts` 里也写明了「不参与用户拖动」）。允许拖动会让**两套几何来源打架**：
    用户拖出来的位置会被下一次展开 / 收起复位，观感是「拖了没用还乱跳」。
    因此它不挂 `drag-region`，也不在 `DRAGGABLE_WINDOWS` 清单里（见 §1）。
- **可配置**：显示 / 隐藏、透明度、静默时段。
  - 实现状态（v0.6.0）：`general.edgeBar.opacity` 保存后即时应用（`setOpacity`，范围 0.2–1.0）；
    `general.edgeBar.quietHours` 由 `main/edge-bar-scheduler.ts` 每 30s 判定，**仅控制提示条自身显隐**，
    与 `advanced.quietHours`（控制主动打扰：课前提醒 / 敏感工具确认）职责分离、互不影响。
    可见性只在状态翻转时切换，避免反复 show 把用户刚手动隐藏的提示条拉回来。
    设置页里这两项跟着 `general.edgeBar.enabled` 显示（见 docs/08 §6.1）。

### 2.3 主界面（Chat Window）

> **BetaV2**：交互窗（chat）升级为常驻**主界面**，本节规格按新口径改写；下文沿用「chat / 交互窗」
> 指同一窗口（窗口名不变，`WindowState.primary` 语义不变）。

- **主界面规格（BetaV2）**：默认 **1120×720**（min 940×600）、resizable、**alwaysOnTop 关闭**（false）、
  place **center**；`frame: false`、几何持久化、关闭 = 隐藏 均不变（见 docs/02 §2.2）。
  旧口径（约 420×640、alwaysOnTop 开启）自本轮废弃。
- **三栏布局（2026-09 重构起）**：`sidebar(240px, 可折叠) | main(1fr) | context(264px, 可折叠)`，
  栏间用分隔而非悬浮卡片；主区消息与 composer 居中排布（内容列最大宽 860px），
  对齐主流 Agent Desktop 的阅读动线：
  - **左栏**：品牌行（单色 mark + Aurora）→「新对话」按钮（`data-action="chat.new-session"`）→
    固定顶置项「快速对话」（`data-field="chat.quick-item"`，点击切到 quick 会话；
    **可直接输入的快速对话入口在桌面提示条面板**，见 §2.2）→
    会话列表（`data-field="chat.session-list"`，单行标题 + 相对时间）→
    **「已归档 · N」分组**（`data-field="chat.archive-group"`，默认收起；展开后的列表是
    `data-field="chat.archive-list"`）→
    底部：模式徽章 + 右栏开关（`data-field="chat.right-panel-toggle"`）+ 设置齿轮。
  - **左栏底部固定项「任务」（v15 新增）**：`data-field="chat.jobs-entry"`，
    落在 `aside.nav` 网格的**第二行**（= SessionNav 自带页脚那一行**之下**、左栏的最底部），
    不随会话列表滚动；角标是本会话的任务条数（内部 `.jobs-count`，有在跑的用强调色）。
    点击展开 / 收起右栏的「任务」面板（`aria-expanded` 跟 `jobsOpen`）。
    **它与「子代理」的位置刻意相反**：「子代理」（`chat.subagent-item`）是左栏**顶部**固定项
    （在「快速对话」下面、会话列表之上，因为它把**主区**切走），而「任务」只切换**右栏**里一块面板，
    放底部才不会与"切主区"的那组争夺视线。
    （v19 起左栏**顶部固定项**共三个：`chat.quick-item` 快速对话 / `chat.subagent-item` 子代理 /
    `chat.auto-item` 自动化 —— 后两个切的是**主区**，见下条「子代理独立页面」与「自动化页规格」。）
  - **会话归档（2026-09 新增）**：会话项 hover 时右侧浮出一枚「归档」图标钮
    （`data-action="chat.archive-session"`，单击即归档、**可逆、不弹确认**）；
    归档后该会话从主列表移入底部「已归档 · N」分组，**仍可点开继续对话**，此时主区头部给一条
    「已归档 · 取消归档」提示（`data-field="chat.archived-banner"`）。
    归档状态写在**会话文件自身**（`sessions/<id>.json` 的 `meta.archived`，见 06 §4），
    **不进 config.json**、归档本身不改 `CONFIG_VERSION`（当前版本见 08 §2）。
    已知边界：`chat:sessions` 目前**没有推送通道**，归档只在发出请求的那个窗口即时生效，
    其它窗口（提示条用 quick 会话）要等下次拉列表才看得到；quick / settings 两个伪会话
    不出现在列表里，因此也不参与归档。
  - **主区**：头部拖拽区（侧栏开关 + 状态灯 + 会话标题 + 未配置徽章 + 清空（图标钮）+
    **Windows 式窗口按钮**：`最小化`（`data-caption-btn="minimize"`，真最小化进任务栏）与
    `关闭`（`data-caption-btn="close"`，= 隐藏窗口）；双击头部拖动区切换最大化）→
    MessageList → composer。**「模型 / 思考等级」两个下拉移入 composer 工具行**
    （对齐 ChatGPT / Claude Desktop；`data-field="chat.model"` / `chat.reasoningEffort` 锚点不变，
    仅位置变化），「收起」文字按钮由 caption「关闭」按钮取代（隐藏语义不变）。
  - **composer（2026-09 输入框重做，见下方「输入框规格」）**：单张悬浮卡
    （附件 chips → textarea → 工具行 → 上下文详解条）；工具行 = 权限模式 + 模型下拉 +
    思考等级下拉 +（右侧）麦克风 + 停止 / 发送；旧「会话：xxx · 可调用 Skill 与 MCP 工具」
    常驻 meta 文案移除，仅保存操作的瞬时提示保留。
  - **右栏「任务」面板（v15 新增，`data-field="chat.jobs"`；面板自身 `chat.job-panel`）**：
    停在右栏**最上方、`ContextPanel` 之上**（右栏是两行网格：任务面板按内容高度、上下文栏占满
    剩余高度；面板收起时上下文栏独占整列）。位置比上下文信息更靠前，是因为"长任务停了"是
    **要用户动手**的状态。默认展开（`jobsOpen = true`），由左栏底部入口按钮切换；
    收起时整块**不渲染**（`v-if`），条数仍由入口按钮的角标兜住。
    每条 job（`chat.job-item`）显示：状态徽标（`排队中` / `进行中` / `已暂停` / `已完成` /
    `出错` / `已取消`）、本地时间（当天只给时刻，跨天带月日）、任务原文（单行省略、完整原文在
    `title` 里）、`第 round/maxRounds 轮`、`token usedTokens/maxTotalTokens`
    （`maxTotalTokens = 0` 显示「不限」，**不显示成 `0/0`**）、`已自动续 N 轮`（`autoContinued > 0`
    才显示）、暂停原因、待办（最多 5 条，`completed` 划掉，余量折成一行「还有 N 项」）、
    最近 3 条已完成步骤（`第 N 轮 · 工具名 · 成功/失败`）、`error` 文本（仅 `error` 状态）。
    两颗按钮：**「继续」`chat.job-resume` 只在 `paused` 时渲染**（其余状态点了没有意义），
    「取消」`chat.job-cancel` 在 `running` / `paused` / `queued` 时渲染 —— 与 `chat:cancelJob`
    的受理范围同一口径（已结束的没有可取消的东西）。
    暂停原因文案（`max-rounds`「已达到轮次上限，已暂停」/ `budget`「已达到 token 预算，已暂停」/
    `aborted`「已取消」）**与 composer 那条提示共用同一份**（`useChat` 导出的
    `PENDING_REASON_TEXT`），两处不许各写一套措辞。
    空态（本会话没有任务）时**整块仍然渲染**并显示「暂无任务」—— 否则用户不知道这里会显示什么；
    样式照文件备份卡空态（`.snapshot-empty`）的克制口径，类名是面板自己的 `.job-empty`，
    **刻意不给 `data-empty` 锚点**：设置页探针把 `data-empty` 当作"门控空状态"白名单来断言，
    这里的空态不是门控行为，多一个锚点只会把探针口径搅浑。
    面板整体按内容增高，条目多了在自己的列表里滚（`max-height: 300px`），不把上下文栏挤没。
  - **右栏（模式感知上下文栏）**：栏内（任务面板之下）第一张是任务清单卡
    （当前会话最后一次 `todo_write` 的结构化清单，
    无清单不渲染）；classroom = 课堂状态卡（`data-field="context.classisland-card"`，
    非 classisland provider 时整卡不渲染；内含 `context.classisland-onclass` 徽章、
    `context.classisland-current` / `context.classisland-next` 两行、无数据时
    `context.classisland-empty`）+ 今日课程卡（`data-field="context.lesson-card"`）+
    分类流水（紧凑）+ 感知文件夹打开；work = 工作目录卡（打开 + 前往设置）+ 办公提示卡；
    通用 = **会话项目卡（v17 新增，`data-field="context.session-project-card"`；无可绑定项目
    或拿不到会话 id 时整卡不渲染；内含下拉 `data-field="context.session-project"`）**
    —— 本会话绑定 `projects.list` 里的一项（选择即调 `chat:setSessionProject`，空串 =
    清除绑定回显「未指定（跟随全局）」），未绑定时缺省目录 / 项目边界 / AGENTS.md / auto 档
    边界回落全局当前项目（`06 §5.1`）
    + **当前项目卡（v13 新增，`data-field="context.project-card"`；无当前项目时整卡不渲染）**
    （**文件备份卡已于 v0.2.4 移除**：回滚 / 清理 UI 整体迁入设置页「智能与工具」页的
    文件备份区组，主界面右栏不再展示快照列表 —— 见下文「文件备份」与 06 §11.8。）
    + 系统状态卡（时间 / 电量 / 网络 / 前台应用）。**非当前模式的功能一律不渲染**。
    课堂状态卡的数据来自桥接的快照（`05 §3.4 v3`）：上课中才显示当前科目与时段，
    下节课显示「科目 · 起–止」；字段缺失按「暂无课堂状态」降级，不编造。
    当前项目卡（`06 §5.1`）显示项目名与项目根；根可用时「打开文件夹」走 `app:openPath` 的
    **新 kind `project`**（打开的是**当前项目根**，与 `kind: 'workspace'` 不同 —— 后者打开的是
    生效工作目录：回落链（当前项目根 > 激活模式工作目录（Work）> `agent.tools.workspaceDir` > 主目录，06 §5.1），配了项目时
    两者都会打开项目根，无项目时 `workspace` 打开主目录或配置的工作目录）；根不可用（目录被删 / 不可读）时
    显示 `class="badge error"` 的「项目目录不可用」徽标与「去设置里重新选择目录」，
    **不渲染「打开文件夹」**（点了只会弹系统错误，反而让人以为路径没问题）。
    "目录是否存在"由主进程经 `project:status` 回传（渲染进程没有文件系统能力），
    取不到状态时按「可用」处理 —— 显示假警报比不显示更糟。
- **麦克风（STT，BetaV2）**：composer 的麦克风按钮（`data-field="chat.mic"`）门控口径同 TTS：
  `stt.enabled && stt.active` 指向 baseUrl / model 齐全的 provider 才渲染按钮，
  **否则连按钮都不渲染**（不是 disabled）；录音走 MediaRecorder → `stt:transcribe`，
  录音态用 theme.css 的 `pulse-ring` 扩散环动画。
- **完整对话**：Markdown、代码高亮、流式渲染、工具执行卡片（可展开查看细节）、附件与文件拖拽发送。
  - 实现状态（v0.6.0）：**附件拖拽已落地** —— 路径解析在 preload（`webUtils.getPathForFile`，Electron 32+ 已移除 `File.path`），
    文本提取复用分类管线的 utilityProcess 提取器（单文件上限 8000 字、单条消息最多 5 个）；提取失败的附件会在上下文里**如实标注「未读取」**，不假装已读。
- **尺寸（BetaV2）**：见本节开头的主界面规格（1120×720 / min 940×600 / 居中）；位置记忆与多会话能力不变。
  - 实现状态（v0.6.0）：**多会话列表已落地**（`chat:sessions` 列表 + `chat:newSession` 新建 + 切换）。
    标题取首条用户消息前 24 字（不额外调用模型生成标题），按最后消息时间倒序；
    空会话显示为「新会话」且不落空文件（首条消息才创建）。窗口默认会话仍为 `main`，老数据继续可读。
    （BetaV2：会话列表渲染于左栏。）
- **联动**：由提示条（面板按钮或点击竖条）与托盘菜单「显示主界面」打开；失焦默认不自动隐藏（可配置）。
- **视觉（前端刷新轮；BetaV2 起头部按上方三栏布局的主区头部为准）**：容器 `.glass` + `--radius-lg`；
  用户消息右对齐胶囊气泡、助手消息左对齐纯文本块；代码块独立卡片 + hover 显隐「复制」
  （在 `markdown.ts` 已转义的白名单 HTML 上补结构，不改其输出契约）。
  工具卡片是「折叠头行（工具名 + `StatusDot` + 状态 + 耗时）+ `.collapse-*` 展开体」；
  耗时是**渲染层观察到的本次调用耗时**，历史水合出来的卡片不伪造耗时。
  流式追加只在末尾加光标（父级 `::after`），不对每条 `delta` 重放进场动画。
- **朗读 / 停止（TTS，v0.8.0）**：每条**助手**消息正文下方有一枚「朗读 / 停止」按钮，
  点它把该条回复的纯文本交给「设置 → 语音」里选中的 TTS provider 合成并播放，再点一次即停止
  （合成中与朗读中共用同一枚按钮，按下即取消在途合成 / 播放）。
  朗读状态（`合成中` / `朗读中` / `失败`）与消息正文**同行展示**（贴着正文末尾的状态文本，
  不新起浮层、不遮挡「复制」按钮）；失败只就地提示一句原因，**不影响对话与流式回复**（见 06 §13.5）。
  `tts.autoRead = true` 时**回复结束后自动朗读**最后一条助手消息，与手动点按钮走完全相同的合成 / 取消路径。
  **没有可用 TTS provider（`tts.enabled = false`，或 `tts.active` 为空 / 指向不存在的条目）时整个按钮不出现**
  —— 不占位、不留 `disabled` 态（与「思考 / 模型」下拉的「不隐藏只禁用」策略不同：朗读是增强功能，
  未配置时连修复路径都不必指）。协议与失败降级见 06 §13，联网范围见 11 §4。
- **任务清单与子代理卡（2026-09 新增）**：`todo_write` 工具卡渲染为**结构化清单卡**
  （`data-field="chat.todo-card"`：状态圈（待办 ○ / 进行中 ◐ / 完成 ✓）+ 条目 + 进度摘要），
  展开体仍是原始参数 / 结果；`task` 工具卡渲染为**子代理卡**（`data-field="chat.task-card"`：
  任务简述 + 运行态 + 步骤数 + 展开后的**实时运行轨迹**：进度条 + 步骤时间线 + 报告）。
  右栏顶部新增「任务清单」卡（数据 = 当前会话消息流里最后一次 `todo_write` 的入参，
  随流式实时更新；无清单时不渲染）。
- **子代理独立页面（2026-09 新增，见 `06 §19`）**：左栏固定项「子代理」
  （`data-field="chat.subagent-item"`，角标 `data-field="chat.subagent-count"` 显示本会话运行数，
  有在跑的用强调色）把**主区**切到子代理页面（`data-field="chat.subagent-page"`）。
  - 页面内容：概览条（运行数 / 进行中数 / 工具调用总数，`data-field="chat.subagent-summary"`）+
    每次运行一张卡（`data-field="chat.subagent-run"`：状态点 + 任务简述 +
    **权限徽章**（`data-field="chat.subagent-perm"`：`write` = 「可读写」强调色 / 缺省「只读」中性色，
    见 `06 §19.2`）+ 状态 + 工具调用数 + 相对时间与耗时 + 「查看对话」折叠
    （点 `›`，锚点 `data-action="chat.subagent-conversation-toggle"`）+
    **两个缩放级别**（不同时出现，避免同一段内容说两遍）：折叠 = 紧凑轨迹（`SubagentTrace`：
    进度条 + 步骤时间线 + 报告 `data-field="chat.subagent-report"`），
    展开 = 独立对话视图（见下条））；无运行时给空状态说明。
  - **独立对话视图**（2026-09，`SubagentConversation.vue`，根锚点 `data-field="chat.subagent-conversation"`，
    见 `06 §19.3`）：展开后渲染 `SubagentSnapshot.messages` —— 顶部一行是权限徽章与
    可用工具清单（`可用工具：read_file、grep…`），随后是**主代理气泡**（任务指令）→
    **子代理正文**（最后一条有正文的标「最终报告」）→ 其中的工具调用各成一行
    （语义图标 + 工具名 + 结果摘要，点开看参数与结果正文）；超限时底部如实标出「中间已省略」。
    与 `task` 工具卡的展开体**共用同一个组件**。
  - **只读口径**：对话视图里**没有输入框 / 发送键 / 任何干预入口**（子代理的生死跟着父请求，
    要中止就中止父请求，这句提示写在视图底部）。capture 探针按「容器内不存在 `textarea` /
    `input` / `contenteditable`」来钉这条口径 —— 注释不算证据。
  - **它不是会话**：`view` 是 `chat/App.vue` 的独立状态
    （`'chat' | 'subagents' | 'automations'`，第三项见下文「自动化页规格」），
    切过去**不动** `sessionId`、不触发水合、不清空消息；输入区与右栏照旧，随时可切回
    （页头「回到对话」按钮 `data-action="chat.subagent-back"`，左栏点任意会话也会切回）。
  - 数据来源：`useChat().subagentRuns` —— 实时 `subagent` 事件（本会话内存）与
    消息流里 `task` 工具卡的持久化快照（重启后仍可回看）按 `callId` 合并，实时那份优先。
- **工具卡的生命周期动效（2026-09）**：正在运行的卡叠一层低对比度扫光；状态翻到终态时
  状态点弹一下（一次性，靠 `settledIds` 只加一次类）；卡片进场上浮淡入并按序错开
  （`TransitionGroup name="tool"`，第 2/3/4 张依次 +40/80/120ms）。
- **思考块的流式动效（2026-09，2026-09 输入框轮加强）**：流式期间块头扫光 +
  **公转指示点**（`.think-orbit.spin`，复用全局 `aurora-spin`）+ 尾部光标，块头显示已思考秒数；
  **块内自动翻滚**：新的思考增量到达时把 `.thinking-text` 跟到最新一行，用 `requestAnimationFrame`
  合并同一帧内的多次请求（增量密集时不再每条 delta 同步读写布局），块首次展开也补滚一次；
  用户在块内**手动上滚**到离底超过 24px 即暂停跟随（与消息区的 `useStickToBottom` 同一阈值口径
  但状态独立，绝不拽动消息区），自己滚回底部即恢复。
  该轮正文一开始写（`thinkingTargetId` 清空）时块头文案从「思考中…」翻成「已深度思考」、
  秒数与动效一起撤掉，**块保持展开**；整个请求结束才收起为摘要行。
- **思考块的视觉（2026-09 视觉减负轮）**：从「外层 `--fill-1` 卡 + 内层 `--fill-2` 文本框」的
  **盒中盒**改成**左侧竖轨的旁注**（`border-left: 2px solid` + 8px 缩进 + 无底色无内框，
  流式期间竖轨转强调色）。原来的双层灰与紧跟其后的工具卡、正文叠成一片
  （用户反馈的「思考与工具展示挤在一起」）；现在正文与思考之间留 `--space-3`，
  工具卡之间留 `--space-2`，一屏能分清「思考 → 回答 → 工具」三段。
- **Agent 正文的流式动效（2026-09）**：正文**逐字出现**（增量直达，见 06 §16.2）+
  末尾光标 + **尾部湿润边缘**（`.thread.streaming` 下对最后一条助手消息的 `.md` 加底部渐隐遮罩，
  流式结束即摘掉）。
  **刻意不做逐字打字机**：正文是 `v-html` 渲染的 markdown，Vue 对 `v-html` 不做 DOM diff，
  按节点挂进场动画会在每个 chunk 上重放（快速流式时整块停在半透明），按帧做真打字机则要
  每帧重解析 markdown —— 遮罩方案既有「还在写」的观感，又零额外开销。
- **展开 / 收起的高度动画（2026-09 修复「动画乱跳」）**：`.collapse-*` 不再拿写死的
  `max-height: 70vh` 当动画终点 —— 它的内容实测只有约 140px（工具卡展开体）与 220px
  （思考块正文），终点远大于内容时 `min(内容高, max-height)` 会让**全部可见位移挤在时间轴的
  一小段里**（展开表现为「飞快长满再空转」，收起表现为「先空转、末尾猛缩」），观感就是乱跳。
  改为**实测高度**动画：终点不再是 `70vh`，而是 `var(--collapse-h, 70vh)` —— 由
  `renderer/shared/composables/useCollapseTransition.ts` 的 `enter` / `before-leave`
  钩子把 `el.scrollHeight` 写进该变量。
  ⚠️ **进入方向必须挂 `@enter`，绝不能挂 `@before-enter`**（这条踩过）：Vue 的 `beforeEnter`
  在元素**插入文档之前**调用（`runtime-core` 的 `mountElement` 里
  `transition.beforeEnter(el)` 先于 `hostInsert(el, …)`），游离元素的 `scrollHeight` 恒为 0，
  写进去就是 `--collapse-h: 0px` —— 起点与终点同为 0，整个 250ms 高度都不动
  （只剩 opacity 在变、`overflow: hidden` 把内容挡住），过渡类一摘再瞬跳到内容高度，
  比原来的曲线**更糟**。`enter` 由 post-render effect 在插入**之后**调用、且 `-enter-to`
  还没挂上（类交换在 `nextFrame` 的双 rAF 里），所以在这里写下的终点会被完整地过渡到；
  `before-leave` 时元素仍在文档里，本来就准。
  另有一道防护：元素尚未布局（父级 `display:none`、窗口隐藏）时 `scrollHeight` 为 0，
  此时**不写**变量、让缺省的 `70vh` 兜底 —— 把终点钉成 0 是比不写更坏的结果。
  ⚠️ **量之前必须把钳制临时摘掉**（这条最容易写错）：过渡类自己带着 `max-height: 0`，
  而展开体常常是 `display: flex; flex-direction: column` 的列容器 —— 容器高度被钳住时，
  flex 会压缩**可收缩的子项**：工具卡里唯一的滚动容器子项 `.tool-args`（`overflow: auto`）
  的自动最小尺寸解析为 **0**，于是它从 79px 被压到 13px，量出来比真实内容矮 66px
  （2026-09-26 实测 401 vs 467）。这个偏差在整个过渡期间**恒定不变**，所以
  「逐帧轮询直到连续两帧相等」也追不到它 —— 松钳（Vue 摘掉过渡类）那一刻真实高度才出现。
  因此 `useCollapseTransition` 在量之前把元素的内联 `max-height` 临时设成 `none`、量完立刻还原
  （同一个 task 内完成、中间不落帧，视觉不闪）。与之配套的根修是 `.tool-args { flex: 0 0 auto }`：
  折叠动画要的是**裁剪**，不是让内容在动画途中重新排版（顺带消掉「内容被压成一细条、
  过渡结束再弹回」的次级跳动）。`before-leave` 时布局已稳定，量一次就够。
  之所以用 CSS 变量而不是直接动画 `height`：不必在结束后把内联高度复位成 `auto`
  （`after-enter` 一旦早于过渡结束触发，元素会当场跳到全高，比原来的曲线更跳），
  而**没挂钩子的使用点自动回落 `70vh`**（与改前行为逐字一致），因此可以一处一处接线，
  不存在「CSS 改了、模板还没接」的破损中间态。时长仍是 `--dur-base`(250ms)。
  ⚠️ **它不适用于「动画期间内容还在长」的折叠体**（这条是 2026-09-26 复核指出、我先前写反了的）：
  终点是**动画开始那一刻**量到的高度，而 `.collapse-*-active` 带 `overflow: hidden`，
  后长出来的部分会被裁掉、过渡类一摘再补跳一次。所以两类折叠体**只淡入（`name="fade"`）、
  不做高度动画**：
  ① **内容正在持续生长** —— 思考块的**自动展开恰好发生在流式进行中**（每个回合都会命中），
  因此它按 `thinkingTargetId === message.id` 切成 `fade`；
  ② **折叠体自己带 `max-height` / 本身就是滚动容器** —— 子代理页的「任务指令」
  （`.run-prompt` 自己有 `max-height: 160px; overflow-y: auto`，可见高度由它自身决定；
  真要给它做高度动画，就得先摘掉它自己的 `max-height` 才能量到真实内容高，
  动画会冲到 600px 级再弹回 160），已改为 `fade`。
  当前真正走实测高度动画的是 **工具卡展开体** 与 **历史思考块的手动点开**（内容已稳定）；
  工具的已知残余：卡片 `running` 时若正好有子代理步骤到达，动画期间会长出一行（约 19px）
  并在末尾补跳 —— 不为此改成淡入，因为绝大多数展开发生在内容已稳定的卡片上，
  而 19px 的一行位移不可见（改成淡入反而丢掉这个场景的高度动效）；
  **不要改回固定 `max-height`**（见 §5.2 硬约定）。流式结束时思考块自动收起为摘要行
  （上文 §2.3「思考块的流式动效」）走的也是这条动画，不再是瞬抽 220px。
  另外 `.tool-card` 的进场错位延迟（第 2/3/4 张 +40/80/120ms）此前挂在
  `.tools > .tool-card:nth-child(n)` 上、**常驻生效**，会误伤卡片上任何别的过渡 ——
  已收窄到只挂在 `.tool-enter-active` / `.tool-leave-active` 下。
- **图标体系（2026-09）**：渲染层图标统一走 [lucide](https://lucide.dev)（`lucide-vue-next`），
  经 `renderer/shared/icons.ts` **具名再导出**（只登记用到的，Vite 摇树）；
  工具卡按工具名给语义图标（`renderer/shared/toolIcons.ts`，未知工具退到扳手、MCP 退到拼图）；
  新图标不再手写内联 SVG（唯一例外：代码块「复制」按钮的图标 —— 它由字符串注入
  `v-html` 输出里，用不了组件，路径与 lucide 保持一致）。
- **消息区跟随最新（v0.6.0 修复「对话不会自动拉到底」）**：滚动容器是窗口自己的 `.thread`，
  跟随逻辑在 `MessageList.vue` + `composables/useStickToBottom.ts`：
  - **默认跟随**：新消息 / 流式增量 / 历史水合导致内容变高时自动滚到底。
    信号有**三条**、合并到"每帧最多滚一次"：`MutationObserver` 看消息 DOM 的增删与文本变更
    （流式是原地改 `content`，工具卡片是插节点），`ResizeObserver` 看内容根与滚动容器的尺寸
    （窗口从隐藏到显示、用户缩放），**`transitionend`（2026-09 新增）** 看高度过渡的结束
    —— 展开 / 收起工具卡与思考块走的是 CSS `height` 过渡，它在「DOM 变更那一帧」之后**继续**长高或缩短，
    而上面两条信号都收不到（内容根带 `min-height: 100%`，`ResizeObserver` 本就不可靠，见下一条），
    此前的结果就是「动画还在动、滚动条已经停在半路」。
    过渡结束后若仍处于跟随态就再补一帧滚底，并以「连续两帧 `scrollHeight` 不变」自终止
    （帧数上限 `MAX_SETTLE_FRAMES = 24`，约 400ms @60fps —— 只是兜底，正常路径靠自终止停）；
  - **用户接管**：用户主动上滚、离底部超过 24px 即**暂停跟随**（否则回看历史时会被流式输出拽走），
    此时右下角浮出「↓ 回到最新」胶囊；点它或**自己发一条消息**（发完必然想看到回复）恢复跟随。
  - 判定与滚动都只读 `scrollHeight / scrollTop / clientHeight`，不引入新依赖，也不改 props / 插槽契约。
  - **为什么不只用 `ResizeObserver`**：交互窗的 `.thread` 是定高 flex 列，`MessageList` 根节点带
    `min-height: 100%`，内容超过一屏后根节点的盒子被钉在一屏高、多出来的部分按**溢出**渲染 ——
    元素尺寸不再变化，只监听尺寸会漏掉每一次流式增量（若 `.thread` 是普通块级容器，其根节点会跟着内容长高，
    尺寸变化本身就能被观察到，因此不会复现这个问题）。`AURORA_CAPTURE` 的自动滚底探针正是靠"内容确实比窗口高"这条守卫把这个坑钉住的。
- **关闭 / 最小化（2026-09 重构起）**：标题栏右侧是 Windows 式窗口按钮（`WindowCaption.vue`）——
  「最小化」真最小化（进任务栏，可从任务栏恢复），「关闭」= **直接隐藏窗口**；
  正在进行的流式回复**不会**因此中止（`hide()` 不触碰 `chat:abort`，见 02 §2.2「关闭 = 隐藏」）。
  双击头部拖动区 = 切换最大化（最大化时几何不落盘，还原后按原尺寸恢复）。
- **侧栏（2026-09 重构起）**：三栏布局的左栏（240px，可折叠）常驻承载品牌行 / 新对话 /
  「快速对话」固定顶置项（点击切 quick 会话）/ 会话列表 / 底部操作；
  快速会话（`sessionId = 'quick'`）与提示条面板的快速对话共用同一份数据 ——
  旧的「标题栏『历史』按钮展开双栏侧栏」口径废弃。
- **思考等级（本轮）**：输入区（`.composer-bar`）含「思考等级」下拉
  （`data-field="chat.reasoningEffort"`，`ThinkingLevelSelect.vue`），读写**当前生效 provider** 的
  `llm.providers.<active>.reasoningEffort`：`auto` = **不下发**该参数（映射成 `undefined`），
  `low` / `medium` / `high` 原样透传。**设置页与对话窗输入区两处入口写的是同一个字段，没有第二份来源**，
  也不做按会话覆盖；改完对**下一次**请求生效，无需重启。
  无可用 provider 时控件**不隐藏**，而是 `disabled` + 提示「先在「设置 → AI 模型」里配置并选中一个模型」
  ——用户抱怨的正是「找不到按钮」，在没有模型时彻底藏起来会让同一个抱怨复现；
  禁用态至少是「找得到但用不了」，并且指向了修复路径。
- **模型选择（本轮）**：输入区（`.composer-bar`）与「思考」并排还有一个「模型」下拉
  （`data-field="chat.model"`，`ModelPickerSelect.vue`），选项来自**当前生效 provider** 的
  `llm.providers.<active>.modelList`；选中即把该 provider 的 `llm.providers.<active>.model`
  改成这一项，下一次请求生效（主进程每次请求都重新读 `settings.get().llm`，无需重启）。
  **模型页与对话窗读写的是同一份列表**：模型页维护 `modelList`、对话窗从同一份列表里选，
  没有第二份来源。当前 `model` 不在列表里（或列表为空）时，下拉把当前值显示为
  「`<model>`（不在列表中）」而不是悄悄替换成别的模型。
  无可用 provider 时**与思考等级一样**「不隐藏、只 `disabled`」，并给出同一句去设置页的提示。
  `.composer-bar` 的控件顺序（2026-09 输入框重做后）：**权限模式** → **模型** → **思考**
  → 弹性空隙 → 瞬时提示 → 麦克风 → 停止 / 发送；
  空间不足（右栏展开 / 窗口缩窄）时先让 `meta` / 提示文本让位（隐藏或
  `overflow: hidden` + `min-width: 0`），**发送按钮绝不能被挤出行外**
  （标题栏拖动区的改动不要碰输入区，见 §1 与 §5.3 的拖动探针）。
- **窗口拖动（本轮）**：标题栏 `.head` 走统一的 `useWindowDrag('chat')`（`:class="dragClass"`），
  按钮区挂 `noDragClass`；详见 §1 与 §5.3 的拖动探针。
### 输入框规格（2026-09 输入框重做）

目标是对齐主流 Agent Desktop（ChatGPT / Claude / Cursor 类）的输入动线：卡内自底向上依次是
**输入区 → 工具行 → 上下文详解条**，三段用发丝线分隔，整体仍是单张悬浮卡（`.composer-box`），
宽度与消息列同轴（860px 中轴）。

- **输入区**：`<textarea>` 自动增高（`rows=1`，高度由 `autoGrow()` 按 `scrollHeight` 钉住，
  1 行起步、**200px 上限**后内部滚动）。CSS 上刻意**不设** `min/max-height` 与 `resize`：
  手动拖动高度会与自动增高互相打架，结果是「发完消息输入框还保持着刚拖出来的高度」。
  `Enter` 发送、`Shift + Enter` 换行（`Ctrl + Enter` 与 `Enter` 等价，兼容老习惯）；
  占位文案随流式状态切换（回复中提示「可先继续输入；回复结束后按 Enter 发送」）。
  流式中按 `Enter` 会给一句 2 秒自灭的提示（发送按钮同时是 disabled 的，两处口径一致）——
  `useChat.send` 在流式期间直接返回，若不提示就是「敲了 Enter 没反应也没说法」。
- **工具行**（左 → 右）：**权限模式** + 模型下拉 + 思考等级下拉 + 弹性空隙 +（右侧）
  瞬时提示 + 麦克风（STT，门控口径不变）+ 停止（流式中）+ 发送。
  压缩顺序与旧口径一致：先让瞬时提示让位，两个下拉可收缩到 72px，**发送按钮绝不能被挤出卡外**。
- **权限模式**（`ComposerPermissionSelect.vue`，`data-field="chat.permission"`）：
  **三档**（v13，语义见 06 §11.2）—— **只读**（`readonly`，`data-field="chat.permission-mode-readonly"`）＝
  写文件 / 执行命令类工具**根本不注册**给模型（设置页摘要写「只读模式：仅注册只读工具（不含写入与命令）」）；
  **变更前确认**（`confirm`，默认，`data-field="chat.permission-confirm"`）＝ 敏感工具
  （写文件 / 执行命令 / MCP 工具 / 改设置）执行前弹确认卡；**完全权限**
  （`auto`，`data-field="chat.permission-full"`）＝ 有项目时**只在项目根之内**免确认、越界仍询问，
  无项目时与从前一样不再逐次询问、只写日志留痕。
  写盘时**同时写两个字段**（`agent.permissionMode` = 选中档，`advanced.confirmSensitiveTools` =
  `档位 !== 'auto'`）：后者是老开关，两者由 `resolvePermissionMode()` 合成生效档位，
  分开写会出现「界面选 confirm、实际生效 auto」的错位。与设置页「智能与工具」页读写的
  **是同一份配置**，没有第二份来源。
  三个细节是有意的：
  - 放宽权限的档位（完全权限）用**警示色常驻**（不是一闪而过的 toast）——闸门开着这件事必须一直看得见；
  - **放宽是两段式**：点「完全权限」只把该项翻成「再点一次确认」，第二下才提交 ——
    一个误点不该把闸门摘掉；**收紧（只读 / 变更前确认）单击即生效**（收紧不需要摩擦）。
    AI 的 `set_setting` 对 `agent.permissionMode` 与 `advanced.confirmSensitiveTools`
    两条路径**一律拒绝**（见 06 §12.2）。
  - 设置页那一处入口（`AdvancedPage.vue`，`data-field="agent.permissionMode"`）是**三档单选**、
    同样走"同时写两个字段"的镜像规则；两处交互强度目前略有差异（对话窗对**放宽**更严），
    因为对话窗是随手可点的位置。
- **确认卡片**（`SensitiveToolCard.vue`）：三颗按钮 —— 「允许一次」、
  **「本会话都允许」**（`data-action="chat.confirm-always"`，v13：本次放行 + 本会话内同名工具
  不再询问）、「拒绝」。倒计时（≤15s 转错误色）与拒绝路径不变；
  会话级授权表在**内核**（`KernelAgentHost`，不落盘），`'always'` 只由用户点按钮产生，
  拒绝永远不会被升级成会话级授权（见 06 §11.2）。
- **斜杠命令**（`SlashCommandMenu.vue` + `slashCommands.ts`，`data-field="chat.slash-menu"`）：
  输入框内容整串匹配 `/xxx`（无空格换行）时，在输入卡**上方**弹出候选浮层，分
  **命令** / **技能** 两组：
  - 命令（选中**即执行**）：`/new` 新对话、`/clear` 清空消息区、`/stop` 停止回复
    （仅流式中出现）、`/subagents` 子代理页、`/settings` 打开设置；
  - 技能（选中**只补全**成 `/技能名 `，焦点留在输入框）：来自 `skills:list` 里 `enabled`
    的技能，与内核 `parseExplicitInvocation` 认的 `/` 前缀调用是同一套（06 §6）。
  键盘：`↑` / `↓` 移动高亮、`Enter` / `Tab` 确认、`Esc` 关闭（输入内容一变即重新打开）。
  浮层打开时 `Enter` **属于浮层**，不会把半截命令发出去。过滤是**前缀匹配**而非模糊匹配：
  命令名都很短，模糊匹配会让 `/s` 命中一堆不相干的技能，反而要多按几次方向键。
  `@` 提及、MCP 工具补全**仍未实现**（技能与命令之外没有第二类候选）。
- **上下文详解条**（`ComposerContextBar.vue`，`data-field="chat.context"`）：卡片最底部一条细状态栏，
  折叠态显示 `上下文 <已用> / <窗口> <进度条> <百分比>` + 本会话累计，最近一轮有缓存命中量时
  紧凑文案里一并带出命中 token 数（探针锚点 `chat.context-usage` 的文案因此含「缓存命中」）。
  点开在上方弹出明细（`data-field="chat.context-detail"`：最近一轮输入 / 输出、缓存命中、
  本会话累计、上下文窗口、消息条数与字符数、当前模型）。
  - **分子**：最近一轮的 `promptTokens`（`usage` 事件，06 §16.2）——就是这一轮真实送进模型的上下文长度；
  - **缓存命中**：最近一轮的缓存命中 token 数（`cachedTokens`，06 §21.4）——来自 provider 回传的
    `prompt_tokens_details.cached_tokens`（OpenAI 形态）或 `prompt_cache_hit_tokens`（DeepSeek 形态），
    明细里另给出占比（命中量 / 本轮的 `promptTokens`）。**两者都缺就整项不显示** ——
    既不写「缓存命中 0」也不占位：那会把「provider 没回传」显示成「一条都没命中」，两者必须可区分；
  - **分母**：`llm.providers.<active>.contextWindow`（v11 新增，08 §1）。**0 = 未知**，此时
    不显示进度条与百分比，明细里给出去设置页填的路径——不编造分母；
  - provider 没回传用量时整条显示「暂无用量数据」，明细里说明原因，**绝不拿字符数换算冒充 token**；
  - 占用 ≥60% 转警示色、≥85% 转错误色（在输入框上就能看出该开新会话了）。
- **长任务暂停提示（v15）**：`useChat` 收到带 `pendingReason` 的 `done` 事件时，把它译成一句话
  （`max-rounds`「已达到轮次上限，已暂停」/ `budget`「已达到 token 预算，已暂停」/
  `aborted`「已取消」），以 `tone="warn"` 的 `AppToast` 挂在 composer 下方。
  **挂在 composer 里而不是消息滚动区**：滚动区的浮层会被自动滚底推走，而这条恰恰是"要你点继续"。
  下一次发送 / 清空 / 切会话时由 `useChat` 复位（`pendingNotice`）；动作入口是右栏「任务」面板里
  那条 job 的「继续」，这条提示只负责把"为什么停了"说清楚。
  文案与面板的「暂停原因」**共用同一份**（`PENDING_REASON_TEXT`），两处措辞不许漂移。
- **三个浮层的锚点与层级（2026-09 修复「浮层互相遮挡」）**：斜杠命令、权限下拉、上下文详解卡
  三者**一律锚在输入卡 `.composer-box` 上**（`.perm` / `.ctx` 都是 `position: static`，
  浮层用 `left/right: 0` + `bottom: calc(100% + 6px)` + `z-index: var(--z-flyout)`），
  于是它们永远浮在**整张输入卡上方**、**绝不覆盖工具行**。
  这条是有具体事故的：此前 `.ctx-card` 锚在工具行**下方**的 `.ctx` 上向上弹，
  底边落在工具行内部，把权限 / 模型 / 思考 / 麦克风 / 停止 / 发送**整条盖住且不可点**
  （`z-index: 20` 在同一个层叠上下文里压住了全是 `z-index: auto` 的工具行内容）。
  三者**互斥**：打开任一个自动关闭其余两个（`chat/App.vue` 持有唯一的 `openFlyout`，三个浮层受控）；
  三者都支持**点击外部**与 `Esc` 关闭（此前斜杠浮层只能靠「输入内容变化」或 `Esc` 关闭，
  于是输入 `/` 之后再点权限钮，权限下拉会被 z-index 更高的斜杠浮层压住）。
  新增浮层时必须复用这套锚点与令牌，**不要新写 z-index 魔数**（层级令牌见 §5.1）。
- **`data-field` 锚点清单（capture 探针依赖）**：`chat.permission` / `chat.permission-menu` /
  `chat.permission-confirm` / `chat.permission-full` / `chat.permission-mode-readonly`（v13 三档；
  `-full` 仍是 auto 档的唯一锚点，不要给它换名）/ `chat.slash-menu` / `chat.slash-<name>` /
  `chat.context` / `chat.context-usage` / `chat.context-cache` / `chat.context-detail`；
  旧的 `chat.model` / `chat.reasoningEffort` / `chat.mic` 位置变了但锚点不变。
  左栏归档（2026-09-26 新增）：`chat.archive-group` / `chat.archive-toggle` / `chat.archive-list` /
  `chat.archived-banner`，动作锚点 `data-action="chat.archive-session"` / `"chat.unarchive-session"`
  / `"chat.unarchive-current"`（最后一个在已归档提示条上）。
  会话项与 hover 归档钮是**同一行里的两个兄弟 `<button>`**（`.nav-row` 包 `.nav-item` + `.row-action`）：
  按钮不能嵌套（无效 HTML，浏览器会把内层甩出去），`.nav-item` 与 `data-field="chat.session-list"`
  的契约因此原样保留。空态「还没有会话」只在**两份列表都空**时出现（全部归档时主列表为空、
  归档分组仍在，此时提示「还没有会话」自相矛盾）。
  项目（v13 新增）：右栏卡锚点 `context.project-card`（警示徽标 `context.project-unavailable`）；
  设置页「通用 → 项目」区组的字段锚点沿用**配置路径原文** —— `projects.name` / `projects.root` /
  `projects.current`（「设为当前」按钮，当前项显示「已启用」并 disabled）/ `projects.repick`
  （「重新选择目录」，仅根不可用的当前项目行）/ `projects.remove`（删除）/ `projects.add`（添加项目，
  走 `project:pickDirectory` 弹系统目录选择框），列表为空时是 `data-empty="projects.list"`。
  钉住它们的探针场景见 §5.3：`chat-project-card.png`（先建出真实项目根 → `settings:update` 把
  `projects.current` 指过去 → 断言右栏卡**恰好一张**、文本含项目名与根目录、**不是**警示态 →
  收尾还原成无项目再断言卡消失）；设置页 general 页探针则数 `[data-field^="projects."]`
  并要求「空态或至少一行」，`data-empty` 白名单为 `general.edgeBar` 与 `projects.list`。
  文件备份（v14 新增；**v0.2.4 起从主界面右栏迁入设置页「智能与工具」页**，共享组件
  `shared/components/SnapshotList.vue`）：列表锚点 `agent.snapshot-list`，每条记录一个
  `data-field="agent.snapshot-restore"` 的「回滚」按钮（**两段式**：第一下变「确认回滚？」，
  第二下才执行），另有 `data-field="agent.snapshot-prune"` 的「立即清理」与
  `data-action="agent.snapshot-refresh"` 的手动刷新（清理无 sessionId 时按「全部会话」执行）。
  capture 探针场景相应改为：主界面断言快照卡**不存在**（`chat-snapshot-card-removed`）、
  设置页断言列表在（`settings-snapshot-list`）。
  设置页「智能与工具」页的文件备份区组字段锚点沿用配置路径原文：`agent.snapshots.enabled` /
  `agent.snapshots.keepPerFile` / `agent.snapshots.maxSnapshotBytes` / `agent.snapshots.totalBudgetBytes`
  （关掉开关时三个数字字段换成 `data-empty="agent.snapshots"`）。
  钉住它们的探针场景见 §5.3：`chat-snapshot-card-removed.png` / `settings-snapshot-list.png`（prepare 走**真实快照端口**种一份快照并
  `flush()` 落索引 → reload 让卡片重新水合 → act 点一次「回滚」→ 断言卡恰好一张、
  至少一条记录、来源译成「写文件」、按钮停在待确认文案）。
  任务面板（v15 新增）：右栏容器 `chat.jobs`（`jobsOpen` 为 false 时整块不渲染）、面板自身
  `chat.job-panel`、每条 `chat.job-item`、「继续」`chat.job-resume`（**仅 `paused` 时渲染**）、
  「取消」`chat.job-cancel`、左栏入口 `chat.jobs-entry`（角标是它内部的 `.jobs-count`，
  不另设锚点）；面板空态**没有** `data-empty` 锚点（见上文右栏条目的理由）。
  钉住它们的探针场景见 §5.3：`chat-job-panel.png`。
  钉住它们的探针场景见 §5.3：`chat-composer-slash.png`（浮层 + 权限钮文案 + 上下文条 +
  **textarea 自动增高** 28px→170px→28px，含 200px 上限与「上限后改为内部滚动」）、
  `chat-composer-permission.png`（权限下拉三档：只读 / 变更前确认 / 完全权限三项都在；
  点「完全权限」一次只翻成「再点一次确认」、**配置一动不动**（`settings:get` 回报 `agent.permissionMode`
  仍是 `confirm`）、再收起下拉）、
  `chat-permission-readonly.png`（v13 只读档：切到 `readonly` 后触发器与菜单项都显示「只读」、
  `settings:get` 回报 `permissionMode === 'readonly'`，收尾还原成 `confirm` 并断言触发器回到
  「变更前确认」）、
  `chat-composer-flyouts.png`（浮层互斥 + 几何不相交 + 发送键 `elementFromPoint` 命中自己）、
  `chat-archive.png`（归档分组）；
  以及 `chat-stream.png`（**唯一一条 DOM 级端到端**：capture 在跑这一段前竖起本地桩 LLM 并把
  `llm.active` 指向它 → 探针把提示词写进 textarea、点发送 → 断言助手气泡里出现了桩服务的回复文本、
  且上下文条显示**真实 token**（`512 / 128k`）与**缓存命中片段**（`缓存命中 512（100%）`，
  `data-field="chat.context-cache"`）而不是「暂无用量数据」。
  为什么这条必须有：`AURORA_SMOKE` 的脚本跑在引导窗里，只能从**事件层**断言流式
  （06 §16.2 的 text / usage 事件），读不到对话窗 DOM；而两个模式互斥 ——
  「事件对了、界面没画出来」这类问题只有这里能抓到），
  以及 `chat-stream-burst.png`（高密度流式回归，见 §5.3 该条）。

> **踩坑记（写 capture 探针必看）**：`capture.ts` 里的探针是**模板字面量字符串**，
> 字符串里写 `'\n'` 会给注入脚本留一个**真换行**（→ 被注入的 JS 在字符串里断行 →
> `SyntaxError` → Electron 只回一句「Script failed to execute」，报告里看不出是哪里错了）。
> 要表达换行用 `String.fromCharCode(10)`，别用转义。另外探针**先取 DOM 计数、再做会改 DOM 的操作**：
> 自动增高那段会把输入框清空，一清空斜杠浮层就自行关闭，在那之后再查 `chat.slash-*` 恒为 0
> （这两条都真踩过）。

> **未实现**：`@` 提及浮层；附件按钮（选文件）—— 附件仍只走拖拽（`webUtils.getPathForFile`），
> 原因是渲染进程拿不到文件系统能力，加选择器要新开一条 IPC + 主进程 `dialog.showOpenDialog`。

> **新增（v0.4.0 / v0.5.0）**：
> - **分类流水**（`ClassificationLedger.vue`）：可折叠区块，默认收起，展示
>   时间 / 文件 / 状态 / 科目 · 来源 · 置信 · 依据，支持「改到其他科目」「打开所在文件夹」「清空流水」；
>   交互窗与设置页共用同一组件（分别给 20 / 50 条）。
> - **敏感工具确认卡片**（`SensitiveToolCard.vue`）：挂在交互窗顶部，展示工具名与参数摘要、
>   到 `expiresAt` 的倒计时与进度条（≤15s 变红），「拒绝 / 允许一次」回执。
>   主进程在推送确认请求时会**主动显示并聚焦交互窗**，避免交互窗未打开时确认不可见而静默超时。

### 自动化页规格（v19 新增，docs/13 §11）

- **入口**：左栏顶部固定项「自动化」（`data-field="chat.auto-item"`，紧接「子代理」之下），
  点击把**主区**切到自动化页（`view = 'automations'`）。它与子代理页**同构** ——
  **不是会话**：切过去不动 `sessionId`、不触发水合、不清空消息，输入区与右栏照旧，
  靠页头「返回对话」按钮（`data-action="automation-back"`）或左栏点任意会话切回。
  `auto-` 前缀的自动化会话**不进左栏会话列表**（渲染层过滤，与 `center-` 会话同款口径，
  见 docs/13 §7），回看那次对话的唯一入口是历史弹窗。
- **骨架**：根锚点 `data-field="automation.page"`，列表容器 `data-field="automation.list"`；
  顶部工具行 = 双 tab「Agent Mode」（`data-field="automation.tab-agent"`）/
  「Normal Mode」（`automation.tab-normal`）+ 右侧「历史」（`data-action="automation.history"`）
  与「新建」（`data-action="automation.new"`）+ 「返回对话」图标钮（`data-action="automation-back"`）。
  **列表按当前 tab 过滤**（Agent tab 只列 Agent 定义）；
  **页头与两个 tab 同行**（`flex-wrap: wrap`，窄窗口下动作组整体折行而不是重叠），
  页头不再有整句副标题 —— 说明改挂在标题右侧的说明标记上（悬停出 `AppTooltip`，§5.4）。
- **卡片**（`automation.item-<id>`）：启停开关（`data-field="automation.toggle"`，写定义的 `enabled`）+
  名称 + 模式徽章（**带语义图标**：Agent = 机器人、Normal = 闪电；内置项用中性「内置」徽章）+
  触发描述（「每天 08:30」「距上课 ≤ 5 分钟」，由触发器参数生成，各 kind 的语义见 docs/13 §4，
  **行首带该条件的图标**）+ 摘要（Agent Mode 显示任务指令单行截断、Normal Mode 显示**图标胶囊**：
  每个操作一枚「图标 + 短名」胶囊，如「系统通知」「打开「数学」」—— 不再把多个操作拼成一整句）+
  右侧三枚图标钮：立即运行 / 编辑 / 删除（`data-action="automation.delete"`），三枚都有悬浮提示。
  **删除是两段式**：首次点击只翻成「再点一次确认删除」（按钮转红底红边、提示文案同步切换），
  **3 秒内**再点才真删（超时自动复位）—— 删掉的是用户攒下的定义，一个误点不该抹掉它。
  卡片挂 `.interactive`（悬停上浮 + 抬阴影 + 边界提亮），禁用态只降透明度、不隐藏。
- **内置区（仅 Normal tab）**：容器 `data-field="automation.builtin"`，区组头 = 图标 + 「内置」+ 说明标记；
  两条 ClassRoom 内置自动化（课前提醒 / 课前打开科目文件夹）带「内置」徽章，开关锚点
  `data-field="automation.builtin-toggle"`，**直接写既有配置**
  （`modes.classroom.preClassReminder` / `preClassOpenFolder`，走既有 `settings:update`），
  **没有编辑 / 删除**；「沿用 ClassRoom 的设置（提前分钟数 / 勿扰时段），在「设置 → 模式」里调整」
  这句**不再占版面**，改挂在区组头的说明标记上（悬停即见）。语义与迁移口径见 docs/13 §6。
- **编辑器弹窗**（仓库**首个 Modal**，`data-field="automation.editor"`）：遮罩用 `--overlay-scrim` +
  `z-index: var(--z-popover)`，弹窗底色用 **`--bg-overlay`** —— 它是**弹层专用令牌**，
  写 `--surface-1` 这类不存在的名字会解析成透明、页面内容直接透进来；
  宽 `min(640px, calc(100vw - 48px))`。字段自上而下（**全部走「左标签 / 右控件」两列网格**：
  标签列 92px、控件列 `minmax(0, 1fr)`，两侧各在自己的格子里，长标签换行也不会挤压控件 —— §5.4）：
  名称 → 模式单选（两个 `.mode-option`，各带图标与一行小字）→
  **触发条件 = 图标磁贴网格**（容器 `data-field="automation.trigger-kind"` 持 `role="radiogroup"`；
  每个磁贴带 `[data-kind]` + `role="radio"`，图标在上、名称在下，`repeat(auto-fill, minmax(140px, 1fr))`；
  选项来自后端 catalog，当前 **7 类**：每天定时 / 固定间隔 / 距上课不足 N 分钟 / 上课时 /
  距下课不足 N 分钟 / 下课时 / 下节课是指定科目；**每类的 description 挂在磁贴的悬浮提示上**，
  选中项的说明另以一行小字出现在磁贴下方）+
  该触发器的**动态字段**（由 `AutomationFieldInput.vue` 按描述符渲染：`text` / `time` 原生输入、
  `number` 定宽数字框、`weekdays` **星期胶囊多选**（全不选 = 每天）、`select` **分段胶囊**；
  **编辑器内不再出现原生 `<select>`**。描述符形状见 docs/13 §4.3）→
  Agent Mode 的「任务指令」textarea，或 Normal Mode 的**操作组件列表**
  （每项 `data-field="automation.action-<索引>"`：行首序号圆点 + **组件胶囊组**（图标 + 组件名，
  点一下换组件；`available: false` 的组件**不出现**而不是 disabled）+ 移除钮 + 参数网格；
  「添加操作」`data-action="automation.add-action"`，**上限 10 个**，到顶即 disabled，
  区组头右侧显示 `n/10`）。
  底部「取消」（`data-action="automation.editor-cancel"`）/「保存」；三条关闭路径 ——
  点遮罩（`@click.self`，点弹窗内部不关）、「取消」、**Esc**（组件在 `window` 上挂 `keydown`
  监听：编辑器优先，其次是历史弹窗；历史里正展开某条运行回放时，第一下 Esc 只收回放 ——
  与「一层一层退」的直觉一致）。
- **历史弹窗**（`data-field="automation.history-panel"`，关闭钮
  `data-action="automation.history-close"`）：列表容器 `data-field="automation.history-list"`，
  每条 = **状态图标**（进行中旋转 / 成功对勾 / 失败叉 / 已中断停止，与状态文案同色）
  + **触发时间 + 归属自动化名 + 状态 + 用时**；
  同样**按当前 tab 过滤**（Agent tab 只列 Agent 运行）。**Agent 记录可点开**（行加 `.clickable`）
  → 弹窗内展开**对话回放**（`.detail-message`，「任务」/「Agent」两侧气泡，数据经既有
  `chat:history` 按 `sessionId` 读取，见 docs/13 §7；会话被删则显示「会话已被删除或还没有消息」）；
  **Normal 记录不可点、没有详情层** —— 产品口径是「只显示触发时间与状态，不展示具体操作」。
  `.run-item` / `.run-time` / `.clickable` / `.detail-message` 四个类名是 capture 探针契约，别改名。
- **门控口径**：catalog 里 `available: false` 的操作组件（如未配置桥接时的 ClassIsland 提醒）
  **在选项里不出现**，不是 `disabled` —— 与麦克风 / 朗读按钮同款口径。
- **推送订阅**：`automation:changed` → 重拉列表；`automation:historyChanged` → 历史弹窗开着时重拉
  （通道清单见 docs/13 §9）。

### 2.5 设置窗口

- 单窗口分栏（**BetaV2**：8 页合并为 **6 页**；2026-09 重构起条目为图标 + 单行文字；v0.2.0 起新增 **Aurora Center** 页共 **7 页**）：侧栏按四组排列 —— **基础**（常规 `general` /
  模式 `modes`）／**智能**（AI 模型 `llm` / 语音 `voice` / 智能与工具 `agent`）／**连接**（Aurora Center `center`）／
  **系统**（高级 `advanced`）；`SETTINGS_PAGE_IDS = ['general','modes','llm','voice','agent','center','advanced']`。
  当前项用分层填充 + 左侧**强调色**指示条（不再用品牌渐变）。合并口径：Skill 与 MCP 并入 `agent` 页、
  STT 并入 `voice` 页、生图模型并入 `llm` 页、勿扰时段并入 `general` 页（全局 + 提示条两组同区）；
  旧深链兼容映射：`?page=tts→voice`、`?page=skills|mcp→agent`。
- **窗口按钮（2026-09 重构起）**：本窗无系统标题栏（`frame: false`），侧栏品牌行右侧提供
  与主界面同款的 Windows 式「最小化 / 关闭」按钮（`WindowCaption.vue`，
  `data-caption-btn="minimize" | "close"`）；「关闭」= **隐藏窗口**（Esc 等效；
  不退出应用，退出只走托盘菜单），「最小化」真最小化进任务栏。
  侧栏导航条目改为**图标 + 单行文字**（不再带两行说明文案）。
- **可拖动区域（本轮补齐）**：侧栏顶部（`.sidebar-drag` 透明条 + 品牌行 `.brand`，
  `.brand` 增加 `min-height: 36px`）与内容区顶部的拖动带（`.content-drag`，高 10px）**都可以拖**；
  关闭按钮与其它交互元素挂 `no-drag`（`theme.css` 另有一条按标签兜底的规则）。
  此前只有侧栏里约 22–30px 的品牌行能拖，正是「有些能拖有些不行」最直接的原因；
  现在侧栏空白处、品牌行、内容区顶部三处都能按住拖动窗口。
- **Aurora Center 页（v0.2.0；v0.2.1 起配对方式改为账号登录，docs/12 §7）**：`CenterPage.vue` 三张卡：
  - **连接设置**（`CenterConnectionSection.vue`）：`center.enabled` / `center.serverUrl` /
    `center.displayName` / **登录账号**（`data-field="center.account"`，回显 `center.account`）+
    **登录密码**（`data-field="center.password"`，write-only，永不落配置）+
    「登录并连接」按钮（走 `center:login` IPC，主进程调 `/api/client/login` 换令牌写入
    `center.token` 凭据链路并自动启用连接；页面按 `settings.hasSecret('center.token')`
    展示「已登录 / 未登录」）、`center.clientId` 只读展示（首次登录时由主进程生成）；
    手填配对令牌的旧入口已移除（服务器端兼容路径保留，见 docs/12 §3）；
  - **远程控制许可**（`CenterPermissionsSection.vue`）：`center.allowRemoteSession` /
    `center.allowRemoteConfig` / `center.allowFileTransfer` 三个开关 + `center.maxFileMb`
    （1–512，保存时夹取）——这些是 Center 远程操作本机的**最终闸门**（docs/12 §7）；
  - **连接状态**（`CenterStatusSection.vue`，`data-field="center.status"`）：轮询
    `center:status`（5s），状态点 connected 绿 / connecting 黄 / error 红（附 `lastError`）/
    disabled 灰。
  - **保存链路分工**：卡片字段整卡走 `settings:update`（`{ center: {...} }` 顶层浅合并，
    不含 `tokenEnc` / `clientId`；主进程合并时运行期剥 `tokenEnc` 防构造 patch 洗密文）；
    令牌由 `center:login` 在主进程内直写凭据链路，页面不经手。
- 模式页（**BetaV2**）：三模式卡片选择 + 引导状态；**只渲染当前模式的配置内容** ——
  ClassRoom 区组不变；Work 已实装，提供工作目录 `workspaceDir`（`data-field="modes.work.workspaceDir"`）
  等配置；Code 仍显示「暂无可配置项」空状态。
  **v19 起页首另有「自动化」区组**（不跟模式门控，三模式都显示）：只有自动化总开关
  （`data-field="automations.enabled"`，常显），说明文案指向主界面左栏的「自动化」入口 ——
  自动化的定义与历史都在那边管理，设置页只放这一道闸门（见 docs/13 §2.2 / docs/08 §1）。
- **ClassIsland 提醒通道与课前提前分钟数（2026-09 新增，见 `05 §3.4 v3`）**：
  ClassRoom →「课程表与课前提醒」分组内新增两项，门控口径：
  - `modes.classroom.preClassLeadMinutes`（数字输入 1–30，默认 5）——门控与
    `preClassReminder` / `preClassOpenFolder` 同款（`schedule.lessons.length > 0`，
    否则整组替换为 `data-empty="modes.classroom.preClassReminder"`）；
  - 提醒通道区（`data-field="settings.classisland-notify-test"`）——门控
    `schedule.provider === 'classisland'`，内含状态回显 `settings.classisland-notify-state`
    与「发送测试提醒」按钮 `settings.classisland-notify-test-button`，结果 Toast 为
    `settings.classisland-notify-result`。按钮调用 `classisland:notify`（固定 `channel: 'custom'`），
    成功显示耗时并刷新回显，失败就地给出原因（插件不是 v3 / 命令通道关闭 / 超时）。
    **渲染层发送时只传字面量对象**：Vue 的 `reactive` / `ref` 代理过不了结构化克隆（`AGENTS.md`）。
- **AI 模型页（本轮重写；BetaV2 增补）**：**目录行列表 + 一次只开一张编辑卡**（`editingId` 单值），不再平铺所有卡片——
  行上只有名称 + 凭据状态 badge（`凭据已保存` / `缺少凭据`）+ 是否默认 + 行操作
  （`编辑` / `设为默认` / `删除`）；当前默认行带 `.accent` 描边与左侧 3px 强调色指示条，行 hover 用 `--fill-2`；
  `删除` 是危险操作，先就地弹确认条（`data-action="confirm-remove-provider"`）再生效；
  列表为空时是 `data-empty="llm.providers"` 的空状态卡。BetaV2 新增：「显示思考过程」开关
  （`data-field="general.chat.showThinking"`）与**生图模型区组**（enabled / active / provider 编辑，
  锚点 `imagegen.*`）。详情见 docs/08 §5。
- **语音页（v0.8.0 新增；BetaV2 扩为 TTS + STT 双区组）**：页面提供 TTS 区组 —— 总开关（`tts.enabled`）、
  默认 TTS 模型（`tts.active`）、自动朗读（`tts.autoRead`）、截断上限（`tts.maxChars`），
  以及 TTS provider 列表的**增 / 改 / 删 + 「试听」**；BetaV2 新增 **STT 区组**（`stt.enabled` / `stt.active` /
  provider 的 baseUrl / model / apiKey / language，锚点 `stt.*`）。
  凭据行的展示规则与 AI 模型页一致（只显示「凭据已保存 / 缺少凭据」，密文不进渲染层）。
  字段与门控矩阵见 docs/08 §1 / §6.1。
- **智能与工具页（2026-09 信息架构收拢）**：页内三组（电脑操控工具 / 技能 / MCP 服务器）同为可折叠
  section-card，折叠策略 —— 「电脑操控工具」**默认展开**（本页主配置面，`agent.tools.*` 探针依赖），
  「技能」「MCP 服务器」**默认收起**（组锚点 `data-group="skills"` / `data-group="mcp"`，
  capture 探针先点开两组、等渲染与折叠动画走完再计数，见 §5.3）。**组头摘要承载状态**（收起也能看清）：
  工具组「x / y 个工具生效」（`y` 取 `COMPUTER_TOOL_NAMES.length`、**不写死数字**，当前 8 个；
  总开关关闭时显示「已停用」）、技能「已启用 x / 共 y」（未发现显示「未发现」）、
  MCP「n 台服务器 / m 台启用」（未配置显示「未配置」）。
  **安全文案收敛为一处**：本页操作直接影响真实系统、工作目录不是沙箱（缺省目录与检索缺省根都按
  06 §5.1 回落链取：配了当前项目时即项目根，Work 模式未绑项目时为模式工作目录，否则 `agent.tools.workspaceDir` > 主目录）、
  敏感工具需逐次确认（确认开关在「系统」页，关闭后不经确认直接执行）只在工具组说明里完整表述一次；
  工作目录长说明、页尾安全提示与原常驻警示 Toast 里与之重复的表述删除，页副标题只保留导航信息。
  **启停控件统一 checkbox**：MCP 服务器行卡的「停用 / 启用」按钮改为 checkbox（绑 `enabled`，
  配置写入路径不变；StatusDot / 状态徽章 / 删除按钮保留），与工具、技能一致。
  **Toast 页级归一**：技能与 MCP 区组不再自带 AppToast，操作回执经 `notify` 事件上抛，
  由页级唯一的 AppToast 渲染。**技能表 4 列**：名称（来源「内置 / 用户」徽章并入名称列）、
  适用场景、脚本、启用 checkbox；原「状态」列与表头旁双徽章删除（组头摘要 + 启用 checkbox
  已覆盖状态信息）。数字输入（命令超时 / 输出上限 / 单次读取上限）定宽（`.input-num`）。
- **MCP 区组（本轮增补）**：服务器编辑新增「自定义请求头」输入 —— 多行 `Key: Value`、每行一个
  （HTTP 传输的鉴权头等场景，`mcp.servers.<id>.headersEnc`，v9 新增）；已配置的头在服务器条目上
  按名字列出并注明「值已加密存储」（读主进程补的只读标记 `headersSet`，与 env 的 `envSet` 同款），
  留空 = 不改动已有值，删除某一行 = 删除该头。编辑交互与「环境变量」完全同款，
  字段与凭据链路见 docs/08 §1 / §1.1。
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
  （BetaV2）智能与工具页 = agent.tools 区组 + 技能区组 + MCP 区组（三组同页折叠；折叠策略 / 组头摘要 /
  安全文案 / Toast / 启停控件的现行口径见上面「智能与工具页（2026-09 信息架构收拢）」条目；
  MCP 状态灯仍用 `StatusDot`，`lazyConnect` 收进折叠区）；高级页（BetaV2）为「网络 / 日志 / 安全 / 危险操作」四卡
  （勿扰时段已并入常规页），「重置为默认配置」需就地二次确认（不再用原生 `confirm`）。

### 2.6 首次安装引导窗口

- 向导式五段：欢迎 → AI 模型（baseURL / API key / 模型名 + 测试连接）→ 模式选择 → 模式设置 → 完成；模式设置可选择“稍后设置”，完成后进入托盘常驻并显示提示条（流程详见 08 §3）。
- **视觉（前端刷新轮）**：三段式布局 —— 顶部「圆点进度 + 可拖动标题栏」、中部单步内容、
  底部「上一步 / 下一步·完成」。步骤切换用**方向正确**的两套动画（`sheet-next` 下一页从右滑入、
  `sheet-prev` 反向），表单统一走 `SettingField`，错误统一 `AppToast tone="error"`，
  模型连接测试 / 目录选择等异步动作有进行中态，完成页「一切就绪」渐进入场。
- 第一步不再有「界面语言」选择器（`general.language` 是死字段，选它不生效）。

## 3. 窗口间状态机

```
托盘 ──▶ 提示条 / 主界面 / 设置 / 引导
提示条 ──点击──▶ 主界面（BetaV2：居中显示 / 聚焦）
提示条 ──面板──▶ 打开主界面（聚焦 / 显示唯一主对话窗口）
```

- **规则**：chat 主界面是**唯一**主对话窗口 —— `WindowState.primary` 只可能是 `'chat'` 或 `null`，
  面板的「打开主界面」只是显示 / 聚焦它，不再存在可跳转的第二对话窗口；
  「收起」= 隐藏窗口（配置里仍只记几何，重启按记录恢复位置）。
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

方向（**BetaV2**：Apple HIG / Pinguo tokens）：**克制的 Apple 风桌面界面** —— 系统色锚点
（蓝 `#007AFF`/`#0A84FF`、绿 `#34C759`/`#30D158`、红 `#FF3B30`/`#FF453A`、橙 `#FF9500`/`#FF9F0A`）
+ iOS 灰阶中性面 + 分层填充 + 大圆角 + 更淡更扩散的柔和阴影；静止卡片靠 1px 边界与留白区分层次，
阴影留给悬停和浮层；留白充足，右栏与主区之间用分隔而非悬浮卡片。
**品牌不再使用双色渐变**：强调色 = Apple 系统蓝纯色，`--aurora-gradient` 即纯强调色值，
全仓禁用 aurora 绿×蓝的 135° 斜向品牌渐变（功能性渐变如遮罩渐隐允许，须注释说明）；
不用霓虹 / 渐变彩带 / 拟物。**明暗跟随系统**：默认深色，Windows 外观切到浅色时四窗同步切换
（令牌与窗口底色口径见 §5.1「系统明暗双档」，截图验收见 §5.3）；不提供手动主题开关。

### 5.1 设计令牌

全部定义在 `apps/desktop/src/renderer/shared/theme.css`，四个窗口共用（各自 `main.ts` 里 import）。

| 类别 | 令牌 | 值 / 说明 |
|---|---|---|
| 品牌（强调 / 成功） | `--aurora-blue` / `--aurora-green` / `--aurora-gradient` | Apple 系统色：亮 `#007AFF` / `#34C759`，暗 `#0A84FF` / `#30D158`；`--aurora-gradient` = **纯强调色值**（**BetaV2 起废弃双色渐变**） |
| 原始中性阶 | `--neutral-900/850/800/700/600/500/400/300/200/100/50` | iOS 灰阶 `#000000` 到 `#f5f5f7`；850 为 Aurora 自有 `#0b0c0f`（保留兼容）；仅语义层消费原始阶 |
| 底色 | `--bg-base` / `--bg-raised` / `--bg-overlay` / `--bg-glass` | 暗 `#000000` / `#1c1c1e` / `#2c2c2e` / `rgba(28,28,30,.72)`；亮 `#f5f5f7` / `#ffffff` / 白 `rgba(255,255,255,.96)` / `rgba(255,255,255,.72)` |
| 分层填充 | `--fill-1` / `--fill-2` / `--fill-3` | 悬浮层 → 卡片 → 悬停/选中，逐层变亮：亮 `rgba(0,0,0,.045/.07/.10)`，暗 `rgba(255,255,255,.07/.10/.14)` |
| 分隔线 | `--border-subtle` / `--border-strong` | iOS 语义：亮 `#d1d1d6` / `#c7c7cc`，暗 `#38383a` / `#48484a` |
| 文本 | `--text-primary` / `--text-secondary` / `--text-muted` | 亮 `#1d1d1f` / `#6e6e73` / `#aeaeb2`，暗 `#f5f5f7` / `#aeaeb2` / `#7c7c80`；正文用 `--leading-normal(1.5)`、说明用 `--leading-relaxed(1.55)` |
| 状态 | `--status-idle` / `-running` / `-unread` / `-error` / `-ok` | idle `#8e8e93`、running = 强调蓝、unread = 警告橙（`#FF9500`/`#FF9F0A`）、error `#FF3B30`/`#FF453A`、ok `#34C759`/`#30D158`，**四个窗口语义一致** |
| 字体 | `--font-ui` / `--font-display` / `--font-mono` | SF 意向系统栈（`-apple-system` → `SF Pro Text` → `Segoe UI Variable` → 雅黑）；标题 `--tracking-display(-0.02em)`，分区标签 `--tracking-eyebrow(0.08em)`，数字 `--num-tabular` |
| 字号 | `--text-xs(11)` / `sm(12.5)` / `base(13.5)` / `lg(15)` / `xl(20)` / `2xl(26)` | 正文基准 `--text-base`；`--leading-tight(1.25)` / `normal(1.5)` |
| 字重 | `--weight-regular(400)` / `medium(500)` / `semibold(600)` | |
| 圆角 | `--radius-xs(6)` / `sm(10)` / `md(14)` / `lg(20)` / `xl(28)` / `pill(999)` | 档位不变，靠大半径营造连续圆角观感 |
| 间距 | `--space-1..10`（4/8/12/16/24/32/48/64/96/128） | 4px 栅格；大阶用于空状态与引导留白 |
| 材质 | `--blur-thin(12)` / `--blur(24)` / `--blur-thick(40)` | `.glass` = 模糊 24 + `saturate(180%)` + 1px 内描边高光 + `--shadow-2`；不支持 `backdrop-filter` 时回落实色 |
| 阴影 | `--shadow-hairline` / `--shadow-1/2/3` | **BetaV2：更淡更扩散**；静止卡片只用细描边与 hairline；浮层/悬停用带负 spread 的 2，模态用 3 |
| 控件 | `--control-h-sm/md/lg` / `--hit-target` | 32/40/48px 按钮高度、40px 图标命中目标；动作圆角统一 `--radius-pill`，输入框使用 `--radius-sm/md`，卡片使用 `--radius-md/lg` |
| 语义色 | `--on-accent` / `--accent-text` / `--accent-ring` / `--status-running-ring` / `--danger-*` / `--error-*` / `--warning-*` / `--ok-*` / `--overlay-scrim` | 强调色上的前景为白色；点 / 面用系统原色，文字态（`--*-text`）用可读的加深 / 提亮变体；状态色只用于状态，不用来装饰卡片 |
| 缓动 | `--ease-standard` / `--ease-spring` / `--ease-smooth` | 颜色/透明度用 standard，大面积位移用 smooth，出现/展开用 spring |
| 时长 | `--dur-fast(150)` / `base(250)` / `slow(350)` / `press(120)` / `pulse(1600)`；`--transition-fast\|base` | `--dur-press` / `--dur-pulse` 为 BetaV2 新增（按下微缩 / 脉冲环），`--transition-*` 是前两者的组合别名 |
| 层级 | `--z-sticky` / `--z-flyout` / `--z-popover` / `--z-toast` | **2026-09 新增**（1 / 20 / 30 / 200）：浮出物的唯一来源。此前是散落在三个组件里的 `z-index: 20/20/30` 魔数，直接后果是输入区浮层互相遮挡（见 §2.3「三个浮层的锚点与层级」）。**新代码不许再写 z-index 字面量**（`edge-bar` 内部那处 `z-index: 1` 是窗内分层，保持原样） |

**硬约束**：既有令牌名（`--bg-*`、`--border-*`、`--text-*`、`--status-*`、`--radius-sm|md|lg`、
`--space-1..6`、`--transition-fast|base`、`--font-ui|mono`、`--aurora-gradient`）**只增不删**——
它们散落在各窗口的 scoped 样式里，删名字不会报错，只会静默掉样式。
**品牌不再使用双色渐变（BetaV2 决策）**：`--aurora-gradient` 是纯强调色值；
凡 `linear-gradient` 叠加 `--aurora-green` × `--aurora-blue` 的品牌渐变（含 135° 斜向那类）一律替换为
强调色纯色或极淡强调色填充；功能性渐变（如遮罩渐隐）允许，但必须注释说明用途。
组件只引用语义令牌，不直接引用原始中性阶或另写颜色字面量。分层卡片用 `--fill-1`，悬停用 `--fill-2`，选中用 `--fill-3`；输入框用 1px 紧聚焦环。每屏一个主动作，其余使用次要或弱动作。玻璃材质用于悬浮面板，不铺满页面；静止卡片保持边界清楚、正文不降低透明度。

**系统明暗双档（BetaV2 值已更新）**：默认深色保留上表暗档值；`@media (prefers-color-scheme: light)` 覆盖
语义层及 `color-scheme: light`，基座 `#f5f5f7`、抬升面 `#ffffff`、玻璃白 `rgba(255,255,255,.72)`、
主字 `#1d1d1f`、次字 `#6e6e73`、弱字 `#aeaeb2`、描边 `#d1d1d6` / `#c7c7cc`；
强调与状态随档位切到 Apple 亮档系统色（蓝 `#007AFF` / 绿 `#34C759` / 红 `#FF3B30` / 橙 `#FF9500`），
文字态再用可读的加深变体；焦点、危险按钮、选区、玻璃回退及阴影成对覆盖。
Electron `nativeTheme.themeSource` 常态保持 `system`；创建和系统外观 `updated` 后非透明的
主界面/设置/引导窗口底色与 CSS 基座一致（**BetaV2**：深 `#000000`、浅 `#f5f5f7`），提示条始终透明，
所有窗口几何与用户配置不随主题改变。

### 5.2 动效规范

- 工具类（`theme.css` 全局）：`.interactive`（悬停上浮 **1px** + `--shadow-2`，按下 `scale(.98)`）、
  `.anim-rise`（`translateY(6px)` 淡入）、`.anim-pop`（`scale(.96)` 弹入）；
  **BetaV2 新增**：`.press`（按下微缩 `scale(.97)`，`--dur-press` 120ms 回弹，按钮类用）、
  `.hover-fill`（侧栏类列表项 hover：150ms 背景过渡 + `--fill-2` 填充，可覆盖 `:hover` 自定底色）、
  `.anim-slide-left` / `.anim-slide-right`（横向滑入 12px，方向性内容切换），
  以及 keyframes `pulse-ring`（录音麦克风的扩散环，配套 `.pulse-ring` 类按 `--dur-pulse` 无限循环）。
- Vue `<Transition>` 预设：`.sheet-*`（右侧滑入，提示条面板 / 抽屉）、`.rise-*`（气泡与列表项）、
  `.fade-*`（内容切换）、`.collapse-*`（`max-height` 展开，**终点取实测高度** `--collapse-h`，
  见 §2.3 与下面的硬约定；工具卡片 / 折叠区块）、
  **`.page-*`（BetaV2 新增：设置页横向切换，fade + `translateX(12px)`，250ms `--ease-standard`，
  新页从右进、旧页往左退）**。
- **硬约定**：快 / 标准 / 慢动作分别为 150 / 250 / 350ms；颜色和透明度走 standard、大面积位移走 smooth、进场展开走 spring。所有过渡/动画必须走 `--transition-*` 或 `--dur-*` + `--ease-*`，不写死时长；
  `prefers-reduced-motion: reduce` 下把三个时长压到 1ms 并让位移动画立刻落位（theme.css 里已全局兜底）。
- **硬约定（2026-09 性能轮新增两条，都是踩过坑的）**：
  1. **展开 / 收起优先用实测高度动画**：`.collapse-*` 的终点走 `var(--collapse-h, 70vh)`，
     由 `useCollapseTransition` 的 `enter` / `before-leave` 钩子写入实测内容高度
     —— **进入方向不能挂 `@before-enter`**（那时元素还没插入文档、`scrollHeight` 为 0），
     且**量之前要临时摘掉内联 `max-height`**（否则被钳制的 flex 列容器会把可收缩子项压扁、量偏小）；
     两条都见 §2.3「展开 / 收起的高度动画」。
     **禁止**用与内容无关的固定 `max-height`（如写死 `70vh`）当**新增**折叠区的终点：内容比终点小得多时，
     `min(内容高, max-height)` 会把全部可见位移挤进时间轴的一小段，看起来就是「先卡住、再猛跳」。
     **两种情形不要用高度动画**（终点只量一次，早于内容长高；过渡期的 `overflow: hidden` 会把
     后长出来的内容裁掉、末尾补跳）：① 内容在该 250ms 内会持续生长（流式思考块 —— 它的自动展开
     正好命中）；② 过渡根自己带 `max-height` / 本身就是滚动容器。这两类一律 `name="fade"`（见 §2.3）。
     现状：**工具卡展开体与历史思考块的手动点开**走实测高度；**思考块的流式自动展开与
     子代理页「任务指令」折叠**走 `fade`；**设置页仍有十几处 `.collapse` 只回落 `70vh`**
     （未接钩子，行为与改前一致），属于逐个接线的存量，别把「优先用」读成「已全部用上」；
  2. **输入区浮层必须锚在 `.composer-box` 上并走 `--z-flyout`**，不许自己写 z-index 魔数、
     更不许锚到工具行**内部**的元素上 —— 锚点错位会让浮层盖住触发它的那排控件
     （`.ctx-card` 把整条工具行连同发送键盖死过一次，属实测事故）。
- **2026-09 动画轮新增**（对话区与子代理页面为主）：
  - **循环类时长令牌**：`--dur-spin`（1200ms，加载指示器）、`--dur-caret`（1100ms，流式光标）、
    `--dur-bounce`（1000ms，三点等待）——循环动画与「出现」动画的节奏要求不同，因此单列令牌，
    取代此前散落在组件里的 `1s` / `1.1s` / `1.4s` 写死值。
  - **新 keyframes / 工具类**：`aurora-caret`（流式光标）、`aurora-typing-bounce`（三点等待）、
    `aurora-shimmer`（运行中扫光，配 `.shimmer` 或组件内 `::before` / `::after`）、
    `aurora-confirm`（完成确认的一次性弹跳，配 `.confirm`）、`aurora-track`（子代理进度条滑动块）、
    `aurora-think-line`（步骤逐条浮现）、`aurora-spin` + `.spin`（无限旋转，**放全局**——
    scoped 样式里的 `@keyframes` 会被 Vue 改名，跨组件复用必须走全局）。
  - **`.tool-*` 过渡**：工具卡进场上浮淡入（`TransitionGroup`），第 2/3/4 张按 40/80/120ms 错开。
- 系统实时切换主题时只更新语义色与非透明原生底色，不改变窗体几何、配置或转场路径；`prefers-reduced-motion: reduce` 在明暗两档均将动画/过渡压到 1ms，状态灯停止呼吸。
- 页面骨架统一用 `.page` / `.page-title` / `.page-sub`；页面需要不同内边距时在自己的 scoped 样式里覆盖
  （scoped 选择器优先级更高，覆盖安全）。

### 5.3 截图核对工具（AURORA_CAPTURE）

- **双主题截图（step-06）**：只在**同时**指定 `AURORA_CAPTURE_THEME=dark|light` 与 `AURORA_CAPTURE=<目录>` 的
  开发截图运行里，`bootstrap()` 会在**创建任何窗口之前**把 `nativeTheme.themeSource` 设为该档；
  普通启动（含只设 `AURORA_CAPTURE`、不指定档位）一律回到 `system`，即跟随 Windows 外观。
  每窗各有一张主题场景：`theme-edge-bar.png` / `theme-chat.png` / `theme-settings.png` / `theme-onboarding.png`
  （引导那张排在五段序列**之前**：只等第 0 段就位、不点页脚按钮，因此阶段推进与原有五条断言不受影响；
  交互窗那张排在最前，仍在 `chat-collapse.png` 之前）。主题探针 `themeProbeScript` 断言四件事：
  ① `matchMedia('(prefers-color-scheme: light|dark)')` 命中目标档；② 文档根的计算值 `color-scheme` 等于目标档；
  ③ `--bg-base` 等于该档基座（**BetaV2**：深 `#000000` / 浅 `#f5f5f7`），且非透明窗的 `body` 背景不透明、与基座同色
  （提示条反过来必须 alpha 0，整窗保持透明）；④ 正文与基座的对比度 ≥ 4.5:1，且明暗极性正确
  （浅色不许白字、深色不许黑字）。**原生窗口底色渲染层读不到**，由同一条 `checks` 记录里的 `native` 字段断言
  （主进程侧 `themeNativeCheck` 读 `BrowserWindow.getBackgroundColor()`），`pass` 取渲染层与主进程结果相与 ——
  原有交互探针各自独立执行、不被替换。两份 `report.json` 均要求每条 `ok:true`、存在的 `result.pass:true`，
  且**配了探针的条目必须有 `result`**（`checked === true` 时 `result` 不得为空，见下面「产物」一段），
  并逐张比对文字、卡片、按钮和引导完成页。
- `AURORA_CAPTURE=<目录> pnpm dev`：把四个窗口、提示条两态、设置页各页、每窗一张双主题场景
  与各条 DOM 探针场景截成一批 PNG 后退出。
  **张数与具体构成以 `report.json` 的实际条目为准，文档里不写死**——BetaV2 又是**净增**，
  后续还会继续加，**不要按固定张数做校验**（这里列出的名字只是当前已知条目，不是清单全集）。
  场景按 `main/capture.ts` 的 `defaultCapturePlan` **实际顺序**执行，当前为五组：
  1. **提示条**：`edge-bar.png`（纯截图）→ `theme-edge-bar.png`（双主题，整窗透明）→
     `edge-bar-expanded.png`（act 派发真实 hover，面板三按钮命中测试）。
  2. **主界面（chat，BetaV2 三栏）**——顺序有约束（见下面「全局顺序」一条）：
     `theme-chat.png`（双主题）→ `chat-sidebar.png`（左栏结构 + **出厂门控现场**）→
     `chat-hit-targets.png`（命中区与可访问性盘点，不改状态）→
     `chat-right-panel-toggle.png` → `chat-right-panel-work.png` → `chat-project-card.png`
     （右栏模式感知两条 + 项目卡一条，均自恢复、不动会话）→ `chat-snapshot-card.png`
     （v14 文件备份卡：prepare 种真实快照并 flush 落索引 + reload，act 点一次「回滚」停在待确认态）→
     `chat-job-panel.png`（v15 右栏「任务」面板：夹具在跑计划前种下 `paused` 的
     `<userData>/jobs/main.json`（**必须早于面板首读**），场景只 reload 让面板重新挂载，act **不点任何按钮**）→
     `chat-subagent-page.png`（点左栏「子代理」固定项进页面，check 收尾切回对话流）→
     `chat-automation.png` / `chat-automation-normal.png` / `chat-automation-editor.png` /
     `chat-automation-history.png`（自动化页四连，v19；见下面「自动化页四连」一条）→
     `chat-thinking-block.png`（reload 水合 seed 思考块后点开）→ `chat-quick-session.png`（展开侧栏快速对话面板）→
     `chat-thinking-level.png` → `chat-model-picker.png` → `chat-tts.png`（reload，朗读按钮）→
     `chat-drag.png` → `chat-collapse.png`（点击写在 check 里，见下）→ `chat.png`（自动滚底）。
     2026-09-26 新增四条（**顺序以 `report.json` 为准**；两条 `chat-stream*` 排在本组最后）：
     `chat-composer-flyouts.png`（两个浮层 + 几何断言）、`chat-tool-card-open.png`（点开工具卡展开体）、
     `chat-archive.png`（左栏归档分组）、`chat-stream-burst.png`（高密度流式，见下面各条说明）。
     历史现场由 `runCapture` 在跑计划前经 `seedChatTtsHistory` 种进 `sessions/main.json`：
     一条助手消息，内容含裸 URL 与行内代码（核对链接样式），并带 `reasoning` 字段
     （**探针标记 `capture-reasoning-probe`**，思考块探针靠它确认「展开后看到的就是 seed 的思考全文」）；
     必须赶在窗口第一次 `chat:history` 之前落盘。
  3. **引导**：`theme-onboarding.png`（双主题，只等第 0 段就位、不点页脚按钮）→
     `onboarding-welcome / llm / modes / guide / done.png` 五段（口径见下面「引导页」一条）。
  4. **设置（BetaV2 六页 IA）**：`theme-settings.png`（先落「常规」页）→ 六页深链循环
     `settings-general / modes / llm / voice / agent / advanced.png`（general / modes / llm / voice / agent
     五页各挂一条门控探针，advanced 纯截图；modes 页 act 先展开默认收起的「课程表与课前提醒」分组）→
     `settings-legacy-tts-alias.png`（旧深链 `?page=tts` 经 `LEGACY_PAGE_ALIASES` 落到「语音」页；
     `skills|mcp → agent` 走同一张映射表，机制由本场景代表验证）→ `settings-drag.png` →
     `settings-llm-models.png` → `settings-llm-params.png` → `settings-llm-structure.png` →
     `settings-tts-card.png`（深链用旧 id `tts`，顺带覆盖「旧链接上编辑卡流程照常可用」）→
     `settings-classroom-patch.png` → `settings-modes-work-gating.png`。
     「思考等级 / 结构 / 模型列表」三条的配置改写与恢复口径见下面各条探针说明。
  5. **提示条收尾**：`edge-bar-collapsed-final.png`（收起，不留展开态）→
     `edge-bar-after-click.png`（先 `hide('chat')` 复位再点竖条，回归「点击呼出交互窗」）。
  `AURORA_CAPTURE_WINDOWS=edge-bar,settings` 只截指定窗口（逗号分隔）。
  仅开发态生效；与 `AURORA_SMOKE` 同时设置时**截图优先**（自测不会执行）。
  进程退出码：0 = 全部成功，1 = 一张图都没写出，2 = **存在失败项**——
  截图/探针抛错（`ok:false`）、探针 `pass === false`，或 `checked` 为真却拿不到 `result`
  （配了探针但脚本静默返回 `undefined`，见下面「产物」一段）。
- **userData 会自动隔离（必须，不是可选）**：**多条**探针会**临时改写真实配置**——
  至少包括：门控场景（切到 Work 模式、翻 `classification.autoMove`）、
  `chat-right-panel-work`（经 `mode.set` 切 `modes.current` 到 work，check 收尾切回 classroom）、
  `chat-thinking-level`（改 `reasoningEffort`，check 结尾写回原值）、
  `chat-model-picker`（切 `model`，check 结尾写回原值）、
  `settings-llm-params`（造一个 provider 用于断言）。
  它们中的大多数会在结束时把改动还原（如 `chat-thinking-level` / `chat-model-picker` 写回原值、
  `settings-llm-models` 删回新增行），但这属于**各场景自己的自律、不是框架保证**：
  场景中途失败就会把脏配置留给后面的场景。所以 `AURORA_CAPTURE` 存在时应用一律把 userData
  指向临时目录并在退出时删除 —— 与 `AURORA_SMOKE` 走同一条隔离路径（`index.ts` 的 `isolatedRun`）。
  也就是说截图跑在**全新默认配置**上，不会碰用户自己的 `%APPDATA%/Aurora`。
  （`SETTINGS_LLM_STRUCTURE_*` 与 `CHAT_AUTO_SCROLL_SCRIPT` 等**只读**探针不在此列。）
- **`settings-llm-models` 基本不改配置**：它的 `+ 手动添加` 只改**本地 draft**（加一行空行，点「应用」才落盘），
  唯一会写盘的情况是隔离环境里**一个 provider 都没有**时先造一个（否则列表区根本不在 DOM 里）；
  check 结尾把刚加的那一行删掉恢复行数。上面的隔离仍然必须——其余几条探针确实会改配置。
- 引导页是欢迎 → AI 模型 → 选择模式 → 模式设置 → 完成五段（§2.6 的简写不省略实际中间阶段）。捕获依次输出 `onboarding-welcome.png`、`onboarding-llm.png`、`onboarding-modes.png`、`onboarding-guide.png`、`onboarding-done.png`，每张图的探针核对当前步骤标识、标题和页脚主动作在窗口可视范围内。自动化在隔离 userData 中通过现有按钮前进；模型页仅填入测试用本地凭据后保存，不伪造离线连接测试成功；模式设置页选择“稍后设置”进入完成页。五段不改变正式引导的数据或分支行为。
- 产物：`<目录>/<窗口或场景>.png` 与 `report.json`（每张图的渲染层探针结果）。
  `report.json` 的字段：`dir` / `requestedTheme`（本次请求的档位，未指定为 `system`）/ `theme`（实际生效档位）
  / `files` / `checks`；每条 `check` 带 `name` / `file` / `result?` / `checked` / `ok` / `error?`。
  `checked` 区分「纯截图场景（没配探针）」与「配了探针」：**配了探针却拿不到返回值会判失败**
  （退出码 2），避免脚本提前 `return` 让断言静默失效 —— 只看 `result.pass === false` 会漏掉这一类。
- 三类动作（`main/capture.ts` 的 `CaptureTarget`）：`prepare`（主进程侧准备）、
  `act`（在渲染层派发真实 `mouseenter` / `click`）、`check`（截图后取一份可判定结果）。
  面板是渲染层 hover 驱动的，**只从主进程改窗口尺寸会拍到空面板**，所以提示条展开态走 `act`。
- 探针返回 `pass: boolean` 时按 `PASS` / `FAIL` 写日志（前缀与 `AURORA_SMOKE_RESULT` 一致）：
  - 提示条面板：`elementFromPoint` 命中测试 3 个按钮 + 是否落在窗口宽度内 + 窗口宽 ≤ 228px
    （面板自身的 220px 只作为信息回报 `styled`）；
  - 点击竖条后的窗口状态（`chat` 可见、`primary === 'chat'`）；
  - **交互窗收起即隐藏**（`CHAT_COLLAPSE_CHECK`，产物 `chat-collapse.png`）：
    在交互窗里真实点击标题栏 caption「关闭」按钮（按 `data-caption-btn="close"` 定位），等 600ms 后
    `await window.aurora.window.getState()`（4s 超时兜底），要求 `visible['chat'] !== true && primary === null`
    （收起 = 直接隐藏窗口，不再拉起小窗；整个 state 一并回报便于排查）。
    ⚠️ 点击写在 **check** 里、该场景**不设 `act`**：`act` 在截图之前执行，窗口若先被 `hide()`，
    紧接着的 `capturePage()` 在 Windows 上**永不返回**（实测整轮截图卡死、`report.json` 写不出来）。
    所以 `chat-collapse.png` 拍到的是**点之前的交互窗**（含那颗「收起」按钮），
    「收起后窗口消失」由本探针的 `pass` 负责；
  - **对话自动滚底 + 回到最新胶囊**（`CHAT_AUTO_SCROLL_SCRIPT`，交互窗一条）：向 `.messages`
    追加一个 1600px、`flex-shrink: 0` 的探针节点（等价于「内容变高」），断言 `.thread` 的
    `scrollHeight - scrollTop - clientHeight ≤ 4`；同时要求「内容确实比窗口高」（`maxScroll ≥ 200`）——
    否则探针没撑开内容时 `distance === 0` 会假 PASS（空 div 会被 flex 压扁，必须禁掉收缩）。
    随后把 `scrollTop` 归零模拟用户上滚，断言「↓ 回到最新」胶囊出现且**落在容器可视区内**
    （`position: sticky` 在"内容按溢出渲染"的交互窗里是否真吸得住，只有真实 DOM 能回答）。
    探针放在 `check`（截图**之后**执行），不污染 PNG，执行完移除节点、归位滚动；注：探针节点是
    **合成内容**，只验证滚动机制本身，不需要配置模型；
  - **输入区浮层不遮挡**（`CHAT_FLYOUTS_ACT` / `CHAT_FLYOUTS_CHECK`，产物 `chat-composer-flyouts.png`，
    2026-09-26）：act 里**依次**打开斜杠浮层（输入 `/`）与权限下拉（点权限钮），
    check 再在**四个时刻**（斜杠开 / 权限开（act 快照）/ 权限开（实时复测）/ 上下文详解开（check 里现开））
    各取一次可见集合与矩形，做的是**几何断言**而不是只数个数 ——
    ①**任一时刻最多一个浮层可见**（三个浮层的矩形都取自真实 `getBoundingClientRect`，
    可见判据是宽高都 > 0）、
    ②可见浮层与 `.composer-bar` 的矩形**不相交**（浮层只许盖在输入卡上方，不许压工具行）、
    ③在**发送键中心**做 `elementFromPoint`，命中的必须是发送键自己或其后代。
    第 ③ 条直接钉住本轮的事故：`.ctx-card` 锚在工具行下方时把整条工具行盖住，那时命中的是浮层。
    断言前必须等过渡结束（`--dur-fast` 150ms，照本文件既有的轮询范式），否则会拍到中间态假 FAIL。
  - **工具卡展开**（`CHAT_TOOL_CARD_OPEN_ACT` / `CHAT_TOOL_CARD_OPEN_CHECK`，
    产物 `chat-tool-card-open.png`，2026-09-26）：点 seed 的 `task` / `todo_write` 卡头展开，
    断言展开体可见、`--collapse-h` 与该元素的 `scrollHeight` 相差 ≤ 2px（**机制的**回归断言：
    有人改回写死 `70vh` 或改错钩子，这条立刻 FAIL），
    并断言**点击后 60ms 的那一帧高度严格小于稳定高度** —— 终值在「正常过渡」与
    「退化成瞬跳」两种实现下相同，只有中间样本能把后者钉住。
    返回值里另有 `diagnostic`（中途 / 稳定两次布局快照）与 `detachedMeasureProbe`
    （游离元素 `scrollHeight` 恒为 0 的旁证），只作信息、不参与 `pass`，
    用于复现「f77a842 之前 enter 侧少写 66px」那个坑。
  - **左栏归档分组**（`CHAT_ARCHIVE_ACT` / `CHAT_ARCHIVE_CHECK`，产物 `chat-archive.png`，
    2026-09-26）：act 点 `chat.archive-toggle` 展开分组；check 断言 seed 的已归档会话
    （`sessions/chat-seed-archived.json`）只在 `chat.archive-list` 里、分组标题计数与实际行数一致，
    然后**点主列表「当前会话」那一行**上的 `[data-action="chat.archive-session"]`（走真实 UI，
    不是直接调 IPC）并断言它离开 `chat.session-list`、进入 `chat.archive-list`，
    同时断言主区头部的**已归档提示条**（`chat.archived-banner`，含 `chat.unarchive-current` 按钮）
    出现；再点该行的 `[data-action="chat.unarchive-session"]` 撤销，断言计数/归属还原、
    **提示条消失**，收尾收起分组、清掉浮层与输入残留（后续场景看到的左栏与跑之前一致）。
    **为什么必须归档当前会话那一行**：提示条只在这时才显示，取主列表第一行的话它永远测不到。
  - **高密度流式（本轮性能修复的回归防线）**（`CHAT_STREAM_BURST_ACT` / `CHAT_STREAM_BURST_CHECK`，
    产物 `chat-stream-burst.png`，2026-09-26）：桩服务按提示词里的 `burst-probe` 标记
    各发 150 条 `reasoning_content` / `content` 分片（间隔 5ms，贴近推理模型 100+ token/s 的密度），
    **外加两轮各 2 万字的前文堆量**（代价与「整份 transcript」成正比，不堆量时连修复前都只测出空闲水平）；
    act 在**流式进行中**截图（思考块此时应在增长），check 断言收尾后正文与思考块的**首尾标记都在**
    （证明三层合并没有丢内容），并把长任务、**20ms 心跳漂移**与 **rAF 帧间隔**三组数
    与阈值比对 —— 真正的判据是后两组（longtask 对「每片几毫秒的持续饱和」没有分辨力，
    详见 06 §16.3 的实测表与「证什么、不证什么」一段）。阈值按修复后实测值 × 约 3 倍标定，
    实测为 0 的项给绝对下限；**改桩密度或 transcript 规模必须重新标定**。
    为什么必须有这一条：原有 `chat-stream.png` 的桩只发 2 条分片，密度低到
    「每条增量都重解析整份对话」也来得及 —— 这类 BUG 在它面前**必然 PASS**（见 06 §16.3）。
  - **主界面左栏结构 + 门控现场**（`CHAT_SIDEBAR_SCRIPT`，产物 `chat-sidebar.png`，BetaV2）：
    断言三栏重构后左栏的固定锚点全在 —— `chat.quick-item`（固定顶置「快速对话」）、
    `chat.session-list`（**有会话行**：隔离 userData 由 `seedChatTtsHistory` 种了 main 会话）、
    `data-action="chat.new-session"`；右栏开关 `chat.right-panel-toggle` 在、右栏 `.context` 默认展开
    （1120px 宽三栏并存）且 classroom「今日课程」与通用「系统状态」两卡都渲染（ContextPanel 无
    data-field 锚点，按卡头文案定位）。**含麦克风门控反向断言**：`stt` 未配置时
    `[data-field="chat.mic"]` 必须**不存在**（数到即坏 —— 钉「未配置连按钮都不渲染，不是 disabled」口径）。
    另外断言 2026-09 新增的两条：`chat.subagent-item` 恰好 1 个、角标 `chat.subagent-count`
    恰好 1 个（seed 的 `task` 工具卡带子代理快照），以及**每张工具卡头恰好一枚语义图标**
    （`.tool-card .tool-head .tool-icon` 数 == `.tool-card` 数）。
    本场景不改任何状态，必须排在一切改配置 / 改会话的场景之前，保证读到出厂门控现场；
  - **主界面命中区与可访问性盘点**（`CHAT_HIT_TARGETS_CHECK`，产物 `chat-hit-targets.png`，2026-09-29）：
    量左栏 / 标题栏 / 输入区 / 消息区里**所有可见可交互控件**的矩形，断言
    ① 无一低于 WCAG 2.2 SC 2.5.8 的 **24×24** 下限（`belowAbsolute` 必须为空）、
    ② 高频动作（新建会话 / 左栏固定项 / 任务入口 / 右栏开关 / 设置 / 发送 / 麦克风 / caption）
    无一低于 **32×32**（`belowPrimary` 必须为空）、
    ③ 消息区 `aria-live="polite"` + `aria-atomic="false"`，且非流式时 `aria-busy="false"`。
    全量尺寸与两类违例都写进报告（`sizes` / `belowAbsolute` / `belowPrimary`）——
    "到底哪个钮太小"直接看数，不用猜。**只量渲染出来的目标**（按钮 / 下拉），不量里面的图标；
    `opacity: 0` 但占位保持可命中的控件（会话行归档钮）同样要达标。
  - **设置页安全区巡检**（`SETTINGS_OVERFLOW_ACT` / `SETTINGS_OVERFLOW_CHECK`，
    产物 `settings-overflow.png`，2026-09-29）：act 依次点开左侧**全部 7 个导航项**
    （通用 / 模式 / AI 模型 / 语音 / 智能与工具 / Aurora Center / 系统），逐页量 `main.content` 内
    **每个元素**的矩形，只查**横向**溢出（纵向滚动是正常行为、不算），
    探出内容区左右边界超过 1px 的节点记账；check 断言**页数 ≥ 7**（防"导航没点全还判 PASS"）
    且违规页数为 0。这条把「安全区」从自动化页扩到了最可能出现"长标签 + 窄控件"的设置页。
  - **子代理页面**（`CHAT_SUBAGENT_OPEN_ACT` / `CHAT_SUBAGENT_OPEN_CHECK`，
    产物 `chat-subagent-page.png`，2026-09）：「子代理」固定项点击后主区切到页面，断言
    `chat.subagent-page` 在、`chat.subagent-run` 恰好 1 张（来自 seed 的 `task` 工具卡快照）、
    轨迹步骤 ≥ 3、进度条 1 条、报告文本非空、权限徽章文案含「可读写」（seed 授予 `write`）、
    导航项为激活态；随后点 `chat.subagent-conversation-toggle` 展开**独立对话视图**，断言
    容器在、`.conv-turn` ≥ 3（任务 + 两轮正文）、`.conv-tool` ≥ 2（工具调用行）、
    「最终报告」标签恰好 1 个、且**容器内没有 `textarea` / `input` / `contenteditable`**
    （只读 —— 用户无法干预的口径判据）；check 收尾点「回到对话」并断言页面已消失
    —— 后续场景（composer / 自动滚底）依赖对话流在前台。
    这条同时验证「子代理快照随工具卡持久化 → 页面读回」这条链路（`06 §19`）；
  - **自动化页四连**（`CHAT_AUTOMATION_*`，产物 `chat-automation.png` / `chat-automation-normal.png` /
    `chat-automation-editor.png` / `chat-automation-history.png`，v19，docs/13 §11）：
    现场由 `seedAutomationFixture` 种下 —— 1 份 Normal 定义（`am-capture1`「早读提醒」，
    `daily 07:30`）+ 2 条历史（normal / agent 各一条，agent 那条指向种子会话 `auto-capture1`）
    + 该会话文件（任务与回复各一条，均带探针标记 `capture-automation-run`）。
    ⚠️ **与其它夹具不同：种完必须 reload 一次自动化引擎**（`AutomationEngine.reload()`）——
    引擎在 `bootstrap()` 里就已启动、`AutomationStore` 首读即缓存空表（in-flight 的 `ensureLoaded`），
    不重读就是「夹具写了、界面照样是空的」（首跑实测 0 条），机制同 `seedJobFixture` 那条注释；
    四张连做**一条链**（共用一次进入，最后一张收尾还原主区）：
    ① 点左栏 `chat.auto-item` 进页面 → 断言 `automation.page` / 双 tab /「历史」/「新建自动化」/
    「返回对话」锚点都在、左栏项为 **`.active`**；
    ② 点 `automation.tab-normal` → 断言 `automation.builtin` 在、`automation.builtin-toggle`
    **恰好 2**（两条内置）、自建项 `automation.item-am-capture1` 恰好 1、`automation.toggle`
    恰好 1（切到 Normal tab 后 Agent 定义不在列表里 —— 顺带钉住「按 tab 过滤」）；
    ③ 点 `automation.new` → 断言**条件磁贴**（`automation.trigger-kind` 容器下 `[data-kind]`）**≥ 7**
    （catalog 七类）且**每枚磁贴都有图标**、磁贴内元素不探出磁贴矩形（安全区几何护栏）、
    至少 1 行操作组件（`[data-field^="automation.action-"]`）且每行胶囊都有图标、
    编辑器内**原生 `<select>` 数为 0**、名称输入框与数字字段都在，
    再派发一次 `pointerenter` 断言悬浮提示真的出现（`body > .app-tip` 文案非空、不探出视口）
    且 `pointerleave` 后自行收回，然后点 `automation.editor-cancel` 并断言弹窗**已消失**
    （不留残影，后续场景还要操作列表）；
    ④ 先切回 Agent tab 再点「历史」→ 点开一条 Agent 记录（`.run-item.clickable`）断言
    `.detail-message` **≥ 2** 且面板文本含 seed 标记（证明回放的是**真实会话**，不是占位）；
    随后关弹窗 → 切 Normal tab → 重开历史，断言 Normal 记录 `clickable === 0`
    （**不可点、无详情层**，产品口径）且 `.run-time` 存在；
    收尾关弹窗 + 点「返回对话」断言页面消失（后续 `chat-classisland-status` 等场景依赖对话流在前台）。
    这一组同时钉住三条产品语义：**按 tab 分别过滤**、**两种记录的详情口径不同**、
    自动化页与子代理页一样是**主区替换内容**（不属任何会话）；
  - **右栏开关**（`CHAT_RIGHT_PANEL_TOGGLE_ACT` / `CHAT_RIGHT_PANEL_TOGGLE_CHECK`，
    产物 `chat-right-panel-toggle.png`，BetaV2）：act 内点两次 `chat.right-panel-toggle`
    走「展开 → 收起 → 展开」，三态记录暂存渲染层；check 断言三态全部成立、且截图时刻右栏
    **仍是展开的**（收起态只允许活在两次点击之间的瞬时，截图本身就是三栏默认布局的证据）；
  - **右栏模式感知**（`CHAT_RIGHT_PANEL_WORK_ACT` / `CHAT_RIGHT_PANEL_WORK_CHECK`，
    产物 `chat-right-panel-work.png`，BetaV2）：经 `window.aurora.mode.set('work')` 切模式后，
    右栏必须**整体**换成「工作目录」卡、classroom 的「今日课程」卡消失
    （「非当前模式的功能一律不渲染」）；check 收尾切回 classroom 并等课堂卡恢复，
    后续场景的 classroom 现场不受影响；
  - **右栏「当前项目」卡**（`chatProjectAct` / `chatProjectCardCheck`，
    产物 `chat-project-card.png`，v13）：`prepare` 先在 `<userData>/capture-project` 建出**真实**项目根
    （不建的话卡片会渲染成「项目目录不可用」警示态，那条断言就会把警示态当健康态通过 = 假 PASS），
    act 走 `settings:update` 把 `projects.current` 指过去（`SettingsStore` 启动即缓存配置，
    写文件对运行中的进程无效），check 断言卡**恰好一张** + 文本含项目名与根目录片段 +
    `context.project-unavailable` 计数为 0；收尾还原成 `{ current: '', list: [] }` 并把
    `restored`（卡片消失）并入 `pass`，后续场景读到的仍是「无项目」；
  - **右栏「任务」面板**（`seedJobFixture` / `CHAT_JOB_PANEL_CHECK`，产物 `chat-job-panel.png`，v15）：
    `runCapture` 在跑计划**之前**直接写文件种一份 `paused` 的 `<userData>/jobs/main.json`（不走进程内的
    `JobStore.create` —— 要造的正是"上次启动留下的那条 paused job"，它必须先于进程内的 job 存储存在）；
    场景的 `prepare` 只 `reload('chat')` 让面板重新挂载并首读这份文件（面板只在挂载 / 切会话时拉一次列表，
    而 job 存储**首读即缓存** —— 先读过空表之后再写文件，面板是看不见的，所以夹具不能放在 `prepare` 里，
    这与 `seedChatTtsHistory` / `seedClassIslandFixture` 同批）；**act 什么都不点**（点「继续」会真的发起续跑，
    那需要模型服务，不是截图阶段该干的事）。check 轮询等面板出现后断言：`chat.job-panel` 在、
    `chat.job-item` ≥ 1、面板文本含「已暂停」与「轮次上限」（暂停原因必须说清"停在哪"，
    而不是一句含糊的"未完成"）、含 `read_file` 与 `token`（面板的价值是"看得见进度"）、
    `chat.job-resume` 存在（返回值里另记了它的文案 `resumeLabel`，只作信息、不参与 `pass`）；
  - **思考过程折叠块**（`CHAT_THINKING_BLOCK_ACT` / `CHAT_THINKING_BLOCK_CHECK`，
    产物 `chat-thinking-block.png`，BetaV2）：前提是 `seedChatTtsHistory` 种下的带 `reasoning`
    （标记 `capture-reasoning-probe`）的助手消息 —— 本场景先 reload 让渲染层重新水合 main 会话，
    历史水合出的思考块**默认收起**（「已深度思考」摘要行）；act 先记录收起态再点开，
    check 断言「曾收起 + 现已展开 + 正文可见且含 seed 标记 + 块位于正文上方」
    （受 `general.chat.showThinking` 门控，块缺失时探针如实报 FAIL 而不是静默通过）；
  - **快速会话**（`CHAT_QUICK_SESSION_ACT` / `CHAT_QUICK_SESSION_CHECK`，
    产物 `chat-quick-session.png`，BetaV2）：点左栏固定项「快速对话」必须切到 `sessionId = 'quick'`，
    激活判据有二 —— `chat.quick-item` 拿到 `.active` 态 + 主区标题 `.head-name` 变固定名「快速对话」
    （act 内轮询等水合往返，check 再读一次兜住时序）。场景停在 quick 会话无需还原：
    后面 `chat-tts` 自带 reload 回 main，其余 chat 场景只依赖 provider 配置；
  - **ClassIsland 课堂状态卡**（`chatClassislandAct` / `CHAT_CLASSISLAND_CHECK`，
    产物 `chat-classisland-status.png`，2026-09）：状态卡只在「模式 = classroom **且**
    课表来源 = classisland」时渲染，出厂配置下整卡不存在。因此主进程侧先按桥接契约写一份
    假产出（`seedClassIslandFixture` → `<userData>/classisland-fixture/schedule.json`，
    含内嵌 `status.version = 3`），act 再把课表来源切到 classisland + 文件模式指向它；
    check 断言卡在、`上课中` 徽章在、`当前 / 下节` 两行分别带上科目与**时段**
    （`数学 08:00–08:45` / `语文 · 09:20–10:05`，v3 新增字段的落点）、空状态替身不在，
    收尾把来源还原成 `manual` 并断言卡片消失。
    **这条依赖 `classisland:status` 的按需重读**：状态快照原本只在感知摘要组装时才刷新，
    刚切过来会拍到一张空卡（本轮实测就是这么发现的），现在该接口在缓存过期（15 秒）时
    自己重读一次（`ClassIslandProvider.refreshIfStale`）。
  - **ClassIsland 联动设置项**（`SETTINGS_CLASSISLAND_SEED_ACT` / `SETTINGS_CLASSISLAND_FIELDS_SCRIPT`，
    产物 `settings-classisland-notify.png`，2026-09）：新增的两项（提前分钟数、提醒通道）门控要求
    `provider = classisland` + 至少一节课程，出厂配置下**不渲染**，因此本场景先经 `settings:update`
    造现场、展开「课表与课前提醒」分组、把提醒通道区滚进视野再拍图；check 断言
    `modes.classroom.preClassLeadMinutes` / `settings.classisland-notify-test` /
    `settings.classisland-notify-state` / `settings.classisland-notify-test-button` 各恰好 1 个，
    收尾把 provider 还原为 `manual`、清空课表并断言提醒通道区已消失（后续场景读到的仍是出厂门控）。
  - 设置页门控（BetaV2 六页 IA：每页一条 `settings-<page>.png`，general / modes / llm / voice / agent
    五页挂探针、advanced 纯截图）：`data-field` / `data-empty` 计数，各页口径 ——
    **general 页**（`SETTINGS_FIELDS_SCRIPT`）：死字段 `general.language` 必须为 0、提示条详情跟随
    `general.edgeBar.enabled` 开关、BetaV2 迁入的全局勿扰时段 `advanced.quietHours.start/.end`
    两字段必须常在（AdvancedPage 不再渲染它们，数到 >0 才是回归）、
    **v13 的项目区组要么给出 `data-empty="projects.list"` 要么至少一行 `projects.name`**
    （只断言「空态或 ≥ 1 行」，不写死条数），且本页 `data-empty` 白名单只有
    `general.edgeBar` 与 `projects.list` 两个 —— 其余空态一律回归；
    **modes 页**（act `SETTINGS_MODES_EXPAND_ACT` 先展开默认收起的「课程表与课前提醒」分组 +
    `SETTINGS_MODES_CLASSROOM_SCRIPT`）：ClassRoom 生效时 classroom 区组在（`watchDir` 恰好一行）、
    work 区组**整块不在**（互斥渲染，BetaV2 起 WorkSection 有真字段，数到 `modes.work.*` 即回归）、
    课前提醒组按课表节次二选一 —— `modes.classroom.preClassOpenFolder` 或
    `data-empty="modes.classroom.preClassReminder"` 必须出现其一、
    自动化总开关 `automations.enabled` **恰好 1 个**（v19 新增断言：它是**常显**字段，
    数到 0 就说明「自动化」区组整块没渲染 —— 与 `agent.tools.enabled` 同款「总开关必须能改回来」）；
    **llm 页**（`SETTINGS_LLM_FIELDS_SCRIPT`）：`general.chat.showThinking`（v8 新字段，思考块唯一门控）
    与 `imagegen.enabled` / `imagegen.active`（v8 新 provider 体系）常在，
    生图 provider 列表与 TTS / STT 同一套二选一（空 → `data-empty="imagegen.providers"`，非空 → 行容器）；
    **voice 页**（`SETTINGS_VOICE_FIELDS_SCRIPT`，原 TtsPage 探针扩展）：TTS 与 STT 两区组各自的
    **常显**开关 / 字段都在（`tts.enabled` / `tts.autoRead` / `tts.maxChars` 与 `stt.enabled` / `stt.active`
    —— 常显字段与列表空态是两件事，别混），列表空态（`data-empty="tts.providers"` / `stt.providers`）
    与非空行容器二选一；
    **agent 页**见下条；**旧深链别名**（`SETTINGS_LEGACY_ALIAS_SCRIPT`，产物 `settings-legacy-tts-alias.png`）：
    `?page=tts` 必须经 `LEGACY_PAGE_ALIASES` 落到合并后的「语音」页（`tts.enabled` 与 `stt.enabled` 都在）；
  - **「智能与工具」页门控**（`SETTINGS_AGENT_FIELDS_SCRIPT`；BetaV2 六页 IA 下原「电脑操控」页
    并入技能 + MCP 两区组）：读 `agent.tools.enabled` 复选框的**实际状态**，
    开着时要求终端 / 文件 / **文件检索** / 打开**四栏**的详情字段都在
    （`terminalFields/filesFields > 0`、`searchFields >= 2`、`openFields > 0`，
    外加终端栏下「免确认命令模式」容器 `allowPatternsFields === 1`）、
    MCP 区组必须给出「空状态（`data-empty="mcp.servers"`）或服务器行」之一，
    且不得出现这两个**预期**空状态之外的任何 `data-empty`（技能同理，`skills.disabled` 允许出现）；
    关着时只要求总开关本身仍在 —— 否则用户再也开不回来；
  - **本轮（工具面扩展 + prompt caching）的探针条目与实测值**（2026-09-26 `AURORA_CAPTURE` 实跑：
    **48 张 PNG / 48 条 `checks`（45 条配了探针、3 条纯截图）/ 0 FAIL / 退出码 0**，
    45 条探针**全部 PASS**。计数口径与上文「不按固定张数校验」同款：这里的数字是**那一次实跑**
    的实测值，不是校验目标 —— 加场景就重跑，别照着它数）：
    - `settings-agent.png`（`SETTINGS_AGENT_FIELDS_SCRIPT`）：开总开关时的实测值
      `total=11`、`terminalFields=4`、**`allowPatternsFields=1`**、`filesFields=2`、
      **`searchFields=2`**、`openFields=1`
      （`pass` 条件要求 `allowPatternsFields === 1` 且 `searchFields >= 2`；`terminalFields` 只要求 `> 0`
      ——它不写死数值，免得下一次扩栏时无谓变红）。**v13 起这个探针还会临时切到只读档**，
      断言区组摘要原文「只读模式：仅注册只读工具（不含写入与命令）」出现、
      「当前生效工具」块里列出的名字只含只读项（`read_file` / `list_dir` 在，
      `run_command` / `write_file` / `edit_file` / `open_path` / `todo_write` 一个都不在），
      然后切回 `confirm` 并断言摘要消失 —— 这一条是"设置页摘要不骗人"的运行时证据
      （摘要与实际注册表是两套代码，只断言主进程注册表时摘要写错也没人发现）。
      终端卡片下「免确认命令模式」列表
      （`agent.tools.terminal.allowPatterns`，06 §11.7）**只数容器**：列表行与输入框都在容器内部、
      不带同前缀的 `data-field`，所以这个数在空列表与非空列表下**恒为 1**；
      列表的空状态用的是普通文案元素（**不是** `data-empty`），否则本页会多出一块 `unexpected` 直接 FAIL。
      总开关关着时仍只要求总开关自己还在；
    - `chat-stream.png` 的**缓存命中片段**（`data-field="chat.context-cache"`，折叠态嵌在
      `chat.context-usage` 里面；`cachedTokens` 见 §2.3 与 06 §21.4）：桩 LLM 在本轮固定回
      `prompt_tokens = 512` + `prompt_tokens_details.cached_tokens = 512`，因此实测文案是
      `512 / 128k  · 缓存命中 512（100%）`（`chat.context-usage`）、`累计 528`（`.ctx-total`）。
      探针要求 `chat.context-cache` 的文案同时含「缓存命中」「512」「100%」三个子串 ——
      只断言「含缓存命中」时，命中量丢了（只剩标题）或百分比算错都照样能过。
      **分母与分子必须自洽**（桩数据 `cached <= prompt`）：写反会算出大于 100% 的占比，
      展示侧的 `Math.min(100, …)` 虽然夹住了，桩数据也不该自相矛盾。
      未回传 `cachedTokens` 时整段不渲染（不写「缓存命中 0」，那会把「没回传」显示成「一条都没命中」）；
  - **缓存前缀稳定性的端到端断言在 `AURORA_SMOKE` 侧**（`index.ts` 的 `runSmokeTest`，06 §21.1）：
    capture **只**覆盖「命中量落到 DOM」这一半，另两条 —— 连续两轮的系统提示词静态前缀逐字节
    相同、`tools` 数组逐个相同且已排序 —— 读的是**桩服务收到的请求体**，只有 smoke 能拿到，
    capture 侧不重复造（2026-09-26 实跑：`SUMMARY 146/146 passed`，三条新记录全 PASS）。
  - **「模式」页切 Work 门控**（`SETTINGS_SWITCH_TO_WORK_SCRIPT` + `SETTINGS_WORK_GATING_SCRIPT`，
    产物 `settings-modes-work-gating.png`，BetaV2 重写）：点「工作模式」卡「启用」后，
    `modes.work.workspaceDir` 必须**恰好一行**（Work 已实装，不再是「暂无可配置项」空状态卡）、
    classroom 区组字段数为 0、且不得存在任何 `data-empty^="modes."`；
    必须排在 `settings-classroom-patch` **之后**（切走后 classroom 控件就不在 DOM 里了）；
  - **真实写盘回归**（`SETTINGS_CLASSROOM_PATCH_ACT` / `SETTINGS_CLASSROOM_PATCH_CHECK`，
    产物 `settings-classroom-patch.png`）：走完整用户路径（展开「分类行为」分组 → 翻
    `classification.autoMove` 复选框 → `patch()` → IPC → 落盘），前后快照在渲染层暂存由 check 比对 ——
    其它 classroom 字段（含 schedule / subjects）不得因 `settings:update` 的**顶层浅合并**而静默丢失。
  - **思考等级**（`SETTINGS_LLM_EFFORT_CHECK`，产物 `settings-llm-params.png`）：造一个 provider →
    点开第一行的「高级参数与连接测试」→ 断言 `[data-field$=".reasoningEffort"]` 与
    `[data-field$=".temperature"]` 都在、且下拉的 `select.value` 等于配置里写的 `'high'`
    （覆盖「写盘 → 回读 → 渲染」整条链路）。
    ⚠️ 这条探针找的是 `document.querySelector('.more')`（设置页里第一颗折叠按钮），而**列表态的行上没有折叠箭头**
    ——所以 act 先按真实用户路径点 `data-action="edit-provider"` 开卡，再点**卡内**那颗 `.more`
    （`高级参数与连接测试`）。行上刻意只有「编辑 / 设为默认 / 删除」三个动作（删除另带就地二次确认条），
    就是为了让「展开高级参数」只有一个入口、且仍是一次只开一张卡。
  - **AI 模型页结构**（`SETTINGS_LLM_STRUCTURE_ACT` / `SETTINGS_LLM_STRUCTURE_CHECK`，
    产物 `settings-llm-structure.png`）：act 点开第一行的 `data-action="edit-provider"`
    （找不到就按文案「编辑」兜底，并把行内实际按钮文案回传）；check 按 **provider id 白名单**选行：
    行容器是 `data-field` **恰好等于** `llm.providers.<id>`（`<id>` 取自配置里的 provider 键）的元素，
    要求这样的行数 === 配置里的 provider 数量，且**可见**编辑卡（可见的 `[data-field$=".baseUrl"]`）恰好 1 张
    ——卡内字段多一层（`llm.providers.<id>.baseUrl`）、模型列表容器也多一层（`<id>.modelList`），
    因此不会被误算成行（这是白名单比对，**不是**「`data-field` 后半段不含更深的点」这种猜测）；
    `providers` 为空时改为要求存在 `[data-empty="llm.providers"]`。act 全程**不写配置**。
  - **对话窗思考等级**（`CHAT_THINKING_LEVEL_ACT` / `CHAT_THINKING_LEVEL_CHECK`，
    产物 `chat-thinking-level.png`，交互窗一条）：act 先把
    `[data-field="chat.reasoningEffort"]` 下拉切到 `high` 并派发 `change`，等 600ms 让
    `settings:update` + `settings:changed` 往返完成；check 再取
    `llm.providers[llm.active].reasoningEffort`，与 DOM 里该下拉的 `select.value` 比对，
    并断言 option 数量为 4。`pass` = 配置值 === `'high'` **且** DOM 值 === `'high'` **且** option 数 === 4
    ——它同时钉住「读写的是同一个字段」与「探针不改坏用户配置」：act 前先记下原值，
    check 结尾把原值写回，恢复结果一并放进返回值。
  - **模型页「模型列表」区**（`SETTINGS_LLM_MODELS_ACT` / `SETTINGS_LLM_MODELS_CHECK`，
    产物 `settings-llm-models.png`，设置页 `?page=llm`）：act 点开第一行的「编辑」
    （`data-action="edit-provider"`，找不到就按文案「编辑」兜底）；check 断言
    「模型设置区」存在（`[data-field$=".modelList"]`）且**行数 ≥ 1**（行是
    `data-field="llm.providers.<id>.modelList.<index>"`）→ 点一次 `data-action="add-model"`
    后**行数 +1** → 结束时**把刚加的那一项删掉**，让后面的场景仍看到干净配置。
    `pass` = 列表区存在 && 行数 ≥ 1 && 添加后行数增加 && 恢复后行数还原。
    ⚠️ 这条 act **只改本地 draft**（`+ 手动添加` 加一行空行，点「应用」才落盘），
    唯一写盘的情况是**一个 provider 都没有**时先造一个（否则列表区不在 DOM 里，无从点开）；
    恢复（删掉刚加的那一行）在 check 里做。之所以仍排在 `settings-llm-params` **之前**，
    是为了少一次配置往返，也避免它把参数场景造出的 provider 状态搅乱。
  - **对话窗模型选择器**（`CHAT_MODEL_PICKER_ACT` / `CHAT_MODEL_PICKER_CHECK`，
    产物 `chat-model-picker.png`，交互窗一条）：act 先读 `settings.get()`，
    在**没有可用 provider**（`llm.active` 指向的条目不存在）**或**它的 `modelList` 少于两个候选时
    造 / 补一个带**两个**模型 id 的（`modelList: ['deepseek-chat', 'deepseek-reasoner']`，并设为 `llm.active`），
    等 `settings:changed` 生效后把 `[data-field="chat.model"]` 切到第二个模型并派发 `change`，
    等 600ms 让 `settings:update` 往返完成，并把原值记进 `window.__auroraModelProbe`；
    check 再断言**配置里的 `model`**（`llm.providers[llm.active].model`）与
    **DOM 里该 select 的 `.value`** 一致，且 **option 数 ≥ 2**，结束时把 `model` 写回原值。
    `pass` = 三条件全真 —— 它同时钉住「两处读写的是同一个字段」与「探针事后恢复配置」。
  - **窗口拖动**（`WINDOW_DRAG_SCRIPT`，产物 `chat-drag.png` 与 `settings-drag.png`，两个窗口各一条场景）：
    量出所有**可见** `.drag-region`（`getBoundingClientRect()` 的宽或高为 0 视为不可见）并取**最大高度那条**，
    要求「至少有一个可见拖动区」且 **`maxHeight >= 32`**（够抓）；再读**那条**生效的 `app-region` 值为 `drag`
    （只断言高度最大的那一条，不是逐块都验 —— 比如设置窗的 `.content-drag` 即使不算数也不影响判定；
    `getComputedStyle` 同时兼容 `-webkit-app-region` 与 `app-region` 两种属性名 —— Chromium 上可能只认其一）；
    最后在拖动区内部找第一个 `button`，量其中心点做 `elementFromPoint`，断言命中的是它自己或其后代
    （即交互元素没有被拖动区吃掉）。返回值带 `regions` 数组（`tag` / `cls` / `w` / `h` / `top`），
    失败时能直接看出是「没挂类」还是「挂了但太小」。
    ⚠️ **待确认口径**：属性名两种都试，若实测在 Electron 上**两个都读到空串**（属性不可读），
    该条会判 FAIL。此时**不要**把探针改成永远 PASS，而是把判定退化为「按 `regions` 的存在性与尺寸」，
    并在 `report.json` 里保留 `region` / `regionValue` 原始值，同时在本文档注明该属性不可读
    （真实拖动仍可手测）——处置结论必须写进该步的执行记录。
  - **交互窗场景的全局顺序（BetaV2 更新）**：`theme-chat`（双主题）→ `chat-sidebar` →
    `chat-right-panel-toggle` → `chat-right-panel-work` → `chat-subagent-page` →
    `chat-automation`（含 `-normal` / `-editor` / `-history` 三张）→
    `chat-thinking-block` → `chat-quick-session` → `chat-thinking-level` → `chat-model-picker` →
    `chat-tts` → `chat-drag` → `chat-collapse` → `chat.png`
    （上面这条链只是**已知条目**，不是清单全集：`chat-composer-slash` / `chat-composer-permission` /
    `chat-classisland-status` 也属于本组，2026-09-26 又新增了 `chat-composer-flyouts` /
    `chat-tool-card-open` / `chat-archive` / `chat-stream-burst`，v19 再加 `chat-automation*` 四连。
    **真实顺序与条数以 `report.json` 为准**，
    改顺序时不要照这份清单核对。）
    （`theme-chat` 排在全部交互窗场景之前，因为主题图要拍"未配置模型"的基线态；
    `chat-sidebar` 排在一切改配置 / 改会话的场景之前，它断言的是隔离 userData 的**出厂门控现场**；
    `chat-tts` / `chat-thinking-block` 的现场由 `seedChatTtsHistory` 在跑计划前种好、各自 reload 重新水合；
    `chat-right-panel-toggle` / `chat-right-panel-work` / `chat-subagent-page` 自恢复
    （子代理页面在 check 里点「回到对话」切回主区），`chat-quick-session` 停在 quick 会话
    —— 后面 `chat-tts` 自带 reload 回 main，无需专门还原）。
    真正的约束有两条：**凡要在窗口里操作 DOM 的场景都必须排在 `chat-collapse.png` 之前**
    ——收起会隐藏窗口，之后再 `capturePage()` 只会卡死（BetaV2 起顺序整体前移就是为这条服务）；
    以及**不要在同一条场景的 `act` 里隐藏窗口**——`act` 在截图之前跑，
    窗口若先被 `hide()`，紧接着的 `capturePage()` 在已隐藏窗口上**不返回**（实测整轮卡死）。
    跨场景之间没有这个限制：每换一条场景 `captureWindows` 会重新 `manager.show()`，
    所以 `chat-collapse`（点「收起」隐藏窗口）**之后**仍有 `chat.png` 场景，并且能正常出图 ——
    「之后既做不了 DOM 操作也截不到图」是**过强的说法**，不要照抄。
    设置窗场景按上面第 4 组的顺序执行：`settings-llm-models` 排在 `settings-llm-params` 之前
    （少一次配置往返）；`settings-classroom-patch` 必须排在 `settings-modes-work-gating` 之前
    （切到 Work 后 classroom 控件不在 DOM）；其余设置场景各自 reload，互相无顺序约束。
- 截图前会等 `WindowManager.whenLoaded()`（`ensure()` 的加载是 fire-and-forget，
  不等会截到 0 字节空图），并对空图重试；连续空图直接判失败，不产出空文件。
- 设置页深链：`main/window-manager.ts` 的 `ensure(name, query)` / `reload(name, query)`  给 URL / `loadFile` 传 query，仅截图场景使用，正常启动不带 query。

### 5.4 文案密度与提示（2026-09 前端减负轮）

用户反馈的原始问题是「文字、组件堆砌，视觉压力大」与「文字冲出组件」。两条口径落在这里，
新写 / 重做的界面一律照此执行：

1. **能压缩的说明不占版面，改挂悬浮提示**（`AppTooltip.vue`）：
   - 触发方式：`pointerenter` 与 `focusin` 都开（键盘可达），`pointerleave` / `focusout` 收回；
     滚动与窗口尺寸变化一律收回 —— `fixed` 定位的气泡不会跟着锚点走，留着就是错位浮层。
   - 定位：`Teleport to body` + `position: fixed`，按锚点矩形算中线、**量到真实宽度后再做视口夹取**
     （长文案在窄窗口下不会冲出屏幕）；`--z-tooltip`（120）高于弹层 `--z-popover`（30）、
     低于 `--z-toast`（200）。**不要**用纯 CSS 伪元素：提示常挂在 `overflow: auto` 的弹窗正文里，
     绝对定位的伪元素会被裁掉；也**不要**再写 `title`（样式不可控、禁用态控件不弹）。
   - **坑**：气泡定位靠 `transform: translate(-50%, ...)`，所以进场动画**只能碰 opacity**
     （`.tip-*` 只过渡透明度）—— 套 `aurora-pop-in` / `aurora-rise-in` 会写 `transform: none`，
     气泡会被拍回锚点左上角。
   - 用在：图标钮（只有图标的按钮必须有提示，因为它没有可见文案）、条件磁贴的 description、
     字段的 `hint`、区组头的说明标记、页头说明。**有可见文案的按钮不需要再套一层提示**。
   - **窄控件的标签用短文案，完整信息挂提示**（2026-09 补）：输入区的思考等级下拉只有约 90px，
     早先的 option 文案 `auto（不指定，兼容性最好）` 被省略号切成「auto（不指定，兼…」——
     用户看不懂，还以为控件坏了。现在 `REASONING_EFFORT_LABELS`（`@aurora/shared`，**唯一来源**）
     给两档文案：`short`（`auto` / `low` / `medium` / `high`）给窄控件、`full` 给设置页的宽下拉，
     完整解释挂 `title`。模型下拉同理（模型 id 常很长，截断后认不出是哪个模型 →
     `title` 给完整 id）。**判据**：控件里显示的文字要么完整可读，要么它的完整版在悬停提示里。
2. **安全区**：标签与控件分列两项布局（`grid-template-columns: 92px minmax(0, 1fr)`）而不是
   「标签在上、控件在下」——竖排时长标签会把控件挤变形；容器与子项一律带 `min-width: 0`
   并允许换行（`overflow-wrap: anywhere`），页面级工具行用 `flex-wrap: wrap` 保证**任何窗口宽度都不重叠**。
   capture 里有两条几何护栏钉住它：`.card` 内的元素不得探出卡片矩形、编辑器磁贴内的元素不得探出磁贴矩形
   （`CHAT_AUTOMATION_NORMAL_CHECK` / `CHAT_AUTOMATION_EDITOR_CHECK`，超出 1px 即 FAIL）。
3. **选择器不再用原生 `<select>`**（`AutomationFieldInput.vue` 的口径，其他页面逐步跟上）：
   选项 ≤ 3～4 个时用**分段胶囊**（点一下即选），
   选项更多时用**图标磁贴网格**（一眼看到全部选项与各自图标）；参数类型用输入框本身表达
   （`type="time"` / `type="number"` + 定宽）。

4. **命中面积（点击成本的可量部分，2026-09-29 新增）**：用户反馈「主界面按钮位置不太合理、
   点击成本大」—— 位置属偏好，**命中面积是客观可量的**。两条标准：
   - **硬性下限**：任何指针目标 ≥ **24×24 CSS px**（WCAG 2.2 SC 2.5.8 AA）；
   - **高频动作**：新建会话 / 左栏固定项 / 任务入口 / 右栏开关 / 设置 / 发送 / 麦克风 /
     标题栏 caption ≥ **32×32**（本仓 `--hit-target: 40px` 的降级版：40 是理想，32 是下限）。
   量的是**渲染出来的目标**（按钮 / 下拉），不是里面的图标 —— 图标小不是问题，它所在的按钮才是命中区。
   `opacity: 0` 但占位保持可命中的控件（会话行的归档钮）同样要达标。
   探针：`chat-hit-targets` 场景（`CHAT_HIT_TARGETS_CHECK`）量四个区（左栏 / 标题栏 / 输入区 /
   消息区）里所有可见控件的矩形，把 `belowAbsolute` / `belowPrimary` 与全量尺寸写进 `report.json`。
   **首次盘点的真实违例**（当场修掉，别再压回去）：会话行归档钮 22×22 → 24、
   输入区上下文条 22 高 → 24、思考块块头 21 高 → 24、左栏固定项 30 高 → 32、
   左栏底部图标钮 28 → 32、caption 按钮 31 高 → 32。
5. **流式内容的可访问性（2026-09-29 调研后补）**：消息区根容器带
   `aria-live="polite"` + `aria-atomic="false"`，并在流式期间 `aria-busy="true"`、
   结束后翻回 `false`。**为什么用 `aria-busy` 而不是逐 token 播报**：逐 token 的 live region
   会把读屏器刷爆，而 `aria-busy` 让 AT **等这一轮写完之后再读一次完整内容**；
   同理禁止 `assertive`（会打断用户正在听的一切）。live 区必须先存在于 DOM、内容后注入，
   因此属性挂在**常驻的消息区根容器**上，而不是随消息创建的气泡上。

## 6. 外部参考（2026-09-29 调研）

本轮两处交互（思考 / 工具调用展示、子代理对话视图）在动手前后各做了一次网络调研，
结论与落地对照如下（**只借结论，不抄实现**，与本仓按需自研的口径一致）：

- **渐进披露是绝对主流**：过程默认折叠、只留**一行摘要**（如「已深度思考」），点开才看全文；
  结果一出现就把过程收起，焦点回到产出。→ 本仓的思考块 / 工具卡 / 子代理轨迹本来就是这个口径
  （§2.3），本轮只把它做**更干净**（竖轨旁注、间距分级），没有引入新的展开层级。
- **工具卡的标准解剖**：卡头 = 工具名徽标 + 状态（转圈 → 对勾 / 错误）；
  卡身 = 可折叠的入参与结果；卡尾 = 耗时（失败时给重试）。→ 本仓已有卡头 / 卡身 / 耗时；
  **失败重试**尚未做（列入待办，不假装已有）。
- **状态机要给即时反馈**：`思考中 / 工具执行中 / 正在回答 / 出错` 四态都要有可见信号，
  避免空白等待。→ 本仓有公转指示点 + 扫光 + 三点等待 + 流式光标，已覆盖。
- **流式渲染与滚动**：按帧合并 DOM 写入、只在贴底时自动跟随。→ 本仓的 `useStickToBottom`
  与思考块内的 rAF 合帧跟随就是这条（§2.3）。
- **子代理面板的共识形态**（调研了若干 subagent 查看器：独立面板 / 子会话树 / 只读检查）：
  ① 独立视图、② **只读**（不向子代理注入消息）、③ 归属到**派生它的那次调用**（不能按"最新会话"猜）、
  ④ 给**完整转写**（对话 + 工具调用 + 结果），而不是只给父代理的摘要、⑤ 运行中可实时跟看。
  → 本仓 `SubagentConversation` + 子代理页面逐条对齐（只读、按 `callId` 配对、
  对话含工具结果、实时事件与持久化快照合并）；**「一个写者」原则**（任何回复只能经父代理转达）
  正好解释了为什么视图里没有输入框 —— 这是设计决定，不是没做完。
