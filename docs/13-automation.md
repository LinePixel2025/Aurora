# 13 · 自动化（Automation）—— Agent Mode 与 Normal Mode

状态：`已定稿`（v0.2.5 随本设计首次落地）

自动化让 Aurora 在**定时**或**满足条件**时自主做事，交互范式对齐 Codex / ChatGPT Tasks
等 Agent 产品的 Scheduled Tasks：任务有一份定义（触发器 + 要做什么）、一条运行历史
（何时触发、耗时、结果），用户随时可以新建 / 编辑 / 启停 / 手动触发。

自动化分两种模式：

| 模式 | 触发后做什么 | 历史记什么 |
|---|---|---|
| **Agent Mode** | 用该自动化配置的**任务指令（prompt）驱动一次完整的 Agent 会话**（模型 + 工具循环，与会话页同一条内核链路） | 每次触发一条运行记录（触发时间 / 用时 / 状态 / 归属自动化）；点开记录可回看**该次对话全文** |
| **Normal Mode** | 顺序执行预设的**操作组件**（系统通知 / ClassIsland 提醒 / 打开文件夹，见 §5） | 每次触发一条记录，**只显示触发时间**（与归属自动化、状态），不展开具体操作 |

两种模式共用同一套**触发器**（§4）与同一份历史存储；区别只在「触发后干什么」。

## 1. 概念模型

```
AutomationDefinition（自动化定义）
├─ id / name / enabled / createdAt / updatedAt
├─ mode: 'agent' | 'normal'
├─ trigger: { kind, params }        ← 触发器（§4），一份自动化只有一个触发器
├─ prompt?: string                  ← Agent Mode：任务指令
└─ actions?: AutomationAction[]     ← Normal Mode：操作组件列表（顺序执行）

AutomationRun（运行记录）
├─ id / automationId / automationName / mode
├─ triggeredAt / finishedAt? / durationMs?
├─ status: 'running' | 'success' | 'failed' | 'interrupted'
├─ sessionId?                       ← Agent Mode：本次会话 id（即对话记录的入口）
└─ error?                           ← 失败原因（Normal Mode 不落操作明细，只落成败）
```

- **触发器（Trigger）**回答「什么时候做」：调度类（每天定时 / 固定间隔）或
  条件类（课堂场景：距上课 / 上课中 / 距下课 / 下课时 / 下节课是指定科目，见 §4.2）。
- **操作组件（Action）**回答「Normal Mode 具体做什么」：主进程注册表里的预设能力，
  用户不能在自动化里写代码、跑命令——Normal Mode 的面是**封闭组件集**（§5），
  这是它与 Agent Mode 的安全分界。
- **内置自动化（builtin）**：ClassRoom 模式既有的自动操作（课前提醒、课前自动打开
  科目文件夹）改由自动化引擎承接（§6），在 Normal Mode 的列表里以「内置」徽章出现，
  开关直接映射既有配置字段。

## 2. 存储与配置

### 2.1 数据文件（`<userData>/automations/`）

| 文件 | 内容 |
|---|---|
| `automations.json` | `AutomationDefinition[]`（用户自建自动化） |
| `history.json` | `AutomationRun[]`（运行历史，全量混排，按 `triggeredAt` 倒序展示；上限 **500** 条，超出淘汰最旧） |

存储实现遵循仓库统一约定（同 `SessionStore` / `JobStore`）：

- **in-flight promise 共享的 `ensureLoaded`**——并发首读共享同一 promise，
  读盘成功才置 `loaded`（否则并发首读拿到空快照、随后一次写入覆盖磁盘历史，
  本仓库已修过两次，禁止改回去）；
- 300ms 防抖 + 原子写（临时文件 → rename）；损坏文件备份 `.corrupt-<ts>.json` 后重建；
- `flush()` 供退出前调用。

**自动化定义不进 `config.json`**：它是用户数据（可多条、带历史），同会话 / 待办一样
走独立文件，不占 CONFIG_VERSION 迁移链。配置里只有一个总开关（下条）。

### 2.2 配置（CONFIG_VERSION 19）

```ts
automations: {
  /** 自动化总开关；关闭 = 引擎停止评估与触发（历史保留可看）。默认 true。 */
  enabled: boolean
}
```

- Schema：`packages/shared/src/config/schema.ts` 新增 `AutomationsSchema`；
  默认值 `defaults.ts` 补 `DEFAULT_AUTOMATIONS`；
- 迁移：`migrations.ts` 追加 `v18 → v19`（补默认值，幂等、不覆盖用户已写值）；
- **`automations` 整组加入 `SETTINGS_READONLY_PREFIXES`**：总开关是用户对「AI 能不能
  自己安排后台动作」的闸门，AI 的 `set_setting` 一律拒绝（同 `agent.permissionMode`
  的自我提权逻辑）。AI 想增删自动化走 §8 的专用工具（逐次确认）。

## 3. 引擎（`apps/desktop/src/main/automation/engine.ts`）

`AutomationEngine` 是主进程常驻服务，职责：按固定节拍评估所有启用的自动化、
去重触发、执行动作、记录历史。

- **节拍**：`setInterval` **15s**（分钟级精度足够，15s 保证 `daily` 的 HH:mm 匹配
  与课堂分钟窗口不漏拍）。引擎常驻（不随模式启停），每次 tick 前现读配置判断
  总开关与各自动化的启用条件——「改了没反应、要重启」是本仓库明令禁止的坑。
- **去重（firedKeys）**：每个条件触发输出一个**唯一键**（§4），引擎按自动化维护
  `Set<key>`，命中即跳过；键集合只在内存（重启后若仍在窗口内会再触发一次，
  与既有课前提醒行为一致）。跨天清理：只保留今天 / 明天星期对应的课表键。
- **互斥**：单次 tick 的执行体串行（`running` 标志防重入）；同一自动化触发后
  立即记录键再执行副作用（先记账后动手，失败不重试——同课前提醒的防刷屏口径）。
- **Normal Mode 执行**：顺序执行 `actions[]`，逐个容错（单个失败记 `warn` 继续）；
  全部执行完记 `success`（存在失败也记 `success`——历史只关心「触发过、做完了」，
  失败细节在日志）。
- **Agent Mode 执行**：
  1. 生成 runId 与会话 id（**两者相同**，`auto-<ts36>-<n>`，见 §7）；
  2. `agent.send({ sessionId, text: prompt, origin: 'automation', extraContext })`——
     `extraContext` 附带触发信息（自动化名 / 触发时间 / 条件快照，如「距上课 3 分钟」），
     模型因此知道「为什么被唤醒」；
  3. 订阅 `agent.onEvent` 过滤该会话：`done` → `success`（落 `durationMs`）、
     `error` → `failed`（落 `error`）；
  4. 启动补偿：引擎启动时把历史里遗留的 `running` 记录改判 `interrupted`
     （进程重启会话监听不存在了，不能永远「进行中」）。
- **Agent 会话的确认卡**：无人值守时敏感工具确认 60s 超时默认拒绝
  （`ProactiveScheduler` 既有语义）。自动化场景的推荐姿势是在该会话上用
  「本会话都允许」或把权限档设为 `auto`（根内免确认）——文档向用户说明，不做
  新的静默放行通道。
- **勿扰时段**：内置自动化保留既有语义（勿扰内跳过，§6）；用户自建自动化
  **不应用勿扰**（用户显式创建的定时任务不应被静默吞掉，在编辑界面提示）。
- **回调**：`onRunChanged`（历史落库后通知 IPC 层广播）、`onFired`（smoke 自测钩子）。

## 4. 触发器（Trigger）

### 4.1 调度类（不依赖课程表）

| kind | 参数 | 语义 | 去重键 |
|---|---|---|---|
| `daily` | `at: 'HH:mm'`、`weekdays?: number[]`（0=周日，缺省每天） | 每周指定天的 HH:mm 触发一次 | `daily-<ymd>-<at>` |
| `interval` | `everyMinutes: number`（5–1440） | 每 N 分钟触发一次 | `interval-<floor(nowMs / N)>`（对齐桶，重启不重复触发同一桶） |

### 4.2 课堂条件类（依赖课程表数据，`requiresSchedule: true`）

**全部从课程表（`IScheduleProvider.getToday`）推导，不依赖桥接 status 快照**——
课表是触发的事实来源（与既有课前提醒一致；status 快照只用于展示，桥接 README
亦约定「快照不用于触发」）。manual 课表同样可用这些条件。

| kind | 参数 | 语义 | 去重键 |
|---|---|---|---|
| `pre-class` | `leadMinutes: number`（1–120） | 距某节课开始 ≤ N 分钟（含启动补偿，同既有课前窗口 `0 ≤ minutesUntil ≤ lead`） | `<lessonKey>` |
| `class-start` | — | 进入某节课（`startTime ≤ now < endTime`） | `<lessonKey>` |
| `pre-end` | `leadMinutes: number`（1–120） | 正在上的课距结束 ≤ N 分钟 | `<lessonKey>` |
| `class-end` | — | 某节课刚结束（`endTime ≤ now < endTime + 1min`） | `<lessonKey>` |
| `next-lesson` | `subject: string`（科目名精确匹配） | 「下一节未开始的课」变为指定科目 | `<lessonKey>` |

- `lessonKey = <weekday>-<startTime>-<subject>`（复用 `schedule.ts` 既有函数）；
- 跨天：临近午夜（`needsNextDayLessons`）时补查次日课程（同既有课前提醒的
  `collectLessons` 逻辑）；
- 课程表不可用（provider 抛错 / 无课）时课堂条件本轮跳过，绝不抛错。

### 4.3 组件目录（catalog）

触发器与操作组件的**表单元数据**由主进程统一提供（渲染层编辑器与 Center 网页端
共用，新增组件只改注册表）：

```ts
interface AutomationConditionDescriptor {
  kind: AutomationTriggerKind
  label: string            // 中文展示名
  description: string
  fields: AutomationDescriptorField[]   // 动态表单字段
  requiresSchedule: boolean             // true = 依赖课程表（无课表数据时列为不可用）
}
interface AutomationDescriptorField {
  key: string
  label: string
  type: 'text' | 'number' | 'time' | 'weekdays' | 'select'
  min?: number; max?: number; step?: number
  options?: { value: string; label: string }[]
  placeholder?: string
  hint?: string
}
// 操作组件描述符（AutomationActionDescriptor）同构，字段为 actions 专属
```

## 5. 操作组件（Action，Normal Mode 的封闭能力集）

| kind | 参数 | 语义 | 不可用时 |
|---|---|---|---|
| `system-notify` | `title`、`body`、`openPath?`（点击通知打开的目录） | 系统通知（`NotificationService`） | 不会 |
| `classisland-remind` | `title`、`body`、`channel: 'custom' \| 'class-started' \| 'pre-class'` | 经 ClassIsland 桥接提醒通道弹出 | 未配置桥接时该组件在 catalog 中标记不可用（UI 不允许选；历史记录失败原因） |
| `open-folder` | `target: 'subject' \| 'path'`；`subject?`（科目名，解析到科目文件夹）或 `path?`（绝对路径） | 用系统默认方式打开文件夹 | 目录解析为空 → 该次执行记 `warn` 跳过 |

**封闭性就是安全边界**：Normal Mode 没有 `run_command`、没有任意写——
自动化的「无人值守」面被限制在通知 / 打开文件夹 / ClassIsland 提醒三个预设能力，
不引入新的确认或提权问题。要更强的能力请用 Agent Mode（受三档权限与确认链约束）。

## 6. 内置自动化（ClassRoom 自动操作的迁移）

ClassRoom 模式既有的自动操作（**自动分类除外**，它是独立管线不动）改由自动化引擎
以**内置自动化**承接，在 Normal Mode 列表中以「内置」徽章展示：

| id | 触发 | 操作 | 启用条件（现读，不落新状态） |
|---|---|---|---|
| `builtin.pre-class-notify` | `pre-class`（`leadMinutes` 现读 `modes.classroom.preClassLeadMinutes`） | `system-notify`（标题「课前提醒：<科目>」、正文「HH:mm 上课，还有 N 分钟」、点击打开科目文件夹） | 当前模式 = classroom **且** `modes.classroom.preClassReminder` **且** 非勿扰时段 |
| `builtin.pre-class-open-folder` | 同上 | `open-folder`（`target: 'subject'`，科目取自触发的课） | 当前模式 = classroom **且** `modes.classroom.preClassOpenFolder` **且** 非勿扰时段 |

- **行为与迁移前逐字一致**：同一去重键（`lessonKey`）、同一提前窗口、同一通知文案、
  勿扰语义、`onFired` 自测钩子——原 `PreClassReminder` 服务**退役删除**
  （`preClassTrigger` / `needsNextDayLessons` 纯函数保留在 `schedule.ts` 供条件评估复用）；
- 内置自动化**不可删除、不出现在编辑器**；开关即既有配置开关（切换写
  `preClassReminder` / `preClassOpenFolder`），触发历史照常进 Normal 历史；
- 两条内置自动化的历史 `automationId` 用上述常量 id（`builtin.` 前缀，
  引擎启动时清理 `builtin.` 前缀的用户自建同名定义，防伪造）。

## 7. Agent Mode 的会话与历史

- **会话 id**：每次 Agent 触发创建专属会话，`sessionId = runId = auto-<ts36>-<n>`。
  `auto-` 前缀会话**不进主界面左栏会话列表**（渲染层过滤，与 `center-` 可见性同款
  口径），只从自动化历史进入——历史弹窗经既有 `chat:history`（`sessionId`）回放对话。
- **origin**：`SendMessageRequest.origin` 与 `AgentJob.origin` 的联合类型各扩一个
  `'automation'`（内核只把它写进 job 记录与日志，无分支逻辑，扩联合即安全）。
- **标题**：会话标题沿用「首条用户消息前 24 字」推导（即任务指令摘要）。
- **用时**：从 `agent.send` 到 `done`/`error` 事件的墙钟时间。

## 8. Agent 工具与 Skill（对话式管理自动化）

**工具**（主进程 `apps/desktop/src/main/tools/automation-tools.ts` 注册，
**不受 `agent.tools.enabled` 门控**——它们管自动化元数据而非本机操控；
`automation_list` / `automation_history` 为 `safe`，其余 `confirm` 逐次确认）：

| 工具 | 灵敏度 | 参数摘要 |
|---|---|---|
| `automation_list` | safe | —（列定义 + 内置 + 摘要） |
| `automation_create` | confirm | name / mode / trigger{kind,params} / prompt 或 actions |
| `automation_update` | confirm | id + 局部字段（含 enabled 启停） |
| `automation_delete` | confirm | id |
| `automation_run` | confirm | id（手动触发一次） |
| `automation_history` | safe | automationId? / limit?（默认 20） |

创建 / 编辑自动化的**合法参数**以 catalog 为准：工具描述里给出触发器与操作的
kind 清单及参数形状；非法 kind / 缺参数直接 `E_INVALID_ARGUMENT`（工具描述 +
SKILL.md 双保险，模型给不出 catalog 之外的组件）。

**Skill**：`skills/automation/SKILL.md`（内置技能）——教模型如何把用户的自然语言
需求落成自动化：确认模式（agent/normal）、选择触发器、（Normal）拼装操作组件 /
（Agent）改写任务指令、创建后用 `automation_run` 试跑并回看 `automation_history`。
当用户说「每天早上……」「上课前帮我……」类需求时触发。

## 9. IPC 契约（新分组 `automation`）

通道（`namespace:action`，`on/off` 成对推送）：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `automation:list` | 渲染层 → 主 | → `{ user: AutomationDefinition[], builtin: AutomationDefinition[] }` |
| `automation:save` | 渲染层 → 主 | `AutomationDefinition`（id 为空 = 新建）→ 定义 |
| `automation:delete` | 渲染层 → 主 | `{ id }` |
| `automation:history` | 渲染层 → 主 | `{ automationId?, mode?, limit? }` → `AutomationRun[]` |
| `automation:run` | 渲染层 → 主 | `{ id }` → `{ runId }` |
| `automation:catalog` | 渲染层 → 主 | → `{ conditions, actions }`（§4.3；available 现取，不推送） |
| `automation:changed` | 主 → 渲染层（推送） | —（定义变化，各窗口重拉 list） |
| `automation:historyChanged` | 主 → 渲染层（推送） | —（新 run 落库 / 状态变化） |

- 返回值统一 `Result<T>`；内置自动化的启停走**既有** `settings:update`
  （`modes.classroom.preClassReminder` / `preClassOpenFolder`），不新增通道；
- 运行记录的对话回放复用 `chat:history`（§7），**不**新增历史明细通道；
- preload 三处同步（`shared/channels.ts` ↔ `preload/channels.ts` 编译期断言、
  `preload/index.ts`、`AuroraApi`）。

## 10. Aurora Center 远程管理

沿用「**客户端存数据、Center 只转发不缓存**」的会话管理模式：自动化定义与历史
都在桌面端，网页端经 WS 命令直达客户端。服务器**零存储改动**（hub 转发 switch
加 case 即可）。

**协议新增命令**（`CenterCommand` / `CenterWebMessage` 一一对应，带 `requestId` 回执）：

| 命令 | 语义 |
|---|---|
| `automation.list` / `automation.catalog` | 拉定义与组件目录 |
| `automation.save` / `automation.delete` | 新建 / 修改 / 删除（`automation.save` 原样转发） |
| `automation.run` | 手动触发 |
| `automation.history` | 拉运行历史 |

- 命令受客户端 `allowRemoteSession` 闸门（自动化是会话级能力，与远程会话同组）；
  `center.enabled` 关闭时整组不可用；
- **Web UI**：新增「自动化」视图（hash 路由 `#/automations`）——设备选择后
  列出该客户端的自动化（Agent / Normal 分组、内置徽章）、启停开关、手动运行、
  新建 / 编辑表单（catalog 动态渲染，与桌面编辑器同构简化版）、历史列表
  （触发时间 / 用时 / 状态；Agent 记录经 `session.history` 同款命令回放对话——
  复用 `automation.history` 返回的 `sessionId`）。

## 11. 桌面端 UI

- **入口**：主界面左栏固定项「自动化」（`data-field="chat.auto-item"`，同子代理项
  模式），点击后主区切到自动化页（`view = 'automations'`，与子代理页同构）。
- **自动化页**（`renderer/chat/components/AutomationPage.vue`）：
  - 顶部一行：标题 + 说明标记 + 双 tab「Agent Mode」/「Normal Mode」+
    右侧「新建」「历史」「返回对话」（窄窗口下动作组整体折行）；
  - 列表：卡片 = 名称 + **带图标的模式徽章** + 触发描述（如「每天 08:00」「距上课 ≤ 5 分钟」，
    行首是该条件的图标）+ 摘要（Agent Mode 为任务指令单行截断；Normal Mode 为**图标胶囊**，
    每个操作一枚「图标 + 短名」）+ 启停开关 + 立即运行 / 编辑 / 删除三枚图标钮（都带悬浮提示）；
    Normal tab 底部「内置」区展示两条内置自动化（徽章 + 开关映射既有配置 + 说明标记）；
  - 编辑器（弹窗形态，仓库首个 Modal 组件，`--z-popover` + 遮罩令牌）：
    名称、模式单选（带图标）、**触发条件 = 图标磁贴网格**（7 类各带语义图标，
    description 走悬浮提示）、catalog 动态字段（`AutomationFieldInput.vue`：
    `select` → 分段胶囊、`weekdays` → 星期胶囊，**编辑器内无原生下拉**）、
    Agent Mode → 任务指令 textarea；Normal Mode → 操作组件列表（行首序号 + 组件胶囊组
    （图标 + 组件名，点一下换组件）+ 移除钮 + 参数网格，可用性门控同「不渲染而不是 disabled」）；
  - **历史弹窗**：Agent tab 列出状态图标 / 触发时间 / 用时 / 归属自动化，点行展开
    对话回放（数据 = `chat:history(sessionId)`）；
    Normal tab 只列触发时间（+ 自动化名 + 状态图标），**无详情层**（口径：不展示
    具体操作）；
  - 文案密度与安全区的通用口径（悬浮提示组件 `AppTooltip`、左标签右控件、无原生下拉）
    见 docs/07 §5.4；
  - 推送订阅：`automation:changed` → 重拉列表；`automation:historyChanged` →
    历史弹窗开着时重拉。
- **设置页**：「模式」页新增「自动化」区组（总开关 `automations.enabled`，
  `data-field="automations.enabled"`）。

## 12. 安全与边界

- **Normal Mode 面封闭**（§5）；**Agent Mode 受既有三档权限 / 确认链 / 项目根边界**
  全量约束——自动化没有自己的权限体系，就是普通会话跑在无人值守时刻；
- `automations.*` 在 AI 的 `set_setting` 黑名单；AI 增删自动化走专用工具（confirm）；
- Center 命令走客户端属主 / admin 鉴权（hub 既有 `authorize`），受
  `allowRemoteSession` 闸门；
- 会话 id 前缀 `auto-` 归一白名单（`[A-Za-z0-9_-]`）天然合法；
  `normalizeSessionId` 防路径穿越语义直接复用；
- 自动化历史是**运行元数据 + Agent 会话引用**，不复制消息正文——删除会话后
  对话回放显示「会话不存在」（正常降级）。

## 13. 验证口径

- **单测**（不依赖 Electron）：条件评估纯函数（各 kind 的匹配 / 去重 / 跨天 /
  非法输入）、store（in-flight 并发首读、淘汰上限、损坏重建）、引擎（fake clock +
  fake provider 的触发矩阵、normal 动作序列、agent run 生命周期含 interrupted 补偿）、
  迁移 v18→v19、工具参数校验。
- **smoke（`AURORA_SMOKE`）**：既有课前提醒断言迁移到内置自动化路径
  （`onFired` 回执同款）；新增：种子自动化手动触发产生历史、Agent 触发产生
  `auto-` 会话且历史落 `success`。
- **capture（`AURORA_CAPTURE`）**：`chat-automation.png`（自动化页双 tab + 列表 +
  内置区 + data-field 门控计数）、`chat-automation-editor.png`（编辑器弹窗 +
  触发器动态字段）、`chat-automation-history.png`（Normal 历史列表 / Agent 历史
  详情弹窗）；设置页 modes 门控计数补 `automations.enabled`。
