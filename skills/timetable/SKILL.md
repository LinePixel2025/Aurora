---
name: timetable
description: 查询手动课程表（星期 × 节次 → 科目），用于课前提醒与"下节课是什么"
when_to_use: 用户询问课程安排、下一节课、或需要触发课前提醒时
---

# timetable

## 目标

基于 ClassRoom Mode 的手动课程表回答课程安排问题。

## 输入

- `schedule`：`{ provider: "manual" | "classisland", lessons: [{ weekday, startTime, endTime, subject }] }`
- `now`：当前本地时间

## 步骤

1. 过滤出今天（`weekday` 匹配）的课程，按 `startTime` 排序。
2. 找出 `now` 之后最近的一节课；若已全部结束，说明今天的课已结束。
3. 回答时给出科目、起止时间，以及距离下节课的剩余时间。

## 约束

- 手动课程表为空时，提示用户在「设置 → 模式」中维护课程表。
- ClassIsland 联动（`provider: "classisland"`）属后续版本：当前请说明尚未接入。
