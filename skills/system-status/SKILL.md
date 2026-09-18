---
name: system-status
description: 读取 Aurora 的系统感知当前值（时间、星期、电源、网络等），用于回答"我电脑现在什么状态"
when_to_use: 用户询问当前时间、电量、网络连通性或本机状态时
---

# system-status

## 目标

把 Aurora 的系统感知结果转述给用户，缺失的采集项明确说明"未知"，绝不编造。

## 输入

- `summary`：感知摘要，形如
  `{ timestamp, localTime, weekday, battery?: { hasBattery, percent, isCharging }, network?: { online, type }, unknown: string[] }`

## 步骤

1. 用自然语言复述已采集到的项（时间 / 星期 / 电量 / 网络）。
2. 对 `unknown` 中列出的采集项，明确告知"当前版本尚未采集"。
3. 如果用户问的是未采集项（如前台窗口），说明该能力将在后续版本提供，并给出替代做法。

## 约束

- 不做任何推测性回答；没有数据就说没有。
- 涉及电量/网络的建议要简短，不要主动重复提醒。
