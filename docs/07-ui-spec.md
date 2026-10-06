# 07 · 窗口与交互设计规格

状态：`已定稿`（v1 基线；**BetaV2** 起设计语言与窗口口径更新，见 §2.3 / §2.5 / §5）

## 1. 设计原则

- **轻**：默认占用最小（提示条），完整窗口按需展开。
- **顺**：所有展开 / 收起带过渡动画，不突兀。
- **聚**：视觉统一（深色主题为主、跟随系统）、状态指示一致（AI 状态灯全局同色语义）。
- **隐**：提示条与引导窗口无任务栏图标；**主界面与设置窗口显示任务栏图标**（可最小化，
  2026-09 前端重构起对齐主流 Agent Desktop），托盘仍是统一管理入口；所有窗口可一键隐藏
  （「关闭」= 隐藏，仅托盘「退出」真正退出）。
- **拖**：能拖的窗口由**显式清单**决定（`DRAGGABLE_WINDOWS = ['chat', 'settings', 'memory', 'onboarding']`，
  `useWindowDrag` composable），模板统一用 `:class="dragClass"` 挂 `drag-region`，
  不靠各窗自己记得加 class；拖动条**可见高度 ≥ 32px**（够用户抓住）。
  右侧提示条**刻意不可拖**——它 `focusable: false`，几何完全由主进程推导（见 §2.2）。
- **缩放**：所有自家窗口支持 `Ctrl + -` 缩小、`Ctrl + +` 放大、`Ctrl + 0` 复位；
  Windows 上 `Ctrl + +` 等价于 `Ctrl + Shift + =`，数字小键盘的 `+ / -` 同样生效。
  快捷键由主进程 `before-input-event` 显式处理，不依赖隐藏的 Electron 菜单。

## 2. 窗口规格

> 小节编号**只增不重排**：§2.1（AI 服务窗）与 §2.4（小 AI 交互窗 / Mini Chat）两节已随窗口删除移除，
> 其余编号保持稳定，避免打断既有交叉引用。

### 2.2 右侧提示条（Edge Bar）

- **形态**：贴屏幕右缘竖条（**收起态 8×200px**），悬停展开为感知工作台（**展开态窗口 328px 宽 × 工作区高 - 48px**），置顶。
  置顶使用 `screen-saver` 等级，并在显示、展开、收起、系统显示配置变化与
  `always-on-top-changed` 事件后重新断言；另有 10 秒 watchdog 只在原生置顶状态丢失时恢复。
  不抢焦点、不改变可穿透性；独占全屏应用与 UAC 安全桌面仍由系统优先。
  **贴附显示器与屏幕侧可配置**（v21，`general.edgeBar.display` / `general.edgeBar.position`，
  docs/08 §1）：`display` = `primary`（主显示器，默认）/ `cursor`（跟随鼠标所在显示器）；
  `position` = `right`（屏幕右缘，默认）/ `left`（屏幕左缘）。设置页「常规 → 提示条」两个下拉；
  几何推导（`computeBounds` / `setEdgeBarExpanded` / `collapseEdgeBar`）全部按该显示器的工作区
  与该侧边缘计算，窗口创建 / 显示 / 两态切换时现读配置（改完即生效，无需重启）。
- **内容（2026-10-04 自感知工作台重构；2026-10 最近理解/提醒精简）**：自感知状态总览
  （运行态 / 今日分析 / 队列 / 记忆数 / 当前文件分析进度）→ 可行动建议 → 最近理解（笔记或记录）→
  下一节课与系统摘要。
  旧版的“当前模式大卡 + 长列表系统状态”收成顶部状态摘要和底部 chips。
  「下一节」是 ClassRoom 专属摘要：`modes.current !== 'classroom'` 时整条不渲染；
  Work / Code 模式只保留通用系统摘要与模式提示，不能复用课堂课表。
- **行为**：
  - **鼠标**悬停 → 120ms 后展开面板，移开 → 面板退出后收起；标题栏右上角是「隐藏」图标，底部主操作区固定为
    「打开主界面 / 记忆库 / 设置」**三个**入口（**BetaV2**：「打开对话窗口」更名「打开主界面」）；
  - **鼠标**点击竖条 → 打开 / 聚焦主界面（**BetaV2**：chat 已是居中主界面，不再「贴右缘滑出」，见 §2.3）；
    这是鼠标下的主操作，**展开态下竖条仍是有效点击目标**；竖条的 `title` 只在收起态出现
    （展开态面板已有同名主按钮，避免原生提示浮在面板内容上），`aria-label` 始终保留；
  - **触摸 / 触控笔**没有可靠的 hover：点按竖条直接展开 / 收起面板，不打开主界面；
    展开后由用户再次点按竖条、点「隐藏」或执行面板操作显式收起，不因触摸合成的
    hover / mouseleave 自动关闭。鼠标行为不受触摸分支影响。
  - 实现状态（前端刷新轮）：
    - 两态由 IPC **`window:setEdgeBarExpanded`** 驱动（渲染层 → preload → `WindowManager.setEdgeBarExpanded`）。
      主进程把 BrowserWindow **稳定保持在展开态宿主尺寸**（328px × 工作区高 - 48px），
      两态只切换原生 `setShape`：收起态裁成贴边的 **8×200px 居中区域**，展开态裁成完整的
      328px 面板区域。这样展开 / 收起只做合成动画，不再瞬切原生窗口尺寸，也不会留下
      不可见的鼠标遮挡区；几何与 shape 算术在 `main/edge-bar-geometry.ts`（纯函数 + 单测）。
    - **展开态必须跟着长高**：面板内容（自感知总览 / 提醒 / 最近理解 / 上下文 + 3 个操作按钮）
      在 200px 里装不下，只加宽会得到「看得到面板却点不到按钮」——实测按钮落在 y=278~410、窗口仅 202px 高，
      `elementFromPoint` 全部落空。稳定宿主让展开态天然使用完整高度，
      `AURORA_CAPTURE` 的 DOM 探针继续把这条钉住（见 §5.3）。
    - 渲染层鼠标悬停延迟 120ms 展开、移开延迟 220ms 收起；面板在稳定宿主内做
      **250ms 轻滑淡入 / 淡出**（右侧 20px + opacity），退出动画结束后才收回 shape。
      触摸 / 触控笔在按下时直接切换并按同一次手势去重，合成的 click 不再走鼠标的
      「打开主界面」分支。窗口隐藏时主进程会把 shape 复位为收起态。
    - **面板内容区 320px，`right: 8px`**：面板不能贴到窗口最右缘（否则会盖住 8px 竖条，
      「展开态竖条仍可点」就不成立、竖条的悬停反馈也看不见）。328 = 320 面板 + 8 竖条。
      面板内以“自感知总览 + 最近理解”为主要信息层级；所有分组只用轻透明 surface，
      不逐项叠加 backdrop-filter。
    - **提示条不承载对话输入（2026-10）**：快速会话仍存在且可从主界面左栏固定项进入，
      但提示条面板不再挂 `useChat`、输入框或消息流。窗口始终保持 `focusable: false`，
      悬停展开不进入键盘焦点状态。
    - **感知数据按需读取**：面板展开时才 `perception.refresh()` 并按 30s 轮询；
      收起态不拉系统感知，也不读取记忆历史。
    - **分析进度条**：有文件排队或正在分析时显示当前文件的等待 / 提取 / 分析 / 写入阶段；
      空闲、未启用或知识库不可用时整条隐藏。今日分析配额仍只由上方指标表达。
    - **顶部流光（2026-10）**：实际进入提取 / 分析 / 写入阶段时，在提示条所在显示器 bounds 顶部
      显示一条可穿透的 2px 彩色渐变线与约 20px 柔光；只动画合成层属性，不做逐帧 IPC。
      光幕顶部不使用透明渐隐，必须贴满屏幕第 0 像素，不留下空隙。
      排队阶段不显示；提示条关闭、手动隐藏、勿扰、首次引导或游戏模式期间一律隐藏，
      连续文件之间保持显示，只有整个分析批次结束后才退场。入场从低位、低透明度、强模糊展开；
      持续态以竖向光幕为底，内部两条宽而软的流光带统一左→右移动，颜色分布同步流转；
      光幕缓慢呼吸和轻微漂移，退场模糊淡出约 680ms。
      叠加层通过分段遮罩、模糊、横向色散与轻微位移模拟屏幕折射，不读取或扭曲桌面的真实像素。
    - 提示条**只持久化 y**：宽高由折叠态决定、水平位置恒定贴右缘，跨启动不复用持久化宽高
      （否则收起态会继承展开态的 328px 宽）。
    - **最近理解（2026-10）**：笔记与记录按时间倒序混排，只展示最近 **5** 条；列表独立滚动，
      总数超过 5 时底部显示「更多记录」并打开记忆库。有 noteId 的行点击后经
      `awareness:presentNote` 打开记忆库、选中对应笔记并展开其日期组；无 noteId 的记录只打开
      记忆库。提示条不再调用系统默认程序打开笔记。
    - **文件自感知建议气泡（v28；2026-10 聚合）**：主进程推送可行动建议时，提示条无焦点抢占地
      展开到正常宽度。单条建议保持完整卡片；两条及以上显示「N 个文件有新提醒」折叠组，点击后
      展开可滚动的提醒列表。提醒在本次应用运行内保留，直到用户忽略；重启后不重放历史提醒。
      标题与正文允许按卡片宽度完整换行并撑高卡片，不再单行省略或两行截断；多条列表用自身滚动兜底。
      `advanced.quietHours`、提示条自身勿扰、禁用或手动隐藏时不打扰。
  - 未实现：`可穿透性可配`（尚未接入 `setIgnoreMouseEvents`）——提示条仍然整块接收鼠标事件。
  - **刻意不可拖动（本轮明确）**：提示条的 `BrowserWindow` 是 `focusable: false`
    （`window-manager.ts`），宽高与位置完全由「工作区右缘 + 垂直居中 + 折叠态」推导
    （`window-manager.ts` 里也写明了「不参与用户拖动」）。允许拖动会让**两套几何来源打架**：
    用户拖出来的位置会被下一次展开 / 收起复位，观感是「拖了没用还乱跳」。
    因此它不挂 `drag-region`，也不在 `DRAGGABLE_WINDOWS` 清单里（见 §1）。
- **可配置**：显示 / 隐藏、透明度、静默时段。提示条使用**自包含圆角玻璃**，不启用原生 Acrylic：
  Windows 的 `backgroundMaterial` 与系统窗口阴影都按整个 BrowserWindow 矩形绘制，圆角面板
  无法闭合左上 / 左下角，会露出矩形材质与阴影（2026-10-04 用户实测）。面板用高不透明度
  `--glass-fallback` tint + 自身阴影收成完整圆角；主界面仍保留原生 Mica 系统材质。
  `general.edgeBar.opacity` 只作为整窗额外透明度，不再是“有没有玻璃感”的来源。
  - 实现状态（v0.6.0；2026-10-04 退出 acrylic）：`general.edgeBar.opacity` 保存后即时应用（`setOpacity`，范围 0.2–1.0）；
    `general.edgeBar.quietHours` 由 `main/edge-bar-scheduler.ts` 每 30s 判定，**仅控制提示条自身显隐**，
    与 `advanced.quietHours`（控制主动打扰：课前提醒 / 敏感工具确认）职责分离、互不影响。
    可见性只在状态翻转时切换，避免反复 show 把用户刚手动隐藏的提示条拉回来。
    设置页里这两项跟着 `general.edgeBar.enabled` 显示（见 docs/08 §6.1）。
    **游戏模式联动（v30）**：检测到 Windows 游戏时，提示条若当时可见会自动隐藏；
    退出游戏后按当前开关与勿扰设置恢复。进入前已由用户手动隐藏的提示条不会在退出时被拉起。

### 2.2.1 自动化详情窗口（Automation Window）

- **定位**：自动化列表仍留在主界面；运行历史与新建 / 编辑改为**单例真实 BrowserWindow**
  （窗口名 `automation`），主界面不再承载这两个 Modal。
- **规格**：默认 `780×720`、最小 `560×480`、resizable、非置顶、无 parent、
  `skipTaskbar: false`、可最小化 / 最大化；关闭 / 取消 / Esc 均为隐藏，不退出应用。
- **内容**：窗口只承载一个视图：
  - `history`：运行历史 + Agent 对话回放；窗口内可切 Agent / Normal；
  - `editor`：按 catalog 驱动的新建 / 编辑表单。
- **打开链**：主界面的「历史 / 新建 / 编辑」经 `automation:openWindow` 发请求；
  主进程校验后复用同一个窗口，等待页面加载完成再经 `automation:windowRequest` 推送视图参数。
- **锚点**：保留 `automation.editor` / `automation.history-panel` / `automation.history-list`
  及 `.run-item` / `.run-time` / `.clickable` / `.detail-message`，截图场景改为直接截 `automation` 窗口。

### 2.3 主界面（Chat Window）

> **BetaV2**：交互窗（chat）升级为常驻**主界面**，本节规格按新口径改写；下文沿用「chat / 交互窗」
> 指同一窗口（窗口名不变，`WindowState.primary` 语义不变）。

- **主界面规格（BetaV2）**：默认 **1280×800**（min **1060×660**；2026-10-03 二次修订，
  用户口径「调大默认窗口大小」——此前 1120×720 / min 940×600）、resizable、
  **alwaysOnTop 关闭**（false）、place **center**；`frame: false`、几何持久化、
  关闭 = 隐藏 均不变（见 docs/02 §2.2）。
  **最小宽 1060 的来由**：左栏默认 240 + 主区下限 420 + 右栏默认 384 + 16 余量 ——
  低于它右栏就会被挤到 280（那时标签条只剩 132px 可用），「三栏各按默认宽并存」不再成立。
  **上限刻意不取更大**（如 1360×860）：`chat-stream-burst` 探针实测「主区越宽 → 消息里的
  图表画布每帧越大 → 软件光栅开销越大」，本机（ToDesk 虚拟显示 + 软件光栅）在 1360×860 下
  高密度流式的帧距掉到 300ms 级（比 2026-09-26 修掉的回归 137ms 还差），1280×800 是
  「明显变大、流式仍然跟手」的档位 —— 想更大就自己拖窗口（那是用户的取舍，不是默认值）。
  存量窗口有**两级抬底**：① 窗口管理器按 `minWidth/minHeight` 夹取恢复出来的几何；
  ② `v25 → v26` 迁移把仍小于新默认的 chat 几何放大一次（**只放大、不缩小**，见 docs/08 §1）。
  旧口径（约 420×640、alwaysOnTop 开启）自 BetaV2 废弃。
- **原生毛玻璃（2026-10-04，Windows 11 22H2+）**：主界面 BrowserWindow 使用
  `backgroundMaterial: 'acrylic'`，渲染层 body 透明，系统材质提供长驻窗口的桌面层次；
  页面侧栏、标题栏、输入区再叠加 CSS 玻璃作为可读性层。系统材质不可用或非 win32 时
  自动回退原有不透明 `--bg-base`，不得用透明窗口裸漏桌面。设置窗与记忆库同样启用原生 Mica
  （侧栏使用标准玻璃、内容区叠 `--glass-content` 可读性 tint）；引导窗继续保持
  不透明基座，避免所有窗口同时采样桌面造成 GPU 重绘与可读性问题。
  **Electron 44 起恢复系统原生最大化**：Electron 33 的 `backgroundMaterial` 会在
  `WS_MAXIMIZE` 后把 Acrylic 锁成灰底，旧版曾用工作区缩放规避；Electron 44 已修复材质
  更新链路，chat / settings / memory 恢复调用 `BrowserWindow.maximize()` / `unmaximize()`，
  最大化期间 DWM 材质与还原后的 Acrylic 都保持正常。最大化期间几何不落盘。
  提示条仍不参与系统最大化：宿主窗口固定使用展开态尺寸，两态只由 `setShape` 切换
  可见 / 可交互区域（收起 8×200px、展开 328px），多余透明区不绘制、不接收鼠标，
  原生窗口尺寸不再参与弹出动画。
- **三栏布局（2026-09 重构起）**：`sidebar(240px, 可折叠) | main(1fr) | context(384px, 可折叠、
可拖拽调宽 280–560px，2026-10-03 起 —— 此前为固定 264px)`，
  栏间用分隔而非悬浮卡片；左右栏使用 `--bg-raised` 实体面与 `--border-strong` 分界，
  和主对话区拉开层级，避免侧栏在浅色/深色主题下都只剩一层几乎不可见的 `--fill-1`。
  主区消息与 composer 居中排布（内容列最大宽 860px），
  对齐主流 Agent Desktop 的阅读动线：
  - **左栏（2026-09-30 会话三分起）**：品牌行（单色 mark + Aurora）→「新对话」按钮
    （`data-action="chat.new-session"`，**固定创建 Agent 会话**）→
    会话滚动区**分三区**（判定与工作目录见 06 §4「会话空间」，三分区工作目录互不相同）→
    **「已归档 · N」分组**（`data-field="chat.archive-group"`，默认收起；展开后的列表是
    `data-field="chat.archive-list"`，**三个分区的会话共用这一个归档分组**）→
    底部：模式徽章 + 右栏开关（`data-field="chat.right-panel-toggle"`）+ 设置齿轮。
    三个分区自上而下（分区标题 `.group-caption` 的可读性经两轮调整，2026-09-30 定稿：
    ① 撤掉 `text-transform: uppercase` + 大字距的 eyebrow 样式 —— 中文没有大小写，
    那样只会把「AGENT对话」拉得又稀又淡；
    ② 用户反馈「不够醒目」后加强为**左侧 3px 强调色竖条（`::before`）+ `--weight-semibold` +
    `--text-base` + 主文字色** —— 与 `.nav-item.active` 的指示条同一套视觉语言。
    这两条都由 `chat-session-groups` 探针钉住：`text-transform === 'none'`、
    `font-size ≥ 13`、`font-weight ≥ 600`、`::before` 宽度 ≥ 2px 且背景色非透明）：
    1. **项目对话**（`data-field="chat.project-group"`，**常显**）：按 `projects.list` 顺序的
       **项目子分组**（子分组标题 = 项目名，标题旁 `+` 钮
       `data-action="chat.new-project-session"`，新建即绑定该项目）；
       **点项目标题行折叠 / 展开该项目的全部会话**（`data-action="chat.toggle-project"`，
       标题行是可点按钮、hover 有底色；`aria-expanded` 跟折叠态；会话数徽标；
       默认**全部展开**，折叠态只存组件内（视图偏好不落配置，重启回展开态）。
       ⚠️ 旧「当前」徽标（`data-field="chat.project-current"`）已于 v25 随全局
       `projects.current` 退役整体删除 —— 探针现为「零出现」哨兵。
       折叠动效：容器 `grid-template-rows: 0fr ↔ 1fr` 过渡（无需测量内容高度）+ 内层
       `overflow: hidden`；折叠时容器加 `inert` —— 视觉裁掉了但键盘还能 Tab 进去，
       否则会 focus 到看不见的会话项上。`+` 与折叠按钮是**同行兄弟**且 `+` 带 `@click.stop`，
       否则点「新建」会顺带把分组收起来（刚新建的会话就看不见了）。
       项目增删走 `TransitionGroup`（淡入 + 轻微位移，不「啪」地插一整块）。
       会话项 = 绑定了 `projectId` 的会话（`ChatSessionSummary.projectId`）。
       **分区标题行右侧是「添加项目」钮**（`data-action="chat.add-project"`：
       弹系统目录选择框 → 加入 `projects.list`，与设置页「会话管理 → 添加项目」
       **同一条链路、同一份口径**（`shared/projects.ts` 的 `appendProject`，
       id / 默认名都只在那里有一份）；
       整区常显正是因为它是主界面唯一的项目登记入口 —— 没有项目时也不能没有它。
       ⚠️ **v25 起项目只登记不「生效」**：全局 `projects.current` 已退役，加完项目要用于
       对话，在该项目的分组头 `+` 新建会话（`chat:setSessionProject`）即绑定。
       选择框出错 / 配置被拒不再静默：IPC 仍是 `Result<string | null>`，渲染层的
       `pickProjectEntry` 把它收敛成三态（选中 / 用户取消 / 出错，`ProjectPickOutcome`），
       出错经左栏左下角的 `chat.project-notice` 提示条报出来（**不挂在 composer 里** ——
       composer 只在对话视图挂载，而左栏这个钮在子代理 / 自动化页照样能点），
       成功给一句「已添加项目「X」」。
       绑定项目已被删除的孤儿会话**归入 Agent对话区**显示（解析链上它们已按未绑定回落；
       展示层按 `knownProjectIds` 判定，2026-09-30 修 —— 此前它们既进不了项目分组、
       又被 Agent 分组按 `projectId === undefined` 挡掉，会从**左栏整条消失**）。
    2. **工作目录对话**（`data-field="chat.work-group"`）：**仅 Work 模式渲染**
       （`modes.current === 'work'`，ClassRoom / Code 无此区）；`space: 'work'` 的会话；
       标题行 `+` 钮 `data-action="chat.new-work-session"`。切走 Work 模式后该区隐藏
       （会话仍在，切回来照常显示）。
    3. **Agent对话**（`data-field="chat.agent-group"`）：`space: 'agent'` 或未标记的会话
       （含历史会话与 `main`）；**首行固定是 quick 会话**（沿用 `data-field="chat.quick-item"`
       锚点；提示条面板与其共用同一会话文件，见 §2.2）；标题行 `+` 钮
       （`data-action="chat.new-agent-session"`）与顶部「新对话」同效（都显式标 agent 空间）。
       旧「会话列表」锚点 `data-field="chat.session-list"` 挂在本区的列表容器上
       （Agent 空间是未标记会话的缺省分区，「主会话列表」的语义由它承接）。
       **Center 子分组（2026-10-03）**：`center-` 前缀会话在本区内拆成独立可折叠子分组
       （`data-field="chat.center-group"`，与项目子分组同一套视觉，默认展开，点标题行折叠；
       无 center 会话不渲染，行内 Center 药丸保留）。
       **旧会话自动折叠（2026-10-03）**：本地会话与 Center 子分组各自只默认展示最近 8 条
       （`RECENT_LIMIT`），溢出收进「更早 · N」折叠行（本地 `chat.older-toggle` /
       Center `chat.center-older-toggle`，默认收起，`aria-expanded` 跟展开态）；
       当前激活会话落在溢出里时强制可见（提到可见列表末尾）。折叠态均为组件内视图偏好，
       不落配置。
       固定顶置项其余三个不变：子代理（`chat.subagent-item`）/ 自动化（`chat.auto-item`）/
       任务（`chat.jobs-entry`）—— 前一个切**主区**，后两个开关**右栏面板**；「快速对话」不再
       是固定顶置项（它的入口随 Agent对话区下沉）。空态文案按分区显示：项目对话区空时不渲染
       空态（没有项目就没有分组），Agent对话区空时显示「还没有会话」（与归档分组都空的联合判定
       同旧口径，分区隐藏的 Work 区不参与该判定）。
  - **左栏固定项「任务」（v15 新增；2026-09-30 收拢进 SessionNav 顶部固定项组）**：
    `data-field="chat.jobs-entry"`，与 快速对话 / 子代理 / 自动化 同一组**顶部固定项**
    （旧「左栏底部固定项」的一处两式样式已随杂糅清理删除，`aside.nav` 回到单行网格）；
    角标是本会话的任务条数（复用 `.count-badge`，有在跑的用强调色）。
    点击展开 / 收起右栏的「任务」面板（`aria-expanded` 跟 `jobsOpen`）；
    面板容器锚点仍是 App.vue 的 `chat.jobs`（与按钮不同元素）。
    （左栏**顶部固定项**现为三个：`chat.subagent-item` 子代理 / `chat.auto-item` 自动化 /
    `chat.jobs-entry` 任务 —— 第一个切**主区**，后两个开关**右栏面板**；
    「快速对话」固定项已随 2026-09-30 会话三分移入 Agent对话区，锚点 `chat.quick-item` 保留。）
  - **会话归档（2026-09 新增）**：会话项 hover 时右侧浮出一枚「归档」图标钮
    （`data-action="chat.archive-session"`，单击即归档、**可逆、不弹确认**）；
    归档后该会话从主列表移入底部「已归档 · N」分组，**仍可点开继续对话**，此时主区头部给一条
    「已归档 · 取消归档」提示（`data-field="chat.archived-banner"`）。
    归档状态写在**会话文件自身**（`sessions/<id>.json` 的 `meta.archived`，见 06 §4），
    **不进 config.json**、归档本身不改 `CONFIG_VERSION`（当前版本见 08 §2）。
    已知边界：`chat:sessions` 目前**没有推送通道**，归档只在发出请求的那个窗口即时生效，
    其它窗口（主界面快速会话）要等下次拉列表才看得到；quick / settings 两个伪会话
    不出现在列表里，因此也不参与归档。（**唯一的例外**是会话删除：它有专属的
    `chat:sessionDeleted` 推送，见下条。）
  - **会话删除的跨窗口同步（2026-10-01，P2-22）**：真删除走 `chat:deleteSession`
    （删 `sessions/<id>.json` + 清内存态，**不可逆**，renderer 负责两步确认，主进程守卫
    在跑的 job，见 08 §7）。主进程**删除成功后**向所有窗口广播 `chat:sessionDeleted`，
    载荷 `{ sessionId }`（被删会话的 id）。chat 窗口订阅后重拉 `chat:sessions`；若被删的
    **正是当前打开的那个会话**，按「左栏最近一条会话（列表新的在前）回落，列表里再没有
    别的会话时 `chat:newSession` 新建并切过去」处理。`quick`（独立快速会话）**不作为回落
    目标**（它有左栏固定入口，落在它上面会让主界面标题变成「快速对话」）；`quick` 本身**会**出现在
    `chat:sessions` 与设置页的会话管理列表里（有消息时才落盘），因此也可以在设置页被删除
    ——语义是「清掉快速对话的历史」，与普通会话同一条 `chat:deleteSession` 链路。
  - **会话自动标题（2026-10-05）**：用户可见会话发出首条需求后，主进程异步生成
    6–14 字任务名并写入 `meta.title`；成功后经 `chat:sessionTitleChanged` 推送当前会话列表，
    左栏与主区标题原位更新。生成失败时仍显示首条消息的 24 字回退标题，后续发送会自动重试；
    不新增消息、不切换会话。`awareness-` / `auto-` / `-sub` 等隐藏后台会话不参与。
  - **主区**：头部拖拽区（侧栏开关 + 状态灯 + 会话标题 + 未配置徽章 + 清空（图标钮）+
    **Windows 式窗口按钮**：`最小化`（`data-caption-btn="minimize"`，真最小化进任务栏）与
    `关闭`（`data-caption-btn="close"`，= 隐藏窗口）；双击头部拖动区切换最大化）→
    MessageList → composer。**「模型 / 思考等级」两个下拉移入 composer 工具行**
    （对齐 ChatGPT / Claude Desktop；`data-field="chat.model"` / `chat.reasoningEffort` 锚点不变，
    仅位置变化），「收起」文字按钮由 caption「关闭」按钮取代（隐藏语义不变）。
  - **composer（2026-09 输入框重做，2026-09-29 减负轮，见下方「输入框规格」）**：单张悬浮卡
    （附件 chips → textarea → 工具行 → 上下文详解条）；工具行 = 权限模式 + 模型下拉 +
    思考等级下拉 +（右侧）保存瞬时提示 + 麦克风 + 停止 / 发送；旧「会话：xxx ·
    可调用 Skill 与 MCP 工具」常驻 meta 文案移除，三枚工具控件是 28px 零边框「芯片」，
    占位文案只留一句（`输入消息…`）。
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
  - **右栏功能标签 = 浏览器式多标签（2026-10-03 新增，同日升级为「可多开」）**：
    右栏顶部是一条**可多开的标签条**（`chat.ctx-tabs`，标签锚点 `chat.ctx-tab-<id>`），
    一个标签 = 一个面板实例：**文件 / 终端 / 浏览器可各开多个**（追加实例的 id 为
    `files-2` / `browser-2`…，首个实例沿用种类名），**「上下文」是单例**（任务面板 +
    模式感知上下文栏的两行网格语义逐字保留，整体收在它里面）。
    初始标签集 = **「上下文 / 文件 / 终端 / 浏览器」**（每种一个，**缺省激活「上下文」**
    —— 旧探针读的 DOM 与四个锚点逐字保留）。
    - **开新标签**：「＋」（`chat.ctx-new-tab`）弹出 `chat.ctx-new-menu`（文件 / 终端 /
      浏览器 / 上下文；「上下文」已在就切过去、不在则重建），标签总数上限 **12**。
    - **标签形制**：图标 + 标题 + 关闭 ✕（`chat.ctx-tab-close-<id>`，悬停 / 激活才显形，
      命中区 ≥ 24×24）。标题由**面板上报**：文件 = 当前目录名或文件名、终端 = cwd 末段、
      浏览器 = 页面标题（`page-title-updated`，回落主机名）、上下文 = 固定「上下文」。
      关闭终端标签 = `terminal:kill`（浏览器式语义：关标签就是关那个 shell）。
    - **溢出折叠 = 固定数量 + 「＋N」菜单**（2026-10-03 用户口径）：标签**不缩窄**
      （固定 88px），可见数量由标签条**实测宽度**算出
      （`capacity = max(1, ⌊(可用宽 − ＋/＋N 两枚按钮) / 88⌋)`）；放不下的收进
      `chat.ctx-tab-more`（＋N 按钮，弹出 `chat.ctx-more-menu` 列出被折叠标签，可切换 /
      可关闭）。**滑动窗口**：激活标签永远落在可见区（浏览器同款）—— 从 ＋N 菜单激活一个
      被折叠的标签时，窗口滑过去把它带回来。384px 默认宽下可见 2 个、拖到 720px 可见 5 个。
      **⚠️ 两枚按钮的宽度先留、标签后让**（2026-10-03 二次修订，用户实测「右栏缩到最小后
      加号按钮不可用」）：88px 是**舒适宽不是下限** —— 可用宽不够时标签一路让到
      `CTX_TAB_WIDTH_MIN = 48`，先把「＋N」「＋」的位置腾出来。右栏被挤到最小 280px 时
      标签条只剩 132px：标签 74px + 两枚按钮 56px + 间距 2px **正好放得下**；
      按钮是「被裁掉就没法点」的（标签条 `overflow: hidden` 兜底裁切），标签窄一点仍可点。
      护栏：`chat-ctx-tabs` 场景把右栏拖到 280，断言两枚按钮**完整落在可视区内**且
      `elementFromPoint` 真的命中「＋」并能点开新建菜单；核心公式另由
      `ctxTabsCore.test.ts` 的不变式覆盖（宽度 × 可见数 + 按钮 + 间距 ≤ 可用宽）。
    - **⚠️ 三键让位（2026-10-03 用户点名，逐字保留）**：标签条右端仍按 `--caption-w`
      （132px）留位；标签条**不横向滚动**（折叠替代滚动），`.ctx-tab-list` 带
      `overflow: hidden` —— 宽度过渡的瞬时溢出被**裁掉**，绝不会画到三键底下；
      两个下拉菜单一律**向下**弹出（在 48px 顶带之下），永不进 caption 矩形。
      护栏：`chat-right-tabs` 的 `captionPinned` / `captionTabOverlap` 保持绿；
      新场景 `chat-ctx-tabs` 另断言**菜单打开时**的矩形与三键无交集。
    - **面板生命周期**：文件 / 终端 / 浏览器面板**首次激活挂载、之后常驻**
      （切走只是 `display:none`）—— 切标签不再重载网页（v1 的「重挂载即重载」取舍已消）、
      不再重建 xterm；**「上下文」面板维持原 `v-if` 口径**（激活才挂载）：它没有本地状态，
      且旧探针 `jobsHiddenOnFiles`（files 下 `chat.jobs` 必须缺席）正依赖这条语义。
      **内存回收（2026-10-04 性能轮）**：隐藏的**浏览器**标签在连续 10 分钟未被激活后，
      自动把 webview 导航到 `about:blank` 释放页面进程（地址、标题、标签都保留；再次激活时
      按原地址重载，可接受一次重载）。终端保留 shell（xterm scrollback 有 5000 行硬上限），
      文件面板无本地状态；这样常驻成本由「开过多少网页」变成「最近活跃的网页」。
      **标签是窗口级的**（不是每会话一套）：面板内容仍随当前会话变化（文件面板切会话即
      重新 bootstrap、终端标签保留自己的 shell、浏览器标签与会话无关）。
      **刻意不做跨重启记忆**：恢复浏览器 / 终端标签会在启动时偷偷加载页面、拉起 shell，
      收益不抵惊扰；宽度记忆（localStorage）不受影响。
      左栏「任务」入口会先**确保上下文标签在**（被关掉则重建）并激活它，再翻面板显隐
      （任务面板收在标签里，直接翻看不见）。
    - **无标签页时的工具快捷入口（2026-10-03 新增，2026-10-04 移至右栏）**：右栏标签**全部关掉**之后
      （`ctxTabs.length === 0`），右栏正文区出现「工具」分组（`chat.tool-shortcuts`），
      四张卡片依次是右栏四种标签（上下文 / 文件 / 终端 / 浏览器，`chat.tool-open-<kind>`，
      图标与标签条 / 新建菜单同一套）。点卡片 = 打开该种类标签**并确保右栏展开** ——
      标签全关后不必再翻右上角的「＋」菜单，在右栏空态就能重开。
      本区**只在标签为空时存在**（它就是空态本身；有标签时留着只是占地方），
      位于右栏正文区、两列网格、卡片高 32px（与左栏固定项同一条命中线）。
      右栏宽度 264 → **384px 缺省**，左缘把手（`chat.ctx-resizer`）可拖拽调宽
      （**280–720px** 夹取，localStorage 记忆、双击复位；视图偏好**不进 config schema**），
      JobPanel / ContextPanel 的固定宽跟随 `--ctx-w`（折叠时收 0 的语义不变）。
      **左栏同样可拖拽**（2026-10-03）：右缘把手 `chat.nav-resizer`，240px 缺省、
      **200–520px** 夹取，`SessionNav` 的 `.nav-inner` 跟随 `--nav-w`（折叠时收 0 的语义不变），
      与右栏共用同一段拖拽实现（`startColumnResize`）。
      **两侧栏的实际渲染宽度 = `min(期望宽度, 窗口宽 − 另一侧宽度 − 主区下限)`**
      （2026-10-03 二次修订）：`App.vue` 的 `navEffWidth` / `ctxEffWidth` 算好后**内联**进
      `--nav-w` / `--ctx-w`（所以栏内子组件读到的就是实际宽度），窗口 resize 时重算；
      **主区下限 `MAIN_MIN_WIDTH = 420`** —— 起因是右栏上限提到 720 后，在 1120px 的窗口里
      拖到上限会把对话区挤成一条（量出来 ~175px，消息一列一个字），窗口看着像坏了。
      存储的永远是用户的**期望宽度**，窗口缩小时只是暂时显示得更窄，窗口变大即恢复。
      窗口最大化时右栏能真正拖到 720px。
      **⚠️ 横向锁死（同日修，用户实测「按钮整排消失」）**：`.app-shell` / `.nav` / `.context` /
      `.ctx-panes` / `.ctx-pane` 的列轨一律 `minmax(0, 1fr)`，面板内部处处 `min-width: 0`，
      文件预览的 markdown 容器另有 `overflow-wrap: anywhere`。此前用隐含的 `auto` 列轨，
      其下限是内容的 **min-content** —— 预览一份带长 URL / 长代码行的文件时整栏内容被撑宽，
      超出 aside 的部分被 `overflow: hidden` 裁掉：**正文被窗口右缘切断、目录条上的按钮
      整排推出可视区**（DOM 里还在，所以只查 DOM 存在性的探针全绿）。护栏是
      `chat-right-tabs` / `chat-file-project` 两条探针里的 `asideOverflowX` 与
      `fileToolbarInView` / `toolbarInView`（量矩形，不量存在）。
      **⚠️ 窗口按钮固定挂在窗口右上角**（2026-10-03 二次修订）：`WindowCaption` 从主区标题栏
      末尾移出，作为 app-shell 直属子节点 `position: fixed` 贴窗口右上角（与设置窗同款）。
      此前它排在主区标题栏的流式末尾 —— 主区一窄（右栏拖宽）整组按钮就被推出主区、
      **压在右栏 tab 条上**。配套两条：`.app-shell` 的 `--head-h`（48px）让主区标题栏与
      右栏 tab 条**同高**（顶带连续），tab 条按 `--caption-w`（132px）右侧让位，
      右栏收起时主区标题栏挂 `.head--corner` 同样让位（否则「清空」按钮落在三键底下）。
      护栏：`chat-right-tabs` 探针断言三键贴右缘、贴顶且**与 tab 矩形无交集**（`captionPinned`
      / `captionTabOverlap`）。
    - **「文件」tab（`FilePreviewPanel`，`chat.file-preview`）**：**小文件管理器 + 预览**
      （2026-10-03 起）。顶部路径输入与「最近预览」（localStorage，最多 8 条）保留；
      工具条（`chat.file-bar`）＝ **面包屑 + 导航**：
      - 面包屑（`chat.file-crumbs`）以根段（`chat.file-root`）起头 —— 会话绑定了项目时根就是
        **项目文件夹**（标签「项目：<名>」），未绑定时是会话空间目录（标签「工作目录」）——
        标签与 `boundaryRoot` 的回落链同源（孤儿绑定按未绑定展示）；其后逐级可点跳转，
        末段即当前目录；深路径时面包屑自己横向滚动，不挤压右侧导航按钮；
      - 导航四钮（`chat.file-back` / `chat.file-forward` / `chat.file-up` / `chat.file-refresh`）
        是 **lucide 图标按钮**（`ArrowLeft` / `ArrowRight` / `ArrowUp` / `RotateCw`）；
        此前用 `⟳ ⤴` 字形，又细又淡，且被上面那条撑破问题推出可视区 —— 两处都已修。
        **导航模型＝与浏览器同构的历史栈**：一个位置是 `{ dir, file? }`（`file` 为空即列表态），
        进目录 / 预览文件 / 点面包屑 / 上级 / 路径输入都是 push 一步（前进链在 push 时截断），
        后退 / 前进在栈里移动；预览态的「返回列表」（`chat.file-exit`）＝后退一步
        （历史里前一条正是同目录的列表态），没有可退的一步时退回当前目录的列表态。
        列表（`chat.file-list`）缺省列出根目录：目录在前、同类按名称数字感知升序（上限 500 条，
        超出标 `truncated`）；「上级」止于边界根。
        markdown 走 shared 渲染器（与消息正文同一安全基线）、纯文本、图片（data URL）、
        二进制/超限/越界如实给原因。读盘走 `preview:read`、列目录走 `preview:list`：
        路径必须在**发起会话边界根之内**（复用 file-port `resolveWithin` 的 realpath 前缀校验；
        与文件工具不同，**根不可用时直接拒绝**——渲染层主动读盘通道不退回无边界），
        文本 2 MB 超限截断、图片 10 MB 上限、前 8 KB NUL 字节判二进制（`main/file-preview.ts`）；
        列目录上限与排序在 `main/file-list.ts`。
    - **「终端」标签（`TerminalPanel`，`chat.terminal`）**：PTY 交互终端
      （@lydell/node-pty + xterm 6）。**每个标签一个 shell**（2026-10-03 二次修订：
      主进程按 `terminalId` 记账，每次 `terminal:create` 出**新的** PTY、不再按窗口复用；
      每窗口上限 6 个、超限如实报错；窗口销毁时该窗口全部 shell 一起 kill、
      应用退出统一 dispose）。渲染层 xterm 是**面板实例自己的**（组件卸载即
      `dispose` + `terminal:kill`）；面板常驻（见上条）因此天然保住 scrollback ——
      模块级单例 + 容器 detach/attach 的老做法已删除。
      标签标题取 **cwd 末段**（`TerminalCreateResult.cwd`，回落「终端」），多开时彼此可辨。
      **底色固定纯黑**（2026-10-03 用户口径：终端就该是黑的；此前跟随 `prefers-color-scheme`，
      浅色系统下拿到白底黑字，与「终端」的视觉预期不符）—— 容器 `.tp-host` 与
      xterm `theme.background` 两处都是 `#000`，viewport 由 xterm 按主题着色。
      尺寸跟随用**挂在容器上的 ResizeObserver**（rAF 合并）：左 / 右栏拖拽调宽、
      窗口缩放、标签激活（常驻面板从 `display:none` 回来）都会让容器尺寸变化，
      只挂 window resize 会让 PTY 停在旧列数。
      cwd 按会话工作目录回落链解析（**创建那一刻**解析一次）；输出按 `terminalId` 过滤后
      只推给创建它的窗口；Windows 默认 PowerShell；shell 退出显示 exit code 并可重开。
      终端是**用户的手动操作面**：不进 AI 工具面、不接确认闸门。IPC：`terminal:create /
input / resize / kill` + `terminal:data / exit` 推送（on/off 成对）。
      打包：`@lydell/node-pty` 经 electron-builder `asarUnpack` 解出（.node 不能进 asar）。
    - **「浏览器」tab（`BrowserPanel`，`chat.browser`）**：webview 内置浏览器
      （工具条 `chat.browser-bar`：后退 `chat.browser-back` / 前进 `chat.browser-forward` /
      刷新·加载中变停止 `chat.browser-reload` / 地址栏 / 主页 `chat.browser-home`；
      缺省主页 bing.com）。四枚导航钮是 **lucide 图标按钮**（`ArrowLeft` / `ArrowRight` /
      `RotateCw` ⇄ `X` / `House`，26×26 命中区）：2026-10-03 之前用的是 `‹ › ⟳ ⌂` 字形，
      在应用字体栈里又细又淡、置灰后几乎不可见（用户口径「没有刷新、上一步等按钮」），
      故整体换成语义图标并把禁用态从 `opacity 0.35` 提到「置灰但看得见」（0.55 + `--text-muted`）。
      工具条右端另有**「新建标签页」（`chat.browser-new-tab`，2026-10-03）**：
      就地再开一个浏览器标签（新标签加载主页）—— 入口不再只藏在右栏标签条的「＋」菜单里。
      地址栏只接受
      http / https（入口即拒绝其它协议），无协议输入按主机名分流：本机地址
      （`localhost` / `127.0.0.1` / `[::1]` / `0.0.0.0`）补 `http://`，其余补 `https://`；
      **webview 设了 `allowpopups`**（不带它时 guest 的弹窗请求在图层就被丢掉、到不了主进程的
      `setWindowOpenHandler` —— 「页内点链接毫无反应」的根因，2026-10-03 实测），
      但主进程对**一切**请求返回 `deny`（不会出现真弹窗），于是 `window.open` / `target="_blank"`：
      主进程在 `did-attach-webview` 上装了 `setWindowOpenHandler`（2026-10-03 二次修订）：
      http(s) 目标**另开一个浏览器标签**（推 `browser:openTab` → 渲染层 `openCtxTab('browser')`
      → 新标签加载该地址），**当前页原地不动**；其余协议（file: / 自定义 / `about:blank`）拒绝。
      旧口径是「同窗导航」（点一下就把当前页顶掉）—— 站点本来要的是新窗口，那个语义现在被如实满足。
      `webviewTag` 只对 chat 窗口开启（window-manager.ts，guest 是独立进程不破坏沙箱）。
      加载失败（离线 / 域名不存在 / 代理不可用）在面板上给出可见提示
      （`chat.browser-failure`），不静默白屏。
      **⚠️ 应用 CSP 只注入自家窗口的页面**（2026-10-03 修复，`main/index.ts`）：
      `onHeadersReceived` 此前无条件注入 `default-src 'self'` 等指令，**连 webview 里的
      外部页面一起打瘸**（内联脚本、CDN 脚本、外域样式/图片全被拒 → 白屏或半残，
      实测复现：同一段页面在注入前 `{inline:0,ext:0}`、注入后脚本被 Chromium 明确拒绝）。
      判据改为按 `webContentsId` 归属（`BrowserWindow.getAllWindows()` 里没有的就是 guest），
      与协议 / 端口 / 开发态 URL 形态无关；`file://` 预览页同样跳过（外域页面本该由
      它自己的 CSP 约束）。
      **切标签不再重载**（2026-10-03 二次修订）：浏览器面板随标签常驻，切走只是隐藏，
      webview 只在**标签关闭**时 `remove()`；标签标题跟随页面标题
      （`page-title-updated`，回落主机名）。隐藏期间页面照常运行（与真浏览器一致）。
    - **Agent 展示（`show_preview` 工具 → `preview:show` 推送）**：Agent 产出的
      HTML 报告 / 网页 / 图片可以直接在右栏看，不必把内容贴进对话。工具目标两类：
      `http(s)` 网址，或**会话边界根之内**的本地文件（相对路径按会话工作目录解析，
      `file://` 转换在主进程完成；越界即拒绝 —— 校验在 `main/tools/preview-port.ts`，
      与文件工具同一个 `resolveWithin`）。推送到达时主界面**自动展开右栏并把目标投给
      「浏览器」标签**（2026-10-03 二次修订：已有浏览器标签就**复用** —— 激活中的是浏览器
      标签就用它，否则用最近激活过的那个；都没有才新建并激活），加载目标
      （本地文件的地址栏显示原始路径而不是 file:// URL）；只接受
      `sessionId === 当前会话` 的展示请求（后台会话不该顶掉用户正在看的右栏）。
  - **右栏（模式感知上下文栏）**：栏内（任务面板之下）第一张是任务清单卡
    （当前会话最后一次 `todo_write` 的结构化清单，
    无清单不渲染）；classroom = 课堂状态卡（`data-field="context.classisland-card"`，
    非 classisland provider 时整卡不渲染；内含 `context.classisland-onclass` 徽章、
    `context.classisland-current` / `context.classisland-next` 两行、无数据时
    `context.classisland-empty`）+ 今日课程卡（`data-field="context.lesson-card"`）+
    分类流水（紧凑）+ 感知文件夹打开；work = 工作目录卡（打开 + 前往设置）+ 办公提示卡；
    通用 = 系统状态卡（时间 / 电量 / 网络 / 前台应用）。**非当前模式的功能一律不渲染**。
    课堂状态卡的数据来自桥接的快照（`05 §3.4 v3`）：上课中才显示当前科目与时段，
    下节课显示「科目 · 起–止」；字段缺失按「暂无课堂状态」降级，不编造。
    （**两张项目卡已于 2026-09-30 下线**：「会话项目」绑定下拉（`context.session-project-card`）
    与「当前项目」卡（`context.project-card`，含 `context.project-unavailable` 警示徽标）
    经用户判定为无用 —— 项目信息在左栏「项目对话」分区按项目名分组已完整可见，
    绑定入口收敛为各项目分组头的 `+`（新建即绑定），项目登记与根可用性警示迁到
    设置页「会话管理」（`projects.*` 锚点 + 警示文案，见 08 §7）；
    两卡的缺席由 `chat-agent-prod-overview` 探针回归护栏钉住。
    **「文件备份」卡已于 v0.2.4 移除**：回滚 / 清理 UI 整体迁入设置页「智能与工具」页的
    文件备份区组，主界面右栏不再展示快照列表 —— 见下文「文件备份」与 06 §11.8。）
- **麦克风（STT，BetaV2）**：composer 的麦克风按钮（`data-field="chat.mic"`）门控口径同 TTS：
  `stt.enabled && stt.active` 指向 baseUrl / model 齐全的 provider 才渲染按钮，
  **否则连按钮都不渲染**（不是 disabled）；门槛**不含 API Key**（与 `ttsReady` 同款，
  本地 whisper 类无需密钥的部署同样出现按钮，转写失败由状态提示兜底）；
  录音走 MediaRecorder → `stt:transcribe`，
  录音态用 theme.css 的 `pulse-ring` 扩散环动画。
- **完整对话**：Markdown、代码高亮、流式渲染、执行轨迹（可展开查看细节）、附件与文件拖拽发送。
  - 实现状态（v0.6.0）：**附件拖拽已落地** —— 路径解析在 preload（`webUtils.getPathForFile`，Electron 32+ 已移除 `File.path`），
    文本提取复用分类管线的 utilityProcess 提取器（单文件上限 8000 字、单条消息最多 5 个）；提取失败的附件会在上下文里**如实标注「未读取」**，不假装已读。
  - **图片附件与缩略图预览（v22 多模态输入，见 06 §3.1）**：附件 chip 上，图片类附件
    （`png / jpg / jpeg / webp / gif / bmp`）渲染一张 **24×24 的缩略图**（`object-fit: cover`、
    圆角与 chip 一致，与 `chip tiny` 同高），chip 的 `title` 同时给出文件名（没生成缩略图时给出原因）；
    缩略图取数据 URL 走 `chat:readAttachment`（主进程读盘 → 上限 `PREVIEW_MAX_BYTES`，超出 / 读取失败时
    退回原来的纯文字 chip，**不显示占位裂图**）。
    图片本身**不走文本提取**：路径经 `chat:send` 透传到内核，按提供方
    `llm.providers.<id>.modelParams.<模型 id>.vision`（v23 起按模型绑定） 开关决定「作为图片分片下发」还是「降级为一行未读取说明」；
    未开启时 chip 上仍显示缩略图（那是本地预览，与是否送给模型无关）。
    该开关**同时决定图像工具（`view_image` / `screenshot` / `clipboard_read_image`）是否注册给模型**
    （见 06 §25）—— 开启后模型除收到图片附件外，还能主动读图 / 截屏 / 读剪贴板里的图片。
- **尺寸**：见本节开头的主界面规格（1280×800 / min 1060×660 / 居中）；位置记忆与多会话能力不变。
  - 实现状态（v0.6.0）：**多会话列表已落地**（`chat:sessions` 列表 + `chat:newSession` 新建 + 切换）。
    标题优先取主进程异步生成的 `meta.title`（6–14 字任务名），生成前 / 失败时回落首条用户
    消息前 24 字；按最后消息时间倒序；
    空会话显示为「新会话」且不落空文件（首条消息才创建）。窗口默认会话仍为 `main`，老数据继续可读。
    （BetaV2：会话列表渲染于左栏。）
- **联动**：由提示条（面板按钮或点击竖条）与托盘菜单「显示主界面」打开；失焦默认不自动隐藏（可配置）。
- **视觉（前端刷新轮；BetaV2 起头部按上方三栏布局的主区头部为准）**：容器 `.glass` + `--radius-lg`；
  用户消息右对齐胶囊气泡、助手消息左对齐纯文本块；代码块独立卡片 + hover 显隐「复制」
  （按钮壳由渲染器直接产出，点击走容器上的事件委托）。
- **Markdown 渲染（P1，2026-10-02）**：正文与 Center Web 共用**同一个渲染器** ——
  `packages/shared/src/browser/markdown/`（markdown-it + `html:false` + highlight.js 子集，
  两端各自的 `markdown.ts` 已删除）。支持的语法与输出契约：
  标题（`#`→`h3`…`####`→`h6`，均带 `.md-h`）、段落 `.md-p`、无序 / 有序列表
  `.md-list(.md-ol)`、GFM 表格 `.md-table-wrap > .md-table`（含对齐、表头加粗、斑马纹、
  横向滚动）、引用块 `.md-quote`、提示块 `.md-admonition-{note,tip,warning,caution,important}`
  （GitHub Alerts 语法 `> [!NOTE]`）、任务列表 `.md-task(.md-task-done)`（只读 checkbox）、
  删除线 `<s>`、水平线 `.md-hr`、行内代码 `.md-inline`、代码块 `.code-block > .md-code[data-lang]`
  （含语言标注与 hljs 高亮，未知语言回落纯转义）、链接 `a.md-link`
  （外链 `target=_blank` + `rel="noopener noreferrer nofollow"`）、图片降级为 `.md-image-link`
  （生产 CSP `img-src 'self' data:` 会拦远程图，点击可看原图）。
- **公式与图表（P2，2026-10-02）**：数学公式 `$...$` / `$$...$$` 走 **KaTeX**
  （`trust:false` + `throwOnError:false`：非法公式以 `katex-error` 红字显示源码，不空白；
  字体与样式随包本地化，CSP 显式放行 `font-src 'self' data:`）。
  ` ```mermaid ` / ` ```echarts ` 围栏渲染为**可水合占位**（源码转义保留在
  `.md-chart-src`，天然构成失败保底），由宿主容器上的水合器
  （`createChartHydrator`，见 `browser/markdown/hydrate.ts`）按需异步渲染：
  懒加载分包（初始 bundle 不含两库）、按源码缓存（流式逐帧重建时命中缓存不重跑渲染器）、
  进入视口 200px 才渲染、单图源码上限（mermaid 100k / echarts 256k 字符，超出只展示源码）；
  mermaid 用 `securityLevel:'strict'`，ECharts 只吃 `JSON.parse` 出来的配置对象
  （模型给不了函数，无「执行任意 JS」路径），且强制 `animation:false`（流式期间不持续触发合成帧）。
  渲染失败 → `data-state="failed"` + 工具栏状态文案 + 源码块保持可见（**永不空白**）。
  每张图工具栏三枚按钮：复制源码 / 下载（mermaid→SVG，echarts→PNG）/ 大图（遮罩层，Esc 关闭）。
- **安全基线不变**：模型原文先转义、再套白名单标记，链接 scheme 走 markdown-it `validateLink`
  （`javascript:` 一律拒绝），绝不允许裸 `v-html` 模型原文。
  样式单源在 `packages/shared/src/browser/markdown/md.css`（经 `--md-*` 变量映射两端令牌），
  桌面与 Center Web 视觉一致；渲染结果按消息缓存（WeakMap + 内容比对），
  流式期间只有正在生长的消息逐帧重解析。
  工具栏位与样式（折叠态摘要行 / 展开态竖脊 + 节点）见下文「执行轨迹」；
  耗时是**渲染层观察到的本次调用耗时**，历史水合出来的行不伪造耗时。
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
- **执行轨迹（2026-10-06 请求级折叠；沿用 2026-10-01 的软胶囊 + 时间线视觉）**：
  正常完成的**一次 Agent 请求**收进一个**轨迹容器**（`AgentTrace.vue`，
  `MessageList` 在气泡内、正文 `.md` **之前**渲染；思考块与工具行都在它的展开体里）。三段式：
  - **折叠态 = 软胶囊**：`--fill-1` 底 + `--radius-sm` 圆角 + min-height 30px 的**有底色胶囊**，
    **没有描边**（悬停浮 `--fill-2`）。为什么放弃 2026-09-30 的「无盒子一行」：那一版
    affordance 近零（一条灰字 + 上下发丝线，不像可点控件）、满屏 muted 灰字没有层次
    —— 用户实测嫌丑。胶囊内从左到右：**状态图标**（运行 = 公转点 / 完成 = `CircleCheck` 绿 /
    有失败 = `CircleX` 红）→ **摘要文案**（`--text-secondary`，「<思考状态> · N 步」，
    有失败步骤补「N 个失败」）→ 右侧**总用时**（用户发送 / 首个工作事件到 done，
    包含思考、工具与图片生成；历史有可靠时间戳时照常回放，否则省略）→ chevron。
    `role="button"` 的 `.trace-head` 整行可点，`aria-expanded` 跟开合态，chevron 旋转 90°。
  - **展开态 = 左缘连续竖脊 + 节点圆点 + 限高内滚**：竖脊画在展开体上（`.trace-body::before`，
    `left: 7px; width: 1px`）；思考块与每个工具行各有一枚 7px 节点圆点骑在这条线上
    （`left: 4px`，中心 7.5px），因此"思考 → 第 1 步 → 第 2 步 → …"读起来是一条时间线。
    阅读顺序固定为 **思考 → 工具行 → 正文**（`chat-trace` 探针按 `thinkingBeforeRow > 0` 钉住）。
    **展开体限高**：`max-height: min(45vh, 480px)` + `overflow-y: auto` —— 几十步的工作历史
    不再把整页撑爆（展开瞬间的视口位移也有界），超出部分在块内滚动，可滚动时**底部渐隐**提示；
    思考块 220px 内滚是同一条思路（它先落地的）。
  - **请求级内容边界**：流式期间仍按当前逐消息轨迹实时展示；正常 `done` 后，同 `requestId`
    的助手消息合成一组。最终结论 = 最后一条正文非空的助手消息，固定显示在胶囊**之后**；
    该请求产生的所有 `displayImages` 去重后固定显示在最终结论**之后**。展开胶囊时，按时间顺序
    查看各轮思考、工具行和中间正文；最终正文不会在展开体里重复。失败 / 取消 / 轮次或预算暂停
    不套用该规则，保留原过程现场。
  - **自动折叠状态机**：`props.streaming` 的**两个边沿**各管一头 ——
    false → true（新一轮开始）把**此刻在屏的消息**登记为历史（默认折叠）；
    true → false（这一轮结束）把**本轮追加的消息**（= 到此刻还没登记过的）一并收成一行摘要。
    **收尾还有第二个触发入口（P2-20，2026-10-01）**：`props.settledRequestId`
    （`useChat` 的 `lastSettledRequestId`，done / error 分支置位、切换会话或清空时复位）。
    它负责 `streaming` 边沿**覆盖不到**的场景 —— 跨窗口观看、或中途切走再切回：
    此时本窗口全程 `streaming === false`、边沿从不触发，靠收尾信号才能把本轮轨迹与思考块收拢。
    两个入口调用**同一个** `settleRound()`（清 `thinkingOpen` + 停表 + 登记为历史），互不重复生效。
    落到渲染上就是
    `traceOpen(message) = traceOpenedIds.has(id) || thinkingTargetId === id || !historyFoldedIds.has(id)`；
    请求级胶囊默认收起，用户显式展开后保持展开；
    **历史水合出来的消息默认折叠**（整表替换时按"当时是否流式"决定是否登记为历史）；
    **用户点开就保持点开**（进 `traceOpenedIds`，跨轮不清；点收起时同时登记为"已折叠"）；
    流式期间 `thinkingTargetId` 指向的那条自动展开（否则推理藏在折叠的轨迹里看不见）。
    ⚠️ 收尾**只能按「本轮追加了哪些消息」收，不能按「哪些被打开过」收**：后者会漏掉
    **没有思考增量**的那一轮（它从没被打开过），轨迹永远停在展开态 —— 2026-10-01 用户实测的
    「模型答完了，工作过程还铺着不折叠」就是这个（回归防线：`chat-trace-fold` 探针，
    桩服务的 `SKILL_ONLY_MARKER` 分流专门造这个现场）。
  - **工具行（`AgentToolRow.vue`）**：见下条「工具行」。
    探针锚点（`chat-trace.png` / `chat-thinking-block.png` / `chat-tool-card-open.png` 依赖）：
    `.message.r-assistant .thinking`、`.thinking-head`、`.thinking-body`、`.thinking-text`、
    `.thinking.streaming .thinking-text`、`.tool-card`、`.tool-head`、`.tool-icon`（每行恰好一枚）、
    `.tool-body`（带内联 `--collapse-h`）、`.tool-args`；`.thinking` 必须仍在同气泡 `.md` **之前**。
    折叠态下展开体**仍在 DOM 里**（grid `0fr` 收成零高度、内层 `overflow: hidden`，见 §5.2）：
    `capture` 的两条探针要先读到折叠态的 `.thinking-head` 文案（含「已深度思考」）与
    `.thinking.streaming .thinking-text` 锚点，整块 `v-if` 掉会让它们在折叠的那一帧失效。
- **工具行（2026-09-30 轨迹重构）**：`todo_write` 渲染为**结构化清单行**
  （`data-field="chat.todo-card"`：状态圈（待办 ○ / 进行中 ◐ / 完成 ✓）+ 条目 + 进度摘要），
  `task` 渲染为**子代理行**（`data-field="chat.task-card"`：任务简述 + 「可读写」徽章 + 步骤数 +
  展开后的**独立对话视图** `SubagentConversation`）；其余工具为通用行（工具名）。
  行首一行固定是：状态点 → 工具图标 → 标题 → **结果摘要**（单行省略，悬停 `AppTooltip` 看全文），
  行尾是耗时与 chevron。三条硬口径：
  ① **不再有「执行中 / 完成 / 失败」文字**：状态语义交给**状态点色**（`--status-running` /
  `--status-ok` / `--status-error`）+ `aria-label`（`.sr-state` 只给读屏器），
  逐行重复的状态文案会把轨迹刷成噪声；
  ② **结果摘要上提到行首**：`outputSummary` 挨着工具名显示（没有摘要时 running 给「进行中…」、
  终态给破折号），展开体里仍有完整结果正文；
  ③ **终态一次性确认 + 底色淡出**：状态翻到终态时状态点弹一下（`aurora-confirm`，靠
  `settledIds` 只加一次类），行底色走 `aurora-tint-out`（`--dur-tint` 800ms，纯强调色；
  错误行换 `--status-error`）淡回透明 —— "刚做完"有个交代，又不留常驻高亮底色。
  运行中的行**只保留一处** `aurora-shimmer` 扫光（行首横向亮带；卡片打底扫光与
  `aurora-edge-breathe` 边框呼吸在本轮删除，keyframes 仍留在 `theme.css` 给子代理页 / 自动化页用）。
  ④ **行首标题语义化（2026-10-01 重塑）**：通用行的标题不再是裸 mono 工具名，而是
  「动词 + 关键参数」的可读短语（`toolLabelOf` 映射：`run_command` → 「运行 <命令>」、
  `read_file` → 「读取 <路径>」、`edit_file` → 「编辑 <路径>」…，未登记的工具退回工具名；
  mono 工具名保留在 `aria-label` 里，语义不丢）。行高 24 → 28px、语义图标 13 → 14px
  （密度与 WCAG 命中区的新平衡点）。
- **任务清单与子代理（右栏）**：右栏顶部有「任务清单」卡（数据 = 当前会话消息流里最后一次
  `todo_write` 的入参，随流式实时更新；无清单时不渲染）。
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
- **轨迹 / 工具行的生命周期动效（2026-10-01 重塑后）**：
  轨迹容器折叠 ⇄ 展开走 **grid `0fr ↔ 1fr` 高度过渡**（`--dur-base`，`prefers-reduced-motion`
  降级为瞬时）：终点是 `1fr` —— **每一帧都按当下内容现解**，动画期间内容再长也不会被裁掉
  （这正是实测高度动画的病根，grid 方案不量高度、从根上避开；见 §5.2 硬约定②）。
  思考块自己的开合仍走 `name="fade"`（`v-if` 挂载式，正文 220px 内滚，高度动画对它本就不适用）；
  轨迹**运行中只有一处扫光** —— 折叠胶囊下缘一条 `aurora-shimmer` 亮带（1px 高）；
  工具行运行中另有一条行首横向亮带（每行至多一条，与上面那条不同元素）；
  工具行终态一次性确认（状态点 `aurora-confirm`）+ 行底色淡出（`aurora-tint-out` / `--dur-tint`）；
  工具行进场上浮淡入并按序错开（`TransitionGroup name="tool"`，第 2/3/4 行依次 +40/80/120ms）。
- **思考块的流式动效（2026-09；2026-09-30 轨迹重构后收敛）**：流式期间只有**一处**活性表达
  —— 轨迹摘要行下缘的扫光（`AgentTrace` 的 `.trace-head.shimmer::after`），
  思考块自己的边框呼吸与卡头扫光**已删除**（同一屏多处动效会打架）；
  块头保留**公转指示点**（`.think-orbit.spin`，复用全局 `aurora-spin`）与尾部光标，
  块头显示已思考秒数；
  **块内自动翻滚**：新的思考增量到达时把 `.thinking-text` 跟到最新一行，用 `requestAnimationFrame`
  合并同一帧内的多次请求（增量密集时不再每条 delta 同步读写布局），块首次展开也补滚一次；
  用户在块内**手动上滚**到离底超过 24px 即暂停跟随（与消息区的跟随同一阈值口径
  但状态独立，绝不拽动消息区），自己滚回底部即恢复。
  块头文案恒为「已深度思考」（**不随**流式漂移：`chat-thinking-block` 探针先读折叠态文案），
  「思考中…」只出现在轨迹摘要行；请求结束的 `streaming` 边沿把思考块与整条轨迹一起收起。
- **思考块的位置与外观（2026-10-01 统一）**：它是**轨迹展开体里的第一个节点**（节点圆点骑在
  轨迹竖脊上，`padding-left: 20px` 与工具行同档）。折叠态的块头与轨迹胶囊**同一套语言**
  （状态图标 + 「已深度思考」+ 流式秒数），展开体保留 `max-height: 220px` 块内滚动。
  轨迹折叠态下整块随展开体收成零高度（grid `0fr`），**仍在 DOM 里**供探针读文案与锚点。
- **Agent 正文的流式动效（2026-09）**：正文**逐字出现**（增量直达，见 06 §16.2）+
  末尾光标 + **尾部湿润边缘**（`.thread.streaming` 下对最后一条助手消息的 `.md` 加底部渐隐遮罩，
  流式结束即摘掉）。
  **刻意不做逐字打字机**：正文是 `v-html` 渲染的 markdown，Vue 对 `v-html` 不做 DOM diff，
  按节点挂进场动画会在每个 chunk 上重放（快速流式时整块停在半透明），按帧做真打字机则要
  每帧重解析 markdown —— 遮罩方案既有「还在写」的观感，又零额外开销。
- **展开 / 收起的高度动画（2026-09 修复「动画乱跳」）**：`.collapse-*` 不再拿写死的
  `max-height: 70vh` 当动画终点 —— 它的内容实测只有约 140px（工具行展开体）与 220px
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
  flex 会压缩**可收缩的子项**：工具行展开体里唯一的滚动容器子项 `.tool-args`（`overflow: auto`）
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
  ① **内容正在持续生长** —— 流式期间思考块与**整条轨迹容器**都在长（轨迹的自动展开
  恰好命中这个场景）。轨迹容器（2026-10-01 起）改走 **grid `0fr ↔ 1fr`**：过渡终点是
  `1fr`，**每一帧都按当下内容现解**，动画期间内容再长也不会被裁掉 —— 实测高度动画的
  病根是「终点在动画开始那一刻量定」，grid 方案不量高度，从根上避开；同时保住高度
  动效（纯 fade 的展开观感是「下面整段瞬移」）。思考块仍是 `name="fade"`
  （`v-if` 挂载式 + 正文 220px 内滚，实测高度对它本就不适用）；
  ② **折叠体自己带 `max-height` / 本身就是滚动容器** —— 子代理页的「任务指令」
  （`.run-prompt` 自己有 `max-height: 160px; overflow-y: auto`，可见高度由它自身决定；
  真要给它做高度动画，就得先摘掉它自己的 `max-height` 才能量到真实内容高，
  动画会冲到 600px 级再弹回 160），已改为 `fade`。
  当前真正走实测高度动画的只剩 **工具行展开体**（`.tool-body`，内容在展开时已稳定）；
  ⚠️ 它是**唯一例外**：`chat-tool-card-open` 探针直接断言展开体的内联 `--collapse-h`
  存在、可解析为 px 且与 `scrollHeight` 相差 ≤ 2px（docs/07 §5.2 硬约定①的回归防线），
  换成 `fade` 会让那条断言 FAIL —— 所以「轨迹容器与思考块一律 fade」这条**不覆盖它**；
  工具的已知残余：行 `running` 时若正好有子代理步骤到达，动画期间会长出一行（约 19px）
  并在末尾补跳 —— 不为此改成淡入，因为绝大多数展开发生在内容已稳定的行上，
  而 19px 的一行位移不可见（改成淡入反而丢掉这个场景的高度动效）；
  **不要改回固定 `max-height`**（见 §5.2 硬约定）。
  （2026-09-30 轨迹重构前，**思考块的手动点开**也走这条动画；现在思考块与轨迹容器
  一律 `fade`，见上文 §2.3 的「执行轨迹」。）
  另外工具行的进场错位延迟（第 2/3/4 行 +40/80/120ms）此前挂在
  `.tools > .tool-card:nth-child(n)` 上、**常驻生效**，会误伤行上任何别的过渡 ——
  已收窄到只挂在 `.tool-enter-active` / `.tool-leave-active` 下。
- **图标体系（2026-09）**：渲染层图标统一走 [lucide](https://lucide.dev)（`lucide-vue-next`），
  经 `renderer/shared/icons.ts` **具名再导出**（只登记用到的，Vite 摇树）；
  工具卡按工具名给语义图标（`renderer/shared/toolIcons.ts`，未知工具退到扳手、MCP 退到拼图）；
  新图标不再手写内联 SVG（唯一例外：代码块「复制」按钮的图标 —— 它由字符串注入
  `v-html` 输出里，用不了组件，路径与 lucide 保持一致）。
- **消息区跟随最新（v0.6.0 修复「对话不会自动拉到底」；2026-09-30 修复「经常跟丢」）**：
  滚动容器是窗口自己的 `.thread`，逻辑分两层：
  `composables/stickToBottomCore.ts`（**纯逻辑、零 DOM**：状态机与帧循环，能被 vitest 的 node
  环境直接收单测，见 `stickToBottomCore.test.ts`）+ `composables/useStickToBottom.ts`（Vue 薄壳：
  向上找滚动容器、接事件源、生命周期）；`MessageList.vue` 只负责"什么算新内容、什么时候强制回底"。
  - **① 跟丢的根因（本轮修复）：跟随状态只由「真实用户输入」关闭，绝不由 `scroll` 事件关闭。**
    旧实现把「距底 > 24px」直接写在 `scroll` 事件里，而 `scroll` 事件**无法区分**是用户滚的
    还是程序自己滚的：一次流式增量让内容长高 70px，程序在上一帧写下的 `scrollTop` 此刻读数
    就超过 24px，于是被误判成"用户接管"，此后所有输出都**停在半路**，且没有任何自愈路径。
    现在只有 `wheel` / 滚条 `pointerdown`（`clientX > clientWidth` 那条缝）/ `PageUp … Space`
    这类**真实输入**才进入判定，而且还要「实际离底超过阈值」这道正向确认才算接管
    —— 用户已经贴在底部继续滚滚轮不会误关。判定是**位置**（读数）而不是"上滚/下滚"，
    所以在底部附近继续滚 → 保持/恢复跟随；停在阈值之外 → 保持接管。
  - **①′ 「输入」与「读数」之间的时间差（2026-10-01 修复「答完翻不动历史」）**：合成器线程
    先滚、主线程后收到输入事件（`passive: true` 的 wheel 尤其如此），所以输入到达那一刻读到的
    **仍是旧位置**。视口本来贴在底部时，「用户上滚」会被判成「用户还在底部继续滚」，紧接着浏览器
    派发的 `scroll` 排出一帧对齐，把这一滚**原样抹回底部** —— 每一次滚轮都被吞，界面永远钉在
    底部（用户实测：模型回答完之后翻不动对话历史）。修法是**真实输入开一个短窗口**
    （`intentWindow`，缺省 250ms）：窗口期内的读数变化按**当前位置**重新判定跟随；窗口一过，
    读数变化退回①的纯通知语义。判定永远只由真实输入**发起**，程序自己滚出来的读数变化
    开不了这个窗口 —— 旧的「跟丢」语义因此一条都没放松。回归防线在
    `stickToBottomCore.test.ts`（「视口在底部时上滚」）与 `CHAT_FOLLOW_WHEEL_UP_SCRIPT`。
  - **①″ 换容器必须连原生监听一起换**：`rebind()`（内容根 / 滚动容器被 Vue 换掉、观察者挂在
    已脱离文档的旧节点上时的自愈入口）原先只重挂两个观察者，而 `wheel` / 滚条 / 翻页键 / `scroll`
    四条**原生监听**只在 `core.start()` 那一次被消费 —— 注释写了「每次 `rebind()` 都重新挂一遍」、
    实现里漏了。漏掉的症状与①′同款（滚不动），但成因完全不同：**没有任何人收得到用户意图**。
    2026-10-01 补齐（`rebind()` 拿存下的 `intentCallback` 重挂）。
  - **①‴ 意图窗口期内对齐帧静默 + 贴底补齐只认「朝底」的输入（2026-10-01 修复「无法用滚轮滚动」）**：
    ①′ 的窗口只解决了「判定被旧读数骗」这一层，还有**两层竞速**会吞掉用户刚滚出去的视口：
    其一，`stick()`（展开折叠体触发 `restick()`）留下的结算帧插在「意图已到、`scroll` 未到」
    之间跑 —— 此刻 `following` 还没被窗口重判翻掉，一帧对齐就把视口按回底部，随后到来的
    `scroll` 读到的又是"贴底"，重判翻不了案；其二，意图瞬间执行的「贴底修正」
    （`snapIfNearBottom`）—— 那一刻读数还是贴底，等于把用户即将发生的上滚**预先吸回去**，
    小步长滚轮（触控板 / 高分辨率滚轮，单步 < 24px 阈值）连重判都判不出去，逐次被吞。
    修法：**窗口期内（`now() < intentDeadline`）`runFrame` 不写 `scrollTop`**（真实输入优先，
    窗口由重判与过期收口；核心文件头 ①″）；**补齐收窄为 `pointer-release` 与向下滚轮**
    （`shouldSnapOnIntent`：向上滚轮 / 按键 / 滚条按下不补，拿不到方向保守不补）。
    回归防线：`stickToBottomCore.test.ts` 的两条竞速用例 + `chat-trace-wheel` 探针
    （CDP 真实滚轮，见 §5.3）—— **JS 合成事件测不到原生滚轮管线**，这是它们必须并存的理由。
  - **② 每帧自愈到"真的到底"**：`scrollTop = scrollHeight - clientHeight` 用的是**写那一刻**的
    读数，而 DOM 变更发生在布局之前 —— 同一帧里内容可能又长了一截（markdown 块 / 工具行
    70–500px）。因此每帧对齐后**再读一次**，仍有偏差就补帧（一帧最多 3 次，防死循环）；
    只要高度还在变就继续排帧，**不再**用旧实现的「连续两帧 `scrollHeight` 不变就停」
    （那恰好会在内容持续增长时提前收工，是"跟到一半就停"的第二个来源）。
    自终止靠「连续两帧既没动作也没长高」，另有 `maxSettleMs = 1500ms` 兜底（每次 mutation 续期），
    不留常驻 rAF。
  - **信号与兜底**：信号有 `MutationObserver`（消息 DOM 的增删与文本变更 —— 流式是原地改
    `content`、工具行是插节点，**这才是可靠信号**）、`ResizeObserver`（内容根与容器尺寸）、
    `transitionend`（高度过渡结束）、`visibilitychange` / `focus`（隐藏恢复），四条合并到
    "每帧最多滚一次"；此外还有一条**心跳兜底**（`startStructureGuard`，2026-09-30 实测后补）：
    只做两次属性读（`scrollHeight` / `scrollTop`），发现内容变高或被挪动就补一次对齐。
    **节拍按活跃度分档（2026-10-04 性能轮）**：最近 1.2s 内有 DOM 变更 / 尺寸变化 / 用户滚动 /
    程序贴底时走逐帧 rAF；空闲时降到 **250ms 一次**，避免聊天窗口开着就永久 60fps 空转。
    结构校对也不再每帧 `findScroller`（那会每帧调 `getComputedStyle`）：只要缓存的容器
    仍连接且 `contains(contentEl)` 就直接复用，只有错位时才重新解析。
    为什么必须有它：实测出现过一个形态 —— `MutationObserver` 的回调**会停**（同一节点上另挂
    一个独立观察者能收到全部变更，而应用自己那个既没断开、也没判成脱离文档、更没抛错），
    纯事件驱动在它面前没有出路；心跳让"无论事件层怎么失灵，下一帧都自我纠正"。
    同一条巡检还负责结构校对：引擎读到的容器必须是内容根**当下**的真实祖先，错位就重新绑定
    （`rebind()`）；引擎的读数与写入本身也是**现查**（`resolveScroller()`），不缓存元素引用 ——
    缓存引用在 DOM 被重建后会变成死节点（读数为常数、写入无效），症状与"跟随被关掉"一模一样。
  - **浏览器滚动锚定已关闭**：`.thread { overflow-anchor: none }` —— 锚定会在内容长高时
    自行调整 `scrollTop`，与我们的逐帧对齐是两套互不知情的补偿，叠加就是"偶尔停在半路"。
  - **用户接管**：上滚（真实输入）后离底超过 24px 即暂停跟随，此时右下角浮出「↓ 回到最新」胶囊；
    真实输入把它滚回底部、点胶囊、或**自己发一条消息**（发完必然想看到回复）都会恢复跟随。
    内容缩到**不足一屏**时跟随自动恢复（没有可滚动距离，"暂停"不再有意义，
    免得胶囊永久挂在右下角）。接管期间引擎**不写** `scrollTop`（不会把正在读历史的人拽走）。
  - 判定与滚动都只读 `scrollHeight / scrollTop / clientHeight`，不引入新依赖，也不改 props / 插槽契约。
  - **为什么不只用 `ResizeObserver`**：交互窗的 `.thread` 是定高 flex 列，`MessageList` 根节点带
    `min-height: 100%`，内容超过一屏后根节点的盒子被钉在一屏高、多出来的部分按**溢出**渲染 ——
    元素尺寸不再变化，只监听尺寸会漏掉每一次流式增量（若 `.thread` 是普通块级容器，其根节点会跟着内容长高，
    尺寸变化本身就能被观察到，因此不会复现这个问题）。`AURORA_CAPTURE` 的自动滚底探针正是靠"内容确实比窗口高"这条守卫把这个坑钉住的。
- **关闭 / 最小化 / 最大化（2026-09 重构起；2026-10 补齐最大化）**：标题栏右侧是 Windows 式窗口按钮
  （`WindowCaption.vue`，顺序对齐 Windows 通用布局：最小化、最大化、关闭）——
  「最小化」真最小化（进任务栏，可从任务栏恢复），「最大化」走 `window:toggleMaximize`
  （图标按 `WindowState.maximized` 在「最大化 / 向下还原」间切换；主进程在 maximize / unmaximize
  事件时广播，覆盖拖动区双击这条不经 `toggleMaximize` 的原生路径），
  「关闭」= **直接隐藏窗口**；
  正在进行的流式回复**不会**因此中止（`hide()` 不触碰 `chat:abort`，见 02 §2.2「关闭 = 隐藏」）。
  双击头部拖动区 = 切换最大化（最大化时几何不落盘，还原后按原尺寸恢复）。
- **侧栏（2026-09 重构起）**：三栏布局的左栏（240px，可折叠）常驻承载品牌行 / 新对话 /
  「快速对话」固定顶置项（点击切 quick 会话）/ 会话列表 / 底部操作；
  快速会话（`sessionId = 'quick'`）只由主界面左栏固定项进入，不再与提示条面板共用 ——
  旧的「标题栏『历史』按钮展开双栏侧栏」口径废弃。
- **思考等级（本轮）**：输入区（`.composer-bar`）含「思考等级」下拉
  （`data-field="chat.reasoningEffort"`，`ThinkingLevelSelect.vue`），读写**当前生效模型**的
  `llm.providers.<active>.modelParams.<modelId>.reasoningEffort`（v23 起随模型绑定，
  `modelId` = 该 provider 的 `model`；**换模型即换等级**，同一 provider 的不同模型各有一套值）：
  `auto` = **不下发**该参数（映射成 `undefined`），
  `low` / `medium` / `high` 原样透传。**设置页与对话窗输入区两处入口写的是同一个字段，没有第二份来源**，
  **不按会话覆盖**（等级是模型级参数，会话级模型只决定用哪个模型）；改完对**下一次**请求生效，无需重启。
  无可用 provider 时控件**不隐藏**，而是 `disabled` + 提示「先在「设置 → AI 模型」里配置并选中一个模型」
  ——用户抱怨的正是「找不到按钮」，在没有模型时彻底藏起来会让同一个抱怨复现；
  禁用态至少是「找得到但用不了」，并且指向了修复路径。
- **模型选择（本轮）**：输入区（`.composer-bar`）与「思考」并排还有一个「模型」下拉
  （`data-field="chat.model"`，`ModelPickerSelect.vue`），选项来自**当前生效 provider** 的
  `llm.providers.<active>.modelList`；**选中写入的是「本会话的模型覆盖」**
  （`chat:setSessionModel` → 会话文件 `meta.llm = { providerId, model }`，docs/06 §3），
  下一次请求生效（主进程每轮经 `createForSession` 现解析，无需重启）；
  菜单里多一项「跟随全局」用于**清除覆盖**（回到全局 `llm.active` 的 `model`）。
  设置页「AI 模型」页签仍写**全局默认**（`llm.providers.<active>.model`）——两处**不是同一份数据**：
  全局是「默认」，会话覆盖是「这个会话用它」，解析链只有一级、未覆盖即跟随全局。
  **模型页与对话窗读写的是同一份候选列表**：模型页维护 `modelList`、对话窗从同一份列表里选，
  没有第二份来源。当前 `model` 不在列表里（或列表为空）时，下拉把当前值显示为
  「`<model>`（不在列表中）」而不是悄悄替换成别的模型。
  **打开编辑卡时，当前生效模型总会占一行**（渲染层重建草稿时把 `model` 补进候选列表），
  所以引导页建出来的 provider（落盘的是 `modelList: []`）也能就地配置它的模型级参数；
  落盘时 `modelList` 仍会被归一为「候选列表 ∪ {`model`}」。
  会话左栏行在**覆盖态**显示模型小徽标（跟随全局时不显示 —— 靠它看出「这个会话绑了模型」）。
  无可用 provider 时**与思考等级一样**「不隐藏、只 `disabled`」，并给出同一句去设置页的提示。
- **权限下拉的换行口径（本轮）**：菜单项的说明文字**允许换行** —— 长文案的实际容器
  `.perm-item-body` 必须有 `white-space: normal`（祖先 `.composer-bar` 的 `white-space: nowrap`
  是**继承**属性，不覆盖它文字就会横向画出卡片）。完全权限档的非确认态文案是**两短句**
  （不再弹卡 / 可访问项目根外），例如「所有敏感操作不再询问」「可访问项目根外路径」；
  `pendingDanger` 那支「再点一次确认：项目根内的敏感操作不再询问」保持原样。
  **探针按 `textContent` 子串断言『完全权限』『再点一次确认』，改文案时必须保留这两个子串。**
  `.composer-bar` 的控件顺序（2026-09 输入框重做后）：**权限模式** → **模型** → **思考**
  → 弹性空隙 → 瞬时提示 → 麦克风 → 停止 / 发送；
  空间不足（右栏展开 / 窗口缩窄）时先让 `meta` / 提示文本让位（隐藏或
  `overflow: hidden` + `min-width: 0`），**发送按钮绝不能被挤出行外**
  （标题栏拖动区的改动不要碰输入区，见 §1 与 §5.3 的拖动探针）。
- **窗口拖动（本轮）**：标题栏 `.head` 走统一的 `useWindowDrag('chat')`（`:class="dragClass"`），
  按钮区挂 `noDragClass`；详见 §1 与 §5.3 的拖动探针。
- **Center Web 的对齐口径（v0.3.3，docs/12 §10）**：网页控制台是这套主界面的**同语言远端版**，
  共用面与分叉面都定死在这里，避免两边各自漂移：
  - **共用（唯一实现，两端引用）**：设计令牌 / 暗浅主题 / `aurora-*` keyframes / 过渡预设 /
    原子类（`@aurora/shared/browser/theme.css`）；Markdown 渲染器与 `md.css`；
    语义图标查表（`toolIcons` / `toolLabels`）与 `icons`；吸底状态机
    （`stickToBottomCore` / `useStickToBottom`）；实测高度动画钩子（`useCollapseTransition`）。
    改这些**必须同时核对两端**（与改 `md.css` 同规矩）。
  - **分叉（有意，别再合并）**：`.vue` 标记结构（shared 走 tsc 构建、不处理 SFC）；
    桌面端三栏是 `会话导航 | 主区 | 上下文面板`，网页端是 `客户端列表 | 会话流 | 控制面板`；
    桌面端标题栏是 Windows caption 按钮，网页端是浏览器页签。
  - **必须逐条对齐的行为**（探针同判据）：用户消息右对齐胶囊 / 助手左对齐纯文本；
    流式只在末尾加光标；轨迹容器三段式（软胶囊摘要 + 竖脊时间线 + 思考 → 工具行 → 正文
    阅读顺序）；思考块块头恒为「已深度思考」+ 流式秒数、220px 内滚、rAF 跟随；
    工具行状态三态 + 语义图标 + 结果摘要上提 + 展开体走实测高度动画；
    轨迹容器与思考块的折叠一律 `fade` / grid `0fr↔1fr`（只有 `.tool-body` 用 `--collapse-h`）；
    确认卡与提问卡同一条待办栏（先到先得、幂等）；固定位 / 门控口径
    （未配置 STT 连麦克风按钮都不渲染）。`data-field` / `data-action` 命名两端同名
    （`chat.mic` / `chat.ask-user-card` / `chat.trace-live` / `chat.task-card` / `chat.todo-card` …）。

### 输入框规格（2026-09 输入框重做；2026-09-29 减负轮）

目标是对齐主流 Agent Desktop（ChatGPT / Claude / Cursor 类）的输入动线：卡内自底向上依次是
**输入区 → 工具行 → 上下文详解条**，整体仍是单张悬浮卡（`.composer-box`），
宽度与消息列同轴（860px 中轴）。

- **输入区**：`<textarea>` 自动增高（`rows=1`，高度由 `autoGrow()` 按 `scrollHeight` 钉住，
  1 行起步、**200px 上限**后内部滚动）。CSS 上刻意**不设** `min/max-height` 与 `resize`：
  手动拖动高度会与自动增高互相打架，结果是「发完消息输入框还保持着刚拖出来的高度」。
  `Enter` 发送、`Shift + Enter` 换行（`Ctrl + Enter` 与 `Enter` 等价，兼容老习惯）。
- **占位文案只留一句**（减负轮）：`输入消息…`（流式中 `正在回复中，可继续输入…`）。
  它**不再当说明栏用** —— 旧版把「Enter 发送 / Shift + Enter 换行 / 输入 / 调用命令与技能 /
  可直接拖入文件」整串塞进占位，长度超过一行，而 textarea 的高度由**内容**决定
  （空内容 = 一行），换行后的第二行会被直接裁掉，用户看到的是「可直接拖入文」这种断句。
  键位说明（`Enter` 发送 / `Shift + Enter` 换行）**不再常驻**工具行 —— 原先挂在那里的
  `.composer-hint` 已移除，键位与其余能力（`/` 命令、拖入文件）一并只留在 textarea 的
  `title` 悬浮提示里；工具行右侧只剩瞬时提示 `.picker-hint`（保存 / 切换成功那类自灭文案）。
  流式中按 `Enter` 会给一句 2 秒自灭的提示（发送按钮同时是 disabled 的，两处口径一致）——
  `useChat.send` 在流式期间直接返回，若不提示就是「敲了 Enter 没反应也没说法」。
- **工具行**（左 → 右）：**权限模式** + 模型下拉 + 思考等级下拉 + 弹性空隙 +
  （右侧）瞬时提示 + 麦克风（STT，门控口径不变）+ 停止（流式中）+ 发送。
  压缩顺序与旧口径一致：先让瞬时提示文本让位，模型下拉可收缩到 72px，
  **发送按钮绝不能被挤出卡外**。
- **三枚「芯片」的视觉口径**（减负轮）：权限 / 模型 / 思考都是 `--control-h-xs`（28px）高、
  `--radius-pill` 圆角、**静止态零边框零底色**（只有文字与原生箭头），悬停 / 聚焦浮一层
  `--fill-2`。三者必须逐字对齐才像同一条工具带上的控件；此前的 40px + 逐枚边框
  （三枚各带 1px 边框的 40px 控件）把输入卡顶成了一条设置工具栏，是「太丑 / 元素冗杂」的主因。
  28px 仍高于 WCAG 2.2 SC 2.5.8 的 24×24 命中下限（`chat-hit-targets` 探针按 24 判），
  发送 / 麦克风保持 32px。
- **权限模式**（`ComposerPermissionSelect.vue`，`data-field="chat.permission"`）：
  **三档**（v13，语义见 06 §11.2）—— **只读**（`readonly`，`data-field="chat.permission-mode-readonly"`）＝
  写文件 / 执行命令类工具**根本不注册**给模型（设置页摘要写「只读模式：仅注册只读工具（不含写入与命令）」）；
  **变更前确认**（`confirm`，`data-field="chat.permission-confirm"`）＝ 敏感工具
  （写文件 / 执行命令 / MCP 工具 / 改设置）在项目根内直接执行、越界才弹确认卡；**完全权限**
  （`auto`，**出厂默认档**，`data-field="chat.permission-full"`）＝ 所有敏感工具直接执行、
  不再弹确认卡；项目根只保留为缺省工作目录。
  写盘时**同时写两个字段**（`agent.permissionMode` = 选中档，`advanced.confirmSensitiveTools` =
  `档位 !== 'auto'`）：后者是老开关，两者由 `resolvePermissionMode()` 合成生效档位，
  分开写会出现「界面选 confirm、实际生效 auto」的错位。与设置页「Agent 设置」页读写的
  **是同一份配置**，没有第二份来源。
  三个细节是有意的：
  - 放宽权限的档位（完全权限）用**警示色常驻**（不是一闪而过的 toast）——闸门开着这件事必须一直看得见；
  - **放宽是两段式**：点「完全权限」只把该项翻成「再点一次确认」，第二下才提交 ——
    一个误点不该把闸门摘掉；**收紧（只读 / 变更前确认）单击即生效**（收紧不需要摩擦）；
    **已经是完全权限时点它只收起下拉**（那一档这时没有可放宽的东西，弹「再点一次确认」
    只会让人以为要再放一次权）。
    AI 的 `set_setting` 对 `agent.permissionMode` 与 `advanced.confirmSensitiveTools`
    两条路径**一律拒绝**（见 06 §11.2）。
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
    2026-10-03 新增两条内置命令：`/init` 初始化 AGENTS.md（探查当前项目并生成 / 补全
    指南，走正常发送链，指令正文由主进程拼进本轮 extraContext，06 §6）、
    `/compact` 压缩上下文（选中即调 `chat:compact`，把历史压成摘要写进 `meta.compact`，
    06 §4；**不走发送链**——压缩没有流式回复，走了输入区会永远停在「流式中」）；
  - 技能（选中**只补全**成 `/技能名 `，焦点留在输入框）：来自 `skills:list` 里 `enabled`
    的技能，与内核 `parseExplicitInvocation` 认的 `/` 前缀调用是同一套（06 §6）。
    键盘：`↑` / `↓` 移动高亮、`Enter` / `Tab` 确认、`Esc` 关闭（输入内容一变即重新打开）。
    浮层打开时 `Enter` **属于浮层**，不会把半截命令发出去。过滤是**前缀匹配**而非模糊匹配：
    命令名都很短，模糊匹配会让 `/s` 命中一堆不相干的技能，反而要多按几次方向键。
    `@` 提及、MCP 工具补全**仍未实现**（技能与命令之外没有第二类候选）。
- **上下文详解条**（`ComposerContextBar.vue`，`data-field="chat.context"`）：卡片最底部一条细状态栏，
  折叠态显示 `上下文 <已用> / <窗口> <进度条> <百分比>` + 本会话累计；2026-10-03 起紧凑文案里的
  命中片段改为**平均缓存命中率**（`平均缓存命中 N%`，分子分母都是**累计**，06 §21.4 ——
  替换早先的「本次缓存命中」单轮口径；探针锚点 `chat.context-usage` 的文案因此含「平均缓存命中」）。
  点开在上方弹出明细（`data-field="chat.context-detail"`）——本轮输入 / 上下文窗口 / 模型 /
  **平均缓存命中**（绝对数与占比）四行。
  - **分子**：最近一轮的 `promptTokens`（`usage` 事件，06 §16.2）——就是这一轮真实送进模型的上下文长度；
  - **平均缓存命中**：`totals.cachedTokens / totals.promptTokens`（累计口径，含种子恢复的部分，
    06 §21.4）——按**会话**算，跨切换、跨重启连续。provider 是否回传缓存字段以
    `latest.cachedTokens` 是否缺省判定，**未回传时整项不显示** ——
    既不写「平均缓存命中 0%」也不占位：那会把「provider 没回传」显示成「一条都没命中」，两者必须可区分；
  - **分母**：当前生效模型在 `llm.providers.<active>.modelParams.<modelId>.contextWindow`
    （v11 新增，**v23 起按模型绑定**，08 §1；`modelId` = 该 provider 的 `model`）。**0 = 未知**，此时
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
  设置页「会话管理 → 项目」区组的字段锚点沿用**配置路径原文** —— `projects.name` / `projects.root` /
  `projects.repick`（「重新选择目录」）/ `projects.remove`（删除）/ `projects.add`（添加项目，
  走 `project:pickDirectory` 弹系统目录选择框），列表为空时是 `data-empty="projects.list"`；
  根不可用的项目行另有 `data-field="projects.unavailable"` 的「目录不可用」徽标 + 警示条。
  ⚠️ 旧 `projects.current`（「设为当前」按钮，当前项显示「已启用」）已于 v25 退役。
  ⚠️ `openPath` 的 `kind: 'project'`（「打开当前项目目录」按钮）同轮退役：
  全局 current 不复存在，该入口删除（`kind: 'workspace'` 保留，按 06 §5.1 回落链取目录）。
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
  ⚠️ **2026-09-30 现状：这一条在同一批改动里 FAIL**（`rows: 0` + 空态文案
  「还没有文件备份…」，而 `list` / `prune` / `refresh` 都在）—— 夹具种下的快照没有被列表读到，
  属**快照夹具 / 设置页**范围（与本轮渲染层与自动跟随无关：设置窗口的 DOM 与探针都没被本轮改过）。
  同批还有 `settings-general.png` 的 check 抛异常（`ok:false`，拿不到结果）。两处都留给后续排查。
  任务面板（v15 新增）：右栏容器 `chat.jobs`（`jobsOpen` 为 false 时整块不渲染）、面板自身
  `chat.job-panel`、每条 `chat.job-item`、「继续」`chat.job-resume`（**仅 `paused` 时渲染**）、
  「取消」`chat.job-cancel`、左栏入口 `chat.jobs-entry`（角标是它内部的 `.jobs-count`，
  不另设锚点）；面板空态**没有** `data-empty` 锚点（见上文右栏条目的理由）。
  钉住它们的探针场景见 §5.3：`chat-job-panel.png`。
  钉住它们的探针场景见 §5.3：`chat-composer-slash.png`（浮层 + 权限钮文案 + 上下文条 +
  **textarea 自动增高** 36px→178px→36px，含 200px 上限与「上限后改为内部滚动」；
  1 行高度 = 行高 20.25px + 上下 padding 8px×2）、
  `chat-composer-permission.png`（权限下拉三档：只读 / 变更前确认 / 完全权限三项都在；
  act 先把档位显式切到 `confirm`（出厂默认是 `auto`，「放宽」只在还能放宽时存在）→
  点「完全权限」一次只翻成「再点一次确认」、**配置一动不动**（`settings:get` 回报
  `agent.permissionMode` 仍是 `confirm`、`confirmSensitiveTools` 仍是 `true`）→
  点第二次才真正放宽，配置落成 `auto` + 老开关 `false`，下拉自行收起）、
  `chat-permission-readonly.png`（v13 只读档：切到 `readonly` 后触发器与菜单项都显示「只读」、
  `settings:get` 回报 `permissionMode === 'readonly'`，收尾还原成**出厂默认档 `auto`**
  并断言触发器回到「完全权限」）、
  `chat-composer-flyouts.png`（浮层互斥 + 几何不相交 + 发送键 `elementFromPoint` 命中自己）、
  `chat-archive.png`（归档分组）；
  以及 `chat-stream.png`（**唯一一条 DOM 级端到端**：capture 在跑这一段前竖起本地桩 LLM 并把
  `llm.active` 指向它 → 探针把提示词写进 textarea、点发送 → 断言助手气泡里出现了桩服务的回复文本、
  且上下文条显示**真实 token**（`512 / 128k`）与**平均缓存命中率**（`平均缓存命中 100%`，
  `data-field="chat.context-cache"`；桩数据 cached == prompt，无论累计几轮占比恒为 100%）
  而不是「暂无用量数据」。
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
>
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
  见 docs/13 §7），回看那次对话的唯一入口是自动化详情窗口的历史视图。
- **骨架**：根锚点 `data-field="automation.page"`，列表容器 `data-field="automation.list"`；
  顶部工具行 = 双 tab「Agent Mode」（`data-field="automation.tab-agent"`）/
  「Normal Mode」（`automation.tab-normal`）+ 右侧「历史」（`data-action="automation.history"`）
  与「新建」（`data-action="automation.new"`）+ 「返回对话」图标钮（`data-action="automation-back"`）。
  **列表按当前 tab 过滤**（Agent tab 只列 Agent 定义）；
  **页头与两个 tab 同行**（`flex-wrap: wrap`，窄窗口下动作组整体折行而不是重叠），
  页头不再有整句副标题 —— 说明改挂在标题右侧的说明标记上（悬停出 `AppTooltip`，§5.4）。
- **卡片**（`automation.item-<id>`）：启停开关（`data-field="automation.toggle"`，写定义的 `enabled`）+
  名称 + 模式徽章（**带语义图标**：Agent = 机器人、Normal = 闪电；内置项用中性「内置」徽章）+
  **次数徽章**（v0.2.8，`data-field="automation.runs"`：上限 > 0 时显示 `3/10` 形态，
  **用尽（已调用 ≥ 上限）转警示色**（加 `.exhausted` 类）并换一条悬浮说明
  「调用次数已用尽，已自动停用；提高上限或重置计数后可再次启用」；上限 0 / 缺省 = 不限，
  不渲染这枚徽章 —— 与「不渲染而不是 disabled」同款门控口径，见 docs/13 §3.1）+
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
- **编辑器视图**（独立 `automation` BrowserWindow，`data-field="automation.editor"`）：
  由主界面的「新建 / 编辑」经 `automation:openWindow` 打开，单例复用。
  字段自上而下（**全部走「左标签 / 右控件」两列网格**：
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
  **「调用次数」一行**（v0.2.8：上限数字输入 `data-field="automation.max-runs"`，**0 = 不限**；
  编辑既有定义时在旁显示「已调用 N 次」+「重置计数」按钮
  `data-action="automation.reset-runs"`（计数为 0 时 disabled）—— 点击只改草稿，
  保存后生效；保存回传 `maxRuns` 与 `runCount` 两个字段，**编辑既有定义不再无条件
  `enabled: true`**（沿用原启停状态），口径见 docs/13 §3.1 / §11）→
  Agent Mode 的「任务指令」textarea，或 Normal Mode 的**操作组件列表**
  （每项 `data-field="automation.action-<索引>"`：行首序号圆点 + **组件胶囊组**（图标 + 组件名，
  点一下换组件；`available: false` 的组件**不出现**而不是 disabled）+ 移除钮 + 参数网格；
  「添加操作」`data-action="automation.add-action"`，**上限 10 个**，到顶即 disabled，
  区组头右侧显示 `n/10`）。
  底部「取消」（`data-action="automation.editor-cancel"`）/「保存」；关闭路径 = 窗口关闭钮 /
  「取消」/ **Esc**，均为隐藏窗口。历史视图里正展开某条运行回放时，第一下 Esc 只收回放。
- **历史视图**（`data-field="automation.history-panel"`，关闭钮
  `data-action="automation.history-close"`）：列表容器 `data-field="automation.history-list"`，
  每条 = **状态图标**（进行中旋转 / 成功对勾 / 失败叉 / 已中断停止，与状态文案同色）
  - **触发时间 + 归属自动化名 + 状态 + 用时**；
    同样**按当前 tab 过滤**（Agent tab 只列 Agent 运行）。**Agent 记录可点开**（行加 `.clickable`）
    → 窗口内展开**对话回放**（`.detail-message`，「任务」/「Agent」两侧气泡，数据经既有
    `chat:history` 按 `sessionId` 读取，见 docs/13 §7；会话被删则显示「会话已被删除或还没有消息」）；
    **Normal 记录不可点、没有详情层** —— 产品口径是「只显示触发时间与状态，不展示具体操作」。
    `.run-item` / `.run-time` / `.clickable` / `.detail-message` 四个类名是 capture 探针契约，别改名。
- **门控口径**：catalog 里 `available: false` 的操作组件（如未配置桥接时的 ClassIsland 提醒）
  **在选项里不出现**，不是 `disabled` —— 与麦克风 / 朗读按钮同款口径。
- **推送订阅**：`automation:changed` → 重拉列表；`automation:historyChanged` → 历史视图开着时重拉
  （通道清单见 docs/13 §9）。

### 2.5 设置窗口

设置页新增「文件自感知」（`?page=awareness`，归入「智能」组）：显式联网同意、最多 3 个监控目录、
知识库目录、后台模型、记忆默认有效期、最近使用开关、每日分析上限与单文件上限、运行状态 / 队列进度、
图片识别状态、记录列表、笔记数量 / 冲突 / 过期摘要、立即扫描、打开记忆库 / 打开知识库文件夹与清空历史。
另提供危险操作「重置自感知系统」：第一次点击只展开说明与确认按钮，明确提示会删除全部记忆、
分析历史与后台分析会话但保留设置和源文件；第二次确认后执行，重置期间按钮保持禁用。
完整笔记列表与 Markdown
预览迁到独立记忆库窗口，不再塞回设置页。未同意正文出网时开关保持不可启用。
“最近记录”页内只显示最近 **5** 条；超过 5 条时标题右侧出现「查看更多」，点击后在设置窗内的
滚动弹窗展示完整记录，逐条「分析」操作与页内列表共用同一记录组件。
后台模型可跟随主模型或显式选择 provider + model；显式模型不可用时状态区显示原因。
“运行状态”另显示“累计 Token”：provider 真实回传的输入 / 输出 / 缓存 / 轮次聚合；
未回传时显示“暂无用量”，不按字符估算。
设置窗内的按钮只保留颜色与按下缩放，不在悬停时位移；鼠标点击结束后释放按钮焦点，避免指针已离开
或后续键盘 Enter 再次触发上一次按钮操作。

- 单窗口分栏（**BetaV2**：8 页合并为 **6 页**；2026-09 重构起条目为图标 + 单行文字；v0.2.0 起新增 **Aurora Center** 页共 **7 页**）：侧栏按四组排列 —— **基础**（常规 `general` /
  模式 `modes`）／**智能**（AI 模型 `llm` / 语音 `voice` / Agent 设置 `agent`）／**连接**（Aurora Center `center`）／
  **系统**（高级 `advanced`）；`SETTINGS_PAGE_IDS = ['general','modes','llm','voice','agent','center','advanced']`。
  当前项用分层填充 + 左侧**强调色**指示条（不再用品牌渐变）。合并口径：Skill 与 MCP 并入 `agent` 页、
  STT 并入 `voice` 页、生图模型并入 `llm` 页、勿扰时段并入 `general` 页（全局 + 提示条两组同区）；
  旧深链兼容映射：`?page=tts→voice`、`?page=skills|mcp→agent`。

### 2.6 记忆库窗口

文件自感知知识库的专用浏览器（`memory`，1040×720，min 760×520，普通居中窗口，
关闭 = 隐藏）。左侧是笔记列表（先按源格式 Word / PPT / Excel / PDF / 图片 / 文本等分组，再按首次感知日期分组；
组内按更新时间倒序，日期组可折叠，默认只展开当前选中笔记所在日期；左栏可搜索并按
格式 / 时间筛选，时间按首次感知日期计算；搜索覆盖标题、来源、摘要与标签。右侧是安全渲染的
Markdown 全文预览；顶部提供「打开文件夹」「用系统打开当前笔记」「打开源文件」、单条过期策略和
「立即过期」按钮。手动过期只停止提供给 Agent，不删除 Markdown，也不隐藏于记忆库；状态显示为
已手动过期，可改为永不过期或重新选择到期时间恢复。
搜索输入必须使用可见的实心底与边框，不能直接铺透明 `--glass-surface`；
整个 sticky 筛选区必须使用全宽不透明的 `--bg-raised` 层，不能只在滚动容器上叠透明渐变，
否则向下滚动时笔记文字会从筛选区后面透出来，看起来像“搜索框没有背景”。
设置页的「打开记忆库」入口只负责 `window:show('memory')`，不把完整列表继续复制在设置页。

- **窗口按钮（2026-09 重构起；2026-10 移位 + 补齐最大化）**：本窗无系统标题栏（`frame: false`），
  Windows 式「最小化 / 最大化 / 关闭」按钮（`WindowCaption.vue`，
  `data-caption-btn="minimize" | "maximize" | "close"`）**贴窗口右上缘**（根元素上
  `position: fixed; top: 0; right: 0`，不随内容滚动；2026-10 起从侧栏品牌行右移出，
  对齐 Windows 通用布局——三键在窗口右上角，不在侧栏里）；
  「关闭」= **隐藏窗口**（Esc 等效；
  不退出应用，退出只走托盘菜单），「最小化」真最小化进任务栏。
  侧栏导航条目改为**图标 + 单行文字**（不再带两行说明文案）。
- **可拖动区域**：设置窗顶部完整 32px 标题带（`.titlebar-drag`）与品牌行 `.brand` **都可以拖**；
  关闭按钮与其它交互元素挂 `no-drag`（`theme.css` 另有一条按标签兜底的规则）。
  `WindowCaption` 位于标题带右端，标题带其余区域始终可拖；内容滚动不再影响拖动入口。
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
- 常规页（**BetaV2**：「启动」/「项目」/「提示条」/「勿扰时段」/「关于与更新」）：
  「启动」区组内、开机自启（`general.launchAtLogin`）之下是 **「以管理员身份运行」**
  （v20 新增，`data-field="general.requireAdmin"`，常显 checkbox）—— 启动时未提权会用 UAC
  重新拉起（**改动重启后生效**，理由与四条边界见 docs/08 §1、docs/09 §9）；
  本页的死字段口径不变：`general.language` 任何页面都不渲染（见下条）。
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
  模型行内参数里的「支持图片输入」（`data-field` 锚点 `…modelParams.<模型 id>.vision`）勾选后，
  除图片附件按分片下发外，还会给模型**注册图像工具**（`view_image` / `screenshot` /
  `clipboard_read_image`，见 06 §25）。
- **语音页（v0.8.0 新增；BetaV2 扩为 TTS + STT 双区组）**：页面提供 TTS 区组 —— 总开关（`tts.enabled`）、
  默认 TTS 模型（`tts.active`）、自动朗读（`tts.autoRead`）、截断上限（`tts.maxChars`），
  以及 TTS provider 列表的**增 / 改 / 删 + 「试听」**；BetaV2 新增 **STT 区组**（`stt.enabled` / `stt.active` /
  provider 的 type / baseUrl / model / apiKey / language，锚点 `stt.*`；
  v24 起「接口协议」（`type`，`openai-compat` / `dashscope-native`）是编辑卡的**第一项**，
  切换后 baseURL / 模型名的提示词随之改写 —— 两套接口的字段语义不同，见 docs/06 §15.1）。
  凭据行的展示规则与 AI 模型页一致（只显示「凭据已保存 / 缺少凭据」，密文不进渲染层）。
  字段与门控矩阵见 docs/08 §1 / §6.1。
- **Agent 设置页（2026-09 信息架构收拢；2026-10 前称「智能与工具」）**：页内三组（电脑操控工具 / 技能 / MCP 服务器）同为可折叠
  section-card，折叠策略 —— 「电脑操控工具」**默认展开**（本页主配置面，`agent.tools.*` 探针依赖），
  「技能」「MCP 服务器」**默认收起**（组锚点 `data-group="skills"` / `data-group="mcp"`，
  capture 探针先点开两组、等渲染与折叠动画走完再计数，见 §5.3）。**组头摘要承载状态**（收起也能看清）：
  工具组「x / y 个工具生效」（`y` 取 `COMPUTER_TOOL_NAMES.length`、**不写死数字**，当前 8 个；
  总开关关闭时显示「已停用」）、技能「已启用 x / 共 y」（未发现显示「未发现」）、
  MCP「n 台服务器 / m 台启用」（未配置显示「未配置」）。
  **安全文案收敛为一处**：本页操作直接影响真实系统、工作目录不是沙箱（缺省目录与检索缺省根都按
  06 §5.1 回落链取：Work 模式配了模式工作目录时为模式目录，否则 `agent.tools.workspaceDir` > 主目录；
  全局 `projects.current` 一级已于 v25 退役）、
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
  （BetaV2）Agent 设置页 = agent.tools 区组 + 技能区组 + MCP 区组（三组同页折叠；折叠策略 / 组头摘要 /
  安全文案 / Toast / 启停控件的现行口径见上面「Agent 设置页（2026-09 信息架构收拢）」条目；
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

方向（**BetaV2 / Aurora Glass 2.0**：Apple HIG / Pinguo tokens）：**克制的 Apple 风桌面界面** —— 系统色锚点
（蓝 `#007AFF`/`#0A84FF`、绿 `#34C759`/`#30D158`、红 `#FF3B30`/`#FF453A`、橙 `#FF9500`/`#FF9F0A`）

- iOS 灰阶中性面 + 分层填充 + 大圆角 + 更淡更扩散的柔和阴影；静止卡片靠 1px 边界与留白区分层次，
  阴影留给悬停和浮层；留白充足，右栏与主区之间用分隔而非悬浮卡片。
  **品牌不再使用双色渐变**：强调色 = Apple 系统蓝纯色，`--aurora-gradient` 即纯强调色值，
  全仓禁用 aurora 绿×蓝的 135° 斜向品牌渐变（功能性渐变如遮罩渐隐允许，须注释说明）；
  不用霓虹 / 渐变彩带 / 拟物。**明暗跟随系统**：默认深色，Windows 外观切到浅色时四窗同步切换
  （令牌与窗口底色口径见 §5.1「系统明暗双档」，截图验收见 §5.3）；不提供手动主题开关。
  Aurora Glass 2.0 把毛玻璃从“少量浮层专属”推进到所有固定工作台：窗口画布、侧栏、顶部栏、
  输入区、设置与引导壳体、提示条、记忆库和 Center 工作台共享同一套 frosted 材质；
  正文卡片与重复列表只使用轻透明表面，不逐项叠加 `backdrop-filter`，避免滚动时产生嵌套模糊重绘。
  左栏 / 右栏 / 设置侧栏 / 记忆库笔记列 / Center 导轨统一挂 `.rail-surface`：顶部极淡纵向高光、
  直线内缘与渐隐 hairline 组成一块连续工作台，不再用通长实线边框成「矩形套圆矩形」；
  内缘不再做大圆角，避免三栏接缝出现突兀的弧形缺口。

### 5.1 设计令牌

全部定义在 `packages/shared/src/browser/theme.css`，桌面窗口与 Center Web 共用（各自入口里 import）。

| 类别                                        | 令牌                                                                                                                                                    | 值 / 说明                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 品牌（强调 / 成功）                         | `--aurora-blue` / `--aurora-green` / `--aurora-gradient`                                                                                                | Apple 系统色：亮 `#007AFF` / `#34C759`，暗 `#0A84FF` / `#30D158`；`--aurora-gradient` = **纯强调色值**（**BetaV2 起废弃双色渐变**）                                                                                                                                     |
| 原始中性阶                                  | `--neutral-900/850/800/700/600/500/400/300/200/100/50`                                                                                                  | iOS 灰阶 `#000000` 到 `#f5f5f7`；850 为 Aurora 自有 `#0b0c0f`（保留兼容）；仅语义层消费原始阶                                                                                                                                                                           |
| 底色                                        | `--bg-base` / `--bg-raised` / `--bg-overlay` / `--bg-glass`                                                                                             | 暗 `#000000` / `#1c1c1e` / `#2c2c2e` / `rgba(28,28,30,.72)`；亮 `#f5f5f7` / `#ffffff` / 白 `rgba(255,255,255,.96)` / `rgba(255,255,255,.72)`                                                                                                                            |
| 分层填充                                    | `--fill-1` / `--fill-2` / `--fill-3`                                                                                                                    | 悬浮层 → 卡片 → 悬停/选中，逐层变亮：亮 `rgba(0,0,0,.045/.07/.10)`，暗 `rgba(255,255,255,.07/.10/.14)`                                                                                                                                                                  |
| 分隔线                                      | `--border-subtle` / `--border-strong`                                                                                                                   | iOS 语义：亮 `#d1d1d6` / `#c7c7cc`，暗 `#38383a` / `#48484a`                                                                                                                                                                                                            |
| 文本                                        | `--text-primary` / `--text-secondary` / `--text-muted`                                                                                                  | 亮 `#1d1d1f` / `#6e6e73` / `#aeaeb2`，暗 `#f5f5f7` / `#aeaeb2` / `#7c7c80`；正文用 `--leading-normal(1.5)`、说明用 `--leading-relaxed(1.55)`                                                                                                                            |
| 状态                                        | `--status-idle` / `-running` / `-unread` / `-error` / `-ok`                                                                                             | idle `#8e8e93`、running = 强调蓝、unread = 警告橙（`#FF9500`/`#FF9F0A`）、error `#FF3B30`/`#FF453A`、ok `#34C759`/`#30D158`，**四个窗口语义一致**                                                                                                                       |
| 字体                                        | `--font-ui` / `--font-display` / `--font-mono`                                                                                                          | 随包 **HarmonyOS Sans + HarmonyOS Sans SC**（Regular / Medium / Bold，`font-display: swap`）；代码与终端保留 Cascadia / Consolas 等宽栈。标题 `--tracking-display(-0.02em)`，分区标签 `--tracking-eyebrow(0.08em)`，数字 `--num-tabular`                                |
| 字号                                        | `--text-xs(11)` / `sm(12.5)` / `base(13.5)` / `lg(15)` / `xl(20)` / `2xl(26)`                                                                           | 正文基准 `--text-base`；`--leading-tight(1.25)` / `normal(1.5)`                                                                                                                                                                                                         |
| 字重                                        | `--weight-regular(400)` / `medium(500)` / `semibold(600)`                                                                                               |                                                                                                                                                                                                                                                                         |
| 圆角                                        | `--radius-xs(6)` / `sm(10)` / `md(14)` / `lg(20)` / `xl(28)` / `pill(999)`                                                                              | 档位不变，靠大半径营造连续圆角观感                                                                                                                                                                                                                                      |
| 间距                                        | `--space-1..10`（4/8/12/16/24/32/48/64/96/128）                                                                                                         | 4px 栅格；大阶用于空状态与引导留白                                                                                                                                                                                                                                      |
| 材质                                        | `--blur-thin(12)` / `--blur(24)` / `--blur-thick(40)`；`--glass-*` / `--canvas-*`                                                                       | Aurora Glass 2.0：固定工作台用 `.glass-shell` / `.glass-bar` / `.glass-panel`，重复卡片用 `.glass-surface`；玻璃只上固定和低频重绘层，正文滚动区不逐项模糊；不支持 `backdrop-filter`、`prefers-reduced-transparency` 或 `prefers-contrast: more` 时回落实色             |
| 阴影                                        | `--shadow-hairline` / `--shadow-1/2/3`                                                                                                                  | **BetaV2：更淡更扩散**；静止卡片只用细描边与 hairline；浮层/悬停用带负 spread 的 2，模态用 3                                                                                                                                                                            |
| 控件                                        | `--control-h-sm/md/lg` / `--hit-target`                                                                                                                 | 32/40/48px 按钮高度、40px 图标命中目标；动作圆角统一 `--radius-pill`，输入框使用 `--radius-sm/md`，卡片使用 `--radius-md/lg`                                                                                                                                            |
| 语义色                                      | `--on-accent` / `--accent-text` / `--accent-ring` / `--status-running-ring` / `--danger-*` / `--error-*` / `--warning-*` / `--ok-*` / `--overlay-scrim` | 强调色上的前景为白色；点 / 面用系统原色，文字态（`--*-text`）用可读的加深 / 提亮变体；状态色只用于状态，不用来装饰卡片                                                                                                                                                  |
| 缓动                                        | `--ease-standard` / `--ease-spring` / `--ease-smooth`                                                                                                   | 颜色/透明度用 standard，大面积位移用 smooth，出现/展开用 spring                                                                                                                                                                                                         |
| 时长                                        | `--dur-fast(150)` / `base(250)` / `slow(350)` / `press(120)` / `pulse(1600)`；`--transition-fast\|base`                                                 | `--dur-press` / `--dur-pulse` 为 BetaV2 新增（按下微缩 / 脉冲环），`--transition-*` 是前两者的组合别名                                                                                                                                                                  |
| 时长（循环与终态，2026-09 动画轮 / 轨迹轮） | `--dur-spin(1200)` / `--dur-caret(1100)` / `--dur-bounce(1000)` / `--dur-breathe(2400)` / `--dur-tint(800)`                                             | 循环动画（加载旋转 / 流式光标 / 三点等待 / 边框呼吸）节奏与「出现」动画不同，单列令牌；`--dur-tint` 是 2026-09-30 轨迹重构新增（工具行**终态底色淡出** `aurora-tint-out` 用），**新名 append-only**                                                                     |
| 层级                                        | `--z-sticky` / `--z-flyout` / `--z-popover` / `--z-toast`                                                                                               | **2026-09 新增**（1 / 20 / 30 / 200）：浮出物的唯一来源。此前是散落在三个组件里的 `z-index: 20/20/30` 魔数，直接后果是输入区浮层互相遮挡（见 §2.3「三个浮层的锚点与层级」）。**新代码不许再写 z-index 字面量**（`edge-bar` 内部那处 `z-index: 1` 是窗内分层，保持原样） |

**硬约束**：既有令牌名（`--bg-*`、`--border-*`、`--text-*`、`--status-*`、`--radius-sm|md|lg`、
`--space-1..6`、`--transition-fast|base`、`--font-ui|mono`、`--aurora-gradient`）**只增不删**——
它们散落在各窗口的 scoped 样式里，删名字不会报错，只会静默掉样式。
**品牌不再使用双色渐变（BetaV2 决策）**：`--aurora-gradient` 是纯强调色值；
凡 `linear-gradient` 叠加 `--aurora-green` × `--aurora-blue` 的品牌渐变（含 135° 斜向那类）一律替换为
强调色纯色或极淡强调色填充；功能性渐变（如遮罩渐隐）允许，但必须注释说明用途。
组件只引用语义令牌，不直接引用原始中性阶或另写颜色字面量。分层卡片用 `--fill-1`，悬停用 `--fill-2`，选中用 `--fill-3`；输入框用 1px 紧聚焦环。每屏一个主动作，其余使用次要或弱动作。玻璃材质用于悬浮面板，不铺满页面；静止卡片保持边界清楚、正文不降低透明度。

**Aurora Glass 2.0 性能与可读性约束**：

- 玻璃分三层：`glass-shell`（左右栏 / 设置侧栏 / Center 导轨，标准模糊）、`glass-bar`（顶部栏 / 输入带 / 页脚，薄模糊）、`glass-panel`（提示条面板 / 模态 / 浮层，厚模糊）。
- 只有上述固定层允许 `backdrop-filter`；`section-card`、消息气泡、工具卡、列表行等重复元素使用 `glass-surface` 的轻透明背景与内高光，不叠加模糊。
- 输入卡使用 `--glass-input`：它由内容 tint 与轻抬升表面混合，避免输入区再嵌套一层 `glass-bar` 后合成成不协调的白色实底。
- 画布新增低对比度 `--canvas-*` 纹理，只作为玻璃背景采样层，不承担品牌装饰；不得新增离散光斑、渐变球或彩色 bokeh。
- 系统要求减少透明度或提高对比度时，全部玻璃退回不透明材质；`prefers-reduced-motion` 继续沿用全局 1ms 降级。

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
  `.fade-*`（内容切换；**轨迹容器与思考块的展开 / 收起也走它**，见下面硬约定）、
  `.collapse-*`（`max-height` 展开，**终点取实测高度** `--collapse-h`，
  见 §2.3 与下面的硬约定；工具行展开体 / 设置页折叠区块）、
  **`.page-*`（BetaV2 新增：设置页 / Center 页面横向切换，fade + `translateX(10px)` + `scale(.998)`，
  250ms `--ease-smooth`，
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
     后长出来的内容裁掉、末尾补跳）：① 内容在该 250ms 内会持续生长（流式思考块与**整条轨迹容器**
     —— 它们的自动展开正好命中）；② 过渡根自己带 `max-height` / 本身就是滚动容器。这两类一律
     `name="fade"`（见 §2.3）。
     现状：**工具行展开体**（`.tool-body`）走实测高度 —— 它是**唯一**还挂着钩子的对话区折叠体，
     且被 `chat-tool-card-open` 探针的内联 `--collapse-h` 断言钉住（**不要**把它改成 `fade`）；
     **轨迹容器、思考块、子代理页「任务指令」折叠**走 `fade`；
     **设置页仍有十几处 `.collapse` 只回落 `70vh`**（未接钩子，行为与改前一致），
     属于逐个接线的存量，别把「优先用」读成「已全部用上」；
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
    scoped 样式里的 `@keyframes` 会被 Vue 改名，跨组件复用必须走全局）；
    **2026-09-30 轨迹轮新增**：`aurora-tint-out`（工具行终态**底色淡出**，
    配 `AgentToolRow` 的 `.settled`，时长 `--dur-tint` 800ms，只动 `background`；
    错误行用组件级 `--trace-tint: var(--status-error)` 换色）。
  - **`.tool-*` 过渡**：工具行进场上浮淡入（`TransitionGroup`），第 2/3/4 行按 40/80/120ms 错开。
  - **轨迹轮的"一处扫光"口径**：运行态全轨迹**只保留一处** `aurora-shimmer`
    （工具行的行首亮带；折叠态的轨迹摘要行是下缘那条 1px 亮带）——
    卡片打底扫光与 `aurora-edge-breathe` 边框呼吸已从对话区删除，
    **但 keyframes 保留**（子代理页 / 自动化页仍在用），别顺手删。
- 系统实时切换主题时只更新语义色与非透明原生底色，不改变窗体几何、配置或转场路径；`prefers-reduced-motion: reduce` 在明暗两档均将动画/过渡压到 1ms，状态灯停止呼吸。
- **2026-10-04 工作台入场动效**：新增 `.anim-window` / `.anim-shell-left` / `.anim-shell-right` /
  `.anim-pane` 四个一次性类，分别用于整窗、左右工作台和主内容入场；只动 `opacity + transform`
  （≤8px / ≤0.5% 缩放），250ms `--ease-smooth` 收束，不做常驻 `will-change`、不做无限循环、
  不逐条动画长列表。`prefers-reduced-motion` 仍由文末全局兜底压成瞬时落位。
- **页面切换留白护栏**：`.page-*` 的透明度下限为 0.94–0.96，不从 0 开始；设置页
  **不再用 `mode="out-in"`**，新页直接挂载并只走一次性 `.anim-pane` 入场，避免透明原生窗口
  漏掉 `transitionend` 时 Aurora Center 等新页不挂载。`settings-overflow` 巡检同时记录每页
  `.page` 的可见高度 / 透明度与正文长度，空白页一律 FAIL。
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
  ③ `--bg-base` 等于该档基座（**BetaV2**：深 `#000000` / 浅 `#f5f5f7`）：提示条，
  以及 Windows 主界面 / 设置窗 / 记忆库原生 Acrylic 档的 `body` 背景 alpha 0，
  其它窗口背景不透明、与基座同色；
  ④ 正文与基座的对比度 ≥ 4.5:1，且明暗极性正确
  （浅色不许白字、深色不许黑字）。**原生窗口底色渲染层读不到**，由同一条 `checks` 记录里的 `native` 字段断言
  （原生玻璃窗由 `nativeGlassCheck` 读 `usesNativeGlass()`，实色窗由 `themeNativeCheck`
  读 `BrowserWindow.getBackgroundColor()`），`pass` 取渲染层与主进程结果相与 ——
  原有交互探针各自独立执行、不被替换。两份 `report.json` 均要求每条 `ok:true`、存在的 `result.pass:true`，
  且**配了探针的条目必须有 `result`**（`checked === true` 时 `result` 不得为空，见下面「产物」一段），
  并逐张比对文字、卡片、按钮和引导完成页。
- `AURORA_CAPTURE=<目录> pnpm dev`：把四个窗口、提示条两态、设置页各页、每窗一张双主题场景
  与各条 DOM 探针场景截成一批 PNG 后退出。
  **张数与具体构成以 `report.json` 的实际条目为准，文档里不写死**——BetaV2 又是**净增**，
  后续还会继续加，**不要按固定张数做校验**（这里列出的名字只是当前已知条目，不是清单全集）。
  场景按 `main/capture.ts` 的 `defaultCapturePlan` **实际顺序**执行，当前为五组：
  1. **提示条**：`edge-bar.png`（纯截图）→ `theme-edge-bar.png`（双主题，整窗透明）→
     `edge-bar-expanded.png`（act 派发真实鼠标 hover，面板三按钮命中测试）→
     `edge-bar-animation.png`（记录 20px 轻滑淡入的进行中与终态）→
     `edge-bar-touch.png`（派发触摸按下，断言面板展开、主界面不打开且不会自动收起）。
  2. **主界面（chat，BetaV2 三栏）**——顺序有约束（见下面「全局顺序」一条）：
     `theme-chat.png`（双主题）→ `chat-sidebar.png`（左栏结构 + **出厂门控现场**）→
     `chat-hit-targets.png`（命中区与可访问性盘点，不改状态）→
     `chat-right-panel-toggle.png` → `chat-right-panel-work.png` → `chat-project-card.png`
     （右栏模式感知两条 + 项目卡一条，均自恢复、不动会话）→ `chat-snapshot-card.png`
     （v14 文件备份卡：prepare 种真实快照并 flush 落索引 + reload，act 点一次「回滚」停在待确认态）→
     `chat-job-panel.png`（v15 右栏「任务」面板：夹具在跑计划前种下 `paused` 的
     `<userData>/jobs/main.json`（**必须早于面板首读**），场景只 reload 让面板重新挂载，act **不点任何按钮**）→
     `chat-right-tabs.png`（2026-10-03 右栏功能 tab：act 在「文件」tab 输入一个必然越界的
     绝对路径点预览，等错误文案出现后截图 —— 越界判定在 stat **之前**，离线可跑、不碰用户目录；
     check 再依次切四个 tab 断言互斥、终端 xterm 跨 tab 往返存活、宽度变量生效；
     2026-10-03 二次修订后「目标标签被折叠」时经「＋N」菜单进入）→
     `chat-ctx-tabs.png`（2026-10-03 二次修订 右栏多标签：act 用「＋」菜单开第二个浏览器标签、
     展开「＋N」菜单截图、从菜单激活一个被折叠的标签、关掉一个标签、再开第二个终端标签，
     收尾恢复初始四标签；check 断言折叠计数与 `＋N` 按钮、滑动窗口把激活标签带回可见区、
     菜单矩形与三键无交集、两个终端是**不同** PTY，并把右栏拖到最小 280px 断言
     **「＋N」「＋」完整落在标签条可视区内且「＋」能被 elementFromPoint 命中、点得开菜单**
     ——用户实测「右栏缩到最小后加号按钮不可用」的回归护栏；另把左栏拖到 200px 断言
     左栏自己的「＋」入口（加项目 / 新建会话）同样可点）→
     `chat-subagent-page.png`（点左栏「子代理」固定项进页面，check 收尾切回对话流）→
     `chat-automation.png` / `chat-automation-normal.png` / `automation-editor.png` /
     `automation-history.png`（自动化页 + 独立窗口，v19；见下面「自动化页与详情窗口」一条）→
     `chat-thinking-block.png`（reload 水合 seed 思考块后点开）→ `chat-quick-session.png`（展开侧栏快速对话面板）→
     `chat-thinking-level.png` → `chat-model-picker.png` → `chat-tts.png`（reload，朗读按钮）→
     `chat-drag.png` → `chat-collapse.png`（点击写在 check 里，见下）→ `chat.png`（自动滚底）→
     `chat-follow-burst.png`（高密度持续跟进）→ `chat-follow-wheel-up.png`（底部上滚，2026-10-01）。
     2026-09-26 新增四条（**顺序以 `report.json` 为准**；三条 `chat-stream*` / `chat-trace-fold`
     排在本组最后）：
     `chat-composer-flyouts.png`（两个浮层 + 几何断言）、`chat-tool-card-open.png`（点开工具行展开体）、
     `chat-archive.png`（左栏归档分组）、`chat-stream-burst.png`（高密度流式，见下面各条说明）。
     2026-09-30 轨迹重构新增一条：`chat-trace.png`（点开 `AgentTrace` 的一行摘要，
     断言折叠态"无盒子"与展开态"竖脊 + 节点"的几何，见下面「执行轨迹」一条）。
     2026-10-01 新增两条：`chat-trace-fold.png`（**有工具调用、没有思考增量**的一轮流式结束后，
     轨迹必须自己收成一行摘要；见下面「执行轨迹自动折叠」一条）与
     `chat-trace-wheel.png`（**CDP 真实滚轮**：展开轨迹后连发小幅上滚，视口必须单调上移；
     见下面「真实滚轮跟随」一条 —— JS 合成事件测不到原生滚轮管线，这条与
     `chat-follow-wheel-up` 必须并存）。
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
     `settings-stt-card.png`（v24 新增；深链用新页 id `voice`，打开 STT 编辑卡并断言
     「接口协议」切到阿里云原生时 baseURL 提示词被改写）→
     `settings-classroom-patch.png` → `settings-modes-work-gating.png`。
     「思考等级 / 结构 / 模型列表」三条的配置改写与恢复口径见下面各条探针说明。
  5. **提示条收尾**：`edge-bar-collapsed-final.png`（收起，不留展开态）→
     `edge-bar-after-click.png`（先 `hide('chat')` 复位再点竖条，回归「点击呼出交互窗」）。
     `AURORA_CAPTURE_WINDOWS=edge-bar,settings` 只截指定窗口（逗号分隔）；
    再细一级用 `AURORA_CAPTURE_ONLY='session-groups'`（按 PNG 文件名**子串**匹配，逗号分隔），
     特殊值 `failed` = 只重跑上次 `report.json` 里未通过的场景（`ok:false` 或探针 `pass:false`）——
     修完一轮只重验红掉的那几张，不必全量重跑；上次全绿时它是**空清单**，一张不跑且退出码为 0
     （"没有要重验的"不等于"没匹配上"，后者退出码是 1）。
     手动观察流光时可加 `AURORA_GLOW_PREVIEW_MS=5000`：预览窗口先保持 5 秒再截图，
     用于确认入场完成后仍持续流动，不改变生产窗口寿命。
  - **截图时机的等待策略**（2026-10-01）：每个场景在 `act` 结束后等**两帧 rAF**（保证 DOM 变更
    已经画出来），再补一个 settle —— 缺省 260ms，按场景里最长的 CSS transition（220ms 级）留余量。
    `executeJavaScript(act, true)` 本身是 await 的，所以 act 内部的异步（写配置、reload、IPC 往返）
    在它返回时都已结束，不需要再用固定长等待去"兜"。**只有动到窗口本身的场景**才覆盖
    `CaptureTarget.settleMs`：提示条展开走主进程原生 shape + IPC，属**跨进程**异步，rAF 等不到它
    （`edge-bar-expanded` 因此保持 700ms）。
    ⚠️ 别把 rAF 当成万能的：把等待一刀切短之后，`edge-bar-expanded.png` 从 79KB 掉到 7.6KB ——
    画面还停在竖条、DOM 却已是展开态，而**探针照样 PASS**（它只读 DOM，不看画面）。
    这类回归只有压缩 PNG 的字节数或人眼看图才发现得了。
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
  - 提示条面板：`elementFromPoint` 命中测试 3 个按钮 + 是否落在窗口宽度内 + 窗口宽 ≤ 328px
    （面板自身的 320px 与自感知 / 最近理解锚点一并作为通过条件）；
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
    2026-09-30 起这条钉**语义**（"跟丢"修复轮）的三个阶段：
    ① 追加内容 → 必须自动到底；
    ② 位置在离底处 + 派发**真实 `WheelEvent`** → 跟随暂停、「↓ 回到最新」胶囊出现且**落在容器可视区内**
    （`position: sticky` 在"内容按溢出渲染"的交互窗里是否真吸得住，只有真实 DOM 能回答）；
    ③ 滚回底部再派发一次真实滚轮 → 跟随恢复、胶囊消失（滞回的两端都被覆盖）。
    ⚠️ **已知覆盖缺口**（如实记下，别当成实现承诺）：**「只有程序改 `scrollTop`、不派发任何输入事件时
    跟随不被关掉」这条没有断言** —— 2026-09-30 实测该场景下 `following` 确实被关掉了，但
    `onUserIntent` 从未被调用（排查中连捕获阶段都确认 wheel 事件到达了 `.thread`），说明还有一条
    未知的关闭路径；查清前写成断言只会得到一条长期 FAIL 的探针。
    2026-10-01 复核：本轮查清的是**另一条**路径（①′ 的输入/读数时间差 + `rebind()` 漏挂原生监听），
    上面这条旧读数仍未复现，缺口照旧保留。
    探针放在 `check`（截图**之后**执行），不污染 PNG，执行完移除节点、归位滚动；注：探针节点是
    **合成内容**，只验证滚动机制本身，不需要配置模型；
  - **底部上滚**（`CHAT_FOLLOW_WHEEL_UP_SCRIPT`，产物 `chat-follow-wheel-up.png`，2026-10-01）：
    上一条的两阶段都是"先把 `scrollTop` 拨到 0 **再**发滚轮"，因此天然能判出「用户接管」；
    而真实用户是**从底部**开始滚的 —— 输入事件到达主线程时合成器还没把视口挪上去，那一刻读数
    仍在底部。本探针如实复刻这两拍（贴底 → 派发真实 `WheelEvent` → 把 `scrollTop` 挪上去 +
    派发 `scroll`），判据是**这一滚必须留在用户滚到的位置**（没被随后那帧对齐拽回底部）
    且「↓ 回到最新」胶囊出现；收尾摘掉探针节点并点应用自己的胶囊恢复跟随。
    它钉住的就是用户报的「答完翻不动历史」；`pass` 另带 `maxScroll ≥ 200` 守卫（内容没撑高时
    "没被拽回"没有意义）。
  - **高密度自动跟随**（`CHAT_FOLLOW_BURST_SCRIPT`，产物 `chat-follow-burst.png`，2026-09-30）：
    与上一条的分工是「语义」对「持续跟进」—— 按 6 帧每帧长高约 120px 持续追加内容
    （真实流式中 markdown 块 / 工具行密集插入的形态），**每帧**都要求「帧末已经到底」
    （`maxDistance ≤ 4`），且**不必等任何 `transitionend`**：旧实现只在过渡结束时补一次，
    高度增长期间一直落后。返回值带 `samples`（每帧的距底读数）与 `grown` 供人工核对
    "是不是真的撑高了内容"。同样排在 `chat-collapse` 之前（窗口一被 hide，DOM 操作就没了）；
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
  - **工具行展开**（`CHAT_TOOL_CARD_OPEN_ACT` / `CHAT_TOOL_CARD_OPEN_CHECK`，
    产物 `chat-tool-card-open.png`，2026-09-26）：点 seed 的 `task` / `todo_write` 行首展开，
    断言展开体可见、`--collapse-h` 与该元素的 `scrollHeight` 相差 ≤ 2px（**机制的**回归断言：
    有人改回写死 `70vh` 或改错钩子，这条立刻 FAIL），
    并断言**点击后 60ms 的那一帧高度严格小于稳定高度** —— 终值在「正常过渡」与
    「退化成瞬跳」两种实现下相同，只有中间样本能把后者钉住。
    返回值里另有 `diagnostic`（中途 / 稳定两次布局快照）与 `detachedMeasureProbe`
    （游离元素 `scrollHeight` 恒为 0 的旁证），只作信息、不参与 `pass`，
    用于复现「f77a842 之前 enter 侧少写 66px」那个坑。
  - **执行轨迹**（`CHAT_TRACE_ACT` / `CHAT_TRACE_CHECK`，产物 `chat-trace.png`，2026-09-30）：
    act **只点 DOM、不写配置** —— 找 `.message.r-assistant .trace`，记录折叠态（无 `.open` 类、
    无 `.trace-body`）与摘要文字，点 `.trace-head` 展开，450ms 后把几何挂 `window.__auroraTraceProbe`。
    check 断言：① 折叠 → 展开的边沿真实发生（`openBefore === false && bodyBefore === false`，
    点完 `.open` 且 `.trace-body` 可见高度 > 0）；② 折叠态确实是"**一行软胶囊**"——
    `.trace-head` 的背景色**不是**透明（软胶囊有底色；改回无底色灰字行在这里 FAIL）、
    上下描边宽度为 0（别拿颜色判：无边框时 `border-top-color` 解析成 `currentColor`），
    且展开体折叠高度为 0（grid `0fr`：`.trace-body` 的 `clientHeight === 0`）；
    ③ 展开态确实是"**竖脊 + 节点**"—— `.trace-body::before` 是宽 ≥ 1px、高 > 0 的竖脊
    （伪元素只能走 `getComputedStyle(el, '::before')` 量），行的左内边距 ≥ 8px；
    ④ 工具行结构没退化——每行恰好一枚 `.tool-head .tool-icon`，
    `.tool-body` 不存在或带可解析的 `--collapse-h`；
    ⑤ 轨迹内顺序为「思考 → 工具行」（`thinkingBeforeRow > 0`）。
    这条同时保证「折叠态仍能读到 `.thinking-head` 文案」这条前提没被改掉；
    场景顺序按 `report.json` 的实际条目排在 `chat-tool-card-open` 之后、`chat-collapse` 之前。
  - **执行轨迹自动折叠**（`CHAT_TRACE_FOLD_CHECK`，产物 `chat-trace-fold.png`，2026-10-01）：
    与上一条的分工是「状态机」对「几何」—— 上一条自己会**先把轨迹收起来**再量（去测折叠态的形状），
    本条**完全不碰 DOM 状态**，只读「流式结束后应用自己留下的那个状态」，因此能抓到状态机的错。
    现场由桩服务的 `SKILL_ONLY_MARKER` 分流造出：第 1 轮只要一次 `use_skill`、第 2 轮**只回正文**
    （一条 `reasoning_content` 都不发）—— 即**有工具调用、没有思考增量**的那一轮。
    `pass` 的三段：① 现场成立（有工具卡、**没有** `.thinking`）；② 轨迹是折叠态（无 `.open` 类 +
    展开体不可见 = grid `0fr` 下 `.trace-body` 的 `clientHeight === 0`）；③ 摘要行有文字。
    前两段缺一不可 —— 只有它们合起来才能区分"收到位了"与"压根没有可收的东西"。
    ⚠️ **为什么必须单列**：原先的收尾逻辑只收「这一轮被打开过的」消息，而消息只有思考增量到达
    时才会被打开；桩服务默认分流每轮都发 `reasoning_content`，于是这个分支在既有 34 条探针里
    **一次都没被覆盖**（2026-10-01 实测：全绿的报告下用户仍看到"工作过程不折叠"）。
  - **真实滚轮跟随**（`CHAT_TRACE_WHEEL_ACT` / `CHAT_TRACE_WHEEL_CHECK`，产物 `chat-trace-wheel.png`，
    2026-10-01）：既有 `chat-follow-wheel-up` 用 JS `dispatchEvent` 合成 wheel —— 它驱动得了
    **意图链路**（监听器照收、判定照跑），却**绕过了原生滚轮管线**：合成事件不触发合成器滚动，
    「贴底时程序把用户刚滚出去的视口吸回去」这一类失效在它面前必然 PASS（意图与对齐帧的竞速、
    吸底补齐的时机，全都发生在合成器与主线程之间，合成事件根本不进那条路）。
    本条经 `webContents.debugger` 发 CDP `Input.dispatchMouseEvent`（type `mouseWheel`）
    —— 这是**真实输入**，走完整的合成器管线：act 先点开一条折叠轨迹（复现 `restick()` 结算帧
    在途的现场），随后连发数次**小幅**上滚（单步 `deltaY` 对应位移 < 24px 阈值，贴近触控板），
    逐次记录 `scrollTop`；check 断言视口**单调上移**且最终离底超过阈值（接管态成立）。
    这条是「意图窗口内对齐帧静默 + 补齐方向收窄」（§5.2 ①‴）的端到端防线，
    与 `stickToBottomCore.test.ts` 的两条竞速单测分工：单测钉时序语义，本条钉真实管线。
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
    （通用 / 模式 / AI 模型 / 语音 / Agent 设置 / Aurora Center / 系统），逐页量 `main.content` 内
    **每个元素**的矩形，只查**横向**溢出（纵向滚动是正常行为、不算），
    探出内容区左右边界超过 1px 的节点记账；check 断言**页数 ≥ 7**（防"导航没点全还判 PASS"）
    且违规页数为 0。这条把「安全区」从自动化页扩到了最可能出现"长标签 + 窄控件"的设置页。
    同一轮把这条护栏补齐到另外两个窗口：**引导窗**（`onboardingCheckScript`，五段共用，
    每段都查 `.pane` 内横向溢出，结果进 `overflow` 字段）与**提示条面板**
    （`EDGE_BAR_PANEL_SCRIPT`，查面板内元素是否探出 328px 窗口边界，进 `overflow` 字段）。
    至此「安全区」的运行时证据覆盖：自动化页（卡片 / 磁贴）、设置页 7 页、引导窗 5 段、
    提示条展开面板、输入区三个下拉 —— 都是几何判据，不是"看着没问题"。
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
  - **自动化页与详情窗口**（`CHAT_AUTOMATION_*`，产物 `chat-automation.png` /
    `chat-automation-normal.png` / `automation-editor.png` / `automation-history.png`，
    v19，docs/13 §11）：
    现场由 `seedAutomationFixture` 种下 —— 1 份 Normal 定义（`am-capture1`「早读提醒」，
    `daily 07:30`）+ 2 条历史（normal / agent 各一条，agent 那条指向种子会话 `auto-capture1`）
    - 该会话文件（任务与回复各一条，均带探针标记 `capture-automation-run`）。
      ⚠️ **与其它夹具不同：种完必须 reload 一次自动化引擎**（`AutomationEngine.reload()`）——
      引擎在 `bootstrap()` 里就已启动、`AutomationStore` 首读即缓存空表（in-flight 的 `ensureLoaded`），
      不重读就是「夹具写了、界面照样是空的」（首跑实测 0 条），机制同 `seedJobFixture` 那条注释；
      主界面两张 + `automation` 窗口两张；独立窗口内由 `act` 调
      `automation:openWindow`，验证编辑器 / 历史不再受主区层级影响。
      ① 点左栏 `chat.auto-item` 进页面 → 断言 `automation.page` / 双 tab /「历史」/「新建自动化」/
      「返回对话」锚点都在、左栏项为 **`.active`**；
      ② 点 `automation.tab-normal` → 断言 `automation.builtin` 在、`automation.builtin-toggle`
      **恰好 2**（两条内置）、自建项 `automation.item-am-capture1` 恰好 1、`automation.toggle`
      恰好 1（切到 Normal tab 后 Agent 定义不在列表里 —— 顺带钉住「按 tab 过滤」）；
      另断言**次数徽章**（v0.2.8，docs/13 §3.1）：`automation.runs` **恰好 2 枚**、
      文本含 `3/10` 与 `5/5`、**`.exhausted` 恰好 1 枚**（seed 的第二份定义已用尽 ——
      用尽转警示色是 DOM 事实，不靠截图猜）；
      ③ `automation` 窗口内打开 editor 请求，断言**条件磁贴**
      （`automation.trigger-kind` 容器下 `[data-kind]`）**≥ 7**
      （catalog 七类）且**每枚磁贴都有图标**、磁贴内元素不探出磁贴矩形（安全区几何护栏）、
      至少 1 行操作组件（`[data-field^="automation.action-"]`）且每行胶囊都有图标、
      编辑器内**原生 `<select>` 数为 0**、名称输入框与数字字段都在、
      **`automation.max-runs`（调用次数上限）输入可用**（v0.2.8：写入 `42` 后读回同一值
      = 双向绑定真的接上了，不只是"元素在 DOM 里"），
      再派发一次 `pointerenter` 断言悬浮提示真的出现（`body > .app-tip` 文案非空、不探出视口）
      且 `pointerleave` 后自行收回，然后 Esc 并断言编辑器**已隐藏**；
      ④ `automation` 窗口内打开 history 请求，点开一条 Agent 记录
      （`.run-item.clickable`）断言
      `.detail-message` **≥ 2** 且面板文本含 seed 标记（证明回放的是**真实会话**，不是占位）；
      随后切 Normal tab，断言 Normal 记录 `clickable === 0`
      （**不可点、无详情层**，产品口径）且 `.run-time` 存在；
      主界面自动化页仍保留，后续 `chat-classisland-status` 等场景可直接切回对话流。
      这一组同时钉住三条产品语义：**按 tab 分别过滤**、**两种记录的详情口径不同**、
      自动化页与子代理页一样是**主区替换内容**（不属任何会话）；
  - **右栏开关**（`CHAT_RIGHT_PANEL_TOGGLE_ACT` / `CHAT_RIGHT_PANEL_TOGGLE_CHECK`，
    产物 `chat-right-panel-toggle.png`，BetaV2）：act 内点两次 `chat.right-panel-toggle`
    走「展开 → 收起 → 展开」，三态记录暂存渲染层；check 断言三态全部成立、且截图时刻右栏
    **仍是展开的**（收起态只允许活在两次点击之间的瞬时，截图本身就是三栏默认布局的证据）；
    另在**收起态**量一次顶部横带（2026-10-03 补）：窗口三键仍贴窗口右缘贴顶，
    标题栏的「清空」按钮已让位、两者矩形不相交（`collapsedCaptionPinned` / `collapsedOverlap`）；
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
  - **右栏功能 tab**（`CHAT_RIGHT_TABS_ACT` / `CHAT_RIGHT_TABS_CHECK`，产物 `chat-right-tabs.png`，
    2026-10-03）：act 切到「文件」tab、在路径框输入 `C:\Windows\win.ini`（必然在会话边界根之外）
    并点预览，等 `chat.file-preview-error` 出现后**停在该 tab 截图**——越界判定发生在 stat
    **之前**，因此离线可跑、且不写任何用户目录（Agent 空间会话的边界根是真实桌面）；
    act 末尾顺带初始化终端 tab 让 xterm 挂上（2026-10-03 二次修订后目标标签可能被折叠：
    act/check 一律直接点 `chat.ctx-tab-<id>` 锚点 —— 折叠时它在 ＋N 菜单里，但**仍是可点的
    元素**（`.click()` 与可见性无关）；标签条自身的折叠 / 菜单交互由 `chat-ctx-tabs`
    场景用真实 UI 覆盖，两者分工见那条的场景注释）。check 断言：
    四个 tab 锚点与拖拽把手都在、
    右栏宽度落在 280–720px（`--ctx-w` 变量真的驱动布局）、越界文案含「边界」、
    **tab 互斥**（files 下 `chat.jobs` 缺席、context 下恢复——旧探针零改动兼容正依赖这条）、
    终端 `.xterm` 跨 tab 往返仍在且行文本长度不减少（面板常驻：切走只是 `display:none`）、
    浏览器面板出现（webview 不等待网络加载）、文件 tab 的面包屑根段恒在且预览态点
    「返回列表」（`chat.file-exit`）后列表容器回来、**左栏把手在且宽度由 `--nav-w` 内联变量真正驱动**、
    **两侧把手各拖一次真的改宽度**（合成 down → move → up，buttons 恒为 1：左栏拖到 320、
    右栏拖到 420，双击各回缺省 240 / 384 —— 「把手在」推不出「拖得动」；再往左拖 900px
    断言宽度取到 `min(720, 窗口 − 左栏 − 420)`、**主区不被压到 380 以下**且工具条按钮仍在
    可视区内）、**窗口按钮固定右上角**（三键贴窗口右缘、`top ≤ 4`，且与右栏 tab 矩形
    **无交集** —— 用户实测的正是按钮压在 tab 上的现场）、**终端黑底**
    （容器与 `.xterm-viewport` 的底色都是纯黑 —— xterm 的 `.xterm` 元素本身是透明的，
    它把主题背景画进 canvas，因此判据取容器 + viewport）、
    **右栏不横向撑破**（`asideOverflowX` ≤ 0，且四枚文件工具条按钮的矩形都落在 aside 矩形内 ——
    2026-10-03 的撑破 bug 会让它们被推出可视区，而只查 DOM 存在性的探针全绿）。成功路径
    （真实读盘 / 截断 / 二进制 / 目录与缺失文件）由 `apps/desktop/src/main/file-preview.test.ts`
    与 `file-list.test.ts` 用真实临时目录覆盖；
  - **右栏多标签（开 / ＋N 折叠 / 滑动窗口 / 多终端）**（`CHAT_CTX_TABS_ACT` /
    `CHAT_CTX_TABS_CHECK`，产物 `chat-ctx-tabs.png`，2026-10-03 二次修订）：
    act 全程走**真实 UI**（不点隐藏锚点）：① 点 `chat.ctx-new-tab` 开「＋」菜单 → 点「浏览器」
    项（等第二个浏览器面板挂载）；② 点 `chat.ctx-tab-more` 展开「＋N」菜单**停在这里截图**；
    ③ 点菜单里第一条被折叠的标签（记下它的 `data-tab-id`）→ 等它激活；④ 点它的 ✕ 关掉；
    ⑤ 再经「＋」开一个终端标签（等第二个 `.xterm` 挂上）；⑥ 收尾：关掉新增的标签、激活回
    「上下文」（**自带收尾**，不依赖别的场景自律）。check 断言：**折叠计数**（`＋N` 按钮的
    数字 = 标签总数 − 可见数）、**滑动窗口**（从菜单激活的那个标签，矩形落在标签条可视区内
    —— 激活标签永远看得见）、**菜单矩形与三键矩形无交集**（菜单只许向下弹）、
    **两个终端是不同 PTY**（两个 `chat.terminal-host` 的 `data-terminal-id` 互异且非空 ——
    主进程多实例真在工作，只数 DOM 个数是数不出共享同一个 shell 的）、
    **容量随宽度变化**（把右栏拖宽 → 同时可见的标签变多：「固定数量」是按标签条实测宽度算的，
    不是写死的 2；拖完双击复位回 384）、**最窄局面**（右栏拖到最小 280px：标签让位到 74px，
    `＋N` / `＋` 两枚按钮**完整落在标签条可视区内**，且「＋」被 `elementFromPoint` 命中
    并真的点开新建菜单 —— 只量「DOM 里在不在」是查不出「被 overflow 裁掉、点不到」的）、
    **左栏最窄**（左栏拖到 200px：`chat.add-project` / `chat.new-agent-session` 等
    「＋」入口逐个量矩形 + 命中测试，全都要可点），关闭后 `＋N` 数字回落、
    收尾后标签总数回到初始 4；
  - **终端 tab 截图**（`CHAT_TERMINAL_ACT` / `CHAT_TERMINAL_CHECK`，产物 `chat-terminal.png`，
    2026-10-03）：不 reload（复用上一场景初始化好的常驻 shell，截图里自带 PowerShell 提示符），
    check 断言 `.xterm` 在 + 容器与 viewport 底色纯黑；行文本只作诊断字段（单独跑本场景时
    新 shell 可能还没有输出，不该判 FAIL）；
  - **文件 tab ＝ 会话项目文件夹**（`chatFileProjectAct(root)` / `CHAT_FILE_PROJECT_CHECK`，
    产物 `chat-file-project.png`，2026-10-03）：prepare 在项目根种出 `assets/`、`报告.md`
    与 `宽内容.md`（长 URL + 长标识符 + 长代码行 —— 撑破现场的夹具）；
    act 经 `settings:update` 登记项目「截图项目」→ 点左栏那条绑项目的种子会话
    （`sessions/chat-seed-project.json`，`meta.projectId = 'capture'`）→ 切到「文件」tab；
    act 的返回值不进 report，读数挂在 `window.__auroraFileProjectAct` 上由 check 读取
    （act 自己的失败必须能被看见，否则会静默假 PASS）。check 断言：面包屑根段「项目：截图项目」
    （且此时只有一段）、根目录里 `assets` / `报告.md` / `宽内容.md` 都在且**目录排在前**、
    **导航历史**（点目录进下层 → 面包屑多一段 → 点「后退」回根只剩一段 → 点「前进」再进下层
    → 点「上级」回根）、点文件在面板内预览（markdown 正文可见 + 「返回列表」按钮在）、
    点它回列表、**宽内容布局护栏**（预览 `宽内容.md` 时 `aside.scrollWidth` 与
    `.fp` 的 `scrollWidth` 都不超 `clientWidth`，且工具条五枚按钮的矩形全落在 aside 可视矩形内）、
    宽内容预览也能退出回列表；**收尾**点回原会话行（用应用自己的行按钮，不猜标题）+
    撤销项目登记，两条都并入 `restored`；
  - **`show_preview` 推送链路的渲染层半边**（`chatFileProjectAct` + `mainAct` /
    `CHAT_PREVIEW_TOOL_CHECK`，产物 `chat-preview-tool.png`，2026-10-03）：act 同上（切到
    绑项目的会话，会话 id 必须与推送的 `sessionId` 一致才被采纳）；`mainAct` 合成一条
    `preview:show`（通道与 payload 形状与工具实际推送一致，由主进程 `webContents.send` 发出）；
    check 断言右栏**自动切到「浏览器」tab**、webview 真的加载了 `file://` 夹具
    （读 `webview.getURL()`，轮询到就绪为止 —— 「面板在但没导航过去」是最可能的失效）、
    地址栏显示原始路径、**导航工具条五枚按钮都在且量得出尺寸**
    （`chat.browser-back` / `-forward` / `-reload` / `-home` / `-new-tab`，宽高 > 8px ——
    2026-10-03 之前是 `‹ › ⟳ ⌂` 字形按钮，用户口径「没有刷新、上一步等按钮」，
    这条把「有真正可见的按钮」钉住）、**切标签不重载**（页面里打标记 → 切走再切回 → 标记仍在
    且 guest `innerWidth` 没塌成 0），以及**标签页自己开标签的两条链路**（用户口径
    「点击超链接后，网站需要单独跳出一个标签页的话可以单开」）：① 点工具条 ＋ → 新开一个
    浏览器标签并激活；② 在页内点 `target="_blank"` 链接 → 同样**新开**标签加载该地址，
    而**当前页原地不动**（夹具的 `getURL()` 仍是 fixture.html —— 「链接把当前页顶掉」正是
    旧口径的失效形态）；两条都收尾关掉新标签。主进程侧的目标校验（http(s) / 越界 / 不存在 /
    `file:` 之外的协议 / 子代理会话 id 剥回父会话）由
    `apps/desktop/src/main/tools/preview-port.test.ts` 覆盖，
    工具层契约由 `packages/agent-core/src/tools/preview.test.ts` 覆盖；
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
    **`general.requireAdmin` 恰好 1 个**（v20 新增断言：常显字段，数到 0 就说明提权开关
    被删掉 / 改名了 —— 与 `general.launchAtLogin` 同款「必须能改回来」）、
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
  - **「Agent 设置」页门控**（`SETTINGS_AGENT_FIELDS_SCRIPT`；BetaV2 六页 IA 下原「电脑操控」页
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
      `chat.context-usage` 里面；06 §21.4）：桩 LLM 在本轮固定回
      `prompt_tokens = 512` + `prompt_tokens_details.cached_tokens = 512`，2026-10-03 起实测文案是
      `512 / 128k  · 平均缓存命中 100%`（`chat.context-usage`；分子分母都是 **totals 累计**，
      桩数据 cached == prompt，无论累计几轮占比恒为 100%）、`累计 528`（`.ctx-total`）。
      探针要求 `chat.context-cache` 的文案同时含「平均缓存命中」「100%」两个子串 ——
      只断言「含缓存命中」时，命中量丢了（只剩标题）或百分比算错都照样能过。
      **分母与分子必须自洽**（桩数据 `cached <= prompt`）：写反会算出大于 100% 的占比，
      展示侧的 `Math.min(100, …)` 虽然夹住了，桩数据也不该自相矛盾。
      未回传 `cachedTokens` 时整段不渲染（不写「平均缓存命中 0%」，那会把「没回传」显示成「一条都没命中」）；
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
    点 `data-action="edit-provider"` 开卡 → 点**当前使用模型那一行**（`.model-row.current`）的
    `data-action="toggle-model-params"` 展开模型参数 → 断言 `[data-field$=".reasoningEffort"]`
    与 `[data-field$=".contextWindow"]` / `[data-field$=".vision"]` 都在**模型行内**、且下拉的
    `select.value` 等于配置里写的 `'high'`（覆盖「写盘 → 回读 → 渲染」整条链路）。
    `temperature` 字段已随 v23 从 Schema 与页面上删除，**不再**断言它存在。
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
    `llm.providers[llm.active].modelParams[provider.model].reasoningEffort`，
    与 DOM 里该下拉的 `select.value` 比对，
    并断言 option 数量为 4。`pass` = 配置值 === `'high'` **且** DOM 值 === `'high'` **且** option 数 === 4
    ——它同时钉住「读写的是同一个字段」与「探针不改坏用户配置」：act 前先记下原值，
    check 结尾把原值写回，恢复结果一并放进返回值。
  - **模型页「模型列表」区**（`SETTINGS_LLM_MODELS_ACT` / `SETTINGS_LLM_MODELS_CHECK`，
    产物 `settings-llm-models.png`，设置页 `?page=llm`）：act 点开第一行的「编辑」
    （`data-action="edit-provider"`，找不到就按文案「编辑」兜底）；check 断言
    「模型设置区」存在（`[data-field$=".modelList"]`）且**行数 ≥ 1**（行容器是
    `data-field="llm.providers.<id>.modelList.<index>"` 且类名 `model-row`；**按 `.model-row`
    计数** —— 行内的参数子字段锚点也以 `.modelList.` 开头，用 `[data-field*=".modelList."]`
    数会虚高）→ 点一次 `data-action="add-model"` 后**行数 +1** → 结束时**把刚加的那一项删掉**，
    让后面的场景仍看到干净配置。
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
    等 600ms 让 IPC 往返完成，并把原值记进 `window.__auroraModelProbe`。
    **check 的口径（本轮起，docs/06 §3 会话级模型）**：下拉写的是**本会话的覆盖**，
    因此读三处 —— ① 全局 `llm.providers[llm.active].model` 必须**仍是** `deepseek-chat`
    （对话框不再改全局默认，这条正是这次改动最该钉住的）；② 会话摘要里**带 `llm` 的那条**
    的 `model` 是 `deepseek-reasoner`（覆盖写进去了；**不假定会话 id** —— 截图夹具会把对话窗
    切到别的会话上，写死 `main` 会读成 null 而误判）；③ DOM 里该 select 的 `.value` 是新模型。
    结束时**清掉本会话覆盖**（`chat:setSessionModel` 传空串）并再读一次会话摘要确认它真的没了
    （判据取**状态**而不是 DOM 的 value：探针前半直接改过 `select.value`，界面状态回到空串时
    Vue 认为"值没变"就不会去改 DOM，读到的仍是探针设的那个值 —— 这条曾经误报过一次 FAIL）。
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
- 设置页深链：`main/window-manager.ts` 的 `ensure(name, query)` / `reload(name, query)` 给 URL / `loadFile` 传 query，仅截图场景使用，正常启动不带 query。

#### 5.3.1 排查一条 FAIL 探针的正确顺序（2026-09-30 「跟丢」排查的教训）

那一轮把「自动跟随跟丢」从"看着像滚动逻辑错了"一路查到"观察者的回调根本没再触发"，
绕了很远。沉淀下来的是**方法论**，下次照这个顺序走能省掉大部分时间：

1. **先分清「读数错」还是「状态错」**。界面症状（滚动条停在半路）对这两者是一样的，
   但修法完全不同：状态错要看"谁改了跟随状态"，读数错要看"引擎读的是哪个节点"。
   做法是各插一个探针：把**引擎自己的读数**（它的 `getMetrics` 结果）与
   **探针自己 querySelector 到的读数**并排回报。两者一致 → 查状态；不一致 → 查节点身份。
2. **不要相信"代码里 assert 的时序"**。本轮实测到的形态是：`MutationObserver` 的回调**会停**
   —— 同一个节点上另挂一个独立观察者能收到 6/6 条变更，而应用自己那个既没被 `disconnect`、
   也没被判成 `isConnected === false`、更没有抛异常。纯事件驱动在这类失灵面前没有出路，
   所以现在有一条**心跳兜底**（每帧两次属性读）。
3. **判断"是不是探针自己把状态改坏了"**。本轮 `chat-follow-burst` 长时间 FAIL，
   根因是**它前面那条 `CHAT_AUTO_SCROLL_SCRIPT` 把跟随关掉后没恢复** —— 探针之间会互相污染。
   每条探针都应自带前置与收尾（点应用的入口按钮恢复状态），不依赖别人的自律。
4. **探针的判据只能有一份**。本轮踩过：`conditions` 表已改用"折叠态量到的描边宽度"，
   而 `pass` 表达式里还留着旧写法 —— 报告里每条都是 `true`、探针却恒定 FAIL，
   排查成本极高。现在 `CHAT_TRACE_CHECK` 的 `pass` 直接取 `conditions` 的乘积。
5. **测量时机要写进注释**。同样踩过两次：描边宽度必须在**折叠态、点击之前**量
   （展开态两次写入之间会读到 `0.666667px` 的过渡中间值）；"折叠态证据"必须在 `check` 里
   重新量（`act` 返回的是点击**之前**的快照，拿它当证据永远为假）。
6. **量事实，别量它的解析值**。`border-left-color` 在"没有左边框"时解析成 `currentColor`，
   于是"左右透明"这条判据恒定不成立 —— 量 `border-left-width === 0` 才是"有没有这条边"。

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
  结果一出现就把过程收起，焦点回到产出。→ 本仓的思考块 / 工具行 / 子代理轨迹本来就是这个口径
  （§2.3），2026-09-30 轨迹重构把它做**更干净**（一条轨迹一行摘要、展开后一条竖脊串起节点；
  原来的竖轨旁注样式已并入轨迹）。
- **工具行的标准解剖**：行首 = 状态点 + 语义图标 + 工具名 + 结果摘要，行尾 = 耗时；
  展开体 = 可折叠的入参与结果。→ 本仓已有这套（2026-09-30 起状态文字由状态点色 + `aria-label`
  承担）；**失败重试**尚未做（列入待办，不假装已有）。
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
