# 05 · 模式系统与 ClassRoom Mode 设计

状态：`已定稿`（ClassRoom 为 v1 基线 + BetaV2 增补；Work 为 BetaV2 初步实装；Code 为接口预留）

## 1. 模式框架（packages/modes）

### 1.1 IMode 接口

```ts
// packages/modes/src/types.ts
export interface ModeContext {
  settings: SettingsStore;
  agent: AgentHost;
  watcher: FileWatcher;
  perception: PerceptionHub;
  events: ModeEventBus;
}

export interface IMode {
  id: 'work' | 'code' | 'classroom';
  displayName: string;
  description: string;
  icon?: string;
  /** 对话式引导定义；未完成时切换模式后触发 */
  guide?: ModeGuide;
  /** 激活 / 停用钩子（失败可回滚） */
  onActivate(ctx: ModeContext): Promise<void>;
  onDeactivate(ctx: ModeContext): Promise<void>;
  /** 注入该模式的系统提示词片段 */
  systemPrompt(ctx: ModeContext): string;
  /** 订阅的感知事件（如 classroom 订阅课前时间提醒） */
  perceptionSubscriptions?: PerceptionSubscription[];
}

export interface ModeGuide {
  id: string;
  steps: GuideStep[]; // 提问 → 收集 → 校验 → 写配置
  resumeable: boolean; // 可续接
}
```

### 1.2 ModeManager 职责

- 注册表：`register(mode)`；启动时装配全部三个模式（classroom 为完整实现，work 为初步实装，code 为占位实现）。
- 切换流程：前置校验 → 持久化 `modes.current` → `onDeactivate(旧)` → `onActivate(新)` → 广播 `mode:changed` → 若新模式 `guide` 未完成，触发主动引导（见 06 §9）。
- 约束：同一时刻仅一个模式激活；切换失败回滚并提示。

## 2. 对话式模式引导

1. 用户在设置中切换模式（或首次安装选择模式）后，ModeManager 检测该模式 `guide` 未完成；
2. Proactive 打开 AI 交互窗口，AI 以对话方式按 `guide.steps` 逐步询问；
3. 每步收集答案 → 校验 → 实时写入配置；全部完成后置 `modes.<id>.guideCompleted = true`；
4. 用户可随时中断；中断后标记为 pending，AI 在合适时机再次提醒（可在设置中关闭）。

**ClassRoom Mode 引导步骤**：

```
① 感知文件夹路径（默认 %USERPROFILE%\Aurora\感知文件夹，可改）
② 科目列表（默认模板：语文/数学/英语/物理/化学/生物/历史/地理/政治 + 自定义增删）
③ 每科目标文件夹（默认 <感知文件夹>/分类/<科目>）
④ 是否开启课前提醒（手动课程表）
→ 完成
```

**Work Mode 引导步骤（BetaV2 起实装）**：

```
① 工作目录（默认 %USERPROFILE%\Aurora\工作目录，可改；激活时不存在则自动创建）
② 确认完成（回复「知道了」，置 modes.work.guideCompleted）
→ 完成
```

## 3. ClassRoom Mode 详细设计（v1）

### 3.1 智慧感知文件夹

- 配置项：`modes.classroom.watchDir`（设置页与引导均可配置）。
- 监听：chokidar 监听 `add`；**稳定判定** = `awaitWriteFinish` + 连续两次 stat 尺寸不变（防“还在复制中”）。
  **chokidar 按需加载**（2026-10-04 性能轮）：静态 require 约 4MB RSS / 47ms，
  只有真正 `watch(dir)` 时才 `import('chokidar')`；未启用感知 / 未配置 `watchDir` 的进程不加载。
- 忽略：隐藏文件、临时文件（`~$*`、`*.tmp`、`.DS_Store`、缩略图缓存等）。

### 3.2 分类管线

```
文件稳定 → 入队（并发 2） → 内容提取 → LLM 分类 → 科目映射 → 移动/复制 → 通知 + 分类流水
```

1. **内容提取（Extractor，utilityProcess 内执行）**
   - 文档（PDF / Office / ODF / RTF / HTML / EPUB / Markdown / TXT 等）：抽取结构化文本；
   - 图片：文件名 + 元数据（OCR 为 P1 可选）；
   - 压缩包 / 其他：文件名 + 扩展名 + 元数据；
   - 证据大小上限 8KB，控制成本与耗时。
2. **LLM 分类（结构化输出）**
   - 输出 JSON Schema：`{ subject: string, confidence: number, reason: string }`；
   - Prompt 注入科目列表与每科关键词；`confidence < 阈值` → 进“待分类”。
3. **映射与落盘**
   - 科目 → 目标文件夹映射；重名自动加后缀（` (1)`）；移动失败回退复制；结果写入分类历史。
4. **规则缓存（省 token、提速）**
   - 高频分类沉淀为本地规则（如“文件名含‘数学’→ 数学”），命中规则跳过 LLM；
   - 用户修正分类时同步更新规则与历史。

> **实现说明（v0.4.0）** —— 落地位置与几处工程决策：
>
> | 环节 | 实现 | 要点 |
> |---|---|---|
> | 监听 / 稳定判定 | `main/file-watcher.ts`（chokidar） | `depth: 0`（科目文件夹在感知文件夹内，递归会造成自触发）、`awaitWriteFinish` 等价「连续两次 stat 尺寸不变」、忽略隐藏 / `~$*` / `*.tmp` / `*.crdownload` / `Thumbs.db`；**抑制集** + **监听代次**双重防回环（旧 watcher 的迟到事件按代次丢弃）。`ignoreInitial: false`：Aurora 启动前就已拖入的文件同样要归类 |
> | 队列 | `main/classify/queue.ts` | 并发 2、同路径去重、单文件失败不影响队列；每阶段发事件供渲染层实时刷新 |
> | 内容提取 | `main/extract.ts`（纯逻辑）+ `extract-worker.ts`（utilityProcess 入口）+ `extract-pool.ts`（主进程侧池） | 用 **officeparser@7.8.0** 解析 PDF、DOCX/PPTX/XLSX、ODF、RTF、HTML、EPUB；表格优先 CSV、其余优先 Markdown；文本类自行读取（含 UTF-8/UTF-16/GBK 嗅探）；图片给尺寸与可选视觉输入，压缩包给条目清单；证据按**字节**做 head 70% + tail 30% 截断（分类 8KB、自感知 24KB，只留头会丢文末结论、只留尾会丢标题线索）。超时 15s、崩溃重启、`import()` 懒加载；**任何失败都降级为「文件名证据」，绝不中断管线** |
> | 规则 | `main/classify/rules.ts` | 优先级：科目名字面命中(0.95) > 配置关键词(0.92) > 用户修正沉淀的学习规则(0.90)；不同科目同权重并列时**放弃并交给模型**（不猜）。规则只处理文件名（读内容就不省成本了） |
> | LLM 分类 | `main/classify/llm.ts` | 复用 OpenAI 兼容 provider 的 `response_format: json_object`；解析失败**降温度重试一次**，仍失败按未判定处理；科目必须在配置列表内；输出用括号平衡法抽取（能正确处理 `reason` 里的 `}`） |
> | 落盘 | `main/classify/paths.ts` | 优先 `rename`；失败回退 `copy` + **大小校验**后删源（校验不过则保留原文件并报错）；重名加 ` (1)`/` (2)`；`classification.autoMove=false` 时只记流水不动文件 |
> | 流水 | `main/classification-history.ts` | `userData/classification.json`，上限 500 条，原子写 + 300ms 防抖 + 损坏备份重建；写盘**串行化**（并发写会共用同一临时文件互相破坏，且先发起的写完成时会用旧快照清掉 `dirty` 导致丢数据） |
> | 通知 | `main/notifications.ts` | `Notification` + 点击打开目标文件夹；3s 去重；不可用时降级为日志并计数（自测据此断言） |
> | 装配 | `main/classification.ts` | 未配置可用模型时**在提取之前**就兜底（不去解析几十 MB 的 PDF 只为发现无法判定）；判定完成后 `movedTo` / `reason`（含降级告警）全部落到流水，可追溯 |
>
> **与文档的一处差异**：`AutoMove` 关闭时不会移动文件，只记录流水并标注原因——这是设置页可选项，
> 默认 `true`（与本文档一致）。
>
> **尚未实现**：用户修正后的「反哺规则」已落地（见 3.2 ④ 与 §3.3），
> 但**修正历史不参与跨启动的规则重建之外的学习**（不做基于内容的相似度学习）。
>
> **v0.6.0 补充**：`autoMove=false`（或移动失败、处理失败）时文件会留在感知文件夹里，
> 而 chokidar 的 `ignoreInitial: false` 每次启动都会再次报出同一个文件 ——
> 不去重就会反复记流水、反复弹通知。现在按 `(路径, 大小, 修改时间)` 作为"已处理"签名
> （落库在流水的 `modifiedAt` 字段），仅在记录**未被移动**（`movedTo` 缺失）时命中跳过；
> 原路径再次出现同名同大小的文件、或 mtime 已变化（用户改了内容）时仍会重新处理。

### 3.3 通知与交互

- 分类完成 → 系统通知（“《xxx.pdf》已分类到 数学/”），点击通知打开对应文件夹。
- AI 交互窗口展示**分类流水**（时间 / 文件 / 科目 / 依据），支持用户就地修正。

> **实现说明（v0.4.0）**：
> - 通知分两类：判定成功 → 「分类完成」（点击打开科目目录）；兜底 / 失败 → 「需要你确认分类」
>   （点击打开「待分类」目录）。二者都带 3s 去重。
> - 分类流水在 **AI 交互窗口的可折叠区块**（`renderer/shared/components/ClassificationLedger.vue`）
>   展示，挂载时经 `classification:history` + `classification:state` 水合，之后由
>   `classification:event` 实时追加；每行可「改到其他科目」（`classification:correct`）
>   与「打开所在文件夹」。
> - 修正会把文件移到新科目、把该条标记 `corrected: true`，并由修正记录**沉淀为学习规则**
>   （见 §3.2 ④）——同一类文件名再次出现时 `source` 为 `rule`，不再消耗模型调用。

### 3.4 课前提醒与上课前自动打开科目文件夹

- **v1（手动课程表）**：设置中维护每周课程表（星期 × 节次 → 科目）；课前 N 分钟系统通知 + 自动打开该科目文件夹（explorer）。N = `modes.classroom.preClassLeadMinutes`（默认 5，范围 1–30，v10 起可配）。
- **v2（ClassIsland 联动）**：通过 ClassIsland（开源桌面课程表应用）读取课程表，替代手动课程表。预留接口，实现可插拔：

```ts
export interface IScheduleProvider {
  id: 'manual' | 'classisland';
  getToday(now: Date): Promise<Lesson[]>; // Lesson: { subject, startTime, endTime }
}
```

> **实现说明（v0.5.0；v0.2.5 起迁到自动化引擎）**：`IScheduleProvider` 落地在
> `apps/desktop/src/main/schedule.ts`，除 `manual` 与 `classisland` 占位实现外，另导出纯函数
> `preClassTrigger()`（判定「课前进度窗口内应触发哪些课」，处理跨天、非法时间、同一节课只触发一次、
> **应用启动时的补偿触发**）、`parseClock()`、`lessonKey()` 与 `needsNextDayLessons()`。
> 定时与副作用自 **v0.2.5** 起由**自动化引擎的内置自动化**承接（见下与 docs/13 §6）：
> 原 `pre-class-reminder.ts` 的 `PreClassReminder` 服务**已删除**，
> `schedule.ts` 的 `preClassTrigger` / `needsNextDayLessons` 纯函数**保留**下来给触发条件评估复用。
> 既有行为逐字保留——命中后先记去重键再动手（通知或打开失败都不会重复刷屏）、
> 受 `modes.classroom.preClassReminder` 与勿扰时段约束；课前进度窗口自 **v10** 起取自
> `modes.classroom.preClassLeadMinutes`（默认 5 分钟，此前是常量 `DEFAULT_LOOKAHEAD_MINUTES = 5`），
> 现在由引擎**每次评估现读**，改设置无需重启（此前由装配层在构造时注入）。

> **课前提醒 = 内置自动化（v0.2.5，docs/13 §6）**：课前提醒不再是 ClassRoom 自有的定时服务，
> 而是自动化引擎里的一条**内置自动化**——它出现在**主界面「自动化 → Normal Mode → 内置」**区，
> 开关**直接映射既有配置字段**，不另立状态：

| id | 触发 | 操作 | 启用条件（引擎每次 tick 现读，勿扰时段在触发判定里跳过） |
|---|---|---|---|
| `builtin.pre-class-notify` | `pre-class`（提前窗口现读 `modes.classroom.preClassLeadMinutes`） | `system-notify`：标题「课前提醒：<科目>」、正文「HH:mm 上课，还有 N 分钟」、点击通知打开科目文件夹 | 当前模式 = `classroom` **且** `modes.classroom.preClassReminder` |
| `builtin.pre-class-open-folder` | 同上（同一节课、同一 `lessonKey` 去重） | `open-folder`（`target: 'subject'`，科目取自触发的课） | 当前模式 = `classroom` **且** `modes.classroom.preClassOpenFolder` |

- **引擎常驻、15s 节拍、每次现读配置**（引擎不随模式启停；改设置无需重启——同一条内置自动化
  的去重键仍是 `<lessonKey>`，因此每节课只触发一次）；
- **「自动打开科目文件夹」同样是内置自动化**（`open-folder` 操作组件），不是通知里的旁路副作用：
  两条内置自动化可分别开关，但共用同一次课前判定；
- 两条内置自动化**不可删除、不进编辑器**，启停即既有配置开关（设置页 / 主界面开关同一份字段），
  触发历史照常进「自动化 → 历史」（Normal Mode 只记触发时间与成败）；
- **自动分类不在这轮迁移内**：它仍是独立的分类管线（§3.2），与自动化引擎无关。

#### v2 实现说明（v0.6.0）：ClassIsland 联动

**为什么不是"直接读 ClassIsland"**：ClassIsland 的扩展体系是 .NET（`PluginBase` + `manifest.yml`，
每个插件独立 `AssemblyLoadContext`），跨进程能力走 `dotnetCampus.Ipc` **命名管道**；
`classisland://` URI 只能触发应用内导航、**不传数据**；官方没有 HTTP API。
Aurora 是 Node/Electron 应用，无法直接消费上述任何一种。因此采用**桥接 + 双源**：

```
ClassIsland ──(C# 插件)──▶ 本地 JSON 契约 ──(读文件 / 读回环端点)──▶ Aurora 的 ClassIslandProvider
                                                                        │
                                          ┌─────────────────────────────┴───────────────────┐
                                    感知摘要（今日课程）                课前提醒（内置自动化）
```

**数据契约**（Aurora 侧 `main/classisland.ts` 的 `ClassIslandPayload`）：

```json
{ "version": 1, "generatedAt": "2026-09-19T07:30:00Z",
  "lessons": [{ "weekday": 1, "startTime": "08:00", "endTime": "08:45", "subject": "数学" }] }
```

`weekday` 沿用 `Lesson` 语义（0=周日 … 6=周六，**7 也接受并折成周日**），
`lessons` **一次给全周**，当天筛选由 `getToday` 完成 —— 与既有 `IScheduleProvider` 契约天然对齐，
因此**感知摘要、课前提醒、`timetable` Skill 三条消费链零改动复用**。

| 关注点 | 决策 | 理由 |
|---|---|---|
| 数据源 | `file`（默认）或 `http`，配置在 `modes.classroom.schedule.classisland` | 文件最省事；端点适合不想让 Aurora 读文件 / 想要更及时的场景 |
| 失败语义 | **一律降级为空课表 + 记日志与告警，绝不抛出** | 课前提醒是增强能力，不能因为桥接插件没装就把主流程带崩（ADR-007） |
| 数据校验 | 逐行校验，非法行跳过并累积告警（带行号） | 宁可少一节课，也不要在错误的时间打开错误的科目文件夹 |
| 重复解析 | 按**原始文本**缓存，文本未变则复用上次结果 | 避免同一批告警每 30s 刷一次日志 |
| 读取频率 | provider 内置 TTL（默认 10s，`cacheTtlMs`）：TTL 内直接复用上次读取结果，显式测试 / 刷新才穿透 | 感知摘要逐 attempt 读、自动化引擎 15s tick、右栏 30s 轮询叠加时不再每次读文件 / 发 HTTP |
| provider 生命周期 | 按配置签名（source / endpoint / timeout）缓存单例，签名变化即重建 | 保留"文本未变则不重解析"的缓存必须跨 tick 存活；端点变更要立即生效 |
| 超时 | `timeoutMs`（默认 3000，Schema 约束 200–30000） | 桥接卡死时不能让 tick 挂住 |
| 可观测 | `classisland:status`（上次同步时间 / 今日课程数 / 告警 / 错误）+ `classisland:test`（立即解析并回传今日预览） | 「读不到」必须可诊断，否则用户只会看到"课前提醒没触发" |

**桥接插件**：源码随仓库提供在 [`integrations/classisland-bridge/`](../integrations/classisland-bridge/README.md)
（`Plugin.cs` + `BridgeOptions.cs` + `manifest.yml` + `.csproj` + 中文 README）。
插件订阅 `ILessonsService.CurrentClassPlan`，以**反射**读取课表结构
（插件与宿主的小版本不总是严格同步，硬编码字段名一旦对不上就是编译失败），
用**临时文件 + 覆盖重命名**原子写出 JSON（保证 Aurora 不会读到半截文件），
并可选开启仅监听 `127.0.0.1` 的只读端点。

> **验证程度**：桥接插件已用 **ClassIsland 2.1.0.1 的真实程序集编译（0 error）并实跑验证** ——
> ClassIsland 日志确认插件被加载，且写出了符合契约的 `schedule.json`，
> Aurora 侧也用它真实产出的文件验证过解析（零告警、星期/时间/科目均正确）。
> 但本仓库 CI **不编译**它（流水线无 .NET SDK），因此改动后需在装有 .NET SDK 与
> ClassIsland 的机器上重新验证。
>
> 实现要点（都是踩过坑后确定的）：`PluginBase` **只有** `Initialize` 一个抽象成员，
> 生命周期要挂 `AppBase.Current` 的 `AppStarted` / `AppStopping` 事件；
> 取服务用接口上的**静态**方法 `IAppHost.TryGetService<T>()`（`AppBase` 没有 public `Services` 属性）；
> 课表按**日期**取（`ILessonsService.GetClassPlanByDate`），星期与单双周轮换由 ClassIsland 自己算，
> 比解读 `TimeRule` 可靠；科目名要经 `IPublicProfileService.Profile.Subjects`（Guid 字典）查，
> 查不到就**跳过该节次**而不是编造名字。
> Aurora 侧契约不变，插件端调整范围限于 `Plugin.cs`。

**桥接插件 v2（BetaV2）**：

- **status.json（当前 / 下节课状态）**：与 `schedule.json` 同目录、原子写，30s tick 与课程切换
  事件时刷新——`{ version, generatedAt, onClass, currentSubject, nextSubject, nextStartTime }`。
  Aurora 侧 `main/classisland.ts` 读取并经 `getStatus()` 透出（`classisland:status` IPC），
  交互窗右栏的「当前 / 下节课」卡直接消费；课程类问题优先信 status，缺失时回退按课表推算。
- **ClassIsland 自身的提醒能力**：课程切换（OnClass）与课前 N 分钟
  （`BridgeOptions.RemindBeforeClassMinutes`，默认 2，bridge.json 可配）通过 ClassIsland 的
  通知服务（`INotificationService`）弹课程提醒；通知服务不可用时**降级**为仅写 status.json +
  日志告警。它与 Aurora 自己的课前提醒相互独立、可并存。

**桥接插件 v3**：

- **状态快照升级到 version 3**：新增 `currentStartTime` / `currentEndTime`（上课中当前节的起止
  `HH:mm`）与 `nextEndTime`（下节课结束时间）。取不到的字段**不写**，绝不编造。
  `schedule.json` 的 `version`（课表结构版本）**保持 1 不变**，只动内嵌 `status.version`。

status v3 字段表（`schedule.json` 内嵌 `status` 与同目录 `status.json` 内容完全一致）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number | 状态格式版本：v2 为 `2`，v3 起为 `3`（与 schedule.json 的 `version` 互不相干） |
| `generatedAt` | string | 快照生成时间（ISO 时间戳） |
| `onClass` | boolean | 是否处于上课状态（ClassIsland 实时课程状态 `CurrentState == OnClass`） |
| `currentSubject` | string | 当前课科目（经桥接侧 `subjectMap` 映射后的 Aurora 侧名称）；不在上课 / 未知时缺省 |
| `currentStartTime` / `currentEndTime` | string | **v3 新增**：当前节次起止 `HH:mm`（上课中才有）；取不到则缺省 |
| `nextSubject` / `nextStartTime` | string | 今天下一节「上课」类型节次的科目与开始时间（「下一节」= 开始时间严格晚于当前时刻的最近一节） |
| `nextEndTime` | string | **v3 新增**：下节课结束时间 `HH:mm`；没有下一节 / 取不到则缺省 |

版本宽容：Aurora 侧 `parseBridgeStatus` **不按版本分派** —— 字段逐个宽容解析、坏字段丢弃，
版本号只记录不拒绝，因此老 Aurora 读 v3 数据、新 Aurora 读 v2 数据都不会整份作废。

**提醒命令通道（v3 新增，Aurora → ClassIsland）**：让 Aurora 能调用 ClassIsland 的提醒能力
（`classisland:notify` IPC 与 `classisland_remind` 工具）。

- **文件模式**：Aurora 原子写入 `<桥接输出目录>/command.json`：

  ```json
  { "version": 1, "id": "<唯一串>", "kind": "notify",
    "channel": "custom | class-started | pre-class",
    "title": "…", "body": "…", "createdAt": "<ISO>" }
  ```

  插件以 `FileSystemWatcher` + 防抖读取（另有 30s 兜底 tick 比较 id / mtime），
  经 ClassIsland 通知服务弹出，并把结果原子写入同目录 `command-result.json`：

  ```json
  { "version": 1, "id": "<回显>", "ok": true, "error": "<可选>", "handledAt": "<ISO>" }
  ```

  **按 `id` 去重**（同 id 不重复弹出、不重复写结果）；命令文件本身**不删除**
  （Aurora 可能回读），已处理 id 记在插件内存里，因此 id 变化才处理。
  启动补救有**过期保护**：`createdAt` 距今超过 10 分钟的命令跳过不弹（否则重启会弹出
  上一节课的提醒）；缺 `createdAt` 时无法判断新旧，照常处理。
- **HTTP 模式**（`enableHttpEndpoint` 打开时）：`POST /notify`，请求体与 `command.json` 同构，
  响应体与 `command-result.json` 同构（`Content-Type: application/json`）；
  `GET /schedule`（及其它 GET）行为**保持不变**，仍返回含内嵌 `status` 的课表 JSON。
  路由按 method + path 分派（v3 之前该 handler 完全不看 `context.Request`）。
- **渠道映射**：`custom` → 「Aurora 提醒」渠道（v3 新增渠道）；`class-started` / `pre-class` →
  v2 已有的两个课程提醒渠道。提醒不可用（提供方未注册 / 通知服务不可用）时**降级为
  仅写 `command-result.json` + 日志**（`ok: false` + `error`），绝不抛出、绝不影响课表导出。
- `enableCommandChannel`（v3 新增，默认 `true`）：为 `false` 时既不起 `FileSystemWatcher`、
  也不响应 `POST /notify`（返回 404），课表导出与课程提醒不受影响。

Aurora 侧：文件模式写 `command.json` 到**课表文件同目录**并轮询 `command-result.json` 等
`id` 匹配（超时用 `modes.classroom.schedule.classisland.timeoutMs`）；HTTP 模式
`POST <端点 origin>/notify`（端点带路径时按 origin 拼接，即
`http://127.0.0.1:17945/schedule` → `http://127.0.0.1:17945/notify`）。

**已知未实现**：单双周、临时调课、班级区分等 ClassIsland 高级课表特性未映射到 Aurora 的
四字段 `Lesson` 模型；OCR 仍未启用。桥接插件**没有注册 ClassIsland 设置页**（README 曾称可在
插件设置页调整，与实现不符，v3 起如实修正）：`bridge.json` 需手工编辑。

### 3.5 Agent 可修改的 ClassRoom 设置（BetaV2）

ClassRoom 的系统提示词会附上「你可以修改的 ClassRoom 设置」清单，指导 Agent 用 `set_setting`
工具代用户调整；改动**即时生效**（watchDir / subjects / classisland.endpoint 变化会重挂文件
监听、重建数据源）：

| 配置路径 | 含义 |
|---|---|
| `modes.classroom.watchDir` | 智慧感知文件夹路径 |
| `modes.classroom.subjects` | 科目列表（每项 name / folder / keywords） |
| `modes.classroom.schedule.provider` | 课程表来源（`manual` / `classisland`） |
| `modes.classroom.schedule.lessons` | 手动课程表（weekday / startTime / endTime / subject） |
| `modes.classroom.schedule.classisland.endpoint` | ClassIsland 桥接数据源（文件路径或 HTTP 端点）；文件源读取失败时自动按桥接插件默认输出路径 `%APPDATA%\ClassIslandurora-bridge\schedule.json` 回落重试一次（v0.2.4），回落成功会置 `classisland:status` 的 `usedFallback` 状态位（并在日志里提示对齐两端配置） |
| `modes.classroom.preClassReminder` | 课前提醒开关 |
| `modes.classroom.preClassLeadMinutes` | 课前提前分钟数（1–30，默认 5；v10 新增） |
| `modes.classroom.preClassOpenFolder` | 课前提醒是否自动打开科目文件夹 |
| `modes.classroom.classification.autoMove` | 判定成功后是否自动移动文件 |
| `modes.classroom.classification.confidenceThreshold` | 分类置信度阈值（低于则进「待分类」） |
| `modes.classroom.classification.fallbackFolder` | 待分类兜底目录 |

`schedule.provider = classisland` 时，课程表来自 ClassIsland 桥接插件，感知摘要包含今日课程与
当前 / 下节课状态（见 §3.4 v2）；此时课前提醒改用桥接课表，手动课表条目不再参与。

> **课堂自动操作的基座口径（v0.2.5）**：ClassRoom 的自动操作基座已换成**自动化引擎**
> （课表条件 → 触发 → 内置动作，§3.4）。后续新增的课堂自动操作（铃声前后动作、课后清理、
> 按科目切换某处状态等）应作为**内置自动化**或**用户自动化**接入，
> **不要另外写定时服务**——否则「改了设置不生效」「与引擎抢触发」这类坑会重新长出来。

## 4. Work Mode（BetaV2 初步实装）与 Code Mode（占位）

### 4.1 Work Mode

v1 占位的 Work Mode 在 BetaV2 完成**初步实装**（`packages/modes/src/work.ts`，`placeholder: false`，displayName「工作模式」）：

- **引导（`work-setup`，两步、可续接）**：
  1. 询问工作目录 → `modes.work.workspaceDir`（默认 `%USERPROFILE%\Aurora\工作目录`，可回复
     绝对路径；引导的 `apply` 是同步契约，目录创建在模式激活时经 `ModeFsPort.ensureDir` 完成，
     失败只告警、不阻断激活）；
  2. 确认完成（回复「知道了」）→ 置 `modes.work.guideCompleted`。
- **职责（systemPrompt）**：办公文档助手——擅长 Word 文档、Excel 表格、PowerPoint 演示文稿与
  PDF 的处理、总结与生成；优先使用 `office_read` / `office_create` / `office_edit` 处理
  DOCX / XLSX / PPTX（纯 JS worker，不依赖本机 Office），默认另存、显式覆盖才写回源文件并
  先保存二进制快照；只有用户明确要求旧格式、宏、复杂格式或 PDF 导出等高级能力时，才说明风险
  并经确认走 `run_command` COM 兜底。**覆盖 / 删除 / 移动文件前必须先向用户确认**；
  产出文件保存到生效工作目录。
- **工作目录是回落链的一级（v0.2.4，Codex 式统一，docs/06 §5.1）**：`modes.work.workspaceDir`
  不再是提示词里的孤立概念 —— 它插在 `effectiveWorkspaceDir` 回落链的
  **当前项目根之后、`agent.tools.workspaceDir` 之前**（仅当激活模式为 Work 且目录非空时参与）。
  2026-09-30 会话三分起，**在 Work 模式下新建的「工作目录对话」会话**（`meta.space: 'work'`，
  docs/06 §4 / docs/07 §2.3）把工作目录**显式钉在会话上**：空间目录排在全局当前项目之前，
  这些会话的工作目录不随用户切 `projects.current` 漂移（绑了项目的会话仍以项目为准）。
  缺省 `cwd` / 搜索根、写入边界、confirm 档「根内写免确认」与 auto 档免确认边界全部落在
  同一条链解析出的目录上 —— 提示词与工具链同源，Work 模式不再与项目指定互相打架
  （二者都不配置时回落 `agent.tools.workspaceDir` / 主目录）。
- **感知订阅**：`[{ kind: 'clock', intervalMs: 60000 }]`。
- **与 ClassRoom 的功能边界**：工作模式**不包含**课堂 / 课程表 / 课件分类功能——那些属于
  ClassRoom Mode；提示词明确声明边界并引导用户切换模式。切换到 Work 后，渲染层也不再渲染
  课堂相关卡片（见 07 文档的主界面右栏规格）。
- 局限：日程 / 邮件 / 待办、深度文档排版等能力仍未提供；`workReadiness()` 导出供设置页展示
  缺失项（工作目录未配置不阻塞对话，只是产出落点未定）。

### 4.2 Code Mode（仍为占位）

Code Mode 保持**占位实现**：引导一步（确认知晓），提示词说明「功能建设中」；工作区项目识别、
Git 状态感知、终端 / 命令执行工具组留待后续版本（能力位通过 06 文档的扩展点预留）。
会话空间的 `'code'` 取值已为它预留（`SessionSpace` 类型，docs/06 §4）——
Code Mode 实装时左栏「项目对话」区之外将出现自己的分区，当前**不产生**该取值。

| 模式 | 当前状态 | 预留能力位（后续实现） |
|---|---|---|
| Work Mode | 初步实装（guide + 办公 systemPrompt + workspaceDir） | 日程 / 邮件 / 待办、深度文档排版、会议纪要 |
| Code Mode | 占位注册，提示词说明“功能建设中” | 工作区项目识别、Git 状态感知、终端 / 命令执行工具组 |

## 5. 模式相关配置（详见 08 §1）

- `modes.current`：当前模式
- `modes.classroom.*`：watchDir、subjects（科目→文件夹映射）、schedule（课程表）、preClassReminder、preClassOpenFolder、classification（autoMove / confidenceThreshold / fallbackFolder）、guideCompleted
- `modes.work.*`：guideCompleted、workspaceDir（BetaV2 起，办公工作目录）
- `modes.code.*`：仅 `guideCompleted`（占位）

## 6. 模式能力对齐（v0.2.0 定稿）

**原则：模式差异只体现在「自主感知能力」与「特化功能」两处，绝不裁剪 Agent 的基础能力。**

具体口径：

1. **工具集全模式一致**：工具注册（内核 `ToolRegistry` + 三档权限 `permissionMode`）
   与模式无关 —— 任何模式下的 Agent 都拥有同一份工具清单（受 `agent.tools.enabled`、
   `agent.permissionMode`、`center.enabled` 等全局门控约束，但不按模式裁剪）。
   `ModeManager` 不参与工具注册。
2. **差异只允许出现在两处**：
   - **自主感知**（`perceptionSubscriptions`）：classroom 订阅文件监听与课程时钟、
     work 订阅时钟、code 暂无 —— 感知差异影响"Agent 主动知道什么"，不影响"Agent 能做什么"；
   - **特化功能**（`systemPrompt` 片段 + guide + 模式专属配置）：classroom 的分类管线 /
     课前提醒、work 的办公文档指引与工作目录。特化功能**只增不减**：模式提示词可以
     声明"本模式的特化能力边界"（如 code 的"功能建设中"），但**不得声明或暗示**
     基础工具（文件 / 命令 / 检索 / Center 等）在当前模式不可用。
3. **回归护栏**：`packages/modes/src/manager.test.ts` 的能力矩阵用例断言三个模式
   `capabilities.tools` 恒等（`MODE_CAPABILITY_MATRIX` 导出，见 `packages/modes/src/capabilities.ts`），
   防止未来有人给某个模式加"工具裁剪"。
