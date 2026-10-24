# Aurora 插件开发工具包（v0.5.1）

这是一个**可整体拷走**的插件开发工具包：把整个目录复制到任意工作目录，让编码 Agent
先读 [AGENTS.md](./AGENTS.md) 与 [PROMPT.md](./PROMPT.md)，再以 [template/](./template) 为起点开发即可，
不需要 Aurora 源码。

## 目录

| 路径 | 内容 |
| --- | --- |
| [README.md](./README.md) | 本说明：如何开始、如何验证、如何安装 |
| [AGENTS.md](./AGENTS.md) | **给编码 Agent 的硬规则**（清单优先、权限、安全、验收） |
| [PROMPT.md](./PROMPT.md) | 可直接粘贴的提示词：新建插件 / 加小组件 / 加事件推送 / 代码审查 |
| [CHECKLIST.md](./CHECKLIST.md) | 提交前验收清单 |
| [docs/01-contract.md](./docs/01-contract.md) | 插件契约全文（进程、RPC、权限、清单、面板、页面、市场、安全） |
| [docs/02-guide.md](./docs/02-guide.md) | 插件开发指南全文（逐节怎么用 API） |
| [template/](./template) | 最小可运行模板：工具 + 面板 + 桌面小组件 + 提示条小组件 |
| [examples/class-board/](./examples/class-board) | 完整示例：班级事务（Agent 工具 + 面板 + 桌面/提示条小组件 + 推送） |
| [examples/hello-aurora/](./examples/hello-aurora) | 全功能示例：工具 / Skill / 命令 / 面板 / 页面 / 自动化 / 主题 / 小组件 |
| [tools/check-plugin.mjs](./tools/check-plugin.mjs) | **独立**清单与文件校验器（只用 Node 内置模块，零依赖） |

## 60 秒开始

1. 复制一份模板：

```bash
cp -r template my-plugin
```

2. 改 `manifest.json` 的 `id` / `name` / `version` 与 `main.js` 的处理器；
3. 在插件根目录运行校验：

```bash
node ../tools/check-plugin.mjs .
# 或从工具包根目录：node tools/check-plugin.mjs my-plugin
```

4. 装进 Aurora：设置 → 插件 → **开发** → 添加目录，选择 `my-plugin` 目录；
   或把目录打成 zip（**根目录直接是 manifest.json**）后走「安装插件包」。

## 用 Agent 开发

在**插件目录**里对 Agent 说：

> 先读 `../plugin-dev-kit/AGENTS.md`、`../plugin-dev-kit/docs/01-contract.md` 与
> `../plugin-dev-kit/docs/02-guide.md`，以 `template/` 为基线实现一个 `<你的需求>` 插件。
> 所有贡献必须写在 manifest.json；完成后运行 `node ../plugin-dev-kit/tools/check-plugin.mjs .` 并修到通过。

或直接粘贴 [PROMPT.md](./PROMPT.md) 里的提示词模板。

## 校验口径

- `tools/check-plugin.mjs` 是**离线基础校验**：清单字段、权限与贡献对应、路径 containment、
  面板 / 小组件约束、引用文件是否存在、schema JSON 能否解析；
- 它不替代 Aurora 仓库里的权威校验；在 Aurora 源码环境中请再跑：

```bash
pnpm build:packages
node scripts/verify-plugin.mjs <插件目录|zip>
```

- 安装到 Aurora 时，宿主会用同一份 zod schema 再校验一次；失败信息以安装弹窗为准。

## 安全边界（必须转告使用者）

插件进程以**当前用户权限**运行，可以直接读写文件、联网、调用子进程。
权限只门控 Aurora API，**不是操作系统沙箱**。安装插件 = 信任其代码；
不要安装来源不明的包。

## 版本

本工具包对应 **Aurora v0.5.1 / 插件 API v1 / 配置 Schema v36**。
Aurora 升级后若 `apiVersion` 变化，以 Aurora 仓库 `docs/14-plugin-system.md` 为准，
并重新生成本目录的 `docs/` 快照。
