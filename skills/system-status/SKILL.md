---
name: system-status
description: 读取 Aurora 的系统感知当前值（时间、星期、电源、网络、前台窗口、显示器、今日课程），用于回答"我电脑现在什么状态"
when_to_use: 用户询问当前时间、电量、网络连通性、正在用什么软件、或本机状态时
---

# system-status

## 目标

把 Aurora 的系统感知结果转述给用户，缺失的采集项明确说明"未知"，绝不编造。

## 输入

- `summary`：感知摘要，形如

  ```
  {
    timestamp, localTime, weekday,
    battery?:    { hasBattery, percent, isCharging },
    network?:    { online, type },
    foreground?: { app, title },                                 // 前台应用与窗口标题
    display?:    { width, height, scaleFactor, count },          // 主显示器
    lessons?:    [{ weekday, startTime, endTime, subject }],     // 今天剩余的课程
    unknown: string[]
  }
  ```

## 步骤

1. 用自然语言复述已采集到的项（时间 / 星期 / 电量 / 网络 / 前台应用 / 显示器 / 今日课程）。
2. 对 `unknown` 中列出的采集项，明确告知"当前版本尚未采集"。
3. 前台窗口可用来理解用户当下在做什么（如"你在看微信"），据此给出更贴合的回应；
   但**不要**据此推断用户的私人内容。

## 约束

- 不做任何推测性回答；没有数据就说没有。`unknown` 里的项一律回答"未采集"。
- 感知字段是**可选**的：某项缺席不等于值本身，不要编造（例如没有 `battery` 不代表没有电池）。
- 涉及电量 / 网络的建议要简短，不要主动重复提醒。
