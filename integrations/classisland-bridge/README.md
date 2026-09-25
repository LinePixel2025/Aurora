# Aurora × ClassIsland 桥接插件

把 [ClassIsland](https://classisland.tech/) 的课表暴露给 [Aurora](../../README.md)，
让 Aurora 的「课前自动打开科目文件夹」与「今日课程感知」不再需要手工维护课表；
v2 起还会通过 ClassIsland 自己的提醒服务弹出上课 / 课前提醒。

> **为什么需要这个插件？** ClassIsland 的扩展体系是 .NET，跨进程能力走
> `dotnetCampus.Ipc` 命名管道，`classisland://` URI 只能做应用内导航、**不传数据**，
> 官方也没有 HTTP API。Aurora 是 Node/Electron 应用，无法直连它的 IPC。
> 因此由本插件在 ClassIsland 内部把课表写成一份**稳定的本地 JSON**（或暴露本地端点），
> Aurora 只读这份契约 —— 双方各自演进，互不绑定内部实现。

## v2 变更（2.0.0.0）

- **新增当前课状态快照**：同一份状态一处计算、两处输出 —— **内嵌为 `schedule.json`
  根对象的 `status` 属性（Aurora 实际消费的就是这份）**，另写同目录的
  `status.json` 兄弟文件（供人工查看 / 其他工具）。两个文件内容完全一致，
  30 秒周期与课程切换事件都会刷新（契约见下）。
- **接入 ClassIsland 的提醒服务**：插件注册为 ClassIsland 的提醒提供方「Aurora 桥接」，
  含「上课提醒」「课前提醒」两个提醒渠道；课程切换（`ILessonsService.OnClass`）与
  课前 N 分钟（`remindBeforeClassMinutes`，默认 2，0 = 关闭）会通过
  `NotificationChannel.ShowNotification` 弹出 ClassIsland 风格的覆盖层提醒，
  可在 ClassIsland「设置 → 提醒」里按提供方 / 渠道开关。
- `schedule.json` 的路径、结构与版本（v1）**完全不变**，仅根对象多一个可选 `status`
  属性（Aurora 对多余字段宽容），Aurora 旧配置无需改动。

## 数据契约

### schedule.json（v1，结构不变）

Aurora 侧消费这份契约（`apps/desktop/src/main/classisland.ts` 的 `ClassIslandPayload`），
v2 起根对象带一个可选的 `status` 快照：

```json
{
  "version": 1,
  "generatedAt": "2026-09-19T07:30:00Z",
  "lessons": [
    { "weekday": 1, "startTime": "08:00", "endTime": "08:45", "subject": "数学" }
  ],
  "status": {
    "version": 2,
    "onClass": true,
    "currentSubject": "数学",
    "nextSubject": "语文",
    "nextStartTime": "09:20",
    "generatedAt": "2026-09-25T08:00:00.123+08:00"
  }
}
```

| 字段 | 说明 |
|---|---|
| `weekday` | `0`=周日 … `6`=周六（`7` 也会被 Aurora 折成周日）；越界值该条被跳过 |
| `startTime` / `endTime` | `HH:mm`（`8:05` 这类未补零写法 Aurora 也能读） |
| `subject` | 科目名，**必须与 Aurora 设置里科目列表的名称一致**，否则课前提醒找不到对应文件夹 |
| `lessons` | 一次性给出**整周**课表；当天筛选由 Aurora 完成 |

Aurora 对非法数据是**逐条跳过并记告警**，不会整份作废，也不会因为桥接不可用而阻塞主流程
（读不到就当作"今天没有课"）。内嵌的 `status` 对象是可选的：缺失时 Aurora 只是拿不到
当前课状态，不影响课表解析。

### status.json（v2 新增）

与 `schedule.json` 同目录（默认 `%APPDATA%\ClassIsland\aurora-bridge\status.json`），
每次写课表时一并原子写出，**内容与 schedule.json 内嵌的 `status` 属性完全相同**
（同一次计算、两个输出，`generatedAt` 等字段不会各说各话）。
**Aurora 消费的是 schedule.json 里内嵌的那份**；status.json 主要供人工查看 / 排障
及其他工具读取：

```json
{
  "version": 2,
  "generatedAt": "2026-09-25T08:00:00.123+08:00",
  "onClass": true,
  "currentSubject": "数学",
  "nextSubject": "语文",
  "nextStartTime": "09:20"
}
```

| 字段 | 说明 |
|---|---|
| `version` | 状态格式版本，当前为 `2`（与 schedule.json 的 `version` 互不相干） |
| `onClass` | 是否处于上课状态，取自 ClassIsland 实时课程状态（`CurrentState == OnClass`） |
| `currentSubject` | 当前上课的科目名（经 `subjectMap` 映射后的 Aurora 侧名称）；不在上课或未知时为空串 |
| `nextSubject` / `nextStartTime` | 今天下一节"上课"类型节次的科目与开始时间 `HH:mm`；与 schedule.json 同源（`GetClassPlanByDate`），上课中取的是下一节，课间取的是紧接着的那节；没有则为空串 |

取不到的字段一律**空串**，不编造。Aurora 侧把它当作快照消费（当前/下节课卡），
不用于触发科目文件夹等动作 —— 那仍以 schedule.json 的课表为准。

## 两种工作模式

| 模式 | Aurora 侧配置 | 适用 |
|---|---|---|
| **文件**（默认） | 数据来源选「JSON 文件」，端点填下面写出的文件绝对路径 | 最省事，无需开放端口 |
| **HTTP** | 数据来源选「本地 HTTP 端点」，端点填 `http://127.0.0.1:17945/schedule` | 需要更实时的数据 / 不想让 Aurora 读文件 |

文件模式下，插件在以下时机重写两份 JSON：ClassIsland 启动完成、课程切换（OnClass）、
时间状态切换，以及一个低频定时器（默认 30 秒）兜底 —— 老师的临时调课也能在 30 秒内反映到 Aurora。

## 课程提醒（v2）

- 提醒通过 **ClassIsland 的通知服务**送进 ClassIsland 自己的提醒 UI（覆盖层展示约 10 秒，
  不做全屏遮罩）。插件以提醒提供方「Aurora 桥接」（两个渠道：上课提醒 / 课前提醒）
  的身份接入，是否弹出、是否朗读等由 ClassIsland 的通知设置决定。
- **上课提醒**：`ILessonsService.OnClass`（课程切换）时发出，内容为「上课了：科目（起止时间）」。
- **课前提醒**：下节课开始前 `remindBeforeClassMinutes` 分钟发出（30 秒粒度检查，
  同一节课只提醒一次；启动晚了但仍在提前窗口内会补提醒）。
- **降级路径**：提醒提供方解析失败或通知服务不可用时，提醒自动降级为
  「仅刷新课表导出（schedule.json + 内嵌 status + status.json）+ 写日志」，不影响课表导出。
  ClassIsland 日志里会出现「提醒提供方不可用」的告警。
- 注意：ClassIsland 自带「上下课提醒」提供方，与本插件的提醒内容相近。
  两者同时开启会看到重复提醒 —— 只用其一即可（ClassIsland 的通知设置里可分别开关）。

## 构建

需要 .NET SDK 8.0+，以及**已安装的 ClassIsland**（插件不通过 NuGet 引用它，
而是直接引用你本机的那份程序集，避免版本错配）。

```bash
# 指向 ClassIsland 安装目录即可（完整包会自动往下找 app-<版本>/ 那一层）
dotnet build -c Release -p:ClassIslandDir="<ClassIsland 安装目录>"
```

也可以设置环境变量 `CLASSISLAND_DIR`，或用默认推断（`%LOCALAPPDATA%\Programs\ClassIsland`
与 `%ProgramFiles%\ClassIsland`）。

产物在 `bin/Release/net8.0/`。两种安装方式任选：

- **手工复制**：把 `AuroraClassIslandBridge.dll` 与 `manifest.yml` 复制到 ClassIsland 的插件目录：

  ```
  <ClassIsland 安装目录>\data\Plugins\aurora-classisland-bridge\
  ```

- **插件包**：`dist/AuroraClassIslandBridge-v2.0.zip`（`manifest.yml` 在压缩包根目录 +
  插件 dll，符合 ClassIsland 插件包格式，放进其插件包目录即可被识别安装）。

重启 ClassIsland 后，在「设置 → 插件」里应能看到「Aurora 桥接」并已加载；
「设置 → 提醒」里会出现「Aurora 桥接」提供方。

> 装好的插件配置位于 `<ClassIsland>\data\Config\Plugins\aurora-classisland-bridge\bridge.json`，
> 桥接输出默认写到 `%APPDATA%\ClassIsland\aurora-bridge\schedule.json` 与同目录 `status.json`。

## 已验证程度

| 项 | 状态 |
|---|---|
| 用 ClassIsland **2.1.0.1** 的真实程序集编译（v2 含通知 API） | ✅ 0 error / 0 warning（已实际执行；通知 API 均按 2.1.0.1 程序集元数据与官方源码 tag 2.1.0.1 核对：`NotificationProviderBase` / `NotificationChannel.ShowNotification(NotificationRequest)` / `NotificationContent.CreateSimpleTextContent`） |
| 被 ClassIsland 加载（日志显示「此次会话已加载插件: Aurora 桥接」） | ✅ v1 已实际运行验证；v2 新增的提醒提供方注册尚未实跑验证 |
| 写出 `schedule.json`，内容符合 Aurora 契约 | ✅ v1 已实际运行验证（v2 未改动路径 / 结构 / 版本）；v2 起根对象内嵌 `status` 属性 ⚠️ 仅编译验证 |
| 写出 `status.json`（与内嵌 `status` 同一份快照） | ⚠️ v2 新增：仅编译验证，尚未实跑验证 |
| 课程提醒在 ClassIsland UI 中弹出 | ⚠️ v2 新增：仅编译验证，尚未实跑验证；不可用时有降级路径（仅 status.json + 日志），不会影响 ClassIsland 运行 |
| Aurora 侧解析真实输出（零告警、星期/时间/科目正确） | ✅ 已用 v1 真实产出文件验证 |
| 生命周期收尾（`AppStopping` 再写一次） | ✅ v1 已验证 |
| 不同 ClassIsland 版本的兼容性 | ⚠️ 仅在 2.1.0.1 验证；`manifest.yml` 的 `apiVersion` 为 `2.0.0.0` |

> v2 未做实机运行验证的原因：提醒弹出与 status.json 时序需要真实课堂环境观察。
> 若升级后发现提醒不弹出，请先看 ClassIsland 日志（搜「Aurora 桥接」）：
> 提供方未注册 / 渠道未命中会走降级路径，只影响提醒，不影响课表导出。

## 配置

插件启用后，在 ClassIsland 的插件设置页可以调整（`bridge.json`）：

- **输出文件路径**：默认 `%APPDATA%\ClassIsland\aurora-bridge\schedule.json`
  （**不要**放在插件安装目录里：插件更新会清空该目录；`status.json` 固定写在同目录）
- **课前提醒分钟数** `remindBeforeClassMinutes`：默认 `2`；`0` = 关闭课前提醒
  （上课提醒始终随课程切换发出，可在 ClassIsland 通知设置里单独关闭）
- **启用本地 HTTP 端点**：默认关闭
- **HTTP 端口**：默认 `17945`，仅监听 `127.0.0.1`（不对外暴露）
- **科目名映射**：把 ClassIsland 的科目名映射成 Aurora 侧的科目名
  （例如 ClassIsland 里叫「数学（必修）」，Aurora 的文件夹叫「数学」；
  status.json 的 currentSubject / nextSubject 同样应用该映射）

## 在 Aurora 里接线

1. 打开 Aurora「设置 → 模式 → ClassRoom → 课程表」
2. 「课程表来源」选 **ClassIsland 联动**
3. 「数据来源」选文件或 HTTP，填上路径 / 端点
4. 点「**测试连接**」：应显示今日课程条数；若为 0 条，请确认今天是休息日、
   或 `subject` 与 Aurora 科目名是否一致
5. 保存后，课前提醒（若已开启）就会按 ClassIsland 的课表触发

## 排障

| 现象 | 排查方向 |
|---|---|
| 测试连接报「尚未配置 ClassIsland 桥接端点」 | 端点/路径还没填 |
| 测试连接报「请求超时」/ 文件读取失败 | 插件是否已加载（ClassIsland 日志里搜「Aurora 桥接」）？文件模式看路径是否存在；HTTP 模式看端口是否被占用 |
| ClassIsland 启动后没生成 `schedule.json` | 看 ClassIsland 日志有没有插件加载记录；`AutoDisableCorruptPlugins` 打开时，加载失败的插件会被自动禁用 |
| 读到 0 条课程 | 今天是否有课（课表按**星期**匹配，周日与周一不是同一份）；课表是否已启用 |
| 有课程但课前提醒没打开文件夹 | `subject` 与 Aurora 科目名不一致（会被跳过，Aurora 日志里有告警）；两边叫法不同时用 `subjectMap` 映射 |
| 上课 / 课前提醒不弹出 | 插件提醒是否被 ClassIsland 通知设置关闭（「设置 → 提醒 → Aurora 桥接」）；`remindBeforeClassMinutes` 是否为 0；日志里是否有「提醒提供方不可用」（有则说明走了降级路径，仅影响提醒） |
| 提醒与 ClassIsland 自带的「上下课提醒」重复 | 两套提醒同时开启所致，关掉其中一套即可 |
| 空节次被导出成课程 | 不该发生：`SubjectId` 为空（`00000000-…`）的节次会被跳过。若出现请反馈 |

### 关于科目名

插件导出的是 **ClassIsland 里的科目名**（经 `subjectMap` 映射后）。
Aurora 侧科目列表里的名称必须与之对应，否则该节课会被 Aurora 跳过并记告警 ——
这是刻意设计：宁可少一节课，也不要在错误的时间打开错误的科目文件夹。

Aurora 侧的桥接状态与告警可以直接在「课程表」设置区看到，日志在
`%APPDATA%\Aurora\logs\`。

## 已知限制

- 本插件按 ClassIsland 2.x 的插件 API 编写，`manifest.yml` 的 `apiVersion` 需要与你安装的
  ClassIsland 版本匹配（见下）。API 变动时可能需要调整 `Plugin.cs`。
- 只同步**课表**（星期 × 节次 → 科目）。单双周、临时调课、班级区分等 ClassIsland 高级课表
  特性暂未映射到 Aurora 的四字段 `Lesson` 模型。
- 课前提醒的检查粒度为 30 秒（跟随桥接的兜底定时器），提醒时刻最多有 ±30 秒误差。
- status.json 只覆盖「今天」的下一节课；跨天（晚自习跨到次日等）场景不在此契约内。
