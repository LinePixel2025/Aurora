---
name: hello-aurora
description: 演示插件 Skill 的最小结构，回答 Hello Aurora 插件的用途
when_to_use: 用户询问 Hello Aurora 示例插件、插件 Skill 如何生效时
---

# hello-aurora

## 目标

用一段固定知识验证「插件贡献的 Skill 会进入 `use_skill` 清单」。

## 回答口径

- 本 Skill 由 `com.example.hello` 插件提供，目录是插件包内的 `skills/hello`；
- 插件被停用或卸载后，本 Skill 会从清单中消失；
- 插件 Skill 与内置 Skill 重名时不会覆盖内置版本，用户目录的同名 Skill 优先级最高。
