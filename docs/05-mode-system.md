# 05 · 模式系统与 ClassRoom Mode 设计

状态：`已定稿`（ClassRoom 部分为 v1 基线；Work/Code 为接口预留）

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

- 注册表：`register(mode)`；启动时装配全部三个模式（classroom 为完整实现，work / code 为占位实现）。
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

## 3. ClassRoom Mode 详细设计（v1）

### 3.1 智慧感知文件夹

- 配置项：`modes.classroom.watchDir`（设置页与引导均可配置）。
- 监听：chokidar 监听 `add`；**稳定判定** = `awaitWriteFinish` + 连续两次 stat 尺寸不变（防“还在复制中”）。
- 忽略：隐藏文件、临时文件（`~$*`、`*.tmp`、`.DS_Store`、缩略图缓存等）。

### 3.2 分类管线

```
文件稳定 → 入队（并发 2） → 内容提取 → LLM 分类 → 科目映射 → 移动/复制 → 通知 + 分类流水
```

1. **内容提取（Extractor，utilityProcess 内执行）**
   - 文档（PDF / docx / pptx / xlsx / md / txt）：抽取前 N 段文本；
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
> | 内容提取 | `main/extract.ts`（纯逻辑）+ `extract-worker.ts`（utilityProcess 入口）+ `extract-pool.ts`（主进程侧池） | 用 **officeparser@7.8.0** 解析 pdf/docx/pptx/xlsx 等；txt/md/csv 自行读取（含 UTF-8/UTF-16/GBK 嗅探）；图片给尺寸、压缩包给条目清单；证据按**字节**做 head 70% + tail 30% 截断（只留头会丢文末结论、只留尾会丢标题线索）。超时 15s、崩溃重启、`import()` 懒加载；**任何失败都降级为「文件名证据」，绝不中断管线** |
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

### 3.4 上课前自动打开科目文件夹

- **v1（手动课程表）**：设置中维护每周课程表（星期 × 节次 → 科目）；课前 5 分钟系统通知 + 自动打开该科目文件夹（explorer）。
- **v2（ClassIsland 联动）**：通过 ClassIsland（开源桌面课程表应用）读取课程表，替代手动课程表。预留接口，实现可插拔：

```ts
export interface IScheduleProvider {
  id: 'manual' | 'classisland';
  getToday(now: Date): Promise<Lesson[]>; // Lesson: { subject, startTime, endTime }
}
```

> **实现说明（v0.5.0）**：`IScheduleProvider` 落地在 `apps/desktop/src/main/schedule.ts`，
> 除 `manual` 与 `classisland` 占位实现外，另导出纯函数 `preClassTrigger()`（判定「课前进度窗口内
> 应触发哪些课」，处理跨天、非法时间、同一节课只触发一次、**应用启动时的补偿触发**）、
> `parseClock()`、`lessonKey()` 与 `needsNextDayLessons()`。
> 定时与副作用在 `pre-class-reminder.ts`（30s tick）：命中后先记 `firedKeys` 再发通知 / 打开目录，
> 因此通知或打开失败都不会每 30s 重复刷屏；受 `modes.classroom.preClassReminder` 与勿扰时段约束。

#### v2 实现说明（v0.6.0）：ClassIsland 联动

**为什么不是"直接读 ClassIsland"**：ClassIsland 的扩展体系是 .NET（`PluginBase` + `manifest.yml`，
每个插件独立 `AssemblyLoadContext`），跨进程能力走 `dotnetCampus.Ipc` **命名管道**；
`classisland://` URI 只能触发应用内导航、**不传数据**；官方没有 HTTP API。
Aurora 是 Node/Electron 应用，无法直接消费上述任何一种。因此采用**桥接 + 双源**：

```
ClassIsland ──(C# 插件)──▶ 本地 JSON 契约 ──(读文件 / 读回环端点)──▶ Aurora 的 ClassIslandProvider
                                                                        │
                                          ┌─────────────────────────────┴───────────────────┐
                                    感知摘要（今日课程）        课前提醒（课前 5 分钟打开科目文件夹）
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

**已知未实现**：单双周、临时调课、班级区分等 ClassIsland 高级课表特性未映射到 Aurora 的
四字段 `Lesson` 模型；OCR 仍未启用。

## 4. Work Mode / Code Mode 接口预留

v1 两个模式均以**占位实现**注册（激活后仅注入提示词片段与占位引导），保证模式切换、引导、提示词注入全链路可用；具体能力通过 06 文档的扩展点预留：

| 模式 | v1 行为 | 预留能力位（P7 实现） |
|---|---|---|
| Work Mode | 占位注册，提示词说明“功能建设中” | 日程 / 邮件 / 待办、文档摘要、会议纪要 —— 对应 Skill / MCP 扩展点 |
| Code Mode | 占位注册，提示词说明“功能建设中” | 工作区项目识别、Git 状态感知、终端 / 命令执行工具组 |

## 5. 模式相关配置（详见 08 §1）

- `modes.current`：当前模式
- `modes.classroom.*`：watchDir、subjects（科目→文件夹映射）、schedule（课程表）、preClassReminder、guideCompleted
- `modes.work.*` / `modes.code.*`：v1 仅 `guideCompleted`
