# Aurora × ClassIsland 桥接插件

把 [ClassIsland](https://classisland.tech/) 的课表暴露给 [Aurora](../../README.md)，
让 Aurora 的「课前自动打开科目文件夹」与「今日课程感知」不再需要手工维护课表；
v2 起还会通过 ClassIsland 自己的提醒服务弹出上课 / 课前提醒。

> **为什么需要这个插件？** ClassIsland 的扩展体系是 .NET，跨进程能力走
> `dotnetCampus.Ipc` 命名管道，`classisland://` URI 只能做应用内导航、**不传数据**，
> 官方也没有 HTTP API。Aurora 是 Node/Electron 应用，无法直连它的 IPC。
> 因此由本插件在 ClassIsland 内部把课表写成一份**稳定的本地 JSON**（或暴露本地端点），
> Aurora 只读这份契约 —— 双方各自演进，互不绑定内部实现。

## v3 变更（3.0.0.0）

- **状态快照升级到 version 3**：新增 `currentStartTime` / `currentEndTime`（上课中当前节的起止
  `HH:mm`）与 `nextEndTime`（下节课结束时间）。取不到的字段**不写**（空串，绝不编造）。
  `schedule.json` 的 `version`（课表结构版本）**保持 1 不变**，只动内嵌 `status.version`。
- **新增入站提醒通道（本版核心）**：让 Aurora 能调用 ClassIsland 的提醒功能 ——
  - **文件模式**：Aurora 原子写 `<桥接输出目录>/command.json`，插件在 1–2 秒内
    （`FileSystemWatcher` + 600ms 防抖，另有 30s 兜底检查）读取并经 ClassIsland 的通知服务弹出，
    结果原子写入同目录 `command-result.json`；**按 `id` 去重**，命令文件**不删除**；
  - **HTTP 模式**（`enableHttpEndpoint` 打开时）：`POST /notify`（请求 / 响应体与上面两个文件同构），
    端点改为按 **method + path 路由**（`GET /schedule` 及其它 GET 行为不变）；
  - 新增第三个提醒渠道 **「Aurora 提醒」**（`custom`）；`class-started` / `pre-class` 复用 v2 的两个渠道；
  - 提醒不可用时**降级为仅写 `command-result.json` + 日志**（`ok: false` + `error`），绝不影响课表导出。
- **新增配置项 `enableCommandChannel`**（默认 `true`）：关闭后不监听命令文件、`POST /notify` 返回 404。
- **⚠️ 配置需要手工编辑 `bridge.json`**：本插件**没有注册 ClassIsland 设置页**
  （v2 的 README 曾写「在插件设置页可以调整」，与实现不符，此处已如实修正）。

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
    "version": 3,
    "onClass": true,
    "currentSubject": "数学",
    "currentStartTime": "08:00",
    "currentEndTime": "08:45",
    "nextSubject": "语文",
    "nextStartTime": "09:20",
    "nextEndTime": "10:05",
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

### status.json（v2 新增，v3 扩充）

与 `schedule.json` 同目录（默认 `%APPDATA%\ClassIsland\aurora-bridge\status.json`），
每次写课表时一并原子写出，**内容与 schedule.json 内嵌的 `status` 属性完全相同**
（同一次计算、两个输出，`generatedAt` 等字段不会各说各话）。
**Aurora 消费的是 schedule.json 里内嵌的那份**；status.json 主要供人工查看 / 排障
及其他工具读取：

```json
{
  "version": 3,
  "generatedAt": "2026-09-25T08:00:00.123+08:00",
  "onClass": true,
  "currentSubject": "数学",
  "currentStartTime": "08:00",
  "currentEndTime": "08:45",
  "nextSubject": "语文",
  "nextStartTime": "09:20",
  "nextEndTime": "10:05"
}
```

| 字段 | 说明 |
|---|---|
| `version` | 状态格式版本：v2 为 `2`，**v3 起为 `3`**（与 schedule.json 的 `version` 互不相干） |
| `onClass` | 是否处于上课状态，取自 ClassIsland 实时课程状态（`CurrentState == OnClass`） |
| `currentSubject` | 当前上课的科目名（经 `subjectMap` 映射后的 Aurora 侧名称）；不在上课或未知时为空串 |
| `currentStartTime` / `currentEndTime` | **v3 新增**：当前节次起止 `HH:mm`（上课中、且当前时间点确实是"上课"类型时才写）；取不到为空串 |
| `nextSubject` / `nextStartTime` | 今天下一节"上课"类型节次的科目与开始时间 `HH:mm`；与 schedule.json 同源（`GetClassPlanByDate`），上课中取的是下一节，课间取的是紧接着的那节；没有则为空串 |
| `nextEndTime` | **v3 新增**：下节课结束时间 `HH:mm`；没有下一节 / 取不到为空串 |

取不到的字段一律**空串**，不编造。Aurora 侧把它当作快照消费（课堂状态行 / 当前·下节课卡），
不用于触发科目文件夹等动作 —— 那仍以 schedule.json 的课表为准。

### command.json / command-result.json（v3 新增：Aurora → ClassIsland 的提醒）

Aurora 可以通过这两个文件让本插件**用 ClassIsland 自己的提醒服务**弹提醒
（Aurora 侧的 `classisland:notify` IPC 与 `classisland_remind` 工具）：

```jsonc
// Aurora 原子写（临时文件 + 覆盖重命名）；插件**不删除**这个文件
{
  "version": 1,
  "id": "唯一串",                     // 去重键：同 id 不重复弹出、不重复写结果
  "kind": "notify",                   // 当前只支持 notify
  "channel": "custom",                // custom | class-started | pre-class（未知值按 custom）
  "title": "Aurora",                  // 与 body 至少一个非空
  "body": "该交作业了",
  "createdAt": "2026-09-25T21:16:18.000+08:00"
}
```

```jsonc
// 插件原子写（同目录），Aurora 轮询它并比对 id
{
  "version": 1,
  "id": "回显请求的 id",
  "ok": true,                         // true = 已交给 ClassIsland 的通知服务
  "error": "失败原因（可选）",
  "handledAt": "2026-09-25T21:16:18.036+08:00"
}
```

- **处理时机**：`FileSystemWatcher`（Created / Changed / Renamed）+ 600ms 防抖 ——
  真机实测 **< 1 秒**完成并写出回执（见「已验证程度」）；另有 30s 兜底检查
  （比较文件原文，防事件丢失），插件启动时也会补处理一次（覆盖"Aurora 先写、插件后启"）。
- **过期保护**：命令文件按契约不删除，而去重表只在内存里，因此插件重启会把最后一条命令
  再处理一次。为避免弹出"上一节课的提醒"，`createdAt` 距今超过 **10 分钟**的命令在启动补救时
  **跳过不弹**（日志记「已过期…跳过不弹」）；没有 `createdAt` 字段的命令无法判断新旧，照常处理。
- **`ok: true` 的语义是「已交给 ClassIsland 的通知服务」**：是否真正弹出 / 是否朗读仍由
  ClassIsland 的「设置 → 提醒」决定（用户在那边关掉提供方或渠道时通知服务不会抛错）。
- **渠道映射**：`custom` → 「Aurora 提醒」渠道（v3 新增）；`class-started` → 「上课提醒」；
  `pre-class` → 「课前提醒」。
- **降级**：提醒提供方不可用 / 发送抛错时，回执为 `ok: false` + `error` 并写日志 ——
  **绝不影响课表导出**。
- **HTTP 模式**（`enableHttpEndpoint: true` 时）：`POST /notify` 的请求体就是 command.json 的内容，
  响应体就是 command-result.json 的内容（`Content-Type: application/json`）；
  请求体非法 → 400，命令通道关闭 → 404，请求体超过 64KB → 413。
  `GET /schedule`（及其它非 POST 请求）行为不变，返回课表 JSON（含内嵌 status）。
  **注意**：`POST /notify` 的请求体请用 **UTF-8 编码**并带上 `charset=utf-8`
  （PowerShell 5.1 的 `Invoke-WebRequest` 默认按 ANSI 发送，中文会乱码 —— 这是客户端行为，
  不是插件问题；已实测 UTF-8 请求体中文正常显示）。

## 两种工作模式

| 模式 | Aurora 侧配置 | 适用 |
|---|---|---|
| **文件**（默认） | 数据来源选「JSON 文件」，端点填下面写出的文件绝对路径 | 最省事，无需开放端口 |
| **HTTP** | 数据来源选「本地 HTTP 端点」，端点填 `http://127.0.0.1:17945/schedule` | 需要更实时的数据 / 不想让 Aurora 读文件 |

文件模式下，插件在以下时机重写两份 JSON：ClassIsland 启动完成、课程切换（OnClass）、
时间状态切换，以及一个低频定时器（默认 30 秒）兜底 —— 老师的临时调课也能在 30 秒内反映到 Aurora。

## 课程提醒（v2 / v3）

- 提醒通过 **ClassIsland 的通知服务**送进 ClassIsland 自己的提醒 UI（覆盖层展示约 10 秒，
  不做全屏遮罩）。插件以提醒提供方「Aurora 桥接」（v3 起三个渠道：上课提醒 / 课前提醒 /
  **Aurora 提醒**）的身份接入，是否弹出、是否朗读等由 ClassIsland 的通知设置决定。
- **上课提醒**：`ILessonsService.OnClass`（课程切换）时发出，内容为「上课了：科目（起止时间）」。
- **课前提醒**：下节课开始前 `remindBeforeClassMinutes` 分钟发出（30 秒粒度检查，
  同一节课只提醒一次；启动晚了但仍在提前窗口内会补提醒）。
- **Aurora 提醒（v3）**：由 **Aurora 主动发起**（设置页「发送测试提醒」按钮 /
  AI 的 `classisland_remind` 工具），经 `command.json` 或 `POST /notify` 送达，见上面的契约。
- **降级路径**：提醒提供方解析失败或通知服务不可用时，提醒自动降级为
  「仅刷新课表导出（schedule.json + 内嵌 status + status.json）+ 写日志」，不影响课表导出。
  ClassIsland 日志里会出现「提醒提供方不可用」的告警。
- **UI 线程要求**：ClassIsland 的 `NotificationHostService.PushNotificationRequests` 会读
  `MainWindowLine` 控件的 Avalonia 属性（带线程校验），因此提醒**必须在 UI 线程上发**。
  命令通道由 `FileSystemWatcher` / 定时器触发（后台线程），插件内部已用
  `Dispatcher.UIThread` 切回 —— 这是 v3 实跑时踩到并修掉的坑（症状：
  `command-result.json` 里 `ok:false`、`error` 为「Call from invalid thread」，界面上什么都不弹）。
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

- **插件包**：`dist/AuroraClassIslandBridge-v3.0.zip`（`manifest.yml` 在压缩包根目录 +
  插件 dll，符合 ClassIsland 插件包格式，放进其插件包目录即可被识别安装）。

重启 ClassIsland 后，在「设置 → 插件」里应能看到「Aurora 桥接」并已加载；
「设置 → 提醒」里会出现「Aurora 桥接」提供方。

> 装好的插件配置位于 `<ClassIsland>\data\Config\Plugins\aurora-classisland-bridge\bridge.json`，
> 桥接输出默认写到 `%APPDATA%\ClassIsland\aurora-bridge\schedule.json` 与同目录 `status.json`。

## 已验证程度

| 项 | 状态 |
|---|---|
| 用 ClassIsland **2.1.0.1** 的真实程序集编译（v3 含通知 API 与 Avalonia Dispatcher） | ✅ **0 error / 0 warning**（已实际执行：`dotnet build -c Release`，.NET SDK 10.0.301，产物 43.5KB dll）。msbuild 的 `MSB3277`（宿主程序集依赖的 System.Text.Json 9 / WindowsBase 6 等与 net8.0 ref 的版本冲突）已在 csproj 里降级为 message —— 用 v2 源码可复现同样 3 条，与源码改动无关 |
| 被 ClassIsland 加载（日志显示「此次会话已加载插件: Aurora 桥接(…,**3.0.0.0**)」） | ✅ **v3 实机验证**（2026-09-25，ClassIsland 2.1.0.1）：`此次会话已加载插件:Aurora 桥接(aurora-classisland-bridge,3.0.0.0)` |
| 提醒提供方与三个渠道注册 | ✅ **v3 实机验证**：日志 `注册提醒提供方：11d7c8f6-…（Aurora 桥接）`、`注册提醒渠道：7a5c41a0-…（Aurora 提醒）` |
| 写出 `schedule.json` 且根对象内嵌 `status` v3 | ✅ **v3 实机验证**：真实产出 `{"version":1, "lessons":[…29 节…], "status":{"version":3,"onClass":true,"currentSubject":"生物","currentStartTime":"21:00","currentEndTime":"22:00",…}}` |
| 写出 `status.json`（与内嵌 `status` 同一份快照） | ✅ **v3 实机验证**：`version` 3、`currentStartTime`/`currentEndTime` 有真实值，与 schedule.json 内嵌那份完全一致 |
| **入站提醒通道：文件模式**（`command.json` → `command-result.json`） | ✅ **v3 实机验证**：手工原子写 `command.json` 后 **687ms** 得到 `{"version":1,"id":"…","ok":true,"handledAt":"…"}`；`id` 去重与"命令文件不删除"均按契约工作 |
| **提醒真的在 ClassIsland 上弹出** | ✅ **v3 实机验证（截图 + 日志双证）**：ClassIsland 日志出现 `处理通知请求：…SimpleTextTemplateData(Aurora 桥接 v3 实机验证：…)`，同时屏幕截图里能看到该覆盖层文本；渠道 `custom` 与 `pre-class` 都验证过 |
| **入站提醒通道：HTTP 模式**（`POST /notify`） | ✅ **v3 实机验证**：`GET /schedule` → 200（课表 + status v3 不变）；`POST /notify` → 200 `ok:true` 且弹出；未知 POST 路径 → 404；非法 JSON → 400；UTF-8 中文请求体显示正常 |
| Aurora 侧解析真实输出（零告警、星期/时间/科目正确、status v3 各字段正确） | ✅ **v3 已用真机产出的 `schedule.json` 对拍**（Aurora 的 `parseClassislandPayload`：0 告警，29 条课程，status v3 六个字段全部解析正确） |
| 生命周期收尾（`AppStopping` 再写一次） | ✅ v1 已验证；v3 关闭时会额外释放 `FileSystemWatcher` 与防抖定时器 |
| 不同 ClassIsland 版本的兼容性 | ⚠️ 仅在 2.1.0.1 实测；`manifest.yml` 的 `apiVersion` 为 `2.0.0.0` |

> v3 的实机验证（2026-09-25 晚）覆盖：插件加载 → 关键日志 → `schedule.json`/`status.json`
> 的 v3 字段 → 文件模式提醒（含延迟测量与屏幕截图）→ HTTP 模式提醒与路由错误码
> → Aurora 侧解析对拍。验证过程中发现并修掉了一个真实缺陷（**提醒必须在 UI 线程发送**，
> 见「课程提醒」一节的说明）。
> 仍未实机验证的部分：跨天（晚自习跨到次日）场景、`enableCommandChannel: false` 的关闭路径
> （代码走查 + 单元级别确认，未在真机上关掉跑一遍）。
> 若提醒不弹出，请先看 ClassIsland 日志（搜「Aurora 桥接」）：
> 提供方未注册 / 渠道未命中会走降级路径，只影响提醒，不影响课表导出。

## 配置

**本插件没有注册 ClassIsland 设置页，配置需要手工编辑 `bridge.json`**
（v2 的 README 曾写「在插件设置页可以调整」，与实现不符，现已修正）：

```
<ClassIsland 安装目录>\data\Config\Plugins\aurora-classisland-bridge\bridge.json
```

插件启动时读取它；**改完要重启 ClassIsland**（配置在启动时装载并缓存）。
若旧配置缺少新字段，插件会**补写一份**（只补缺失键，已写值原样保留）。

- **输出文件路径** `outputPath`：默认 `%APPDATA%\ClassIsland\aurora-bridge\schedule.json`
  （**不要**放在插件安装目录里：插件更新会清空该目录；`status.json`、`command.json`、
  `command-result.json` 固定写在同目录）
- **课前提醒分钟数** `remindBeforeClassMinutes`：默认 `2`；`0` = 关闭课前提醒
  （上课提醒始终随课程切换发出，可在 ClassIsland 通知设置里单独关闭）
- **启用本地 HTTP 端点** `enableHttpEndpoint`：默认 `false`
- **HTTP 端口** `httpPort`：默认 `17945`，仅监听 `127.0.0.1`（不对外暴露）
- **提醒命令通道** `enableCommandChannel`（v3 新增）：默认 `true`；`false` 时不监听
  `command.json`、`POST /notify` 返回 404
- **科目名映射** `subjectMap`：把 ClassIsland 的科目名映射成 Aurora 侧的科目名
  （例如 ClassIsland 里叫「数学（必修）」，Aurora 的文件夹叫「数学」；
  status 的 currentSubject / nextSubject 同样应用该映射）

## 在 Aurora 里接线

1. 打开 Aurora「设置 → 模式 → ClassRoom → 课程表」
2. 「课程表来源」选 **ClassIsland 联动**
3. 「数据来源」选文件或 HTTP，填上路径 / 端点
4. 点「**测试连接**」：应显示今日课程条数；若为 0 条，请确认今天是休息日、
   或 `subject` 与 Aurora 科目名是否一致
5. 保存后，课前提醒（若已开启）就会按 ClassIsland 的课表触发
6. 想让 Aurora / AI 也能往 ClassIsland 发提醒：同一区组里的「**发送测试提醒**」按钮点一下，
   应在 ClassIsland 上看到提醒；失败时就地显示原因（插件不是 v3 / 命令通道关闭 / 超时）

## 排障

| 现象 | 排查方向 |
|---|---|
| 测试连接报「尚未配置 ClassIsland 桥接端点」 | 端点/路径还没填 |
| 测试连接报「请求超时」/ 文件读取失败 | 插件是否已加载（ClassIsland 日志里搜「Aurora 桥接」）？文件模式看路径是否存在；HTTP 模式看端口是否被占用 |
| ClassIsland 启动后没生成 `schedule.json` | 看 ClassIsland 日志有没有插件加载记录；`AutoDisableCorruptPlugins` 打开时，加载失败的插件会被自动禁用 |
| 读到 0 条课程 | 今天是否有课（课表按**星期**匹配，周日与周一不是同一份）；课表是否已启用 |
| 有课程但课前提醒没打开文件夹 | `subject` 与 Aurora 科目名不一致（会被跳过，Aurora 日志里有告警）；两边叫法不同时用 `subjectMap` 映射 |
| 上课 / 课前提醒不弹出 | 插件提醒是否被 ClassIsland 通知设置关闭（「设置 → 提醒 → Aurora 桥接」）；`remindBeforeClassMinutes` 是否为 0；日志里是否有「提醒提供方不可用」（有则说明走了降级路径，仅影响提醒） |
| Aurora 侧「发送测试提醒」报「等待 ClassIsland 回执超时」 | 插件不是 v3（看日志的加载版本号）；`enableCommandChannel` 被设为 `false`；`outputPath` 的目录不可写（Aurora 写 `command.json` 失败 / 插件读不到） |
| 测试提醒报「通知服务不可用：Call from invalid thread」 | v3 早期构建的缺陷（提醒没切回 UI 线程），升级到正式 v3 即可；若仍出现请把日志里的异常栈反馈回来 |
| `POST /notify` 返回 404 | `enableCommandChannel: false`，或 `enableHttpEndpoint` 没开（那时端口本身也不会监听） |
| ClassIsland 上的提醒中文变问号 | 客户端提交的 body 不是 UTF-8：请带 `Content-Type: application/json; charset=utf-8`（curl / Aurora 侧默认正确；PowerShell 5.1 的 `Invoke-WebRequest` 需自己转字节） |
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
- status 只覆盖「今天」的下一节课；跨天（晚自习跨到次日等）场景不在此契约内。
- **提醒命令通道的 `ok: true` 只代表「已交给 ClassIsland 的通知服务」**：
  用户在 ClassIsland「设置 → 提醒」里关掉「Aurora 桥接」提供方或某个渠道时，
  通知服务不会抛错，因此插件无从得知"其实没弹出来"。
- 同一时刻多条提醒时，ClassIsland 的覆盖层会**排队**展示（每条约 10 秒），
  因此第二条的**显示时间**可能晚于命令处理时间（实测：命令 21:16:27 处理完成，
  21:16:33 才显示 —— 处理本身仍是 < 1 秒，排队是 ClassIsland 通知服务的行为）。
- **没有 ClassIsland 设置页**：`bridge.json` 需手工编辑并重启 ClassIsland（见「配置」）。
