---
name: timetable
description: 查询课程表（星期 × 节次 → 科目），用于课前提醒与"下节课是什么"
when_to_use: 用户询问课程安排、下一节课、或需要触发课前提醒时
---

# timetable

## 目标

基于 ClassRoom Mode 的课程表回答课程安排问题。

## 输入

- `schedule`：`{ provider: "manual" | "classisland", lessons: [{ weekday, startTime, endTime, subject }] }`
  - `provider = "manual"`：课表来自设置里手工维护的条目；
  - `provider = "classisland"`：课表来自 ClassIsland 桥接插件写出的本地 JSON
    （见仓库 `integrations/classisland-bridge/`）；桥接不可用时该列表为空。
- `now`：当前本地时间

## ClassIsland 联动（BetaV2 / v3）

当 `provider = "classisland"` 时，课程表由 ClassIsland 桥接插件写出的本地 JSON 提供
（`schedule.json`，见仓库 `integrations/classisland-bridge/`）。桥接插件 v2 起还会在同目录
维护 `status.json`（`onClass` / `currentSubject` / `currentStartTime` / `currentEndTime` /
`nextSubject` / `nextStartTime` / `nextEndTime` —— 后三个时间字段自 v3 起补齐），
因此**当前正在上的课与下节课可直接从感知摘要读取**（Aurora 已透出该状态，
摘要文本里会有一行「课堂状态：…」），不必根据 `now` 自行推算；
`status.json` 缺失或滞后时，才按上面的步骤从课表推算。

**需要把提醒发到 ClassIsland 上**（教室屏幕上的提醒 / 课前提醒）时，用 `classisland_remind`
工具（参数 `{ body, title?, channel? }`，渠道 `custom` / `class-started` / `pre-class`）——
它经 ClassIsland 自己的提醒服务弹出，只弹提醒、不改课表。
桥接未配置（没装 v3 插件 / 端点没填）时这个工具**不在工具表里**：
如实说明原因并引导用户去「设置 → 模式 → ClassRoom → 课程表」配置，
不要改用 `notify_user` 冒充（那只是 Aurora 自己的系统通知）。

## 步骤

1. 过滤出今天（`weekday` 匹配）的课程，按 `startTime` 排序。
2. 找出 `now` 之后最近的一节课；若已全部结束，说明今天的课已结束。
3. 回答时给出科目、起止时间，以及距离下节课的剩余时间。

## 约束

- 课程表为空时按来源区分说明：
  - `provider = "manual"` → 提示用户在「设置 → 模式 → ClassRoom → 课程表」中维护；
  - `provider = "classisland"` → 说明可能是今天没课，或桥接插件尚未安装 / 端点未配置
    （可提示用户在设置页点「测试连接」查看具体原因）。
- 不要编造课程表内容：数据为空就如实说明，不要推测"通常周三有数学课"。
