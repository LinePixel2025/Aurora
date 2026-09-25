# 07 · 窗口与交互设计规格

状态：`已定稿`（v1 基线；**BetaV2** 起设计语言与窗口口径更新，见 §2.3 / §2.5 / §5）

## 1. 设计原则

- **轻**：默认占用最小（提示条），完整窗口按需展开。
- **顺**：所有展开 / 收起带过渡动画，不突兀。
- **聚**：视觉统一（深色主题为主、跟随系统）、状态指示一致（AI 状态灯全局同色语义）。
- **隐**：业务窗口无任务栏图标，托盘为唯一管理入口；所有窗口可一键隐藏。
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
      「最近消息」列表 `flex: 1 1 auto` 吸收剩余高度，中部不留大片空白。
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
- **三栏布局（BetaV2）**：`sidebar(232px, 可折叠) | main(1fr) | context(264px, 可折叠)`，
  栏间用分隔而非悬浮卡片：
  - **左栏**：品牌行（单色 mark + Aurora）→「新对话」按钮（`data-action="chat.new-session"`）→
    固定顶置项「快速对话」（`data-field="chat.quick-item"`，即 `sessionId = 'quick'`）→
    会话列表（`data-field="chat.session-list"`，标题 + 时间 + 条数 + 激活态）→
    底部：模式徽章 + 右栏开关（`data-field="chat.right-panel-toggle"`）+ 设置齿轮。
    **不再有独立快捷窗口，也不再有「快速 / 会话」双栏 tab**（旧的标题栏「历史」按钮 + 侧栏 sheet 口径废弃）。
  - **主区**：头部拖拽区（会话标题 + 模型下拉 `data-field="chat.model"` + 思考等级下拉
    `data-field="chat.reasoningEffort"` + 清空 / 设置）→ MessageList → composer
    （附件 chips + textarea + 麦克风按钮 + 停止 / 发送）。
  - **右栏（模式感知上下文栏）**：classroom = 当前 / 下节课卡（非 classisland provider 时隐藏）+
    今日课程 + 分类流水（紧凑）+ 感知文件夹打开；work = 工作目录卡（打开 + 前往设置）+ 办公提示卡；
    通用 = 系统状态卡（时间 / 电量 / 网络 / 前台应用）。**非当前模式的功能一律不渲染**。
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
    元素尺寸不再变化，只监听尺寸会漏掉每一次流式增量（若 `.thread` 是普通块级容器，其根节点会跟着内容长高，
    尺寸变化本身就能被观察到，因此不会复现这个问题）。`AURORA_CAPTURE` 的自动滚底探针正是靠"内容确实比窗口高"这条守卫把这个坑钉住的。
- **收起（本轮窗口 UX 修复）**：标题栏「收起」= **直接隐藏窗口**，不再拉起独立小窗；
  正在进行的流式回复**不会**因此中止（`hide()` 不触碰 `chat:abort`，见 02 §2.2「关闭 = 隐藏」）。
- **侧栏（BetaV2）**：三栏布局的左栏（232px，可折叠）常驻承载品牌行 / 新对话 / 「快速对话」顶置项 /
  会话列表 / 底部操作（见上方三栏布局）；快速会话（`sessionId = 'quick'`）只是左栏里的一个固定顶置项，
  与普通会话共用同一窗口 —— 旧的「标题栏『历史』按钮展开双栏侧栏」口径废弃。
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
  `.composer-bar` 的控件顺序是：`meta` 文本 → **模型** → **思考** → 停止 / 发送按钮；
  主区较宽时 `meta` 常驻，空间不足（右栏展开 / 窗口缩窄）时先让 `meta` 让位（隐藏或
  `overflow: hidden` + `min-width: 0`），**发送按钮绝不能被挤出行外**
  （标题栏拖动区的改动不要碰输入区，见 §1 与 §5.3 的拖动探针）。
- **窗口拖动（本轮）**：标题栏 `.head` 走统一的 `useWindowDrag('chat')`（`:class="dragClass"`），
  按钮区挂 `noDragClass`；详见 §1 与 §5.3 的拖动探针。
- **未实现**：输入框的 `/`、`@` 补全浮层 —— 代码里从来没有对应功能（composer 只有 textarea + Enter 发送），
  做它需要新开一步（渲染层要能拿到 Skill / MCP 工具清单）。

> **新增（v0.4.0 / v0.5.0）**：
> - **分类流水**（`ClassificationLedger.vue`）：可折叠区块，默认收起，展示
>   时间 / 文件 / 状态 / 科目 · 来源 · 置信 · 依据，支持「改到其他科目」「打开所在文件夹」「清空流水」；
>   交互窗与设置页共用同一组件（分别给 20 / 50 条）。
> - **敏感工具确认卡片**（`SensitiveToolCard.vue`）：挂在交互窗顶部，展示工具名与参数摘要、
>   到 `expiresAt` 的倒计时与进度条（≤15s 变红），「拒绝 / 允许一次」回执。
>   主进程在推送确认请求时会**主动显示并聚焦交互窗**，避免交互窗未打开时确认不可见而静默超时。

### 2.5 设置窗口

- 单窗口分栏（**BetaV2**：8 页合并为 **6 页**）：侧栏按三组排列 —— **基础**（常规 `general` /
  模式 `modes`）／**AI 能力**（AI 模型 `llm` / 语音 `voice`）／**系统**（智能与工具 `agent` /
  高级 `advanced`）；`SETTINGS_PAGE_IDS = ['general','modes','llm','voice','agent','advanced']`。
  当前项用分层填充 + 左侧**强调色**指示条（不再用品牌渐变）。合并口径：Skill 与 MCP 并入 `agent` 页、
  STT 并入 `voice` 页、生图模型并入 `llm` 页、勿扰时段并入 `general` 页（全局 + 提示条两组同区）；
  旧深链兼容映射：`?page=tts→voice`、`?page=skills|mcp→agent`。
- **关闭入口（v0.5.1 起）**：本窗无系统标题栏（`frame: false`），因此侧栏品牌区自担标题栏职责——
  整行可拖动（`drag-region`），右侧提供「✕ 隐藏」按钮；按 `Esc` 等效。
  按 docs/02 §2.2 约定，此处「关闭」= **隐藏窗口**（不退出应用，退出只走托盘菜单）。
- **可拖动区域（本轮补齐）**：侧栏顶部（`.sidebar-drag` 透明条 + 品牌行 `.brand`，
  `.brand` 增加 `min-height: 36px`）与内容区顶部的拖动带（`.content-drag`，高 10px）**都可以拖**；
  关闭按钮与其它交互元素挂 `no-drag`（`theme.css` 另有一条按标签兜底的规则）。
  此前只有侧栏里约 22–30px 的品牌行能拖，正是「有些能拖有些不行」最直接的原因；
  现在侧栏空白处、品牌行、内容区顶部三处都能按住拖动窗口。
- 模式页（**BetaV2**）：三模式卡片选择 + 引导状态；**只渲染当前模式的配置内容** ——
  ClassRoom 区组不变；Work 已实装，提供工作目录 `workspaceDir`（`data-field="modes.work.workspaceDir"`）
  等配置；Code 仍显示「暂无可配置项」空状态。
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
  （BetaV2）智能与工具页 = agent.tools 区组 + 技能区组 + MCP 区组（三组同页折叠，MCP 状态灯仍用
  `StatusDot`，`lazyConnect` 收进折叠区）；高级页（BetaV2）为「网络 / 日志 / 安全 / 危险操作」四卡
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
  `.fade-*`（内容切换）、`.collapse-*`（`max-height` 展开，工具卡片 / 折叠区块）、
  **`.page-*`（BetaV2 新增：设置页横向切换，fade + `translateX(12px)`，250ms `--ease-standard`，
  新页从右进、旧页往左退）**。
- **硬约定**：快 / 标准 / 慢动作分别为 150 / 250 / 350ms；颜色和透明度走 standard、大面积位移走 smooth、进场展开走 spring。所有过渡/动画必须走 `--transition-*` 或 `--dur-*` + `--ease-*`，不写死时长；
  `prefers-reduced-motion: reduce` 下把三个时长压到 1ms 并让位移动画立刻落位（theme.css 里已全局兜底）。
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
     `chat-right-panel-toggle.png` → `chat-right-panel-work.png`（两者自恢复、不动会话）→
     `chat-thinking-block.png`（reload 水合 seed 思考块后点开）→ `chat-quick-session.png`（切 quick 会话）→
     `chat-thinking-level.png` → `chat-model-picker.png` → `chat-tts.png`（reload，朗读按钮）→
     `chat-drag.png` → `chat-collapse.png`（点击写在 check 里，见下）→ `chat.png`（自动滚底）。
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
    在交互窗里真实点击标题栏「收起」按钮（按钮按文案「收起」定位），等 600ms 后
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
  - **主界面左栏结构 + 门控现场**（`CHAT_SIDEBAR_SCRIPT`，产物 `chat-sidebar.png`，BetaV2）：
    断言三栏重构后左栏的固定锚点全在 —— `chat.quick-item`（固定顶置「快速对话」）、
    `chat.session-list`（**有会话行**：隔离 userData 由 `seedChatTtsHistory` 种了 main 会话）、
    `data-action="chat.new-session"`；右栏开关 `chat.right-panel-toggle` 在、右栏 `.context` 默认展开
    （1120px 宽三栏并存）且 classroom「今日课程」与通用「系统状态」两卡都渲染（ContextPanel 无
    data-field 锚点，按卡头文案定位）。**含麦克风门控反向断言**：`stt` 未配置时
    `[data-field="chat.mic"]` 必须**不存在**（数到即坏 —— 钉「未配置连按钮都不渲染，不是 disabled」口径）。
    本场景不改任何状态，必须排在一切改配置 / 改会话的场景之前，保证读到出厂门控现场；
  - **右栏开关**（`CHAT_RIGHT_PANEL_TOGGLE_ACT` / `CHAT_RIGHT_PANEL_TOGGLE_CHECK`，
    产物 `chat-right-panel-toggle.png`，BetaV2）：act 内点两次 `chat.right-panel-toggle`
    走「展开 → 收起 → 展开」，三态记录暂存渲染层；check 断言三态全部成立、且截图时刻右栏
    **仍是展开的**（收起态只允许活在两次点击之间的瞬时，截图本身就是三栏默认布局的证据）；
  - **右栏模式感知**（`CHAT_RIGHT_PANEL_WORK_ACT` / `CHAT_RIGHT_PANEL_WORK_CHECK`，
    产物 `chat-right-panel-work.png`，BetaV2）：经 `window.aurora.mode.set('work')` 切模式后，
    右栏必须**整体**换成「工作目录」卡、classroom 的「今日课程」卡消失
    （「非当前模式的功能一律不渲染」）；check 收尾切回 classroom 并等课堂卡恢复，
    后续场景的 classroom 现场不受影响；
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
  - 设置页门控（BetaV2 六页 IA：每页一条 `settings-<page>.png`，general / modes / llm / voice / agent
    五页挂探针、advanced 纯截图）：`data-field` / `data-empty` 计数，各页口径 ——
    **general 页**（`SETTINGS_FIELDS_SCRIPT`）：死字段 `general.language` 必须为 0、提示条详情跟随
    `general.edgeBar.enabled` 开关、BetaV2 迁入的全局勿扰时段 `advanced.quietHours.start/.end`
    两字段必须常在（AdvancedPage 不再渲染它们，数到 >0 才是回归）；
    **modes 页**（act `SETTINGS_MODES_EXPAND_ACT` 先展开默认收起的「课程表与课前提醒」分组 +
    `SETTINGS_MODES_CLASSROOM_SCRIPT`）：ClassRoom 生效时 classroom 区组在（`watchDir` 恰好一行）、
    work 区组**整块不在**（互斥渲染，BetaV2 起 WorkSection 有真字段，数到 `modes.work.*` 即回归）、
    课前提醒组按课表节次二选一 —— `modes.classroom.preClassOpenFolder` 或
    `data-empty="modes.classroom.preClassReminder"` 必须出现其一；
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
    开着时要求终端 / 文件 / 打开三栏的详情字段都在（`terminalFields/filesFields/openFields > 0`）、
    MCP 区组必须给出「空状态（`data-empty="mcp.servers"`）或服务器行」之一，
    且不得出现这两个**预期**空状态之外的任何 `data-empty`（技能同理，`skills.disabled` 允许出现）；
    关着时只要求总开关本身仍在 —— 否则用户再也开不回来；
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
    `chat-right-panel-toggle` → `chat-right-panel-work` → `chat-thinking-block` →
    `chat-quick-session` → `chat-thinking-level` → `chat-model-picker` → `chat-tts` →
    `chat-drag` → `chat-collapse` → `chat.png`
    （`theme-chat` 排在全部交互窗场景之前，因为主题图要拍"未配置模型"的基线态；
    `chat-sidebar` 排在一切改配置 / 改会话的场景之前，它断言的是隔离 userData 的**出厂门控现场**；
    `chat-tts` / `chat-thinking-block` 的现场由 `seedChatTtsHistory` 在跑计划前种好、各自 reload 重新水合；
    `chat-right-panel-toggle` / `chat-right-panel-work` 自恢复，`chat-quick-session` 停在 quick 会话
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
- 设置页深链：`main/window-manager.ts` 的 `ensure(name, query)` / `reload(name, query)`
  给 URL / `loadFile` 传 query，仅截图场景使用，正常启动不带 query。
