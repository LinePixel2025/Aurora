---
date: 2026-10-03
title: DSH 的技能根清单与 .system 陷阱（技能该放哪一层）
tags: [环境, 技能, 坑]
source: 模型自动记录
---

# DSH 技能根清单与 `.system` 陷阱

## 现象

- DSH 的技能根有固定 rank（来自 `@deepseek-ai/dsh-skill-filesystem`）：

| rank | 来源 | 路径 |
| --- | --- | --- |
| 100 | project-dsh | `<项目根>/.dsh/skills` |
| 200 | project-agents | `<项目根>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `~/.dsh/skills` |
| 500 | user-agents | `~/.agents/skills` |
| 600 | bundled | `bundledSkillDir`（默认取环境变量 `DSH_BUNDLED_SKILL_DIR`） |

- `<dshHome>/skills/.system` 是「看起来像系统目录」的死位子：用户根注册时带 `skipSystem: true`，扫描与加载都会跳过顶层 `.system`；实测没有任何组件注册扫描它。把技能直接放进 `.system` = 从技能目录里静默消失。
- 宿主层 `skill-filesystem` 行被禁用，预设（preset）行才带 `customSkillDirs` —— 用户不是丢文件就能多一个根。
- 2026-10-03 把 `memory-read` / `memory-create` 从 `~/.dsh/skills` 移到 `~/.agents/skills`（用户口径：与内置技能同层）；移动后无需重启，下一次 `skill` 工具调用返回的 `Base directory` 即更新。

## 原因

- 发现逻辑是「扫一组固定根 + 单调 rank 合并」，根之间不会互相递归；用户根跳过 `.system` 是为另一个根预留位子，而不是「系统目录会被自动扫描」。
- 宿主行的启用 / 禁用由 bundle 补丁层决定，用户不是随便丢文件就能多一个根。

## 影响

- 按字面理解 `.system` = 系统级 → 技能静默消失（不报错、目录里也没有，只会觉得「技能没被识别」）。
- 放进 npm 安装包内的 `dsh-agent-preset\skills` → 应用升级 / 重装会被覆盖。
- 放在 rank 更低的根会被 rank 更高处的同名技能遮蔽（同名以 rank 优先级为准）。

## 结论与做法

- 要「所有项目 / 所有 agent 都看得到」，放 `~/.agents/skills`（rank 500）；要只对某个项目生效就放 `<项目根>/.dsh/skills`（rank 100，本仓库已有这个根）。
- **不要**用 `~/.dsh/skills/.system`，除非同时在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一条宿主层 `skill-filesystem` 行（`includeDefaultRoots: false` + `customSkillDirs` 指向它），并用 `dsh dump-config` 复算配置验证。
- 技能格式：`<根>/<name>/SKILL.md`（目录 bundle）或 `<根>/<name>.md`（平铺文件）；只认**一层**，不支持 `**/SKILL.md`；frontmatter 必填 `name`（kebab-case）与 `description`。格式错的条目**只记 warning 后被丢弃**，模型侧看不到任何「某技能无效」的诊断。
- 移动 / 新增技能后**用 `skill` 工具复解析一次**（看 `Base directory`）即可确认被发现，不需要重启 App。
- 本仓库落点：`AGENTS.md` 开头「会话开始先加载项目记忆」一节写着这两个技能的所在层，改位置要同步改它。
