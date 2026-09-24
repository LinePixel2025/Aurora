# 07 · 窗口与交互设计规格

状态：`已定稿`（v1 基线）

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
  - 悬停 → 展开面板；面板含「打开对话窗口 / 设置 / 隐藏提示条」**三个**入口；
  - 点击竖条 → 从右侧滑出完整 AI 交互窗口（桌面层，可覆盖任意应用）；这是提示条的主操作，**展开态下竖条仍是有效点击目标**；
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

### 2.3 AI 交互窗口（Chat Window）

- **完整对话**：Markdown、代码高亮、流式渲染、工具执行卡片（可展开查看细节）、附件与文件拖拽发送。
  - 实现状态（v0.6.0）：**附件拖拽已落地** —— 路径解析在 preload（`webUtils.getPathForFile`，Electron 32+ 已移除 `File.path`），
    文本提取复用分类管线的 utilityProcess 提取器（单文件上限 8000 字、单条消息最多 5 个）；提取失败的附件会在上下文里**如实标注「未读取」**，不假装已读。
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
- **侧栏（本轮）**：标题栏「历史」按钮展开侧栏，侧栏是「快速 / 会话」**双栏** ——
  「快速」栏展示快速会话（`sessionId = quick`）最近 5 条预览 + 「继续快速对话」按钮，
  「会话」栏是完整会话列表（切换 / 新建）。两栏共用**同一个窗口**，快速会话不再有独立小窗。
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
  420px 窄窗放不下时先让 `meta` 让位（隐藏或 `overflow: hidden` + `min-width: 0`），
  **发送按钮绝不能被挤出行外**（标题栏拖动区的改动不要碰输入区，见 §1 与 §5.3 的拖动探针）。
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

- 单窗口分栏：侧栏 8 项按三组排列 —— **基础**（常规 / 模式）／**AI 能力**（AI 模型 / 语音 / Skill / MCP /
  电脑操控）／**系统**（高级：日志、代理、静默时段）；当前项用分层填充 + 左侧品牌渐变指示条。
  「AI 能力」组的顺序即 `llm` / `tts` / `skills` / `mcp` / `agent`，「语音」是本轮新增的第 2 项。
- **关闭入口（v0.5.1 起）**：本窗无系统标题栏（`frame: false`），因此侧栏品牌区自担标题栏职责——
  整行可拖动（`drag-region`），右侧提供「✕ 隐藏」按钮；按 `Esc` 等效。
  按 docs/02 §2.2 约定，此处「关闭」= **隐藏窗口**（不退出应用，退出只走托盘菜单）。
- **可拖动区域（本轮补齐）**：侧栏顶部（`.sidebar-drag` 透明条 + 品牌行 `.brand`，
  `.brand` 增加 `min-height: 36px`）与内容区顶部的拖动带（`.content-drag`，高 10px）**都可以拖**；
  关闭按钮与其它交互元素挂 `no-drag`（`theme.css` 另有一条按标签兜底的规则）。
  此前只有侧栏里约 22–30px 的品牌行能拖，正是「有些能拖有些不行」最直接的原因；
  现在侧栏空白处、品牌行、内容区顶部三处都能按住拖动窗口。
- 模式页：三模式卡片选择 + 引导状态；**只渲染当前模式的配置内容**，Work / Code 显示「暂无可配置项」空状态。
- **AI 模型页（本轮重写）**：**目录行列表 + 一次只开一张编辑卡**（`editingId` 单值），不再平铺所有卡片——
  行上只有名称 + 凭据状态 badge（`凭据已保存` / `缺少凭据`）+ 是否默认 + 行操作
  （`编辑` / `设为默认` / `删除`）；当前默认行带 `.accent` 描边与左侧 3px 品牌色指示条，行 hover 用 `--fill-2`；
  `删除` 是危险操作，先就地弹确认条（`data-action="confirm-remove-provider"`）再生效；
  列表为空时是 `data-empty="llm.providers"` 的空状态卡。详情见 docs/08 §5。
- **语音页（v0.8.0 新增）**：侧栏「AI 能力」组第 2 项，页面提供总开关（`tts.enabled`）、
  默认 TTS 模型（`tts.active`）、自动朗读（`tts.autoRead`）、截断上限（`tts.maxChars`），
  以及 TTS provider 列表的**增 / 改 / 删 + 「试听」**；凭据行的展示规则与 AI 模型页一致
  （只显示「凭据已保存 / 缺少凭据」，密文不进渲染层）。字段与门控矩阵见 docs/08 §1 / §6.1。
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

- 向导式五段：欢迎 → AI 模型（baseURL / API key / 模型名 + 测试连接）→ 模式选择 → 模式设置 → 完成；模式设置可选择“稍后设置”，完成后进入托盘常驻并显示提示条（流程详见 08 §3）。
- **视觉（前端刷新轮）**：三段式布局 —— 顶部「圆点进度 + 可拖动标题栏」、中部单步内容、
  底部「上一步 / 下一步·完成」。步骤切换用**方向正确**的两套动画（`sheet-next` 下一页从右滑入、
  `sheet-prev` 反向），表单统一走 `SettingField`，错误统一 `AppToast tone="error"`，
  模型连接测试 / 目录选择等异步动作有进行中态，完成页「一切就绪」渐进入场。
- 第一步不再有「界面语言」选择器（`general.language` 是死字段，选它不生效）。

## 3. 窗口间状态机

```
托盘 ──▶ 提示条 / 交互窗 / 设置 / 引导
提示条 ──点击──▶ 交互窗（贴右缘滑出）
提示条 ──面板──▶ 打开对话窗口（聚焦 / 显示唯一主对话窗口）
```

- **规则**：交互窗是**唯一**主对话窗口 —— `WindowState.primary` 只可能是 `'chat'` 或 `null`，
  面板的「打开对话窗口」只是显示 / 聚焦它，不再存在可跳转的第二对话窗口；
  交互窗「收起」= 隐藏窗口（配置里仍只记几何，重启按记录恢复位置）。
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

方向：**克制的深色桌面界面** —— 静止卡片靠 1px 边界与留白区分层次，阴影留给悬停和浮层；品牌极光渐变只用于品牌标识、主动作和引导完成页。**明暗跟随系统**：默认深色，Windows 外观切到浅色时四窗同步切换（令牌与窗口底色口径见 §5.1「系统明暗双档」，截图验收见 §5.3）；不提供手动主题开关。

### 5.1 设计令牌

全部定义在 `apps/desktop/src/renderer/shared/theme.css`，四个窗口共用（各自 `main.ts` 里 import）。

| 类别 | 令牌 | 值 / 说明 |
|---|---|---|
| 品牌 | `--aurora-green` / `--aurora-blue` / `--aurora-gradient` | `#38d196` / `#5684ff`，渐变呼应 Aurora；**全局唯一点缀色** |
| 原始中性阶 | `--neutral-900/850/800/700/600/500/400/300/200/100/50` | `#000000` 到 `#f5f5f7`；850 为 Aurora 自有 `#0b0c0f`；仅语义层消费原始阶 |
| 底色 | `--bg-base` / `--bg-raised` / `--bg-overlay` / `--bg-glass` | `var(--neutral-850)` / 保留 `#141519` / `rgba(20,21,25,.78)` / `.72`；浅色主题另行定义 |
| 分层填充 | `--fill-1` / `--fill-2` / `--fill-3` | 悬浮层 → 卡片 → 悬停/选中，逐层变亮 |
| 分隔线 | `--border-subtle` / `--border-strong` | `rgba(255,255,255,.07)` / `.14` |
| 文本 | `--text-primary` / `--text-secondary` / `--text-muted` | `var(--neutral-50)` / `var(--neutral-300)` / `var(--neutral-500)`；正文与说明分别用 `--leading-normal(1.5)` / `--leading-relaxed(1.55)` |
| 状态 | `--status-idle` / `-running` / `-unread` / `-error` / `-ok` | 灰 / 蓝 / 橙 / 红 / 绿，**四个窗口语义一致** |
| 字体 | `--font-ui` / `--font-display` / `--font-mono` | 系统 UI 栈（`SF Pro Text` → `Segoe UI Variable` → 雅黑）；标题 `--tracking-display(-0.02em)`，分区标签 `--tracking-eyebrow(0.08em)`，数字 `--num-tabular` |
| 字号 | `--text-xs(11)` / `sm(12.5)` / `base(13.5)` / `lg(15)` / `xl(20)` / `2xl(26)` | 正文基准 `--text-base`；`--leading-tight(1.25)` / `normal(1.5)` |
| 字重 | `--weight-regular(400)` / `medium(500)` / `semibold(600)` | |
| 圆角 | `--radius-xs(6)` / `sm(10)` / `md(14)` / `lg(20)` / `xl(28)` / `pill(999)` | |
| 间距 | `--space-1..10`（4/8/12/16/24/32/48/64/96/128） | 4px 栅格；大阶用于空状态与引导留白 |
| 材质 | `--blur-thin(12)` / `--blur(24)` / `--blur-thick(40)` | `.glass` = 模糊 + `saturate(180%)` + 1px 内描边 + `--shadow-2`；不支持 `backdrop-filter` 时回落实色 |
| 阴影 | `--shadow-hairline` / `--shadow-1/2/3` | 静止卡片只用细描边与 hairline；浮层/悬停用带负 spread 的 2，模态用 3 |
| 控件 | `--control-h-sm/md/lg` / `--hit-target` | 32/40/48px 按钮高度、40px 图标命中目标；动作圆角统一 `--radius-pill`，输入框使用 `--radius-sm/md`，卡片使用 `--radius-md/lg` |
| 语义色 | `--on-accent` / `--accent-text` / `--accent-ring` / `--status-running-ring` / `--danger-*` / `--error-*` / `--warning-*` / `--ok-*` / `--overlay-scrim` | 前景、焦点、状态和遮罩只由语义层提供；状态色只用于状态，不用来装饰卡片 |
| 缓动 | `--ease-standard` / `--ease-spring` / `--ease-smooth` | 颜色/透明度用 standard，大面积位移用 smooth，出现/展开用 spring |
| 时长 | `--dur-fast(150)` / `base(250)` / `slow(350)`；`--transition-fast|base` | 后者是前者的组合别名 |

**硬约束**：既有令牌名（`--bg-*`、`--border-*`、`--text-*`、`--status-*`、`--radius-sm|md|lg`、
`--space-1..6`、`--transition-fast|base`、`--font-ui|mono`、`--aurora-gradient`）**只增不删**——
它们散落在各窗口的 scoped 样式里，删名字不会报错，只会静默掉样式。组件只引用语义令牌，不直接引用原始中性阶或另写颜色字面量。分层卡片用 `--fill-1`，悬停用 `--fill-2`，选中用 `--fill-3`；输入框用 1px 紧聚焦环。每屏一个主动作，其余使用次要或弱动作。玻璃材质用于悬浮面板，不铺满页面；静止卡片保持边界清楚、正文不降低透明度。

**系统明暗双档**：默认深色保留上表值；`@media (prefers-color-scheme: light)` 覆盖语义层及 `color-scheme: light`，基座 `#f5f5f7`、抬升面 `#ffffff`、玻璃白 `rgba(255,255,255,.92)`、主字 `#1d1d1f`、次字 `#4a4a50`、弱字 `#62626a`、描边深灰透明度 `.10/.18`。浅色状态采用可读的深蓝/深橙/深红/深绿，品牌渐变仍为 Aurora 原色；焦点、危险按钮、选区、玻璃回退及阴影成对覆盖。Electron `nativeTheme.themeSource` 常态保持 `system`；创建和系统外观 `updated` 后非透明的交互/设置/引导窗口底色与 CSS 基座一致（深 `#0b0c0f`、浅 `#f5f5f7`），提示条始终透明，所有窗口几何与用户配置不随主题改变。

### 5.2 动效规范

- 工具类（`theme.css` 全局）：`.interactive`（悬停上浮 1px + `--shadow-2`，按下 `scale(.98)`）、
  `.anim-rise`（`translateY(6px)` 淡入）、`.anim-pop`（`scale(.96)` 弹入）。
- Vue `<Transition>` 预设：`.sheet-*`（右侧滑入，提示条面板 / 抽屉）、`.rise-*`（气泡与列表项）、
  `.fade-*`（内容切换）、`.collapse-*`（`max-height` 展开，工具卡片 / 折叠区块）。
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
  ③ `--bg-base` 等于该档基座（深 `#0b0c0f` / 浅 `#f5f5f7`），且非透明窗的 `body` 背景不透明、与基座同色
  （提示条反过来必须 alpha 0，整窗保持透明）；④ 正文与基座的对比度 ≥ 4.5:1，且明暗极性正确
  （浅色不许白字、深色不许黑字）。**原生窗口底色渲染层读不到**，由同一条 `checks` 记录里的 `native` 字段断言
  （主进程侧 `themeNativeCheck` 读 `BrowserWindow.getBackgroundColor()`），`pass` 取渲染层与主进程结果相与 ——
  原有交互探针各自独立执行、不被替换。两份 `report.json` 均要求每条 `ok:true`、存在的 `result.pass:true`，
  且**配了探针的条目必须有 `result`**（`checked === true` 时 `result` 不得为空，见下面「产物」一段），
  并逐张比对文字、卡片、按钮和引导完成页。
- `AURORA_CAPTURE=<目录> pnpm dev`：把四个窗口、提示条两态、设置页各页、每窗一张双主题场景
  与各条 DOM 探针场景（面板 / 收起 / 自动滚底 / 门控 / 拖动 / 思考等级 / 模型列表与模型选择 / 真实写盘 / 提示条收尾图）
  截成一批 PNG 后退出。
  **张数与具体构成以 `report.json` 的实际条目为准，文档里不写死**：本轮（对话窗 UX 修复）是**净增**——
  新增 `chat-thinking-level.png` / `settings-llm-params.png` / `settings-llm-structure.png` /
  `settings-llm-models.png` / `chat-model-picker.png` / `chat-drag.png` / `settings-drag.png` 等场景；
  后续步骤还会继续加，因此**不要按固定张数做校验**（这里列出的名字只是当前已知条目，不是清单全集）；
  （交互窗的截图还带一条自动滚底探针与一条「收起即隐藏」探针；设置页另有「AI 模型 - 思考等级」一条探针场景
  ——它**会**额外出 `settings-llm-params.png`——以及「AI 模型 - 结构」场景（`settings-llm-structure.png`，
  探针 `SETTINGS_LLM_STRUCTURE_CHECK`：provider 行数 === 配置里的 provider 数量、点开「编辑」后**可见编辑卡恰好 1 张**、
  `providers` 为空时存在 `[data-empty="llm.providers"]`；该场景**只读配置**、自己不改写，避免与「思考等级」那条互相干扰）、
  「AI 模型 - 模型列表」场景（`settings-llm-models.png`）与交互窗的「模型选择」场景（`chat-model-picker.png`），
  最后两条在**必要时**会**临时改写配置**（`chat-model-picker` 切模型；`settings-llm-models`
  的「+ 手动添加」只改本地 draft，仅当「一个 provider 都没有」时才先造一个），并尽力恢复原状，判定口径见下面各条；
  另有「电脑操控」页的门控探针，后者不额外出图）；
  `AURORA_CAPTURE_WINDOWS=edge-bar,settings` 只截指定窗口（逗号分隔）。
  仅开发态生效；与 `AURORA_SMOKE` 同时设置时**截图优先**（自测不会执行）。
  进程退出码：0 = 全部成功，1 = 一张图都没写出，2 = **存在失败项**——
  截图/探针抛错（`ok:false`）、探针 `pass === false`，或 `checked` 为真却拿不到 `result`
  （配了探针但脚本静默返回 `undefined`，见下面「产物」一段）。
- **userData 会自动隔离（必须，不是可选）**：**多条**探针会**临时改写真实配置**——
  至少包括：门控场景（切到 Work 模式、翻 `classification.autoMove`）、
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
  - 设置页门控：`data-field` / `data-empty` 计数（死字段 `general.language` 必须为 0、
    非 ClassRoom 模式下 `modes.classroom.*` 必须为 0、提示条详情跟随开关）；
  - **电脑操控页门控**（`SETTINGS_AGENT_FIELDS_SCRIPT`）：读 `agent.tools.enabled` 复选框的**实际状态**，
    开着时要求终端 / 文件 / 打开三栏的详情字段都在（`terminalFields/filesFields/openFields > 0`
    且 `data-empty` 为空），关着时只要求总开关本身仍在 —— 否则用户再也开不回来；
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
  - **交互窗场景的全局顺序（step-06 更新）**：`theme-chat`（双主题）→ `chat-thinking-level` →
    `chat-model-picker` → `chat-tts` → `chat-drag` → `chat-collapse` → `chat.png`
    （`theme-chat` 排在全部交互窗场景之前，因为主题图要拍"未配置模型"的基线态；
    `chat-tts` 的现场由 `seedChatTtsHistory` 在跑计划前种好）。
    真正的约束只有一条：**不要在同一条场景的 `act` 里隐藏窗口**——`act` 在截图之前跑，
    窗口若先被 `hide()`，紧接着的 `capturePage()` 在已隐藏窗口上**不返回**（实测整轮卡死）。
    跨场景之间没有这个限制：每换一条场景 `captureWindows` 会重新 `manager.show()`，
    所以 `chat-collapse`（点「收起」隐藏窗口）**之后**仍有 `chat.png` 场景，并且能正常出图 ——
    「之后既做不了 DOM 操作也截不到图」是**过强的说法**，不要照抄。
    设置窗的拖动场景（`settings-drag.png`，`query: { page: 'general' }`）与既有设置页场景无顺序约束；
    设置页的 `settings-llm-models` 排在 `settings-llm-params` 之前（理由见上）。
- 截图前会等 `WindowManager.whenLoaded()`（`ensure()` 的加载是 fire-and-forget，
  不等会截到 0 字节空图），并对空图重试；连续空图直接判失败，不产出空文件。
- 设置页深链：`main/window-manager.ts` 的 `ensure(name, query)` / `reload(name, query)`
  给 URL / `loadFile` 传 query，仅截图场景使用，正常启动不带 query。
