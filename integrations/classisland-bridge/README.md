# Aurora × ClassIsland 桥接插件

把 [ClassIsland](https://classisland.tech/) 的课表暴露给 [Aurora](../../README.md)，
让 Aurora 的「课前 5 分钟自动打开科目文件夹」与「今日课程感知」不再需要手工维护课表。

> **为什么需要这个插件？** ClassIsland 的扩展体系是 .NET，跨进程能力走
> `dotnetCampus.Ipc` 命名管道，`classisland://` URI 只能做应用内导航、**不传数据**，
> 官方也没有 HTTP API。Aurora 是 Node/Electron 应用，无法直连它的 IPC。
> 因此由本插件在 ClassIsland 内部把课表写成一份**稳定的本地 JSON**（或暴露本地端点），
> Aurora 只读这份契约 —— 双方各自演进，互不绑定内部实现。

## 数据契约

Aurora 侧只认这一份契约（`apps/desktop/src/main/classisland.ts` 的 `ClassIslandPayload`）：

```json
{
  "version": 1,
  "generatedAt": "2026-09-19T07:30:00Z",
  "lessons": [
    { "weekday": 1, "startTime": "08:00", "endTime": "08:45", "subject": "数学" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `weekday` | `0`=周日 … `6`=周六（`7` 也会被 Aurora 折成周日）；越界值该条被跳过 |
| `startTime` / `endTime` | `HH:mm`（`8:05` 这类未补零写法 Aurora 也能读） |
| `subject` | 科目名，**必须与 Aurora 设置里科目列表的名称一致**，否则课前提醒找不到对应文件夹 |
| `lessons` | 一次性给出**整周**课表；当天筛选由 Aurora 完成 |

Aurora 对非法数据是**逐条跳过并记告警**，不会整份作废，也不会因为桥接不可用而阻塞主流程
（读不到就当作"今天没有课"）。

## 两种工作模式

| 模式 | Aurora 侧配置 | 适用 |
|---|---|---|
| **文件**（默认） | 数据来源选「JSON 文件」，端点填下面写出的文件绝对路径 | 最省事，无需开放端口 |
| **HTTP** | 数据来源选「本地 HTTP 端点」，端点填 `http://127.0.0.1:17945/schedule` | 需要更实时的数据 / 不想让 Aurora 读文件 |

文件模式下，插件在以下时机重写 JSON：ClassIsland 启动完成、课表切换、科目变更，
以及一个低频定时器（默认 30 秒）兜底 —— 老师的临时调课也能在 30 秒内反映到 Aurora。

## 构建

需要 .NET SDK 8.0+，以及**已安装的 ClassIsland**（插件不通过 NuGet 引用它，
而是直接引用你本机的那份程序集，避免版本错配）。

```bash
# 指向 ClassIsland 安装目录即可（完整包会自动往下找 app-<版本>/ 那一层）
dotnet build -c Release -p:ClassIslandDir="<ClassIsland 安装目录>"
```

也可以设置环境变量 `CLASSISLAND_DIR`，或用默认推断（`%LOCALAPPDATA%\Programs\ClassIsland`
与 `%ProgramFiles%\ClassIsland`）。

产物在 `bin/Release/net8.0/`。把它复制到 ClassIsland 的**插件目录**：

```
<ClassIsland 安装目录>\data\Plugins\aurora-classisland-bridge\
```

目录内需包含 `AuroraClassIslandBridge.dll` 与 `manifest.yml`（`README.md` 可选）。
重启 ClassIsland 后，在「设置 → 插件」里应能看到「Aurora 桥接」并已加载。

> 装好的插件配置位于 `<ClassIsland>\data\Config\Plugins\aurora-classisland-bridge\bridge.json`，
> 桥接输出默认写到 `%APPDATA%\ClassIsland\aurora-bridge\schedule.json`。

## 已验证程度

| 项 | 状态 |
|---|---|
| 用 ClassIsland **2.1.0.1** 的真实程序集编译 | ✅ 0 error（已实际执行） |
| 被 ClassIsland 加载（日志显示「此次会话已加载插件: Aurora 桥接」） | ✅ 已实际运行验证 |
| 写出 `schedule.json`，内容符合 Aurora 契约 | ✅ 已实际运行验证 |
| Aurora 侧解析该真实输出（零告警、星期/时间/科目正确） | ✅ 已用真实产出文件验证 |
| 生命周期收尾（`AppStopping` 再写一次） | ✅ 已验证 |
| 不同 ClassIsland 版本的兼容性 | ⚠️ 仅在 2.1.0.1 验证；`manifest.yml` 的 `apiVersion` 为 `2.0.0.0` |

## 配置

插件启用后，在 ClassIsland 的插件设置页可以调整：

- **输出文件路径**：默认 `%APPDATA%\ClassIsland\aurora-bridge\schedule.json`
  （**不要**放在插件安装目录里：插件更新会清空该目录）
- **启用本地 HTTP 端点**：默认关闭
- **HTTP 端口**：默认 `17945`，仅监听 `127.0.0.1`（不对外暴露）
- **科目名映射**：把 ClassIsland 的科目名映射成 Aurora 侧的科目名
  （例如 ClassIsland 里叫「数学（必修）」，Aurora 的文件夹叫「数学」）

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
