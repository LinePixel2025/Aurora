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

### 3.3 通知与交互

- 分类完成 → 系统通知（“《xxx.pdf》已分类到 数学/”），点击通知打开对应文件夹。
- AI 交互窗口展示**分类流水**（时间 / 文件 / 科目 / 依据），支持用户就地修正。

### 3.4 上课前自动打开科目文件夹

- **v1（手动课程表）**：设置中维护每周课程表（星期 × 节次 → 科目）；课前 5 分钟系统通知 + 自动打开该科目文件夹（explorer）。
- **v2（ClassIsland 联动，P7）**：通过 ClassIsland（开源桌面课程表应用）的配置数据 / API / 插件机制读取课程表，替代手动课程表。预留接口，实现可插拔：

```ts
export interface IScheduleProvider {
  id: 'manual' | 'classisland';
  getToday(): Promise<Lesson[]>; // Lesson: { subject, startTime, endTime }
}
```

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
