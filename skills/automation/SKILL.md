---
name: automation
description: 创建、修改、试跑和管理 Aurora 的自动化任务（定时或课堂条件触发，分 Agent Mode 与 Normal Mode 两种模式）
when_to_use: 当用户想「每天/每周定时做某事」「每 N 分钟做某事」「上课前/下课时自动做某事」「距上课/下课多少分钟时做某事」「下节课是某科目时做某事」，或想查看/修改/启停已有的自动化任务时
---

# 自动化（Automation）管理

你要帮用户把一句自然语言需求落成一份**自动化定义**，或帮他管理已有的自动化。
自动化 = **触发器（什么时候）+ 模式与内容（做什么）**。

## 第一步：判断模式

先问清（或从需求推断）触发后要做的事，再选模式：

- **Agent Mode（`mode: "agent"`）**：触发后由你（Agent）跑一次完整会话去完成任务 ——
  能读文件、查资料、写东西、调工具。适合「每天早上帮我整理待办」「下课后总结今天的文件」
  这类需要理解和生成的任务。内容写在 `prompt`（任务指令）里，要写得像给同事的完整交代：
  目标、步骤、产出放哪、什么时候该停。
- **Normal Mode（`mode: "normal"`）**：触发后按预设清单执行固定操作（弹通知 /
  ClassIsland 提醒 / 打开文件夹），**不需要模型参与**，速度快、零成本。适合
  「上课前提醒我」「课前打开科目文件夹」这类固定动作。内容写在 `actions` 数组里。

用户没想清楚时给建议：要「动脑子」用 Agent Mode，要「按部就班」用 Normal Mode。

## 第二步：选触发器

| 用户说 | 触发器 |
|---|---|
| 「每天 08:00」「周一到周五 7:50」 | `daily`：`{ at: "08:00", weekdays: [1,2,3,4,5] }` |
| 「每 30 分钟」「每小时」 | `interval`：`{ everyMinutes: 30 }`（5–1440） |
| 「上课前 5 分钟」 | `pre-class`：`{ leadMinutes: 5 }` |
| 「开始上课时」 | `class-start`：`{}` |
| 「快下课时」「下课前 2 分钟」 | `pre-end`：`{ leadMinutes: 2 }` |
| 「下课时」 | `class-end`：`{}` |
| 「下节是数学课时」 | `next-lesson`：`{ subject: "数学" }`（科目名必须与课程表一致，先确认） |

课表类触发器读的是当前课程表（手动课表或 ClassIsland 联动皆可）。

## 第三步：构造内容

- Agent Mode：`prompt` 一段完整任务指令。触发时会附带触发上下文（如「距上课 3 分钟」），
  指令里不用重复时间。
- Normal Mode：`actions` 数组（按序执行），每项 `{ kind, params }`：
  - `system-notify`：`{ title, body, openPath? }` —— 系统通知；
  - `classisland-remind`：`{ title, body, channel? }` —— 需已配置 ClassIsland 桥接；
  - `open-folder`：`{ target: "subject"|"path", subject?, path? }` —— 打开科目文件夹或指定路径。

参数约束见 `automation_create` 工具描述；不在清单里的组件会被拒绝，不要编造。

## 第四步：创建并试跑

1. `automation_create` 创建（会请用户确认）；创建成功拿到 id。
2. **主动建议试跑**：`automation_run` 触发一次（Normal 立即生效；Agent 在后台跑会话）。
3. `automation_history` 查看结果并向用户汇报（Agent 运行的对话在主界面「自动化 → 历史」里可回放）。

## 管理已有自动化

- 查看全部（含内置）：`automation_list` —— **任何修改前先调它拿 id**。
- 修改 / 启停：`automation_update`（`enabled: false` 即停用）。
- 删除：`automation_delete`。
- 查历史：`automation_history`（可按 automationId 过滤）。

**内置自动化**（id 以 `builtin.` 开头）是 ClassRoom 模式的既有自动操作
（课前提醒、课前自动打开科目文件夹），不可删除、不可直接修改；要调整它们，
引导用户去「设置 → 模式 → ClassRoom」改对应开关与「课前提醒提前分钟数」。

## 约束

- `automations.enabled` 总开关与权限档位你改不了（只读黑名单）；如果自动化没有生效，
  先用 `automation_list` 确认定义存在且已启用，再提示用户检查总开关（设置 → 模式 → 自动化）。
- Normal Mode 的操作组件是封闭清单（没有执行命令、没有任意写文件）——用户要更强的能力
  时建议改用 Agent Mode。
- 用户不在线确认时，Agent Mode 运行中的敏感工具确认 60 秒超时按拒绝处理；
  建议用户在自动化会话里用「本会话都允许」，或把权限档调到 auto（项目根内免确认）。
